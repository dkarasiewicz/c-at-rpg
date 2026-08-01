/**
 * WP-06 — Events engine tests (ARCHITECTURE.md §5 WP-06 acceptance):
 *  - validator passes shipped content, fails crafted violations of each of
 *    the 7 invariants;
 *  - draw order §2.2 with an instrumented Rng (selection → outcome →
 *    per-random-target; single-outcome options skip the roll);
 *  - damage clamps at 1 HP; heal caps; requirement payment; gateCat;
 *  - fired-id bookkeeping (run + floor), even on `nothing` / pending fight;
 *  - fightRequest handed up unresolved; empty-pool shiny fallback.
 */
import { describe, expect, it } from "vitest";
import type {
  CatRunState,
  ClassId,
  EventOption,
  GameEvent,
  InventorySlot,
  Outcome,
  Rng,
  RunState,
} from "../src/core/types.js";
import { hash, mulberry32 } from "../src/core/rng.js";
import { eligibleEvents, selectEvent } from "../src/core/events/select.js";
import {
  applyEventEffects,
  effectiveGateStat,
  effectiveMaxHp,
  isOptionAvailable,
  resolveOption,
  resolveScalar,
} from "../src/core/events/resolve.js";
import { validateEvents } from "../src/core/events/validate.js";
import { EVENTS } from "../src/content/events.js";
import { CLASSES } from "../src/content/classes.js";
import { CONSUMABLES } from "../src/content/consumables.js";

/* ------------------------------------------------------------------------ */
/* Fixtures & instrumented Rng                                               */
/* ------------------------------------------------------------------------ */

const ORDER: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];
const NAME = (c: ClassId) => CLASSES[c].catName;

function makeRun(
  over: Partial<RunState> = {},
  catOver: Partial<CatRunState>[] = [],
): RunState {
  const cats: CatRunState[] = ORDER.map((classId, i) => ({
    // the seeded Strays keep their class name as their instance id
    id: classId,
    name: CLASSES[classId].catName,
    classId,
    hp: CLASSES[classId].base.hp,
    lives: 9,
    weapon: null,
    trinket: null,
    tempMods: [],
    energyNextBattle: 0,
    ...(catOver[i] ?? {}),
  }));
  const slots: InventorySlot[] = new Array<InventorySlot>(16).fill(null);
  return {
    runSeed: "TEST",
    floorNum: 1,
    cats,
    marchingOrder: [...ORDER],
    xp: 0,
    level: 1,
    inventory: { shinies: 50, slots, nextUid: 1 },
    score: {
      floorsCleared: 0,
      floorsReached: 1,
      enemiesDefeated: 0,
      bossesDefeated: 0,
      catPiles: 0,
      shiniesCollected: 0,
    },
    firedEventIds: [],
    floorFiredEventIds: [],
    uniquesDropped: [],
    floor: null,
    playTimeMs: 0,
    ...over,
  };
}

const ev = (id: string): GameEvent => {
  const found = EVENTS.find((e) => e.id === id);
  if (!found) throw new Error(`no shipped event '${id}'`);
  return found;
};

/** Scripted rng: floats served in order; int() derives from one float draw. */
function floatsRng(vals: number[]): Rng {
  let i = 0;
  const next = () => {
    if (i >= vals.length) throw new Error("scripted rng exhausted");
    return vals[i++];
  };
  return {
    float: next,
    int(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
  };
}

/** Wraps any Rng and logs every draw ("float" / "int(lo,hi)"). */
function tracked(rng: Rng): Rng & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    float() {
      log.push("float");
      return rng.float();
    },
    int(lo, hi) {
      log.push(`int(${lo},${hi})`);
      return rng.int(lo, hi);
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Validator — shipped content + the 7 invariants                            */
/* ------------------------------------------------------------------------ */

const walkAway: EventOption = {
  label: "Walk away.",
  outcomes: [{ weight: 1, text: "You leave.", effects: [{ kind: "nothing" }] }],
};
const plainOutcome: Outcome = {
  weight: 1,
  text: "ok",
  effects: [{ kind: "shinies", amount: 5 }],
};
function crafted(
  options: EventOption[],
  over: Partial<GameEvent> = {},
): GameEvent {
  return {
    id: "crafted",
    title: "Crafted",
    prompt: "Test.",
    weight: 5,
    floors: [1, 6],
    options,
    ...over,
  };
}

describe("validate: shipped content", () => {
  it("validateEvents(EVENTS) passes", () => {
    expect(validateEvents(EVENTS)).toEqual([]);
  });
});

describe("validate: the 7 invariants fail crafted violations", () => {
  it("1: option/outcome counts and weights", () => {
    expect(validateEvents([crafted([walkAway])]).join()).toMatch(/2-4 options/);
    expect(
      validateEvents([
        crafted([walkAway, walkAway, walkAway, walkAway, walkAway]),
      ]).join(),
    ).toMatch(/2-4 options/);
    expect(
      validateEvents([
        crafted([walkAway, { label: "x", outcomes: [] }]),
      ]).join(),
    ).toMatch(/1-4 outcomes/);
    expect(
      validateEvents([
        crafted([
          walkAway,
          { label: "x", outcomes: [{ ...plainOutcome, weight: 0 }] },
        ]),
      ]).join(),
    ).toMatch(/weight must be > 0/);
    expect(
      validateEvents([crafted([walkAway, walkAway], { weight: 0 })]).join(),
    ).toMatch(/event weight must be > 0/);
  });

  it("2: the walk-away rule", () => {
    const damaging: EventOption = {
      label: "ouch",
      outcomes: [
        {
          weight: 1,
          text: "ow",
          effects: [{ kind: "damage", target: "party", amount: 3 }],
        },
      ],
    };
    const gated: EventOption = {
      ...walkAway,
      requires: { kind: "class", class: "medic" },
    };
    expect(validateEvents([crafted([damaging, gated])]).join()).toMatch(
      /walk-away/,
    );
    // a requirement-free, damage-free, fight-free option satisfies it
    expect(validateEvents([crafted([damaging, walkAway])])).toEqual([]);
  });

  it("3: fight placement", () => {
    const fightNotLast: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [
            { kind: "fight", encounter: ["ratThug"], loot: "none" },
            { kind: "nothing" },
          ],
        },
      ],
    };
    expect(validateEvents([crafted([fightNotLast, walkAway])]).join()).toMatch(
      /not the last effect/,
    );
    const twoFights: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [
            { kind: "fight", encounter: ["ratThug"], loot: "none" },
            { kind: "fight", encounter: ["ratThug"], loot: "none" },
          ],
        },
      ],
    };
    expect(validateEvents([crafted([twoFights, walkAway])]).join()).toMatch(
      /more than one fight/,
    );
  });

  it("4: gateCat only behind class/stat gates", () => {
    const ungatedGateCat: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [{ kind: "heal", target: "gateCat", amount: 5 }],
        },
      ],
    };
    expect(
      validateEvents([crafted([ungatedGateCat, walkAway])]).join(),
    ).toMatch(/gateCat/);
    // item/shinies gates do not produce a gate cat either
    const itemGated: EventOption = {
      ...ungatedGateCat,
      requires: { kind: "item", item: "tunaSnack" },
    };
    expect(validateEvents([crafted([itemGated, walkAway])]).join()).toMatch(
      /gateCat/,
    );
  });

  it("5: id cross-references", () => {
    const badEnemy: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [
            { kind: "fight", encounter: ["ghostOfXmas"], loot: "none" },
          ],
        },
      ],
    };
    expect(validateEvents([crafted([badEnemy, walkAway])]).join()).toMatch(
      /unknown enemy id 'ghostOfXmas'/,
    );
    const badItem: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [{ kind: "giveItem", item: "phantomTreat" }],
        },
      ],
    };
    expect(validateEvents([crafted([badItem, walkAway])]).join()).toMatch(
      /unknown item id 'phantomTreat'/,
    );
    const badReqItem: EventOption = {
      ...walkAway,
      label: "x",
      requires: { kind: "item", item: "phantomTreat" },
    };
    expect(validateEvents([crafted([badReqItem, walkAway])]).join()).toMatch(
      /unknown item id 'phantomTreat'/,
    );
  });

  it("6: scalars resolve >= 0 on every firing floor", () => {
    const negAtHighFloor: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [
            {
              kind: "damage",
              target: "party",
              amount: { base: 2, perFloor: -1 },
            },
          ],
        },
      ],
    };
    expect(
      validateEvents([crafted([negAtHighFloor, walkAway])]).join(),
    ).toMatch(/resolves below 0 on floor 3/);
    const negCost: EventOption = {
      ...walkAway,
      label: "x",
      requires: { kind: "shinies", cost: { base: 4, perFloor: -1 } },
    };
    expect(validateEvents([crafted([negCost, walkAway])]).join()).toMatch(
      /cost resolves below 0/,
    );
  });

  it("7: restoreLife amount >= 1 (static facet)", () => {
    const zeroRestore: EventOption = {
      label: "x",
      outcomes: [
        {
          weight: 1,
          text: "y",
          effects: [{ kind: "restoreLife", target: "lowestLives", amount: 0 }],
        },
      ],
    };
    expect(validateEvents([crafted([zeroRestore, walkAway])]).join()).toMatch(
      /restoreLife amount/,
    );
  });
});

/* ------------------------------------------------------------------------ */
/* Selection (§2.1) + empty-pool fallback                                    */
/* ------------------------------------------------------------------------ */

describe("selectEvent", () => {
  const FLOOR1_IDS = [
    "yarnBall",
    "suspiciousHuman",
    "perfectBox",
    "milkBowl",
    "catnipPatch",
  ];

  it("floor-1 pool is the 5 floor-range events", () => {
    expect(eligibleEvents(EVENTS, 1, [], []).map((e) => e.id)).toEqual(
      FLOOR1_IDS,
    );
  });

  it("once events fired this run are excluded; non-once are not", () => {
    const ids = eligibleEvents(
      EVENTS,
      3,
      ["shrineOfNine", "elderStray", "yarnBall"],
      [],
    ).map((e) => e.id);
    expect(ids).not.toContain("shrineOfNine");
    expect(ids).not.toContain("elderStray");
    expect(ids).toContain("yarnBall"); // run-fired non-once still eligible
  });

  it("floor-fired events are excluded regardless of once", () => {
    const ids = eligibleEvents(EVENTS, 1, [], ["yarnBall"]).map((e) => e.id);
    expect(ids).not.toContain("yarnBall");
  });

  it("weighted pick consumes exactly 1 draw and honors weights", () => {
    // floor-1 weights: 10, 8, 10, 8, 9 → total 45
    const lo = tracked(floatsRng([0]));
    const first = selectEvent(EVENTS, 1, [], [], lo);
    expect(first).toEqual({ kind: "event", event: ev("yarnBall") });
    expect(lo.log).toEqual(["int(1,45)"]);

    const hi = tracked(floatsRng([0.999]));
    const last = selectEvent(EVENTS, 1, [], [], hi);
    expect(last).toEqual({ kind: "event", event: ev("catnipPatch") });
    expect(hi.log).toEqual(["int(1,45)"]);
  });

  it("empty pool falls back to 15 + 8·floor shinies with zero draws", () => {
    const rng = tracked(mulberry32(1));
    const sel = selectEvent(EVENTS, 1, [], FLOOR1_IDS, rng);
    expect(sel.kind).toBe("fallback");
    if (sel.kind === "fallback") expect(sel.shinies).toBe(23);
    expect(rng.log).toEqual([]);

    const sel4 = selectEvent(
      EVENTS,
      4,
      [],
      EVENTS.map((e) => e.id),
      mulberry32(1),
    );
    if (sel4.kind === "fallback") expect(sel4.shinies).toBe(47);
  });
});

/* ------------------------------------------------------------------------ */
/* Draw order (§2.2) with instrumented Rng                                   */
/* ------------------------------------------------------------------------ */

describe("resolveOption draw order", () => {
  it("outcome roll then one int draw per `random` effect, in effect order", () => {
    const run = makeRun();
    // yarnBall option 0: outcomes weight 6/4; outcome 1 has damage:random
    // then buff:random → exactly [float, int(0,3), int(0,3)]
    const rng = tracked(floatsRng([0.99, 0, 0.9]));
    const out = resolveOption(run, ev("yarnBall"), 0, rng);
    expect(rng.log).toEqual(["float", "int(0,3)", "int(0,3)"]);
    expect(out.outcomeIndex).toBe(1);
    // two `random` effects may hit DIFFERENT cats (intended comedy):
    // damage (draw 0 → rank 1 Bruno, 4+1·1 = 5 dmg), debuff (draw 0.9 → rank 4)
    expect(out.state.cats[0].hp).toBe(CLASSES.bruiser.base.hp - 5);
    expect(out.state.cats[3].tempMods).toEqual([
      { stat: "spd", amount: -1, duration: "floor", sourceEventId: "yarnBall" },
    ]);
  });

  it("single-outcome options skip the outcome roll entirely", () => {
    const run = makeRun();
    const rng = tracked(mulberry32(7));
    const out = resolveOption(run, ev("yarnBall"), 2, rng); // walk-away
    expect(rng.log).toEqual([]);
    expect(out.outcomeIndex).toBe(0);
    expect(out.fightRequest).toBeNull();
  });

  it("deterministic: same seed → identical resolution", () => {
    const run = makeRun();
    const seed = hash("TEST", 1, "event", 0);
    const a = resolveOption(run, ev("yarnBall"), 0, mulberry32(seed));
    const b = resolveOption(run, ev("yarnBall"), 0, mulberry32(seed));
    expect(a).toEqual(b);
  });

  it("never mutates the input RunState", () => {
    const run = makeRun();
    const snapshot = JSON.parse(JSON.stringify(run)) as unknown;
    resolveOption(run, ev("yarnBall"), 0, mulberry32(42));
    expect(JSON.parse(JSON.stringify(run))).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------------ */
/* Clamps, caps, targets                                                     */
/* ------------------------------------------------------------------------ */

describe("effect clamps and targeting", () => {
  it("damage ignores def and clamps at 1 HP (never KOs)", () => {
    const run = makeRun({}, [{ hp: 3 }]); // Bruno at 3 HP
    const rng = floatsRng([0.99, 0, 0]); // outcome 1, both randoms → Bruno
    const out = resolveOption(run, ev("yarnBall"), 0, rng);
    expect(out.state.cats[0].hp).toBe(1); // 5 dmg wanted, 2 applied
    expect(out.results[0]).toEqual({
      text: `${NAME("bruiser")} -2 HP`,
      tone: "loss",
    });
  });

  it("heal caps at effective max HP and reports actual amounts", () => {
    const run = makeRun({}, [
      { hp: CLASSES.bruiser.base.hp - 4 },
      { hp: CLASSES.trickster.base.hp },
    ]);
    // suspiciousHuman option 0 outcome 0 (w55): heal party 8+1·1 = 9
    const out = resolveOption(run, ev("suspiciousHuman"), 0, floatsRng([0]));
    expect(out.state.cats[0].hp).toBe(CLASSES.bruiser.base.hp); // +4 only
    expect(out.state.cats[1].hp).toBe(CLASSES.trickster.base.hp); // +0
    expect(out.results[0]).toEqual({
      text: `${NAME("bruiser")} +4 HP`,
      tone: "gain",
    });
    expect(out.results[1]).toEqual({
      text: `${NAME("trickster")} +0 HP`,
      tone: "gain",
    });
  });

  it("lowestLives targeting picks the fewest-Lives cat below 9", () => {
    const run = makeRun({ floorNum: 3 }, [
      { lives: 9 },
      { lives: 7 },
      { lives: 8 },
      { lives: 9 },
    ]);
    run.inventory.shinies = 100;
    const rng = tracked(mulberry32(5));
    const out = resolveOption(run, ev("shrineOfNine"), 0, rng);
    expect(rng.log).toEqual([]); // single outcome, no random targets
    expect(out.state.inventory.shinies).toBe(10); // cost 60+10·3 = 90 paid
    expect(out.state.cats[1].lives).toBe(8); // Pixel, fewest below 9
    expect(out.results).toEqual([
      { text: "-90 ✦", tone: "loss" },
      { text: `${NAME("trickster")} regains 1 Life`, tone: "gain" },
    ]);
  });

  it("energyNextBattle accumulates and caps at +6 (start 4, cap 10)", () => {
    const run = makeRun();
    const eff = [
      { kind: "energyNextBattle", target: "party", amount: 5 } as const,
    ];
    const once = applyEventEffects(run, eff, "test", mulberry32(1));
    const twice = applyEventEffects(once.state, eff, "test", mulberry32(1));
    expect(once.state.cats.map((c) => c.energyNextBattle)).toEqual([
      5, 5, 5, 5,
    ]);
    expect(twice.state.cats.map((c) => c.energyNextBattle)).toEqual([
      6, 6, 6, 6,
    ]);
  });

  it("hpMax buffs raise current HP; expiry-style negative mods clamp it", () => {
    const run = makeRun();
    const up = applyEventEffects(
      run,
      [
        {
          kind: "buff",
          target: "party",
          stat: "hpMax",
          amount: 5,
          duration: "floor",
        },
      ],
      "test",
      mulberry32(1),
    );
    expect(up.state.cats[0].hp).toBe(CLASSES.bruiser.base.hp + 5);
    expect(effectiveMaxHp(up.state, 0)).toBe(CLASSES.bruiser.base.hp + 5);
    const down = applyEventEffects(
      up.state,
      [
        {
          kind: "buff",
          target: "party",
          stat: "hpMax",
          amount: -100,
          duration: "floor",
        },
      ],
      "test",
      mulberry32(1),
    );
    expect(effectiveMaxHp(down.state, 0)).toBe(1); // floors at 1
    expect(down.state.cats[0].hp).toBe(1); // clamped to new max
  });
});

/* ------------------------------------------------------------------------ */
/* Requirements: payment, gates, gateCat                                     */
/* ------------------------------------------------------------------------ */

describe("requirements and gateCat", () => {
  it("item requirement consumes the item when picked", () => {
    const run = makeRun({ floorNum: 2 });
    run.inventory.slots[0] = { defId: "tunaSnack", count: 2 };
    const out = resolveOption(run, ev("elderStray"), 0, mulberry32(1));
    expect(out.state.inventory.slots[0]).toEqual({
      defId: "tunaSnack",
      count: 1,
    });
    expect(out.results[0]).toEqual({
      text: `Used: ${CONSUMABLES.tunaSnack.name} ×1`,
      tone: "loss",
    });
    // party DEF buff attached to every living cat
    for (const cat of out.state.cats) {
      expect(cat.tempMods).toEqual([
        {
          stat: "def",
          amount: 1,
          duration: "floor",
          sourceEventId: "elderStray",
        },
      ]);
    }
    // input inventory untouched
    expect(run.inventory.slots[0]).toEqual({ defId: "tunaSnack", count: 2 });
  });

  it("item requirement unmet when the item is absent", () => {
    const run = makeRun({ floorNum: 2 });
    expect(isOptionAvailable(run, ev("elderStray").options[0])).toBe(false);
    run.inventory.slots[3] = { defId: "tunaSnack", count: 1 };
    expect(isOptionAvailable(run, ev("elderStray").options[0])).toBe(true);
  });

  it("class gates are free and resolve gateCat to that class's cat", () => {
    const run = makeRun({ floorNum: 2 });
    const out = resolveOption(run, ev("cursedPost"), 1, mulberry32(1)); // Hexer gate
    expect(out.state.inventory.shinies).toBe(50); // nothing paid
    expect(out.state.cats[2].tempMods).toEqual([
      { stat: "atk", amount: 1, duration: "run", sourceEventId: "cursedPost" },
    ]);
    expect(out.results).toEqual([
      { text: `${NAME("hexer")}: ATK +1 (this run)`, tone: "buff" },
    ]);
  });

  it("stat gates use best EFFECTIVE stat and gateCat is the best-stat cat", () => {
    const run = makeRun({ floorNum: 2 });
    // redDot option 1 requires crt >= 12: Pixel's base crt 15 qualifies
    expect(effectiveGateStat(run, 1, "crt")).toBe(15);
    expect(isOptionAvailable(run, ev("redDot").options[1])).toBe(true);
    const out = resolveOption(run, ev("redDot"), 1, mulberry32(1));
    expect(out.state.cats[1].tempMods).toEqual([
      { stat: "crt", amount: 5, duration: "run", sourceEventId: "redDot" },
    ]);
    expect(out.state.inventory.shinies).toBe(60); // +10 ✦
    expect(out.state.score.shiniesCollected).toBe(10);
  });

  it("temp mods fold into gate checks (equipment/buff unlocking)", () => {
    const run = makeRun();
    // perfectBox option 1 requires spd >= 8; Pixel base spd 8 → met
    expect(isOptionAvailable(run, ev("perfectBox").options[1])).toBe(true);
    run.cats[1].tempMods.push({
      stat: "spd",
      amount: -1,
      duration: "floor",
      sourceEventId: "x",
    });
    // best spd is now 7 → gate unmet
    expect(effectiveGateStat(run, 1, "spd")).toBe(7);
    expect(isOptionAvailable(run, ev("perfectBox").options[1])).toBe(false);
  });

  it("shinies gate: unmet when the wallet cannot cover the scaled cost", () => {
    const run = makeRun({ floorNum: 3 }, [{ lives: 8 }]);
    run.inventory.shinies = 89; // cost = 60 + 10·3 = 90
    expect(isOptionAvailable(run, ev("shrineOfNine").options[0])).toBe(false);
    run.inventory.shinies = 90;
    expect(isOptionAvailable(run, ev("shrineOfNine").options[0])).toBe(true);
  });

  it("restoreLife options gray out when every living cat is at 9 Lives", () => {
    const run = makeRun({ floorNum: 3 });
    run.inventory.shinies = 999;
    expect(isOptionAvailable(run, ev("shrineOfNine").options[0])).toBe(false);
    run.cats[3].lives = 6;
    expect(isOptionAvailable(run, ev("shrineOfNine").options[0])).toBe(true);
  });

  it("class gate requires the class cat to be alive", () => {
    const run = makeRun({ floorNum: 2 }, [{}, {}, { lives: 0 }]);
    run.marchingOrder = ["bruiser", "trickster", "medic"];
    expect(isOptionAvailable(run, ev("cursedPost").options[1])).toBe(false); // Hexer gone
  });

  it("resolveOption throws on an unavailable option", () => {
    const run = makeRun({ floorNum: 2 });
    expect(() =>
      resolveOption(run, ev("elderStray"), 0, mulberry32(1)),
    ).toThrow(/not available/);
  });
});

/* ------------------------------------------------------------------------ */
/* Fired-id bookkeeping & fightRequest handoff                               */
/* ------------------------------------------------------------------------ */

describe("fired-id bookkeeping and fights", () => {
  it("marks run + floor fired ids even on a pure `nothing` outcome", () => {
    const run = makeRun();
    const out = resolveOption(run, ev("yarnBall"), 2, mulberry32(1));
    expect(out.state.firedEventIds).toEqual(["yarnBall"]);
    expect(out.state.floorFiredEventIds).toEqual(["yarnBall"]);
    expect(run.firedEventIds).toEqual([]); // input untouched
  });

  it("hands the fight up unresolved; the tile is still spent", () => {
    const run = makeRun({ floorNum: 3 });
    const rng = tracked(mulberry32(9));
    const out = resolveOption(run, ev("dormantRoomba"), 0, rng);
    expect(rng.log).toEqual([]); // single outcome, no draws
    expect(out.fightRequest).toEqual({
      eventId: "dormantRoomba",
      encounter: ["roombaScout"],
      loot: "bonus",
      onWinEffects: [{ kind: "shinies", amount: { base: 25, perFloor: 5 } }],
      gateCatIndex: null,
    });
    // nothing resolved yet: wallet/hp unchanged, but the event is fired —
    // even if the upcoming fight is fled, curiosity spends the tile
    expect(out.state.inventory.shinies).toBe(50);
    expect(out.state.firedEventIds).toEqual(["dormantRoomba"]);
    expect(out.state.floorFiredEventIds).toEqual(["dormantRoomba"]);
  });

  it("pre-fight effects land before the fight is handed up (A Perfect Box)", () => {
    const run = makeRun({}, [{ hp: 20 }]);
    // option 0 outcomes weight 7/3 → float 0.75 ⇒ roll 7.5 ⇒ ambush outcome
    const out = resolveOption(run, ev("perfectBox"), 0, floatsRng([0.75]));
    expect(out.outcomeIndex).toBe(1);
    expect(out.state.cats[0].hp).toBe(31); // heal 10+1·1 = 11 landed first
    expect(out.fightRequest).toMatchObject({
      encounter: ["ratThug", "ratThug", "ratThug"],
      loot: "normal",
    });
  });

  it("onWinEffects apply later via applyEventEffects, continuing the stream", () => {
    const run = makeRun({ floorNum: 3 });
    const rng = mulberry32(hash("TEST", 3, "event", 0));
    const out = resolveOption(run, ev("dormantRoomba"), 0, rng);
    const win = applyEventEffects(
      out.state,
      out.fightRequest!.onWinEffects,
      out.fightRequest!.eventId,
      rng, // same instance: the eventRng sequence continues
      out.fightRequest!.gateCatIndex,
    );
    expect(win.state.inventory.shinies).toBe(50 + 25 + 5 * 3);
    expect(win.results).toEqual([{ text: "+40 ✦", tone: "gain" }]);
    expect(win.state.score.shiniesCollected).toBe(40);
  });
});

/* ------------------------------------------------------------------------ */
/* Items, shinies wallet, misc                                               */
/* ------------------------------------------------------------------------ */

describe("inventory and wallet effects", () => {
  it("giveItem stacks to 5 and reports what was received", () => {
    const run = makeRun();
    run.inventory.slots[0] = { defId: "tunaSnack", count: 4 };
    const out = applyEventEffects(
      run,
      [{ kind: "giveItem", item: "tunaSnack", count: 2 }],
      "test",
      mulberry32(1),
    );
    expect(out.state.inventory.slots[0]).toEqual({
      defId: "tunaSnack",
      count: 5,
    });
    expect(out.state.inventory.slots[1]).toEqual({
      defId: "tunaSnack",
      count: 1,
    });
    expect(out.results).toEqual([
      { text: `Received: ${CONSUMABLES.tunaSnack.name} ×2`, tone: "gain" },
    ]);
  });

  it("takeItem is a no-op when the item is absent", () => {
    const run = makeRun();
    const out = applyEventEffects(
      run,
      [{ kind: "takeItem", item: "catnip" }],
      "test",
      mulberry32(1),
    );
    expect(out.state.inventory.slots).toEqual(run.inventory.slots);
    expect(out.results).toEqual([]);
  });

  it("shinies losses clamp the wallet at 0", () => {
    const run = makeRun();
    run.inventory.shinies = 12;
    const out = applyEventEffects(
      run,
      [{ kind: "shinies", amount: -30 }],
      "test",
      mulberry32(1),
    );
    expect(out.state.inventory.shinies).toBe(0);
    expect(out.results).toEqual([{ text: "-12 ✦", tone: "loss" }]);
    expect(out.state.score.shiniesCollected).toBe(0); // losses never score
  });

  it("scalar resolution is base + perFloor·floor", () => {
    expect(resolveScalar(7, 4)).toBe(7);
    expect(resolveScalar({ base: 15, perFloor: 8 }, 1)).toBe(23);
    expect(resolveScalar({ base: 60, perFloor: 10 }, 3)).toBe(90);
  });

  it("milk bowl sniff: heal + party energy, with per-cat and party lines", () => {
    const run = makeRun({}, [{ hp: 10 }]);
    const rng = tracked(mulberry32(3));
    const out = resolveOption(run, ev("milkBowl"), 1, rng); // Medic gate
    expect(rng.log).toEqual([]); // single outcome, party targets: no draws
    expect(out.state.cats[0].hp).toBe(17); // heal 6+1·1 = 7
    expect(out.state.cats.map((c) => c.energyNextBattle)).toEqual([1, 1, 1, 1]);
    expect(out.results[out.results.length - 1]).toEqual({
      text: "Party: +1 Energy next battle",
      tone: "buff",
    });
  });
});
