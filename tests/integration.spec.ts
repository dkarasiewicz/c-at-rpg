/**
 * WP-09 — shell/integration gate tests.
 *
 * Part 1: SceneManager contract (ARCHITECTURE.md §3): the gameloop.md §1
 * FSM transition table — now with CAT TOWN between the title and the run
 * (balance-and-meta.md §4: title → Cat Town → run → results → Cat Town) —
 * overlay rules (max one, pause never over loot, Esc closes first), ticker
 * gating / freeze semantics, and key routing.
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
  FLOOR_COUNT,
  floorConfig,
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
import type { SaveFile } from "../src/core/types.js";
import { GATE_SEED, scriptedRun } from "./support/scriptedRun.js";

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
  it("walks the canonical happy path boot → town → … → results → town", () => {
    const { manager } = makeHarness();
    const path: SceneId[] = [
      "boot",
      "title",
      "catTown", // the hub owns the run start now (balance-and-meta.md §4)
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
      "catTown", // …and the payout is carried home to the hub
      "floorgen", // straight back down from the town
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
    manager.goto("catTown");
    expect(() => manager.goto("results")).toThrow(/illegal transition/);
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
    // CAT TOWN sits between the title and every run (balance-and-meta.md §4)
    expect(TRANSITIONS.title).toContain("catTown"); // the way into a run
    expect(TRANSITIONS.catTown).toEqual(["floorgen", "title"]);
    expect(TRANSITIONS.results).toContain("catTown"); // the payout comes home
    expect(TRANSITIONS.title).toContain("floorgen"); // ?smoke= direct start
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
    expect(TRANSITIONS.results).toEqual(["catTown", "floorgen", "title"]);
    // party creator (GM custom parties): title ⇄ creator, accept/fallback
    // always lands in floorgen — a run start is never blocked
    expect(TRANSITIONS.title).toContain("partyCreator");
    expect(TRANSITIONS.partyCreator).toEqual(["floorgen", "title"]);
    // LOOT/PAUSE are overlays, not states:
    expect(Object.keys(TRANSITIONS)).toHaveLength(10);
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
    manager.goto("catTown");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // the hub has no run to pause
    manager.goto("floorgen");
    manager.goto("runMap");
    manager.handleKey("esc");
    expect(manager.overlay).toBe("pause");
    manager.popOverlay();
    manager.goto("battle");
    manager.goto("results");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // results blocked
    // partyCreator and catTown have no run — their Esc navigates, never pauses
    expect(PAUSE_BLOCKED).toEqual([
      "boot",
      "results",
      "partyCreator",
      "catTown",
    ]);
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
    saveRun(run, { storage });
    const loaded = loadRun({ storage });
    expect(loaded).toEqual(run);
    // determinism: loading twice gives the same thing
    expect(loadRun({ storage })).toEqual(loaded);
  });

  it("different seeds diverge (sanity)", () => {
    const a = generateCurrentFloorMap(newRun("MEOW-1987"));
    const b = generateCurrentFloorMap(newRun("PURR-0001"));
    expect(b.floorMap).not.toEqual(a.floorMap);
  });
});

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

/* ------------------------------------------------------------------ */
/* the DEEP gate: floors 1-6 and the Dogfather                         */
/* ------------------------------------------------------------------ */
//
// The floor-1 gate above pins the shell, but every number it touches comes
// from `ENEMY_CURVE`'s shallow end: floor-1 packs, level-1 cats, tier-1
// stats. Nothing in the repo guarded the other end — floors 5-6, the tier-3
// roster, the level-8 party or the run's final boss — so a curve change
// could sail through green and only fail in a browser on floor 5.
//
// This walks the SAME driver all the way to the floor-6 boss and pins the
// resulting RunState as its own fixture. It is deliberately a second seed:
// the shallow gate and the deep gate must be able to fail independently.

const DEEP_SEED = "DEEP-0";
const DEEP_FIXTURE_URL = new URL(
  "./fixtures/integration-deep-run.json",
  import.meta.url,
);

describe("integration gate: the full descent (floors 1-6 + the boss)", () => {
  const out = scriptedRun(DEEP_SEED, { throughFloor: FLOOR_COUNT });

  it("walks every floor entry → terminal and clears all six", () => {
    expect(out.floorsWalked).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.run.floorNum).toBe(FLOOR_COUNT);
    expect(out.run.score.floorsReached).toBe(FLOOR_COUNT);
    expect(out.run.score.floorsCleared).toBe(FLOOR_COUNT);
  });

  it("puts down both authored bosses, the floor-6 one last", () => {
    expect(out.run.score.bossesDefeated).toBe(2);
    expect(out.bossesFelled).toHaveLength(2);
    // the run's final boss is whatever floor 6 authored as its lair holder
    expect(out.bossesFelled[1]).toBe(floorConfig(FLOOR_COUNT).boss?.bossId);
  });

  it("reaches the level cap and fights the deep roster", () => {
    // ENEMY_CURVE guard: a party that walked six floors is level 8 and has
    // felled a lot more than a floor-1 sample.
    expect(out.run.level).toBe(8);
    expect(out.run.score.enemiesDefeated).toBeGreaterThan(20);
    expect(out.fights).toBeGreaterThan(8);
    // somebody is still standing — a driver that wipes throws, but a run
    // that limps home with one cat is worth noticing in the assertion too
    expect(out.run.cats.filter((c) => c.lives > 0).length).toBeGreaterThan(0);
  });

  it("is deterministic: two executions produce deep-equal RunStates", () => {
    const again = scriptedRun(DEEP_SEED, { throughFloor: FLOOR_COUNT });
    expect(again.nodesVisited).toEqual(out.nodesVisited);
    expect(again.run).toEqual(out.run);
  });

  it("deep-equals the recorded late-floor RunState fixture", () => {
    const snapshot = JSON.parse(
      JSON.stringify(serializeRun(out.run)),
    ) as SaveFile;
    const path = fileURLToPath(DEEP_FIXTURE_URL);
    if (process.env.RECORD_FIXTURES) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
    }
    if (!existsSync(path)) {
      throw new Error(
        "missing tests/fixtures/integration-deep-run.json — record it with " +
          "RECORD_FIXTURES=1 npx vitest run tests/integration.spec.ts",
      );
    }
    const fixture = JSON.parse(readFileSync(path, "utf8")) as SaveFile;
    expect(snapshot).toEqual(fixture);
  });
});
