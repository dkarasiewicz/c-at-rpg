/**
 * c(at)rpg — run-state lifecycle (ARCHITECTURE.md WP-07: core/run/runState.ts).
 *
 * newRun(seed) → the starting party & kit; floor generation entry points;
 * descend (floor-mod expiry + catnap heal + floor gen); applyBattleResult
 * write-back (hp/lives, XP/level-ups, deaths + grief loot, score counters);
 * loot-grant application; fired-event & Mewthical-unique bookkeeping.
 *
 * Convention: run-level functions return a NEW RunState (structural
 * sharing); the FloorState inside is the dungeon layer's mutable object and
 * is mutated in place (its own convention).
 */
import type {
  BattleResult,
  CatRunState,
  ClassId,
  EquipDef,
  EquipInstance,
  LootGrant,
  Roamer,
  RunState,
  ScoreCounters,
} from "../types";
import { EQUIP_DEFS } from "../../content/equipment";
import { FLOORS } from "../../content/floors";
import { STARTING_KIT } from "../../content/lootTables";
import { generateFloor } from "../dungeon/gen";
import { applyVictory } from "../dungeon/step";
import {
  addConsumables,
  addShinies,
  applyGrant,
  applyGriefLoot,
  emptyInventory,
} from "../loot/inventory";
import { makeEquipInstance } from "../loot/roll";
import {
  applyLevelUps,
  expireFloorMods,
  levelForXp,
  maxHp,
  XP_CAP,
} from "./party";

/** Fixed party order (types.ts §2.9) — also the default marching order. */
export const PARTY_ORDER: readonly ClassId[] = [
  "bruiser",
  "trickster",
  "hexer",
  "medic",
];

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
 * 2 Tuna Snacks + 1 Cardboard Box; default marching order. The floor is
 * NOT generated yet — FLOORGEN calls `generateCurrentFloor` (floorNum
 * starts at 1, floorsReached counts it as entered).
 */
export function newRun(runSeed: string): RunState {
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
    floor: null,
    playTimeMs: 0,
  };
}

/**
 * Generate (or regenerate) the current floor from the run seed — the
 * FLOORGEN state's core call. Deterministic: same seed + floorNum ⇒ same
 * floor.
 */
export function generateCurrentFloor(run: RunState): RunState {
  const cfg = FLOORS[run.floorNum - 1];
  if (!cfg) throw new Error(`no floor config for floor ${run.floorNum}`);
  return { ...run, floor: generateFloor(run.runSeed, run.floorNum, cfg) };
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
 *  4. the new floor generates from the seed.
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
  return generateCurrentFloor({
    ...run,
    cats,
    score,
    floorNum: run.floorNum + 1,
    floorFiredEventIds: [],
    floor: null,
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
 *  - on victory over a roamer pack (`roamerId` given): the pack dies on the
 *    floor (boss kill unlocks the stairs); when the last pack on the floor
 *    dies, `floorsCleared` ticks. Event fights pass no roamerId.
 */
export function applyBattleResult(
  run: RunState,
  result: BattleResult,
  roamerId?: number,
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

  // 6. floor bookkeeping: pack death + floors-cleared tick.
  if (result.outcome === "victory" && roamerId !== undefined && run.floor) {
    applyVictory(run.floor, roamerId);
    const packs = run.floor.entities.filter(
      (e): e is Roamer => e.kind === "roamer" || e.kind === "boss",
    );
    if (packs.length > 0 && packs.every((p) => p.dead)) {
      score.floorsCleared += 1;
    }
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
