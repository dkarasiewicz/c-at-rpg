/**
 * THE DREAMING — the browser's READ path into the shared content pool
 * (docs/design/roster-and-persistence.md §5 "The Dreaming", §6 "Storage: yes,
 * Supabase").
 *
 * Everything in the `catrpg` schema is CONTENT — a Stand somebody dreamed, an
 * item, an event card, a compiled Stand interaction — with no player identity
 * anywhere. That is why the browser may read it directly with the publishable
 * anon key: RLS grants `anon` SELECT and refuses `anon` INSERT with 42501, so
 * this module is structurally incapable of writing. **Every write goes through
 * the DM agent**, which is the only thing that holds the service-role key.
 *
 * OFFLINE-FIRST IS A HARD RULE, and it is enforced here the same way
 * `services/dm.ts` enforces it for the DM:
 *
 *  - with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` unset, `poolReady()`
 *    is false and every reader SHORT-CIRCUITS WITHOUT A REQUEST — no fetch, no
 *    error, no log;
 *  - every reader returns `[]` / `null` on ANY failure (network, non-2xx,
 *    malformed body, timeout), so a caller can always fall back to authored
 *    content;
 *  - one hard timeout per request; nothing is unbounded.
 *
 * The pool is an ENRICHMENT LAYER, never a dependency. The local `MetaFile`
 * remains the source of truth for a player's own town.
 *
 * Transport is PostgREST over plain `fetch` — no SDK in the bundle, matching
 * how `services/dm.ts` speaks to the agent. The `catrpg` schema is selected
 * per-request with `Accept-Profile`, so nothing depends on a server-side
 * default.
 */

/* ------------------------------------------------------------------------ */
/* The kinds a dream can have — ONE definition, shared                       */
/* ------------------------------------------------------------------------ */

/**
 * The plural pool kinds, as callers name them. This union is the single
 * source of truth for what may be dreamed: `agent/lib/pool.ts` imports the
 * TYPE from here (never the other way round — `src/` must not depend on the
 * agent), and `DREAMED_KIND_COLUMN` below maps each to the singular value the
 * `content.kind` CHECK constraint accepts in `supabase/001_init.sql`.
 *
 * Add a kind here, add it to the CHECK constraint, and both halves agree.
 */
export type DreamedKind =
  | "stands"
  | "items"
  | "events"
  | "enemies"
  | "encounters"
  | "cats"
  | "powers"
  | "backgrounds";

/** Plural pool kind → the singular `catrpg.content.kind` column value. */
export const DREAMED_KIND_COLUMN: Record<DreamedKind, string> = {
  stands: "stand",
  items: "item",
  events: "event",
  enemies: "enemy",
  encounters: "encounter",
  cats: "cat",
  powers: "power",
  backgrounds: "background",
};

export const DREAMED_KINDS = Object.keys(DREAMED_KIND_COLUMN) as DreamedKind[];

/* ------------------------------------------------------------------------ */
/* Row shapes (the columns, camelCased at the boundary)                      */
/* ------------------------------------------------------------------------ */

/** One dreamed thing, as the client sees it. `payload` is UNTRUSTED. */
export interface DreamedRow {
  id: string;
  kind: DreamedKind;
  /** What the engine consumes. Re-lint it before it can affect anything. */
  payload: unknown;
  /** Public URL in the `catrpg-art` bucket, or null when it has no picture. */
  artUrl: string | null;
  styleVersion: number;
  floorMin: number;
  floorMax: number;
  tier: number | null;
  provenance: string | null;
  createdAt: string | null;
}

/**
 * A compiled Stand interaction (stand-powers.md Layer 3).
 *
 * `rule: null` IS THE ANSWER, not an absence: "these two do not resonate" is a
 * real verdict and the row exists precisely so it is never recomputed. The
 * distinction the caller needs is `null` (no row — never judged) versus a row
 * whose `rule` is null (judged, and the answer was no).
 */
export interface DreamedInteraction {
  pairKey: string;
  rule: unknown | null;
  flavor: string | null;
  announce: string | null;
  frameworkVer: number;
}

/* ------------------------------------------------------------------------ */
/* Config                                                                    */
/* ------------------------------------------------------------------------ */

const READ_TIMEOUT_MS = 4000;
const DEFAULT_SCHEMA = "catrpg";
const DEFAULT_BUCKET = "catrpg-art";

interface PoolConfig {
  url: string;
  anonKey: string;
  schema: string;
  bucket: string;
}

/**
 * Read `import.meta.env` LAZILY and defensively.
 *
 * The cast is deliberate: this module is also type-checked under
 * `agent/tsconfig.json` (the agent imports `DreamedKind` from here so the kind
 * union has exactly one home), and that project has no `vite/client` types. It
 * is read inside a function rather than at module scope so importing this file
 * has no side effects at all in a non-Vite runtime.
 */
function viteEnv(): Record<string, string | undefined> {
  const meta = import.meta as unknown as {
    env?: Record<string, string | undefined>;
  };
  return meta.env ?? {};
}

let cachedConfig: PoolConfig | null | undefined;

function config(): PoolConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const env = viteEnv();
  const url = (env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const anonKey = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  cachedConfig =
    url && anonKey
      ? {
          url,
          anonKey,
          schema: (env.VITE_SUPABASE_SCHEMA ?? "").trim() || DEFAULT_SCHEMA,
          bucket: (env.VITE_SUPABASE_ART_BUCKET ?? "").trim() || DEFAULT_BUCKET,
        }
      : null;
  return cachedConfig;
}

/**
 * True when the pool is reachable in principle. FALSE IS A FULLY SUPPORTED
 * STATE — the game plays on authored content and nothing here is called.
 */
export function poolReady(): boolean {
  return config() !== null;
}

/** Test hook: forget the memoised env read. */
export function resetPoolConfig(): void {
  cachedConfig = undefined;
}

/* ------------------------------------------------------------------------ */
/* Transport                                                                 */
/* ------------------------------------------------------------------------ */

async function get(path: string): Promise<unknown[] | null> {
  const cfg = config();
  if (!cfg) return null; // short-circuit: no request, ever
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method: "GET",
      headers: {
        apikey: cfg.anonKey,
        authorization: `Bearer ${cfg.anonKey}`,
        // PostgREST serves the schema named here, per request.
        "accept-profile": cfg.schema,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null; // network, abort, malformed JSON — all the same to a caller
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------ */
/* Readers                                                                   */
/* ------------------------------------------------------------------------ */

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toDreamed(raw: unknown, kind: DreamedKind): DreamedRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    kind,
    payload: r.payload,
    artUrl: str(r.art_url),
    styleVersion: num(r.style_version, 1),
    floorMin: num(r.floor_min, 1),
    floorMax: num(r.floor_max, 6),
    tier: typeof r.tier === "number" ? r.tier : null,
    provenance: str(r.author_session),
    createdAt: str(r.created_at),
  };
}

export interface ReadDreamedOptions {
  /** Only rows whose `[floorMin, floorMax]` band covers this floor. */
  floor?: number;
  /** Only rows authored against this style contract (visual-v2.md §Style). */
  styleVersion?: number;
  /** Only rows that have a hosted picture. */
  withArt?: boolean;
  /** 1..100, default 20. */
  limit?: number;
}

/**
 * Dreamed things of one kind, newest and best-rated first. `[]` means "none,
 * or the pool is not reachable" — deliberately the same to the caller, because
 * the fallback is identical: play the authored content.
 */
export async function readDreamed(
  kind: DreamedKind,
  options: ReadDreamedOptions = {},
): Promise<DreamedRow[]> {
  const column = DREAMED_KIND_COLUMN[kind];
  if (!column) return [];
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const q = [
    `kind=eq.${encodeURIComponent(column)}`,
    "select=id,payload,art_url,style_version,floor_min,floor_max,tier,author_session,created_at",
    "order=rating.desc,created_at.desc",
    `limit=${limit}`,
  ];
  if (typeof options.floor === "number") {
    q.push(`floor_min=lte.${options.floor}`, `floor_max=gte.${options.floor}`);
  }
  if (typeof options.styleVersion === "number") {
    q.push(`style_version=eq.${options.styleVersion}`);
  }
  if (options.withArt) q.push("art_url=not.is.null");
  const rows = await get(`content?${q.join("&")}`);
  if (!rows) return [];
  const out: DreamedRow[] = [];
  for (const raw of rows) {
    const row = toDreamed(raw, kind);
    if (row) out.push(row);
  }
  return out;
}

/**
 * The compiled verdict for one Stand pair, or `null` when no verdict has ever
 * been recorded (or the pool is unreachable).
 *
 * A returned row with `rule === null` is the definitive "these two do not
 * resonate" — the whole point of persisting null verdicts is that this costs
 * one cheap SELECT instead of a model call, forever, for every player.
 */
export async function readInteraction(
  pairKey: string,
): Promise<DreamedInteraction | null> {
  const rows = await get(
    `interactions?pair_key=eq.${encodeURIComponent(pairKey)}` +
      "&select=pair_key,rule,flavor,announce,framework_ver&limit=1",
  );
  const raw = rows?.[0];
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pair_key !== "string") return null;
  return {
    pairKey: r.pair_key,
    rule: r.rule ?? null,
    flavor: str(r.flavor),
    announce: str(r.announce),
    frameworkVer: num(r.framework_ver, 1),
  };
}

/**
 * Keyed art rows (shipped sprites, generated icons) by asset key. Used by a
 * style-version bump to find pictures that need requeuing.
 */
export async function readArt(
  key: string,
): Promise<{ key: string; url: string; styleVersion: number } | null> {
  const rows = await get(
    `art?key=eq.${encodeURIComponent(key)}&select=key,url,style_version&limit=1`,
  );
  const raw = rows?.[0];
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.url !== "string") return null;
  return { key: r.key, url: r.url, styleVersion: num(r.style_version, 1) };
}

/**
 * Public URL of an object in the art bucket. The bucket is PUBLIC on purpose:
 * a dreamed thing must keep its picture without a signed request on every
 * frame. Returns null when the pool is not configured.
 */
export function artPublicUrl(objectPath: string): string | null {
  const cfg = config();
  if (!cfg) return null;
  const clean = objectPath.replace(/^\/+/, "");
  return `${cfg.url}/storage/v1/object/public/${cfg.bucket}/${clean}`;
}

/**
 * How many things of a kind have been dreamed. Used for display ("the world
 * has 143 dreams in it"); the pool-first ROLL lives on the agent, where the
 * write side is, so the client can never talk itself into a stale decision.
 */
export async function countDreamed(kind: DreamedKind): Promise<number> {
  const column = DREAMED_KIND_COLUMN[kind];
  if (!column) return 0;
  const rows = await get(
    `content?kind=eq.${encodeURIComponent(column)}&select=id&limit=1000`,
  );
  return rows?.length ?? 0;
}
