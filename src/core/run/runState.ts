/**
 * c(at)rpg — run-state lifecycle (ARCHITECTURE.md WP-07: core/run/runState.ts).
 *
 * newRun(seed) → the starting party & kit; run-map generation entry points;
 * descend (floor-mod expiry + catnap heal + map gen); applyBattleResult
 * write-back (hp/lives, XP/level-ups, deaths + grief loot, score counters);
 * loot-grant application; fired-event & Mewthical-unique bookkeeping.
 *
 * Convention: run-level functions return a NEW RunState (structural
 * sharing). The run map is immutable data — traversal state lives on the
 * RunState itself as `currentNodeId` / `visitedNodeIds` (core/map/traverse.ts).
 */
import type {
  BattleResult,
  CatClass,
  CatRunState,
  ClassId,
  EquipDef,
  EquipInstance,
  FloorConfig,
  FloorMap,
  LootGrant,
  RunState,
  ScoreCounters,
  Skill,
  Stats,
} from "../types.js";
import type { PowerScript } from "../combat/powerTypes.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { FLOORS } from "../../content/floors.js";
import { STARTING_KIT } from "../../content/lootTables.js";
import { generateFloorMap } from "../map/generate.js";
import {
  addConsumables,
  addShinies,
  applyGrant,
  applyGriefLoot,
  emptyInventory,
} from "../loot/inventory.js";
import { makeEquipInstance } from "../loot/roll.js";
import {
  applyLevelUps,
  expireFloorMods,
  levelForXp,
  maxHp,
  XP_CAP,
} from "./party.js";

/** Fixed party order (types.ts §2.9) — also the default marching order. */
export const PARTY_ORDER: readonly ClassId[] = [
  "bruiser",
  "trickster",
  "hexer",
  "medic",
];

/* ------------------------------------------------------------------ */
/* Custom party (GM party creator — docs/design/gm-system.md)          */
/* ------------------------------------------------------------------ */

/**
 * A GM-generated cat kit, snapshotted into the run at creation. Composed of
 * core types only (the ui-layer party creator maps the wire-shape
 * `GeneratedCatKit` from src/services/gmTypes.ts into this — core never
 * imports from services). Each kit occupies one of the four fixed ClassId
 * slots (role-mapped: tank→bruiser, striker→trickster, control→hexer,
 * support→medic) so every classId-keyed system keeps working; the ui layer
 * overlays the kit's stats/skills/flavor onto the content tables for the
 * duration of the run.
 */
export interface CustomCatKit {
  /** The fixed party slot this kit occupies. */
  classId: ClassId;
  role: "tank" | "striker" | "control" | "support";
  catName: string;
  className: string;
  epithet: string;
  /** L1 stats (GM budget-linted per role). */
  base: Stats;
  /** 7 rows, applied at L2..L8. */
  growth: Partial<Stats>[];
  /** Exactly 4 full Skill defs (ids namespaced, not in content/skills.ts). */
  skills: Skill[];
  /** Prose-only in v1 — custom trait hooks are not executable. */
  trait: { name: string; desc: string };
  /** Dramatic ALL-CAPS Stand name. */
  standName: string;
  /** Masonry image prompt kept for future sprite generation (no art yet). */
  visualPrompt: string;
  /** Budget-linted Power Script (stand-powers.md Layer 2). */
  power: PowerScript;
  flavor: CatClass["flavor"];
}

// Additive, optional extension of the frozen §2.9 RunState contract: a run
// started from the party creator carries its generated kits (they serialize
// with the save via serializeRun's rest-spread). Absent = the four Strays.
declare module "../types" {
  interface RunState {
    /** GM-generated custom party (party creator); absent = default Strays. */
    customParty?: CustomCatKit[];
  }
}

export const FLOOR_COUNT = FLOORS.length; // 6
/** Landing catnap: free `floor(0.25 × maxHP)` per living cat (GDD §7). */
export const CATNAP_PCT = 0.25;

const zeroScore = (): ScoreCounters => ({
  floorsCleared: 0,
  floorsReached: 0,
  enemiesDefeated: 0,
  bossesDefeated: 0,
  catPiles: 0,
  shiniesCollected: 0,
});

function weaponDefFor(classId: ClassId): EquipDef {
  const def = Object.values(EQUIP_DEFS).find(
    (d) => d.slot === "weapon" && d.classId === classId,
  );
  if (!def) throw new Error(`no class weapon def for ${classId}`);
  return def;
}

/**
 * A fresh run (gameloop RUN_INIT): fixed party [bruiser, trickster, hexer,
 * medic] at level 1, 9 Lives and full HP each, wearing their Stray L1 class
 * weapons (`atk +2`, fixed — no rolls, loot.md §6); starting kit 20 ✦ +
 * 2 Tuna Snacks + 1 Cardboard Box; default marching order. The run map is
 * NOT generated yet — FLOORGEN calls `generateCurrentFloorMap` (floorNum
 * starts at 1, floorsReached counts it as entered).
 *
 * `customParty` (optional, additive — default behavior is unchanged): a
 * party-creator run records its GM-generated kits on the RunState. NOTE the
 * caller must have overlaid the kits onto the content tables BEFORE calling
 * (ui/scenes/partyCreator.ts applyPartyContent) so starting HP derives from
 * the custom base stats; cats still occupy the four fixed ClassId slots.
 */
export function newRun(
  runSeed: string,
  customParty?: CustomCatKit[],
): RunState {
  let inventory = emptyInventory();
  inventory = addShinies(inventory, STARTING_KIT.shinies);
  for (const c of STARTING_KIT.consumables) {
    inventory = addConsumables(inventory, c.defId, c.count).inv;
  }

  const cats: CatRunState[] = PARTY_ORDER.map((classId, i) => {
    const weapon = makeEquipInstance(
      i + 1,
      weaponDefFor(classId).id,
      1,
      "stray",
    );
    const cat: CatRunState = {
      classId,
      hp: 0,
      lives: 9,
      weapon,
      trinket: null,
      tempMods: [],
      energyNextBattle: 0,
    };
    cat.hp = maxHp(cat, 1);
    return cat;
  });
  inventory = { ...inventory, nextUid: PARTY_ORDER.length + 1 };

  const score = zeroScore();
  score.floorsReached = 1;

  return {
    runSeed,
    floorNum: 1,
    cats,
    marchingOrder: PARTY_ORDER.slice(),
    xp: 0,
    level: 1,
    inventory,
    score,
    firedEventIds: [],
    floorFiredEventIds: [],
    uniquesDropped: [],
    floorMap: null,
    currentNodeId: null,
    visitedNodeIds: [],
    playTimeMs: 0,
    ...(customParty && customParty.length > 0 ? { customParty } : {}),
  };
}

/** The FloorConfig for a 1-based floor number, or a hard error. */
export function floorConfig(floorNum: number): FloorConfig {
  const cfg = FLOORS[floorNum - 1];
  if (!cfg) throw new Error(`no floor config for floor ${floorNum}`);
  return cfg;
}

/**
 * Generate (or regenerate) the current floor's run map from the run seed —
 * the FLOORGEN state's core call. Deterministic: same seed + floorNum ⇒ the
 * same graph (run-map-and-dm.md §2). The party is placed on the entry node
 * and the entry counts as visited: it is where the floor's first encounter
 * happens, not a lobby.
 */
export function generateCurrentFloorMap(run: RunState): RunState {
  const map = generateFloorMap(
    run.runSeed,
    run.floorNum,
    floorConfig(run.floorNum),
  );
  return enterFloorMap(run, map);
}

/** Put the party on a map's entry node (fresh floor, or a migrated save). */
export function enterFloorMap(run: RunState, map: FloorMap): RunState {
  return {
    ...run,
    floorMap: map,
    currentNodeId: map.entryId,
    visitedNodeIds: [map.entryId],
  };
}

/** Living cats (lives > 0), fixed party order. */
export function livingCats(run: RunState): CatRunState[] {
  return run.cats.filter((c) => c.lives > 0);
}

/**
 * Free landing catnap: every living cat heals `floor(0.25 × maxHP)`,
 * capped at max HP. Returns the healed amounts per cat index (0 for dead
 * or already-full cats) for the landing scene's floaters.
 */
export function catnapHeal(
  cats: readonly CatRunState[],
  level: number,
): { cats: CatRunState[]; healed: number[] } {
  const healed: number[] = [];
  const next = cats.map((cat) => {
    if (cat.lives <= 0) {
      healed.push(0);
      return cat;
    }
    const max = maxHp(cat, level);
    const hp = Math.min(max, cat.hp + Math.floor(CATNAP_PCT * max));
    healed.push(hp - cat.hp);
    return hp === cat.hp ? cat : { ...cat, hp };
  });
  return { cats: next, healed };
}

/**
 * Descend to the next floor (Landing → FLOORGEN n+1):
 *  1. floor-scoped tempMods expire (descending the stairs — events.md §1),
 *  2. free catnap heal `floor(0.25 × maxHP)` per living cat,
 *  3. floorNum+1, floorsReached+1, floor-scoped fired-event ids reset,
 *  4. the new floor's run map generates from the seed and the party is
 *     placed on its entry node (traversal state resets with the floor).
 * `energyNextBattle` grants persist — they are consumed by the next battle
 * setup, whenever that happens.
 */
export function descend(run: RunState): RunState {
  if (run.floorNum >= FLOOR_COUNT) {
    throw new Error("descend: already on the last floor");
  }
  const expired = run.cats.map((c) => expireFloorMods(c, run.level));
  const { cats } = catnapHeal(expired, run.level);
  const score = { ...run.score, floorsReached: run.score.floorsReached + 1 };
  return generateCurrentFloorMap({
    ...run,
    cats,
    score,
    floorNum: run.floorNum + 1,
    floorFiredEventIds: [],
    floorMap: null,
    currentNodeId: null,
    visitedNodeIds: [],
  });
}

/* ------------------------------------------------------------------ */
/* battle write-back                                                   */
/* ------------------------------------------------------------------ */

export interface ApplyBattleOutput {
  run: RunState;
  /** classIds that hit 0 Lives in this battle (gone for the run) */
  died: ClassId[];
  /** their equipment, now in the shared inventory (grief loot) */
  griefLoot: EquipInstance[];
  /** grief pieces that found no inventory slot (dropped to the tile) */
  griefOverflow: EquipInstance[];
  /** party level after XP application (== run.level) */
  levelAfter: number;
}

/**
 * Write a finished battle back into the run (gameloop.md §1: battles write
 * back ONLY per-cat hp/lives, XP/level, score counters — everything else is
 * battle-scoped):
 *
 *  - per-cat `hp`/`lives` from the post-standup BattleResult values;
 *    `energyNextBattle` was consumed by this battle's setup and clears;
 *  - Ninth Bell: `hookSpent` latches on the equipped instance;
 *  - XP → level-ups (multi-level ok, delta-HP rule, surplus past 570
 *    ignored) applied to the written-back HP values;
 *  - cats at 0 Lives: removed from the marching order (compression) and
 *    their gear drops into the shared inventory (grief loot, WP-05 API);
 *  - score counters (enemies, cat piles, bosses);
 *  - on victory at the floor's TERMINAL node (`nodeId === floorMap.bossId`):
 *    `floorsCleared` ticks — the boss (or the pack guarding the stairs) is
 *    down and the way onward is open. Pass the node the fight belongs to;
 *    event fights and mid-floor packs pass their own id (or nothing) and
 *    never tick it.
 */
export function applyBattleResult(
  run: RunState,
  result: BattleResult,
  nodeId?: number,
): ApplyBattleOutput {
  // 1. hp/lives write-back (post-standup values), energyNextBattle cleared.
  let cats: CatRunState[] = run.cats.map((cat) => {
    const r = result.cats.find((c) => c.classId === cat.classId);
    if (!r) return cat;
    return { ...cat, hp: r.hp, lives: r.lives, energyNextBattle: 0 };
  });

  // 2. Ninth Bell crack: mark the equipped instance spent.
  if (result.ninthBellSpent) {
    cats = cats.map((cat) => {
      const t = cat.trinket;
      if (t && t.hook === "ninthBell" && !t.hookSpent) {
        return { ...cat, trinket: { ...t, hookSpent: true } };
      }
      return cat;
    });
  }

  // 3. XP + level-ups (victory only carries xp; flee/defeat report 0).
  const xp = Math.min(XP_CAP, run.xp + result.xpGained);
  const levelAfter = levelForXp(xp);
  cats = applyLevelUps(cats, run.level, levelAfter);

  // 4. deaths: marching-order compression + grief loot.
  const died: ClassId[] = [];
  const griefLoot: EquipInstance[] = [];
  const griefOverflow: EquipInstance[] = [];
  let inventory = run.inventory;
  cats = cats.map((cat) => {
    if (cat.lives > 0) return cat;
    if (!run.marchingOrder.includes(cat.classId)) return cat; // already gone
    died.push(cat.classId);
    const g = applyGriefLoot(cat, inventory);
    inventory = g.inv;
    griefLoot.push(...g.dropped);
    griefOverflow.push(...g.overflow);
    return g.cat;
  });
  const marchingOrder = run.marchingOrder.filter((id) => !died.includes(id));

  // 5. score counters.
  const score: ScoreCounters = {
    ...run.score,
    enemiesDefeated: run.score.enemiesDefeated + result.enemiesDefeated,
    catPiles: run.score.catPiles + result.catPiles,
    bossesDefeated: run.score.bossesDefeated + (result.bossDefeated ? 1 : 0),
  };

  // 6. floor bookkeeping: clearing the terminal node clears the floor.
  if (
    result.outcome === "victory" &&
    nodeId !== undefined &&
    run.floorMap !== null &&
    nodeId === run.floorMap.bossId
  ) {
    score.floorsCleared += 1;
  }

  return {
    run: {
      ...run,
      cats,
      marchingOrder,
      xp,
      level: levelAfter,
      inventory,
      score,
    },
    died,
    griefLoot,
    griefOverflow,
    levelAfter,
  };
}

/* ------------------------------------------------------------------ */
/* loot & event bookkeeping                                            */
/* ------------------------------------------------------------------ */

/**
 * Fold a LootGrant into the run: wallet (clamped 0..999; negatives = TITHE),
 * inventory slots (overflow returned for the Take/Leave modal), the
 * `shiniesCollected` score counter (positive gains only — punishments never
 * reduce score), and Mewthical unique bookkeeping (uniquesDropped).
 */
export function applyLootGrant(
  run: RunState,
  grant: LootGrant,
): {
  run: RunState;
  overflow: {
    equips: EquipInstance[];
    consumables: { defId: string; count: number }[];
  };
} {
  const { inv, overflow } = applyGrant(run.inventory, grant);
  const uniques = run.uniquesDropped.slice();
  for (const e of grant.equips) {
    if (e.hook && !uniques.includes(e.hook)) uniques.push(e.hook);
  }
  const score = {
    ...run.score,
    shiniesCollected: run.score.shiniesCollected + Math.max(0, grant.shinies),
  };
  return {
    run: { ...run, inventory: inv, uniquesDropped: uniques, score },
    overflow,
  };
}

/**
 * Record a fired event id: floor-scoped list (no repeat on this floor) and
 * the run-scoped list (`once` gating — events.md §2.1). Idempotent.
 */
export function markEventFired(run: RunState, eventId: string): RunState {
  const floorFiredEventIds = run.floorFiredEventIds.includes(eventId)
    ? run.floorFiredEventIds
    : [...run.floorFiredEventIds, eventId];
  const firedEventIds = run.firedEventIds.includes(eventId)
    ? run.firedEventIds
    : [...run.firedEventIds, eventId];
  return { ...run, firedEventIds, floorFiredEventIds };
}
