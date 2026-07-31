/**
 * Balance rework — the rules from docs/design/balance-and-meta.md that are
 * numbers rather than pipeline steps.
 *
 *  §1  Off-Balance ×1.3, Braced, tier resistance, per-skill shove chances
 *  §2  variable party size: roster API, rank projection, Cat Pile at 2/3/4
 *  §3  the per-floor enemy curve (and the boss exclusion)
 *
 * The engine-pipeline half of the rework (draw order, event order, the §13
 * worked example) lives in combat.spec.ts. Nothing here asserts a number the
 * engine produced — every expectation is computed by hand from the doc.
 */
import { describe, expect, it } from "vitest";
import type {
  BattleSetup,
  BattleState,
  ClassId,
  Rng,
  TraitId,
} from "../src/core/types.js";
import { CLASSES } from "../src/content/classes.js";
import { SKILLS } from "../src/content/skills.js";
import { ENEMIES, OFF_BALANCE_RESIST_BY_TIER } from "../src/content/enemies.js";
import {
  curvedEnemyStats,
  ENEMY_CURVE,
  floorCurve,
  FLOORS,
} from "../src/content/floors.js";
import { createBattle } from "../src/core/combat/setup.js";
import {
  byId,
  canUseFrom,
  hasStatus,
  legalActions,
  living,
  OFF_BALANCE_MULT,
  offBalanceResistOf,
  projectedUsableFrom,
} from "../src/core/combat/state.js";
import { resolveAction } from "../src/core/combat/resolve.js";
import { startRound } from "../src/core/combat/turns.js";
import {
  applyStatus,
  BRACE_ON_CONSUME,
  BRACE_ON_EXPIRY,
  roundEndPhase,
} from "../src/core/combat/status.js";
import {
  benchedCats,
  canRecruit,
  DEFAULT_PARTY_CAPACITY,
  fieldedCats,
  MAX_PARTY_CAPACITY,
  newRun,
  partyCapacity,
  PARTY_ORDER,
  RECRUIT_FLOOR,
  recruitCat,
  STARTING_PARTY_SIZE,
} from "../src/core/run/runState.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

class ScriptedRng implements Rng {
  private i = 0;
  constructor(private rolls: number[]) {}
  float(): number {
    if (this.i >= this.rolls.length) {
      throw new Error(`ScriptedRng exhausted at draw ${this.i}`);
    }
    return this.rolls[this.i++];
  }
  int(lo: number, hi: number): number {
    const v = this.float();
    if (v < lo || v > hi || !Number.isInteger(v)) {
      throw new Error(`ScriptedRng: draw ${v} outside int(${lo},${hi})`);
    }
    return v;
  }
  get used(): number {
    return this.i;
  }
}

const noRng = new ScriptedRng([]);

function catsFor(order: readonly ClassId[]): BattleSetup["cats"] {
  return order.map((id) => {
    const cls = CLASSES[id];
    return {
      classId: id,
      name: cls.catName,
      stats: { ...cls.base },
      hp: cls.base.hp,
      lives: 9,
      skills: cls.skills
        .filter((s) => s.unlockLevel <= 1)
        .map((s) => s.skillId),
      traits: [] as TraitId[],
      hooks: [],
      startEnergyBonus: 0,
    };
  });
}

function battle(
  order: readonly ClassId[],
  enemies: string[],
  floor?: number,
): BattleState {
  return createBattle({
    cats: catsFor(order),
    enemies,
    encounterIndex: 1,
    canFlee: true,
    ...(floor !== undefined ? { floor } : {}),
  });
}

function setQueue(bs: BattleState, ids: string[]): void {
  bs.round = Math.max(1, bs.round);
  bs.queue = ids.map((id) => ({
    combatantId: id,
    initiative: 0,
    acted: false,
  }));
  bs.queueIndex = 0;
}

const ALL4: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

/* ================================================================== */
/* §1 — Off-Balance rework                                             */
/* ================================================================== */

describe("§1 Off-Balance multiplier", () => {
  it("is ×1.3, so crit × Off-Balance is ×1.95 and the ceiling is ×2.145", () => {
    expect(OFF_BALANCE_MULT).toBe(1.3);
    expect(1.5 * OFF_BALANCE_MULT).toBeCloseTo(1.95, 10);
    expect(1.1 * 1.5 * OFF_BALANCE_MULT).toBeCloseTo(2.145, 10);
  });

  it("applies to damage: Claw Swipe 12 × 1.3 = 15.6 → 16, − DEF 1 = 15", () => {
    const bs = battle(ALL4, ["ratThug"]);
    applyStatus(byId(bs, "e0:ratThug"), "offBalance");
    setQueue(bs, ["cat:trickster"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]), // variance ×1.0, no crit
    );
    const d = r.events.find((e) => e.t === "damage");
    expect(d).toMatchObject({ amount: 15, offBal: true, crit: false });
  });
});

describe("§1 Braced — the anti-lock rule", () => {
  it("blocks Off-Balance application outright", () => {
    const bs = battle(ALL4, ["ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    expect(applyStatus(rat, "braced", BRACE_ON_EXPIRY)).toBe(true);
    expect(applyStatus(rat, "offBalance")).toBe(false);
    expect(hasStatus(rat, "offBalance")).toBe(false);
  });

  it("is granted when Off-Balance expires at round end, and lasts the whole next round", () => {
    const bs = battle(ALL4, ["ratThug", "ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    applyStatus(rat, "offBalance");

    // round-end 1: Off-Balance expires, Braced (duration 1) is granted AFTER
    // the decrement pass, so it is not ticked on the round it was earned.
    roundEndPhase(bs, []);
    expect(hasStatus(rat, "offBalance")).toBe(false);
    expect(hasStatus(rat, "braced")).toBe(true);
    expect(applyStatus(rat, "offBalance")).toBe(false); // immune all next round

    // round-end 2: Braced ticks to 0 and goes.
    roundEndPhase(bs, []);
    expect(hasStatus(rat, "braced")).toBe(false);
    expect(applyStatus(rat, "offBalance")).toBe(true); // free again
  });

  it("a Cat Pile leaves survivors Braced for a full round (duration 2)", () => {
    const bs = battle(ALL4, ["yarnGolem", "ratThug"]);
    setQueue(bs, ["cat:trickster"]);
    for (const e of living(bs, "enemy")) applyStatus(e, "offBalance");
    const armed = resolveAction(bs, { type: "guard" }, noRng);
    expect(armed.state.catPilePrompt).toBe(true);

    const piled = resolveAction(
      armed.state,
      { type: "catPile", accept: true },
      noRng,
    );
    const golem = byId(piled.state, "e0:yarnGolem");
    expect(hasStatus(golem, "offBalance")).toBe(false);
    expect(hasStatus(golem, "braced")).toBe(true);
    // duration 2 survives THIS round's sweep and covers the next one
    roundEndPhase(piled.state, []);
    expect(hasStatus(golem, "braced")).toBe(true);
    roundEndPhase(piled.state, []);
    expect(hasStatus(golem, "braced")).toBe(false);
  });

  it("re-application keeps the longer duration and emits no second event", () => {
    const bs = battle(ALL4, ["ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    expect(applyStatus(rat, "braced", BRACE_ON_EXPIRY)).toBe(true);
    expect(applyStatus(rat, "braced", BRACE_ON_CONSUME)).toBe(false); // refresh only
    expect(rat.statuses.filter((s) => s.id === "braced")).toHaveLength(1);
    expect(rat.statuses.find((s) => s.id === "braced")!.duration).toBe(
      BRACE_ON_CONSUME,
    );
  });

  it("a boss Poise break BYPASSES Braced — §11.1 is untouched", () => {
    const bs = battle(ALL4, ["vacuumKing"]);
    const boss = byId(bs, "e0:vacuumKing");
    applyStatus(boss, "braced", BRACE_ON_CONSUME);
    boss.poise = 1; // one chip from a break
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:vacuumKing" },
      new ScriptedRng([1, 0.9]), // heavy target: the Off-Paw gate never rolls
    );
    const after = byId(r.state, "e0:vacuumKing");
    expect(r.events.some((e) => e.t === "poiseBreak")).toBe(true);
    expect(hasStatus(after, "offBalance")).toBe(true);
    expect(hasStatus(after, "braced")).toBe(false); // stripped by the break
  });
});

describe("§1 tier resistance", () => {
  it("is 0 / 25% / 40% by tier, and cats and bosses never resist", () => {
    expect(OFF_BALANCE_RESIST_BY_TIER).toEqual({ 1: 0, 2: 0.25, 3: 0.4 });
    const bs = battle(ALL4, ["ratThug", "roombaScout", "trashPanda"]);
    expect(offBalanceResistOf(byId(bs, "e0:ratThug"))).toBe(0); // T1
    expect(offBalanceResistOf(byId(bs, "e1:roombaScout"))).toBe(0.25); // T2
    expect(offBalanceResistOf(byId(bs, "e2:trashPanda"))).toBe(0.4); // T3
    expect(offBalanceResistOf(byId(bs, "cat:bruiser"))).toBe(0);
    const boss = battle(ALL4, ["vacuumKing"]);
    expect(offBalanceResistOf(byId(boss, "e0:vacuumKing"))).toBe(0);
  });

  it("a tier-2 enemy shrugs the shove off on a roll under 0.25", () => {
    const bs = battle(ALL4, ["roombaScout", "ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    // variance, crit, Body Slam's 0.7 gate (0.3 lands), tier roll 0.10 < 0.25
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:roombaScout" },
      new ScriptedRng([1, 0.9, 0.3, 0.1]),
    );
    const scout = byId(r.state, "e0:roombaScout");
    expect(scout.rank).toBe(2); // it still MOVED — only the debuff was denied
    expect(hasStatus(scout, "offBalance")).toBe(false);
    expect(
      r.events.some(
        (e) => e.t === "log" && e.text.includes("keeps its footing"),
      ),
    ).toBe(true);
  });

  it("the same shove lands on a roll at or above 0.25", () => {
    const bs = battle(ALL4, ["roombaScout", "ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:roombaScout" },
      new ScriptedRng([1, 0.9, 0.3, 0.25]),
    );
    expect(hasStatus(byId(r.state, "e0:roombaScout"), "offBalance")).toBe(true);
  });
});

describe("§1 per-skill shove chances", () => {
  it("prices cheap shoves at 0.6-0.8 and keeps the expensive ones at 1.0", () => {
    const chance = (id: string): number => SKILLS[id].offBalanceChance ?? 1.0;
    // cheap single-target
    expect(chance("scruffToss")).toBe(0.6);
    expect(chance("yankOfYarn")).toBe(0.6);
    expect(chance("bodySlam")).toBe(0.7);
    // row setup — the Cat Pile enablers
    expect(chance("tripWire")).toBe(0.8);
    expect(chance("snarlOfThreads")).toBe(0.8);
    // expensive: the guarantee is what the energy buys
    for (const id of ["dumpsterDunk", "trashCompactor", "fullUnravel"]) {
      expect(chance(id)).toBe(1.0);
      expect(SKILLS[id].cost).toBeGreaterThanOrEqual(6);
    }
    // symmetric: enemy mook shoves pay the same tax against cats
    for (const id of ["ram", "bite", "lidBash", "grizzledCuff"]) {
      expect(chance(id)).toBe(0.7);
    }
  });

  it("every shove chance sits in [0.6, 1.0] and only moveTarget skills carry one", () => {
    for (const sk of Object.values(SKILLS)) {
      if (sk.offBalanceChance === undefined) continue;
      expect(
        sk.moveTarget,
        `${sk.id} has a chance but no moveTarget`,
      ).toBeTruthy();
      expect(sk.offBalanceChance).toBeGreaterThanOrEqual(0.6);
      expect(sk.offBalanceChance).toBeLessThanOrEqual(1.0);
    }
  });

  it("a failed chance roll moves the target but denies the debuff", () => {
    const bs = battle(ALL4, ["ratThug", "ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    // 0.8 ≥ bodySlam's 0.7 → the gate fails; tier 1, so no resist roll follows
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9, 0.8]),
    );
    const rat = byId(r.state, "e0:ratThug");
    expect(rat.rank).toBe(2);
    expect(hasStatus(rat, "offBalance")).toBe(false);
  });

  it("draws NOTHING when the application could not have landed anyway", () => {
    const bs = battle(ALL4, ["ratThug", "ratThug"]);
    applyStatus(byId(bs, "e0:ratThug"), "braced", BRACE_ON_EXPIRY);
    setQueue(bs, ["cat:bruiser"]);
    // variance + crit only: a Braced target costs zero entropy
    const rng = new ScriptedRng([1, 0.9]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:ratThug" },
      rng,
    );
    expect(rng.used).toBe(2);
    expect(hasStatus(byId(r.state, "e0:ratThug"), "offBalance")).toBe(false);
  });
});

/* ================================================================== */
/* §2 — variable party size                                            */
/* ================================================================== */

describe("§2 rank projection", () => {
  it("clamps usableFrom onto the living formation, and is a no-op at full size", () => {
    const back = SKILLS.soothingPurr; // [3,4]
    expect(projectedUsableFrom(back, 4)).toEqual([3, 4]);
    expect(projectedUsableFrom(back, 3)).toEqual([3]);
    expect(projectedUsableFrom(back, 2)).toEqual([2]);
    expect(projectedUsableFrom(back, 1)).toEqual([1]);
    const front = SKILLS.clawSwipe; // [1,2]
    expect(projectedUsableFrom(front, 4)).toEqual([1, 2]);
    expect(projectedUsableFrom(front, 2)).toEqual([1, 2]);
    expect(projectedUsableFrom(front, 1)).toEqual([1]);
  });

  it("lets a 2-cat Medic heal from the back rank — she could not before", () => {
    const bs = battle(["bruiser", "medic"], ["ratThug"]);
    const medic = byId(bs, "cat:medic");
    expect(medic.rank).toBe(2);
    expect(canUseFrom(bs, medic, SKILLS.soothingPurr)).toBe(true);
    expect(canUseFrom(bs, medic, SKILLS.nineLivesNudge)).toBe(true);
    setQueue(bs, ["cat:medic"]);
    expect(
      legalActions(bs).skills.find((s) => s.skillId === "soothingPurr")?.ok,
    ).toBe(true);
  });

  it("still denies rank: a 2-cat Medic shoved to the FRONT loses her kit", () => {
    const bs = battle(["bruiser", "medic"], ["ratThug"]);
    const medic = byId(bs, "cat:medic");
    const bruno = byId(bs, "cat:bruiser");
    medic.rank = 1;
    bruno.rank = 2;
    expect(canUseFrom(bs, medic, SKILLS.soothingPurr)).toBe(false);
  });

  it("a lone survivor can use its whole kit (it is its own back line)", () => {
    const bs = battle(ALL4, ["ratThug"]);
    for (const id of ["cat:bruiser", "cat:trickster", "cat:hexer"]) {
      const c = byId(bs, id);
      c.ko = true;
      c.hp = 0;
    }
    const medic = byId(bs, "cat:medic");
    medic.rank = 1;
    expect(canUseFrom(bs, medic, SKILLS.nineLivesNudge)).toBe(true);
  });
});

describe("§2 combat works at party size 2, 3 and 4", () => {
  for (const size of [2, 3, 4] as const) {
    it(`runs a full round with ${size} cats and compresses ranks correctly`, () => {
      const order = ALL4.slice(0, size);
      let bs = battle(order, ["ratThug", "ratThug"]);
      expect(living(bs, "cat").map((c) => c.rank)).toEqual(
        Array.from({ length: size }, (_, i) => i + 1),
      );
      const rng = new ScriptedRng(
        Array.from({ length: size + 2 }, () => 1), // initiative draws
      );
      bs = startRound(bs, rng).state;
      expect(bs.queue).toHaveLength(size + 2);
      // every cat has at least one legal action from wherever it stands
      for (const c of living(bs, "cat")) {
        const usable = c.skills.filter((id) => canUseFrom(bs, c, SKILLS[id]));
        expect(usable.length, `${c.id} has no usable skill`).toBeGreaterThan(0);
      }
    });
  }

  it("Cat Pile needs 2 living cats: fires at 2, never at 1", () => {
    const two = battle(["bruiser", "trickster"], ["ratThug", "ratThug"]);
    setQueue(two, ["cat:bruiser"]);
    for (const e of living(two, "enemy")) applyStatus(e, "offBalance");
    expect(
      resolveAction(two, { type: "guard" }, noRng).state.catPilePrompt,
    ).toBe(true);

    const one = battle(["bruiser", "trickster"], ["ratThug", "ratThug"]);
    const pixel = byId(one, "cat:trickster");
    pixel.ko = true;
    pixel.hp = 0;
    setQueue(one, ["cat:bruiser"]);
    for (const e of living(one, "enemy")) applyStatus(e, "offBalance");
    expect(
      resolveAction(one, { type: "guard" }, noRng).state.catPilePrompt,
    ).toBe(false);
  });

  it("Cat Pile damage scales with the cats actually fielded", () => {
    // floor(0.30 × Σ atk); bases 10 / 12 / 11 / 9
    const expected = (order: ClassId[]): number =>
      Math.floor(0.3 * order.reduce((s, id) => s + CLASSES[id].base.atk, 0));
    for (const size of [2, 3, 4] as const) {
      const order = ALL4.slice(0, size);
      const bs = battle(order, ["ratThug", "ratThug"]);
      setQueue(bs, ["cat:bruiser"]);
      for (const e of living(bs, "enemy")) applyStatus(e, "offBalance");
      const r = resolveAction(bs, { type: "guard" }, noRng);
      const prompt = r.events.find((e) => e.t === "catPilePrompt");
      expect(prompt).toMatchObject({ damageEach: expected(order) });
    }
    expect(expected(ALL4)).toBe(12); // §13 postscript, unchanged
    expect(expected(["bruiser", "trickster"])).toBe(6);
  });
});

describe("§2 roster API", () => {
  it("a fresh run fields exactly two cats but keeps all four slots", () => {
    const run = newRun("MEOW-1987");
    expect(run.cats.map((c) => c.classId)).toEqual(PARTY_ORDER);
    expect(run.marchingOrder).toHaveLength(STARTING_PARTY_SIZE);
    expect(run.marchingOrder[0]).toBe("bruiser");
    expect(fieldedCats(run)).toHaveLength(2);
    expect(benchedCats(run)).toHaveLength(2);
  });

  it("the starting pair is deterministic per seed and varies across seeds", () => {
    expect(newRun("A").marchingOrder).toEqual(newRun("A").marchingOrder);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(newRun(`S${i}`).marchingOrder[1]);
    expect(seen.size).toBeGreaterThan(1); // not a constant
    expect(seen.has("bruiser")).toBe(false); // Bruno never doubles up
  });

  it("recruitCat adds one cat at full HP and respects the capacity", () => {
    let run = newRun("RECRUIT-1");
    expect(partyCapacity(run)).toBe(DEFAULT_PARTY_CAPACITY);
    expect(canRecruit(run)).toBe(true);

    const out = recruitCat(run);
    expect(out.recruited).not.toBeNull();
    run = out.run;
    expect(run.marchingOrder).toHaveLength(3);
    expect(canRecruit(run)).toBe(false); // capacity 3 is full

    // a full roster is a no-op, not an error
    const again = recruitCat(run);
    expect(again.recruited).toBeNull();
    expect(again.run).toBe(run);
  });

  it("Cat Town's fourth slot is just a bigger capacity", () => {
    let run = newRun("TOWN-1", undefined, {
      partyCapacity: MAX_PARTY_CAPACITY,
    });
    expect(partyCapacity(run)).toBe(4);
    run = recruitCat(run).run;
    run = recruitCat(run).run;
    expect(run.marchingOrder).toHaveLength(4);
    expect(canRecruit(run)).toBe(false);
    expect(new Set(run.marchingOrder).size).toBe(4);
  });

  it("an explicit roster overrides the seeded draw", () => {
    const run = newRun("X", undefined, {
      roster: ["bruiser", "hexer", "medic"],
      partyCapacity: 3,
    });
    expect(run.marchingOrder).toEqual(["bruiser", "hexer", "medic"]);
    expect(benchedCats(run).map((c) => c.classId)).toEqual(["trickster"]);
  });

  it("RECRUIT_FLOOR is a mid-run floor, not the start or the end", () => {
    expect(RECRUIT_FLOOR).toBeGreaterThan(1);
    expect(RECRUIT_FLOOR).toBeLessThan(FLOORS.length);
  });
});

/* ================================================================== */
/* §3 — the difficulty curve                                           */
/* ================================================================== */

describe("§3 enemy stat curve", () => {
  it("has one row per floor and never regresses", () => {
    expect(ENEMY_CURVE).toHaveLength(FLOORS.length);
    expect(ENEMY_CURVE[0]).toEqual({
      hpMult: 1.0,
      atkMult: 1.0,
      defAdd: 0,
      spdAdd: 0,
      crtAdd: 0,
    });
    for (let i = 1; i < ENEMY_CURVE.length; i++) {
      const prev = ENEMY_CURVE[i - 1];
      const row = ENEMY_CURVE[i];
      expect(row.hpMult).toBeGreaterThanOrEqual(prev.hpMult);
      expect(row.atkMult).toBeGreaterThanOrEqual(prev.atkMult);
      expect(row.defAdd).toBeGreaterThanOrEqual(prev.defAdd);
      expect(row.spdAdd).toBeGreaterThanOrEqual(prev.spdAdd);
      expect(row.crtAdd).toBeGreaterThanOrEqual(prev.crtAdd);
    }
    // flat DEF is subtracted off EVERY hit, so it stays tiny by design
    expect(Math.max(...ENEMY_CURVE.map((r) => r.defAdd))).toBeLessThanOrEqual(
      1,
    );
  });

  it("clamps out-of-range floors to the end rows", () => {
    expect(floorCurve(0)).toBe(ENEMY_CURVE[0]);
    expect(floorCurve(1)).toBe(ENEMY_CURVE[0]);
    expect(floorCurve(99)).toBe(ENEMY_CURVE[ENEMY_CURVE.length - 1]);
  });

  it("scales a Rat Thug by hand: floor 6 is hp 18×1.32→24, atk 7×1.30→9", () => {
    const base = ENEMIES.ratThug.stats;
    expect(base.hp).toBe(18);
    expect(base.atk).toBe(7);
    const f6 = curvedEnemyStats(base, 6);
    expect(f6.hp).toBe(24); // 18 × 1.32 = 23.76 → 24
    expect(f6.atk).toBe(9); // 7 × 1.30 = 9.10 → 9
    expect(f6.def).toBe(base.def + 1);
    expect(f6.spd).toBe(base.spd + 1);
    expect(f6.crt).toBe(base.crt + 5);
    // floor 1 is the identity row
    expect(curvedEnemyStats(base, 1)).toEqual(base);
  });

  it("createBattle applies the curve, and omitting `floor` means floor 1", () => {
    const f1 = battle(ALL4, ["ratThug"], 1);
    const f6 = battle(ALL4, ["ratThug"], 6);
    const none = battle(ALL4, ["ratThug"]);
    expect(byId(f1, "e0:ratThug").stats.hp).toBe(18);
    expect(byId(f6, "e0:ratThug").stats.hp).toBe(24);
    expect(byId(f6, "e0:ratThug").hp).toBe(24); // current HP follows max
    expect(byId(none, "e0:ratThug").stats).toEqual(
      byId(f1, "e0:ratThug").stats,
    );
  });

  it("NEVER curves a boss — §11 pacing depends on the authored block", () => {
    for (const floor of [1, 3, 6]) {
      const bs = battle(ALL4, ["vacuumKing"], floor);
      const boss = byId(bs, "e0:vacuumKing");
      expect(boss.stats).toEqual(ENEMIES.vacuumKing.stats);
      expect(boss.hp).toBe(140);
      expect(boss.poiseMax).toBe(3);
    }
    const dog = battle(ALL4, ["dogfather"], 6);
    expect(byId(dog, "e0:dogfather").stats).toEqual(ENEMIES.dogfather.stats);
  });
});

describe("§3 encounter budgets retuned for the two-cat opening", () => {
  it("rises monotonically and starts small enough for two cats", () => {
    for (const f of FLOORS) expect(f.budgetLo).toBeLessThanOrEqual(f.budgetHi);
    const los = FLOORS.map((f) => f.budgetLo);
    for (let i = 1; i < los.length; i++) {
      expect(los[i]).toBeGreaterThanOrEqual(los[i - 1]);
    }
    // floor 1 must be affordable by a 2-cat party: at most ~4 tier-1 bodies
    expect(FLOORS[0].budgetHi).toBeLessThanOrEqual(4);
  });
});
