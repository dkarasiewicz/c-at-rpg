/**
 * c(at)rpg — persistence (ARCHITECTURE.md WP-07: core/run/save.ts).
 *
 * SaveFile = the run minus its `floorMap`: the map regenerates from
 * `(runSeed, floorNum)` on its own RNG stream, and everything mutable about
 * a floor is already two plain fields on the RunState (`currentNodeId`,
 * `visitedNodeIds`). No delta, no bitsets — the tile maze took those with it
 * (run-map-and-dm.md §2). The META slot is Cat Town's profile: lifetime
 * records PLUS the banked wallet, the owned unlock ids and the run history
 * (balance-and-meta.md §4) — shape and rules in core/meta, storage here.
 *
 * This is the ONLY file in the repo allowed to touch localStorage, behind a
 * tiny adapter so tests inject a stub (ARCHITECTURE.md §0 rule 5).
 * Unparseable or unknown-version saves are silently deleted; KNOWN older
 * versions migrate forward instead — a v1/v2 (tile-dungeon) save loads into a
 * freshly generated run map at the same floor rather than being thrown away.
 */
import type { MetaFile, RunState, SaveFile, SaveVersion } from "../types.js";
import type { MetaProfile } from "../meta/types.js";
import { generateFloorMap } from "../map/generate.js";
import { META_VERSION, emptyProfile, migrateMeta } from "../meta/profile.js";
import { enterFloorMap, floorConfig } from "./runState.js";

export const SAVE_KEY = "catrpg.save.v1";
export const META_KEY = "catrpg.meta.v1";

/**
 * Current save schema (docs/design/progression.md §5, run-map-and-dm.md §2).
 *   v1 — pre-progression: no Whisker Points, no loadouts, no collar slot.
 *   v2 — pre-run-map: the tile dungeon, saved as `run.floor` + a FloorDelta.
 *   v3 — current. The run map replaces the maze: `floorMap` regenerates and
 *        `currentNodeId` / `visitedNodeIds` carry the traversal.
 * The localStorage KEY deliberately keeps its `.v1` name — it is a key, not a
 * schema tag, and renaming it would orphan every save on disk.
 */
export const SAVE_VERSION = 3;

/** Versions `loadRun` will accept and migrate forward. */
export const READABLE_SAVE_VERSIONS: readonly SaveVersion[] = [1, 2, 3];

/* ------------------------------------------------------------------ */
/* storage adapter                                                     */
/* ------------------------------------------------------------------ */

export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The real thing. Guarded so headless tests without DOM never explode. */
export const localStorageAdapter: StorageAdapter = {
  get: (k) => globalThis.localStorage?.getItem(k) ?? null,
  set: (k, v) => globalThis.localStorage?.setItem(k, v),
  remove: (k) => globalThis.localStorage?.removeItem(k),
};

/** Map-backed stub for tests. */
export function memoryStorage(): StorageAdapter {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}

/* ------------------------------------------------------------------ */
/* run ⇄ SaveFile                                                      */
/* ------------------------------------------------------------------ */

/** Strip the (regenerable) run map. Requires a generated map. */
export function serializeRun(run: RunState): SaveFile {
  if (!run.floorMap) {
    throw new Error(
      "serializeRun: no run map to snapshot (autosave points always have one)",
    );
  }
  const rest = { ...run };
  delete (rest as Partial<RunState>).floorMap;
  return { version: SAVE_VERSION, run: rest };
}

/** The loose shape a stored `run` object really has before migration. */
type StoredRun = Partial<Omit<RunState, "floorMap">> & {
  runSeed?: unknown;
  floorNum?: unknown;
  /** v1/v2 only: the live tile FloorState, dropped by the v2→v3 migration. */
  floor?: unknown;
};

/**
 * Bring a stored payload up to `SAVE_VERSION`, or return `null` when it is
 * from an unknown (future / corrupt) schema and must be discarded.
 *
 * v1 → v2 (progression.md §5): every progression field is optional and the
 * "absent" behaviour is the v1 behaviour — cats keep their weapon/trinket and
 * simply have no collar (`undefined`), no spent Whisker Points and no custom
 * loadout. That step adds nothing.
 *
 * v2 → v3 (run-map-and-dm.md §2): the tile maze is gone. The `floorDelta`
 * blob and `run.floor` are dropped and the traversal fields are stamped as
 * "not on a map yet" — `deserializeRun` then generates the floor's run map
 * from the seed and lands the party on its entry node. The party keeps its
 * HP, Lives, XP, gear, wallet and floor number; it loses only its position
 * inside a dungeon that no longer exists.
 */
export function migrateSave(sf: SaveFile): SaveFile | null {
  if (!sf || typeof sf !== "object" || !sf.run) return null;
  if (!READABLE_SAVE_VERSIONS.includes(sf.version)) return null;
  if (sf.version === SAVE_VERSION) return sf;

  const carried: StoredRun = { ...(sf.run as StoredRun) };
  delete carried.floor; // the tile FloorState a v1/v2 blob carried inline
  const run = {
    ...carried,
    currentNodeId: null,
    visitedNodeIds: [],
  } as unknown as SaveFile["run"];
  return { version: SAVE_VERSION, run };
}

/**
 * Regenerate the floor's run map from the seed and put the party back on it.
 * A save whose `currentNodeId` is missing or no longer exists on the map
 * (a migrated v1/v2 blob) restarts at the entry node of the equivalent floor.
 */
export function deserializeRun(sf: SaveFile): RunState {
  const { floorNum, runSeed } = sf.run;
  const map = generateFloorMap(runSeed, floorNum, floorConfig(floorNum));
  const run = { ...sf.run, floorMap: map } as RunState;

  const id = run.currentNodeId;
  const known = id !== null && id !== undefined && map.nodes[id] !== undefined;
  if (!known) return enterFloorMap(run, map);
  return {
    ...run,
    visitedNodeIds: (run.visitedNodeIds ?? []).filter(
      (n) => map.nodes[n] !== undefined,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* localStorage plumbing                                               */
/* ------------------------------------------------------------------ */

/** Autosave: one synchronous JSON blob (gameloop.md §9). */
export function saveRun(
  run: RunState,
  storage: StorageAdapter = localStorageAdapter,
): void {
  storage.set(SAVE_KEY, JSON.stringify(serializeRun(run)));
}

/**
 * Load the save, or null. Unparseable / version-mismatched saves are
 * silently DELETED (title's Continue shows iff this returns non-null).
 */
export function loadRun(
  storage: StorageAdapter = localStorageAdapter,
): RunState | null {
  const raw = storage.get(SAVE_KEY);
  if (raw === null) return null;
  try {
    const sf = migrateSave(JSON.parse(raw) as SaveFile);
    if (sf === null) {
      storage.remove(SAVE_KEY);
      return null;
    }
    return deserializeRun(sf);
  } catch {
    storage.remove(SAVE_KEY);
    return null;
  }
}

/** Deleted on RESULTS entry (both outcomes) and on Abandon. */
export function deleteSave(
  storage: StorageAdapter = localStorageAdapter,
): void {
  storage.remove(SAVE_KEY);
}

/* ------------------------------------------------------------------ */
/* MetaFile — the Cat Town profile (balance-and-meta.md §4)            */
/* ------------------------------------------------------------------ */
//
// The persistence half only: the SHAPE, the migration and every rule about
// spending live in core/meta (profile.ts). This file owns storage, nothing
// else — meta v2 (wallet, unlocked ids, run history) reaches disk through
// exactly these four functions.

/** Meta schema this build writes. v1 = records only, v2 = Cat Town. */
export { META_VERSION } from "../meta/profile.js";

/** A fresh profile: no records, empty tin, nothing unlocked. */
export function emptyMeta(): MetaProfile {
  return emptyProfile();
}

/**
 * Load the profile, migrating a v1 (records-only) blob forward. Unparseable
 * or unknown-version payloads fall back to a fresh profile — the same
 * silent-discard rule the run save uses.
 */
export function loadMeta(
  storage: StorageAdapter = localStorageAdapter,
): MetaProfile {
  const raw = storage.get(META_KEY);
  if (raw === null) return emptyProfile();
  try {
    return migrateMeta(JSON.parse(raw)) ?? emptyProfile();
  } catch {
    return emptyProfile();
  }
}

export function saveMeta(
  meta: MetaFile,
  storage: StorageAdapter = localStorageAdapter,
): void {
  storage.set(META_KEY, JSON.stringify(meta));
}

/**
 * Fold a finished run into the LIFETIME RECORDS: runs+1, victories on
 * victory, best score, fastest victory time. The shinies payout, the run
 * history and everything else Cat Town cares about go through
 * `bankRun` (core/meta/profile.ts) — which does this fold too, so a caller
 * that banks must not also call this.
 */
export function recordRunEnd(
  meta: MetaProfile,
  end: { victory: boolean; score: number; playTimeMs: number },
): MetaProfile {
  const fastest = meta.records.fastestVictoryMs;
  return {
    ...meta,
    version: META_VERSION,
    counters: {
      runs: meta.counters.runs + 1,
      victories: meta.counters.victories + (end.victory ? 1 : 0),
    },
    records: {
      bestScore: Math.max(meta.records.bestScore, end.score),
      fastestVictoryMs: end.victory
        ? Math.min(fastest ?? Number.POSITIVE_INFINITY, end.playTimeMs)
        : fastest,
    },
  };
}
