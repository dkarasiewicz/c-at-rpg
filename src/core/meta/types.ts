/**
 * CAT TOWN — the meta layer's shared contracts (balance-and-meta.md §4).
 *
 * Pure types plus the two open-namespace conventions the whole layer rests
 * on. Imports core/types.ts and nothing else; no runtime code beyond frozen
 * constant tables.
 *
 * ── THE UNLOCK ID IS THE CONTRACT (§4 "the unlock IS the content pool") ──
 * Every unlock id is `"<namespace>:<localId>"`. `applyUnlocks` folds an id
 * into the run overlay by its NAMESPACE, so the catalog is open: a Stand,
 * item or event the GM (or another player) generated can be registered as
 * `stand:<poolId>` / `item:<poolId>` / `event:<poolId>` later and reach the
 * run with no engine change. Five namespaces have a scalar meaning; every
 * other namespace is a content pool, keyed by its own name.
 *
 *   slot:*     +1 to the run's party capacity (or `grants.slots`)
 *   shinies:*  starting-wallet bonus (`grants.shinies`)
 *   biome:<n>  raises the deepest reachable biome to <n>
 *   shop:*     a Peddler upgrade id, passed through verbatim
 *   gear:<def> an equipment def granted into the backpack at run start
 *   pool:<ns>  OPENS the shared generated pool for namespace <ns>
 *   <ns>:<id>  everything else — appended to `overlay.pool[ns]`
 */
import type { MetaFile } from "../types.js";

/** `"<namespace>:<localId>"`, e.g. `slot:third`, `class:hexer`, `pool:stand`. */
export type UnlockId = string;

/** Where in Cat Town an unlock is bought. Open — see `PLACES`. */
export type PlaceId = string;

/**
 * What an unlock contributes to the run overlay. Omitted entirely on most
 * defs: the id's namespace derives the grant (see the header). Present when
 * an unlock's effect cannot be read off its id (a fatter purse, a biome).
 */
export interface UnlockGrant {
  /** extra cat slots in the formation (default 1 for the `slot:` namespace) */
  slots?: number;
  /** starting-wallet bonus, in shinies */
  shinies?: number;
  /** raise `maxBiome` to at least this */
  biome?: number;
  /** Peddler upgrade ids */
  shopUpgrades?: readonly string[];
  /** equipment def ids handed over at run start */
  gear?: readonly string[];
  /** namespaces whose shared generated pool this opens */
  openPools?: readonly string[];
  /** explicit pool additions, `{ namespace: localIds }` */
  pool?: Readonly<Record<string, readonly string[]>>;
}

/**
 * One purchasable addition to the pool of possibilities. NEVER a flat power
 * increase (§4): a def either widens what a run can contain or how many cats
 * carry it, never "+2 atk forever".
 */
export interface UnlockDef {
  id: UnlockId;
  /** Display name on the location marker. */
  name: string;
  /** The one-line pitch. Present tense, in-fiction, ≤ ~90 chars. */
  pitch: string;
  /** Price in banked shinies. */
  cost: number;
  /** Every one of these must already be owned before this can be bought. */
  requires: readonly UnlockId[];
  /** Which Cat Town location sells it. */
  place: PlaceId;
  /** Overlay contribution; derived from the id namespace when absent. */
  grants?: UnlockGrant;
}

/** A place in town — the unlock list rendered as somewhere you visit. */
export interface PlaceDef {
  id: PlaceId;
  name: string;
  /** Sub-line under the name on the marker. */
  blurb: string;
  /** Manifest id for the painted marker (fail-soft; a glyph stands in). */
  art: string;
  /** Fallback glyph when the marker art is absent. */
  glyph: string;
  /** Marker anchor in design px on the 1280×720 backdrop. */
  x: number;
  y: number;
}

/** One finished run, newest first in `MetaProfile.history`. */
export interface RunRecord {
  seed: string;
  victory: boolean;
  /** floor the run ended on */
  floor: number;
  score: number;
  /** shinies actually banked */
  payout: number;
  playTimeMs: number;
}

/** Meta-file schema versions this build can read. */
export type MetaVersionNum = 1 | 2;

/**
 * The persistent profile — localStorage `catrpg.meta.v1` (the KEY keeps its
 * name; `version` is what gates the payload). v1 was lifetime records only;
 * v2 adds the wallet, the owned unlock ids and the run history.
 */
export interface MetaProfile extends MetaFile {
  version: 2;
  /** Banked, unspent. */
  shinies: number;
  /** Ever banked — a record, never spent from. */
  lifetimeShinies: number;
  /** Owned unlock ids, sorted, unique. */
  unlocked: UnlockId[];
  /** Most recent runs first, capped at `HISTORY_LIMIT`. */
  history: RunRecord[];
}

/**
 * What a finished run hands the town. Assembled by the results scene from
 * the RunState it just buried; the meta layer never reads a RunState.
 */
export interface RunSummary {
  seed: string;
  victory: boolean;
  floorsReached: number;
  floorsCleared: number;
  enemiesDefeated: number;
  bossesDefeated: number;
  catPiles: number;
  /** shinies still in the wallet when the run ended */
  shiniesCarried: number;
  score: number;
  playTimeMs: number;
}

/** One line of the payout receipt. */
export interface PayoutLine {
  label: string;
  /** `count × rate`, both shown on the receipt */
  count: number;
  rate: number;
  amount: number;
}

export interface Payout {
  lines: PayoutLine[];
  /** Σ lines, before the outcome adjustment. */
  earned: number;
  /** Victory bonus (0 on a loss). */
  bonus: number;
  /** Applied to `earned` on a loss only. */
  lossRate: number;
  /** What actually gets banked, never below `MIN_PAYOUT`. */
  total: number;
}

/**
 * The content overlay a fresh run starts from — the ONLY thing the meta
 * layer hands the engine. `newRun`'s caller folds this in; nothing under
 * core/run, core/map or core/combat imports anything from core/meta.
 */
export interface RunOverlay {
  /**
   * How many cats the run may FIELD at most — `newRun`'s `partyCapacity`.
   * A run always starts with two (§2); three is the engine default (the
   * third joins mid-run) and four is what the fourth bowl buys.
   */
  partyCapacity: number;
  /** Added to the starting wallet. */
  startingShinies: number;
  /** Deepest biome this run may reach (1 = the base game). */
  maxBiome: number;
  /** Equipment def ids handed over at run start. */
  gear: readonly string[];
  /** Peddler upgrade ids the Landing honours. */
  shopUpgrades: readonly string[];
  /** Namespaces whose shared generated pool is open to this run. */
  openPools: readonly string[];
  /**
   * Additive content pools by namespace: `class`, `stand`, `item`, `event`,
   * `encounter`, and whatever a future pool namespace calls itself. Values
   * are local ids (the part after the `:`).
   */
  pool: Readonly<Record<string, readonly string[]>>;
}

/** Split `"ns:local"`; a bare id is all namespace, empty local. */
export function splitUnlockId(id: UnlockId): { ns: string; local: string } {
  const i = id.indexOf(":");
  if (i < 0) return { ns: id, local: "" };
  return { ns: id.slice(0, i), local: id.slice(i + 1) };
}
