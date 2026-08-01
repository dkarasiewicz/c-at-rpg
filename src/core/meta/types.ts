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
import type {
  CatId,
  CatRunState,
  ClassId,
  EquipInstance,
  MetaFile,
  SkillId,
  StatKey,
} from "../types.js";
import type { Bestiary } from "./bestiary.js";

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

/* ------------------------------------------------------------------ */
/* THE ROSTER (docs/design/roster-and-persistence.md §1-§3)            */
/* ------------------------------------------------------------------ */

/**
 * A CONDITION a cat carries between runs (§3: hunger, scars, quirks).
 *
 * Deliberately an OPEN bag rather than a closed union: the conditions system
 * is somebody else's work package, and this shape exists so a cat instance
 * has somewhere to put it that survives a save round-trip today. Whoever
 * lands §3 owns the vocabulary of `id` and the meaning of `value`; the
 * roster screen already prints `label` and the migration already carries the
 * whole array through untouched.
 */
export interface CatCondition {
  /** `'hunger'`, `'scar:tailTip'`, `'quirk:boxAddict'` — namespaced like unlocks. */
  id: string;
  /** What the roster screen prints. Short — it sits under a name. */
  label: string;
  /** Magnitude, where the condition has one (hunger level, scar severity). */
  value?: number;
  /** Whatever else the owning system needs; carried verbatim by the save. */
  data?: Readonly<Record<string, number | string | boolean>>;
}

/**
 * ONE CAT, AT REST IN TOWN — the persisted individual (§1).
 *
 * This is the source of truth for a cat between runs: it owns the level, the
 * xp, the gear and the Lives, and `runCat` projects it into a `CatRunState`
 * when it descends. A run never invents a cat; it borrows these.
 */
export interface MetaCat {
  id: CatId;
  /** The cat's own name. A Stray gets the class's; a dreamed cat gets its own. */
  name: string;
  classId: ClassId;
  /** The Stand. Dramatic, ALL-CAPS, and this cat's alone. */
  standName: string;
  /** 1..LEVEL_CAP — derived from `xp`, stored so the roster screen is cheap. */
  level: number;
  /** Cumulative xp this individual has earned. */
  xp: number;
  /** 0..9. A cat is REMOVED at 0, so a roster entry always has at least 1. */
  lives: number;
  weapon: EquipInstance | null;
  trinket: EquipInstance | null;
  collar: EquipInstance | null;
  /** Whisker Points spent per stat (progression.md §1). */
  points?: Partial<Record<StatKey, number>>;
  /** The 3 chosen battle skills after `clawSwipe` (progression.md §3). */
  loadout?: SkillId[];
  /** §3 transient state. Empty/absent until the conditions system lands. */
  conditions?: CatCondition[];
  /** Where this cat came from — one line, for the roster screen. */
  origin?: string;
  /** How many descents this cat has come home from. */
  runs?: number;
}

/**
 * A cat that did not come home (§2). Perma-death is only worth having if the
 * loss is something the player can go and look at, so every field here is a
 * sentence the memorial says out loud: who, how far, and what did it.
 */
export interface MemorialEntry {
  catId: CatId;
  name: string;
  classId: ClassId;
  standName: string;
  /** The level it died at. */
  level: number;
  /** Deepest floor reached. */
  floor: number;
  /** What killed them, in words. */
  cause: string;
  /** The run it happened in. */
  seed: string;
  /** Descents survived before the last one. */
  runs: number;
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
export type MetaVersionNum = 1 | 2 | 3 | 4;

/**
 * The persistent profile — localStorage `catrpg.meta.v1` (the KEY keeps its
 * name; `version` is what gates the payload). v1 was lifetime records only;
 * v2 adds the wallet, the owned unlock ids and the run history; v3 adds the
 * Bestiary (enemy-intel.md §4).
 *
 * `version` is the WIDE `MetaVersion` rather than a literal: a profile that
 * predates the Bestiary is still a valid `MetaProfile` in memory (its
 * `bestiary` is simply absent), and `migrateMeta` is what stamps it current.
 */
export interface MetaProfile extends MetaFile {
  /** Banked, unspent. */
  shinies: number;
  /** Ever banked — a record, never spent from. */
  lifetimeShinies: number;
  /** Owned unlock ids, sorted, unique. */
  unlocked: UnlockId[];
  /** Most recent runs first, capped at `HISTORY_LIMIT`. */
  history: RunRecord[];
  /**
   * Per-enemy earned knowledge (core/meta/bestiary.ts). ABSENT on a v1/v2
   * payload and on any caller that predates it; every reader goes through
   * `knowledgeOf`, which treats absent as "nothing learned yet".
   */
  bestiary?: Bestiary;

  /* ---- v4: the roster (roster-and-persistence.md §1-§3) ---- */

  /**
   * THE CLOWDER — every cat that lives here, oldest first. ABSENT on a v1-v3
   * payload; `migrateMeta` seeds it from the town's class pool, and
   * `ensureRoster` guarantees it is never empty (§2's guard rail).
   */
  roster?: MetaCat[];
  /** The fallen, newest first. Never pruned — that is the whole point. */
  memorial?: MemorialEntry[];
  /**
   * Which cats descend next, front→back. Absent/stale entries are repaired
   * on read (`descendingCats`), so a dead cat can never be sent down again.
   */
  descending?: CatId[];
  /**
   * Gear the town holds: what came home in the backpack, including what a
   * cat that did not come home was wearing (§2 — perma-death takes the cat,
   * not the collar).
   */
  stash?: EquipInstance[];
  /** Counter behind minted `CatId`s (`cat-<n>`). */
  nextCatId?: number;
  /** Town-wide `EquipInstance.uid` counter, so town gear never collides. */
  nextUid?: number;
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

  /* ---- the roster write-back (roster-and-persistence.md §1-§2) ---- */

  /**
   * The cats that descended, as the run left them. Present ⇒ `bankRun` also
   * writes the roster back: survivors bank their xp, gear and Lives; anyone
   * at 0 Lives is buried (removed from the roster, added to the memorial).
   * ABSENT ⇒ the pre-roster behaviour, records and payout only.
   */
  cats?: readonly CatRunState[];
  /** Equipment still in the backpack — it comes home to the town stash. */
  carried?: readonly EquipInstance[];
  /** What ended the run, for the memorial ("the Vacuum King, floor 4"). */
  cause?: string;
  /** Party xp at the end of the run; survivors are levelled to at least it. */
  xp?: number;
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
