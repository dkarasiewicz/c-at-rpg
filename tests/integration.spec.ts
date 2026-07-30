/**
 * WP-09 — shell/integration gate tests.
 *
 * Part 1: SceneManager contract (ARCHITECTURE.md §3): the gameloop.md §1
 * FSM transition table, overlay rules (max one, pause never over loot,
 * Esc closes first), ticker gating / freeze semantics, and key routing.
 * Headless: sceneManager.ts imports pixi types only.
 *
 * Part 2: shell-level determinism — the title → floorgen → explore handoff
 * data path (newRun → generateCurrentFloor → autosave round-trip) is
 * deterministic for a fixed seed, twice.
 *
 * Part 3: the ARCHITECTURE.md §5 integration gate — a headless scripted
 * run on a fixed seed (new run → floor 1 → fight a pack via scripted
 * actions → loot → event tile → descend), deep-equalled against a
 * recorded RunState fixture and executed twice for determinism. The
 * driver below mirrors the REAL scene wiring byte-for-byte: the battle
 * scene's BattleSetup build + §4 rng stream keys, explore's chestSeed
 * rolls, the event scene's selectEvent/resolveOption stream, and the
 * loot overlay's applyEventEffects → applyLootGrant order.
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
} from "../src/ui/sceneManager";
import {
  applyBattleResult,
  applyLootGrant,
  descend,
  generateCurrentFloor,
  newRun,
} from "../src/core/run/runState";
import {
  loadRun,
  memoryStorage,
  saveRun,
  serializeRun,
  emptyMeta,
} from "../src/core/run/save";
import { Tile } from "../src/core/types";
import type {
  BattleAction,
  BattleEvent,
  BattleResult,
  BattleSetup,
  BattleState,
  EnemyId,
  EventOption,
  FloorState,
  MewHookId,
  Roamer,
  RunState,
  SaveFile,
} from "../src/core/types";
import { hash, mulberry32 } from "../src/core/rng";
import { CLASSES } from "../src/content/classes";
import { SKILLS } from "../src/content/skills";
import { EVENTS } from "../src/content/events";
import { createBattle } from "../src/core/combat/setup";
import { battleResult, isAutoSkip, startRound } from "../src/core/combat/turns";
import { legalActions, nextActor } from "../src/core/combat/state";
import { resolveAction } from "../src/core/combat/resolve";
import { takeEnemyTurn } from "../src/core/combat/ai";
import { contactCheck, step, type StepDir } from "../src/core/dungeon/step";
import {
  rollBossLoot,
  rollChest,
  rollVictory,
  type LootCtx,
} from "../src/core/loot/roll";
import { addShinies } from "../src/core/loot/inventory";
import { selectEvent } from "../src/core/events/select";
import {
  applyEventEffects,
  isOptionAvailable,
  resolveOption,
} from "../src/core/events/resolve";
import {
  effectiveStats,
  skillsForLevel,
  traitTier,
} from "../src/core/run/party";

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
      "explore",
      "battle",
      "explore",
      "event",
      "explore",
      "landing",
      "floorgen",
      "explore",
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
    manager.goto("explore");
    expect(() => manager.goto("title")).toThrow(/illegal transition/);
    expect(manager.current).toBe("explore");
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
    expect(TRANSITIONS.title).toContain("explore"); // Continue
    expect(TRANSITIONS.floorgen).toEqual(["explore"]);
    expect(TRANSITIONS.battle).toContain("results"); // defeat / floor-6 win
    expect(TRANSITIONS.event).toContain("battle"); // ambush fight
    expect(TRANSITIONS.landing).toContain("floorgen"); // Descend
    expect(TRANSITIONS.results).toEqual(["floorgen", "title"]);
    // LOOT/PAUSE are overlays, not states:
    expect(Object.keys(TRANSITIONS)).toHaveLength(8);
  });
});

/* ------------------------------------------------------------------ */
/* overlays: stacking, freeze, ticker gating                           */
/* ------------------------------------------------------------------ */

describe("SceneManager overlays", () => {
  it("never stacks overlays; pause cannot open over loot", () => {
    const { manager } = makeHarness();
    manager.goto("explore");
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
    manager.goto("explore");
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
    manager.goto("explore");
    manager.update(16);
    expect(sceneSpies.explore!.updates).toBe(1);
    manager.pushOverlay("loot");
    manager.update(16);
    manager.update(16);
    expect(sceneSpies.explore!.updates).toBe(1); // frozen
    expect(overlaySpies.loot!.updates).toBe(2);
    manager.popOverlay();
    manager.update(16);
    expect(sceneSpies.explore!.updates).toBe(2);
  });

  it("pops any overlay before a scene swap", () => {
    const { manager, overlaySpies } = makeHarness();
    manager.goto("explore");
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
    manager.goto("explore");
    manager.handleKey("esc");
    expect(manager.overlay).toBe("pause");
    manager.popOverlay();
    manager.goto("battle");
    manager.goto("results");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // results blocked
    expect(PAUSE_BLOCKED).toEqual(["boot", "results"]);
  });

  it("routes keys overlay-first and swallows them beneath an overlay", () => {
    const { manager, sceneSpies, overlaySpies } = makeHarness();
    manager.goto("explore");
    manager.handleKey("w");
    expect(sceneSpies.explore!.keys).toEqual(["w"]);
    manager.pushOverlay("loot");
    manager.handleKey("w");
    expect(overlaySpies.loot!.keys).toEqual(["w"]);
    expect(sceneSpies.explore!.keys).toEqual(["w"]); // frozen scene sees nothing
  });

  it("Esc closes the overlay first (loot before pause can ever open)", () => {
    const { manager } = makeHarness();
    manager.goto("explore");
    manager.pushOverlay("loot");
    manager.handleKey("esc");
    expect(manager.overlay).toBeNull(); // first Esc closed loot
    manager.handleKey("esc");
    expect(manager.overlay).toBe("pause"); // second Esc pauses
  });

  it("lets a consuming overlay keep Esc for itself", () => {
    const { manager, overlaySpies } = makeHarness();
    manager.goto("explore");
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

describe("shell handoff determinism (title → floorgen → explore)", () => {
  it("same seed ⇒ identical generated floor, twice", () => {
    const a = generateCurrentFloor(newRun("MEOW-1987"));
    const b = generateCurrentFloor(newRun("MEOW-1987"));
    expect(a.floor).not.toBeNull();
    expect(b.floor).toEqual(a.floor);
    expect(b).toEqual(a);
  });

  it("autosave at the floorgen point round-trips to a deep-equal run", () => {
    const storage = memoryStorage();
    const run = generateCurrentFloor(newRun("MEOW-1987"));
    saveRun(run, storage);
    const loaded = loadRun(storage);
    expect(loaded).toEqual(run);
    // determinism: loading twice gives the same thing
    expect(loadRun(storage)).toEqual(loaded);
  });

  it("different seeds diverge (sanity)", () => {
    const a = generateCurrentFloor(newRun("MEOW-1987"));
    const b = generateCurrentFloor(newRun("PURR-0001"));
    expect(b.floor).not.toEqual(a.floor);
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

const DIRS: readonly (readonly [StepDir, number, number])[] = [
  ["N", 0, -1],
  ["E", 1, 0],
  ["S", 0, 1],
  ["W", -1, 0],
];

/** BFS from the target outward; the party's best first step, or null. */
function firstStep(
  f: FloorState,
  tx: number,
  ty: number,
  blocked: ReadonlySet<number>,
): StepDir | null {
  const dist = new Int32Array(f.w * f.h).fill(-1);
  const q: number[] = [ty * f.w + tx];
  dist[q[0]] = 0;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    const cx = cur % f.w;
    const cy = (cur - cx) / f.w;
    for (const [, dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue;
      const ni = ny * f.w + nx;
      if (dist[ni] !== -1 || f.tiles[ni] === Tile.Wall || blocked.has(ni))
        continue;
      dist[ni] = dist[cur] + 1;
      q.push(ni);
    }
  }
  let best: StepDir | null = null;
  let bestD = Infinity;
  for (const [d, dx, dy] of DIRS) {
    const nx = f.party.x + dx;
    const ny = f.party.y + dy;
    if (nx < 0 || ny < 0 || nx >= f.w || ny >= f.h) continue;
    const dd = dist[ny * f.w + nx];
    if (dd >= 0 && dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return best;
}

/**
 * One party step toward (tx, ty), preferring paths that do not trample
 * other unopened chests / unused event tiles; falls back to a plain
 * path (bumping whatever is in the way) when entities block the only
 * corridor. Deterministic — no rng anywhere in the step loop.
 */
function stepToward(
  f: FloorState,
  tx: number,
  ty: number,
): ReturnType<typeof step> {
  const blocked = new Set<number>();
  for (const e of f.entities) {
    if (e.x === tx && e.y === ty) continue;
    if ((e.kind === "chest" && !e.opened) || (e.kind === "event" && !e.used)) {
      blocked.add(e.y * f.w + e.x);
    }
  }
  const dir = firstStep(f, tx, ty, blocked) ?? firstStep(f, tx, ty, new Set());
  if (!dir) throw new Error(`scripted run: no path to ${tx},${ty}`);
  return step(f, dir);
}

interface ScriptedOutcome {
  run: RunState;
  packFights: number;
  chestsOpened: number;
  eventsResolved: number;
}

/**
 * The §5 scripted mini-run: new run → generate floor 1 → walk to and
 * fight pack 1 (scripted actions, real AI, §4 streams) → victory loot →
 * open a chest (chestSeed stream) → step on an event tile (eventRng
 * stream, first available non-fight option; event fights handled via
 * the 1000+entityId encounterIndex convention) → descend to floor 2.
 */
function scriptedRun(seed: string): ScriptedOutcome {
  let run = generateCurrentFloor(newRun(seed));
  const f = run.floor;
  if (!f) throw new Error("floor 1 did not generate");
  let packFights = 0;
  let chestsOpened = 0;
  let eventsResolved = 0;

  // Victory write-back + §4 victory-loot stream, exactly as battle.ts
  // finish() does it (applyBattleResult → roll → applyLootGrant).
  const afterVictory = (
    result: BattleResult,
    encounterIndex: number,
    roamerId: number | undefined,
    isBoss: boolean,
  ): void => {
    run = applyBattleResult(run, result, roamerId).run;
    const vrng = mulberry32(
      hash(run.runSeed, run.floorNum, "loot", 100 + encounterIndex),
    );
    const grant = isBoss
      ? rollBossLoot(vrng, lootCtxOf(run))
      : rollVictory(vrng, lootCtxOf(run));
    run = applyLootGrant(run, grant).run; // overflow = Leave (none expected)
  };

  const fightChain = (
    trig: Extract<ReturnType<typeof step>, { t: "battle" }>,
  ): void => {
    let t: ReturnType<typeof contactCheck> = trig;
    while (t && t.t === "battle") {
      const result = driveBattle(run, t.enemies, t.encounterIndex, t.isBoss);
      if (result.outcome !== "victory") {
        throw new Error(`scripted pack fight ended in ${result.outcome}`);
      }
      afterVictory(result, t.encounterIndex, t.roamerId, t.isBoss);
      packFights++;
      t = contactCheck(f); // chained adjacent fights (dungeon.md §14)
    }
  };

  const resolveEventTile = (eventEntityId: number, eventSeed: number): void => {
    const erng = mulberry32(eventSeed);
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
      const encIdx = 1000 + eventEntityId; // event.ts convention
      const result = driveBattle(run, fr.encounter, encIdx, false);
      if (result.outcome !== "victory") {
        throw new Error(`scripted event fight ended in ${result.outcome}`);
      }
      run = applyBattleResult(run, result).run; // event fights: no roamerId
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

  const handleTrigger = (trig: ReturnType<typeof step>): void => {
    switch (trig.t) {
      case "battle":
        fightChain(trig);
        break;
      case "chest": {
        const chest = f.entities[trig.chestId];
        if (chest.kind !== "chest") throw new Error("bad chest trigger");
        // mirror of explore.ts openChest: fresh stream per open (§4)
        const crng = mulberry32(chest.chestSeed);
        const grant =
          chest.lootTableId === "boss_hoard"
            ? rollBossLoot(crng, lootCtxOf(run))
            : rollChest(crng, lootCtxOf(run));
        run = applyLootGrant(run, grant).run;
        chestsOpened++;
        break;
      }
      case "event":
        resolveEventTile(trig.eventId, trig.eventSeed);
        break;
      default:
        break; // moved / bump / stairs — keep walking
    }
  };

  const walkTo = (
    target: () => { x: number; y: number } | undefined,
    done: () => boolean,
    what: string,
  ): void => {
    for (let steps = 0; !done(); steps++) {
      if (steps > 800) throw new Error(`scripted run: ${what} not reached`);
      const t = target();
      if (!t) return; // nothing left of this kind on the floor
      handleTrigger(stepToward(f, t.x, t.y));
    }
  };

  // 1. fight pack 1 (lowest-id living roamer; chasers may intercept —
  //    all handled by the same deterministic battle driver).
  walkTo(
    () => f.entities.find((e): e is Roamer => e.kind === "roamer" && !e.dead),
    () => packFights > 0,
    "pack fight",
  );
  // 2. loot: bump open the first unopened chest.
  walkTo(
    () =>
      f.entities.find(
        (e): e is Extract<typeof e, { kind: "chest" }> =>
          e.kind === "chest" && !e.opened,
      ),
    () => chestsOpened > 0,
    "chest",
  );
  // 3. event tile.
  walkTo(
    () =>
      f.entities.find(
        (e): e is Extract<typeof e, { kind: "event" }> =>
          e.kind === "event" && !e.used,
      ),
    () => eventsResolved > 0,
    "event tile",
  );
  // 4. descend (core descend = floor-mod expiry → catnap → gen floor 2).
  run = descend(run);
  return { run, packFights, chestsOpened, eventsResolved };
}

const FIXTURE_URL = new URL("./fixtures/integration-run.json", import.meta.url);

describe("integration gate: scripted mini-run (ARCHITECTURE.md §5)", () => {
  it("covers battle, loot, event and descend on the fixed seed", () => {
    const out = scriptedRun(GATE_SEED);
    expect(out.packFights).toBeGreaterThan(0);
    expect(out.chestsOpened).toBeGreaterThan(0);
    expect(out.eventsResolved).toBeGreaterThan(0);
    expect(out.run.floorNum).toBe(2);
    expect(out.run.floor).not.toBeNull();
    expect(out.run.score.enemiesDefeated).toBeGreaterThan(0);
    expect(out.run.xp).toBeGreaterThan(0);
    expect(out.run.floorFiredEventIds).toEqual([]); // reset on descend
    expect(out.run.score.floorsReached).toBe(2);
  });

  it("is deterministic: two executions produce deep-equal RunStates", () => {
    const a = scriptedRun(GATE_SEED);
    const b = scriptedRun(GATE_SEED);
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
