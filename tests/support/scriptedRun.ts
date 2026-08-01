/**
 * THE SCRIPTED RUN DRIVER — the headless stand-in for a player.
 *
 * Extracted from tests/integration.spec.ts so BOTH gates (the floor-1 one
 * and the full-descent one) and any throwaway balance probe drive the exact
 * same code. It mirrors the REAL scene wiring byte-for-byte: the battle
 * scene's `BattleSetup` build and §4 rng stream keys, the node payload-seed
 * rolls, the run map's rest/treasure handling, the event scene's
 * selectEvent/resolveOption stream, and the loot overlay's
 * applyEventEffects → applyLootGrant order.
 *
 * The cat policy is deliberately unclever (first legal skill, first listed
 * target, otherwise guard) so the gate measures the ENGINE and not a tuned
 * bot. Enemies run the real AI.
 */
import {
  applyBattleResult,
  applyLootGrant,
  catnapHeal,
  descend,
  FLOOR_COUNT,
  floorConfig,
  generateCurrentFloorMap,
  fieldedCats,
  newRun,
} from "../../src/core/run/runState.js";
import type {
  BattleAction,
  CatId,
  BattleEvent,
  BattleResult,
  BattleSetup,
  BattleState,
  EnemyId,
  EventOption,
  FloorConfig,
  MapNode,
  EquipInstance,
  MewHookId,
  NodeType,
  RunState,
} from "../../src/core/types.js";
import {
  CAMP_EMBERS,
  canTakeCamp,
  newCampSession,
  takeCampAction,
  type CampActionId,
} from "../../src/core/run/camp.js";
import {
  withConditions,
  type CatCondition,
} from "../../src/core/run/conditions.js";
import { hash, mulberry32 } from "../../src/core/rng.js";
import { CLASSES } from "../../src/content/classes.js";
import {
  encounterFor,
  encounterIndexOf,
} from "../../src/core/map/encounter.js";
import {
  advance,
  atTerminal,
  optionsForRun,
} from "../../src/core/map/traverse.js";
import { SKILLS } from "../../src/content/skills.js";
import { EVENTS } from "../../src/content/events.js";
import { createBattle } from "../../src/core/combat/setup.js";
import {
  battleResult,
  isAutoSkip,
  startRound,
} from "../../src/core/combat/turns.js";
import { legalActions, nextActor } from "../../src/core/combat/state.js";
import { resolveAction } from "../../src/core/combat/resolve.js";
import { takeEnemyTurn } from "../../src/core/combat/ai.js";
import {
  rollBossLoot,
  rollChest,
  rollVictory,
  type LootCtx,
} from "../../src/core/loot/roll.js";
import {
  addEquip,
  addShinies,
  canEquip,
  equipItem,
  isEquip,
  removeSlot,
} from "../../src/core/loot/inventory.js";
import { EQUIP_DEFS } from "../../src/content/equipment.js";
import { selectEvent } from "../../src/core/events/select.js";
import {
  applyEventEffects,
  isOptionAvailable,
  resolveOption,
} from "../../src/core/events/resolve.js";
import {
  effectiveStats,
  maxHp,
  POINT_MENU,
  skillsForLevel,
  spendPoint,
  traitTier,
  unspentPoints,
} from "../../src/core/run/party.js";

/** The seed the shallow (floor-1) gate is recorded against. */
export const GATE_SEED = "MEOW-1987";

/** Mirror of battle.ts buildSetup: BattleSetup from the live RunState. */
export function buildSetup(
  run: RunState,
  enemies: EnemyId[],
  encounterIndex: number,
  isBoss: boolean,
): BattleSetup {
  const cats: BattleSetup["cats"] = [];
  for (const catId of run.marchingOrder) {
    const cat = run.cats.find((c) => c.id === catId);
    if (!cat || cat.lives <= 0) continue;
    const classId = cat.classId;
    const stats = effectiveStats(cat, run.level);
    const cls = CLASSES[classId];
    const traits =
      traitTier(classId, run.level) >= 2
        ? [cls.trait.id, cls.trait.id]
        : [cls.trait.id];
    const hooks: MewHookId[] = [];
    for (const item of [cat.weapon, cat.trinket]) {
      if (item?.hook && !item.hookSpent) hooks.push(item.hook);
    }
    cats.push({
      catId,
      classId,
      name: cat.name,
      stats,
      hp: Math.min(cat.hp, stats.hp),
      lives: cat.lives,
      skills: skillsForLevel(classId, run.level),
      traits,
      hooks,
      startEnergyBonus: cat.energyNextBattle,
    });
  }
  return { cats, enemies, encounterIndex, canFlee: !isBoss };
}

/** Mirror of the scenes' LootCtx construction. */
function lootCtxOf(run: RunState): LootCtx {
  return {
    floor: run.floorNum,
    livingClasses: run.cats.filter((c) => c.lives > 0).map((c) => c.classId),
    uniquesDropped: run.uniquesDropped,
    nextUid: run.inventory.nextUid,
    currentShinies: run.inventory.shinies,
  };
}

/**
 * Drive one battle to completion with a scripted, deterministic cat
 * policy: first legal skill (in class skill order) on its first listed
 * target, otherwise guard. Enemies run the real AI; the rng stream is
 * §4's `mulberry32(hash(runSeed, floor, encounterIndex))` exactly as
 * the battle scene keys it.
 */
export function driveBattle(
  run: RunState,
  enemies: EnemyId[],
  encounterIndex: number,
  isBoss: boolean,
): BattleResult {
  let bs: BattleState = createBattle(
    buildSetup(run, enemies, encounterIndex, isBoss),
  );
  const rng = mulberry32(hash(run.runSeed, run.floorNum, encounterIndex));
  const log: BattleEvent[] = [];
  const apply = (r: { state: BattleState; events: BattleEvent[] }): void => {
    bs = r.state;
    log.push(...r.events);
  };
  for (let guard = 0; bs.outcome === "ongoing"; guard++) {
    if (guard > 4000) throw new Error("scripted battle did not terminate");
    if (bs.catPilePrompt) {
      apply(resolveAction(bs, { type: "catPile", accept: true }, rng));
      continue;
    }
    const actor = nextActor(bs);
    if (!actor) {
      apply(startRound(bs, rng));
      continue;
    }
    if (actor.side === "enemy") {
      apply(resolveAction(bs, takeEnemyTurn(actor, bs, rng), rng));
      continue;
    }
    if (isAutoSkip(bs)) {
      apply(resolveAction(bs, { type: "guard" }, rng));
      continue;
    }
    const la = legalActions(bs);
    const opt = la.skills.find((s) => s.ok);
    let action: BattleAction = { type: "guard" };
    if (opt) {
      const def = SKILLS[opt.skillId];
      const needsTarget =
        def.target.pattern === "single" && def.target.side !== "self";
      action = needsTarget
        ? { type: "skill", skillId: opt.skillId, targetId: opt.targetIds[0] }
        : { type: "skill", skillId: opt.skillId };
    }
    apply(resolveAction(bs, action, rng));
  }
  return battleResult(bs, log);
}

/**
 * THE DEN, headless — everything a player does between fights and the driver
 * used to skip entirely.
 *
 * Without this the scripted party walks all six floors in its starting Stray
 * L1 weapons with every Whisker Point unspent, which is not "an unclever
 * player", it is a party with two thirds of its power switched off. Measured:
 * 1 seed in 400 finished a descent that way, and most of them died on floor
 * 2. It is not a fair test of `ENEMY_CURVE` if the party never levels up.
 *
 * Both policies are dumb but deterministic:
 *   POINTS  round-robin down `POINT_MENU` until nothing can take another.
 *   GEAR    equip anything in the backpack whose stat total beats what is in
 *           that slot now; the loser goes back in the bag.
 */
function manageParty(run: RunState): RunState {
  let cats = run.cats.slice();
  let inventory = run.inventory;

  // ---- Whisker Points -------------------------------------------------
  cats = cats.map((cat) => {
    let next = cat;
    for (let guard = 0; unspentPoints(next, run.level) > 0; guard++) {
      if (guard > 64) break;
      const before = next;
      for (const entry of POINT_MENU) {
        if (unspentPoints(next, run.level) <= 0) break;
        next = spendPoint(next, entry.stat, run.level);
      }
      if (next === before) break; // every stat capped
    }
    return next;
  });

  // ---- gear -----------------------------------------------------------
  const worth = (item: EquipInstance | null): number => {
    if (!item) return -1;
    let n = 0;
    for (const v of Object.values(item.stats)) n += v ?? 0;
    return n;
  };
  for (let ci = 0; ci < cats.length; ci++) {
    if (cats[ci].lives <= 0) continue;
    for (let si = 0; si < inventory.slots.length; si++) {
      const slot = inventory.slots[si];
      if (!isEquip(slot)) continue;
      const cat = cats[ci];
      if (!canEquip(cat, slot)) continue;
      const target = EQUIP_DEFS[slot.defId].slot;
      if (worth(slot) <= worth(cat[target] ?? null)) continue;
      const pulled = removeSlot(inventory, si);
      inventory = pulled.inv;
      const swap = equipItem(cat, slot);
      cats[ci] = swap.cat;
      if (swap.replaced) inventory = addEquip(inventory, swap.replaced).inv;
    }
  }

  return { ...run, cats, inventory };
}

export interface ScriptedOutcome {
  run: RunState;
  nodesVisited: NodeType[];
  fights: number;
  treasures: number;
  eventsResolved: number;
  /** Catnap nodes the party actually curled up on. */
  rests: number;
  /** Camp fires the party sat down at (roster-and-persistence.md §4). */
  camps: number;
  /** Floors the driver actually walked entry → terminal, in order. */
  floorsWalked: number[];
  /** Enemy ids the driver put down, deepest floor last. */
  bossesFelled: EnemyId[];
  /**
   * Every pack the driver actually fought, in order, tagged with the floor it
   * was fought on. This is the only place a test can see WHAT the late floors
   * field — `nodesVisited` reports a node was a fight, never that the fight
   * was three tier-3 monsters — so it is what pins the deep end of
   * `ENEMY_CURVE` and the tier roster to a fixture.
   */
  packs: { floor: number; enemies: EnemyId[]; boss: boolean }[];
  /**
   * 1-based route number the driver stopped in FRONT of (the run map's own
   * `1`/`2`/`3` hotkeys), or 0 when it did not stop short.
   */
  stoppedBeforeRoute: number;
}

/**
 * The §5 scripted run, on the run map: new run → generate the floor's graph →
 * walk entry → terminal, always taking the FIRST offered route, resolving
 * every node the party lands on with the real engines (packs from the node's
 * payload seed, victory loot on the §4 victory stream, treasure on a chest
 * roll, events through selectEvent/resolveOption) → descend → repeat.
 *
 * `throughFloor` is how deep to go. The floor-1 gate stops at 1 (and descends
 * once, so the descend path is covered); the late-floor gate runs it to
 * `FLOOR_COUNT`, which is the ONLY automated thing in the repo that touches
 * floors 5-6, the ENEMY_CURVE at depth, and the Dogfather.
 */
export function scriptedRun(
  seed: string,
  opts: {
    throughFloor?: number;
    /**
     * Stop the LAST floor one step short of its terminal node, leaving the
     * party standing where the boss is the next route. What the browser
     * playtest injects as a save so it can walk into the floor-6 lair by
     * hand instead of replaying five floors of keystrokes.
     */
    stopBeforeTerminal?: boolean;
    /**
     * Stop as soon as a route of this TYPE is on offer, without taking it.
     * The browser playtest uses it to park a save one step from an event
     * node so the event modal can be opened by hand.
     */
    stopBeforeType?: NodeType;
    /**
     * Conditions to hang on EVERY cat before the descent
     * (roster-and-persistence.md §3). The driver builds its party with
     * `newRun`, which has no town behind it and therefore no hunger and no
     * scars — so this is how a balance probe asks "what does a clowder that
     * nobody fed actually cost?" without inventing a second harness.
     */
    conditions?: readonly CatCondition[];
  } = {},
): ScriptedOutcome {
  const throughFloor = Math.max(
    1,
    Math.min(FLOOR_COUNT, opts.throughFloor ?? 1),
  );
  let run = generateCurrentFloorMap(newRun(seed));
  if (opts.conditions && opts.conditions.length > 0) {
    const carried = opts.conditions;
    run = {
      ...run,
      cats: run.cats.map((c) => {
        const cat = withConditions(c, carried);
        return { ...cat, hp: maxHp(cat, run.level) };
      }),
    };
  }
  const nodesVisited: NodeType[] = [];
  const floorsWalked: number[] = [];
  const bossesFelled: EnemyId[] = [];
  const packs: { floor: number; enemies: EnemyId[]; boss: boolean }[] = [];
  let fights = 0;
  let treasures = 0;
  let eventsResolved = 0;
  let rests = 0;
  let camps = 0;
  let stoppedBeforeRoute = 0;
  /** The floor the driver is on — re-read per node, never captured once. */
  const cfgNow = (): FloorConfig => floorConfig(run.floorNum);

  // Victory write-back + §4 victory-loot stream, exactly as battle.ts
  // finish() does it (applyBattleResult → roll → applyLootGrant).
  const afterVictory = (
    result: BattleResult,
    encounterIndex: number,
    nodeId: number | undefined,
    isBoss: boolean,
  ): void => {
    run = applyBattleResult(run, result, nodeId).run;
    const vrng = mulberry32(
      hash(run.runSeed, run.floorNum, "loot", 100 + encounterIndex),
    );
    const grant = isBoss
      ? rollBossLoot(vrng, lootCtxOf(run))
      : rollVictory(vrng, lootCtxOf(run));
    run = applyLootGrant(run, grant).run; // overflow = Leave (none expected)
  };

  const resolveEventNode = (node: MapNode): void => {
    const erng = mulberry32(node.seed);
    const sel = selectEvent(
      EVENTS,
      run.floorNum,
      run.firedEventIds,
      run.floorFiredEventIds,
      erng,
    );
    if (sel.kind === "fallback") {
      // mirror of event.ts: shinies + score, no rng draws
      const inv = addShinies(run.inventory, sel.shinies);
      run = {
        ...run,
        inventory: inv,
        score: {
          ...run.score,
          shiniesCollected:
            run.score.shiniesCollected + (inv.shinies - run.inventory.shinies),
        },
      };
      eventsResolved++;
      return;
    }
    const evt = sel.event;
    const noFight = (o: EventOption): boolean =>
      o.outcomes.every((oc) => oc.effects.every((e) => e.kind !== "fight"));
    let optIdx = evt.options.findIndex(
      (o) => isOptionAvailable(run, o) && noFight(o),
    );
    if (optIdx < 0) {
      optIdx = evt.options.findIndex((o) => isOptionAvailable(run, o));
    }
    if (optIdx < 0) throw new Error(`no available option on ${evt.id}`);
    const out = resolveOption(run, evt, optIdx, erng);
    run = out.state;
    if (out.fightRequest) {
      const fr = out.fightRequest;
      const encIdx = 1000 + node.id; // event.ts convention
      packs.push({
        floor: run.floorNum,
        enemies: [...fr.encounter],
        boss: false,
      });
      const result = driveBattle(run, fr.encounter, encIdx, false);
      if (result.outcome !== "victory") {
        throw new Error(`scripted event fight ended in ${result.outcome}`);
      }
      run = applyBattleResult(run, result).run; // event fights: no node id
      // loot overlay order: onWinEffects (same eventRng) → grant
      const vrng = mulberry32(
        hash(run.runSeed, run.floorNum, "loot", 100 + encIdx),
      );
      const grant =
        fr.loot === "none"
          ? null
          : fr.loot === "bonus"
            ? rollChest(vrng, lootCtxOf(run))
            : rollVictory(vrng, lootCtxOf(run));
      run = applyEventEffects(
        run,
        fr.onWinEffects,
        fr.eventId,
        erng,
        fr.gateCatIndex,
      ).state;
      if (grant) run = applyLootGrant(run, grant).run;
    }
    eventsResolved++;
  };

  /**
   * Resolve the node the party is standing on, by type — then do the
   * between-nodes housekeeping a player does (`manageParty`).
   */
  const resolveNode = (node: MapNode): void => {
    nodesVisited.push(node.type);
    switch (node.type) {
      case "fight":
      case "elite":
      case "boss": {
        const enemies = encounterFor(node, cfgNow());
        if (!enemies) throw new Error(`fight node ${node.id} has no pack`);
        const isBoss = node.type === "boss";
        const encIdx = encounterIndexOf(node);
        packs.push({
          floor: run.floorNum,
          enemies: [...enemies],
          boss: isBoss,
        });
        const result = driveBattle(run, enemies, encIdx, isBoss);
        if (result.outcome !== "victory") {
          throw new Error(
            `scripted node fight ended in ${result.outcome} ` +
              `(floor ${run.floorNum}, node ${node.id}, pack ${enemies.join("+")})`,
          );
        }
        // the LAIR HOLDER, not its escort — floor 6 walks in with a hound
        if (isBoss) bossesFelled.push(cfgNow().boss?.bossId ?? enemies[0]);
        afterVictory(result, encIdx, node.id, isBoss);
        fights++;
        break;
      }
      case "treasure": {
        // mirror of the treasure node: one fresh stream per node seed (§4)
        const crng = mulberry32(node.seed);
        run = applyLootGrant(run, rollChest(crng, lootCtxOf(run))).run;
        treasures++;
        break;
      }
      case "event":
        resolveEventNode(node);
        break;
      case "rest": {
        // The run map's catnap panel, headless: the SAME `catnapHeal` the
        // scene calls. The driver used to fall through here, which quietly
        // made every scripted run harder than a played one — a real party
        // walking onto a warm spot always takes the heal.
        const { cats } = catnapHeal(run.cats, run.level);
        run = { ...run, cats };
        rests++;
        break;
      }
      case "camp": {
        // The camp scene, headless (roster-and-persistence.md §4). The policy
        // is the dull-but-sensible one a player reaches for: patch up whoever
        // is worst, feed whoever is hungriest, and put somebody on watch —
        // taken through the REAL `takeCampAction`, so what the gate measures
        // is the shipped camp and not an idealised one.
        run = spendCamp(run);
        camps++;
        break;
      }
      default:
        break; // shop — the Peddler is the landing scene's, and buying
      // nothing is a legal (and deterministic) player choice
    }
    run = manageParty(run);
  };

  /** One floor, entry node → terminal node, resolving everything on the way. */
  const walkFloor = (stopShort = false): void => {
    const map = run.floorMap;
    if (!map) throw new Error(`floor ${run.floorNum} map did not generate`);
    floorsWalked.push(run.floorNum);
    resolveNode(map.nodes[run.currentNodeId!]);
    for (let steps = 0; !atTerminal(run); steps++) {
      if (steps > 32) {
        throw new Error(`floor ${run.floorNum}: never reached the terminal`);
      }
      const routes = optionsForRun(run);
      if (routes.length === 0) {
        throw new Error(`floor ${run.floorNum}: dead end`);
      }
      // one step from what the caller asked for: hand the move over
      if (stopShort && routes[0].node.id === map.bossId) {
        stoppedBeforeRoute = 1;
        return;
      }
      if (opts.stopBeforeType) {
        const i = routes.findIndex((r) => r.node.type === opts.stopBeforeType);
        if (i >= 0) {
          stoppedBeforeRoute = i + 1;
          return;
        }
      }
      run = advance(run, routes[0].node.id);
      resolveNode(map.nodes[run.currentNodeId!]);
    }
    if (stopShort) return;
    if (run.score.floorsCleared < run.floorNum) {
      throw new Error(`floor ${run.floorNum}: terminal node did not fall`);
    }
  };

  const hunting = opts.stopBeforeType !== undefined;
  while (run.floorNum < throughFloor && stoppedBeforeRoute === 0) {
    walkFloor(hunting);
    if (stoppedBeforeRoute > 0) break;
    // descend (core descend = floor-mod expiry → catnap → next floor's map)
    run = descend(run);
  }
  if (stoppedBeforeRoute === 0) {
    walkFloor(opts.stopBeforeTerminal === true || hunting);
  }
  // the floor-1 gate keeps its original shape: it descends once past its
  // last walked floor, which is what covers the descend path itself.
  if (
    throughFloor < FLOOR_COUNT &&
    !opts.stopBeforeTerminal &&
    stoppedBeforeRoute === 0
  ) {
    run = descend(run);
  }

  return {
    run,
    nodesVisited,
    fights,
    treasures,
    eventsResolved,
    rests,
    camps,
    floorsWalked,
    bossesFelled,
    packs,
    stoppedBeforeRoute,
  };
}

/* ------------------------------------------------------------------ */
/* the camp, headless (roster-and-persistence.md §4)                   */
/* ------------------------------------------------------------------ */

/**
 * Spend a camp fire the way a competent, unclever player does: the most
 * wounded cat gets patched up, the hungriest gets fed, somebody takes the
 * watch — first legal action in that order, until the embers are gone.
 *
 * It goes through the REAL `canTakeCamp` / `takeCampAction`, so the gate
 * fixture pins the shipped camp: change what an ember buys and this run's
 * recorded HP changes with it.
 */
export function spendCamp(start: RunState): RunState {
  let run = start;
  let session = newCampSession();
  for (let i = 0; i < CAMP_EMBERS; i++) {
    const party = fieldedCats(run);
    if (party.length === 0) break;
    const wounded = [...party].sort(
      (a, b) =>
        a.hp / maxHp(a, run.level) - b.hp / maxHp(b, run.level) ||
        (a.id < b.id ? -1 : 1),
    );
    const tries: { id: CampActionId; who: CatId[] }[] = [
      ...wounded.map((c) => ({ id: "bandage" as const, who: [c.id] })),
      ...party.map((c) => ({ id: "eat" as const, who: [c.id] })),
      ...party.map((c) => ({ id: "tend" as const, who: [c.id] })),
      { id: "watch" as const, who: [party[0].id] },
      ...(party.length >= 2
        ? [{ id: "talk" as const, who: [party[0].id, party[1].id] }]
        : []),
    ];
    const next = tries.find((t) => canTakeCamp(run, session, t.id, t.who).ok);
    if (!next) break;
    const out = takeCampAction(run, session, next.id, next.who);
    run = out.run;
    session = out.session;
  }
  return run;
}
