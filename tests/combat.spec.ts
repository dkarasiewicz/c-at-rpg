/**
 * WP-03 — combat engine tests.
 *
 * The gate: combat.md §13's worked example reproduced EXACTLY with a scripted
 * Rng yielding the listed rolls. Plus: pipeline order, clamping/Off-Balance,
 * Cat Pile, all six statuses, Poise/double-turn/phase/windup/summons, flee,
 * Nine Lives, the four class traits, all 8 Mewthical hooks, and determinism.
 *
 * Note on the §13 fixture: combat.md §13 predates classes.md's trait hooks —
 * its party carries no traits (String Theory would change Mora's energy
 * numbers), so the fixture passes `traits: []`, exactly as §13 specifies.
 */
import { describe, expect, it } from "vitest";
import type {
  BattleEvent,
  BattleSetup,
  BattleState,
  ClassId,
  MewHookId,
  Rng,
  TraitId,
} from "../src/core/types";
import { hash, mulberry32 } from "../src/core/rng";
import { CLASSES } from "../src/content/classes";
import { createBattle } from "../src/core/combat/setup";
import {
  byId,
  hasStatus,
  legalActions,
  living,
  nextActor,
  previewDamage,
} from "../src/core/combat/state";
import { catPileDamageEach, resolveAction } from "../src/core/combat/resolve";
import { battleResult, fleeChance, startRound } from "../src/core/combat/turns";
import { takeEnemyTurn } from "../src/core/combat/ai";
import { applyStatus, roundEndPhase } from "../src/core/combat/status";

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

/** never-called Rng for actions that must consume zero draws */
const noRng = new ScriptedRng([]);

const ORDER: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

function l1Cats(
  traits: Partial<Record<ClassId, TraitId[]>> | null = null,
  hooks: Partial<Record<ClassId, MewHookId[]>> = {},
): BattleSetup["cats"] {
  return ORDER.map((id) => {
    const cls = CLASSES[id];
    return {
      classId: id,
      name: cls.catName,
      stats: { ...cls.base },
      hp: cls.base.hp,
      lives: id === "hexer" ? 8 : 9, // §13: Mora is down one Life
      skills: cls.skills
        .filter((s) => s.unlockLevel <= 1)
        .map((s) => s.skillId),
      traits: traits?.[id] ?? [],
      hooks: hooks[id] ?? [],
      startEnergyBonus: 0,
    };
  });
}

function makeBattle(
  enemies: string[],
  opts: {
    traits?: Partial<Record<ClassId, TraitId[]>>;
    hooks?: Partial<Record<ClassId, MewHookId[]>>;
    canFlee?: boolean;
    encounterIndex?: number;
  } = {},
): BattleState {
  return createBattle({
    cats: l1Cats(opts.traits ?? null, opts.hooks ?? {}),
    enemies,
    encounterIndex: opts.encounterIndex ?? 1,
    canFlee: opts.canFlee ?? true,
  });
}

/** Hand-craft the frozen queue so tests can drive exact turn order. */
function setQueue(bs: BattleState, ids: string[]): void {
  bs.round = Math.max(1, bs.round);
  bs.queue = ids.map((id) => ({
    combatantId: id,
    initiative: 0,
    acted: false,
  }));
  bs.queueIndex = 0;
}

function damages(log: BattleEvent[]) {
  return log.filter((e) => e.t === "damage");
}

/* ------------------------------------------------------------------ */
/* §13 worked example — THE gate                                       */
/* ------------------------------------------------------------------ */

describe("combat.md §13 worked example", () => {
  it("reproduces the full round exactly", () => {
    let bs = makeBattle(["ratThug", "ratThug", "crowShaman"]);
    const rng = new ScriptedRng([
      // initiative: cats rank 1→4 (+2,+1,+2,+1), enemies rank 1→5 (+2,+0,+1)
      2, 1, 2, 1, 2, 0, 1,
      // Pixel Claw Swipe: variance idx 1 (×1.0), crit roll 0.07 < 0.15
      1, 0.07,
      // Mora Yank of Yarn: variance idx 2 (×1.1), no crit
      2, 0.5,
      // Crow Peck: variance idx 0 (×0.9), no crit
      0, 0.5,
      // Rat A Shiv: variance idx 2 (×1.1), no crit
      2, 0.9,
      // Bruno Body Slam: variance idx 1 (×1.0), no crit
      1, 0.9,
      // Rat B Shiv: variance idx 0 (×0.9), no crit
      0, 0.9,
    ]);
    const log: BattleEvent[] = [];
    const run = (r: { state: BattleState; events: BattleEvent[] }) => {
      bs = r.state;
      log.push(...r.events);
    };

    run(startRound(bs, rng));
    // Sorted: Pixel 9 → Mora 8 (cat before enemy) → Crow 8 → Rat A 7 →
    // Bruno 6 (lower rank) → Baguette 6 → Rat B 5.
    expect(bs.queue.map((q) => q.combatantId)).toEqual([
      "cat:trickster",
      "cat:hexer",
      "e2:crowShaman",
      "e0:ratThug",
      "cat:bruiser",
      "cat:medic",
      "e1:ratThug",
    ]);
    expect(bs.queue.map((q) => q.initiative)).toEqual([9, 8, 8, 7, 6, 6, 5]);

    // 1. Pixel: Claw Swipe on Rat A — 18 crit − DEF 1 = 17. EN 6+1=7.
    run(
      resolveAction(
        bs,
        { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
        rng,
      ),
    );
    expect(damages(log).at(-1)).toMatchObject({
      id: "e0:ratThug",
      amount: 17,
      crit: true,
      offBal: false,
      source: "clawSwipe",
    });
    expect(byId(bs, "e0:ratThug").hp).toBe(1);
    expect(byId(bs, "cat:trickster").energy).toBe(7);

    // 2. Mora: Yank of Yarn on the Crow — 7 damage, pulled 2 to rank 1,
    //    Off-Balance; rats slide back. EN 6−3=3, no Cat Pile prompt.
    run(
      resolveAction(
        bs,
        { type: "skill", skillId: "yankOfYarn", targetId: "e2:crowShaman" },
        rng,
      ),
    );
    expect(damages(log).at(-1)).toMatchObject({
      id: "e2:crowShaman",
      amount: 7,
    });
    const crow = byId(bs, "e2:crowShaman");
    expect(crow.hp).toBe(7);
    expect(crow.rank).toBe(1);
    expect(hasStatus(crow, "offBalance")).toBe(true);
    expect(byId(bs, "e0:ratThug").rank).toBe(2);
    expect(byId(bs, "e1:ratThug").rank).toBe(3);
    expect(byId(bs, "cat:hexer").energy).toBe(3);
    expect(bs.catPilePrompt).toBe(false);
    expect(
      log.some((e) => e.t === "moved" && e.id === "e2:crowShaman" && e.forced),
    ).toBe(true);

    // 3. Crow (rank 1): hex offline, Peck ties on Bruno/Pixel → lower rank →
    //    Bruno, chosen WITHOUT an rng draw. 7 − DEF 3 = 4.
    const crowActor = nextActor(bs)!;
    expect(crowActor.id).toBe("e2:crowShaman");
    const drawsBefore = rng.used;
    const crowAction = takeEnemyTurn(crowActor, bs, rng);
    expect(rng.used).toBe(drawsBefore); // deterministic tie-break, no roll
    expect(crowAction).toEqual({
      type: "skill",
      skillId: "peck",
      targetId: "cat:bruiser",
    });
    run(resolveAction(bs, crowAction, rng));
    expect(damages(log).at(-1)).toMatchObject({ id: "cat:bruiser", amount: 4 });
    expect(byId(bs, "cat:bruiser").hp).toBe(36);

    // 4. Rat A: Shiv prefers the wounded Bruno — 8 − 3 = 5.
    const ratA = nextActor(bs)!;
    const aAct = takeEnemyTurn(ratA, bs, rng);
    expect(aAct).toEqual({
      type: "skill",
      skillId: "shiv",
      targetId: "cat:bruiser",
    });
    run(resolveAction(bs, aAct, rng));
    expect(damages(log).at(-1)).toMatchObject({ id: "cat:bruiser", amount: 5 });
    expect(byId(bs, "cat:bruiser").hp).toBe(31);

    // 5. Bruno: Body Slam the Off-Balance Crow — 12 × 1.5 = 18, dead;
    //    push moot; rats slide to ranks 1-2. EN 6−4=2.
    run(
      resolveAction(
        bs,
        { type: "skill", skillId: "bodySlam", targetId: "e2:crowShaman" },
        rng,
      ),
    );
    expect(damages(log).at(-1)).toMatchObject({
      id: "e2:crowShaman",
      amount: 18,
      crit: false,
      offBal: true,
    });
    expect(byId(bs, "e2:crowShaman").ko).toBe(true);
    expect(byId(bs, "e0:ratThug").rank).toBe(1);
    expect(byId(bs, "e1:ratThug").rank).toBe(2);
    expect(byId(bs, "cat:bruiser").energy).toBe(2);

    // 6. Baguette: Guard — Guarded, EN 6+2=8.
    run(resolveAction(bs, { type: "guard" }, rng));
    const baguette = byId(bs, "cat:medic");
    expect(hasStatus(baguette, "guarded")).toBe(true);
    expect(baguette.energy).toBe(8);

    // 7. Rat B: Shiv on Bruno — 6 − 3 = 3.
    const ratB = nextActor(bs)!;
    const bAct = takeEnemyTurn(ratB, bs, rng);
    expect(bAct).toEqual({
      type: "skill",
      skillId: "shiv",
      targetId: "cat:bruiser",
    });
    run(resolveAction(bs, bAct, rng));
    expect(damages(log).at(-1)).toMatchObject({ id: "cat:bruiser", amount: 3 });
    expect(byId(bs, "cat:bruiser").hp).toBe(28);

    // Round exhausted; every scripted roll consumed, none extra.
    expect(nextActor(bs)).toBeNull();
    expect(rng.used).toBe(19);
    expect(bs.outcome).toBe("ongoing");

    // The full damage sequence of the round.
    expect(damages(log).map((d) => d.amount)).toEqual([17, 7, 4, 5, 18, 3]);

    // Round-end phase (runs inside the next startRound): nothing to sweep,
    // Baguette keeps Guarded until her own turn, latch resets.
    const rng2 = new ScriptedRng([0, 0, 0, 0, 0, 0]);
    const r2 = startRound(bs, rng2);
    expect(r2.state.round).toBe(2);
    expect(hasStatus(byId(r2.state, "cat:medic"), "guarded")).toBe(true);
    expect(r2.state.catPileLatch).toBe(false);

    // §13 postscript: a Cat Pile at this party would deal floor(0.30·42)=12.
    expect(catPileDamageEach(bs)).toBe(12);
  });
});

/* ------------------------------------------------------------------ */
/* pipeline order, clamping, Off-Balance                               */
/* ------------------------------------------------------------------ */

describe("damage pipeline and Off-Paw", () => {
  it("damage resolves before movement — a shove never buffs its own damage", () => {
    const bs = makeBattle(["ratThug", "ratThug"]);
    setQueue(bs, ["cat:bruiser", "cat:trickster"]);
    const rng = new ScriptedRng([1, 0.9]);
    const r1 = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:ratThug" },
      rng,
    );
    const d1 = damages(r1.events)[0];
    expect(d1).toMatchObject({ amount: 11, offBal: false }); // 12 − DEF 1
    const rat = byId(r1.state, "e0:ratThug");
    expect(rat.rank).toBe(2); // pushed (clamped from +2 to the back rank)
    expect(hasStatus(rat, "offBalance")).toBe(true);

    // the teammate acting later cashes the +50%
    const r2 = resolveAction(
      r1.state,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    expect(damages(r2.events)[0]).toMatchObject({ amount: 17, offBal: true }); // 12×1.5=18 −1
  });

  it("a clamped-to-0 push moves nothing and applies no Off-Balance", () => {
    const bs = makeBattle(["ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    const rat = byId(r.state, "e0:ratThug");
    expect(rat.rank).toBe(1);
    expect(hasStatus(rat, "offBalance")).toBe(false);
    expect(r.events.some((e) => e.t === "moved")).toBe(false);
  });

  it("voluntary movement (moveSelf / Move swap) never self-inflicts Off-Balance", () => {
    const bs = makeBattle(["ratThug"]);
    // Pixel to rank 3 so Pounce is legal: swap her back via the Move action
    setQueue(bs, ["cat:trickster", "cat:trickster"]);
    const r1 = resolveAction(bs, { type: "move", dir: "back" }, noRng);
    const pixel1 = byId(r1.state, "cat:trickster");
    expect(pixel1.rank).toBe(3);
    expect(byId(r1.state, "cat:hexer").rank).toBe(2);
    expect(hasStatus(pixel1, "offBalance")).toBe(false);

    const r2 = resolveAction(
      r1.state,
      { type: "skill", skillId: "pounce", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    const pixel2 = byId(r2.state, "cat:trickster");
    expect(pixel2.rank).toBe(1); // leapt to the front line
    expect(hasStatus(pixel2, "offBalance")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Cat Pile                                                            */
/* ------------------------------------------------------------------ */

describe("Cat Pile", () => {
  function armPile(): { bs: BattleState; log: BattleEvent[] } {
    const bs = makeBattle(["ratThug", "ratThug"]);
    setQueue(bs, ["cat:trickster", "cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "tripWire" },
      new ScriptedRng([1, 0.9, 1, 0.9]),
    );
    return { bs: r.state, log: [...r.events] };
  }

  it("Trip Wire arms it: row shove → prompt with floor(0.30·Σatk)", () => {
    const { bs, log } = armPile();
    expect(damages(log).map((d) => d.amount)).toEqual([6, 6]); // 7.2→7 −1
    expect(bs.catPilePrompt).toBe(true);
    expect(bs.catPileLatch).toBe(true);
    expect(log.at(-1)).toMatchObject({ t: "catPilePrompt", damageEach: 12 });
  });

  it("accept: 12 typeless to each, ignores DEF, then victory here", () => {
    const { bs, log } = armPile();
    const r = resolveAction(bs, { type: "catPile", accept: true }, noRng);
    log.push(...r.events);
    expect(r.events).toContainEqual({
      t: "catPile",
      damageEach: 12,
      targets: ["e0:ratThug", "e1:ratThug"],
    });
    // 18 − 6 (tripwire) − 12 = 0: both die, victory
    expect(r.state.outcome).toBe("victory");
    const result = battleResult(r.state, log);
    expect(result.catPiles).toBe(1);
    expect(result.enemiesDefeated).toBe(2);
    expect(result.xpGained).toBe(20);
  });

  it("decline keeps the Off-Balance marks; latch blocks a re-prompt this round", () => {
    const { bs } = armPile();
    const r = resolveAction(bs, { type: "catPile", accept: false }, noRng);
    expect(r.state.catPilePrompt).toBe(false);
    for (const e of living(r.state, "enemy")) {
      expect(hasStatus(e, "offBalance")).toBe(true);
    }
    // another cat action while all enemies are still Off-Balance: no prompt
    const r2 = resolveAction(r.state, { type: "guard" }, noRng);
    expect(r2.state.catPilePrompt).toBe(false);
  });

  it("survivors of an accepted pile scramble back up (marks consumed)", () => {
    const bs = makeBattle(["yarnGolem", "ratThug"]);
    setQueue(bs, ["cat:trickster"]);
    // hand-arm: both enemies Off-Balance, then a cat action triggers the check
    for (const e of living(bs, "enemy")) applyStatus(e, "offBalance");
    const r1 = resolveAction(bs, { type: "guard" }, noRng);
    expect(r1.state.catPilePrompt).toBe(true);
    const r2 = resolveAction(
      r1.state,
      { type: "catPile", accept: true },
      noRng,
    );
    const golem = byId(r2.state, "e0:yarnGolem");
    expect(golem.hp).toBe(40 - 12);
    expect(hasStatus(golem, "offBalance")).toBe(false);
  });

  it("needs at least 2 living cats", () => {
    const bs = makeBattle(["ratThug", "ratThug"]);
    for (const id of ["cat:trickster", "cat:hexer", "cat:medic"]) {
      const c = byId(bs, id);
      c.ko = true;
      c.hp = 0;
    }
    byId(bs, "cat:bruiser").rank = 1;
    setQueue(bs, ["cat:bruiser"]);
    for (const e of living(bs, "enemy")) applyStatus(e, "offBalance");
    const r = resolveAction(bs, { type: "guard" }, noRng);
    expect(r.state.catPilePrompt).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* statuses                                                            */
/* ------------------------------------------------------------------ */

describe("the six statuses", () => {
  it("scratched: values add, cap 3 applications, reapply resets duration", () => {
    const bs = makeBattle(["ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    expect(applyStatus(rat, "scratched", 3)).toBe(true);
    expect(applyStatus(rat, "scratched", 3)).toBe(true);
    rat.statuses.forEach((s) => (s.duration = 1)); // age them
    expect(applyStatus(rat, "scratched", 3)).toBe(true);
    expect(applyStatus(rat, "scratched", 3)).toBe(false); // cap 3
    expect(rat.statuses.filter((s) => s.id === "scratched")).toHaveLength(3);
    // reapply reset every application's duration back to 3
    expect(rat.statuses.every((s) => s.duration === 3)).toBe(true);
  });

  it("scratched ticks at the victim's turn start, ignoring DEF and Guarded", () => {
    const bs = makeBattle(["ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    applyStatus(rat, "scratched", 3);
    applyStatus(rat, "guarded");
    setQueue(bs, ["e0:ratThug"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      new ScriptedRng([1, 0.9]),
    );
    const tick = damages(r.events).find((d) => d.source === "scratched");
    expect(tick).toMatchObject({ id: "e0:ratThug", amount: 3 });
    expect(byId(r.state, "e0:ratThug").hp).toBe(15);
  });

  it("scratched expires after 3 round-end phases", () => {
    const bs = makeBattle(["ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    applyStatus(rat, "scratched", 3);
    const events: BattleEvent[] = [];
    roundEndPhase(bs, events);
    roundEndPhase(bs, events);
    expect(hasStatus(rat, "scratched")).toBe(true);
    roundEndPhase(bs, events);
    expect(hasStatus(rat, "scratched")).toBe(false);
    expect(events).toContainEqual({
      t: "statusExpired",
      id: "e0:ratThug",
      status: "scratched",
    });
  });

  it("frazzled: skips the turn entirely (no regen, no action), then removed; no reapply", () => {
    const bs = makeBattle(["ratThug"]);
    const bruno = byId(bs, "cat:bruiser");
    applyStatus(bruno, "frazzled");
    expect(applyStatus(bruno, "frazzled")).toBe(false); // no stunlock
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(bs, { type: "guard" }, noRng); // action ignored
    const after = byId(r.state, "cat:bruiser");
    expect(after.energy).toBe(4); // no regen
    expect(hasStatus(after, "frazzled")).toBe(false);
    expect(hasStatus(after, "guarded")).toBe(false); // never acted
    expect(r.events).toContainEqual({
      t: "statusExpired",
      id: "cat:bruiser",
      status: "frazzled",
    });
  });

  it("off-balance: no stacking; swept in the round-end phase", () => {
    const bs = makeBattle(["ratThug"]);
    const rat = byId(bs, "e0:ratThug");
    expect(applyStatus(rat, "offBalance")).toBe(true);
    expect(applyStatus(rat, "offBalance")).toBe(false);
    const events: BattleEvent[] = [];
    roundEndPhase(bs, events);
    expect(hasStatus(rat, "offBalance")).toBe(false);
  });

  it("guarded halves damage and expires at the owner's next turn start", () => {
    const bs = makeBattle(["ratThug"]);
    const bruno = byId(bs, "cat:bruiser");
    applyStatus(bruno, "guarded");
    setQueue(bs, ["e0:ratThug", "cat:bruiser"]);
    const r1 = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:bruiser" },
      new ScriptedRng([1, 0.9]),
    );
    // 7 × 0.5 = 3.5 → 4 − 3 = 1
    expect(damages(r1.events)[0]).toMatchObject({
      id: "cat:bruiser",
      amount: 1,
    });
    const r2 = resolveAction(r1.state, { type: "guard" }, noRng);
    expect(r2.events).toContainEqual({
      t: "statusExpired",
      id: "cat:bruiser",
      status: "guarded",
    });
  });

  it("provoked: single-target damage must hit the provoker; newest wins", () => {
    const bs = makeBattle(["ratThug"]);
    byId(bs, "cat:trickster").hp = 10; // rat would otherwise prefer Pixel
    setQueue(bs, ["cat:bruiser", "e0:ratThug"]);
    const r1 = resolveAction(bs, { type: "skill", skillId: "hiss" }, noRng); // chance 1.0 → 0 draws
    const rat = byId(r1.state, "e0:ratThug");
    expect(hasStatus(rat, "provoked")).toBe(true);
    expect(hasStatus(byId(r1.state, "cat:bruiser"), "guarded")).toBe(true);
    const act = takeEnemyTurn(rat, r1.state, noRng);
    expect(act).toMatchObject({ targetId: "cat:bruiser" });
  });

  it("mending: heals at the owner's turn start; refresh keeps the higher value", () => {
    const bs = makeBattle(["ratThug"]);
    const bruno = byId(bs, "cat:bruiser");
    bruno.hp = 20;
    applyStatus(bruno, "mending", 3);
    applyStatus(bruno, "mending", 5);
    applyStatus(bruno, "mending", 2);
    expect(bruno.statuses.filter((s) => s.id === "mending")).toHaveLength(1);
    expect(bruno.statuses[0].value).toBe(5);
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(bs, { type: "guard" }, noRng);
    expect(r.events).toContainEqual({
      t: "heal",
      id: "cat:bruiser",
      amount: 5,
      source: "mending",
    });
  });
});

/* ------------------------------------------------------------------ */
/* bosses: Poise, double turn, phases, windup, summons                 */
/* ------------------------------------------------------------------ */

describe("bosses", () => {
  it("forced-move attempts chip Poise (once per skill use), even on a lone boss", () => {
    const bs = makeBattle(["vacuumKing"], {
      canFlee: false,
      encounterIndex: 0,
    });
    setQueue(bs, ["cat:bruiser", "cat:bruiser", "cat:bruiser"]);
    // Squeaky Toy: power 0, chance-1.0 — zero rolls, pure chip
    let r = resolveAction(
      bs,
      { type: "item", itemId: "squeakyToy", targetId: "e0:vacuumKing" },
      noRng,
    );
    expect(r.events).toContainEqual({
      t: "poiseChip",
      id: "e0:vacuumKing",
      left: 2,
    });
    let boss = byId(r.state, "e0:vacuumKing");
    expect(boss.rank).toBe(1); // the body never moves
    expect(hasStatus(boss, "offBalance")).toBe(false);

    r = resolveAction(
      r.state,
      { type: "item", itemId: "squeakyToy", targetId: "e0:vacuumKing" },
      noRng,
    );
    // third attempt breaks: Off-Balance window + reset; lone boss → Cat Pile opens
    r = resolveAction(
      r.state,
      { type: "item", itemId: "squeakyToy", targetId: "e0:vacuumKing" },
      noRng,
    );
    expect(r.events).toContainEqual({ t: "poiseBreak", id: "e0:vacuumKing" });
    boss = byId(r.state, "e0:vacuumKing");
    expect(hasStatus(boss, "offBalance")).toBe(true);
    expect(boss.poise).toBe(3); // reset to max
    expect(r.events.some((e) => e.t === "catPilePrompt")).toBe(true);
  });

  it("doubleTurn: two independent queue entries; Frazzled eats only one slot", () => {
    let bs = makeBattle(["vacuumKing"], { canFlee: false, encounterIndex: 0 });
    const rng = new ScriptedRng([0, 0, 0, 0, 0, 0]); // 4 cats + 2 boss rolls
    const r = startRound(bs, rng);
    bs = r.state;
    const bossEntries = bs.queue.filter(
      (q) => q.combatantId === "e0:vacuumKing",
    );
    expect(bossEntries).toHaveLength(2);

    applyStatus(byId(bs, "e0:vacuumKing"), "frazzled");
    setQueue(bs, ["e0:vacuumKing", "e0:vacuumKing"]);
    const s1 = resolveAction(bs, { type: "advance" }, noRng); // slot 1: skipped
    expect(s1.events).toContainEqual({
      t: "statusExpired",
      id: "e0:vacuumKing",
      status: "frazzled",
    });
    expect(damages(s1.events)).toHaveLength(0);
    // slot 2: acts normally (Dust Blast row: 6−3=3 on Bruno, 6−1=5 on Pixel)
    const act = takeEnemyTurn(byId(s1.state, "e0:vacuumKing"), s1.state, noRng);
    expect(act).toMatchObject({ type: "skill", skillId: "dustBlast" });
    const s2 = resolveAction(s1.state, act, new ScriptedRng([1, 0.9, 1, 0.9]));
    expect(damages(s2.events).map((d) => d.amount)).toEqual([3, 5]);
  });

  it("phase switch at 50%: skill list swaps, cooldowns clear", () => {
    const bs = makeBattle(["dogfather"], { canFlee: false, encounterIndex: 0 });
    const boss = byId(bs, "e0:dogfather");
    boss.hp = 100; // exactly 50% of 200 → next hit crosses nothing new; already ≤
    boss.cooldowns = { junkyardToss: 2 };
    setQueue(bs, ["cat:trickster"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:dogfather" },
      new ScriptedRng([1, 0.9]),
    );
    const after = byId(r.state, "e0:dogfather");
    expect(r.events).toContainEqual({
      t: "phaseChange",
      id: "e0:dogfather",
      phase: 1,
    });
    expect(after.skills).toContain("theBigBark");
    expect(after.cooldowns).toEqual({});
  });

  it("windup: charge telegraph, then the release hits the marked row", () => {
    const bs = makeBattle(["dogfather"], { canFlee: false, encounterIndex: 0 });
    const boss = byId(bs, "e0:dogfather");
    boss.hp = 90;
    boss.phase = 1;
    boss.skills = ["maul", "junkyardToss", "theBigBark"];
    boss.cooldowns = {};
    setQueue(bs, ["e0:dogfather", "e0:dogfather"]);

    const a1 = takeEnemyTurn(boss, bs, noRng);
    expect(a1).toMatchObject({ type: "skill", skillId: "theBigBark" });
    const r1 = resolveAction(bs, a1, noRng); // charging: no rolls, no damage
    const charged = byId(r1.state, "e0:dogfather");
    expect(charged.charging).toEqual({ skillId: "theBigBark", ranks: [1, 2] });
    expect(
      r1.events.some((e) => e.t === "charging" && e.ranks.join() === "1,2"),
    ).toBe(true);
    expect(damages(r1.events)).toHaveLength(0);

    const a2 = takeEnemyTurn(charged, r1.state, noRng);
    expect(a2).toEqual({ type: "skill", skillId: "theBigBark" }); // scripted release
    const r2 = resolveAction(r1.state, a2, new ScriptedRng([1, 0.9, 1, 0.9]));
    // 200-power row: Bruno 24−3=21, Pixel 24−1=23
    expect(damages(r2.events).map((d) => d.amount)).toEqual([21, 23]);
    expect(byId(r2.state, "e0:dogfather").charging).toBeNull();
  });

  it("Frazzled (The Cucumber) cancels a charging windup; once per battle", () => {
    const bs = makeBattle(["dogfather"], { canFlee: false, encounterIndex: 0 });
    const boss = byId(bs, "e0:dogfather");
    boss.charging = { skillId: "theBigBark", ranks: [1, 2] };
    setQueue(bs, ["cat:hexer", "cat:hexer"]);
    const r = resolveAction(
      bs,
      { type: "item", itemId: "theCucumber", targetId: "e0:dogfather" },
      noRng, // chance 1.0 → no roll
    );
    expect(r.events).toContainEqual({
      t: "chargeCancelled",
      id: "e0:dogfather",
    });
    expect(byId(r.state, "e0:dogfather").charging).toBeNull();
    expect(hasStatus(byId(r.state, "e0:dogfather"), "frazzled")).toBe(true);
    expect(r.state.cucumberUsed).toBe(true);
    expect(() =>
      resolveAction(
        r.state,
        { type: "item", itemId: "theCucumber", targetId: "e0:dogfather" },
        noRng,
      ),
    ).toThrow();
  });

  it("summons spawn into the lowest empty rank, cap enforced, act next round", () => {
    const bs = makeBattle(["ratPrince"], { canFlee: false, encounterIndex: 0 });
    const boss = byId(bs, "e0:ratPrince");
    setQueue(bs, ["e0:ratPrince", "e0:ratPrince", "e0:ratPrince"]);
    const a1 = takeEnemyTurn(boss, bs, noRng);
    expect(a1).toMatchObject({ type: "skill", skillId: "summonVermin" });
    const r1 = resolveAction(bs, a1, noRng);
    expect(r1.events).toContainEqual({
      t: "summon",
      id: "summon0:ratThug",
      minion: "ratThug",
      rank: 2,
    });
    // not in this round's frozen queue → acts starting next round
    expect(r1.state.queue.some((q) => q.combatantId.startsWith("summon"))).toBe(
      false,
    );

    // second summon lands at rank 3; then the cap (2) forces a normal skill
    const b2 = byId(r1.state, "e0:ratPrince");
    b2.cooldowns = {};
    const r2 = resolveAction(
      r1.state,
      takeEnemyTurn(b2, r1.state, noRng),
      noRng,
    );
    expect(r2.events).toContainEqual({
      t: "summon",
      id: "summon1:ratThug",
      minion: "ratThug",
      rank: 3,
    });
    const b3 = byId(r2.state, "e0:ratPrince");
    b3.cooldowns = {};
    const a3 = takeEnemyTurn(b3, r2.state, noRng);
    expect(a3).toMatchObject({ skillId: "scepterBonk" });
  });
});

/* ------------------------------------------------------------------ */
/* flee                                                                */
/* ------------------------------------------------------------------ */

describe("flee (Scatter!)", () => {
  it("chance = clamp(0.4 + 0.05·(avgCatSpd − avgEnemySpd), 0.25, 0.9)", () => {
    const bs = makeBattle(["ratThug", "ratThug"]);
    // cats (4+8+6+5)/4 = 5.75 vs rats 5 → 0.4375
    expect(fleeChance(bs)).toBeCloseTo(0.4375, 10);
  });

  it("success ends the battle, clears all statuses; failure wastes the turn", () => {
    const bs = makeBattle(["ratThug", "ratThug"]);
    applyStatus(byId(bs, "e0:ratThug"), "offBalance");
    setQueue(bs, ["cat:bruiser", "cat:trickster"]);
    const fail = resolveAction(bs, { type: "flee" }, new ScriptedRng([0.9]));
    expect(fail.events).toContainEqual({
      t: "fleeAttempt",
      ok: false,
      chance: 0.4375,
    });
    expect(fail.state.outcome).toBe("ongoing");
    expect(fail.state.queue[0].acted).toBe(true); // turn wasted

    const ok = resolveAction(
      fail.state,
      { type: "flee" },
      new ScriptedRng([0.1]),
    );
    expect(ok.state.outcome).toBe("fled");
    expect(ok.events.at(-1)).toEqual({ t: "fled" });
    expect(byId(ok.state, "e0:ratThug").statuses).toEqual([]);
    const result = battleResult(ok.state, ok.events);
    expect(result.outcome).toBe("fled");
    expect(result.xpGained).toBe(0);
  });

  it("no fleeing in boss battles; Can-Opener Recording flees rollless elsewhere", () => {
    const bossFight = makeBattle(["vacuumKing"], {
      canFlee: false,
      encounterIndex: 0,
    });
    setQueue(bossFight, ["cat:bruiser"]);
    expect(legalActions(bossFight).canFlee).toBe(false);
    expect(() => resolveAction(bossFight, { type: "flee" }, noRng)).toThrow();
    expect(() =>
      resolveAction(
        bossFight,
        { type: "item", itemId: "canOpenerRecording" },
        noRng,
      ),
    ).toThrow(); // nonBoss

    const bs = makeBattle(["ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "item", itemId: "canOpenerRecording" },
      noRng,
    );
    expect(r.events).toContainEqual({ t: "fleeAttempt", ok: true, chance: 1 });
    expect(r.state.outcome).toBe("fled");
  });
});

/* ------------------------------------------------------------------ */
/* Nine Lives, KO, revival                                             */
/* ------------------------------------------------------------------ */

describe("Nine Lives", () => {
  it("KO removes from formation and clears statuses; standup costs 1 Life", () => {
    const bs = makeBattle(["ratThug"]);
    const pixel = byId(bs, "cat:trickster");
    pixel.hp = 1;
    applyStatus(pixel, "scratched", 3);
    byId(bs, "e0:ratThug").hp = 1;
    setQueue(bs, ["e0:ratThug", "cat:bruiser"]);

    const r1 = resolveAction(
      bs,
      { type: "skill", skillId: "shiv", targetId: "cat:trickster" },
      new ScriptedRng([1, 0.9]),
    );
    const koPixel = byId(r1.state, "cat:trickster");
    expect(koPixel.ko).toBe(true);
    expect(koPixel.statuses).toEqual([]);
    expect(r1.events).toContainEqual({ t: "ko", id: "cat:trickster" });
    expect(byId(r1.state, "cat:hexer").rank).toBe(2); // slid forward
    expect(byId(r1.state, "cat:medic").rank).toBe(3);

    const r2 = resolveAction(
      r1.state,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    expect(r2.state.outcome).toBe("victory");
    expect(r2.events).toContainEqual({
      t: "lifeLost",
      id: "cat:trickster",
      livesLeft: 8,
    });
    const after = byId(r2.state, "cat:trickster");
    expect(after.hp).toBe(1);
    const result = battleResult(r2.state, r2.events);
    expect(result.cats).toContainEqual({
      classId: "trickster",
      hp: 1,
      lives: 8,
    });
  });

  it("Nine Lives Nudge revives at 30% into rank 4, once per battle, no Life lost", () => {
    const bs = makeBattle(["ratThug"]);
    const pixel = byId(bs, "cat:trickster");
    pixel.ko = true;
    pixel.hp = 0;
    byId(bs, "cat:hexer").rank = 2;
    byId(bs, "cat:medic").rank = 3;
    setQueue(bs, ["cat:medic", "cat:medic"]);

    const r = resolveAction(
      bs,
      { type: "skill", skillId: "nineLivesNudge", targetId: "cat:trickster" },
      noRng, // revive draws nothing
    );
    const revived = byId(r.state, "cat:trickster");
    expect(revived.ko).toBe(false);
    expect(revived.hp).toBe(8); // round(0.30 × 28)
    expect(revived.rank).toBe(4);
    expect(revived.lives).toBe(9); // in-battle revival: no pip lost
    expect(r.events).toContainEqual({
      t: "revive",
      id: "cat:trickster",
      hp: 8,
    });
    expect(byId(r.state, "cat:medic").usedOncePerBattle).toContain(
      "nineLivesNudge",
    );
    // once per battle
    revived.ko = true;
    revived.hp = 0;
    expect(() =>
      resolveAction(
        r.state,
        { type: "skill", skillId: "nineLivesNudge", targetId: "cat:trickster" },
        noRng,
      ),
    ).toThrow();
  });

  it("Feather Wand revives at 25% (item path)", () => {
    const bs = makeBattle(["ratThug"]);
    const pixel = byId(bs, "cat:trickster");
    pixel.ko = true;
    pixel.hp = 0;
    byId(bs, "cat:hexer").rank = 2;
    byId(bs, "cat:medic").rank = 3;
    setQueue(bs, ["cat:medic"]);
    const r = resolveAction(
      bs,
      { type: "item", itemId: "featherWand", targetId: "cat:trickster" },
      noRng,
    );
    expect(byId(r.state, "cat:trickster").hp).toBe(7); // round(0.25 × 28)
    expect(byId(r.state, "cat:medic").energy).toBe(6); // items cost no energy
  });
});

/* ------------------------------------------------------------------ */
/* class traits                                                        */
/* ------------------------------------------------------------------ */

describe("class traits", () => {
  it("Immovable Loaf: once per battle Bruno declines a forced move (tier 2 adds Guarded)", () => {
    const bs = makeBattle(["roombaScout"], {
      traits: { bruiser: ["immovableLoaf", "immovableLoaf"] }, // tier 2
    });
    setQueue(bs, ["e0:roombaScout", "e0:roombaScout"]);
    const r1 = resolveAction(
      bs,
      { type: "skill", skillId: "ram", targetId: "cat:bruiser" },
      new ScriptedRng([1, 0.9]),
    );
    const bruno1 = byId(r1.state, "cat:bruiser");
    expect(r1.events).toContainEqual({
      t: "traitTriggered",
      id: "cat:bruiser",
      trait: "immovableLoaf",
    });
    expect(bruno1.rank).toBe(1);
    expect(hasStatus(bruno1, "offBalance")).toBe(false);
    expect(hasStatus(bruno1, "guarded")).toBe(true); // tier 2 bonus
    expect(bruno1.traitLatchUsed).toBe(true);

    // second shove goes through (guarded halves it first, then he moves)
    const r2 = resolveAction(
      r1.state,
      { type: "skill", skillId: "ram", targetId: "cat:bruiser" },
      new ScriptedRng([1, 0.9]),
    );
    const bruno2 = byId(r2.state, "cat:bruiser");
    expect(bruno2.rank).toBe(2);
    expect(hasStatus(bruno2, "offBalance")).toBe(true);
  });

  it("Opportunist: +10 crit vs Off-Balance targets (crit-roll injection)", () => {
    const bs = makeBattle(["ratThug"], {
      traits: { trickster: ["opportunist"] },
    });
    setQueue(bs, ["cat:trickster", "cat:trickster"]);
    // roll 0.20: ≥ 0.15 base → no crit without the bonus
    const plain = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.2]),
    );
    expect(damages(plain.events)[0].crit).toBe(false);
    // same roll vs an Off-Balance target: 15+10=25% → crit
    applyStatus(byId(plain.state, "e0:ratThug"), "offBalance");
    const boosted = resolveAction(
      plain.state,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.2]),
    );
    expect(damages(boosted.events)[0].crit).toBe(true);
  });

  it("String Theory: a forced move or Poise chip refunds Mora 1 energy", () => {
    const bs = makeBattle(["ratThug", "ratThug"], {
      traits: { hexer: ["stringTheory"] },
    });
    setQueue(bs, ["cat:hexer"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "yankOfYarn", targetId: "e1:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    expect(r.events).toContainEqual({
      t: "traitTriggered",
      id: "cat:hexer",
      trait: "stringTheory",
    });
    // 4 + 2 regen − 3 cost + 1 refund = 4
    expect(byId(r.state, "cat:hexer").energy).toBe(4);
  });

  it("Purr Engine: Baguette's Guard gives every other living cat +1 energy", () => {
    const bs = makeBattle(["ratThug"], { traits: { medic: ["purrEngine"] } });
    setQueue(bs, ["cat:medic"]);
    const r = resolveAction(bs, { type: "guard" }, noRng);
    expect(byId(r.state, "cat:medic").energy).toBe(8); // 4+2 regen +2 guard
    expect(byId(r.state, "cat:bruiser").energy).toBe(5);
    expect(byId(r.state, "cat:trickster").energy).toBe(5);
    expect(byId(r.state, "cat:hexer").energy).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* the 8 Mewthical hooks                                               */
/* ------------------------------------------------------------------ */

describe("Mewthical hooks", () => {
  it("poiseChip2 (Dumpster Lid Mitts): forced-move attempts chip 2", () => {
    const bs = makeBattle(["vacuumKing"], {
      canFlee: false,
      encounterIndex: 0,
      hooks: { bruiser: ["poiseChip2"] },
    });
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:vacuumKing" },
      new ScriptedRng([1, 0.9]),
    );
    expect(r.events).toContainEqual({
      t: "poiseChip",
      id: "e0:vacuumKing",
      left: 1,
    });
  });

  it("critOffBalance (The Red Dot): crits inflict Off-Balance (boss: chip 1)", () => {
    const bs = makeBattle(["ratThug"], {
      hooks: { trickster: ["critOffBalance"] },
    });
    setQueue(bs, ["cat:trickster"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.05]), // crit
    );
    expect(damages(r.events)[0].crit).toBe(true);
    expect(hasStatus(byId(r.state, "e0:ratThug"), "offBalance")).toBe(true);

    const boss = makeBattle(["vacuumKing"], {
      canFlee: false,
      encounterIndex: 0,
      hooks: { trickster: ["critOffBalance"] },
    });
    setQueue(boss, ["cat:trickster"]);
    const rb = resolveAction(
      boss,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:vacuumKing" },
      new ScriptedRng([1, 0.05]),
    );
    expect(rb.events).toContainEqual({
      t: "poiseChip",
      id: "e0:vacuumKing",
      left: 2,
    });
  });

  it("appliesAlwaysHit (Grandmother's Cursed Yarn): status chances draw no roll", () => {
    const bs = makeBattle(["ratThug"], {
      hooks: { hexer: ["appliesAlwaysHit"] },
    });
    byId(bs, "cat:hexer").energy = 4;
    setQueue(bs, ["cat:hexer"]);
    // exactly 2 draws (variance, crit) — a 0.9-chance roll would exhaust it
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "hairballHex", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    expect(hasStatus(byId(r.state, "e0:ratThug"), "scratched")).toBe(true);
  });

  it("healsGrantMending (Bell of Purrfect Pitch): heals add Mending 2", () => {
    const bs = makeBattle(["ratThug"], {
      hooks: { medic: ["healsGrantMending"] },
    });
    byId(bs, "cat:bruiser").hp = 20;
    setQueue(bs, ["cat:medic"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "soothingPurr", targetId: "cat:bruiser" },
      noRng, // heals draw nothing
    );
    expect(r.events).toContainEqual({
      t: "heal",
      id: "cat:bruiser",
      amount: 11, // round(1.2 × 9)
      source: "soothingPurr",
    });
    const bruno = byId(r.state, "cat:bruiser");
    expect(bruno.statuses).toContainEqual({
      id: "mending",
      value: 2,
      duration: 2,
    });
  });

  it("moverOffBalance (Static-Charged Fluff): the enemy mover goes Off-Balance", () => {
    const bs = makeBattle(["roombaScout"], {
      hooks: { bruiser: ["moverOffBalance"] },
    });
    setQueue(bs, ["e0:roombaScout"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "ram", targetId: "cat:bruiser" },
      new ScriptedRng([1, 0.9]),
    );
    expect(byId(r.state, "cat:bruiser").rank).toBe(2); // still shoved
    expect(hasStatus(byId(r.state, "e0:roombaScout"), "offBalance")).toBe(true);
  });

  it("ninthBell (The Ninth Bell): the standup Life loss is prevented once", () => {
    const bs = makeBattle(["ratThug"], { hooks: { trickster: ["ninthBell"] } });
    const pixel = byId(bs, "cat:trickster");
    pixel.ko = true;
    pixel.hp = 0;
    byId(bs, "cat:hexer").rank = 2;
    byId(bs, "cat:medic").rank = 3;
    byId(bs, "e0:ratThug").hp = 1;
    setQueue(bs, ["cat:bruiser"]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:ratThug" },
      new ScriptedRng([1, 0.9]),
    );
    expect(r.state.outcome).toBe("victory");
    expect(r.events).toContainEqual({ t: "lifeSaved", id: "cat:trickster" });
    expect(byId(r.state, "cat:trickster").lives).toBe(9);
    expect(battleResult(r.state, r.events).ninthBellSpent).toBe(true);
  });

  it("catPileDouble (Alpha Beetle): the wearer's atk counts twice", () => {
    const bs = makeBattle(["ratThug", "ratThug"], {
      hooks: { trickster: ["catPileDouble"] },
    });
    setQueue(bs, ["cat:trickster"]);
    for (const e of living(bs, "enemy")) applyStatus(e, "offBalance");
    const r = resolveAction(bs, { type: "guard" }, noRng);
    // floor(0.30 × (10 + 12·2 + 11 + 9)) = floor(16.2) = 16
    expect(r.events).toContainEqual({ t: "catPilePrompt", damageEach: 16 });
  });

  it("startEnergy6 (Ball of Pure Yarn): the wearer starts battles at 6 Energy", () => {
    const bs = makeBattle(["ratThug"], { hooks: { medic: ["startEnergy6"] } });
    expect(byId(bs, "cat:medic").energy).toBe(6);
    expect(byId(bs, "cat:bruiser").energy).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* misc engine behavior                                                */
/* ------------------------------------------------------------------ */

describe("engine behavior", () => {
  it("previewDamage: variance 1.0, no crit, current statuses", () => {
    const bs = makeBattle(["ratThug"]);
    expect(previewDamage(bs, "clawSwipe", "cat:trickster", "e0:ratThug")).toBe(
      11,
    );
    applyStatus(byId(bs, "e0:ratThug"), "offBalance");
    expect(previewDamage(bs, "clawSwipe", "cat:trickster", "e0:ratThug")).toBe(
      17,
    );
  });

  it("legalActions: rank gates, energy gates, targets", () => {
    const bs = makeBattle(["ratThug"]);
    setQueue(bs, ["cat:trickster"]);
    const la = legalActions(bs);
    expect(la.actorId).toBe("cat:trickster");
    const byIdOpt = Object.fromEntries(la.skills.map((s) => [s.skillId, s]));
    expect(byIdOpt.clawSwipe.ok).toBe(true);
    expect(byIdOpt.pounce.ok).toBe(false); // rank 2, needs 3-4
    expect(byIdOpt.tripWire.ok).toBe(true); // cost 4 ≤ post-regen 6
    expect(la.canMoveForward).toBe(true);
    expect(la.canMoveBack).toBe(true);
    expect(la.canGuard).toBe(true);
  });

  it("energy: regen caps at enMax; costs are enforced", () => {
    const bs = makeBattle(["ratThug"]);
    byId(bs, "cat:bruiser").energy = 9;
    byId(bs, "cat:trickster").energy = 0;
    setQueue(bs, ["cat:bruiser", "cat:trickster"]);
    const r = resolveAction(bs, { type: "guard" }, noRng);
    expect(byId(r.state, "cat:bruiser").energy).toBe(10); // 9+2 capped, +2 guard → 10
    expect(() =>
      resolveAction(r.state, { type: "skill", skillId: "tripWire" }, noRng),
    ).toThrow(); // 0+2 regen < cost 4
  });

  it("same seed + same action script ⇒ identical event log and state", () => {
    const play = () => {
      let bs = makeBattle(["ratThug", "ratThug", "crowShaman"], {
        traits: {
          bruiser: ["immovableLoaf"],
          trickster: ["opportunist"],
          hexer: ["stringTheory"],
          medic: ["purrEngine"],
        },
      });
      const rng = mulberry32(hash("MEOW-1987", 1, 1));
      const log: BattleEvent[] = [];
      for (let round = 0; round < 3 && bs.outcome === "ongoing"; round++) {
        const rs = startRound(bs, rng);
        bs = rs.state;
        log.push(...rs.events);
        let actor = nextActor(bs);
        while (actor && bs.outcome === "ongoing") {
          const action =
            actor.side === "enemy"
              ? takeEnemyTurn(actor, bs, rng)
              : ({ type: "guard" } as const);
          const frozen = JSON.stringify(bs);
          const rr = resolveAction(bs, action, rng);
          expect(JSON.stringify(bs)).toBe(frozen); // purity: input untouched
          bs = rr.state;
          log.push(...rr.events);
          if (bs.catPilePrompt) {
            const pr = resolveAction(
              bs,
              { type: "catPile", accept: true },
              rng,
            );
            bs = pr.state;
            log.push(...pr.events);
          }
          actor = nextActor(bs);
        }
      }
      return { bs, log };
    };
    const a = play();
    const b = play();
    expect(a.log).toEqual(b.log);
    expect(a.bs).toEqual(b.bs);
    expect(a.log.length).toBeGreaterThan(20);
  });

  it("item heals use the locked flat numbers (Tuna 12, Sardine full)", () => {
    const bs = makeBattle(["ratThug"]);
    const bruno = byId(bs, "cat:bruiser");
    bruno.hp = 10;
    setQueue(bs, ["cat:medic", "cat:medic"]);
    const r1 = resolveAction(
      bs,
      { type: "item", itemId: "tunaSnack", targetId: "cat:bruiser" },
      noRng, // zero battle-stream rolls
    );
    expect(byId(r1.state, "cat:bruiser").hp).toBe(22);
    const r2 = resolveAction(
      r1.state,
      { type: "item", itemId: "sardineTin", targetId: "cat:bruiser" },
      noRng,
    );
    expect(byId(r2.state, "cat:bruiser").hp).toBe(40);
  });

  it("Catnip's energyGain is target-directed for item skills", () => {
    const bs = makeBattle(["ratThug"]);
    setQueue(bs, ["cat:medic"]);
    const r = resolveAction(
      bs,
      { type: "item", itemId: "catnip", targetId: "cat:bruiser" },
      noRng,
    );
    expect(byId(r.state, "cat:bruiser").energy).toBe(6); // 4 + 2
    expect(byId(r.state, "cat:medic").energy).toBe(6); // regen only
  });

  it("enemies with nothing usable Advance one rank (voluntary, no Off-Balance)", () => {
    const bs = makeBattle(["ratThug", "ratThug", "crowShaman"]);
    // shove the crow's neighbours away conceptually: park the crow at rank 3
    // with only 'hex' (usableFrom 2-4) on cooldown → nothing usable
    const crow = byId(bs, "e2:crowShaman");
    crow.skills = ["hex"];
    crow.cooldowns = { hex: 3 };
    const act = takeEnemyTurn(crow, bs, noRng);
    expect(act).toEqual({ type: "advance" });
    setQueue(bs, ["e2:crowShaman"]);
    const r = resolveAction(bs, act, noRng);
    const moved = byId(r.state, "e2:crowShaman");
    expect(moved.rank).toBe(2);
    expect(hasStatus(moved, "offBalance")).toBe(false);
  });
});
