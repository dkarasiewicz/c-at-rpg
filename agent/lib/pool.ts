/**
 * Shared content pool (gm-system.md "Shared content pool").
 *
 * SERVER-SIDE ONLY. It reads `process.env` and talks to Upstash over REST, so
 * it lives in the agent package and is never imported by `src/` — the browser
 * has no shared store and must not pretend to. Its callers are the DM's
 * `contribute_content` tool and `scripts/seed-pool.ts`. (It lived in
 * `api/_lib/pool.ts` until the `api/gm/*` endpoints were retired; the pool
 * outlived them because the agent writes to it.)
 *
 * Every validated generation is persisted and REUSED: a reader rolls
 * pool-first with probability p = min(0.7, poolSize / 200) before paying for
 * a fresh generation.
 *
 * Two storage impls behind one interface:
 *  - MemoryPool  — dev / no env vars; per warm lambda instance only.
 *  - UpstashPool — Upstash Redis over its REST API (UPSTASH_REDIS_REST_URL /
 *    UPSTASH_REDIS_REST_TOKEN). Plain fetch, no SDK dependency.
 *
 * Entries are stored as JSON strings; validation happens before add and
 * again after sample (a pool entry that no longer validates is skipped).
 */

export type PoolKind = "stands" | "items" | "events" | "enemies";

/**
 * Keyed memo tables (stand-powers.md "DB additions"):
 *  - powers        — Power Script rows keyed by power id;
 *  - interactions  — resonance rows keyed by pairKey (json may be null:
 *    "no resonance" is a valid, memoized outcome — a stored row saying so);
 *  - art           — generation-zero asset rows keyed by asset id, each
 *    recording styleVersion (visual-v2.md §Style contract).
 */
export type KeyedPoolKind = "powers" | "interactions" | "art";

export interface PoolStore {
  size(kind: PoolKind): Promise<number>;
  /** Uniform random entry (JSON string) or null when empty/unavailable. */
  sample(kind: PoolKind): Promise<string | null>;
  add(kind: PoolKind, entryJson: string): Promise<void>;
  /** Row JSON for `key`, or null when the table has no row (never memoized). */
  getEntry(kind: KeyedPoolKind, key: string): Promise<string | null>;
  /** Upsert the row for `key`. */
  setEntry(kind: KeyedPoolKind, key: string, entryJson: string): Promise<void>;
}

/** Pool-first probability per gm-system.md: p = min(0.7, size/200). */
export function poolPickProbability(size: number): number {
  return Math.min(0.7, Math.max(0, size) / 200);
}

/** Roll the pool-first policy for a store. */
export async function shouldUsePool(
  pool: PoolStore,
  kind: PoolKind,
  random: () => number = Math.random,
): Promise<boolean> {
  try {
    const size = await pool.size(kind);
    return random() < poolPickProbability(size);
  } catch {
    return false;
  }
}

const MAX_POOL_ENTRIES = 500;

/* ------------------------------------------------------------------------ */
/* In-memory (dev)                                                           */
/* ------------------------------------------------------------------------ */

export class MemoryPool implements PoolStore {
  private readonly lists = new Map<PoolKind, string[]>();
  private readonly tables = new Map<KeyedPoolKind, Map<string, string>>();

  private table(kind: KeyedPoolKind): Map<string, string> {
    let t = this.tables.get(kind);
    if (!t) {
      t = new Map();
      this.tables.set(kind, t);
    }
    return t;
  }

  private list(kind: PoolKind): string[] {
    let l = this.lists.get(kind);
    if (!l) {
      l = [];
      this.lists.set(kind, l);
    }
    return l;
  }

  size(kind: PoolKind): Promise<number> {
    return Promise.resolve(this.list(kind).length);
  }

  sample(kind: PoolKind): Promise<string | null> {
    const l = this.list(kind);
    if (l.length === 0) return Promise.resolve(null);
    return Promise.resolve(l[Math.floor(Math.random() * l.length)]);
  }

  add(kind: PoolKind, entryJson: string): Promise<void> {
    const l = this.list(kind);
    l.unshift(entryJson);
    if (l.length > MAX_POOL_ENTRIES) l.length = MAX_POOL_ENTRIES;
    return Promise.resolve();
  }

  getEntry(kind: KeyedPoolKind, key: string): Promise<string | null> {
    return Promise.resolve(this.table(kind).get(key) ?? null);
  }

  setEntry(kind: KeyedPoolKind, key: string, entryJson: string): Promise<void> {
    this.table(kind).set(key, entryJson);
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------------ */
/* Upstash Redis (REST)                                                      */
/* ------------------------------------------------------------------------ */

export class UpstashPool implements PoolStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command(cmd: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const body = (await res.json()) as { result?: unknown };
    return body.result;
  }

  private key(kind: PoolKind): string {
    return `gmpool:${kind}`;
  }

  async size(kind: PoolKind): Promise<number> {
    const n = await this.command(["LLEN", this.key(kind)]);
    return typeof n === "number" ? n : 0;
  }

  async sample(kind: PoolKind): Promise<string | null> {
    const n = await this.size(kind);
    if (n <= 0) return null;
    const idx = Math.floor(Math.random() * n);
    const entry = await this.command(["LINDEX", this.key(kind), idx]);
    return typeof entry === "string" ? entry : null;
  }

  async add(kind: PoolKind, entryJson: string): Promise<void> {
    await this.command(["LPUSH", this.key(kind), entryJson]);
    await this.command(["LTRIM", this.key(kind), 0, MAX_POOL_ENTRIES - 1]);
  }

  private hashKey(kind: KeyedPoolKind): string {
    return `gmpool:h:${kind}`;
  }

  async getEntry(kind: KeyedPoolKind, key: string): Promise<string | null> {
    const row = await this.command(["HGET", this.hashKey(kind), key]);
    return typeof row === "string" ? row : null;
  }

  async setEntry(
    kind: KeyedPoolKind,
    key: string,
    entryJson: string,
  ): Promise<void> {
    await this.command(["HSET", this.hashKey(kind), key, entryJson]);
  }
}

/* ------------------------------------------------------------------------ */
/* Env-driven default                                                        */
/* ------------------------------------------------------------------------ */

let defaultPool: PoolStore | null = null;

/** Upstash when both env vars are set, in-memory otherwise. No hard dep. */
export function getPool(): PoolStore {
  if (defaultPool) return defaultPool;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  defaultPool = url && token ? new UpstashPool(url, token) : new MemoryPool();
  return defaultPool;
}
