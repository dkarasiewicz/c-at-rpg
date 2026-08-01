/**
 * CAT TOWN — the persistent profile: the wallet, the owned unlock ids, the
 * run history, and the rules for spending (balance-and-meta.md §4).
 *
 * Every function is pure — profile in, NEW profile out. Nothing here touches
 * localStorage; core/run/save.ts owns the one storage adapter in the repo
 * and calls `migrateMeta` / `emptyProfile` on the way in and out.
 */
import type { MetaFile } from "../types.js";
import type {
  MetaProfile,
  RunRecord,
  RunSummary,
  UnlockDef,
  UnlockId,
} from "./types.js";
import { computePayout } from "./payout.js";
import type { Payout } from "./types.js";
import { unlockCatalog, unlockDef } from "./unlocks.js";
import { applyUnlocks } from "./overlay.js";
import { observeBattle, readBestiary } from "./bestiary.js";
import {
  readMemorial,
  readRoster,
  readStash,
  settleRun,
  syncRoster,
} from "./roster.js";
import type { BattleEvent, BattleState } from "../types.js";

/**
 * Current meta schema. v1 = lifetime records only; v2 = the town;
 * v3 = the Bestiary (enemy-intel.md §4); v4 = THE ROSTER — cat instances,
 * the memorial and the town stash (roster-and-persistence.md §1-§2).
 */
export const META_VERSION = 4 as const;

/** Runs kept in `history` (newest first). */
export const HISTORY_LIMIT = 10;

/* ------------------------------------------------------------------ */
/* construction & migration                                            */
/* ------------------------------------------------------------------ */

/**
 * A brand-new town: nothing unlocked, nothing banked — and the two cats who
 * live here already (roster-and-persistence.md §2 "you start with one or
 * two"). `syncRoster` seeds them from the base class pool, so the starting
 * clowder and the starting overlay can never drift apart.
 */
export function emptyProfile(): MetaProfile {
  return syncRoster({
    version: META_VERSION,
    counters: { runs: 0, victories: 0 },
    records: { bestScore: 0, fastestVictoryMs: null },
    shinies: 0,
    lifetimeShinies: 0,
    unlocked: [],
    history: [],
    bestiary: {},
    roster: [],
    memorial: [],
    descending: [],
    stash: [],
  });
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function readHistory(v: unknown): RunRecord[] {
  if (!Array.isArray(v)) return [];
  const out: RunRecord[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Partial<RunRecord>;
    out.push({
      seed: typeof rec.seed === "string" ? rec.seed : "",
      victory: rec.victory === true,
      floor: num(rec.floor, 1),
      score: num(rec.score),
      payout: num(rec.payout),
      playTimeMs: num(rec.playTimeMs),
    });
  }
  return out.slice(0, HISTORY_LIMIT);
}

/**
 * Bring a stored meta payload up to `META_VERSION`, or return null when it
 * is from an unknown (future / corrupt) schema and must be discarded.
 *
 * v1 → v2: the counters and records carry over verbatim; the town starts
 * empty (no wallet, no unlocks, no history). A v1 player keeps their best
 * score and simply arrives in a town they have not built yet.
 *
 * v2 → v3: the Bestiary (enemy-intel.md §4). A v2 file has none, so it loads
 * with an empty one — the player keeps every shiny and unlock and simply has
 * not met anything yet. A v3 file is repaired rather than trusted
 * (`readBestiary`), so a hand-edited entry cannot claim a tag outside the
 * vocabulary, a skill the species does not own, or more kills than meetings.
 *
 * v3 → v4: THE ROSTER. A v3 town owned CLASSES, not cats, so the migration
 * turns each class it houses into the individual it always implied — one
 * instance per unlocked class, level 1, 9 Lives, wearing its Stray weapon.
 * The player loses nothing (a v3 profile stored no per-cat progress to lose)
 * and walks into a town whose clowder is exactly the pool the old overlay
 * would have drawn from. `syncRoster` does that fold and the §2 guard rail
 * runs on the way out, so no loaded profile is ever catless.
 */
export function migrateMeta(raw: unknown): MetaProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Omit<Partial<MetaProfile>, "version"> &
    Omit<Partial<MetaFile>, "version"> & { version?: unknown };
  if (
    m.version !== 1 &&
    m.version !== 2 &&
    m.version !== 3 &&
    m.version !== 4
  ) {
    return null;
  }

  const base = emptyProfile();
  const counters = m.counters ?? base.counters;
  const records = m.records ?? base.records;
  const profile: MetaProfile = {
    version: META_VERSION,
    counters: {
      runs: num(counters.runs),
      victories: num(counters.victories),
    },
    records: {
      bestScore: num(records.bestScore),
      fastestVictoryMs:
        typeof records.fastestVictoryMs === "number"
          ? records.fastestVictoryMs
          : null,
    },
    shinies: Math.max(0, Math.floor(num(m.shinies))),
    lifetimeShinies: Math.max(0, Math.floor(num(m.lifetimeShinies))),
    unlocked: dedupe(strings(m.unlocked)),
    history: readHistory(m.history),
    bestiary: readBestiary(m.bestiary),
    roster: readRoster(m.roster),
    memorial: readMemorial(m.memorial),
    descending: strings(m.descending),
    stash: readStash(m.stash),
    ...(typeof m.nextCatId === "number" ? { nextCatId: m.nextCatId } : {}),
    ...(typeof m.nextUid === "number" ? { nextUid: m.nextUid } : {}),
  };
  // a v1 file (or a hand-edited one) can have banked less than it owns
  if (profile.lifetimeShinies < profile.shinies) {
    profile.lifetimeShinies = profile.shinies;
  }
  // v3 → v4: give every class the town owns the cat it always implied, and
  // guarantee the roster is never empty (roster-and-persistence.md §2).
  return syncRoster(profile, applyUnlocks(profile));
}

const dedupe = (ids: readonly string[]): string[] =>
  [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/* ------------------------------------------------------------------ */
/* earning                                                             */
/* ------------------------------------------------------------------ */

export interface BankResult {
  meta: MetaProfile;
  payout: Payout;
}

/**
 * Fold a finished run into the profile — the ONE write the results screen
 * makes. Banks the payout (win or lose), ticks the lifetime counters and
 * records, pushes the run onto the history, and — when the summary carries
 * `cats` — settles the roster: survivors come home with their xp and gear,
 * the fallen are buried for good (roster-and-persistence.md §2).
 */
export function bankRun(meta: MetaProfile, summary: RunSummary): BankResult {
  const payout = computePayout(summary);
  const record: RunRecord = {
    seed: summary.seed,
    victory: summary.victory,
    floor: summary.floorsReached,
    score: summary.score,
    payout: payout.total,
    playTimeMs: summary.playTimeMs,
  };
  const fastest = meta.records.fastestVictoryMs;
  const banked: MetaProfile = {
    ...meta,
    version: META_VERSION,
    counters: {
      runs: meta.counters.runs + 1,
      victories: meta.counters.victories + (summary.victory ? 1 : 0),
    },
    records: {
      bestScore: Math.max(meta.records.bestScore, summary.score),
      fastestVictoryMs: summary.victory
        ? Math.min(fastest ?? Number.POSITIVE_INFINITY, summary.playTimeMs)
        : fastest,
    },
    shinies: meta.shinies + payout.total,
    lifetimeShinies: meta.lifetimeShinies + payout.total,
    history: [record, ...meta.history].slice(0, HISTORY_LIMIT),
  };
  return {
    payout,
    meta: settleRun(banked, summary, applyUnlocks(banked)),
  };
}

/**
 * Fold ONE finished battle into the Bestiary (enemy-intel.md §4) — the write
 * the battle scene makes when the outcome lands, win, lose or flee. Knowledge
 * is earned by fighting, not by surviving: a battle you fled still taught you
 * what hit you.
 */
export function recordBattle(
  meta: MetaProfile,
  state: BattleState,
  events: readonly BattleEvent[],
): MetaProfile {
  const bestiary = observeBattle(meta.bestiary ?? {}, state, events);
  return { ...meta, bestiary };
}

/** Grant shinies outside a run end (debug hooks, gifts, GM rewards). */
export function earnShinies(meta: MetaProfile, amount: number): MetaProfile {
  const n = Math.max(0, Math.floor(amount));
  if (n === 0) return meta;
  return {
    ...meta,
    shinies: meta.shinies + n,
    lifetimeShinies: meta.lifetimeShinies + n,
  };
}

/* ------------------------------------------------------------------ */
/* spending                                                            */
/* ------------------------------------------------------------------ */

export type UnlockState =
  /** already owned */
  | "owned"
  /** prerequisites met and affordable — buy it */
  | "available"
  /** prerequisites met, wallet too light */
  | "unaffordable"
  /** something upstream is still locked */
  | "locked"
  /** no such def in the catalog */
  | "unknown";

export function isUnlocked(meta: MetaProfile, id: UnlockId): boolean {
  return meta.unlocked.includes(id);
}

export function prereqsMet(
  meta: MetaProfile,
  id: UnlockId,
  catalog: readonly UnlockDef[] = unlockCatalog(),
): boolean {
  const def = unlockDef(id, catalog);
  if (!def) return false;
  return def.requires.every((r) => meta.unlocked.includes(r));
}

export function unlockState(
  meta: MetaProfile,
  id: UnlockId,
  catalog: readonly UnlockDef[] = unlockCatalog(),
): UnlockState {
  const def = unlockDef(id, catalog);
  if (!def) return "unknown";
  if (isUnlocked(meta, id)) return "owned";
  if (!prereqsMet(meta, id, catalog)) return "locked";
  return meta.shinies >= def.cost ? "available" : "unaffordable";
}

export interface PurchaseResult {
  ok: boolean;
  /** Unchanged when `ok` is false — purchasing is never partially applied. */
  meta: MetaProfile;
  reason: UnlockState;
}

/**
 * Buy an unlock. IDEMPOTENT: buying something already owned is a no-op that
 * reports `owned` and never charges twice. Prerequisites are checked against
 * the profile, not the catalog order, so a registered pool def with an
 * unowned parent stays shut.
 *
 * A purchase that widens the town's class pool ALSO moves the cat in
 * (`syncRoster`). This is the reported bug's other half: before, `class:*`
 * bought an entry in a pool that no screen could reach — now it buys a cat
 * standing in the town, ready to be fielded from the roster screen.
 */
export function purchase(
  meta: MetaProfile,
  id: UnlockId,
  catalog: readonly UnlockDef[] = unlockCatalog(),
): PurchaseResult {
  const state = unlockState(meta, id, catalog);
  if (state !== "available") return { ok: false, meta, reason: state };
  const def = unlockDef(id, catalog)!;
  const bought: MetaProfile = {
    ...meta,
    shinies: meta.shinies - def.cost,
    unlocked: dedupe([...meta.unlocked, id]),
  };
  return {
    ok: true,
    reason: "available",
    meta: syncRoster(bought, applyUnlocks(bought, catalog)),
  };
}

/** Everything buyable right now (prereqs met, affordable, not owned). */
export function affordableUnlocks(
  meta: MetaProfile,
  catalog: readonly UnlockDef[] = unlockCatalog(),
): UnlockId[] {
  return catalog
    .filter((d) => unlockState(meta, d.id, catalog) === "available")
    .map((d) => d.id);
}

/**
 * What the payout just put within reach — the ids Cat Town highlights when
 * the player walks back in from a run.
 */
export function newlyAffordable(
  before: MetaProfile,
  after: MetaProfile,
  catalog: readonly UnlockDef[] = unlockCatalog(),
): UnlockId[] {
  const was = new Set(affordableUnlocks(before, catalog));
  return affordableUnlocks(after, catalog).filter((id) => !was.has(id));
}
