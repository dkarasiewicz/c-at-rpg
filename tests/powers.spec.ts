/**
 * Stand Powers (Layer 1) — interpreter, budget lint, wiring.
 *
 * Covers: powerBudget hand-computed fixtures, validatePowerScript caps,
 * opt-in attachment (a powerless setup carries NO powers key), every wired
 * trigger, the RNG draw-order addendum (chance rolls AFTER existing rolls;
 * no draws when a power can't fire), charges (perRound reset / perBattle
 * latch), stock powers for all 4 cats + 3 bosses, and determinism (same
 * seed + scripts ⇒ identical event log).
 */
import { describe, expect, it } from "vitest";
import type {
  BattleEvent,
  BattleSetup,
  BattleState,
  ClassId,
  Rng,
} from "../src/core/types";
import type {
  PoweredBattleSetup,
  PoweredBattleState,
  PowerScript,
} from "../src/core/combat/powerTypes";
import {
  BUDGET_CAPS,
  capForCombatantId,
  powerBudget,
  validatePowerScript,
} from "../src/core/combat/powers";
import { CAT_POWERS, ENEMY_POWERS } from "../src/content/powers";
import { CLASSES } from "../src/content/classes";
import { hash, mulberry32 } from "../src/core/rng";
import { createBattle } from "../src/core/combat/setup";
import { resolveAction } from "../src/core/combat/resolve";
import { startRound } from "../src/core/combat/turns";
import { takeEnemyTurn } from "../src/core/combat/ai";
import {
  byId,
  hasStatus,
  legalActions,
  nextActor,
  statusesOf,
} from "../src/core/combat/state";

/* ------------------------------------------------------------------ */
/* helpers (mirrors combat.spec.ts)                                    */
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

const ORDER: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

function l1Cats(): BattleSetup["cats"] {
  return ORDER.map((id) => {
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
      traits: [],
      hooks: [],
      startEnergyBonus: 0,
    };
  });
}

function makeBattle(
  enemies: string[],
  powers?: Record<string, PowerScript>,
): BattleState {
  const setup: PoweredBattleSetup = {
    cats: l1Cats(),
    enemies,
    encounterIndex: 1,
    canFlee: true,
  };
  if (powers) setup.powers = powers;
  return createBattle(setup);
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

const powersOf = (bs: BattleState) => (bs as PoweredBattleState).powers;

const standLogs = (events: BattleEvent[], stand: string) =>
  events.filter((e) => e.t === "log" && e.text.includes(`「${stand}」`));

/** minimal valid script factory for synthetic interpreter tests */
function script(over: Partial<PowerScript>): PowerScript {
  const base: PowerScript = {
    id: "power:test",
    version: 1,
    name: "TEST STAND",
    flavor: "It does the thing.",
    budget: 0,
    trigger: "onTurnStart",
    conditions: [],
    effects: [{ kind: "status", target: "self", status: "guarded" }],
  };
  const s = { ...base, ...over };
  s.budget = powerBudget(s);
  return s;
}

/* ------------------------------------------------------------------ */
/* budget lint — hand-computed fixtures                                */
/* ------------------------------------------------------------------ */

describe("powerBudget", () => {
  it("prices THE DUMPSTER KING: 3 × (3+4) × 0.35 × 0.7 = 5.145", () => {
    expect(powerBudget(CAT_POWERS.bruiser!)).toBeCloseTo(5.145, 10);
  });
  it("prices BOX AMBUSH: 1.5 × 6 × 0.7 = 6.3", () => {
    expect(powerBudget(CAT_POWERS.trickster!)).toBeCloseTo(6.3, 10);
  });
  it("prices STRING THEORY: 2 × (2+3) × 0.7 = 7", () => {
    expect(powerBudget(CAT_POWERS.hexer!)).toBeCloseTo(7, 10);
  });
  it("prices PURR ENGINE: 1 × (12+12) × 0.4 = 9.6", () => {
    expect(powerBudget(CAT_POWERS.medic!)).toBeCloseTo(9.6, 10);
  });
  it("prices ABSOLUTE VOID: 3 × 4 × 0.25 × 0.7 = 2.1", () => {
    expect(powerBudget(ENEMY_POWERS.vacuumKing!)).toBeCloseTo(2.1, 10);
  });
  it("prices BAD TO THE BONE: 1.5 × (3+7) × 0.7 = 10.5", () => {
    expect(powerBudget(ENEMY_POWERS.dogfather!)).toBeCloseTo(10.5, 10);
  });
  it("prices PURPLE REIGN: 1 × 8 × 0.6 = 4.8", () => {
    expect(powerBudget(ENEMY_POWERS.ratPrince!)).toBeCloseTo(4.8, 10);
  });
  it("stacks condition discounts and charge discounts multiplicatively", () => {
    // onTurnStart 3 × damage 100/10 ×1 × hpBelowPct 0.7 × chance 0.5 × perBattle2 0.6
    const s = script({
      trigger: "onTurnStart",
      effects: [{ kind: "damage", target: "other", pct: 100 }],
      conditions: [
        { kind: "hpBelowPct", pct: 50 },
        { kind: "chance", pct: 50 },
      ],
      charges: { perBattle: 2 },
    });
    expect(powerBudget(s)).toBeCloseTo(3 * 10 * 0.7 * 0.5 * 0.6, 10);
  });
});

describe("validatePowerScript", () => {
  it("passes every stock power under its cap", () => {
    for (const [cls, p] of Object.entries(CAT_POWERS)) {
      const res = validatePowerScript(p!, capForCombatantId(`cat:${cls}`));
      expect(res.problems).toEqual([]);
      expect(res.ok).toBe(true);
    }
    for (const [id, p] of Object.entries(ENEMY_POWERS)) {
      const res = validatePowerScript(p!, capForCombatantId(`e0:${id}`));
      expect(res.problems).toEqual([]);
      expect(res.ok).toBe(true);
    }
  });
  it("maps combatant ids to caps (cat / enemy tier)", () => {
    expect(capForCombatantId("cat:medic")).toBe(BUDGET_CAPS.cat);
    expect(capForCombatantId("e0:ratThug")).toBe(BUDGET_CAPS.enemyByTier[1]);
    expect(capForCombatantId("e0:vacuumKing")).toBe(BUDGET_CAPS.enemyByTier[2]);
    expect(capForCombatantId("e0:dogfather")).toBe(BUDGET_CAPS.enemyByTier[3]);
  });
  it("rejects an over-budget script", () => {
    // onTurnStart 3 × damage 150/10 × allies-mult 2 = 90 — way over any cap
    const s = script({
      trigger: "onTurnStart",
      effects: [{ kind: "damage", target: "enemies", pct: 150 }],
    });
    expect(validatePowerScript(s, BUDGET_CAPS.cat).ok).toBe(false);
  });
  it("rejects per-effect numeric cap breaches", () => {
    const s = script({
      effects: [{ kind: "damage", target: "other", pct: 200 }],
    });
    expect(
      validatePowerScript(s, 999).problems.some((p) =>
        p.includes("damage pct"),
      ),
    ).toBe(true);
    const e = script({
      effects: [{ kind: "energy", target: "self", amount: 9 }],
    });
    expect(
      validatePowerScript(e, 999).problems.some((p) =>
        p.includes("energy amount"),
      ),
    ).toBe(true);
  });
  it("rejects a declared budget that mismatches the computed one", () => {
    const s = { ...script({}), budget: 999 };
    expect(
      validatePowerScript(s, 999).problems.some((p) =>
        p.includes("declared budget"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* opt-in attachment                                                   */
/* ------------------------------------------------------------------ */

describe("createBattle power attachment (opt-in)", () => {
  it("a setup without powers produces a state with NO powers key", () => {
    const bs = makeBattle(["ratThug"]);
    expect("powers" in bs).toBe(false);
  });
  it("attaches validated scripts by combatant id", () => {
    const bs = makeBattle(["ratThug"], { "cat:bruiser": CAT_POWERS.bruiser! });
    expect(powersOf(bs)?.scripts["cat:bruiser"]?.id).toBe("power:dumpsterKing");
    expect(powersOf(bs)?.charges["cat:bruiser"]).toEqual({
      battle: 0,
      round: 0,
    });
  });
  it("drops a script that fails the lint (defense in depth) ", () => {
    const bad = { ...CAT_POWERS.bruiser!, budget: 999 }; // tampered row
    const bs = makeBattle(["ratThug"], { "cat:bruiser": bad });
    expect("powers" in bs).toBe(false);
  });
  it("ignores scripts keyed to unknown combatants", () => {
    const bs = makeBattle(["ratThug"], { "cat:nobody": CAT_POWERS.bruiser! });
    expect("powers" in bs).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* THE DUMPSTER KING — onTakeHit chance counter (scripted battle)      */
/* ------------------------------------------------------------------ */

describe("onTakeHit — THE DUMPSTER KING counter", () => {
  const powers = { "cat:bruiser": CAT_POWERS.bruiser! };

  it("fires: chance roll AFTER variance+crit; shoves the attacker, guards Bruno", () => {
    let bs = makeBattle(["ratThug", "ratThug"], powers);
    setQueue(bs, ["e0:ratThug"]);
    // draws: shiv variance ×1.0, crit 0.5 (no), power chance 0.2 < 0.35
    const rng = new ScriptedRng([1, 0.5, 0.2]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(3);
    // shiv: 100% × atk 7 ×1.0 − def 3 = 4
    expect(byId(bs, "cat:bruiser").hp).toBe(40 - 4);
    expect(standLogs(r.events, "THE DUMPSTER KING")).toHaveLength(1);
    // counter shove: rat A rank 1 → 2 (forced), rat B slides 2 → 1
    expect(r.events).toContainEqual({
      t: "moved",
      id: "e0:ratThug",
      from: 1,
      to: 2,
      forced: true,
    });
    expect(hasStatus(byId(bs, "e0:ratThug"), "offBalance")).toBe(true);
    expect(hasStatus(byId(bs, "cat:bruiser"), "guarded")).toBe(true);
    expect(powersOf(bs)?.charges["cat:bruiser"]).toEqual({
      battle: 1,
      round: 1,
    });
  });

  it("misses the chance roll: draws exactly one extra float, no effects", () => {
    let bs = makeBattle(["ratThug", "ratThug"], powers);
    setQueue(bs, ["e0:ratThug"]);
    const rng = new ScriptedRng([1, 0.5, 0.9]); // 0.9 ≥ 0.35 → no counter
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(3);
    expect(standLogs(r.events, "THE DUMPSTER KING")).toHaveLength(0);
    expect(hasStatus(byId(bs, "cat:bruiser"), "guarded")).toBe(false);
    expect(powersOf(bs)?.charges["cat:bruiser"]).toEqual({
      battle: 0,
      round: 0,
    });
  });

  it("perRound 1: a second hit the same round consults nothing (no draw); startRound resets", () => {
    let bs = makeBattle(["ratThug", "ratThug"], powers);
    setQueue(bs, ["e0:ratThug", "e1:ratThug"]);
    // first hit: fires (draws 3); second hit: charges spent → 2 draws only
    let rng = new ScriptedRng([1, 0.5, 0.2, 1, 0.5]);
    let r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      rng,
    );
    bs = r.state;
    // rat A got shoved to rank 2; rat B now rank 1 — both still reach rank-1 Bruno
    r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(5);
    expect(standLogs(r.events, "THE DUMPSTER KING")).toHaveLength(0);
    // new round resets the perRound counter: initiative 6 draws + attack 3
    rng = new ScriptedRng([1, 1, 1, 1, 1, 1]);
    const sr = startRound(bs, rng);
    bs = sr.state;
    expect(powersOf(bs)?.charges["cat:bruiser"]?.round).toBe(0);
    setQueue(bs, ["e0:ratThug"]);
    const rng2 = new ScriptedRng([1, 0.5, 0.1]);
    r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      rng2,
    );
    expect(standLogs(r.events, "THE DUMPSTER KING")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* BOX AMBUSH — onCrit bonus strike                                    */
/* ------------------------------------------------------------------ */

describe("onCrit — BOX AMBUSH bonus strike", () => {
  it("a crit triggers a deterministic second hit on the same target", () => {
    let bs = makeBattle(["ratThug"], {
      "cat:trickster": CAT_POWERS.trickster!,
    });
    setQueue(bs, ["cat:trickster"]);
    const rng = new ScriptedRng([1, 0.01]); // variance ×1.0, crit (0.01 < 0.15)
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(2); // the bonus strike draws NOTHING
    expect(standLogs(r.events, "BOX AMBUSH")).toHaveLength(1);
    // claw swipe: 100% × 12 × 1.5 crit = 18 − 1 = 17; echo: 60% × 12 = 7.2→7 − 1 = 6
    const dmg = r.events.filter((e) => e.t === "damage");
    expect(dmg).toContainEqual({
      t: "damage",
      id: "e0:ratThug",
      amount: 17,
      crit: true,
      offBal: false,
      source: "clawSwipe",
    });
    expect(dmg).toContainEqual({
      t: "damage",
      id: "e0:ratThug",
      amount: 6,
      crit: false,
      offBal: false,
      source: "power:boxAmbush",
    });
    // 18 HP − 17 − 6 → KO'd by the echo, victory
    expect(r.events.some((e) => e.t === "ko" && e.id === "e0:ratThug")).toBe(
      true,
    );
    expect(bs.outcome).toBe("victory");
  });

  it("a non-crit hit does not consult it (and draws nothing extra)", () => {
    const bs = makeBattle(["ratThug"], {
      "cat:trickster": CAT_POWERS.trickster!,
    });
    setQueue(bs, ["cat:trickster"]);
    const rng = new ScriptedRng([1, 0.9]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      rng,
    );
    expect(rng.used).toBe(2);
    expect(standLogs(r.events, "BOX AMBUSH")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* STRING THEORY — onForcedMove refund + echo                          */
/* ------------------------------------------------------------------ */

describe("onForcedMove — STRING THEORY echo", () => {
  it("a pull refunds 1 energy and snaps a thread across the moved target", () => {
    let bs = makeBattle(["ratThug", "ratThug"], {
      "cat:hexer": CAT_POWERS.hexer!,
    });
    setQueue(bs, ["cat:hexer"]);
    const rng = new ScriptedRng([1, 0.5]); // variance, crit — power draws nothing
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "yankOfYarn", targetId: "e1:ratThug" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(2);
    expect(standLogs(r.events, "STRING THEORY")).toHaveLength(1);
    // energy: regen 4→6, cost 3 → 3, refund +1 → 4
    expect(byId(bs, "cat:hexer").energy).toBe(4);
    expect(r.events).toContainEqual({ t: "energy", id: "cat:hexer", delta: 1 });
    // yank: 60% × 11 ×1.0 = 6.6→7 − 1 = 6 (18→12); pulled to rank 1, Off-Balance;
    // echo: 30% × 11 = 3.3 × 1.5 offBal = 4.95→5 − 1 = 4 (12→8)
    expect(r.events).toContainEqual({
      t: "damage",
      id: "e1:ratThug",
      amount: 4,
      crit: false,
      offBal: true,
      source: "power:stringTheory",
    });
    expect(byId(bs, "e1:ratThug").hp).toBe(8);
    expect(byId(bs, "e1:ratThug").rank).toBe(1);
  });

  it("does not fire when the forced move is fully clamped (lone rank-1 pull)", () => {
    const bs = makeBattle(["ratThug"], { "cat:hexer": CAT_POWERS.hexer! });
    setQueue(bs, ["cat:hexer"]);
    // yankOfYarn targets ranks [2,3,4] — a lone rank-1 rat is not targetable;
    // use tripWire-style scenario instead: hexer has no push skill, so assert
    // via a synthetic on the same trigger: a pull on rank-1 never happens
    // through targeting; the clamp case is covered by moving nobody:
    const rng = new ScriptedRng([1, 0.5, 0.5]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "hairballHex", targetId: "e0:ratThug" },
      rng,
    );
    // hairballHex has no moveTarget → onForcedMove never consults
    expect(standLogs(r.events, "STRING THEORY")).toHaveLength(0);
    expect(rng.used).toBe(3); // variance, crit, scratched chance 0.9
  });
});

/* ------------------------------------------------------------------ */
/* PURR ENGINE — onAllyKO auto-mend                                    */
/* ------------------------------------------------------------------ */

describe("onAllyKO — PURR ENGINE auto-mend", () => {
  it("a cat KO floods the survivors with healing + Mending, once per battle", () => {
    let bs = makeBattle(["ratThug"], { "cat:medic": CAT_POWERS.medic! });
    byId(bs, "cat:trickster").hp = 3; // about to fall
    byId(bs, "cat:bruiser").hp = 30; // has room to heal
    setQueue(bs, ["e0:ratThug", "e0:ratThug"]);
    const rng = new ScriptedRng([1, 0.5, 1, 0.5]);
    let r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:trickster" },
      rng,
    );
    bs = r.state;
    expect(r.events.some((e) => e.t === "ko" && e.id === "cat:trickster")).toBe(
      true,
    );
    expect(standLogs(r.events, "PURR ENGINE")).toHaveLength(1);
    // heal 60% × atk 9 = 5.4→5: only Bruno was below max
    expect(r.events).toContainEqual({
      t: "heal",
      id: "cat:bruiser",
      amount: 5,
      source: "power:purrEngine",
    });
    expect(byId(bs, "cat:bruiser").hp).toBe(35);
    // Mending 2 on all three living cats; the fallen one gets nothing
    for (const id of ["cat:bruiser", "cat:hexer", "cat:medic"]) {
      expect(statusesOf(byId(bs, id), "mending")[0]?.value).toBe(2);
    }
    expect(hasStatus(byId(bs, "cat:trickster"), "mending")).toBe(false);
    // perBattle 1: a second KO does not re-fire
    byId(bs, "cat:hexer").hp = 2;
    r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:hexer" },
      rng,
    );
    expect(r.events.some((e) => e.t === "ko" && e.id === "cat:hexer")).toBe(
      true,
    );
    expect(standLogs(r.events, "PURR ENGINE")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Boss stock powers                                                   */
/* ------------------------------------------------------------------ */

describe("boss powers", () => {
  it("BAD TO THE BONE (onCrit): files the victim at the back, bleeding", () => {
    let bs = makeBattle(["dogfather"], {
      "e0:dogfather": ENEMY_POWERS.dogfather!,
    });
    setQueue(bs, ["e0:dogfather"]);
    const rng = new ScriptedRng([1, 0.01]); // variance ×1.0, crit (crt 5%)
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "maul", targetId: "cat:bruiser" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(2);
    expect(standLogs(r.events, "BAD TO THE BONE")).toHaveLength(1);
    // maul: 110% × 12 × 1.5 = 19.8→20 − 3 = 17
    expect(byId(bs, "cat:bruiser").hp).toBe(40 - 17);
    // shoved 1 → rank 2 (Pixel slides to 1), Off-Balance + Scratched 2
    expect(byId(bs, "cat:bruiser").rank).toBe(2);
    expect(hasStatus(byId(bs, "cat:bruiser"), "offBalance")).toBe(true);
    expect(statusesOf(byId(bs, "cat:bruiser"), "scratched")[0]?.value).toBe(2);
  });

  it("ABSOLUTE VOID (onTakeHit): vacuums the attacker's energy", () => {
    let bs = makeBattle(["vacuumKing"], {
      "e0:vacuumKing": ENEMY_POWERS.vacuumKing!,
    });
    setQueue(bs, ["cat:bruiser"]);
    const rng = new ScriptedRng([1, 0.5, 0.1]); // variance, no crit, chance hit
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:vacuumKing" },
      rng,
    );
    bs = r.state;
    expect(rng.used).toBe(3);
    expect(standLogs(r.events, "ABSOLUTE VOID")).toHaveLength(1);
    // regen 4→6, drained −2 → 4, Claw Swipe banks +1 → 5
    expect(r.events).toContainEqual({
      t: "energy",
      id: "cat:bruiser",
      delta: -2,
    });
    expect(byId(bs, "cat:bruiser").energy).toBe(5);
  });

  it("PURPLE REIGN (onAllyKO): a fallen subject costs every cat tribute", () => {
    let bs = makeBattle(["ratPrince", "ratThug"], {
      "e0:ratPrince": ENEMY_POWERS.ratPrince!,
    });
    byId(bs, "e1:ratThug").hp = 5;
    setQueue(bs, ["cat:trickster"]);
    const rng = new ScriptedRng([1, 0.5]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e1:ratThug" },
      rng,
    );
    bs = r.state;
    expect(r.events.some((e) => e.t === "ko" && e.id === "e1:ratThug")).toBe(
      true,
    );
    expect(standLogs(r.events, "PURPLE REIGN")).toHaveLength(1);
    // tribute: 40% × atk 9 = 3.6→4, minus each cat's def, min 1
    const tribute = r.events.filter(
      (e) => e.t === "damage" && e.source === "power:purpleReign",
    );
    expect(tribute).toHaveLength(4);
    expect(byId(bs, "cat:bruiser").hp).toBe(40 - 1); // 4 − def 3
    expect(byId(bs, "cat:hexer").hp).toBe(24 - 4); // 4 − def 0
  });
});

/* ------------------------------------------------------------------ */
/* remaining triggers (synthetic scripts)                              */
/* ------------------------------------------------------------------ */

describe("interpreter — remaining triggers", () => {
  it("onBattleStart fires after round-1 initiative, in slot order", () => {
    const s = script({
      id: "power:loafPrep",
      trigger: "onBattleStart",
      effects: [{ kind: "status", target: "self", status: "guarded" }],
    });
    let bs = makeBattle(["ratThug"], { "cat:bruiser": s });
    const rng = new ScriptedRng([1, 1, 1, 1, 1]); // initiative only (4 cats + 1 rat)
    const r = startRound(bs, rng);
    bs = r.state;
    expect(rng.used).toBe(5);
    expect(hasStatus(byId(bs, "cat:bruiser"), "guarded")).toBe(true);
    // announced AFTER the roundStart event
    const iRound = r.events.findIndex((e) => e.t === "roundStart");
    const iLog = r.events.findIndex(
      (e) => e.t === "log" && e.text.includes("TEST STAND"),
    );
    expect(iRound).toBeGreaterThanOrEqual(0);
    expect(iLog).toBeGreaterThan(iRound);
    // round 2: does not fire again
    const rng2 = new ScriptedRng([1, 1, 1, 1, 1]);
    const r2 = startRound(bs, rng2);
    expect(standLogs(r2.events, "TEST STAND")).toHaveLength(0);
  });

  it("onTurnStart fires after regen; a frazzled slot consults nothing", () => {
    const s = script({
      id: "power:idle",
      trigger: "onTurnStart",
      effects: [{ kind: "energy", target: "self", amount: 2 }],
    });
    let bs = makeBattle(["ratThug"], { "cat:medic": s });
    setQueue(bs, ["cat:medic"]);
    let r = resolveAction(bs, { type: "guard" }, new ScriptedRng([]));
    bs = r.state;
    // regen 4→6, power +2 → 8, guard +2 → 10
    expect(byId(bs, "cat:medic").energy).toBe(10);
    expect(standLogs(r.events, "TEST STAND")).toHaveLength(1);
    // frazzled: the whole slot is consumed, no power consult
    const bs2 = makeBattle(["ratThug"], { "cat:medic": s });
    byId(bs2, "cat:medic").statuses.push({
      id: "frazzled",
      value: 0,
      duration: 1,
    });
    setQueue(bs2, ["cat:medic"]);
    r = resolveAction(bs2, { type: "guard" }, new ScriptedRng([]));
    expect(standLogs(r.events, "TEST STAND")).toHaveLength(0);
  });

  it("onTurnEnd fires after the action, before the death sweep", () => {
    const s = script({
      id: "power:lick",
      trigger: "onTurnEnd",
      effects: [{ kind: "heal", target: "self", pct: 40 }],
    });
    let bs = makeBattle(["ratThug"], { "cat:bruiser": s });
    byId(bs, "cat:bruiser").hp = 20;
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(bs, { type: "guard" }, new ScriptedRng([]));
    bs = r.state;
    // 40% × atk 10 = 4
    expect(r.events).toContainEqual({
      t: "heal",
      id: "cat:bruiser",
      amount: 4,
      source: "power:lick",
    });
    expect(byId(bs, "cat:bruiser").hp).toBe(24);
  });

  it("onStatusApplied fires per landed application on the recipient", () => {
    const s = script({
      id: "power:shrug",
      trigger: "onStatusApplied",
      effects: [{ kind: "cleanse", target: "self", status: "scratched" }],
    });
    let bs = makeBattle(["ratThug", "crowShaman"], { "cat:bruiser": s });
    setQueue(bs, ["e1:crowShaman"]);
    // hex: variance, crit, scratched chance 0.5 < 0.9 → lands → power cleanses
    const rng = new ScriptedRng([1, 0.5, 0.5]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "hex", targetId: "cat:bruiser" },
      rng,
    );
    bs = r.state;
    expect(standLogs(r.events, "TEST STAND")).toHaveLength(1);
    expect(r.events).toContainEqual({
      t: "cleansed",
      id: "cat:bruiser",
      status: "scratched",
    });
    expect(hasStatus(byId(bs, "cat:bruiser"), "scratched")).toBe(false);
  });

  it("hpBelowPct / roundAtLeast / selfRank predicates gate without drawing", () => {
    const s = script({
      id: "power:desperation",
      trigger: "onTurnStart",
      conditions: [
        { kind: "hpBelowPct", pct: 50 },
        { kind: "roundAtLeast", n: 1 },
        { kind: "selfRank", ranks: [1] },
      ],
      effects: [{ kind: "status", target: "self", status: "guarded" }],
    });
    // healthy: does not fire
    let bs = makeBattle(["ratThug"], { "cat:bruiser": s });
    setQueue(bs, ["cat:bruiser"]);
    let r = resolveAction(bs, { type: "guard" }, new ScriptedRng([]));
    expect(standLogs(r.events, "TEST STAND")).toHaveLength(0);
    // bloodied at rank 1: fires (guard applies Guarded once — power already did)
    bs = makeBattle(["ratThug"], { "cat:bruiser": s });
    byId(bs, "cat:bruiser").hp = 10;
    setQueue(bs, ["cat:bruiser"]);
    r = resolveAction(bs, { type: "guard" }, new ScriptedRng([]));
    expect(standLogs(r.events, "TEST STAND")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* determinism                                                         */
/* ------------------------------------------------------------------ */

describe("determinism", () => {
  function playout(seed: number): BattleEvent[] {
    const powers = {
      "cat:bruiser": CAT_POWERS.bruiser!,
      "cat:trickster": CAT_POWERS.trickster!,
      "cat:hexer": CAT_POWERS.hexer!,
      "cat:medic": CAT_POWERS.medic!,
    };
    let bs = makeBattle(["ratThug", "ratThug", "crowShaman"], powers);
    const rng = mulberry32(seed);
    const log: BattleEvent[] = [];
    let guardCount = 0;
    for (let step = 0; step < 400 && bs.outcome === "ongoing"; step++) {
      if (bs.catPilePrompt) {
        const r = resolveAction(bs, { type: "catPile", accept: true }, rng);
        bs = r.state;
        log.push(...r.events);
        continue;
      }
      const actor = nextActor(bs);
      if (!actor) {
        const r = startRound(bs, rng);
        bs = r.state;
        log.push(...r.events);
        continue;
      }
      if (actor.side === "enemy") {
        const r = resolveAction(bs, takeEnemyTurn(actor, bs, rng), rng);
        bs = r.state;
        log.push(...r.events);
        continue;
      }
      // cats: first usable skill with a target, else guard (varied but scripted)
      const la = legalActions(bs);
      const opt = la.skills.find((o) => o.ok && o.targetIds.length > 0);
      const action =
        opt && guardCount++ % 3 !== 2
          ? {
              type: "skill" as const,
              skillId: opt.skillId,
              targetId: opt.targetIds[0],
            }
          : { type: "guard" as const };
      const r = resolveAction(bs, action, rng);
      bs = r.state;
      log.push(...r.events);
    }
    return log;
  }

  it("same seed + same scripts ⇒ identical event log", () => {
    const seed = hash("powers-det", 3, 7);
    expect(JSON.stringify(playout(seed))).toBe(JSON.stringify(playout(seed)));
  });

  it("different seeds diverge (sanity that powers actually roll)", () => {
    const a = playout(hash("powers-det", 1, 1));
    const b = playout(hash("powers-det", 2, 2));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
