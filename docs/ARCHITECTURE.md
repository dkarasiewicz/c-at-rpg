# c(at)rpg — Technical Architecture

**Status: CANONICAL for implementation structure.** Where this doc and a design doc
disagree on *game rules*, the design docs win (GDD.md at the top). Where anything
disagrees on *code structure, types, file ownership, or module boundaries*, this doc
wins. The types in §2 are frozen contracts: implementers extend behavior, never
change these shapes without a tech-lead sign-off recorded here.

---

## 0. Layering rules (non-negotiable)

```
src/main.ts ──► src/ui ──► src/content ──► src/core/types.ts (+ core/rng, core/util)
                  │
                  └──────► src/core/**   (engines)
src/core/** ────► src/content (tables) + src/core/types.ts   — NEVER pixi, NEVER src/ui
src/content/** ─► src/core/types.ts ONLY (data objects typed against the contracts)
```

1. **`src/core`** — pure logic. Zero `pixi.js` imports, zero DOM, zero
   `Math.random()`, zero `Date.now()` (play time is fed in). Every function is
   deterministic given its inputs; every module is unit-testable in Node.
2. **`src/content`** — data only. Plain exported `const` objects/arrays typed
   against `core/types.ts`. No functions beyond trivial lookups; no imports except
   `core/types.ts`. (Exception: `content` may not import engine modules —
   `core/combat/*` etc. import `content`, never the reverse. This keeps the graph
   acyclic: `types.ts` imports nothing.)
3. **`src/ui`** — PixiJS scenes and components. UI *reads* core state and *renders*
   engine event logs; it never computes gameplay outcomes. Visual randomness is
   `Math.random()` and must never touch a gameplay `Rng`.
4. **`src/main.ts`** — bootstrap: pixi `Application.init`, root scaling, scene
   manager construction, localStorage probe, first scene push.
5. `localStorage` is touched only by `core/run/save.ts` (behind a 2-line adapter so
   tests can inject a stub).

Enforced by a lint rule (`eslint.config.mjs`: `no-restricted-imports` of `pixi.js`
inside `src/core/**` and `src/content/**`) — WP-01 sets this up.

---

## 1. File tree

Every file listed is owned by exactly one work package (§5). One-line
responsibility each; approximate LoC in brackets (budget guidance, not a cap).

```
src/
  main.ts                     # [80] Pixi app init, root container + letterbox scaler, SceneManager boot → 'boot' scene
  vite-env.d.ts               # (template) Vite ambient types — untouched

  core/
    types.ts                  # [450] EVERY shared interface/type in §2. Imports nothing. The contract file.
    rng.ts                    # [50] fnv1a, hash(...parts), mulberry32 → Rng; the ONLY RNG code in the repo (§4)
    util.ts                   # [60] roundHalfUp, clamp, weighted pick (d100 cumulative), Fisher-Yates(rng), base64 bitset enc/dec

    combat/
      setup.ts                # [110] createBattle(BattleSetup): effective stats fold-in, energyNextBattle, marching order → ranks, boss init, mewthical start hooks
      state.ts                # [150] rank ops (slide/clamp-push-pull/swap), living/target queries, legalActions(state), previewDamage (variance 1.0, no crit)
      turns.ts                # [180] initiative rolls + tie-breaks, frozen round queue, round-end phase, victory/defeat/flee, Nine Lives bookkeeping, Ninth Bell hook
      resolve.ts              # [300] resolveAction pipeline (damage→moveTarget→applies→moveSelf→CatPile check→death check), item-as-skill, Cat Pile, trait + mewthical hooks
      status.ts               # [110] 6 status defs: apply/stack/tick/expiry rules per combat.md §6, tick timing
      ai.ts                   # [100] takeEnemyTurn score-and-pick (combat.md §10), Provoked targeting, advance fallback
      boss.ts                 # [110] Poise chip/break, doubleTurn queue entries, phase switch, charge/windup + cancel, summons

    dungeon/
      gen.ts                  # [220] rooms-in-a-maze: room scatter, growing-tree maze, connectors+union-find, trim passes, boss lair, validation+retry (dungeon.md §5)
      populate.ts             # [160] stairs, chests (nooks first), events, roamers+packs (threat budget), waypoints, per-entity seeds (dungeon.md §6-7)
      floor.ts                # [110] tile index helpers, BFS flood (N,E,S,W FIFO), Bresenham LOS, visibility recompute (whisker-light + room light)
      step.ts                 # [130] the step loop: move/bump/chest-open, roamer phase, contact check, tile triggers, flee re-entry + stun (dungeon.md §9.3)
      roamers.ts              # [80] patrol/chase/return/stunned state machine, shared BFS flood, zero RNG (dungeon.md §12)

    events/
      select.ts               # [40] pool filter (floors, once, per-floor fired), weighted pick, empty-pool shiny fallback (events.md §2.1)
      resolve.ts              # [130] resolveOption: requirement payment, outcome roll, effects in order, result lines, fightRequest handoff (events.md §2.3)
      validate.ts             # [40] dev-time authoring invariants (events.md §1), run in tests + dev boot

    loot/
      roll.ts                 # [110] rollChest/rollVictory/rollBossLoot/rollBundle per loot.md §5 (roll order §5e), rarity/slot/def/secondary picks, §3 value formulas
      inventory.ts            # [90] 16 slots, stacks of 5, add/remove/merge, equip/unequip (hp adjust), sell values, grief loot, MOULT downgrade
      shop.ts                 # [60] Peddler stock roll (shop stream), prices, Warm Lap cost, sell-at-quarter

    run/
      runState.ts             # [120] newRun(seed), descend (catnap heal + floor gen call), applyBattleResult write-back, fired-event & unique bookkeeping
      party.ts                # [90] effectiveStats(cat) = base+growth+equipment+tempMods, skill list by level, XP → level-ups (delta-HP rule), trait tier
      score.ts                # [40] score table (gameloop.md §7), results summary struct
      save.ts                 # [110] SaveFile/MetaFile (de)serialize, floor→delta snapshot, localStorage adapter, version gate

  content/
    classes.ts                # [120] CLASSES: 4 CatClass defs verbatim from classes.md (bases, growth rows, unlocks, traits, barks, palettes)
    skills.ts                 # [140] SKILLS: Claw Swipe + 12 class skills + enemy skills + boss skills, all in the one Skill shape
    enemies.ts                # [120] ENEMIES: 10 species + sockWraith + elderStray, stat blocks per dungeon.md §7.1 (canonical), looks (ui-art §5 data)
    bosses.ts                 # [80] BOSSES: vacuumKing, dogfather (+ ratPrince SHOULD): BossData + encounter arrays per GDD §6
    equipment.ts              # [90] EQUIP_DEFS (10), 8 Mewthical uniques (MewHookId + names), rarity table
    consumables.ts            # [90] CONSUMABLES: 10 defs with battle Skill payloads (cost 0, chance 1.0) + explore fields + prices
    lootTables.ts             # [70] consumable weight table (Σ=100), rarity weights by floor band, chest/fight/boss draw tables, §5d bundles, starting kit
    events.ts                 # [300] EVENTS: the 10 shipped GameEvents verbatim from events.md §4 (ids fixed: 'rat'→'ratThug')
    floors.ts                 # [40] FLOORS: canonical 6-floor table from GDD §6, XP_TO_LEVEL, LEVEL_CAP

  ui/
    palette.ts                # [70] PAL + THEMES consts verbatim from ui-art.md §2
    layout.ts                 # [80] R.* rect consts for every screen (ui-art §§7-11), Rect type
    textStyles.ts             # [40] DISPLAY / UI / MONO TextStyle presets + BitmapFont install (ui-art §3)
    tween.ts                  # [60] tween(obj, props, ms, ease, onDone?), eases linear/quadOut/backOut, screen-shake helper
    widgets.ts                # [180] bar, energy pips, status chips, hotkey chips, buttons, panels, tooltips, paw-pip rows (ui-art §6)
    input.ts                  # [70] keyboard map + repeat, one listener; routes keys to overlay-first-then-scene; pointer helpers
    sceneManager.ts           # [110] Scene/Overlay lifecycle (§3): swap, overlay push/pop, ticker gating, FSM transition guard table
    draw/
      cats.ts                 # [180] drawCat recipe (96×96), 4 class variants, mini-portrait, KO greyscale (ui-art §4)
      enemies.ts              # [200] 4 family recipes, size grades, props, tier chevrons, boss extras (ui-art §5)
      glyphs.ts               # [60] event glyphs (yarnBall/fishBones/pawShrine/strangeBox), stairs swirl, chest, misc pictograms
    scenes/
      boot.ts                 # [40] black screen, paw logo, click-to-start
      title.ts                # [130] logo, rooftop cats, New Run / Continue / Records, seed entry
      floorgen.ts             # [30] one-frame "Descending… Floor N" interstitial; calls core floor gen
      explore.ts              # [280] tile layer, fog overlay, entity blobs, party token, camera, step-loop driving, trigger dispatch
      exploreHud.ts           # [130] floor/seed chips, 4 cat cards, shiny counter, item belt (Tuna/Sardine pressable), toasts, marching-order panel (Tab)
      minimap.ts              # [80] RenderTexture minimap + M full-map overlay
      battle.ts               # [320] battle scene: engine driving loop, event-queue animator, targeting flow, unit containers, floaters, log line
      battleWidgets.ts        # [230] initiative ribbon, skill bar + range strips, active panel, Cat Pile banner, Poise pips, boss telegraph
      event.ts                # [160] event modal: PROMPT/RESULT states, option buttons + gate tags, hotkeys 1-4, delta lines (events.md §3 + ui-art §9)
      landing.ts              # [170] Landing scene: catnap floaters, Peddler stock + buy/sell + Warm Lap, marching order, Descend
      results.ts              # [120] victory/defeat banner, score count-up, records line, Again/New Seed/Title
    overlays/
      loot.ts                 # [90] chest/victory loot popup: rows, XP bar + level-up toasts, Lives ledger (pip crack), Take All
      pause.ts                # [110] Esc menu: Resume/Party/Inventory/Help/Abandon; footer seed/floor/time
      inventoryPanel.ts       # [130] 16-slot grid, equip/unequip per cat, full-inventory pickup modal, sort

tests/
  rng.spec.ts                 # known-answer hash/mulberry32 vectors, int bounds
  content.spec.ts             # validator pass, weights Σ=100, id cross-refs, L1 party == combat.md §13 party
  combat.spec.ts              # combat.md §13 worked example EXACTLY, + determinism & edge cases
  dungeon.spec.ts             # 'MEOW-1987' floor-1 fixture == dungeon.md §13 grid + entities
  loot.spec.ts                # roll order, value formulas, inventory invariants
  events.spec.ts              # draw order, clamp-at-1, fired bookkeeping
  run.spec.ts                 # level-up deltas, save round-trip, score math
  integration.spec.ts         # scripted mini-run: gen → battle → loot → event → descend, headless, deterministic
```

Total ≈ 6.3k LoC — on budget with GDD §11's sanity check.

---

## 2. Shared type contracts (`src/core/types.ts`)

This is the actual content of `core/types.ts` (doc comments trimmed here; the file
carries them). **Parallel implementers code against these shapes and do not edit
them.** Additive optional fields require tech-lead sign-off.

### 2.1 Primitives, ids, RNG

```ts
// ---- RNG (implemented in core/rng.ts) ----
export interface Rng {
  float(): number;                 // [0, 1)
  int(lo: number, hi: number): number; // inclusive both ends
}

// ---- ids ----
export type ClassId  = 'bruiser' | 'trickster' | 'hexer' | 'medic';
export type SkillId  = string;    // camelCase, e.g. 'bodySlam'
export type EnemyId  = string;    // camelCase, e.g. 'ratThug', 'vacuumKing'
export type ItemId   = string;    // consumable OR equip def id, camelCase e.g. 'tunaSnack'
export type StatusId = 'scratched' | 'frazzled' | 'offBalance'
                     | 'guarded' | 'provoked' | 'mending';
export type TraitId  = 'heavy'                      // immune to forced movement
                     | 'immovableLoaf' | 'opportunist'
                     | 'stringTheory' | 'purrEngine';

// ---- stats ----
export type StatKey = 'hp' | 'atk' | 'def' | 'spd' | 'crt' | 'enMax';
export interface Stats { hp: number; atk: number; def: number;
                         spd: number; crt: number; enMax: number; }
```

### 2.2 Skills & statuses (combat.md §4 + classes.md §2 additive fields, merged)

```ts
export interface StatusApplication {
  status: StatusId;
  chance: number;                  // 0..1; EXACTLY 1.0 draws NO rng roll (GDD §4 ruling)
  value?: number;                  // scratched/mending magnitude
  to?: 'target' | 'self' | 'allEnemies';  // default 'target'
}

export interface Skill {
  id: SkillId;
  name: string;
  desc: string;
  cost: number;                    // energy (cats); ignored for enemies
  cooldown?: number;               // rounds (enemies); ignored for cats
  usableFrom: number[];            // user ranks
  target: {
    side: 'enemy' | 'ally' | 'self';
    ranks: number[];
    pattern: 'single' | 'row';
  };
  power: number;                   // 0 = no damage/heal component
  kind: 'damage' | 'heal' | 'utility';
  moveTarget?: number;             // + push back N, − pull forward N (forced)
  moveSelf?: number;               // + retreat, − advance (voluntary, no Off-Balance)
  applies?: StatusApplication[];
  cleanses?: StatusId[];           // remove ONE application of each per target
  revivePct?: number;              // targets KO'd allies; revive at pct, placed rank 4
  oncePerBattle?: boolean;         // latched per battle per user
  energyGain?: number;             // Claw Swipe's +1
  aiWeight?: number;               // enemy AI base score (default 10)
}

export interface StatusInstance {
  id: StatusId;
  value: number;                   // 0 where meaningless
  duration: number;                // interpretation per status def in combat/status.ts
                                   // (rounds for scratched/mending; latch flags for the rest)
}
```

### 2.3 Combat state, actions, event log

```ts
export interface Combatant {
  id: string;                      // battle-unique: 'cat:bruiser', 'e0:ratThug', 'summon2:sockWraith'
  name: string;
  side: 'cat' | 'enemy';
  classId?: ClassId;               // cats only
  speciesId?: EnemyId;             // enemies only
  rank: number;                    // 1-based current position
  stats: Stats;                    // EFFECTIVE stats (base+growth+equip+tempMods), frozen at setup
  hp: number;
  energy: number;                  // cats only
  skills: SkillId[];               // current kit (boss phase swap mutates this)
  cooldowns: Record<SkillId, number>; // enemies only
  statuses: StatusInstance[];
  traits: TraitId[];
  hooks: MewHookId[];              // equipped Mewthical effects, resolved at setup
  usedOncePerBattle: SkillId[];    // Nine Lives Nudge etc.
  traitLatchUsed?: boolean;        // Immovable Loaf once-per-battle
  lives?: number;                  // cats only, 0..9
  ko: boolean;                     // KO'd (removed from ranks, revivable)
  // boss-only:
  poise?: number;                  // current
  poiseMax?: number;
  phase?: number;                  // 0-based phase index
  charging?: { skillId: SkillId; ranks: number[] } | null;
}

export interface BossData {
  poise: number;
  doubleTurn: boolean;
  phases: { hpPct: number; skills: SkillId[] }[];   // phases[0].hpPct = 1.0
  windup?: { skillId: SkillId; telegraph: string }; // 2-slot nuke
  summon?: { skillId: SkillId; minion: EnemyId; cap: number };
}

export interface QueueEntry { combatantId: string; initiative: number; acted: boolean; }

export interface BattleState {
  combatants: Combatant[];         // all, both sides (KO'd stay, ranks compressed)
  round: number;
  queue: QueueEntry[];             // frozen per round
  queueIndex: number;
  catPileLatch: boolean;           // prompt already offered this round
  catPilePrompt: boolean;          // engine awaits catPile accept/decline action
  cucumberUsed: boolean;
  canFlee: boolean;
  encounterIndex: number;
  outcome: 'ongoing' | 'victory' | 'defeat' | 'fled';
}

export interface BattleSetup {
  cats: {                          // in marching order, front→back
    classId: ClassId; name: string; stats: Stats; hp: number; lives: number;
    skills: SkillId[]; traits: TraitId[]; hooks: MewHookId[];
    startEnergyBonus: number;      // energyNextBattle mods, cap 10 total
  }[];
  enemies: EnemyId[];              // front-to-back, 1..5
  encounterIndex: number;          // 0 = boss
  canFlee: boolean;
}

export type BattleAction =
  | { type: 'skill'; skillId: SkillId; targetId?: string } // targetId omitted for self/row
  | { type: 'move'; dir: 'forward' | 'back' }              // swap with adjacent cat
  | { type: 'guard' }
  | { type: 'item'; itemId: ItemId; targetId?: string }
  | { type: 'flee' }
  | { type: 'catPile'; accept: boolean }
  | { type: 'advance' };                                   // enemy fallback (AI only)

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
  | { t: 'roundStart'; round: number; queue: QueueEntry[] }
  | { t: 'turnStart'; id: string; energyAfterRegen?: number }
  | { t: 'damage'; id: string; amount: number; crit: boolean; offBal: boolean;
      source: SkillId | 'catPile' | 'scratched' }
  | { t: 'heal'; id: string; amount: number; source: SkillId | 'mending' | ItemId }
  | { t: 'moved'; id: string; from: number; to: number; forced: boolean }
  | { t: 'statusApplied'; id: string; status: StatusId; value: number }
  | { t: 'statusExpired'; id: string; status: StatusId }
  | { t: 'cleansed'; id: string; status: StatusId }
  | { t: 'energy'; id: string; delta: number }
  | { t: 'guard'; id: string }
  | { t: 'poiseChip'; id: string; left: number }
  | { t: 'poiseBreak'; id: string }
  | { t: 'catPilePrompt'; damageEach: number }
  | { t: 'catPile'; damageEach: number; targets: string[] }
  | { t: 'ko'; id: string }
  | { t: 'revive'; id: string; hp: number }
  | { t: 'lifeLost'; id: string; livesLeft: number }     // post-battle standup
  | { t: 'lifeSaved'; id: string }                        // Ninth Bell
  | { t: 'phaseChange'; id: string; phase: number }
  | { t: 'charging'; id: string; skillId: SkillId; ranks: number[]; text: string }
  | { t: 'chargeCancelled'; id: string }
  | { t: 'summon'; id: string; minion: EnemyId; rank: number }
  | { t: 'traitTriggered'; id: string; trait: TraitId }
  | { t: 'fleeAttempt'; ok: boolean; chance: number }
  | { t: 'victory' } | { t: 'defeat' } | { t: 'fled' }
  | { t: 'log'; text: string };                           // flavor lines

export interface BattleResult {
  outcome: 'victory' | 'defeat' | 'fled';
  cats: { classId: ClassId; hp: number; lives: number }[]; // post-standup values
  xpGained: number;                // Σ enemy xp, 0 on flee/defeat
  catPiles: number;
  enemiesDefeated: number;
  bossDefeated: boolean;
  ninthBellSpent: boolean;         // mark hookSpent on the equipped instance
  events: BattleEvent[];           // full log (for tests / scrollback)
}
```

### 2.4 Classes & progression (classes.md §2)

```ts
export interface CatTrait {
  id: TraitId; name: string; desc: string;
  tier2Level: number;              // 7 in v1
  tier2Desc: string;
}

export interface CatClass {
  id: ClassId;
  className: string; catName: string; epithet: string;
  base: Stats;
  growth: Partial<Stats>[];        // 7 rows, applied at L2..L8
  skills: { skillId: SkillId; unlockLevel: number }[];
  trait: CatTrait;
  flavor: { bio: string; barks: { crit: string; ko: string; catPile: string } };
  palette: { body: number; ears: number; eyes: number };
}
```

### 2.5 Enemies

```ts
export interface EnemyLook {
  family: 'vermin' | 'bird' | 'beast' | 'construct';
  sizeGrade: 'minion' | 'standard' | 'elite' | 'boss';
  tier: 1 | 2 | 3;
  props?: string[];                // 'crown' | 'shamanStaff' | 'scarf' | 'patchEye' | ...
}

export interface EnemyDef {
  id: EnemyId; name: string;
  tier: 1 | 2 | 3;
  threat: number;                  // pack-budget cost; bosses/summons: 0
  row: 'front' | 'back';           // formation ordering in pack build
  stats: Stats;                    // enMax unused for enemies (0)
  skills: SkillId[];
  traits: TraitId[];               // ['heavy'] for yarnGolem
  xp: number;
  look: EnemyLook;
  boss?: BossData;                 // present on vacuumKing/dogfather/(ratPrince)
}
```

### 2.6 Items, equipment, inventory (loot.md §10)

```ts
export type Rarity = 'stray' | 'sleek' | 'pedigree' | 'mewthical';

export type MewHookId =
  | 'poiseChip2' | 'critOffBalance' | 'appliesAlwaysHit' | 'healsGrantMending'
  | 'moverOffBalance' | 'ninthBell' | 'catPileDouble' | 'startEnergy6';

export interface EquipDef {
  id: ItemId; name: string; icon: string;
  slot: 'weapon' | 'trinket';
  classId?: ClassId;               // weapons only
  primary: StatKey;
  secondaryPool: [StatKey, StatKey];
  uniqueId?: MewHookId;            // absent on Cardboard Cuirass / Spiked Collar
  uniqueName?: string;             // Mewthical display name
}

export interface EquipInstance {
  uid: number;
  defId: ItemId;
  itemLevel: number;               // L = drop floor (boss/shop: floor+1)
  rarity: Rarity;
  stats: Partial<Record<StatKey, number>>;  // fully resolved at drop time
  hook?: MewHookId;
  hookSpent?: boolean;             // Ninth Bell crack
}

export interface ConsumableDef {
  id: ItemId; name: string; icon: string;
  price: number;
  battleSkill: Skill;              // cost 0, all applies chance 1.0
  explore?: { heal: number | 'full' };   // tunaSnack, sardineTin only
  oncePerBattle?: boolean;         // theCucumber
  nonBoss?: boolean;               // canOpenerRecording
}

export interface ConsumableStack { defId: ItemId; count: number; }  // 1..5

export type InventorySlot = EquipInstance | ConsumableStack | null;

export interface Inventory {
  shinies: number;                 // 0..999
  slots: InventorySlot[];          // length 16
  nextUid: number;                 // EquipInstance uid counter
}

// Loot grants, as returned by core/loot/roll.ts and displayed by the loot overlay:
export interface LootGrant {
  shinies: number;
  equips: EquipInstance[];
  consumables: { defId: ItemId; count: number }[];
}
```

### 2.7 Dungeon (dungeon.md §3)

```ts
export const enum Tile { Wall = 0, Floor = 1, Door = 2, StairsUp = 3, StairsDown = 4 }

export interface Room { id: number; x: number; y: number; w: number; h: number; }

export interface Roamer {
  kind: 'roamer' | 'boss';
  id: number; x: number; y: number;
  encounterIndex: number;          // 0 = boss, 1..N in placement order
  enemies: EnemyId[];              // front-to-back, 1..5
  homeRoom: number;
  waypoints: [number, number][];
  wpIndex: number;
  state: 'patrol' | 'chase' | 'return' | 'stunned';
  stunnedFor: number;
  lostSightFor: number;
  dead: boolean;
}

export type Entity =
  | { kind: 'chest'; id: number; x: number; y: number; opened: boolean;
      lootTableId: 'chest_t1' | 'chest_t2' | 'chest_t3' | 'boss_hoard'; chestSeed: number }
  | { kind: 'event'; id: number; x: number; y: number; used: boolean; eventSeed: number }
  | Roamer;

export interface FloorState {
  floor: number;                   // 1..6
  w: number; h: number;
  tiles: Uint8Array;               // index = y*w + x
  rooms: Room[];
  entranceRoomId: number; exitRoomId: number;
  entities: Entity[];              // id = index at creation
  stairsLocked: boolean;
  explored: Uint8Array;            // 0|1
  visible: Set<number>;            // recomputed after every step
  party: { x: number; y: number };
  stepCount: number;
}

export interface FloorConfig {
  name: string;
  w: number; h: number; roomAttempts: number;
  roamers: number; chests: number; events: number;
  pool: EnemyId[]; budgetLo: number; budgetHi: number;
  boss?: { bossId: EnemyId; encounter: EnemyId[] };
}

// Step-loop result: what the UI must react to after one step.
export type StepTrigger =
  | { t: 'battle'; roamerId: number; encounterIndex: number; enemies: EnemyId[]; isBoss: boolean }
  | { t: 'chest'; chestId: number }         // bumped an unopened chest
  | { t: 'event'; eventId: number; eventSeed: number }
  | { t: 'stairs'; locked: boolean }
  | { t: 'moved' } | { t: 'bump' };
```

### 2.8 Narrative events (events.md §1, verbatim with canonical fixes)

```ts
export type Scalar = number | { base: number; perFloor: number };
export type BuffStat = 'atk' | 'def' | 'spd' | 'crt' | 'hpMax';

export type TargetSel = 'party' | 'random' | 'lowestHp' | 'lowestLives' | 'gateCat';

export type Requirement =
  | { kind: 'class';   class: ClassId }
  | { kind: 'stat';    stat: 'atk' | 'def' | 'spd' | 'crt'; min: number }  // best EFFECTIVE stat
  | { kind: 'item';    item: ItemId; count?: number }
  | { kind: 'shinies'; cost: Scalar };

export type Effect =
  | { kind: 'heal';    target: TargetSel; amount: Scalar }
  | { kind: 'damage';  target: TargetSel; amount: Scalar }   // ignores def; clamps at 1 HP
  | { kind: 'buff';    target: TargetSel; stat: BuffStat; amount: number;
      duration: 'floor' | 'run' }
  | { kind: 'shinies'; amount: Scalar }
  | { kind: 'giveItem'; item: ItemId; count?: number }
  | { kind: 'takeItem'; item: ItemId; count?: number }
  | { kind: 'restoreLife'; target: 'lowestLives'; amount: number }
  | { kind: 'energyNextBattle'; target: TargetSel; amount: number }
  | { kind: 'fight'; encounter: EnemyId[]; loot: 'none' | 'normal' | 'bonus';
      onWinEffects?: Effect[] }
  | { kind: 'nothing' };

export interface Outcome { weight: number; text: string; effects: Effect[]; }
export interface EventOption { label: string; requires?: Requirement; outcomes: Outcome[]; }

export interface GameEvent {
  id: string; title: string; prompt: string;
  weight: number;
  floors: [number, number];
  once?: boolean;
  options: EventOption[];          // 2..4
}

export interface TempMod {          // events.md §1 "Temp stat mods"
  stat: BuffStat; amount: number;
  duration: 'floor' | 'run';
  sourceEventId: string;
}

export interface ResultLine {       // UI delta lines, also used by loot overlay
  text: string; tone: 'gain' | 'loss' | 'buff' | 'neutral';
}
```

### 2.9 Run state, save, score

```ts
export interface CatRunState {
  classId: ClassId;
  hp: number;                      // current; max derives from effectiveStats
  lives: number;                   // 0..9; 0 = gone for the run
  weapon: EquipInstance | null;
  trinket: EquipInstance | null;
  tempMods: TempMod[];
  energyNextBattle: number;        // consumed by next battle setup, then cleared
}

export interface ScoreCounters {
  floorsCleared: number;           // every roamer on the floor dead
  floorsReached: number;
  enemiesDefeated: number;
  bossesDefeated: number;
  catPiles: number;
  shiniesCollected: number;        // lifetime-this-run (score), not the wallet
}

export interface RunState {
  runSeed: string;
  floorNum: number;                // 1..6
  cats: CatRunState[];             // FIXED order [bruiser, trickster, hexer, medic]
  marchingOrder: ClassId[];        // living cats only, front→back
  xp: number; level: number;       // 1..8
  inventory: Inventory;
  score: ScoreCounters;
  firedEventIds: string[];         // run-scoped (for `once`)
  floorFiredEventIds: string[];    // reset each floor
  uniquesDropped: MewHookId[];     // mewthical downgrade rule
  floor: FloorState | null;
  playTimeMs: number;
}

// ---- persistence (core/run/save.ts) ----
export interface FloorDelta {      // tiles regenerate from the seed; deltas overlay
  partyPos: { x: number; y: number };
  explored: string;                // base64 bitset
  stepCount: number;
  stairsLocked: boolean;
  entities: (
    | { kind: 'chest'; id: number; opened: boolean }
    | { kind: 'event'; id: number; used: boolean }
    | { kind: 'roamer' | 'boss'; id: number; x: number; y: number; dead: boolean;
        state: Roamer['state']; stunnedFor: number; lostSightFor: number; wpIndex: number }
  )[];
}

export interface SaveFile {        // localStorage 'catrpg.save.v1'
  version: 1;
  run: Omit<RunState, 'floor'>;
  floorDelta: FloorDelta;
}

export interface MetaFile {        // localStorage 'catrpg.meta.v1' — records only, no unlocks
  version: 1;
  counters: { runs: number; victories: number };
  records: { bestScore: number; fastestVictoryMs: number | null };
}

// Score lines (core/run/score.ts): floorsCleared×100, floorsReached×50,
// enemiesDefeated×10, bossesDefeated×300, shinies×5, catPiles×20,
// livesRemaining×25 (victory only), victory bonus 1000. Time shown, never scored.
```

### 2.10 Content table types (what `src/content` must export)

```ts
// content/classes.ts
export declare const CLASSES: Record<ClassId, CatClass>;
// content/skills.ts — cat + enemy + boss + consumable-payload skills, one namespace
export declare const SKILLS: Record<SkillId, Skill>;
// content/enemies.ts
export declare const ENEMIES: Record<EnemyId, EnemyDef>;
// content/bosses.ts — boss EnemyDefs live in ENEMIES; this exports placement data
export declare const BOSS_ENCOUNTERS: Record<EnemyId, EnemyId[]>; // bossId → encounter array
// content/equipment.ts
export declare const EQUIP_DEFS: Record<ItemId, EquipDef>;
// content/consumables.ts
export declare const CONSUMABLES: Record<ItemId, ConsumableDef>;
// content/lootTables.ts
export declare const CONSUMABLE_WEIGHTS: { id: ItemId; weight: number }[]; // Σ = 100
export declare const RARITY_WEIGHTS: Record<'f12' | 'f34' | 'f56', Record<Rarity, number>>;
export declare const CHEST_DRAWS: { kind: 'consumable' | 'equipment' | 'shinyPile'; weight: number }[];
export declare const BUNDLES: Record<'SNACK_STASH' | 'SHINY_HOARD' | 'GEAR' | 'GEAR_FANCY'
                                   | 'TITHE' | 'MOULT', object>; // shapes per loot.md §5d
export declare const STARTING_KIT: { shinies: number;
  consumables: { defId: ItemId; count: number }[] }; // + stray L1 weapons equipped
// content/events.ts
export declare const EVENTS: GameEvent[];
// content/floors.ts
export declare const FLOORS: FloorConfig[];         // length 6, GDD §6 table
export declare const XP_TO_LEVEL: number[];         // [0,30,70,130,210,310,430,570]
export declare const LEVEL_CAP: number;             // 8
```

---

## 3. Scene management

### 3.1 The model

One `SceneManager` (in `ui/sceneManager.ts`) owns the pixi stage. States mirror
gameloop.md §1's FSM: scenes `boot · title · floorgen · explore · battle · event ·
landing · results`, overlays `loot · pause` (max one overlay, never stacked).

```ts
// ui/sceneManager.ts (contract — UI-layer type, not in core/types.ts)
export interface GameCtx {
  run: RunState | null;            // THE shared mutable state; scenes communicate only through it
  scenes: SceneManager;
  save(): void;                    // core/run/save.ts wrapper — called at the 5 autosave points
  meta: MetaFile;
}

export interface Scene {
  mount(root: Container, ctx: GameCtx, params?: unknown): void;
  unmount(): void;                 // MUST destroy all owned display objects + tickers
  update?(dtMs: number): void;     // called by the shared ticker while topmost
  onKey?(key: string): boolean;    // true = consumed
}

export interface SceneManager {
  goto(id: SceneId, params?: unknown): void;       // full swap: unmount old, mount new
  pushOverlay(id: OverlayId, params?: unknown): void;
  popOverlay(): void;
  current: SceneId;
  overlay: OverlayId | null;
}
```

Rules (from gameloop.md §1, restated as code behavior):

- `goto` destroys the outgoing scene completely. `explore` is **rebuilt from
  `ctx.run.floor`** on every re-entry — no scene survives in the background.
- While an overlay is up: the underlying scene's `update` is skipped and its
  subtree gets `interactiveChildren = false`. The pixi ticker keeps running
  (overlay animations, ambient idle in `landing`).
- `pause` cannot open over `loot`; Esc closes `loot` first. Esc opens `pause`
  from every scene except `boot`/`results`; during `battle` only in the input
  phase (the scene gates it).
- Transition legality is a static table in `sceneManager.ts`; illegal `goto`
  throws in dev, no-ops in prod.

### 3.2 Core → UI data flow (the one pattern)

Core engines are synchronous pure functions; UI drives them and animates their
event logs. **UI never mutates core state directly** — it calls a core function,
stores the returned state back onto `ctx.run` (or local battle state), and renders.

The battle scene's loop is the template:

```
battle.mount:
  bs = createBattle(setupFromRun(ctx.run, trigger))    // core/combat/setup.ts
  rng = mulberry32(hash(runSeed, floor, encounterIndex))
loop:
  if queue exhausted → { bs, events } = startRound(bs, rng); animate(events)
  actor = nextActor(bs)
  if actor.side === 'enemy' or status auto-skip:
      action = takeEnemyTurn(actor, bs, rng)
      { bs, events } = resolveAction(bs, action, rng); animate(events)
  else: enable input; on player confirm → resolveAction → animate(events)
  if bs.catPilePrompt → show banner → resolveAction({type:'catPile', accept})
  if bs.outcome !== 'ongoing' → result = battleResult(bs)
      → applyBattleResult(ctx.run, result)             // core/run/runState.ts
      → victory: pushOverlay('loot', rollVictoryLoot(...)) ; defeat: goto('results')
      → fled: goto('explore') (step loop applies the 5-step stun)
```

`animate(events)` appends to an animation queue that drains at ≥3 events/s even
mid-tween (ui-art §12); the engine never waits on animation. The explore scene
drives `core/dungeon/step.ts` identically: one `step(floor, dir)` per input,
returned `StepTrigger` dispatched to battle/event/loot/stairs handlers, fog diff
re-rendered.

### 3.3 Input

`ui/input.ts` installs exactly one `keydown`/`keyup` listener and a pointer
normalizer (design-resolution coordinates via the root transform). Dispatch order:
active overlay → active scene → global (Esc/M/Tab handled by scenes per their
specs). Key repeat for movement is implemented by the explore scene (re-step when
the 110 ms tween finishes while held), not by OS auto-repeat.

### 3.4 Stage & scaling

`main.ts` builds: `app.stage → root Container` at 1280×720 design resolution,
uniform `min(w/1280, h/720)` scale, centered, letterbox `PAL.void`. Layer stack
inside root, bottom→top: `bg · world · fx · hud · floaters · modal · flash`
(ui-art §1). Scenes receive `root` and attach to the appropriate layers; screen
shake offsets `world`+`fx` only.

---

## 4. Seeded RNG design

Single algorithm everywhere: **fnv1a string hash + mulberry32 PRNG**
(dungeon.md §2, canonical per GDD). `core/rng.ts` is the only file that
implements randomness; `Math.random()` is legal **only** in `src/ui` for visuals.

```ts
// core/rng.ts — full implementation (frozen; tests carry known-answer vectors)
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export const hash = (...parts: (string | number)[]): number => fnv1a(parts.join('|'));

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    float() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(lo, hi) { return lo + Math.floor(this.float() * (hi - lo + 1)); },
  };
}
```

`runSeed` is a **string** (user-entered or generated as 8 hex chars from
`Math.random()` at title screen — the only place visual RNG feeds gameplay, and
only to *pick* a seed).

### Stream split table (complete — no other gameplay streams may exist)

| Stream | Seed expression | Consumer | Consumption contract |
|---|---|---|---|
| `genRng` | `mulberry32(hash(runSeed, floor, 'gen'))` (`'gen1'`, `'gen2'`… on validation retry) | `dungeon/gen.ts` | strictly in dungeon.md §5 step order; rejected placements still burn their rolls |
| `popRng` | `mulberry32(hash(runSeed, floor, 'pop'))` (retry suffix likewise) | `dungeon/populate.ts` | strictly in dungeon.md §6 order |
| `battleRng` | `mulberry32(hash(runSeed, floor, encounterIndex))` | battle scene → all `core/combat` calls | draw order per combat.md §3: initiative (cats R1→4, enemies R1→5) → per action per target: variance, crit, per-effect status chances (chance 1.0 draws nothing) → AI tie-breaks → flee. Re-engaging a fled pack restarts the same stream |
| `chestSeed` | `hash(runSeed, floor, 'loot', chestIndex)` | `loot/roll.ts`, lazily at open | one fresh `mulberry32(chestSeed)` per open; roll order loot.md §5e |
| `victorySeed` | `hash(runSeed, floor, 'loot', 100 + encounterIndex)` | `loot/roll.ts`, at victory screen | same roll-order contract |
| `eventSeed` | `hash(runSeed, floor, 'event', eventIndex)` | `events/select.ts` + `events/resolve.ts`, at trigger | draw order events.md §2.2: selection → outcome → per-`random`-target |
| `shopRng` | `mulberry32(hash(runSeed, 'shop', n))` | `loot/shop.ts` per landing (n = floor just cleared) | stock rolls in loot.md §6 order |
| `bossPickRng` | `mulberry32(hash(runSeed, 'bossPick'))` | `runState.ts` (SHOULD: Rat Prince alternate) | one roll per run |

Rules: an `Rng` instance is created at the boundary (scene or run-state function)
and passed *down* into core functions — core never seeds itself, which is what
makes every engine test drivable with a scripted `Rng`. Exploration and roamer AI
consume **zero** RNG. Per-entity derived seeds mean open/trigger order can never
perturb any other system.

---

## 5. Work packages

12 packages. File ownership is **exclusive** — no two packages touch the same
file (`package.json`/config edits are WP-01 only; later packages needing a dep
ask the tech lead). "Deps" are hard build-order dependencies; everything else can
proceed in parallel on the frozen §2 contracts.

Dependency graph:

```
WP-01 ─► WP-02 ─┬─► WP-03 (combat) ────────────┬─► WP-11 (battle UI)
                ├─► WP-04 (dungeon) ───────────┼─► WP-10 (explore UI)
                ├─► WP-05 (loot) ──────┐       │
                ├─► WP-06 (events) ────┼───────┼─► WP-12 (event/landing/loot UI)
                ├─► WP-07 (run/save) ──┴─► WP-09 (shell)
                └─► WP-08 (UI kit) ──► WP-09, WP-10, WP-11, WP-12
```

After WP-02 lands, **six packages (03–08) run fully in parallel**; the four UI
packages then fan out again.

---

### WP-01 · Foundation *(no dependencies — lands first, blocks everything)*
**Files:** `src/core/types.ts`, `src/core/rng.ts`, `src/core/util.ts`,
`tests/rng.spec.ts`, plus one-time project setup: vitest devDependency +
`"test"` script in `package.json`, the `no-restricted-imports` rule in
`eslint.config.mjs`.
**Acceptance:**
- `types.ts` compiles standalone and contains §2 verbatim (plus doc comments).
- `hash('MEOW-1987', 1, 'gen')` and 10 first draws of its `mulberry32` recorded
  as known-answer test vectors; `int(lo,hi)` inclusive-bounds property test.
- `roundHalfUp(7.5)===8`, `roundHalfUp(6.4)===6`; weighted-pick and shuffle
  determinism tests pass.
- `npm test` and `npm run lint` green; lint fails on a planted `pixi.js` import
  in `src/core`.

### WP-02 · Content *(deps: WP-01)*
**Files:** all of `src/content/` (`classes.ts`, `skills.ts`, `enemies.ts`,
`bosses.ts`, `equipment.ts`, `consumables.ts`, `lootTables.ts`, `events.ts`,
`floors.ts`), `tests/content.spec.ts`.
**Acceptance:**
- Every table typechecks against §2.10. All cross-references resolve (skill ids
  on enemies/classes exist in `SKILLS`; event `encounter`/item ids exist;
  `'rat'`→`'ratThug'` fix applied; roombaScout uses dungeon.md's stat block).
- `CONSUMABLE_WEIGHTS` sums to 100; `FLOORS` is the GDD §6 table exactly;
  `XP_TO_LEVEL` matches classes.md §8.
- L1 party built from `CLASSES` equals combat.md §13's table byte-for-byte
  (stats, skills, default marching order).
- Boss data: vacuumKing 140 HP/Poise 3, dogfather 200 HP/Poise 4 + porcelainHound
  escort, flags per GDD §6.

### WP-03 · Combat engine *(deps: WP-01, WP-02)*
**Files:** `src/core/combat/` (`setup.ts`, `state.ts`, `turns.ts`, `resolve.ts`,
`status.ts`, `ai.ts`, `boss.ts`), `tests/combat.spec.ts`.
**Acceptance:**
- **combat.md §13 worked example reproduces exactly** (scripted `Rng` yielding the
  listed rolls → identical damage numbers, order, end state). This is the gate.
- Pipeline order (damage→moveTarget→applies→moveSelf→pile check→death check),
  clamping/Off-Balance rules, Cat Pile trigger + math, all six statuses, Poise/
  double-turn/phase/windup/summon, Frazzled-on-doubleTurn, flee formula, Nine
  Lives standup + in-battle-revive exemption — each covered by at least one test.
- All four class traits and all 8 Mewthical hooks implemented at their documented
  injection points; engine with no gear equipped passes the worked example.
- Purity: same seed + same action script ⇒ identical `BattleEvent` log (deep-equal
  test); no `Math.random`, no pixi (lint).

### WP-04 · Dungeon engine *(deps: WP-01, WP-02)*
**Files:** `src/core/dungeon/` (`gen.ts`, `populate.ts`, `floor.ts`, `step.ts`,
`roamers.ts`), `tests/dungeon.spec.ts`.
**Acceptance:**
- `runSeed 'MEOW-1987'`, floor 1 reproduces dungeon.md §13's grid, rooms, chest/
  event/roamer placements, packs, and `encounterIndex` assignment exactly
  (fixture test).
- Boss floors: 11×7 lair, single west door, locked stairs, hoard chest at
  `(lairX+2, lairY+1)`, lair-entry trigger.
- Visibility: Chebyshev-3 + Bresenham LOS + room light matches hand-built cases;
  doors never block LOS.
- Step loop: contact (Manhattan ≤1, lowest id), chest bump consumes step, flee
  returns to pre-contact tile with 5-step stun, roamer half-speed desync
  `(stepCount + id) % 2`, chase give-up rules — all tested; zero RNG consumed at
  runtime (assert by instrumented Rng).

### WP-05 · Loot & economy engine *(deps: WP-01, WP-02)*
**Files:** `src/core/loot/` (`roll.ts`, `inventory.ts`, `shop.ts`),
`tests/loot.spec.ts`.
**Acceptance:**
- Roll order per loot.md §5e (unneeded rolls skipped, not burned); rarity bands,
  slot 40/60, living-classes weapon pick, Mewthical unique-or-downgrade rule.
- Value formulas §3 (primary/secondary, round half up) against a reference table;
  prices, sell = floor(buy/4) min 1, Warm Lap `30+15n`.
- Inventory: 16 slots, stack-to-5 merge, equip/unequip hp adjustment (never below
  1), grief loot on cat death, MOULT downgrade, full-inventory take/leave paths.
- Shop stock roll from `shopRng` matches a recorded fixture for a known seed.

### WP-06 · Events engine *(deps: WP-01, WP-02)*
**Files:** `src/core/events/` (`select.ts`, `resolve.ts`, `validate.ts`),
`tests/events.spec.ts`.
**Acceptance:**
- `validate(EVENTS)` passes for shipped content and fails crafted violations of
  each of the 7 invariants.
- Draw order §2.2 verified with instrumented Rng (selection → outcome →
  per-random-target; single-outcome options skip the roll).
- Damage clamps at 1 HP; heal caps; requirement payment (item consumed, shinies
  deducted, gates free); `gateCat` resolution; fired-id bookkeeping (run + floor);
  tile consumed even on `nothing`/fled fight; `fightRequest` handed up unresolved;
  empty-pool shiny fallback.

### WP-07 · Run state, progression & save *(deps: WP-01, WP-02)*
**Files:** `src/core/run/` (`runState.ts`, `party.ts`, `score.ts`, `save.ts`),
`tests/run.spec.ts`.
**Acceptance:**
- `newRun(seed)`: starting kit, stray L1 weapons equipped, 20 ✦, default marching
  order, level 1.
- `effectiveStats`: base + growth rows + equip + tempMods; spd floors at 1,
  def/crt at 0; hpMax mods adjust current HP per events.md §1.
- Level-ups: multi-level from one battle, current-HP rises only by max-HP delta,
  capstone at 4 / trait tier 2 at 7, surplus XP past 570 ignored.
- `applyBattleResult`: hp/lives write-back, 0-Lives removal (marching order
  compression, grief loot via WP-05 API), score counters.
- Save: `serialize(run) → deserialize → regenerate floor from seed + overlay
  delta` round-trips to deep-equal `RunState` (for a mid-floor fixture);
  version-mismatch deletion; MetaFile records update; descend applies catnap heal
  `floor(0.25·maxHP)` and clears floor-scoped mods/event ids.
- Score table matches gameloop.md §7 on hand-computed fixtures.

### WP-08 · UI kit *(deps: WP-01, WP-02 — parallel with WP-03..07)*
**Files:** `src/ui/` (`palette.ts`, `layout.ts`, `textStyles.ts`, `tween.ts`,
`widgets.ts`, `input.ts`), `src/ui/draw/` (`cats.ts`, `enemies.ts`, `glyphs.ts`).
**Acceptance:**
- `PAL`/`THEMES`/rects/text styles match ui-art.md §§2-3, 7-11 values exactly.
- `drawCat` renders all 4 classes in both poses + mini-portrait + KO variant;
  `drawEnemy` renders all 4 families × size grades + boss extras; verified via a
  temporary dev gallery (kept behind `?gallery=1` URL flag inside `draw/glyphs.ts`'s
  dev helper, removed features not required).
- Tween helper: 3 eases, shake, fire-and-forget; widgets render per §6 spec.
- No gameplay imports beyond `core/types.ts` + `content` palettes.

### WP-09 · Shell: bootstrap, scene manager, meta screens *(deps: WP-07, WP-08)*
**Files:** `src/main.ts`, `src/ui/sceneManager.ts`, `src/ui/scenes/boot.ts`,
`title.ts`, `floorgen.ts`, `results.ts`, `src/ui/overlays/pause.ts`.
**Acceptance:**
- App boots to title at 60fps; letterbox scaling correct at arbitrary window
  sizes; FSM enforces the gameloop.md §1 transition table.
- Title: seed entry (blank = random 8-hex), New Run → floorgen → explore
  handoff, Continue visible iff valid save, Records line from MetaFile.
- Pause overlay: freeze semantics, Party/Inventory tabs open the WP-12 panel,
  Abandon → RESULTS(defeat) with save deletion.
- Results: full score count-up, NEW BEST flair, Again (same seed) / New Seed /
  Title; save deleted on entry; autosave fires at the five specified points via
  `ctx.save()`.

### WP-10 · Explore UI *(deps: WP-04, WP-07, WP-08)*
**Files:** `src/ui/scenes/explore.ts`, `exploreHud.ts`, `minimap.ts`.
**Acceptance:**
- Renders the MEOW-1987 fixture floor correctly (tiles, fog 3-state, entities
  culled by knowledge state, camera lerp + clamp).
- WASD/arrows step with held-repeat on tween completion (~9/s); click-to-path
  auto-walk with the three cancel conditions (SHOULD-tier, may stub to no-op);
  Tab marching-order panel blocked when a chaser is within 3 tiles; M map overlay.
- All `StepTrigger`s dispatched to the right scenes/overlays; roamer `!`/`?`
  markers; minimap per dungeon.md §11 table; belt allows Tuna/Sardine only,
  others disabled with tooltip.
- 60fps on the largest floor (35×23) — fog overlay rebuilds only changed tiles.

### WP-11 · Battle UI *(deps: WP-03, WP-08)*
**Files:** `src/ui/scenes/battle.ts`, `battleWidgets.ts`.
**Acceptance:**
- Full battle playable start-to-finish against any pack and both bosses using
  only `core/combat`'s public API + `BattleEvent` log (no rule logic in UI —
  verified by review).
- Ribbon (frozen queue, acted-dim, ×2 chips, collapse on death), skill bar with
  range strips + move glyphs + disabled-reasons, targeting flow with damage/shove
  previews (`previewDamage`), Cat Pile banner, Poise pips, charge telegraph,
  floaters/log per ui-art §8, KO corpse-slide exclusivity rule.
- Animation queue drains ≥3 events/s; engine resolution never blocked; hotkeys
  1-6, R scatter (hidden vs bosses), arrows for move-swap.

### WP-12 · Event, Landing & Loot UI *(deps: WP-05, WP-06, WP-07, WP-08)*
**Files:** `src/ui/scenes/event.ts`, `landing.ts`, `src/ui/overlays/loot.ts`,
`inventoryPanel.ts`.
**Acceptance:**
- Event modal: geometry per ui-art §9, interaction per events.md §3 (hotkeys 1-4,
  Esc does nothing, grayed-but-visible gates, RESULT delta lines, `Fight!`
  handoff to battle scene).
- Loot overlay: chest + victory variants, XP bar + level-up toasts + Lives
  ledger (pip crack), full-inventory take/leave modal path.
- Landing: catnap floaters, Peddler stock from WP-05 (buy/sell/Warm Lap once,
  sold-out slots), marching-order editor, Descend → floorgen.
- Inventory panel: 16-slot grid, per-cat equip/unequip with stat-delta preview,
  sort; opens from pause and from pickup.

### Integration gate (owned by WP-09's implementer, after all packages merge)
**Files:** `tests/integration.spec.ts`.
**Acceptance:** headless scripted run (fixed seed): new run → generate floor 1 →
fight pack 1 via scripted actions → loot → event tile → descend → assert
deep-equal `RunState` against a recorded fixture, twice (determinism). Plus a
manual playtest checklist: full 6-floor victory run, a defeat run, a
save/reload-mid-floor run, 60fps spot checks.

---

## 6. Open items / deferred decisions

- **SHOULD-tier features** (autosave already MUST-adjacent per GDD §11 — it is in
  WP-07/09; Rat Prince, Mewthical hooks, records flair, log scrollback, How to
  Play, click-to-path) degrade gracefully: hooks are stubbed as "downgrade to
  Pedigree" until WP-03's hook code lands; click-to-path may ship as keyboard-only.
- **No audio** in v1 (GDD §10 cut) — no audio module exists in the tree; adding
  one later is a new `ui/audio.ts` + scene calls, no core changes.
- Any contract change to §2 goes through this file first (edit + changelog note
  at the top), then fan-out to affected packages.
