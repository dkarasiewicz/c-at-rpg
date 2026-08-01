/**
 * THE DREAMING — the shared content pool, the system of record
 * (docs/design/roster-and-persistence.md §5/§6, gm-system.md "Shared content
 * pool").
 *
 * SERVER-SIDE ONLY. It reads `process.env` and holds the SERVICE-ROLE key, so
 * it lives in the agent package and `src/` never imports it — the browser has
 * its own read-only half in `src/services/pool.ts` (anon key, SELECT only).
 * Never let anything here reach a `VITE_*` variable: Vite bakes those into the
 * shipped bundle.
 *
 * ## What replaced what
 *
 * This was Upstash Redis, and `UPSTASH_REDIS_REST_URL` was never set in
 * production — so it silently fell back to a per-instance in-memory store and
 * NOTHING EVER PERSISTED, for anyone (roster-and-persistence.md §6). The store
 * is now Postgres, in the `catrpg` schema of the shared Supabase project,
 * because the pool wants QUERIES ("an item legal on floor 3 at styleVersion 1")
 * and RELATIONS, not key lookups. `supabase/001_init.sql` is the schema.
 *
 * ## Transport
 *
 * PostgREST over plain `fetch` — no SDK dependency, matching how the rest of
 * this agent talks HTTP. The schema is selected PER REQUEST with
 * `Accept-Profile` (reads) / `Content-Profile` (writes), so nothing depends on
 * a server-side default having been configured. Art bytes go to Supabase
 * Storage over its own REST endpoint.
 *
 * ## The contract
 *
 * `PoolStore` is unchanged — `size` / `sample` / `add` / `getEntry` /
 * `setEntry` keep their signatures (the new query argument is optional), so
 * every existing caller works untouched. `ContentPool` adds the richer surface
 * the Dreaming needs: typed rows, floor-banded pool-first picks, and art
 * upload.
 *
 * ## Two impls, one interface
 *
 *  - `MemoryPool`   — dev / no env vars; per warm instance only. This is what
 *    keeps the OFFLINE-FIRST invariant honest: no database ⇒ every method
 *    still answers, the DM still authors, the game still plays.
 *  - `SupabasePool` — the real one. Any failure is swallowed into a null/no-op
 *    return: publishing is never on the hot path, and a run must never fail
 *    because a shared store was unreachable.
 */
import type { DreamedKind } from "../../src/services/pool.js";
import { DREAMED_KIND_COLUMN } from "../../src/services/pool.js";

/**
 * The pool kinds. Everything the DM can author within existing bounds is
 * durable content (roster-and-persistence.md §5): stands, items, events,
 * enemies, encounters, cats, powers, backgrounds.
 *
 * The union has ONE home — `src/services/pool.ts` — because the browser reads
 * the same rows. Widening it there widens it here, and the `content.kind`
 * CHECK constraint in `supabase/001_init.sql` must be widened to match.
 */
export type PoolKind = DreamedKind;

/**
 * Keyed memo tables (stand-powers.md "DB additions"):
 *  - powers        — Power Script rows keyed by power id. These live in
 *    `content` with `kind='power'`: one table keeps "give me something for
 *    floor 3" a single query.
 *  - interactions  — resonance rows keyed by pairKey. `rule` may be null:
 *    "these two do not resonate" is a REAL ANSWER and the row exists so it is
 *    never recomputed, by anyone, ever again.
 *  - art           — asset rows keyed by asset id, each recording
 *    styleVersion (visual-v2.md §Style contract).
 */
export type KeyedPoolKind = "powers" | "interactions" | "art";

/** A dreamed thing, with the provenance that lets a later style bump find it. */
export interface ContentRow {
  /** Stable primary key. Derived from the payload id when there is one. */
  id: string;
  kind: PoolKind;
  /** Exactly what the engine consumes, already validated by its own lints. */
  payload: unknown;
  /** Public `catrpg-art` URL. Never a generator URL — see `rehostArt`. */
  artUrl?: string | null;
  artPrompt?: string | null;
  /** The style contract it was authored against (`ART_STYLE.version`). */
  styleVersion: number;
  floorMin: number;
  floorMax: number;
  tier?: number | null;
  /** `dm:<reason>` / `generation-zero` / `stock:*` — who dreamed it and why. */
  provenance?: string | null;
  frameworkVer?: number;
}

/** Narrowing for a pool-first read: kind + floor band + style version. */
export interface PoolQuery {
  floor?: number;
  styleVersion?: number;
}

export interface PoolStore {
  /** How many entries of `kind` match `query` (0 when unavailable). */
  size(kind: PoolKind, query?: PoolQuery): Promise<number>;
  /** Uniform random entry (JSON string) or null when empty/unavailable. */
  sample(kind: PoolKind, query?: PoolQuery): Promise<string | null>;
  /** Store a validated entry. `entryJson` is parsed for its row metadata. */
  add(kind: PoolKind, entryJson: string): Promise<void>;
  /** Row JSON for `key`, or null when the table has no row (never memoized). */
  getEntry(kind: KeyedPoolKind, key: string): Promise<string | null>;
  /** Upsert the row for `key`. */
  setEntry(kind: KeyedPoolKind, key: string, entryJson: string): Promise<void>;
}

/** The richer surface the Dreaming uses. Both impls provide all of it. */
export interface ContentPool extends PoolStore {
  /** Store a fully-specified row (the write path the DM's tools use). */
  addContent(row: ContentRow): Promise<boolean>;
  /**
   * Upsert many rows in ONE request, returning how many landed.
   *
   * PostgREST takes an array body natively, so generation zero is six requests
   * rather than two hundred and fifty — which is the difference between a seed
   * that runs inside any timeout and one that does not.
   */
  addContentBatch(rows: readonly ContentRow[]): Promise<number>;
  /** One suitable dreamed thing, or null. Honours the floor band + style. */
  pick(kind: PoolKind, query?: PoolQuery): Promise<ContentRow | null>;
  /** Fetch by primary key. */
  byId(kind: PoolKind, id: string): Promise<ContentRow | null>;
  /**
   * Upload bytes to the public art bucket and return the PUBLIC URL, or null.
   * Pointing at a generator URL is not persistence — a dreamed thing must keep
   * its picture (roster-and-persistence.md §6).
   */
  putArt(
    objectPath: string,
    bytes: ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<string | null>;
  /** Download a generator URL and re-host it in the bucket. Null on failure. */
  rehostArt(objectPath: string, sourceUrl: string): Promise<string | null>;
  /** False when this is the in-memory fallback (no database configured). */
  readonly durable: boolean;
}

/* ------------------------------------------------------------------------ */
/* Pool-first policy                                                          */
/* ------------------------------------------------------------------------ */

/** Pool-first probability per gm-system.md: p = min(0.7, size/200). */
export function poolPickProbability(size: number): number {
  return Math.min(0.7, Math.max(0, size) / 200);
}

/**
 * Roll the pool-first policy for a store.
 *
 * The probability RISES AS THE POOL GROWS, which is the whole design: an empty
 * world always generates, a world with 200 dreamed things reuses 7 times in
 * 10. An unreachable pool rolls false, so a generation happens and the run is
 * unaffected.
 */
export async function shouldUsePool(
  pool: PoolStore,
  kind: PoolKind,
  random: () => number = Math.random,
  query?: PoolQuery,
): Promise<boolean> {
  try {
    const size = await pool.size(kind, query);
    return random() < poolPickProbability(size);
  } catch {
    return false;
  }
}

const MAX_POOL_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------------ */
/* Row helpers — shared by both impls                                        */
/* ------------------------------------------------------------------------ */

const FLOOR_MIN = 1;
const FLOOR_MAX = 6;

function clampFloor(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, n));
}

/**
 * A stable id for a payload with no id of its own. FNV-1a — deterministic,
 * dependency-free, and good enough for a content key (a collision costs one
 * overwritten dream, not a correctness bug).
 */
function stableId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

/**
 * Reconstruct a `ContentRow` from the JSON shape `PoolStore.add()` has always
 * taken, so the legacy call site keeps working and STILL lands a properly
 * columned row. Recognised keys: `id`, `floor`, `floors: [min,max]`,
 * `styleVersion`, `provenance`, `tier`, `artUrl`, `artPrompt`.
 */
export function rowFromEntryJson(
  kind: PoolKind,
  entryJson: string,
): ContentRow {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(entryJson);
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    /* an unparseable entry still gets a row, keyed by its own text */
  }
  const inner = body.equip ?? body.flavour ?? null;
  const innerId =
    typeof inner === "object" && inner !== null
      ? (inner as Record<string, unknown>).id
      : undefined;
  const rawId =
    typeof body.id === "string"
      ? body.id
      : typeof innerId === "string"
        ? innerId
        : typeof (inner as { subject?: unknown } | null)?.subject === "string"
          ? ((inner as { subject: string }).subject as string)
          : stableId(entryJson);

  const floors = Array.isArray(body.floors) ? body.floors : null;
  const floor = clampFloor(body.floor, FLOOR_MIN);
  return {
    id: `${DREAMED_KIND_COLUMN[kind]}:${rawId}`.slice(0, 200),
    kind,
    payload: body,
    artUrl: typeof body.artUrl === "string" ? body.artUrl : null,
    artPrompt: typeof body.artPrompt === "string" ? body.artPrompt : null,
    styleVersion: typeof body.styleVersion === "number" ? body.styleVersion : 1,
    floorMin: floors ? clampFloor(floors[0], floor) : floor,
    floorMax: floors ? clampFloor(floors[1], FLOOR_MAX) : FLOOR_MAX,
    tier: typeof body.tier === "number" ? body.tier : null,
    provenance: typeof body.provenance === "string" ? body.provenance : null,
    frameworkVer: 1,
  };
}

/* ------------------------------------------------------------------------ */
/* In-memory (dev / no database) — the offline-first guarantee               */
/* ------------------------------------------------------------------------ */

export class MemoryPool implements ContentPool {
  readonly durable = false;
  private readonly lists = new Map<PoolKind, ContentRow[]>();
  private readonly tables = new Map<KeyedPoolKind, Map<string, string>>();

  private table(kind: KeyedPoolKind): Map<string, string> {
    let t = this.tables.get(kind);
    if (!t) {
      t = new Map();
      this.tables.set(kind, t);
    }
    return t;
  }

  private list(kind: PoolKind): ContentRow[] {
    let l = this.lists.get(kind);
    if (!l) {
      l = [];
      this.lists.set(kind, l);
    }
    return l;
  }

  private matching(kind: PoolKind, query?: PoolQuery): ContentRow[] {
    const rows = this.list(kind);
    if (!query) return rows;
    return rows.filter(
      (r) =>
        (query.floor === undefined ||
          (r.floorMin <= query.floor && query.floor <= r.floorMax)) &&
        (query.styleVersion === undefined ||
          r.styleVersion === query.styleVersion),
    );
  }

  size(kind: PoolKind, query?: PoolQuery): Promise<number> {
    return Promise.resolve(this.matching(kind, query).length);
  }

  sample(kind: PoolKind, query?: PoolQuery): Promise<string | null> {
    const rows = this.matching(kind, query);
    if (rows.length === 0) return Promise.resolve(null);
    const row = rows[Math.floor(Math.random() * rows.length)];
    return Promise.resolve(JSON.stringify(row.payload));
  }

  add(kind: PoolKind, entryJson: string): Promise<void> {
    return this.addContent(rowFromEntryJson(kind, entryJson)).then(() => {});
  }

  addContent(row: ContentRow): Promise<boolean> {
    const l = this.list(row.kind);
    const at = l.findIndex((r) => r.id === row.id);
    if (at >= 0) l.splice(at, 1);
    l.unshift(row);
    if (l.length > MAX_POOL_ENTRIES) l.length = MAX_POOL_ENTRIES;
    return Promise.resolve(true);
  }

  async addContentBatch(rows: readonly ContentRow[]): Promise<number> {
    // De-duplicate exactly as `SupabasePool` must, so a DRY RUN reports the
    // number of ROWS that would exist and not the number of writes attempted.
    // (Four of the shipped Power Scripts are the STOCK fallbacks under their
    // own ids — 11 candidates, 7 rows. A dry run that said 11 would be lying
    // about what the shared pool ends up holding.)
    const byId = new Map<string, ContentRow>();
    for (const row of rows) byId.set(row.id, row);
    let n = 0;
    for (const row of byId.values()) if (await this.addContent(row)) n++;
    return n;
  }

  pick(kind: PoolKind, query?: PoolQuery): Promise<ContentRow | null> {
    const rows = this.matching(kind, query);
    if (rows.length === 0) return Promise.resolve(null);
    return Promise.resolve(rows[Math.floor(Math.random() * rows.length)]);
  }

  byId(kind: PoolKind, id: string): Promise<ContentRow | null> {
    return Promise.resolve(this.list(kind).find((r) => r.id === id) ?? null);
  }

  getEntry(kind: KeyedPoolKind, key: string): Promise<string | null> {
    return Promise.resolve(this.table(kind).get(key) ?? null);
  }

  setEntry(kind: KeyedPoolKind, key: string, entryJson: string): Promise<void> {
    this.table(kind).set(key, entryJson);
    return Promise.resolve();
  }

  putArt(): Promise<string | null> {
    return Promise.resolve(null); // no bucket without a database
  }

  rehostArt(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/* ------------------------------------------------------------------------ */
/* Supabase (PostgREST + Storage, over plain fetch)                          */
/* ------------------------------------------------------------------------ */

interface RestRow {
  id?: unknown;
  payload?: unknown;
  art_url?: unknown;
  art_prompt?: unknown;
  style_version?: unknown;
  floor_min?: unknown;
  floor_max?: unknown;
  tier?: unknown;
  author_session?: unknown;
  framework_ver?: unknown;
}

const CONTENT_COLUMNS =
  "id,payload,art_url,art_prompt,style_version,floor_min,floor_max,tier," +
  "author_session,framework_ver";

export class SupabasePool implements ContentPool {
  readonly durable = true;

  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly schema = "catrpg",
    private readonly bucket = "catrpg-art",
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  /* -- transport --------------------------------------------------------- */

  private headers(write: boolean, extra: Record<string, string> = {}) {
    return {
      apikey: this.serviceKey,
      authorization: `Bearer ${this.serviceKey}`,
      // PostgREST only answers for the schema named on the request.
      ...(write
        ? { "content-profile": this.schema }
        : { "accept-profile": this.schema }),
      ...extra,
    };
  }

  private async rest(
    path: string,
    init: RequestInit & {
      write?: boolean;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<Response | null> {
    const { write = false, extraHeaders, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${this.url}/rest/v1/${path}`, {
        ...rest,
        headers: this.headers(write, extraHeaders),
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async selectRows(path: string): Promise<unknown[] | null> {
    const res = await this.rest(path, {
      method: "GET",
      extraHeaders: { accept: "application/json" },
    });
    if (!res?.ok) return null;
    try {
      const body: unknown = await res.json();
      return Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }

  /* -- content ----------------------------------------------------------- */

  private filters(kind: PoolKind, query?: PoolQuery): string {
    const q = [`kind=eq.${encodeURIComponent(DREAMED_KIND_COLUMN[kind])}`];
    if (typeof query?.floor === "number") {
      q.push(`floor_min=lte.${query.floor}`, `floor_max=gte.${query.floor}`);
    }
    if (typeof query?.styleVersion === "number") {
      q.push(`style_version=eq.${query.styleVersion}`);
    }
    return q.join("&");
  }

  private static toRow(kind: PoolKind, raw: unknown): ContentRow | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as RestRow;
    if (typeof r.id !== "string") return null;
    return {
      id: r.id,
      kind,
      payload: r.payload,
      artUrl: typeof r.art_url === "string" ? r.art_url : null,
      artPrompt: typeof r.art_prompt === "string" ? r.art_prompt : null,
      styleVersion: typeof r.style_version === "number" ? r.style_version : 1,
      floorMin: typeof r.floor_min === "number" ? r.floor_min : FLOOR_MIN,
      floorMax: typeof r.floor_max === "number" ? r.floor_max : FLOOR_MAX,
      tier: typeof r.tier === "number" ? r.tier : null,
      provenance:
        typeof r.author_session === "string" ? r.author_session : null,
      frameworkVer: typeof r.framework_ver === "number" ? r.framework_ver : 1,
    };
  }

  async size(kind: PoolKind, query?: PoolQuery): Promise<number> {
    // `Prefer: count=exact` puts the total in Content-Range without shipping
    // the rows: "0-0/143". A HEAD would be cheaper still, but PostgREST wants
    // a range header for it and this is already one small request.
    const res = await this.rest(
      `content?${this.filters(kind, query)}&select=id&limit=1`,
      {
        method: "GET",
        extraHeaders: { prefer: "count=exact", accept: "application/json" },
      },
    );
    if (!res?.ok) return 0;
    const range = res.headers.get("content-range");
    const total = range ? Number.parseInt(range.split("/")[1] ?? "", 10) : NaN;
    // Drain the body so the connection can be reused.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    return Number.isFinite(total) ? total : 0;
  }

  async sample(kind: PoolKind, query?: PoolQuery): Promise<string | null> {
    const row = await this.pick(kind, query);
    return row ? JSON.stringify(row.payload) : null;
  }

  /**
   * A random suitable row. PostgREST cannot `order by random()`, so this takes
   * the freshest, best-rated window and picks inside it: recent dreams stay
   * likely without the pool ever going stale on one lucky row.
   */
  async pick(kind: PoolKind, query?: PoolQuery): Promise<ContentRow | null> {
    const rows = await this.selectRows(
      `content?${this.filters(kind, query)}&select=${CONTENT_COLUMNS}` +
        `&order=rating.desc,created_at.desc&limit=50`,
    );
    if (!rows || rows.length === 0) return null;
    const raw = rows[Math.floor(Math.random() * rows.length)];
    return SupabasePool.toRow(kind, raw);
  }

  async byId(kind: PoolKind, id: string): Promise<ContentRow | null> {
    const rows = await this.selectRows(
      `content?id=eq.${encodeURIComponent(id)}&select=${CONTENT_COLUMNS}&limit=1`,
    );
    return rows?.[0] ? SupabasePool.toRow(kind, rows[0]) : null;
  }

  add(kind: PoolKind, entryJson: string): Promise<void> {
    return this.addContent(rowFromEntryJson(kind, entryJson)).then(() => {});
  }

  private static wire(row: ContentRow): Record<string, unknown> {
    return {
      id: row.id,
      kind: DREAMED_KIND_COLUMN[row.kind],
      payload: row.payload ?? {},
      art_url: row.artUrl ?? null,
      art_prompt: row.artPrompt ?? null,
      style_version: row.styleVersion,
      floor_min: row.floorMin,
      floor_max: row.floorMax,
      tier: row.tier ?? null,
      author_session: row.provenance ?? null,
      framework_ver: row.frameworkVer ?? 1,
    };
  }

  async addContent(row: ContentRow): Promise<boolean> {
    return (await this.addContentBatch([row])) === 1;
  }

  async addContentBatch(rows: readonly ContentRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    // De-duplicate on id first: PostgREST refuses a single ON CONFLICT batch
    // that contains the same key twice ("cannot affect row a second time"), so
    // one repeated id would reject the WHOLE upsert. Last write wins, which is
    // what a re-dream means anyway.
    const byId = new Map<string, ContentRow>();
    for (const row of rows) byId.set(row.id, row);
    const res = await this.rest("content", {
      method: "POST",
      write: true,
      extraHeaders: {
        "content-type": "application/json",
        // Idempotent: re-dreaming the same id refreshes it rather than 409ing.
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([...byId.values()].map(SupabasePool.wire)),
    });
    return res?.ok ? byId.size : 0;
  }

  /* -- keyed tables ------------------------------------------------------ */

  async getEntry(kind: KeyedPoolKind, key: string): Promise<string | null> {
    if (kind === "powers") {
      const row = await this.byId("powers", key);
      return row ? JSON.stringify(row.payload) : null;
    }
    const table = kind === "interactions" ? "interactions" : "art";
    const column = kind === "interactions" ? "pair_key" : "key";
    const rows = await this.selectRows(
      `${table}?${column}=eq.${encodeURIComponent(key)}&select=*&limit=1`,
    );
    const raw = rows?.[0];
    if (typeof raw !== "object" || raw === null) return null;
    // The row IS the answer, including `rule: null` — a stored "these two do
    // not resonate" must be distinguishable from "never judged" (null here).
    return JSON.stringify(raw);
  }

  async setEntry(
    kind: KeyedPoolKind,
    key: string,
    entryJson: string,
  ): Promise<void> {
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(entryJson);
      if (typeof parsed === "object" && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    if (kind === "powers") {
      // A power is content: same table, `kind='power'`, so the pool-first read
      // is one query across everything that has ever been dreamed.
      await this.addContent({
        id: key.startsWith("power:") ? key : `power:${key}`,
        kind: "powers",
        payload: body,
        styleVersion:
          typeof body.styleVersion === "number" ? body.styleVersion : 1,
        floorMin: FLOOR_MIN,
        floorMax: FLOOR_MAX,
        provenance:
          typeof body.provenance === "string" ? body.provenance : null,
        frameworkVer:
          typeof body.version === "number" ? (body.version as number) : 1,
      });
      return;
    }

    const [table, payload] =
      kind === "interactions"
        ? [
            "interactions",
            {
              pair_key: key,
              // NULL IS A VERDICT. `rule: null` means "judged, and they do not
              // resonate" — stored precisely so it is never recomputed.
              rule: body.rule ?? null,
              flavor: typeof body.flavor === "string" ? body.flavor : null,
              announce:
                typeof body.announce === "string" ? body.announce : null,
              framework_ver:
                typeof body.frameworkVer === "number" ? body.frameworkVer : 1,
              first_by: typeof body.firstBy === "string" ? body.firstBy : null,
            },
          ]
        : [
            "art",
            {
              key,
              url: typeof body.url === "string" ? body.url : (body.file ?? ""),
              prompt: typeof body.prompt === "string" ? body.prompt : null,
              style_version:
                typeof body.styleVersion === "number" ? body.styleVersion : 1,
            },
          ];

    await this.rest(table, {
      method: "POST",
      write: true,
      extraHeaders: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([payload]),
    });
  }

  /* -- storage ----------------------------------------------------------- */

  async putArt(
    objectPath: string,
    bytes: ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<string | null> {
    const clean = objectPath.replace(/^\/+/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS * 4); // an image is bigger than a row
    try {
      const res = await fetch(
        `${this.url}/storage/v1/object/${this.bucket}/${clean}`,
        {
          method: "POST",
          headers: {
            apikey: this.serviceKey,
            authorization: `Bearer ${this.serviceKey}`,
            "content-type": contentType,
            "x-upsert": "true",
          },
          body: bytes as BodyInit,
          signal: controller.signal,
        },
      );
      if (!res.ok) return null;
      // The bucket is PUBLIC on purpose: a dreamed thing keeps its picture
      // without a signed request on every frame.
      return `${this.url}/storage/v1/object/public/${this.bucket}/${clean}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pull an image off whatever generated it and re-host it in the bucket.
   *
   * Pointing a pool row at a generator URL is not persistence — that URL is
   * not a durable host, and a dreamed thing whose picture 404s in a month is
   * not persisted, it is remembered wrong (roster-and-persistence.md §6).
   */
  async rehostArt(
    objectPath: string,
    sourceUrl: string,
  ): Promise<string | null> {
    if (!/^https?:\/\//i.test(sourceUrl)) return null;
    // Already ours? Nothing to do.
    if (sourceUrl.startsWith(`${this.url}/storage/v1/object/public/`)) {
      return sourceUrl;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS * 4);
    try {
      const res = await fetch(sourceUrl, { signal: controller.signal });
      if (!res.ok) return null;
      const type = res.headers.get("content-type") ?? "image/png";
      if (!type.startsWith("image/")) return null;
      const bytes = await res.arrayBuffer();
      return await this.putArt(objectPath, bytes, type);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Env-driven default                                                        */
/* ------------------------------------------------------------------------ */

let defaultPool: ContentPool | null = null;

/**
 * Supabase when the service-role credentials are present, in-memory otherwise.
 * NO HARD DEPENDENCY: with the env unset the DM still authors, the tools still
 * answer, and the game still plays — nothing is merely kept.
 */
export function getPool(): ContentPool {
  if (defaultPool) return defaultPool;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  defaultPool =
    url && key
      ? new SupabasePool(
          url,
          key,
          process.env.SUPABASE_SCHEMA || "catrpg",
          process.env.SUPABASE_ART_BUCKET || "catrpg-art",
        )
      : new MemoryPool();
  return defaultPool;
}

/** Test/seed hook: drop the memoised store so env changes take effect. */
export function resetPool(): void {
  defaultPool = null;
}
