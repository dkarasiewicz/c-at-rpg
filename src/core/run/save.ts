/**
 * c(at)rpg — persistence (ARCHITECTURE.md WP-07: core/run/save.ts).
 *
 * SaveFile = the run minus its FloorState, plus a FloorDelta: tiles/rooms/
 * entities regenerate from the seed and the delta overlays mutable state
 * (GDD §9 ruling). MetaFile keeps lifetime records only — no unlocks.
 *
 * This is the ONLY file in the repo allowed to touch localStorage, behind a
 * tiny adapter so tests inject a stub (ARCHITECTURE.md §0 rule 5).
 * Version-mismatched or unparseable saves are silently deleted (no
 * migrations in v1 — gameloop.md §9).
 */
import type {
  FloorDelta,
  FloorState,
  MetaFile,
  RunState,
  SaveFile,
} from "../types";
import { decodeBitset, encodeBitset } from "../util";
import { FLOORS } from "../../content/floors";
import { generateFloor } from "../dungeon/gen";
import { recomputeVisibility } from "../dungeon/floor";

export const SAVE_KEY = "catrpg.save.v1";
export const META_KEY = "catrpg.meta.v1";
export const SAVE_VERSION = 1;

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
/* floor ⇄ delta                                                       */
/* ------------------------------------------------------------------ */

/** Snapshot the mutable overlay of a floor (types.ts §2.9 FloorDelta). */
export function floorToDelta(f: FloorState): FloorDelta {
  return {
    partyPos: { x: f.party.x, y: f.party.y },
    explored: encodeBitset(f.explored),
    stepCount: f.stepCount,
    stairsLocked: f.stairsLocked,
    entities: f.entities.map((e) => {
      if (e.kind === "chest") {
        return { kind: "chest" as const, id: e.id, opened: e.opened };
      }
      if (e.kind === "event") {
        return { kind: "event" as const, id: e.id, used: e.used };
      }
      return {
        kind: e.kind,
        id: e.id,
        x: e.x,
        y: e.y,
        dead: e.dead,
        state: e.state,
        stunnedFor: e.stunnedFor,
        lostSightFor: e.lostSightFor,
        wpIndex: e.wpIndex,
      };
    }),
  };
}

/** Overlay a delta onto a freshly regenerated floor (mutates `f`). */
export function applyFloorDelta(f: FloorState, d: FloorDelta): void {
  f.party = { x: d.partyPos.x, y: d.partyPos.y };
  f.stepCount = d.stepCount;
  f.stairsLocked = d.stairsLocked;
  f.explored = decodeBitset(d.explored, f.w * f.h);
  for (const de of d.entities) {
    const e = f.entities[de.id];
    if (!e || e.kind !== de.kind) continue; // regen mismatch: skip defensively
    if (de.kind === "chest" && e.kind === "chest") {
      e.opened = de.opened;
    } else if (de.kind === "event" && e.kind === "event") {
      e.used = de.used;
    } else if (
      (de.kind === "roamer" || de.kind === "boss") &&
      (e.kind === "roamer" || e.kind === "boss")
    ) {
      e.x = de.x;
      e.y = de.y;
      e.dead = de.dead;
      e.state = de.state;
      e.stunnedFor = de.stunnedFor;
      e.lostSightFor = de.lostSightFor;
      e.wpIndex = de.wpIndex;
    }
  }
  recomputeVisibility(f); // rebuild `visible` (a Set is never serialized)
}

/* ------------------------------------------------------------------ */
/* run ⇄ SaveFile                                                      */
/* ------------------------------------------------------------------ */

/** Strip the live floor into a delta. Requires a generated floor. */
export function serializeRun(run: RunState): SaveFile {
  if (!run.floor) {
    throw new Error(
      "serializeRun: no floor to snapshot (autosave points always have one)",
    );
  }
  const { floor, ...rest } = run;
  return { version: SAVE_VERSION, run: rest, floorDelta: floorToDelta(floor) };
}

/** Regenerate the floor from the seed and overlay the saved delta. */
export function deserializeRun(sf: SaveFile): RunState {
  const { floorNum, runSeed } = sf.run;
  const cfg = FLOORS[floorNum - 1];
  if (!cfg) throw new Error(`deserializeRun: bad floorNum ${floorNum}`);
  const floor = generateFloor(runSeed, floorNum, cfg);
  applyFloorDelta(floor, sf.floorDelta);
  return { ...sf.run, floor };
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
    const sf = JSON.parse(raw) as SaveFile;
    if (sf.version !== SAVE_VERSION) {
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
/* MetaFile — lifetime records, no unlocks                             */
/* ------------------------------------------------------------------ */

export function emptyMeta(): MetaFile {
  return {
    version: 1,
    counters: { runs: 0, victories: 0 },
    records: { bestScore: 0, fastestVictoryMs: null },
  };
}

export function loadMeta(
  storage: StorageAdapter = localStorageAdapter,
): MetaFile {
  const raw = storage.get(META_KEY);
  if (raw === null) return emptyMeta();
  try {
    const meta = JSON.parse(raw) as MetaFile;
    return meta.version === 1 ? meta : emptyMeta();
  } catch {
    return emptyMeta();
  }
}

export function saveMeta(
  meta: MetaFile,
  storage: StorageAdapter = localStorageAdapter,
): void {
  storage.set(META_KEY, JSON.stringify(meta));
}

/**
 * Fold a finished run into the records (written on every RESULTS entry):
 * runs+1, victories on victory, best score, fastest victory time.
 */
export function recordRunEnd(
  meta: MetaFile,
  end: { victory: boolean; score: number; playTimeMs: number },
): MetaFile {
  const fastest = meta.records.fastestVictoryMs;
  return {
    version: 1,
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
