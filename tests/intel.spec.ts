/**
 * ENEMY INTEL — docs/design/enemy-intel.md §§1, 2, 4.
 *
 *  §1  the data model: derived levels, and weaknesses that are MODIFIERS
 *      (if inspecting an enemy would not change how you play, the data is
 *      decoration — so every expectation here is a number that moved)
 *  §2  declared intents: truthful, bound, and drawn from the same seeded
 *      stream one step earlier — proved by replaying seeds
 *  §4  the Bestiary: knowledge accrual, `???` rather than omission, and the
 *      v2 → v3 meta migration
 *
 * Nothing here asserts a number the engine produced: every expectation is
 * computed by hand from the docs.
 */
import { describe, expect, it } from "vitest";
import type {
  BattleAction,
  BattleEvent,
  BattleState,
  ClassId,
  DeclaredIntent,
  Rng,
  SkillId,
} from "../src/core/types.js";
import { CLASSES } from "../src/content/classes.js";
import { SKILLS } from "../src/content/skills.js";
import {
  baseLevel,
  BOSS_LEVEL_BONUS,
  curveLevelSteps,
  ENEMIES,
  enemyLevel,
  LEVEL_BY_TIER,
  OFF_BALANCE_RESIST_BY_TIER,
} from "../src/content/enemies.js";
import { BOSS_ENCOUNTERS } from "../src/content/bosses.js";
import { createBattle } from "../src/core/combat/setup.js";
import {
  byId,
  legalActions,
  offBalanceResistOf,
  previewDamage,
  resistsTag,
  SHOVE_RESIST_MULT,
  SHOVE_WEAK_MULT,
  weakTo,
} from "../src/core/combat/state.js";
import { resolveAction } from "../src/core/combat/resolve.js";
import { nextActor, startRound } from "../src/core/combat/turns.js";
import { takeEnemyTurn } from "../src/core/combat/ai.js";
import { declaredIntents, intentFor } from "../src/core/combat/intent.js";
import { mulberry32 } from "../src/core/rng.js";
import {
  actedThisBattle,
  allSkillsOf,
  emptyKnowledge,
  hasIntelGrace,
  intentsVisibleFor,
  KILLS_TO_COMPLETE,
  knownIntel,
  maskIntent,
  observeBattle,
  readBestiary,
} from "../src/core/meta/bestiary.js";
import type { Bestiary } from "../src/core/meta/bestiary.js";
import {
  emptyProfile,
  META_VERSION,
  migrateMeta,
  recordBattle,
} from "../src/core/meta/profile.js";

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

const ALL4: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

function battle(
  order: readonly ClassId[],
  enemies: string[],
  kits: Partial<Record<ClassId, SkillId[]>> = {},
): BattleState {
  return createBattle({
    cats: order.map((id) => {
      const cls = CLASSES[id];
      return {
        classId: id,
        name: cls.catName,
        stats: { ...cls.base },
        hp: cls.base.hp,
        lives: 9,
        skills:
          kits[id] ??
          cls.skills.filter((s) => s.unlockLevel <= 1).map((s) => s.skillId),
        traits: [],
        hooks: [],
        startEnergyBonus: 0,
      };
    }),
    enemies,
    encounterIndex: 1,
    canFlee: true,
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

const damages = (
  evs: readonly BattleEvent[],
): Extract<BattleEvent, { t: "damage" }>[] =>
  evs.filter(
    (e): e is Extract<BattleEvent, { t: "damage" }> => e.t === "damage",
  );

const intels = (
  evs: readonly BattleEvent[],
): Extract<BattleEvent, { t: "intel" }>[] =>
  evs.filter((e): e is Extract<BattleEvent, { t: "intel" }> => e.t === "intel");

/* ================================================================== */
/* §1 — the data model                                                 */
/* ================================================================== */

describe("§1 enemy data model", () => {
  it("every def carries a description, a tell and both intel lists", () => {
    for (const [id, def] of Object.entries(ENEMIES)) {
      expect(def.description.length, `${id} description`).toBeGreaterThan(20);
      expect(def.tell.length, `${id} tell`).toBeGreaterThan(10);
      expect(Array.isArray(def.weaknesses), `${id} weaknesses`).toBe(true);
      expect(Array.isArray(def.resistances), `${id} resistances`).toBe(true);
      // a tag cannot be both — `resistsTag` gives the weakness priority, but
      // authoring both is a mistake, not a feature
      for (const w of def.weaknesses) {
        expect(def.resistances, `${id} declares ${w} twice`).not.toContain(w);
      }
    }
  });

  it("levels are DERIVED from tier + the floor curve, never hand-typed", () => {
    expect(LEVEL_BY_TIER).toEqual({ 1: 1, 2: 4, 3: 7 });
    for (const [id, def] of Object.entries(ENEMIES)) {
      expect(def.level, `${id} level`).toBe(baseLevel(def.tier, !!def.boss));
    }
    // the curve's own rows, read as rungs: floors 1..6 → 0,2,5,6,6,6
    expect([1, 2, 3, 4, 5, 6].map(curveLevelSteps)).toEqual([0, 2, 5, 6, 6, 6]);
    expect(enemyLevel(ENEMIES.ratThug, 1)).toBe(1);
    expect(enemyLevel(ENEMIES.ratThug, 3)).toBe(6);
    expect(enemyLevel(ENEMIES.ratThug, 6)).toBe(7);
    expect(enemyLevel(ENEMIES.trashPanda, 6)).toBe(13); // 7 + 6
    // the ladder never goes DOWN as you descend, and never hangs on a float:
    // floor 4 is exactly 5.5 rungs and must round half-UP to 6.
    const steps = [1, 2, 3, 4, 5, 6].map(curveLevelSteps);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    }
  });

  it("bosses are off the curve, so their level does not move with the floor", () => {
    for (const id of Object.keys(BOSS_ENCOUNTERS)) {
      const def = ENEMIES[id];
      expect(def.boss).toBeDefined();
      expect(def.level).toBe(LEVEL_BY_TIER[def.tier] + BOSS_LEVEL_BONUS);
      expect(enemyLevel(def, 1)).toBe(enemyLevel(def, 6));
    }
  });

  it("folds the tier Off-Paw resistance into `resistances` — one system", () => {
    const bs = battle(ALL4, [
      "ratThug",
      "roombaScout",
      "trashPanda",
      "porcelainHound",
    ]);
    // the balance pass's numbers, unchanged (balance-and-meta.md §1.1)
    expect(offBalanceResistOf(byId(bs, "e0:ratThug"))).toBe(0); // T1
    expect(offBalanceResistOf(byId(bs, "e1:roombaScout"))).toBe(
      OFF_BALANCE_RESIST_BY_TIER[2],
    );
    expect(offBalanceResistOf(byId(bs, "e2:trashPanda"))).toBe(
      OFF_BALANCE_RESIST_BY_TIER[3],
    );
    expect(offBalanceResistOf(byId(bs, "cat:bruiser"))).toBe(0);
    // …with exactly one deliberate exception: the hollow hound is WEAK to
    // being knocked over, so its tier gate is 0 and Off-Paw always lands.
    expect(weakTo(byId(bs, "e3:porcelainHound"), "offBalance")).toBe(true);
    expect(offBalanceResistOf(byId(bs, "e3:porcelainHound"))).toBe(0);
  });

  it("every other tier-2/3 mook still DECLARES the tier resistance", () => {
    for (const [id, def] of Object.entries(ENEMIES)) {
      if (def.boss || def.tier === 1) continue;
      const declared =
        def.resistances.includes("offBalance") ||
        def.weaknesses.includes("offBalance");
      expect(declared, `${id} silently dropped its tier gate`).toBe(true);
    }
  });

  it("bosses never reach the tier gate at all (heavy + Poise, §11.1)", () => {
    const bs = battle(ALL4, ["vacuumKing"]);
    expect(offBalanceResistOf(byId(bs, "e0:vacuumKing"))).toBe(0);
  });
});

/* ================================================================== */
/* §1 — weaknesses are MECHANICAL                                      */
/* ================================================================== */

describe("§1 shove-type damage modifiers", () => {
  it("a shove weakness multiplies the hit by 1.25, exactly once", () => {
    expect(SHOVE_WEAK_MULT).toBe(1.25);
    const bs = battle(ALL4, ["dustBunny"]);
    setQueue(bs, ["cat:bruiser"]);
    // Body Slam 120% × ATK 10 = 12 × 1.25 = 15 − DEF 2 = 13 (plain: 12 − 2 = 10)
    const rng = new ScriptedRng([1, 0.9]); // variance ×1.0, no crit
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:dustBunny" },
      rng,
    );
    expect(rng.used).toBe(2); // intel costs NO entropy
    expect(damages(r.events)[0]).toMatchObject({ amount: 13, crit: false });
    expect(intels(r.events)).toEqual([
      { t: "intel", id: "e0:dustBunny", tag: "shove", effect: "weak" },
    ]);
  });

  it("a shove resistance multiplies it by 0.80", () => {
    expect(SHOVE_RESIST_MULT).toBe(0.8);
    const bs = battle(ALL4, ["sewerBat"]);
    setQueue(bs, ["cat:bruiser"]);
    // 12 × 0.8 = 9.6 → 10 − DEF 0 = 10 (plain: 12)
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:sewerBat" },
      new ScriptedRng([1, 0.9]),
    );
    expect(damages(r.events)[0]).toMatchObject({ amount: 10 });
    expect(intels(r.events)).toEqual([
      { t: "intel", id: "e0:sewerBat", tag: "shove", effect: "resist" },
    ]);
  });

  it("only SHOVE-type skills carry it — a plain claw is untouched", () => {
    const bs = battle(ALL4, ["dustBunny"]);
    setQueue(bs, ["cat:bruiser"]);
    // Claw Swipe 100% × 10 = 10 − DEF 2 = 8, no moveTarget, no modifier
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:dustBunny" },
      new ScriptedRng([1, 0.9]),
    );
    expect(damages(r.events)[0]).toMatchObject({ amount: 8 });
    expect(intels(r.events)).toEqual([]);
  });

  it("a row shove applies it ONCE PER TARGET, never twice to one", () => {
    const bs = battle(ALL4, ["dustBunny", "dustBunny"]);
    setQueue(bs, ["cat:trickster"]);
    // Trip Wire 60% × ATK 12 = 7.2 × 1.25 = 9 − DEF 2 = 7 each
    // (plain: 7.2 → 7 − 2 = 5; twice-applied would be 11.25 → 11 − 2 = 9)
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "tripWire" },
      new ScriptedRng([1, 0.9, 1, 0.9, 0.9, 0.9]),
    );
    expect(damages(r.events).map((d) => d.amount)).toEqual([7, 7]);
    expect(intels(r.events).filter((e) => e.tag === "shove")).toHaveLength(2);
  });

  it("previewDamage carries it too, so a telegraph never lies", () => {
    const bs = battle(ALL4, ["dustBunny"]);
    expect(previewDamage(bs, "bodySlam", "cat:bruiser", "e0:dustBunny")).toBe(
      13,
    );
    expect(previewDamage(bs, "clawSwipe", "cat:bruiser", "e0:dustBunny")).toBe(
      8,
    );
  });
});

describe("§1 status weaknesses and resistances", () => {
  it("a resisted status NEVER lands, and its chance roll is not drawn", () => {
    expect(
      resistsTag(
        byId(battle(ALL4, ["roombaScout"]), "e0:roombaScout"),
        "scratched",
      ),
    ).toBe(true);
    const bs = battle(ALL4, ["roombaScout"], { hexer: ["hairballHex"] });
    setQueue(bs, ["cat:hexer"]);
    const rng = new ScriptedRng([1, 0.9]); // variance + crit ONLY
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "hairballHex", targetId: "e0:roombaScout" },
      rng,
    );
    expect(rng.used).toBe(2); // the 0.9 scratched roll was never drawn
    expect(byId(r.state, "e0:roombaScout").statuses).toEqual([]);
    expect(intels(r.events)).toEqual([
      { t: "intel", id: "e0:roombaScout", tag: "scratched", effect: "resist" },
    ]);
  });

  it("a status weakness ALWAYS lands, and its chance roll is not drawn", () => {
    const bs = battle(ALL4, ["ratThug"], { hexer: ["phantomCucumber"] });
    setQueue(bs, ["cat:hexer"]);
    const rng = new ScriptedRng([1, 0.9]); // the 0.8 frazzle roll is skipped
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "phantomCucumber", targetId: "e0:ratThug" },
      rng,
    );
    expect(rng.used).toBe(2);
    expect(byId(r.state, "e0:ratThug").statuses.map((s) => s.id)).toContain(
      "frazzled",
    );
    expect(intels(r.events)).toContainEqual({
      t: "intel",
      id: "e0:ratThug",
      tag: "frazzled",
      effect: "weak",
    });
  });

  it("an unremarkable target still rolls its chance, exactly as before", () => {
    const bs = battle(ALL4, ["crowShaman"], { hexer: ["phantomCucumber"] });
    setQueue(bs, ["cat:hexer"]);
    const rng = new ScriptedRng([1, 0.9, 0.9]); // 0.9 ≥ 0.8 → no frazzle
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "phantomCucumber", targetId: "e0:crowShaman" },
      rng,
    );
    expect(rng.used).toBe(3);
    expect(byId(r.state, "e0:crowShaman").statuses).toEqual([]);
    expect(intels(r.events)).toEqual([]);
  });

  it("an offBalance weakness skips the TIER roll but keeps the skill's gate", () => {
    const bs = battle(ALL4, ["porcelainHound", "ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    // variance, crit, Body Slam's 0.70 gate — and NO tier roll (T3 = 0.40)
    const rng = new ScriptedRng([1, 0.9, 0.3]);
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:porcelainHound" },
      rng,
    );
    expect(rng.used).toBe(3);
    const hound = byId(r.state, "e0:porcelainHound");
    expect(hound.statuses.map((s) => s.id)).toContain("offBalance");
    expect(intels(r.events)).toContainEqual({
      t: "intel",
      id: "e0:porcelainHound",
      tag: "offBalance",
      effect: "weak",
    });
  });

  it("a tier resistance still draws its roll and reports itself", () => {
    const bs = battle(ALL4, ["trashPanda", "ratThug"]);
    setQueue(bs, ["cat:bruiser"]);
    const rng = new ScriptedRng([1, 0.9, 0.3, 0.1]); // 0.1 < 0.40 → shrugged
    const r = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:trashPanda" },
      rng,
    );
    expect(rng.used).toBe(4);
    expect(byId(r.state, "e0:trashPanda").statuses).toEqual([]);
    expect(intels(r.events)).toContainEqual({
      t: "intel",
      id: "e0:trashPanda",
      tag: "offBalance",
      effect: "resist",
    });
  });
});

/* ================================================================== */
/* §2 — declared intents                                               */
/* ================================================================== */

/** A dumb but legal cat: claw the front enemy if you can reach it, else Guard. */
function takeCatTurn(bs: BattleState, actorId: string): BattleAction {
  const opts = legalActions(bs);
  const claw = opts.skills.find((s) => s.skillId === "clawSwipe");
  if (opts.actorId === actorId && claw?.ok && claw.targetIds.length > 0) {
    return { type: "skill", skillId: "clawSwipe", targetId: claw.targetIds[0] };
  }
  return { type: "guard" };
}

/** Drive a whole battle with both sides acting; returns the full log. */
function playOut(
  seed: number,
  enemies: string[],
  maxRounds = 12,
): { log: BattleEvent[]; state: BattleState } {
  const rng = mulberry32(seed);
  let bs = battle(ALL4, enemies);
  const log: BattleEvent[] = [];
  for (let round = 0; round < maxRounds && bs.outcome === "ongoing"; round++) {
    const r = startRound(bs, rng);
    bs = r.state;
    log.push(...r.events);
    for (;;) {
      if (bs.outcome !== "ongoing") break;
      if (bs.catPilePrompt) {
        const res = resolveAction(bs, { type: "catPile", accept: true }, rng);
        bs = res.state;
        log.push(...res.events);
        continue;
      }
      const actor = nextActor(bs);
      if (!actor) break;
      const action =
        actor.side === "cat"
          ? takeCatTurn(bs, actor.id)
          : takeEnemyTurn(actor, bs, rng);
      const res = resolveAction(bs, action, rng);
      bs = res.state;
      log.push(...res.events);
    }
  }
  return { log, state: bs };
}

describe("§2 declared intents", () => {
  it("startRound publishes one truthful intent per living enemy", () => {
    const bs = battle(ALL4, ["ratThug", "crowShaman"]);
    const r = startRound(bs, mulberry32(7));
    const rat = intentFor(r.state, "e0:ratThug")!;
    const crow = intentFor(r.state, "e1:crowShaman")!;
    expect(rat.kind).toBe("strike");
    expect(rat.skillId).toBe("shiv");
    expect(rat.targetId).toBe("cat:bruiser"); // wounded-tie → lowest rank
    expect(rat.value).toBe(
      previewDamage(r.state, "shiv", "e0:ratThug", "cat:bruiser"),
    );
    expect(crow.skillId).toBe("hex"); // from rank 2 the hex is live
    // published as events too, in queue order
    const declared = r.events.filter((e) => e.t === "intent");
    expect(declared).toHaveLength(2);
    // cats never declare
    expect(intentFor(r.state, "cat:bruiser")).toBeNull();
  });

  it("the intent IS the action — declared == executed, over many seeds", () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      let bs = battle(ALL4, ["ratThug", "crowShaman", "roombaScout"]);
      for (let round = 0; round < 8 && bs.outcome === "ongoing"; round++) {
        bs = startRound(bs, rng).state;
        for (;;) {
          if (bs.outcome !== "ongoing" || bs.catPilePrompt) break;
          const actor = nextActor(bs);
          if (!actor) break;
          const intent =
            actor.side === "enemy" ? intentFor(bs, actor.id) : null;
          const action =
            actor.side === "cat"
              ? ({ type: "guard" } as const)
              : takeEnemyTurn(actor, bs, rng);
          const res = resolveAction(bs, action, rng);
          const broke = res.events.some((e) => e.t === "intentBroken");
          if (intent && !broke && intent.targetId) {
            if (intent.kind === "strike" || intent.kind === "shove") {
              const hit = damages(res.events)[0];
              expect(hit?.source).toBe(intent.skillId);
              expect(hit?.id).toBe(intent.targetId);
              checked++;
            }
          }
          bs = res.state;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("is deterministic: the same seed replays byte-identical logs", () => {
    for (const seed of [1, 2, 3, 11, 97, 4242]) {
      const a = playOut(seed, ["ratThug", "crowShaman", "sprinklerImp"]);
      const b = playOut(seed, ["ratThug", "crowShaman", "sprinklerImp"]);
      expect(JSON.stringify(b.log)).toEqual(JSON.stringify(a.log));
      expect(b.state.outcome).toBe(a.state.outcome);
    }
  });

  it("a dead target retargets the SAME skill and says so", () => {
    const bs = battle(ALL4, ["ratThug"]);
    const r = startRound(bs, mulberry32(7));
    let s = r.state;
    const intent = intentFor(s, "e0:ratThug")!;
    expect(intent.targetId).toBe("cat:bruiser");
    // Bruno leaves the field before the rat's slot
    s = {
      ...s,
      combatants: s.combatants.map((c) =>
        c.id === "cat:bruiser" ? { ...c, hp: 0, ko: true } : c,
      ),
    };
    setQueue(s, ["e0:ratThug"]);
    s.round = r.state.round;
    s.intents = r.state.intents;
    const rat = byId(s, "e0:ratThug");
    const action = takeEnemyTurn(rat, s, mulberry32(1));
    expect(action).toMatchObject({ type: "skill", skillId: "shiv" });
    const res = resolveAction(s, action, new ScriptedRng([1, 0.9]));
    expect(res.events).toContainEqual({
      t: "intentBroken",
      id: "e0:ratThug",
      reason: "retargeted",
    });
    expect(damages(res.events)[0].source).toBe("shiv");
    expect(damages(res.events)[0].id).not.toBe("cat:bruiser");
  });

  it("rank denial breaks the telegraph: the Crow loses its hex and re-picks", () => {
    // the §13 scenario: the Crow declares its hex from rank 3, then Mora
    // yanks it to rank 1 where the hex is illegal.
    const bs = battle(ALL4, ["ratThug", "ratThug", "crowShaman"], {
      hexer: ["yankOfYarn"],
    });
    const rng = mulberry32(7);
    let s = startRound(bs, rng).state;
    expect(intentFor(s, "e2:crowShaman")!.skillId).toBe("hex");
    setQueue(s, ["cat:hexer", "e0:crowShaman"]);
    s.round = 1;
    const pull = resolveAction(
      s,
      { type: "skill", skillId: "yankOfYarn", targetId: "e2:crowShaman" },
      new ScriptedRng([1, 0.9, 0.3]),
    );
    s = pull.state;
    expect(byId(s, "e2:crowShaman").rank).toBe(1);
    const crow = byId(s, "e2:crowShaman");
    setQueue(s, ["e2:crowShaman"]);
    s.round = 1;
    const action = takeEnemyTurn(crow, s, mulberry32(3));
    expect(action).toMatchObject({ type: "skill", skillId: "peck" });
    const res = resolveAction(s, action, new ScriptedRng([1, 0.9]));
    expect(res.events).toContainEqual({
      t: "intentBroken",
      id: "e2:crowShaman",
      reason: "rechosen",
    });
  });

  it("a double-turn boss declares its FIRST slot and leaves the second unknown", () => {
    const bs = battle(ALL4, ["vacuumKing"]);
    const r = startRound(bs, mulberry32(5));
    expect(
      r.state.queue.filter((e) => e.combatantId === "e0:vacuumKing"),
    ).toHaveLength(2);
    expect(Object.keys(r.state.intents!)).toEqual(["e0:vacuumKing"]);
    const first = intentFor(r.state, "e0:vacuumKing")!;
    expect(first.kind).not.toBe("unknown");
    // once the first slot resolves the declaration is spent…
    // isolate the boss's two slots so the cats do not act in between
    const s0: BattleState = {
      ...r.state,
      queue: r.state.queue.filter((e) => e.combatantId === "e0:vacuumKing"),
      queueIndex: 0,
    };
    const boss = byId(s0, "e0:vacuumKing");
    const rng = mulberry32(5);
    const after = resolveAction(s0, takeEnemyTurn(boss, s0, rng), rng).state;
    expect(intentFor(after, "e0:vacuumKing")).toBeNull();
    // …and the UI is told `unknown` rather than a stale lie
    expect(declaredIntents(after)[0]).toMatchObject({ kind: "unknown" });
  });

  it("labels a shove as a SHOVE even though it also deals damage", () => {
    const bs = battle(ALL4, ["roombaScout"]);
    const r = startRound(bs, mulberry32(9));
    const intent = intentFor(r.state, "e0:roombaScout")!;
    expect(SKILLS[intent.skillId!].moveTarget).toBeTruthy();
    expect(intent.kind).toBe("shove");
    expect(intent.value).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* §4 — the Bestiary                                                   */
/* ================================================================== */

describe("§4 knowledge accrual", () => {
  it("meeting, being hit, seeing intel fire and killing all record", () => {
    const { log, state } = playOut(4, ["ratThug", "ratThug"]);
    const b = observeBattle({}, state, log);
    expect(b.ratThug.met).toBe(1); // one battle, not one per body
    expect(b.ratThug.skills).toEqual(["shiv"]);
    expect(b.ratThug.kills).toBe(
      log.filter((e) => e.t === "ko" && e.id.startsWith("e")).length,
    );
  });

  it("records a weakness only when the player watched it fire", () => {
    const bs = battle(ALL4, ["dustBunny"]);
    setQueue(bs, ["cat:bruiser"]);
    const plain = resolveAction(
      bs,
      { type: "skill", skillId: "clawSwipe", targetId: "e0:dustBunny" },
      new ScriptedRng([1, 0.9]),
    );
    expect(observeBattle({}, plain.state, plain.events).dustBunny.weak).toEqual(
      [],
    );
    const shove = resolveAction(
      bs,
      { type: "skill", skillId: "bodySlam", targetId: "e0:dustBunny" },
      new ScriptedRng([1, 0.9]),
    );
    expect(observeBattle({}, shove.state, shove.events).dustBunny.weak).toEqual(
      ["shove"],
    );
  });

  it("accumulates across battles and completes at KILLS_TO_COMPLETE", () => {
    let meta = emptyProfile();
    for (let i = 0; i < KILLS_TO_COMPLETE; i++) {
      const { log, state } = playOut(100 + i, ["dustBunny"]);
      meta = recordBattle(meta, state, log);
    }
    const k = meta.bestiary!.dustBunny;
    expect(k.met).toBe(KILLS_TO_COMPLETE);
    expect(k.kills).toBe(KILLS_TO_COMPLETE);
    expect(knownIntel(meta, "dustBunny").complete).toBe(true);
    expect(knownIntel(meta, "dustBunny").killsToComplete).toBe(0);
  });
});

describe("§4 knownIntel — unknown is REPORTED, never omitted", () => {
  const def = ENEMIES.trashPanda;

  it("a stranger reports every fact as unknown, with a full checklist", () => {
    const view = knownIntel(emptyProfile(), "trashPanda", 5);
    expect(view.exists).toBe(true);
    expect(view.name).toEqual({ known: false, value: null });
    expect(view.level).toEqual({ known: false, value: null });
    expect(view.description.known).toBe(false);
    // the ROWS are all there — the UI renders ??? in place
    expect(view.skills.map((s) => s.id)).toEqual(allSkillsOf(def));
    expect(view.skills.every((s) => !s.known)).toBe(true);
    expect(view.weaknesses.map((w) => w.tag)).toEqual(def.weaknesses);
    expect(view.resistances.map((r) => r.tag)).toEqual(def.resistances);
    expect(view.unknownCount).toBe(
      5 + def.skills.length + def.weaknesses.length + def.resistances.length,
    );
    expect(view.intentsVisible).toBe(false);
  });

  it("meeting it opens name / level / tier / description / tell only", () => {
    const meta = {
      ...emptyProfile(),
      bestiary: { trashPanda: { ...emptyKnowledge(), met: 1 } } as Bestiary,
    };
    const view = knownIntel(meta, "trashPanda", 5);
    expect(view.name.value).toBe("Trash Panda");
    expect(view.level.value).toBe(enemyLevel(def, 5)); // 7 + 5 rungs
    expect(view.tell.known).toBe(true);
    expect(view.skills.every((s) => !s.known)).toBe(true);
    expect(view.weaknesses.every((w) => !w.known)).toBe(true);
    expect(view.intentsVisible).toBe(true);
  });

  it("a completed entry opens everything, including unseen skills", () => {
    const meta = {
      ...emptyProfile(),
      bestiary: {
        trashPanda: { ...emptyKnowledge(), met: 3, kills: KILLS_TO_COMPLETE },
      } as Bestiary,
    };
    const view = knownIntel(meta, "trashPanda", 6);
    expect(view.complete).toBe(true);
    expect(view.skills.every((s) => s.known)).toBe(true);
    expect(view.weaknesses.every((w) => w.known)).toBe(true);
    expect(view.resistances.every((r) => r.known)).toBe(true);
    expect(view.unknownCount).toBe(0);
  });

  it("an id this build does not ship reports as non-existent, not a crash", () => {
    const view = knownIntel(emptyProfile(), "hedgehogMafia");
    expect(view.exists).toBe(false);
    expect(view.name.known).toBe(false);
    expect(view.skills).toEqual([]);
  });
});

describe("§2/§5 intent visibility", () => {
  it("is hidden for a first-timer until it acts, then remembered forever", () => {
    const fresh = emptyProfile();
    expect(intentsVisibleFor(fresh, "ratThug")).toBe(false);
    expect(intentsVisibleFor(fresh, "ratThug", true)).toBe(true);
    const { log, state } = playOut(11, ["ratThug"]);
    expect(actedThisBattle(state, log)).toContain("ratThug");
    const after = recordBattle(fresh, state, log);
    expect(intentsVisibleFor(after, "ratThug")).toBe(true);
  });

  it("masks the telegraph into `unknown` — no icon, no number", () => {
    const intent: DeclaredIntent = {
      id: "e0:ratThug",
      kind: "strike",
      skillId: "shiv",
      targetId: "cat:bruiser",
      value: 6,
      round: 1,
    };
    expect(maskIntent(intent, true)).toBe(intent);
    expect(maskIntent(intent, false)).toEqual({
      id: "e0:ratThug",
      kind: "unknown",
      value: 0,
      round: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/* the floor-1 novice grace                                            */
/* ------------------------------------------------------------------ */
//
// "Learning is the reward" only works if the first lesson is legible. A
// brand-new player's very first floor used to be a wall of `?` — no names,
// no levels, no telegraphs — at the exact moment they were learning what a
// telegraph is. Floor 1 of run 1 now opens the BASICS of tier-1 enemies on
// sight, and nothing else: skills, weaknesses and resistances are still
// earned by watching them fire.

describe("first-run floor-1 intel grace", () => {
  const novice = emptyProfile(); // counters.runs === 0
  const veteran: MetaProfile = {
    ...emptyProfile(),
    counters: { runs: 1, victories: 0 },
  };

  it("opens name / level / tier / description / tell on sight", () => {
    const view = knownIntel(novice, "ratThug", 1);
    expect(view.met).toBe(0); // never actually met
    expect(view.name.value).toBe(ENEMIES.ratThug.name);
    expect(view.level.known).toBe(true);
    expect(view.tier.known).toBe(true);
    expect(view.description.known).toBe(true);
    expect(view.tell.known).toBe(true);
    expect(view.intentsVisible).toBe(true);
    expect(intentsVisibleFor(novice, "ratThug", false, 1)).toBe(true);
  });

  it("still makes you EARN skills, weaknesses and resistances", () => {
    const view = knownIntel(novice, "ratThug", 1);
    expect(view.skills.every((s) => !s.known)).toBe(true);
    expect(view.weaknesses.every((w) => !w.known)).toBe(true);
    expect(view.resistances.every((r) => !r.known)).toBe(true);
    expect(view.complete).toBe(false);
    expect(view.unknownCount).toBeGreaterThan(0);
  });

  it("does not reach floor 2, tier-2 enemies, or a second run", () => {
    expect(hasIntelGrace(novice, "ratThug", 1)).toBe(true);
    expect(hasIntelGrace(novice, "ratThug", 2)).toBe(false);
    expect(hasIntelGrace(novice, "roombaScout", 1)).toBe(false); // tier 2
    expect(hasIntelGrace(veteran, "ratThug", 1)).toBe(false);
    expect(knownIntel(veteran, "ratThug", 1).name.known).toBe(false);
    expect(knownIntel(novice, "ratThug", 2).name.known).toBe(false);
  });

  it("never applies without a floor — a caller that cannot say gets none", () => {
    expect(intentsVisibleFor(novice, "ratThug")).toBe(false);
  });

  it("the Bestiary page opts OUT: the checklist shows only what was earned", () => {
    const codex = knownIntel(novice, "ratThug", 1, { grace: false });
    expect(codex.name.known).toBe(false);
    expect(codex.intentsVisible).toBe(false);
  });
});

describe("§4 persistence — the v2 → v3 migration", () => {
  it("loads a v2 profile with an empty Bestiary, keeping everything else", () => {
    const m = migrateMeta({
      version: 2,
      counters: { runs: 4, victories: 1 },
      records: { bestScore: 900, fastestVictoryMs: null },
      shinies: 120,
      lifetimeShinies: 300,
      unlocked: ["class:hexer"],
      history: [],
    })!;
    expect(m.version).toBe(META_VERSION);
    expect(m.shinies).toBe(120);
    expect(m.unlocked).toEqual(["class:hexer"]);
    expect(m.bestiary).toEqual({});
  });

  it("repairs a hand-edited Bestiary instead of trusting it", () => {
    const m = migrateMeta({
      version: 3,
      counters: { runs: 1, victories: 0 },
      records: { bestScore: 0, fastestVictoryMs: null },
      shinies: 0,
      lifetimeShinies: 0,
      unlocked: [],
      history: [],
      bestiary: {
        ratThug: {
          met: 1,
          kills: 9, // more kills than meetings
          skills: ["shiv", "theBigBark", 7], // a skill it does not own
          weak: ["frazzled", "instantWin"], // outside the vocabulary
          resist: "nope",
        },
        hedgehogMafia: { met: 5 }, // a species this build does not ship
      },
    })!;
    expect(Object.keys(m.bestiary!)).toEqual(["ratThug"]);
    expect(m.bestiary!.ratThug).toEqual({
      met: 9, // a kill IS a meeting
      kills: 9,
      skills: ["shiv"],
      weak: ["frazzled"],
      resist: [],
    });
  });

  it("round-trips a learned Bestiary through JSON unchanged", () => {
    const { log, state } = playOut(21, ["ratThug", "crowShaman"]);
    const meta = recordBattle(emptyProfile(), state, log);
    const back = migrateMeta(JSON.parse(JSON.stringify(meta)))!;
    expect(back.bestiary).toEqual(meta.bestiary);
  });

  it("readBestiary treats junk as an empty Bestiary", () => {
    expect(readBestiary(null)).toEqual({});
    expect(readBestiary("nope")).toEqual({});
    expect(readBestiary({ ratThug: 7 })).toEqual({});
  });
});
