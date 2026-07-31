/**
 * CAT TOWN — `applyUnlocks(meta) → RunOverlay`.
 *
 * The ONE object that crosses from the meta layer into a run. Everything the
 * town has ever bought collapses into it, and `startRun` folds it into a
 * fresh RunState, so `core/run`, `core/map` and `core/combat` stay entirely
 * unaware that a meta layer exists.
 *
 * The fold is namespace-driven (see types.ts): `slot:` / `shinies:` /
 * `biome:` / `shop:` / `gear:` / `pool:` have scalar meanings and EVERY
 * other namespace becomes an additive content pool under its own name. An
 * unlock id nobody wrote code for still lands somewhere useful, which is
 * what makes GM- and player-generated Stands, items and events shippable
 * through this door with no engine change (balance-and-meta.md §4).
 *
 * Pure: no rng, no clock, no I/O. `applyUnlocks` returns a fresh object on
 * every call, so a run that already started can never be reached by a later
 * purchase.
 */
import type {
  MetaProfile,
  RunOverlay,
  UnlockDef,
  UnlockGrant,
} from "./types.js";
import { splitUnlockId } from "./types.js";
import { hash, mulberry32 } from "../rng.js";
import {
  DEFAULT_PARTY_CAPACITY,
  MAX_PARTY_CAPACITY,
  STARTING_PARTY_SIZE,
} from "../run/runState.js";
import { unlockCatalog, unlockDef } from "./unlocks.js";

/**
 * The engine's numbers, re-exported so the town never keeps its own copy:
 * a run FIELDS two cats at the start, may grow to three by recruiting
 * mid-run, and only reaches four when Cat Town has put out a fourth bowl
 * (balance-and-meta.md §2 + §4).
 */
export const BASE_PARTY_CAPACITY = DEFAULT_PARTY_CAPACITY;
export { MAX_PARTY_CAPACITY, STARTING_PARTY_SIZE };
/** Biome 1 is the base game's six floors. */
export const BASE_BIOME = 1;

/** Bruno never leaves; he is in every formation. */
export const ANCHOR_CLASS = "bruiser";

/**
 * The cats living in town before a single unlock: Bruno and the one who
 * never left. `class:*` unlocks (and the `pool:class` gate) widen this, and
 * the run's second cat is drawn from it.
 */
export const BASE_CLASS_POOL: readonly string[] = ["bruiser", "trickster"];

/** The overlay a profile with nothing unlocked produces. */
export function emptyOverlay(): RunOverlay {
  return {
    partyCapacity: BASE_PARTY_CAPACITY,
    startingShinies: 0,
    maxBiome: BASE_BIOME,
    gear: [],
    shopUpgrades: [],
    openPools: [],
    pool: { class: [...BASE_CLASS_POOL] },
  };
}

interface MutableOverlay {
  partyCapacity: number;
  startingShinies: number;
  maxBiome: number;
  gear: string[];
  shopUpgrades: string[];
  openPools: string[];
  pool: Record<string, string[]>;
}

const push = (list: string[], value: string): void => {
  if (value !== "" && !list.includes(value)) list.push(value);
};

/** Fold one unlock id (+ its optional explicit grant) into the overlay. */
function foldUnlock(
  out: MutableOverlay,
  id: string,
  grants: UnlockGrant | undefined,
): void {
  const { ns, local } = splitUnlockId(id);

  switch (ns) {
    case "slot":
      out.partyCapacity += grants?.slots ?? 1;
      break;
    case "shinies":
      out.startingShinies += grants?.shinies ?? 0;
      break;
    case "biome": {
      const n = grants?.biome ?? Number.parseInt(local, 10);
      if (Number.isFinite(n)) out.maxBiome = Math.max(out.maxBiome, n);
      break;
    }
    case "shop":
      push(out.shopUpgrades, local);
      break;
    case "gear":
      push(out.gear, local);
      break;
    case "pool":
      // `pool:<ns>` opens the SHARED generated pool for that namespace —
      // this is the door GM/player content walks through.
      push(out.openPools, local);
      break;
    default:
      if (local !== "") {
        (out.pool[ns] ??= []).push(local);
        out.pool[ns] = [...new Set(out.pool[ns])];
      }
      break;
  }

  // explicit grants stack ON TOP of the namespace reading, so a def can add
  // anything its id does not say (a class unlock that also opens a biome…)
  if (!grants) return;
  if (ns !== "slot" && grants.slots !== undefined) {
    out.partyCapacity += grants.slots;
  }
  if (ns !== "shinies" && grants.shinies !== undefined) {
    out.startingShinies += grants.shinies;
  }
  if (ns !== "biome" && grants.biome !== undefined) {
    out.maxBiome = Math.max(out.maxBiome, grants.biome);
  }
  for (const s of grants.shopUpgrades ?? []) push(out.shopUpgrades, s);
  for (const g of grants.gear ?? []) push(out.gear, g);
  for (const p of grants.openPools ?? []) push(out.openPools, p);
  for (const [poolNs, ids] of Object.entries(grants.pool ?? {})) {
    const list = (out.pool[poolNs] ??= []);
    for (const value of ids) push(list, value);
  }
}

/**
 * THE contract: the content overlay a new run starts from. Unknown ids
 * (a pooled def that is no longer registered) are folded by namespace
 * anyway, so uninstalling content never orphans a purchase.
 */
export function applyUnlocks(
  meta: MetaProfile,
  catalog: readonly UnlockDef[] = unlockCatalog(),
): RunOverlay {
  const out: MutableOverlay = {
    partyCapacity: BASE_PARTY_CAPACITY,
    startingShinies: 0,
    maxBiome: BASE_BIOME,
    gear: [],
    shopUpgrades: [],
    openPools: [],
    pool: { class: [...BASE_CLASS_POOL] },
  };

  for (const id of meta.unlocked) {
    foldUnlock(out, id, unlockDef(id, catalog)?.grants);
  }

  out.partyCapacity = Math.min(
    MAX_PARTY_CAPACITY,
    Math.max(STARTING_PARTY_SIZE, out.partyCapacity),
  );
  return out;
}

/** Every cat living in town — who a run may field or recruit. */
export function eligibleClasses(overlay: RunOverlay): readonly string[] {
  return overlay.pool.class ?? [];
}

/**
 * The formation a run STARTS with: Bruno plus one other, drawn from the
 * cats the town has (balance-and-meta.md §2 — the clowder is earned).
 *
 * Deterministic and keyed on the same `hash(runSeed, 'roster')` stream
 * `newRun` uses for its own draw, so a town with nothing unlocked produces
 * exactly the vanilla pairing and a seed always means the same run.
 */
export function startingRoster(runSeed: string, overlay: RunOverlay): string[] {
  const others = eligibleClasses(overlay).filter((c) => c !== ANCHOR_CLASS);
  if (others.length === 0) return [ANCHOR_CLASS];
  const i = mulberry32(hash(runSeed, "roster")).int(0, others.length - 1);
  return [ANCHOR_CLASS, others[i]].slice(0, STARTING_PARTY_SIZE);
}
