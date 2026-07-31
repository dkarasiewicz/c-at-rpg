/**
 * c(at)rpg — shared type contracts.
 *
 * This file is the frozen contract described in ARCHITECTURE.md §2. Parallel
 * implementers code against these shapes and do not edit them; additive
 * optional fields require tech-lead sign-off recorded in ARCHITECTURE.md.
 *
 * Imports NOTHING. Zero runtime code beyond the `EQUIP_SLOTS` const.
 */

/* ------------------------------------------------------------------------ */
/* §2.1 Primitives, ids, RNG                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Seeded pseudo-random stream (implemented in core/rng.ts — the ONLY RNG code
 * in the repo). Instances are created at the boundary (scene or run-state
 * function) and passed down into core functions; core never seeds itself.
 */
export interface Rng {
  /** Uniform draw in [0, 1). */
  float(): number;
  /** Uniform integer draw, inclusive on BOTH ends. */
  int(lo: number, hi: number): number;
}

// ---- ids ----
export type ClassId = "bruiser" | "trickster" | "hexer" | "medic";
/** camelCase, e.g. 'bodySlam' */
export type SkillId = string;
/** camelCase, e.g. 'ratThug', 'vacuumKing' */
export type EnemyId = string;
/** consumable OR equip def id, camelCase e.g. 'tunaSnack' */
export type ItemId = string;
export type StatusId =
  "scratched" | "frazzled" | "offBalance" | "guarded" | "provoked" | "mending";
export type TraitId =
  | "heavy" // immune to forced movement
  | "immovableLoaf"
  | "opportunist"
  | "stringTheory"
  | "purrEngine";

// ---- stats ----
export type StatKey = "hp" | "atk" | "def" | "spd" | "crt" | "enMax";
export interface Stats {
  hp: number;
  atk: number;
  def: number;
  spd: number;
  crt: number;
  enMax: number;
}

/* ------------------------------------------------------------------------ */
/* §2.2 Skills & statuses (combat.md §4 + classes.md §2, merged)             */
/* ------------------------------------------------------------------------ */

export interface StatusApplication {
  status: StatusId;
  /** 0..1; EXACTLY 1.0 draws NO rng roll (GDD §4 ruling). */
  chance: number;
  /** scratched/mending magnitude */
  value?: number;
  /** default 'target' */
  to?: "target" | "self" | "allEnemies";
}

/**
 * A skill is a plain data object. Cats are gated by energy (no cooldowns);
 * enemies are gated by cooldowns (no energy). Consumables carry a battle
 * Skill payload in the same shape (cost 0, all applies chance 1.0).
 */
export interface Skill {
  id: SkillId;
  name: string;
  desc: string;
  /** energy (cats); ignored for enemies */
  cost: number;
  /** rounds (enemies); ignored for cats */
  cooldown?: number;
  /** user ranks the skill is usable from */
  usableFrom: number[];
  target: {
    side: "enemy" | "ally" | "self";
    ranks: number[];
    pattern: "single" | "row";
  };
  /** 0 = no damage/heal component */
  power: number;
  kind: "damage" | "heal" | "utility";
  /** + push back N, − pull forward N (forced) */
  moveTarget?: number;
  /** + retreat, − advance (voluntary, no Off-Balance) */
  moveSelf?: number;
  applies?: StatusApplication[];
  /** remove ONE application of each per target */
  cleanses?: StatusId[];
  /** targets KO'd allies; revive at pct, placed rank 4 */
  revivePct?: number;
  /** latched per battle per user */
  oncePerBattle?: boolean;
  /** Claw Swipe's +1 */
  energyGain?: number;
  /** enemy AI base score (default 10) */
  aiWeight?: number;
}

export interface StatusInstance {
  id: StatusId;
  /** 0 where meaningless */
  value: number;
  /**
   * Interpretation per status def in combat/status.ts
   * (rounds for scratched/mending; latch flags for the rest).
   */
  duration: number;
}

/* ------------------------------------------------------------------------ */
/* §2.3 Combat state, actions, event log                                     */
/* ------------------------------------------------------------------------ */

export interface Combatant {
  /** battle-unique: 'cat:bruiser', 'e0:ratThug', 'summon2:sockWraith' */
  id: string;
  name: string;
  side: "cat" | "enemy";
  /** cats only */
  classId?: ClassId;
  /** enemies only */
  speciesId?: EnemyId;
  /** 1-based current position */
  rank: number;
  /** EFFECTIVE stats (base+growth+equip+tempMods), frozen at setup */
  stats: Stats;
  hp: number;
  /** cats only */
  energy: number;
  /** current kit (boss phase swap mutates this) */
  skills: SkillId[];
  /** enemies only */
  cooldowns: Record<SkillId, number>;
  statuses: StatusInstance[];
  traits: TraitId[];
  /** equipped Mewthical effects, resolved at setup */
  hooks: MewHookId[];
  /** Nine Lives Nudge etc. */
  usedOncePerBattle: SkillId[];
  /** Immovable Loaf once-per-battle */
  traitLatchUsed?: boolean;
  /** cats only, 0..9 */
  lives?: number;
  /** KO'd (removed from ranks, revivable) */
  ko: boolean;
  // boss-only:
  /** current poise */
  poise?: number;
  poiseMax?: number;
  /** 0-based phase index */
  phase?: number;
  charging?: { skillId: SkillId; ranks: number[] } | null;
}

export interface BossData {
  poise: number;
  doubleTurn: boolean;
  /** phases[0].hpPct = 1.0 */
  phases: { hpPct: number; skills: SkillId[] }[];
  /** 2-slot nuke */
  windup?: { skillId: SkillId; telegraph: string };
  summon?: { skillId: SkillId; minion: EnemyId; cap: number };
}

export interface QueueEntry {
  combatantId: string;
  initiative: number;
  acted: boolean;
}

export interface BattleState {
  /** all, both sides (KO'd stay, ranks compressed) */
  combatants: Combatant[];
  round: number;
  /** frozen per round */
  queue: QueueEntry[];
  queueIndex: number;
  /** prompt already offered this round */
  catPileLatch: boolean;
  /** engine awaits catPile accept/decline action */
  catPilePrompt: boolean;
  cucumberUsed: boolean;
  canFlee: boolean;
  encounterIndex: number;
  outcome: "ongoing" | "victory" | "defeat" | "fled";
}

export interface BattleSetup {
  /** in marching order, front→back */
  cats: {
    classId: ClassId;
    name: string;
    stats: Stats;
    hp: number;
    lives: number;
    skills: SkillId[];
    traits: TraitId[];
    hooks: MewHookId[];
    /** energyNextBattle mods, cap 10 total */
    startEnergyBonus: number;
  }[];
  /** front-to-back, 1..5 */
  enemies: EnemyId[];
  /** 0 = boss */
  encounterIndex: number;
  canFlee: boolean;
}

export type BattleAction =
  | { type: "skill"; skillId: SkillId; targetId?: string } // targetId omitted for self/row
  | { type: "move"; dir: "forward" | "back" } // swap with adjacent cat
  | { type: "guard" }
  | { type: "item"; itemId: ItemId; targetId?: string }
  | { type: "flee" }
  | { type: "catPile"; accept: boolean }
  | { type: "advance" }; // enemy fallback (AI only)

// Engine API (core/combat):
//   createBattle(setup: BattleSetup): BattleState
//   startRound(state, rng): { state, events }        // initiative rolls
//   nextActor(state): Combatant | null               // null => round exhausted
//   legalActions(state): { action-shaped descriptors for UI enabling }
//   resolveAction(state, action, rng): { state: BattleState; events: BattleEvent[] }
//   takeEnemyTurn(self, state, rng): BattleAction
//   previewDamage(state, skillId, userId, targetId): number  // variance 1.0, no crit
//   battleResult(state): BattleResult                 // when outcome !== 'ongoing'
// All functions pure: state in → new state out (structural sharing ok, no mutation).

export type BattleEvent =
  | { t: "roundStart"; round: number; queue: QueueEntry[] }
  | { t: "turnStart"; id: string; energyAfterRegen?: number }
  | {
      t: "damage";
      id: string;
      amount: number;
      crit: boolean;
      offBal: boolean;
      source: SkillId | "catPile" | "scratched";
    }
  | {
      t: "heal";
      id: string;
      amount: number;
      source: SkillId | "mending" | ItemId;
    }
  | { t: "moved"; id: string; from: number; to: number; forced: boolean }
  | { t: "statusApplied"; id: string; status: StatusId; value: number }
  | { t: "statusExpired"; id: string; status: StatusId }
  | { t: "cleansed"; id: string; status: StatusId }
  | { t: "energy"; id: string; delta: number }
  | { t: "guard"; id: string }
  | { t: "poiseChip"; id: string; left: number }
  | { t: "poiseBreak"; id: string }
  | { t: "catPilePrompt"; damageEach: number }
  | { t: "catPile"; damageEach: number; targets: string[] }
  | { t: "ko"; id: string }
  | { t: "revive"; id: string; hp: number }
  | { t: "lifeLost"; id: string; livesLeft: number } // post-battle standup
  | { t: "lifeSaved"; id: string } // Ninth Bell
  | { t: "phaseChange"; id: string; phase: number }
  | {
      t: "charging";
      id: string;
      skillId: SkillId;
      ranks: number[];
      text: string;
    }
  | { t: "chargeCancelled"; id: string }
  | { t: "summon"; id: string; minion: EnemyId; rank: number }
  | { t: "traitTriggered"; id: string; trait: TraitId }
  | { t: "fleeAttempt"; ok: boolean; chance: number }
  | { t: "victory" }
  | { t: "defeat" }
  | { t: "fled" }
  | { t: "log"; text: string }; // flavor lines

export interface BattleResult {
  outcome: "victory" | "defeat" | "fled";
  /** post-standup values */
  cats: { classId: ClassId; hp: number; lives: number }[];
  /** Σ enemy xp, 0 on flee/defeat */
  xpGained: number;
  catPiles: number;
  enemiesDefeated: number;
  bossDefeated: boolean;
  /** mark hookSpent on the equipped instance */
  ninthBellSpent: boolean;
  /** full log (for tests / scrollback) */
  events: BattleEvent[];
}

/* ------------------------------------------------------------------------ */
/* §2.4 Classes & progression (classes.md §2)                                */
/* ------------------------------------------------------------------------ */

export interface CatTrait {
  id: TraitId;
  name: string;
  desc: string;
  /** 7 in v1 */
  tier2Level: number;
  tier2Desc: string;
}

export interface CatClass {
  id: ClassId;
  className: string;
  catName: string;
  epithet: string;
  base: Stats;
  /** 7 rows, applied at L2..L8 */
  growth: Partial<Stats>[];
  skills: { skillId: SkillId; unlockLevel: number }[];
  trait: CatTrait;
  flavor: { bio: string; barks: { crit: string; ko: string; catPile: string } };
  palette: { body: number; ears: number; eyes: number };
}

/* ------------------------------------------------------------------------ */
/* §2.5 Enemies                                                              */
/* ------------------------------------------------------------------------ */

export interface EnemyLook {
  family: "vermin" | "bird" | "beast" | "construct";
  sizeGrade: "minion" | "standard" | "elite" | "boss";
  tier: 1 | 2 | 3;
  /** 'crown' | 'shamanStaff' | 'scarf' | 'patchEye' | ... */
  props?: string[];
}

export interface EnemyDef {
  id: EnemyId;
  name: string;
  tier: 1 | 2 | 3;
  /** pack-budget cost; bosses/summons: 0 */
  threat: number;
  /** formation ordering in pack build */
  row: "front" | "back";
  /** enMax unused for enemies (0) */
  stats: Stats;
  skills: SkillId[];
  /** ['heavy'] for yarnGolem */
  traits: TraitId[];
  xp: number;
  look: EnemyLook;
  /** present on vacuumKing/dogfather/(ratPrince) */
  boss?: BossData;
}

/* ------------------------------------------------------------------------ */
/* §2.6 Items, equipment, inventory (loot.md §10)                            */
/* ------------------------------------------------------------------------ */

export type Rarity = "stray" | "sleek" | "pedigree" | "mewthical";

export type MewHookId =
  | "poiseChip2"
  | "critOffBalance"
  | "appliesAlwaysHit"
  | "healsGrantMending"
  | "moverOffBalance"
  | "ninthBell"
  | "catPileDouble"
  | "startEnergy6";

/**
 * Equipment slots a cat wears (progression.md §4). `weapon` + `trinket` are
 * the original two (loot.md §2); `collar` is the additive third slot — a
 * universal, defensive/utility piece. Slot order is display order and the
 * iteration order of every slot-generic helper (grief loot, MOULT, sort).
 */
export type EquipSlot = "weapon" | "trinket" | "collar";

/** The canonical slot list — iterate this, never a hardcoded pair. */
export const EQUIP_SLOTS = ["weapon", "trinket", "collar"] as const;

export interface EquipDef {
  id: ItemId;
  name: string;
  icon: string;
  slot: EquipSlot;
  /** weapons only */
  classId?: ClassId;
  primary: StatKey;
  secondaryPool: [StatKey, StatKey];
  /** absent on Cardboard Cuirass / Spiked Collar */
  uniqueId?: MewHookId;
  /** Mewthical display name */
  uniqueName?: string;
}

export interface EquipInstance {
  uid: number;
  defId: ItemId;
  /** L = drop floor (boss/shop: floor+1) */
  itemLevel: number;
  rarity: Rarity;
  /** fully resolved at drop time */
  stats: Partial<Record<StatKey, number>>;
  hook?: MewHookId;
  /** Ninth Bell crack */
  hookSpent?: boolean;
}

export interface ConsumableDef {
  id: ItemId;
  name: string;
  icon: string;
  price: number;
  /** cost 0, all applies chance 1.0 */
  battleSkill: Skill;
  /** tunaSnack, sardineTin only */
  explore?: { heal: number | "full" };
  /** theCucumber */
  oncePerBattle?: boolean;
  /** canOpenerRecording */
  nonBoss?: boolean;
}

/** count 1..5 */
export interface ConsumableStack {
  defId: ItemId;
  count: number;
}

export type InventorySlot = EquipInstance | ConsumableStack | null;

export interface Inventory {
  /** 0..999 */
  shinies: number;
  /** length 16 */
  slots: InventorySlot[];
  /** EquipInstance uid counter */
  nextUid: number;
}

/** Loot grants, as returned by core/loot/roll.ts and displayed by the loot overlay. */
export interface LootGrant {
  shinies: number;
  equips: EquipInstance[];
  consumables: { defId: ItemId; count: number }[];
}

/* ------------------------------------------------------------------------ */
/* §2.7 Run map (run-map-and-dm.md §2 — SUPERSEDES the dungeon.md tile maze) */
/* ------------------------------------------------------------------------ */

/**
 * What an encounter node IS. Every node on a floor map is an encounter; the
 * type is what the medallion advertises (asset ids `node:<type>`).
 */
export type NodeType =
  "fight" | "elite" | "event" | "shop" | "rest" | "treasure" | "boss";

/**
 * One encounter on the floor's directed graph. `depth` is the column
 * (0 = entry, `FloorMap.columns - 1` = terminal), `row` the 0-based slot
 * within that column top→bottom (`rowCount` = how many share the column, so
 * the UI can lay the column out without scanning).
 */
export interface MapNode {
  /** index into `FloorMap.nodes` — stable, 0-based */
  id: number;
  type: NodeType;
  /** column index, 0 = entry */
  depth: number;
  /** 0-based row within the column, top → bottom */
  row: number;
  /** how many nodes live in this column */
  rowCount: number;
  /**
   * Payload seed — `hash(runSeed, floor, 'node', id)`. Derived, NOT drawn
   * from the map stream, so what a node contains never depends on the order
   * nodes are visited (the per-entity-seed rule, ARCHITECTURE.md §4).
   */
  seed: number;
}

/** A one-way step. Always `nodes[from].depth + 1 === nodes[to].depth`. */
export interface MapEdge {
  from: number;
  to: number;
}

/**
 * A floor: a layered DAG, entry on the left, boss (or the stairs-guard on a
 * non-boss floor) on the right. Every node is reachable from `entryId` and
 * every maximal path terminates at `bossId`.
 */
export interface FloorMap {
  /** 1..6 */
  floor: number;
  /** column count, 4..7 */
  columns: number;
  /** index === node.id */
  nodes: MapNode[];
  /** sorted by (from, to) */
  edges: MapEdge[];
  /** the single column-0 node the party starts on */
  entryId: number;
  /** the single terminal node — the boss, or the pack guarding the stairs */
  bossId: number;
}

/**
 * Authored per-floor node budget (run-map-and-dm.md §2: "density is authored,
 * not emergent"). Replaces the tile maze's `roamers`/`chests`/`events`.
 */
export interface FloorMapBudget {
  /** inclusive column range; clamped to 4..7 */
  columnsLo: number;
  columnsHi: number;
  /** inclusive nodes-per-intermediate-column range; clamped to 1..4 */
  rowsLo: number;
  rowsHi: number;
  /** relative weights for intermediate nodes; a missing type is never drawn */
  weights: Partial<Record<NodeType, number>>;
  /** types that MUST appear at least once on the floor (shop + rest) */
  guaranteed: NodeType[];
}

export interface FloorConfig {
  name: string;
  pool: EnemyId[];
  budgetLo: number;
  budgetHi: number;
  /** the authored run-map budget for this floor */
  map: FloorMapBudget;
  boss?: { bossId: EnemyId; encounter: EnemyId[] };
}

/* ------------------------------------------------------------------------ */
/* §2.8 Narrative events (events.md §1, verbatim with canonical fixes)       */
/* ------------------------------------------------------------------------ */

export type Scalar = number | { base: number; perFloor: number };
export type BuffStat = "atk" | "def" | "spd" | "crt" | "hpMax";

export type TargetSel =
  "party" | "random" | "lowestHp" | "lowestLives" | "gateCat";

export type Requirement =
  | { kind: "class"; class: ClassId }
  | { kind: "stat"; stat: "atk" | "def" | "spd" | "crt"; min: number } // best EFFECTIVE stat
  | { kind: "item"; item: ItemId; count?: number }
  | { kind: "shinies"; cost: Scalar };

export type Effect =
  | { kind: "heal"; target: TargetSel; amount: Scalar }
  | { kind: "damage"; target: TargetSel; amount: Scalar } // ignores def; clamps at 1 HP
  | {
      kind: "buff";
      target: TargetSel;
      stat: BuffStat;
      amount: number;
      duration: "floor" | "run";
    }
  | { kind: "shinies"; amount: Scalar }
  | { kind: "giveItem"; item: ItemId; count?: number }
  | { kind: "takeItem"; item: ItemId; count?: number }
  | { kind: "restoreLife"; target: "lowestLives"; amount: number }
  | { kind: "energyNextBattle"; target: TargetSel; amount: number }
  | {
      kind: "fight";
      encounter: EnemyId[];
      loot: "none" | "normal" | "bonus";
      onWinEffects?: Effect[];
    }
  | { kind: "nothing" };

export interface Outcome {
  weight: number;
  text: string;
  effects: Effect[];
}

export interface EventOption {
  label: string;
  requires?: Requirement;
  outcomes: Outcome[];
}

export interface GameEvent {
  id: string;
  title: string;
  prompt: string;
  weight: number;
  floors: [number, number];
  once?: boolean;
  /** 2..4 */
  options: EventOption[];
}

/** events.md §1 "Temp stat mods" */
export interface TempMod {
  stat: BuffStat;
  amount: number;
  duration: "floor" | "run";
  sourceEventId: string;
}

/** UI delta lines, also used by loot overlay. */
export interface ResultLine {
  text: string;
  tone: "gain" | "loss" | "buff" | "neutral";
}

/* ------------------------------------------------------------------------ */
/* §2.9 Run state, save, score                                               */
/* ------------------------------------------------------------------------ */

export interface CatRunState {
  classId: ClassId;
  /** current; max derives from effectiveStats */
  hp: number;
  /** 0..9; 0 = gone for the run */
  lives: number;
  weapon: EquipInstance | null;
  trinket: EquipInstance | null;
  tempMods: TempMod[];
  /** consumed by next battle setup, then cleared */
  energyNextBattle: number;

  /* ---- progression.md additions. ALL OPTIONAL: absent ⇒ v1 behaviour ---- */

  /**
   * Third equipment slot (progression.md §4). `undefined` = the cat predates
   * the collar slot (v1 save) and wears nothing there; `null` = empty.
   */
  collar?: EquipInstance | null;
  /**
   * Whisker Points spent per stat (progression.md §1). Absent = nothing
   * spent. Each entry counts POINTS, not stat magnitude — the per-point
   * amount and per-stat cap live in `POINT_MENU` (core/run/party.ts).
   */
  points?: Partial<Record<StatKey, number>>;
  /**
   * The 3 chosen battle skills, in order, that follow the always-present
   * `clawSwipe` (progression.md §3). Absent = the legacy default kit
   * (`knownSkills` truncated to 4).
   */
  loadout?: SkillId[];
}

export interface ScoreCounters {
  /** every roamer on the floor dead */
  floorsCleared: number;
  floorsReached: number;
  enemiesDefeated: number;
  bossesDefeated: number;
  catPiles: number;
  /** lifetime-this-run (score), not the wallet */
  shiniesCollected: number;
}

export interface RunState {
  runSeed: string;
  /** 1..6 */
  floorNum: number;
  /** FIXED order [bruiser, trickster, hexer, medic] */
  cats: CatRunState[];
  /** living cats only, front→back */
  marchingOrder: ClassId[];
  xp: number;
  /** 1..8 */
  level: number;
  inventory: Inventory;
  score: ScoreCounters;
  /** run-scoped (for `once`) */
  firedEventIds: string[];
  /** reset each floor */
  floorFiredEventIds: string[];
  /** mewthical downgrade rule */
  uniquesDropped: MewHookId[];
  /** the current floor's run map; null until FLOORGEN generates it */
  floorMap: FloorMap | null;
  /** where the party stands on `floorMap`; null while `floorMap` is null */
  currentNodeId: number | null;
  /** every node the party has stood on this floor, in arrival order */
  visitedNodeIds: number[];
  playTimeMs: number;
}

// ---- persistence (core/run/save.ts) ----

/** Save-file schema versions this build can read (save.ts SAVE_VERSION = 3). */
export type SaveVersion = 1 | 2 | 3;

/**
 * localStorage 'catrpg.save.v1' (the KEY keeps its name so old saves are still
 * found; `version` is what gates them). v1 = pre-progression, v2 = pre-run-map
 * (both tile-dungeon saves, migrated forward on load by `migrateSave`);
 * v3 = current — the run map regenerates from the seed, so the whole floor is
 * `run.floorMap` + the two traversal fields and there is no delta to store.
 */
export interface SaveFile {
  version: SaveVersion;
  run: Omit<RunState, "floorMap">;
  /**
   * Legacy v1/v2 tile-dungeon overlay. Present only on pre-run-map blobs and
   * ignored on load (the tile maze is gone — run-map-and-dm.md §2).
   */
  floorDelta?: unknown;
}

/** localStorage 'catrpg.meta.v1' — records only, no unlocks */
export interface MetaFile {
  version: 1;
  counters: { runs: number; victories: number };
  records: { bestScore: number; fastestVictoryMs: number | null };
}

// Score lines (core/run/score.ts): floorsCleared×100, floorsReached×50,
// enemiesDefeated×10, bossesDefeated×300, shinies×5, catPiles×20,
// livesRemaining×25 (victory only), victory bonus 1000. Time shown, never scored.

/* ------------------------------------------------------------------------ */
/* §2.10 Content table types (what `src/content` must export)                */
/* ------------------------------------------------------------------------ */
//
// These are contracts on the CONTENT modules, not values of this module —
// each `src/content/*.ts` file exports the real const, typed as follows:
//
//   content/classes.ts      export const CLASSES: Record<ClassId, CatClass>
//   content/skills.ts       export const SKILLS: Record<SkillId, Skill>
//                           (cat + enemy + boss + consumable-payload skills, one namespace)
//   content/enemies.ts      export const ENEMIES: Record<EnemyId, EnemyDef>
//   content/bosses.ts       export const BOSS_ENCOUNTERS: Record<EnemyId, EnemyId[]>
//                           (boss EnemyDefs live in ENEMIES; this is placement data)
//   content/equipment.ts    export const EQUIP_DEFS: Record<ItemId, EquipDef>
//   content/consumables.ts  export const CONSUMABLES: Record<ItemId, ConsumableDef>
//   content/lootTables.ts   export const CONSUMABLE_WEIGHTS: { id: ItemId; weight: number }[]  // Σ = 100
//                           export const RARITY_WEIGHTS:
//                             Record<'f12' | 'f34' | 'f56', Record<Rarity, number>>
//                           export const CHEST_DRAWS:
//                             { kind: 'consumable' | 'equipment' | 'shinyPile'; weight: number }[]
//                           export const BUNDLES: Record<'SNACK_STASH' | 'SHINY_HOARD' | 'GEAR'
//                             | 'GEAR_FANCY' | 'TITHE' | 'MOULT', object>  // shapes per loot.md §5d
//                           export const STARTING_KIT: { shinies: number;
//                             consumables: { defId: ItemId; count: number }[] }
//                           (+ stray L1 weapons equipped)
//   content/events.ts       export const EVENTS: GameEvent[]
//   content/floors.ts       export const FLOORS: FloorConfig[]        // length 6, GDD §6 table
//                           export const XP_TO_LEVEL: number[]        // [0,30,70,130,210,310,430,570]
//                           export const LEVEL_CAP: number            // 8
