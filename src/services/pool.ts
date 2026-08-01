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
import type {
  EnemyDef,
  EnemyId,
  EquipDef,
  EquipSlot,
  GameEvent,
  IntelTag,
  ItemId,
  Rarity,
  StatKey,
  Stats,
  TraitId,
} from "../core/types.js";
import type {
  Dreamed,
  DreamedBackdrop,
  DreamedChoice,
  DreamedEnemy,
  DreamedEquip,
  DreamedEvent,
  DreamedOrigin,
} from "../core/loot/dreamed.js";
import { validateEvents } from "../core/events/validate.js";
import { lintEventCaps, lintItem } from "./contentLint.js";
import { EQUIP_DEFS } from "../content/equipment.js";
import { ENEMIES } from "../content/enemies.js";
import { SKILLS } from "../content/skills.js";
import type { GeneratedEquip } from "./gmTypes.js";

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
 *
 * THE EXPRESSION SHAPE IS LOAD-BEARING — do not "simplify" it into a local.
 * Vite substitutes the TOKEN `import.meta.env`: in a build esbuild's `define`
 * rewrites that member expression, and the dev server only prepends the env
 * object to modules whose transformed source CONTAINS that exact string. This
 * file used to read
 *
 *     const meta = import.meta as unknown as { env?: … };
 *     return meta.env ?? {};
 *
 * which transpiles to `const meta = import.meta` — the token never appears, no
 * substitution ever happened, and `env` was `undefined` in every environment.
 * `poolReady()` was therefore permanently false: the pool could not have been
 * reached even with all four `VITE_SUPABASE_*` variables correctly set. Keep
 * the property access inline so `import.meta.env` survives into the output.
 */
function viteEnv(): Record<string, string | undefined> {
  const inlined =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  if (inlined.VITE_SUPABASE_URL) return inlined;
  // Fallback for runtimes with no Vite transform in front of them — the agent
  // project, a plain `tsx` script, and the tests, which set these with
  // `vi.stubEnv` AFTER the bundler has already inlined the literal above.
  // Only ever reads the four publishable `VITE_*` names; the service-role key
  // has no spelling that could be picked up here.
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  return proc?.env ?? inlined;
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

/** Rows plus the TOTAL the query matched (which is usually far more). */
interface Page {
  rows: unknown[];
  /** From PostgREST's `Content-Range: 0-19/66`; falls back to `rows.length`. */
  total: number;
}

async function getPage(path: string, wantTotal: boolean): Promise<Page | null> {
  const cfg = config();
  if (!cfg) return null; // short-circuit: no request, ever
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, READ_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      apikey: cfg.anonKey,
      authorization: `Bearer ${cfg.anonKey}`,
      // PostgREST serves the schema named here, per request.
      "accept-profile": cfg.schema,
      accept: "application/json",
    };
    // One request answers both "give me candidates" and "how big is the world"
    // — and the second is what `p = min(0.7, size/200)` is computed from, so
    // the page size never caps the probability.
    if (wantTotal) headers.prefer = "count=exact";
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;
    const range = res.headers.get("content-range") ?? "";
    const slash = range.lastIndexOf("/");
    const parsed =
      slash >= 0 ? Number.parseInt(range.slice(slash + 1), 10) : NaN;
    return {
      rows: body,
      total: Number.isFinite(parsed) && parsed >= 0 ? parsed : body.length,
    };
  } catch {
    return null; // network, abort, malformed JSON — all the same to a caller
  } finally {
    clearTimeout(timer);
  }
}

async function get(path: string): Promise<unknown[] | null> {
  return (await getPage(path, false))?.rows ?? null;
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
function dreamedQuery(
  column: string,
  options: ReadDreamedOptions,
): string | null {
  if (!column) return null;
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
  return `content?${q.join("&")}`;
}

export async function readDreamed(
  kind: DreamedKind,
  options: ReadDreamedOptions = {},
): Promise<DreamedRow[]> {
  return (await readDreamedPage(kind, options)).rows;
}

/**
 * `readDreamed` plus the TOTAL number of rows the query matched — the number
 * `p = min(0.7, size/200)` is computed from. `{ rows: [], total: 0 }` is the
 * unreachable/unconfigured answer, which is also the "do nothing" answer.
 */
export async function readDreamedPage(
  kind: DreamedKind,
  options: ReadDreamedOptions = {},
): Promise<{ rows: DreamedRow[]; total: number }> {
  const path = dreamedQuery(DREAMED_KIND_COLUMN[kind], options);
  if (!path) return { rows: [], total: 0 };
  const page = await getPage(path, true);
  if (!page) return { rows: [], total: 0 };
  const out: DreamedRow[] = [];
  for (const raw of page.rows) {
    const row = toDreamed(raw, kind);
    if (row) out.push(row);
  }
  return { rows: out, total: page.total };
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

/* ========================================================================== */
/* THE ARRIVAL GATE                                                           */
/* ========================================================================== */
/**
 * Everything below turns rows into things the engines may touch.
 *
 * A row in `catrpg.content` was authored BY A MODEL, ON SOMEBODY ELSE'S
 * MACHINE, and stored by a service that this browser does not control. It is
 * exactly as trustworthy as a query string. So the same defence in depth the
 * DM's own verdicts get is applied here, on arrival, before the engine ever
 * sees a payload:
 *
 *  1. **Re-lint with the SHIPPED validators.** Events go through
 *     `core/events/validate` (the 7 authoring invariants the static content
 *     passes) and the `EVENT_CAPS` numbers from `services/contentLint`;
 *     items through `lintItem`. Nothing bespoke is invented for the checks
 *     that already exist.
 *  2. **Whitelist, never spread.** A validated thing is REBUILT field by
 *     field from known keys. An extra key in a payload cannot reach the
 *     engine, because nothing copies it.
 *  3. **Shipped content always wins.** A row whose id collides with shipped
 *     content resolves to the SHIPPED def. There is no way for a pool row to
 *     rewrite `mittsOfMenace` or `ratThug` into something stronger — the
 *     worst a collision can do is hand the player the item they already had.
 *  4. **Drop, never repair.** A row that fails anything is discarded whole
 *     and silently; the caller falls back to authored content, which is the
 *     same thing it does when the network is down.
 */

/* ------------------------------------------------------------------------ */
/* Small typed guards                                                        */
/* ------------------------------------------------------------------------ */

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max
    ? v
    : null;
}

function intIn(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi
    ? v
    : null;
}

/**
 * `Record<Union, true>` rather than an array: adding a member to `TraitId` or
 * `IntelTag` becomes a COMPILE ERROR here instead of a silently narrower
 * filter that quietly drops every dream carrying the new tag.
 */
const TRAIT_OK: Record<TraitId, true> = {
  heavy: true,
  immovableLoaf: true,
  opportunist: true,
  stringTheory: true,
  purrEngine: true,
};
const INTEL_OK: Record<IntelTag, true> = {
  shove: true,
  offBalance: true,
  scratched: true,
  frazzled: true,
  provoked: true,
};
const SLOT_OK: Record<EquipSlot, true> = {
  weapon: true,
  trinket: true,
  collar: true,
};
/** The `Effect` union's discriminants — see core/types.ts §2.8. */
const EFFECT_KIND_OK: Record<string, true> = {
  heal: true,
  damage: true,
  buff: true,
  shinies: true,
  giveItem: true,
  takeItem: true,
  restoreLife: true,
  energyNextBattle: true,
  fight: true,
  nothing: true,
};

function tagList<T extends string>(
  v: unknown,
  ok: Record<string, true>,
): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const t of v) {
    if (typeof t !== "string" || !ok[t]) return null;
    out.push(t as T);
  }
  return out;
}

function originOf(row: DreamedRow): DreamedOrigin {
  return {
    rowId: row.id,
    provenance: row.provenance,
    byStray: (row.provenance ?? "").startsWith("dm:"),
  };
}

/* ------------------------------------------------------------------------ */
/* Items                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * An `items` row → an `EquipDef` the loot ladder may roll.
 *
 * Consumable rows live in the same table (generation zero seeded both) and
 * are simply not candidates here: the §7 consumable table is a weighted list,
 * not a def pick, so there is nowhere for a dreamed one to slot in without
 * inventing a weight for it. They are dropped, not failed.
 */
export function validateDreamedItem(row: DreamedRow): DreamedEquip | null {
  const payload = obj(row.payload);
  if (!payload) return null;
  const equip = obj(payload.equip);
  if (!equip) return null;
  const id = text(equip.id, 40);
  if (!id) return null;

  // ── shipped content always wins ──────────────────────────────────────
  // The row cannot redefine a def this build ships; it can only point at it.
  const shipped = EQUIP_DEFS[id];
  if (shipped) return { origin: originOf(row), value: shipped };
  // A consumable (price + battleSkill, no slot) is not a def pick candidate.
  if (equip.slot === undefined) return null;

  // ── the SHIPPED item lint, verbatim ──────────────────────────────────
  // Same function `agent/tools/contribute_content.ts` had to pass to write
  // the row. Its rarity-coupled clauses need the rarity the row was priced
  // at; a row that lost it is linted as `stray`, the rarity that FORBIDS a
  // Mewthical hook — the safe direction.
  const rarity: Rarity =
    typeof payload.rarity === "string" &&
    ["stray", "sleek", "pedigree", "mewthical"].includes(payload.rarity)
      ? (payload.rarity as Rarity)
      : "stray";
  if (lintItem(equip as unknown as GeneratedEquip, rarity).length > 0) {
    return null;
  }

  // ── rebuild from known keys only ─────────────────────────────────────
  const slot = typeof equip.slot === "string" ? equip.slot : "";
  if (!SLOT_OK[slot as EquipSlot]) return null;
  const icon = text(equip.icon, 4);
  const name = text(equip.name, 40);
  const pool = equip.secondaryPool;
  if (!icon || !name || !Array.isArray(pool) || pool.length !== 2) return null;
  const def: EquipDef = {
    id: id as ItemId,
    name,
    icon,
    slot: slot as EquipSlot,
    primary: equip.primary as StatKey,
    secondaryPool: [pool[0] as StatKey, pool[1] as StatKey],
  };
  if (typeof equip.classId === "string") {
    def.classId = equip.classId as EquipDef["classId"];
  }
  if (typeof equip.uniqueId === "string") {
    def.uniqueId = equip.uniqueId as EquipDef["uniqueId"];
    const uniqueName = text(equip.uniqueName, 40);
    if (uniqueName) def.uniqueName = uniqueName;
  }
  registerDreamedEquip(def);
  return { origin: originOf(row), value: def };
}

/* ------------------------------------------------------------------------ */
/* Events                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The id `lintEventCaps` is asked to price INSTEAD of the row's own.
 *
 * That function is an AUTHORING lint: two of its rules ("the id must start
 * with `gm`", "the id must not collide with a shipped event") ask where a
 * card came from, which on arrival is already known — the row is in the pool,
 * and generation zero seeded the shipped cards into it under their own ids.
 * Everything else it does is the per-floor damage / heal / shinies / buff /
 * energy / item-count / encounter-size CEILING table, which is exactly what
 * a poisoned card must not be able to exceed. Pricing a clone under a legal
 * id runs the whole cap table for real and neutralises only the two
 * provenance questions.
 */
const CAP_PROBE_ID = "gmDreamedArrival";

/** An `events` row → a `GameEvent` the event scene may show. */
export function validateDreamedEvent(row: DreamedRow): DreamedEvent | null {
  const payload = obj(row.payload);
  if (!payload) return null;
  const id = text(payload.id, 60);
  const title = text(payload.title, 80);
  const prompt = text(payload.prompt, 1200);
  const floors = payload.floors;
  if (!id || !title || !prompt) return null;
  if (
    !Array.isArray(floors) ||
    floors.length !== 2 ||
    intIn(floors[0], 1, 6) === null ||
    intIn(floors[1], 1, 6) === null ||
    (floors[0] as number) > (floors[1] as number)
  ) {
    return null;
  }
  if (typeof payload.weight !== "number" || !(payload.weight > 0)) return null;
  if (!Array.isArray(payload.options)) return null;

  // Every effect kind must be one the resolver actually implements. The
  // switch in `core/events/resolve.ts` has no default arm, so an invented
  // kind would resolve to a silent no-op — an outcome whose text promised
  // something and whose effects did nothing. Dropped instead.
  if (!effectKindsOk(payload.options)) return null;

  const event = payload as unknown as GameEvent;
  // The SHIPPED structural validator: the walk-away rule, fight placement,
  // gateCat gating, id cross-references, per-floor scalar sanity.
  if (validateEvents([event]).length > 0) return null;
  // The SHIPPED numeric ceilings (see CAP_PROBE_ID above).
  if (lintEventCaps({ ...event, id: CAP_PROBE_ID }).length > 0) return null;

  return {
    origin: originOf(row),
    value: {
      id,
      title,
      prompt,
      weight: event.weight,
      floors: [floors[0] as number, floors[1] as number],
      options: event.options,
      once: event.once === true ? true : undefined,
    } as GameEvent,
  };
}

/** Walk options → outcomes → effects (and `fight.onWinEffects`) for kinds. */
function effectKindsOk(options: unknown[]): boolean {
  const walk = (effects: unknown, depth: number): boolean => {
    if (depth > 4 || !Array.isArray(effects)) return false;
    for (const raw of effects) {
      const e = obj(raw);
      if (!e || typeof e.kind !== "string" || !EFFECT_KIND_OK[e.kind]) {
        return false;
      }
      if (e.kind === "fight" && e.onWinEffects !== undefined) {
        if (!walk(e.onWinEffects, depth + 1)) return false;
      }
    }
    return true;
  };
  for (const rawOpt of options) {
    const opt = obj(rawOpt);
    if (!opt || !Array.isArray(opt.outcomes)) return false;
    for (const rawOutcome of opt.outcomes) {
      const outcome = obj(rawOutcome);
      if (!outcome || !walk(outcome.effects, 0)) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* Enemies                                                                   */
/* ------------------------------------------------------------------------ */

/** Stat ceilings for a dreamed body, well above the shipped roster's worst. */
const ENEMY_STAT_BOUNDS: Record<keyof Stats, [number, number]> = {
  hp: [1, 300],
  atk: [0, 60],
  def: [0, 10],
  spd: [1, 20],
  crt: [0, 100],
  enMax: [0, 0],
};

/**
 * An `enemies` row → an `EnemyDef` a pack may field.
 *
 * There is no shipped validator for an enemy (the DM's write path only
 * shape-checks the narrative fields), so this IS the validator, and it is
 * strict on purpose: a pack member's stat block, skill list and traits are
 * read by `core/combat/setup`, `ai` and `resolve` without a guard anywhere,
 * so an unknown skill id or a 9,999-HP body is a broken run rather than a bad
 * one. Two rules do most of the work:
 *
 *  - every `skills` entry must exist in the SHIPPED `SKILLS` table, so a
 *    dream can only recombine moves the engine already implements;
 *  - a `boss` block is refused outright. A boss is a floor's authored
 *    destination with Poise, phases and its own loot table; one wandering
 *    into a corridor pack is not a surprise, it is a wipe.
 */
export function validateDreamedEnemy(row: DreamedRow): DreamedEnemy | null {
  const p = obj(row.payload);
  if (!p) return null;
  const id = text(p.id, 40);
  if (!id) return null;

  // Shipped content always wins — a row may point at `ratThug`, never edit it.
  const shipped = ENEMIES[id];
  if (shipped) {
    return shipped.boss ? null : { origin: originOf(row), value: shipped };
  }
  if (p.boss !== undefined) return null;

  const name = text(p.name, 40);
  const tier = intIn(p.tier, 1, 3);
  const level = intIn(p.level, 1, 40);
  const description = text(p.description, 600);
  const tell = text(p.tell, 300);
  const threat = intIn(p.threat, 0, 6);
  const xp = intIn(p.xp, 0, 200);
  const weaknesses = tagList<IntelTag>(p.weaknesses, INTEL_OK);
  const resistances = tagList<IntelTag>(p.resistances, INTEL_OK);
  const traits = tagList<TraitId>(p.traits, TRAIT_OK);
  if (
    !name ||
    tier === null ||
    level === null ||
    !description ||
    !tell ||
    threat === null ||
    xp === null ||
    !weaknesses ||
    !resistances ||
    !traits
  ) {
    return null;
  }
  if (p.row !== "front" && p.row !== "back") return null;

  const rawStats = obj(p.stats);
  if (!rawStats) return null;
  const stats = {} as Stats;
  for (const key of Object.keys(ENEMY_STAT_BOUNDS) as (keyof Stats)[]) {
    const [lo, hi] = ENEMY_STAT_BOUNDS[key];
    const v = intIn(rawStats[key], lo, hi);
    if (v === null) return null;
    stats[key] = v;
  }

  if (!Array.isArray(p.skills) || p.skills.length === 0) return null;
  const skills: string[] = [];
  for (const s of p.skills) {
    if (typeof s !== "string" || !SKILLS[s]) return null;
    skills.push(s);
  }

  const look = obj(p.look);
  if (!look) return null;
  const family = look.family;
  const sizeGrade = look.sizeGrade;
  if (
    family !== "vermin" &&
    family !== "bird" &&
    family !== "beast" &&
    family !== "construct"
  ) {
    return null;
  }
  if (
    sizeGrade !== "minion" &&
    sizeGrade !== "standard" &&
    sizeGrade !== "elite" &&
    sizeGrade !== "boss"
  ) {
    return null;
  }
  const props = Array.isArray(look.props)
    ? look.props.filter((v): v is string => typeof v === "string").slice(0, 8)
    : undefined;

  const def: EnemyDef = {
    id: id as EnemyId,
    name,
    tier: tier as 1 | 2 | 3,
    level,
    description,
    tell,
    weaknesses,
    resistances,
    threat,
    row: p.row,
    stats,
    skills,
    traits,
    xp,
    look: {
      family,
      sizeGrade: sizeGrade === "boss" ? "elite" : sizeGrade,
      tier: tier as 1 | 2 | 3,
      ...(props && props.length > 0 ? { props } : {}),
    },
  };
  registerDreamedEnemy(def);
  return { origin: originOf(row), value: def };
}

/* ------------------------------------------------------------------------ */
/* Backdrops                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A `backgrounds` row → the dressing for one floor. Cosmetic by construction:
 * only the name and the picture are read, so the worst a poisoned backdrop
 * can do is call floor 3 something silly.
 */
export function validateDreamedBackdrop(
  row: DreamedRow,
): Dreamed<DreamedBackdrop> | null {
  const p = obj(row.payload);
  if (!p) return null;
  const id = text(p.id, 60);
  const name = text(p.name, 40);
  const floor = intIn(p.floor, 1, 6) ?? row.floorMin;
  if (!id || !name) return null;
  return {
    origin: originOf(row),
    value: { id, name, floor, artUrl: row.artUrl },
  };
}

/* ------------------------------------------------------------------------ */
/* The registry: dreamed defs the rest of the game can look up by id         */
/* ========================================================================== */
/**
 * A dropped item and a fought enemy are both PERSISTED by id — an
 * `EquipInstance` stores a `defId`, a saved battle stores a `speciesId` — and
 * a dozen places (`overlays/inventoryPanel`, `overlays/loot`, `combat/setup`)
 * look the def straight back up out of the shipped table. So a dreamed def
 * must BE in that table for as long as anything can still reference it, or a
 * reload after the pool goes away is a crash rather than a downgrade.
 *
 * Hence two steps, both cheap:
 *  - register the validated def into the shipped record, and
 *  - keep a copy in `localStorage`, re-validated and re-registered by
 *    `hydrateDreamedDefs()` at boot with NO network call at all.
 *
 * The stored copy is as untrusted as the row was — it sits in a store the
 * player can edit — so hydration runs the same validators over it. Shipped
 * ids are never overwritten (`in` check), so this can only ADD content.
 */
const DEFS_KEY = "catrpg.dreamed.defs.v1";
const MAX_STORED_DEFS = 120;

/** Defs registered this session, by kind, so the store can be rewritten. */
const registered = {
  equips: new Map<string, EquipDef>(),
  enemies: new Map<string, EnemyDef>(),
};

function registerDreamedEquip(def: EquipDef): void {
  if (def.id in EQUIP_DEFS) return;
  EQUIP_DEFS[def.id] = def;
  registered.equips.set(def.id, def);
  persistDefs();
}

function registerDreamedEnemy(def: EnemyDef): void {
  if (def.id in ENEMIES) return;
  ENEMIES[def.id] = def;
  registered.enemies.set(def.id, def);
  persistDefs();
}

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // private mode / blocked storage — the game plays on
  }
}

function persistDefs(): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(
      DEFS_KEY,
      JSON.stringify({
        equips: [...registered.equips.values()].slice(-MAX_STORED_DEFS),
        enemies: [...registered.enemies.values()].slice(-MAX_STORED_DEFS),
      }),
    );
  } catch {
    /* quota / disabled — the defs simply do not survive the tab */
  }
}

let hydrated = false;

/**
 * Re-register previously dreamed defs from `localStorage`. Synchronous, no
 * network, safe to call repeatedly, and a no-op when nothing was ever
 * dreamed — so it can sit at the top of every entry point.
 */
export function hydrateDreamedDefs(): void {
  if (hydrated) return;
  hydrated = true;
  const s = store();
  if (!s) return;
  let raw: string | null = null;
  try {
    raw = s.getItem(DEFS_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const body = obj(parsed);
  if (!body) return;
  // Re-validated through the ordinary arrival path: a hand-edited store is
  // just another untrusted payload.
  for (const equip of Array.isArray(body.equips) ? body.equips : []) {
    validateDreamedItem({
      id: `local:${String(obj(equip)?.id ?? "?")}`,
      kind: "items",
      payload: { equip },
      artUrl: null,
      styleVersion: 1,
      floorMin: 1,
      floorMax: 6,
      tier: null,
      provenance: "local-cache",
      createdAt: null,
    });
  }
  for (const enemy of Array.isArray(body.enemies) ? body.enemies : []) {
    validateDreamedEnemy({
      id: `local:${String(obj(enemy)?.id ?? "?")}`,
      kind: "enemies",
      payload: enemy,
      artUrl: null,
      styleVersion: 1,
      floorMin: 1,
      floorMax: 6,
      tier: null,
      provenance: "local-cache",
      createdAt: null,
    });
  }
}

/* ========================================================================== */
/* The session cache: async prime, SYNCHRONOUS consume                        */
/* ========================================================================== */
/**
 * THE PLAYER NEVER WAITS ON THE NETWORK.
 *
 * The engines that need this are pure and synchronous — `rollChest`,
 * `selectEvent`, `encounterFor` — and every one of them runs the instant a
 * node is stepped on. So nothing here is awaited on the hot path. A floor
 * entry PRIMES the pool (fire and forget, one hard-timeout request per kind)
 * and every decision afterwards reads whatever landed, synchronously. If the
 * prime is still in flight, or timed out, or the pool is not configured at
 * all, the read is an empty `DreamedChoice` and the roll is the authored one.
 *
 * The cache is per session and per floor, never invalidated: a run is minutes
 * long, the pool changes on the scale of other people's playthroughs, and a
 * mid-floor refetch could only make two decisions on the same floor disagree.
 */
/**
 * The four kinds a run actually reads. `DreamedKind` is wider — stands, cats,
 * encounters and powers are the DM's own surface — and this narrowing is what
 * keeps a floor entry to four requests.
 */
type CachedKind = Extract<
  DreamedKind,
  "items" | "events" | "enemies" | "backgrounds"
>;

/** Candidates fetched per floor. Wide enough for variety, small enough to be one packet. */
const PAGE_LIMIT = 60;

interface FloorDreams {
  items: DreamedChoice<EquipDef>;
  events: DreamedChoice<GameEvent>;
  enemies: DreamedChoice<EnemyDef>;
  backgrounds: DreamedChoice<DreamedBackdrop>;
}

const EMPTY: DreamedChoice<never> = { candidates: [], poolSize: 0 };

function emptyFloor(): FloorDreams {
  return {
    items: EMPTY,
    events: EMPTY,
    enemies: EMPTY,
    backgrounds: EMPTY,
  };
}

const floors = new Map<number, FloorDreams>();
const inFlight = new Map<number, Promise<void>>();

const VALIDATORS: {
  [K in CachedKind]: (row: DreamedRow) => Dreamed<unknown> | null;
} = {
  items: validateDreamedItem,
  events: validateDreamedEvent,
  enemies: validateDreamedEnemy,
  backgrounds: validateDreamedBackdrop,
};

async function fetchKind(
  kind: CachedKind,
  floor: number,
): Promise<DreamedChoice<unknown>> {
  let page: { rows: DreamedRow[]; total: number };
  try {
    page = await readDreamedPage(kind, { floor, limit: PAGE_LIMIT });
  } catch {
    return EMPTY; // the reader already swallows everything; belt and braces
  }
  const validate = VALIDATORS[kind];
  const candidates: Dreamed<unknown>[] = [];
  for (const row of page.rows) {
    // A validator that THROWS on a shape nobody imagined must still only cost
    // its own row — never the page, never the floor, never the run.
    try {
      const ok = validate(row);
      if (ok) candidates.push(ok);
    } catch {
      /* dropped, like any other row that failed */
    }
  }
  // `poolSize` is the whole world's count for this kind and floor; the
  // candidates are the page that survived arrival. A pool full of rows that
  // all fail validation therefore still has p > 0 and simply never picks —
  // which is correct: there is nothing to pick.
  return { candidates, poolSize: candidates.length === 0 ? 0 : page.total };
}

/**
 * Warm the cache for a floor. FIRE AND FORGET — the returned promise exists
 * for tests, and no scene awaits it. Never throws, never rejects; with the
 * pool unconfigured it makes ZERO requests and resolves immediately.
 */
export function primeDreaming(floor: number): Promise<void> {
  hydrateDreamedDefs(); // synchronous, offline, and the reason a saved run loads
  installLedgerHook();
  const existing = inFlight.get(floor);
  if (existing) return existing;
  if (floors.has(floor)) return Promise.resolve();
  if (!poolReady()) {
    floors.set(floor, emptyFloor());
    return Promise.resolve();
  }
  const job = (async (): Promise<void> => {
    // Each kind has its own validator, so each is fetched and narrowed on its
    // own; one kind failing never costs the other three. All four go out at
    // once because they share a floor and a timeout.
    const [items, events, enemies, backgrounds] = await Promise.all([
      fetchKind("items", floor),
      fetchKind("events", floor),
      fetchKind("enemies", floor),
      fetchKind("backgrounds", floor),
    ]);
    floors.set(floor, {
      items: items as DreamedChoice<EquipDef>,
      events: events as DreamedChoice<GameEvent>,
      enemies: enemies as DreamedChoice<EnemyDef>,
      backgrounds: backgrounds as DreamedChoice<DreamedBackdrop>,
    });
  })().finally(() => {
    inFlight.delete(floor);
  });
  inFlight.set(floor, job);
  return job;
}

function dreamsFor(floor: number): FloorDreams {
  return floors.get(floor) ?? emptyFloor();
}

/** Dreamed equipment legal on `floor`. Empty until (and unless) a prime lands. */
export function dreamedEquips(floor: number): DreamedChoice<EquipDef> {
  return dreamsFor(floor).items;
}

/** Dreamed event cards legal on `floor`. */
export function dreamedEvents(floor: number): DreamedChoice<GameEvent> {
  return dreamsFor(floor).events;
}

/** Dreamed enemies legal on `floor`, already registered in `ENEMIES`. */
export function dreamedEnemies(floor: number): DreamedChoice<EnemyDef> {
  return dreamsFor(floor).enemies;
}

/** Dreamed backdrops for `floor`. */
export function dreamedBackdrops(
  floor: number,
): DreamedChoice<DreamedBackdrop> {
  return dreamsFor(floor).backgrounds;
}

/** Test hook: forget every cached floor, every registration and the store. */
export function resetDreaming(): void {
  floors.clear();
  inFlight.clear();
  registered.equips.clear();
  registered.enemies.clear();
  hydrated = false;
  used.length = 0;
}

/* ------------------------------------------------------------------------ */
/* What actually reached the player                                          */
/* ------------------------------------------------------------------------ */

/** One dreamed thing that made it onto a screen. */
export interface DreamedUse {
  kind: CachedKind;
  /** `catrpg.content.id` — the row, quotable as evidence. */
  rowId: string;
  /** Where it showed up: 'chest' | 'peddler' | 'event' | 'pack' | 'floor'. */
  where: string;
  /** The thing's own id inside the payload. */
  ref: string;
  provenance: string | null;
}

const used: DreamedUse[] = [];

/**
 * Expose the ledger on `window.__dreaming` — read-only, same family as
 * `main.ts`'s `__scene` / `__run` hooks, and the thing a smoke reads to prove
 * a specific `catrpg.content` row reached a player rather than inferring it
 * from pixels. Installed at the first prime, so it answers even when a run
 * dreams nothing (which is a result worth being able to read).
 */
function installLedgerHook(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { __dreaming?: () => unknown }).__dreaming =
    (): unknown => ({
      ready: poolReady(),
      sizes: Object.fromEntries(
        [...floors.entries()].map(([f, d]) => [
          f,
          {
            items: d.items.poolSize,
            events: d.events.poolSize,
            enemies: d.enemies.poolSize,
            backgrounds: d.backgrounds.poolSize,
          },
        ]),
      ),
      used: used.slice(),
    });
}

/** Record that a dreamed thing reached the screen. */
export function noteDreamedUse(
  kind: CachedKind,
  origin: DreamedOrigin,
  where: string,
  ref: string,
): void {
  used.push({
    kind,
    rowId: origin.rowId,
    where,
    ref,
    provenance: origin.provenance,
  });
  installLedgerHook();
}
