/**
 * WP-09 — shell/integration gate tests.
 *
 * Part 1: SceneManager contract (ARCHITECTURE.md §3): the gameloop.md §1
 * FSM transition table, overlay rules (max one, pause never over loot,
 * Esc closes first), ticker gating / freeze semantics, and key routing.
 * Headless: sceneManager.ts imports pixi types only.
 *
 * Part 2: shell-level determinism — the title → floorgen → runMap handoff
 * data path (newRun → generateCurrentFloorMap → autosave round-trip) is
 * deterministic for a fixed seed, twice.
 *
 * Part 3: the ARCHITECTURE.md §5 integration gate — a headless scripted
 * run on a fixed seed (new run → floor 1's run map → walk entry to boss,
 * resolving every node → descend), deep-equalled against a recorded
 * RunState fixture and executed twice for determinism. The driver below
 * mirrors the REAL scene wiring byte-for-byte: the battle scene's
 * BattleSetup build + §4 rng stream keys, the node payload-seed rolls, the
 * event scene's selectEvent/resolveOption stream, and the loot overlay's
 * applyEventEffects → applyLootGrant order.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Container } from "pixi.js";
import {
  createSceneManager,
  LAYER_NAMES,
  PAUSE_BLOCKED,
  TRANSITIONS,
  type GameCtx,
  type OverlayFactories,
  type Scene,
  type SceneFactories,
  type SceneId,
} from "../src/ui/sceneManager.js";
import {
  applyBattleResult,
  applyLootGrant,
  descend,
  generateCurrentFloorMap,
  newRun,
} from "../src/core/run/runState.js";
import {
  loadRun,
  memoryStorage,
  saveRun,
  serializeRun,
  emptyMeta,
} from "../src/core/run/save.js";
import type {
  BattleAction,
  BattleEvent,
  BattleResult,
  BattleSetup,
  BattleState,
  EnemyId,
  EventOption,
  MapNode,
  MewHookId,
  NodeType,
  RunState,
  SaveFile,
} from "../src/core/types.js";
import { hash, mulberry32 } from "../src/core/rng.js";
import { CLASSES } from "../src/content/classes.js";
import { FLOORS } from "../src/content/floors.js";
import { encounterFor, encounterIndexOf } from "../src/core/map/encounter.js";
import {
  advance,
  atTerminal,
  optionsForRun,
} from "../src/core/map/traverse.js";
import { SKILLS } from "../src/content/skills.js";
import { EVENTS } from "../src/content/events.js";
import { createBattle } from "../src/core/combat/setup.js";
import {
  battleResult,
  isAutoSkip,
  startRound,
} from "../src/core/combat/turns.js";
import { legalActions, nextActor } from "../src/core/combat/state.js";
import { resolveAction } from "../src/core/combat/resolve.js";
import { takeEnemyTurn } from "../src/core/combat/ai.js";
import {
  rollBossLoot,
  rollChest,
  rollVictory,
  type LootCtx,
} from "../src/core/loot/roll.js";
import { addShinies } from "../src/core/loot/inventory.js";
import { selectEvent } from "../src/core/events/select.js";
import {
  applyEventEffects,
  isOptionAvailable,
  resolveOption,
} from "../src/core/events/resolve.js";
import {
  effectiveStats,
  skillsForLevel,
  traitTier,
} from "../src/core/run/party.js";

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface LayerStub {
  label: string;
  interactiveChildren: boolean;
}

function stubRoot(): { root: Container; layers: LayerStub[] } {
  const layers = LAYER_NAMES.map((label) => ({
    label,
    interactiveChildren: true,
  }));
  return { root: { children: layers } as unknown as Container, layers };
}

interface SpyScene extends Scene {
  mounted: number;
  unmounted: number;
  updates: number;
  keys: string[];
  lastParams: unknown;
  consumeKeys: boolean;
}

function spyScene(consumeKeys = false): SpyScene {
  const s: SpyScene = {
    mounted: 0,
    unmounted: 0,
    updates: 0,
    keys: [],
    lastParams: undefined,
    consumeKeys,
    mount(_root, _ctx, params) {
      s.mounted++;
      s.lastParams = params;
    },
    unmount() {
      s.unmounted++;
    },
    update() {
      s.updates++;
    },
    onKey(key) {
      s.keys.push(key);
      return s.consumeKeys;
    },
  };
  return s;
}

function makeHarness() {
  const { root, layers } = stubRoot();
  const sceneSpies: Partial<Record<SceneId, SpyScene>> = {};
  const overlaySpies: { loot?: SpyScene; pause?: SpyScene } = {};
  const scenes = Object.fromEntries(
    (Object.keys(TRANSITIONS) as SceneId[]).map((id) => [
      id,
      () => {
        const s = spyScene();
        sceneSpies[id] = s;
        return s;
      },
    ]),
  ) as SceneFactories;
  const overlays: OverlayFactories = {
    loot: () => (overlaySpies.loot = spyScene()),
    pause: () => (overlaySpies.pause = spyScene()),
  };
  const manager = createSceneManager(root, scenes, overlays, { strict: true });
  const ctx: GameCtx = {
    run: null,
    scenes: manager,
    save: () => undefined,
    meta: emptyMeta(),
  };
  manager.bind(ctx);
  return { manager, ctx, layers, sceneSpies, overlaySpies };
}

/* ------------------------------------------------------------------ */
/* FSM transition table                                                */
/* ------------------------------------------------------------------ */

describe("SceneManager FSM", () => {
  it("walks the canonical happy path boot → … → results → title", () => {
    const { manager } = makeHarness();
    const path: SceneId[] = [
      "boot",
      "title",
      "floorgen",
      "runMap",
      "battle", // a fight node
      "runMap",
      "event", // an event node
      "runMap",
      "landing", // a SHOP node borrows the Peddler…
      "runMap", // …and hands the route straight back
      "battle", // the stairs guard falls
      "runMap",
      "landing", // the stairwell, floor cleared
      "floorgen",
      "runMap",
      "battle",
      "results",
      "title",
    ];
    for (const id of path) {
      manager.goto(id);
      expect(manager.current).toBe(id);
    }
  });

  it("throws on illegal transitions in strict (dev) mode", () => {
    const { manager } = makeHarness();
    manager.goto("boot");
    expect(() => manager.goto("battle")).toThrow(/illegal transition/);
    manager.goto("title");
    manager.goto("floorgen");
    manager.goto("runMap");
    expect(() => manager.goto("title")).toThrow(/illegal transition/);
    expect(manager.current).toBe("runMap");
  });

  it("no-ops on illegal transitions in prod mode", () => {
    const { root } = (() => ({ root: stubRoot().root }))();
    const scenes = Object.fromEntries(
      (Object.keys(TRANSITIONS) as SceneId[]).map((id) => [
        id,
        () => spyScene(),
      ]),
    ) as SceneFactories;
    const manager = createSceneManager(
      root,
      scenes,
      { loot: () => spyScene(), pause: () => spyScene() },
      { strict: false },
    );
    manager.bind({
      run: null,
      scenes: manager,
      save: () => undefined,
      meta: emptyMeta(),
    });
    manager.goto("boot");
    manager.goto("results"); // illegal from boot
    expect(manager.current).toBe("boot");
  });

  it("destroys the outgoing scene on every swap (full swap, no survivors)", () => {
    const { manager, sceneSpies } = makeHarness();
    manager.goto("boot");
    manager.goto("title");
    expect(sceneSpies.boot!.unmounted).toBe(1);
    manager.goto("floorgen", { hello: 1 });
    expect(sceneSpies.title!.unmounted).toBe(1);
    expect(sceneSpies.floorgen!.mounted).toBe(1);
    expect(sceneSpies.floorgen!.lastParams).toEqual({ hello: 1 });
  });

  it("transition table matches the gameloop.md §1 FSM", () => {
    expect(TRANSITIONS.boot).toEqual(["title"]);
    expect(TRANSITIONS.title).toContain("floorgen"); // New Run
    expect(TRANSITIONS.title).toContain("runMap"); // Continue
    expect(TRANSITIONS.floorgen).toEqual(["runMap"]);
    expect(TRANSITIONS.battle).toContain("results"); // defeat / floor-6 win
    expect(TRANSITIONS.battle).toContain("runMap"); // back to the route
    expect(TRANSITIONS.event).toContain("battle"); // ambush fight
    // the run map dispatches every node type it does not resolve in-scene
    expect(TRANSITIONS.runMap).toEqual([
      "battle",
      "event",
      "landing",
      "results",
    ]);
    expect(TRANSITIONS.landing).toContain("floorgen"); // Descend
    expect(TRANSITIONS.landing).toContain("runMap"); // a shop NODE returns
    expect(TRANSITIONS.results).toEqual(["floorgen", "title"]);
    // party creator (GM custom parties): title ⇄ creator, accept/fallback
    // always lands in floorgen — a run start is never blocked
    expect(TRANSITIONS.title).toContain("partyCreator");
    expect(TRANSITIONS.partyCreator).toEqual(["floorgen", "title"]);
    // LOOT/PAUSE are overlays, not states:
    expect(Object.keys(TRANSITIONS)).toHaveLength(9);
  });
});

/* ------------------------------------------------------------------ */
/* overlays: stacking, freeze, ticker gating                           */
/* ------------------------------------------------------------------ */

describe("SceneManager overlays", () => {
  it("never stacks overlays; pause cannot open over loot", () => {
    const { manager } = makeHarness();
    manager.goto("runMap");
    manager.pushOverlay("loot");
    expect(manager.overlay).toBe("loot");
    manager.pushOverlay("pause"); // must be ignored
    expect(manager.overlay).toBe("loot");
    manager.popOverlay();
    expect(manager.overlay).toBeNull();
    manager.pushOverlay("pause");
    expect(manager.overlay).toBe("pause");
  });

  it("freezes non-modal layers beneath an overlay and thaws on pop", () => {
    const { manager, layers } = makeHarness();
    manager.goto("runMap");
    manager.pushOverlay("pause");
    for (const l of layers) {
      const expected = l.label === "modal" || l.label === "flash";
      expect(l.interactiveChildren).toBe(expected);
    }
    manager.popOverlay();
    for (const l of layers) expect(l.interactiveChildren).toBe(true);
  });

  it("skips the underlying scene's update while an overlay is up", () => {
    const { manager, sceneSpies, overlaySpies } = makeHarness();
    manager.goto("runMap");
    manager.update(16);
    expect(sceneSpies.runMap!.updates).toBe(1);
    manager.pushOverlay("loot");
    manager.update(16);
    manager.update(16);
    expect(sceneSpies.runMap!.updates).toBe(1); // frozen
    expect(overlaySpies.loot!.updates).toBe(2);
    manager.popOverlay();
    manager.update(16);
    expect(sceneSpies.runMap!.updates).toBe(2);
  });

  it("pops any overlay before a scene swap", () => {
    const { manager, overlaySpies } = makeHarness();
    manager.goto("runMap");
    manager.pushOverlay("pause");
    manager.goto("results"); // Abandon Run path
    expect(overlaySpies.pause!.unmounted).toBe(1);
    expect(manager.overlay).toBeNull();
    expect(manager.current).toBe("results");
  });
});

/* ------------------------------------------------------------------ */
/* key routing                                                         */
/* ------------------------------------------------------------------ */

describe("SceneManager key routing", () => {
  it("Esc opens pause from gameplay scenes but never on boot/results", () => {
    const { manager } = makeHarness();
    manager.goto("boot");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // boot blocked
    manager.goto("title");
    manager.goto("floorgen");
    manager.goto("runMap");
    manager.handleKey("esc");
    expect(manager.overlay).toBe("pause");
    manager.popOverlay();
    manager.goto("battle");
    manager.goto("results");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // results blocked
    // partyCreator has no run — its Esc navigates, never pauses
    expect(PAUSE_BLOCKED).toEqual(["boot", "results", "partyCreator"]);
  });

  it("routes keys overlay-first and swallows them beneath an overlay", () => {
    const { manager, sceneSpies, overlaySpies } = makeHarness();
    manager.goto("runMap");
    manager.handleKey("w");
    expect(sceneSpies.runMap!.keys).toEqual(["w"]);
    manager.pushOverlay("loot");
    manager.handleKey("w");
    expect(overlaySpies.loot!.keys).toEqual(["w"]);
    expect(sceneSpies.runMap!.keys).toEqual(["w"]); // frozen scene sees nothing
  });

  it("Esc closes the overlay first (loot before pause can ever open)", () => {
    const { manager } = makeHarness();
    manager.goto("runMap");
    manager.pushOverlay("loot");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // first Esc closed loot
    manager.handleKey("esc");
    expect(manager.overlay).toBe("pause"); // second Esc pauses
  });

  it("lets a consuming overlay keep Esc for itself", () => {
    const { manager, overlaySpies } = makeHarness();
    manager.goto("runMap");
    manager.pushOverlay("pause");
    overlaySpies.pause!.consumeKeys = true; // e.g. a sub-panel is open
    manager.handleKey("esc");
    expect(manager.overlay).toBe("pause"); // not popped
    overlaySpies.pause!.consumeKeys = false;
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* shell data path: newRun → floorgen → autosave round-trip            */
/* ------------------------------------------------------------------ */

describe("shell handoff determinism (title → floorgen → run map)", () => {
  it("same seed ⇒ identical generated run map, twice", () => {
    const a = generateCurrentFloorMap(newRun("MEOW-1987"));
    const b = generateCurrentFloorMap(newRun("MEOW-1987"));
    expect(a.floorMap).not.toBeNull();
    expect(b.floorMap).toEqual(a.floorMap);
    expect(b).toEqual(a);
  });

  it("autosave at the floorgen point round-trips to a deep-equal run", () => {
    const storage = memoryStorage();
    const run = generateCurrentFloorMap(newRun("MEOW-1987"));
    saveRun(run, storage);
    const loaded = loadRun(storage);
    expect(loaded).toEqual(run);
    // determinism: loading twice gives the same thing
    expect(loadRun(storage)).toEqual(loaded);
  });

  it("different seeds diverge (sanity)", () => {
    const a = generateCurrentFloorMap(newRun("MEOW-1987"));
    const b = generateCurrentFloorMap(newRun("PURR-0001"));
    expect(b.floorMap).not.toEqual(a.floorMap);
  });
});

/* ------------------------------------------------------------------ */
/* §5 integration gate: headless scripted run on a fixed seed          */
/* ------------------------------------------------------------------ */

const GATE_SEED = "MEOW-1987";

/** Mirror of battle.ts buildSetup: BattleSetup from the live RunState. */
function buildSetup(
  run: RunState,
  enemies: EnemyId[],
  encounterIndex: number,
  isBoss: boolean,
): BattleSetup {
  const cats: BattleSetup["cats"] = [];
  for (const classId of run.marchingOrder) {
    const cat = run.cats.find((c) => c.classId === classId);
    if (!cat || cat.lives <= 0) continue;
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
      classId,
      name: cls.catName,
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
function driveBattle(
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

interface ScriptedOutcome {
  run: RunState;
  nodesVisited: NodeType[];
  fights: number;
  treasures: number;
  eventsResolved: number;
}

/**
 * The §5 scripted mini-run, on the run map: new run → generate floor 1's
 * graph → walk entry → boss, always taking the FIRST offered route, and
 * resolve every node the party lands on with the real engines (packs from
 * the node's payload seed, victory loot on the §4 victory stream, treasure
 * on a chest roll, events through selectEvent/resolveOption) → descend.
 */
function scriptedRun(seed: string): ScriptedOutcome {
  let run = generateCurrentFloorMap(newRun(seed));
  const map = run.floorMap;
  if (!map) throw new Error("floor 1 map did not generate");
  const cfg = FLOORS[run.floorNum - 1];
  const nodesVisited: NodeType[] = [];
  let fights = 0;
  let treasures = 0;
  let eventsResolved = 0;

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

  /** Resolve the node the party is standing on, by type. */
  const resolveNode = (node: MapNode): void => {
    nodesVisited.push(node.type);
    switch (node.type) {
      case "fight":
      case "elite":
      case "boss": {
        const enemies = encounterFor(node, cfg);
        if (!enemies) throw new Error(`fight node ${node.id} has no pack`);
        const isBoss = node.type === "boss";
        const encIdx = encounterIndexOf(node);
        const result = driveBattle(run, enemies, encIdx, isBoss);
        if (result.outcome !== "victory") {
          throw new Error(`scripted node fight ended in ${result.outcome}`);
        }
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
      default:
        break; // shop / rest — the landing-style scenes own those
    }
  };

  resolveNode(map.nodes[run.currentNodeId!]);
  for (let steps = 0; !atTerminal(run); steps++) {
    if (steps > 32) throw new Error("scripted run: never reached the boss");
    const opts = optionsForRun(run);
    if (opts.length === 0) throw new Error("scripted run: dead end");
    run = advance(run, opts[0].node.id);
    resolveNode(map.nodes[run.currentNodeId!]);
  }

  // descend (core descend = floor-mod expiry → catnap → generate floor 2)
  run = descend(run);
  return { run, nodesVisited, fights, treasures, eventsResolved };
}

const FIXTURE_URL = new URL("./fixtures/integration-run.json", import.meta.url);

describe("integration gate: scripted mini-run (ARCHITECTURE.md §5)", () => {
  it("walks floor 1 entry → boss and covers fights, loot and descend", () => {
    const out = scriptedRun(GATE_SEED);
    expect(out.fights).toBeGreaterThan(0);
    expect(out.nodesVisited.length).toBeGreaterThanOrEqual(4);
    expect(out.run.floorNum).toBe(2);
    expect(out.run.floorMap).not.toBeNull();
    expect(out.run.score.enemiesDefeated).toBeGreaterThan(0);
    expect(out.run.xp).toBeGreaterThan(0);
    expect(out.run.floorFiredEventIds).toEqual([]); // reset on descend
    expect(out.run.score.floorsReached).toBe(2);
    expect(out.run.score.floorsCleared).toBe(1); // the terminal node fell
    // floor 2 starts fresh at its own entry node
    expect(out.run.currentNodeId).toBe(out.run.floorMap!.entryId);
    expect(out.run.visitedNodeIds).toEqual([out.run.floorMap!.entryId]);
  });

  it("is deterministic: two executions produce deep-equal RunStates", () => {
    const a = scriptedRun(GATE_SEED);
    const b = scriptedRun(GATE_SEED);
    expect(b.nodesVisited).toEqual(a.nodesVisited);
    expect(b.run).toEqual(a.run);
    expect(serializeRun(b.run)).toEqual(serializeRun(a.run));
  });

  it("deep-equals the recorded RunState fixture", () => {
    const { run } = scriptedRun(GATE_SEED);
    const snapshot = JSON.parse(JSON.stringify(serializeRun(run))) as SaveFile;
    const path = fileURLToPath(FIXTURE_URL);
    if (process.env.RECORD_FIXTURES) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
    }
    if (!existsSync(path)) {
      throw new Error(
        "missing tests/fixtures/integration-run.json — record it with " +
          "RECORD_FIXTURES=1 npx vitest run tests/integration.spec.ts",
      );
    }
    const fixture = JSON.parse(readFileSync(path, "utf8")) as SaveFile;
    expect(snapshot).toEqual(fixture);
  });
});
