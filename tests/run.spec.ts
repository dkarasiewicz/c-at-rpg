/**
 * WP-07 acceptance tests — run state, progression & save (ARCHITECTURE §5).
 *
 * Covers: newRun starting kit + stray L1 weapons, effectiveStats folding
 * (growth/equip/tempMods + clamps), level-ups (multi-level, delta-HP rule,
 * capstone at 4 / trait tier 2 at 7, surplus XP ignored), applyBattleResult
 * write-back (hp/lives, deaths + grief loot + marching-order compression,
 * score counters, Ninth Bell), descend (catnap heal + floor-scoped resets),
 * the gameloop.md §7 score table, and the save round-trip (run map
 * regenerated from the seed), version gate, and MetaFile records.
 *
 * The run-map engine itself lives in tests/run-map.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { advance, optionsForRun } from "../src/core/map/traverse.js";
import type {
  BattleResult,
  CatRunState,
  RunState,
  ScoreCounters,
} from "../src/core/types.js";
import { EQUIP_DEFS } from "../src/content/equipment.js";
import { makeEquipInstance } from "../src/core/loot/roll.js";
import { isStack } from "../src/core/loot/inventory.js";
import {
  applyLevelUps,
  effectiveStats,
  expireFloorMods,
  growthStats,
  levelForXp,
  maxHp,
  skillsForLevel,
  traitTier,
  XP_CAP,
} from "../src/core/run/party.js";
import {
  applyBattleResult,
  applyLootGrant,
  catnapHeal,
  descend,
  generateCurrentFloorMap,
  markEventFired,
  newRun,
  PARTY_ORDER,
  STARTING_PARTY_SIZE,
} from "../src/core/run/runState.js";
import {
  computeScore,
  discoveriesOf,
  survivingLives,
  VICTORY_BONUS,
} from "../src/core/run/score.js";
import {
  deleteSave,
  deserializeRun,
  emptyMeta,
  loadMeta,
  loadRun,
  memoryStorage,
  recordRunEnd,
  SAVE_KEY,
  saveMeta,
  saveRun,
  serializeRun,
} from "../src/core/run/save.js";

const SEED = "MEOW-1987";

/** BattleResult factory: post-standup cat values default to the run's. */
function battleResult(
  run: RunState,
  partial: Partial<BattleResult> = {},
): BattleResult {
  return {
    outcome: "victory",
    cats: run.cats
      .filter((c) => c.lives > 0)
      .map((c) => ({ classId: c.classId, hp: c.hp, lives: c.lives })),
    xpGained: 0,
    catPiles: 0,
    enemiesDefeated: 0,
    bossDefeated: false,
    ninthBellSpent: false,
    events: [],
    ...partial,
  };
}

/* ---------------------------------------------------------------------- */
/* newRun                                                                  */
/* ---------------------------------------------------------------------- */

describe("newRun", () => {
  const run = newRun(SEED);

  it("grants the starting kit: 20 ✦, 2 Tuna Snacks, 1 Cardboard Box", () => {
    expect(run.inventory.shinies).toBe(20);
    const stacks = run.inventory.slots.filter(isStack);
    expect(stacks).toEqual([
      { defId: "tunaSnack", count: 2 },
      { defId: "cardboardBox", count: 1 },
    ]);
  });

  it("equips each cat's Stray L1 class weapon (atk +2, no rolls)", () => {
    for (const cat of run.cats) {
      const w = cat.weapon!;
      expect(w).not.toBeNull();
      expect(w.rarity).toBe("stray");
      expect(w.itemLevel).toBe(1);
      expect(w.stats).toEqual({ atk: 2 });
      expect(EQUIP_DEFS[w.defId].slot).toBe("weapon");
      expect(EQUIP_DEFS[w.defId].classId).toBe(cat.classId);
      expect(cat.trinket).toBeNull();
    }
    // uids 1..4 consumed; inventory counter is past them
    expect(run.cats.map((c) => c.weapon!.uid)).toEqual([1, 2, 3, 4]);
    expect(run.inventory.nextUid).toBe(5);
  });

  it("starts at level 1, 0 XP, 9 Lives each, full HP, default order", () => {
    expect(run.level).toBe(1);
    expect(run.xp).toBe(0);
    // All four SLOTS exist in cats[] (types.ts §2.9 fixed order), but the run
    // only FIELDS two of them — Bruno plus one drawn from the roster stream
    // (balance-and-meta.md §2). The rest are benched until recruited.
    expect(run.cats.map((c) => c.classId)).toEqual(PARTY_ORDER);
    expect(run.marchingOrder).toHaveLength(STARTING_PARTY_SIZE);
    expect(run.marchingOrder[0]).toBe("bruiser");
    expect(PARTY_ORDER).toContain(run.marchingOrder[1]);
    expect(new Set(run.marchingOrder).size).toBe(2);
    expect(run.cats.every((c) => c.lives === 9)).toBe(true);
    // full HP = class base hp (stray weapons add atk only)
    expect(run.cats.map((c) => c.hp)).toEqual([40, 28, 24, 26]);
    for (const cat of run.cats) expect(cat.hp).toBe(maxHp(cat, run.level));
  });

  it("starts on floor 1 (reached), no map generated yet, clean books", () => {
    expect(run.floorNum).toBe(1);
    expect(run.floorMap).toBeNull();
    expect(run.currentNodeId).toBeNull();
    expect(run.visitedNodeIds).toEqual([]);
    expect(run.score).toEqual({
      floorsCleared: 0,
      floorsReached: 1,
      enemiesDefeated: 0,
      bossesDefeated: 0,
      catPiles: 0,
      shiniesCollected: 0,
    });
    expect(run.firedEventIds).toEqual([]);
    expect(run.floorFiredEventIds).toEqual([]);
    expect(run.uniquesDropped).toEqual([]);
    expect(run.playTimeMs).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* effectiveStats                                                          */
/* ---------------------------------------------------------------------- */

describe("effectiveStats", () => {
  const run = newRun(SEED);
  const bruno = run.cats[0];

  it("folds base + equipped weapon at L1", () => {
    expect(effectiveStats(bruno, 1)).toEqual({
      hp: 40,
      atk: 12, // 10 base + 2 stray weapon
      def: 3,
      spd: 4,
      crt: 5,
      enMax: 10,
    });
  });

  it("applies growth rows at L2..level in order", () => {
    // bruiser rows: L2 {hp4,atk1}, L3 {hp4,def1}
    expect(growthStats("bruiser", 3)).toEqual({
      hp: 48,
      atk: 11,
      def: 4,
      spd: 4,
      crt: 5,
      enMax: 10,
    });
    expect(effectiveStats(bruno, 3).atk).toBe(13); // + weapon
  });

  it("adds trinket stats", () => {
    const collar = makeEquipInstance(99, "fluffyCollar", 2, "stray");
    const cat: CatRunState = { ...bruno, trinket: collar };
    expect(effectiveStats(cat, 1).hp).toBe(40 + (collar.stats.hp ?? 0));
  });

  it("folds tempMods; spd floors at 1, def/crt at 0; hpMax maps to hp", () => {
    const cat: CatRunState = {
      ...bruno,
      tempMods: [
        { stat: "spd", amount: -10, duration: "floor", sourceEventId: "e" },
        { stat: "def", amount: -5, duration: "floor", sourceEventId: "e" },
        { stat: "crt", amount: -99, duration: "run", sourceEventId: "e" },
        { stat: "hpMax", amount: 5, duration: "floor", sourceEventId: "e" },
        { stat: "atk", amount: 3, duration: "run", sourceEventId: "e" },
      ],
    };
    const s = effectiveStats(cat, 1);
    expect(s.spd).toBe(1);
    expect(s.def).toBe(0);
    expect(s.crt).toBe(0);
    expect(s.hp).toBe(45);
    expect(s.atk).toBe(15);
  });
});

/* ---------------------------------------------------------------------- */
/* skills, traits, XP → levels                                             */
/* ---------------------------------------------------------------------- */

describe("progression", () => {
  it("skill list by level: capstone joins at L4", () => {
    expect(skillsForLevel("bruiser", 1)).toEqual([
      "clawSwipe",
      "bodySlam",
      "hiss",
    ]);
    expect(skillsForLevel("bruiser", 3)).not.toContain("dumpsterDunk");
    expect(skillsForLevel("bruiser", 4)).toContain("dumpsterDunk");
    expect(skillsForLevel("medic", 4)).toContain("purrquake");
  });

  it("trait tier 2 at L7", () => {
    expect(traitTier("hexer", 6)).toBe(1);
    expect(traitTier("hexer", 7)).toBe(2);
    expect(traitTier("hexer", 8)).toBe(2);
  });

  it("levelForXp follows the cumulative table, capped at 8", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(29)).toBe(1);
    expect(levelForXp(30)).toBe(2);
    expect(levelForXp(69)).toBe(2);
    expect(levelForXp(70)).toBe(3);
    expect(levelForXp(569)).toBe(7);
    expect(levelForXp(570)).toBe(8);
    expect(levelForXp(99999)).toBe(8);
    expect(XP_CAP).toBe(570);
  });

  it("level-ups raise current HP only by the max-HP delta", () => {
    const run = newRun(SEED);
    const damaged = run.cats.map((c) => ({ ...c, hp: 10 }));
    const after = applyLevelUps(damaged, 1, 3);
    // hp growth L2+L3: bruiser 4+4, trickster 2+2, hexer 2+2, medic 3+3
    expect(after.map((c) => c.hp)).toEqual([18, 14, 14, 16]);
  });

  it("dead cats are untouched by level-ups", () => {
    const run = newRun(SEED);
    const cats = run.cats.map((c, i) =>
      i === 3 ? { ...c, lives: 0, hp: 5 } : c,
    );
    const after = applyLevelUps(cats, 1, 2);
    expect(after[3].hp).toBe(5);
  });
});

/* ---------------------------------------------------------------------- */
/* applyBattleResult                                                       */
/* ---------------------------------------------------------------------- */

describe("applyBattleResult", () => {
  it("writes back hp/lives and clears energyNextBattle", () => {
    let run = newRun(SEED);
    run = {
      ...run,
      cats: run.cats.map((c) => ({ ...c, energyNextBattle: 2 })),
    };
    const result = battleResult(run, {
      cats: [
        { classId: "bruiser", hp: 12, lives: 8 },
        { classId: "trickster", hp: 28, lives: 9 },
        { classId: "hexer", hp: 1, lives: 7 },
        { classId: "medic", hp: 20, lives: 9 },
      ],
    });
    const { run: after } = applyBattleResult(run, result);
    expect(after.cats.map((c) => c.hp)).toEqual([12, 28, 1, 20]);
    expect(after.cats.map((c) => c.lives)).toEqual([8, 9, 7, 9]);
    expect(after.cats.every((c) => c.energyNextBattle === 0)).toBe(true);
  });

  it("applies multi-level XP with the delta-HP rule; surplus past 570 ignored", () => {
    const run = newRun(SEED);
    const { run: after } = applyBattleResult(
      run,
      battleResult(run, { xpGained: 75 }),
    );
    expect(after.xp).toBe(75);
    expect(after.level).toBe(3); // 70 ≤ 75 < 130
    // started at full HP, +8/+4/+4/+6 from two growth rows
    expect(after.cats.map((c) => c.hp)).toEqual([48, 32, 28, 32]);

    const late = { ...after, xp: 560, level: 7 };
    const { run: capped } = applyBattleResult(
      late,
      battleResult(late, { xpGained: 100 }),
    );
    expect(capped.xp).toBe(570);
    expect(capped.level).toBe(8);
  });

  it("0-Lives death: marching order compresses, gear becomes grief loot", () => {
    // fielded explicitly so the compression assertion does not ride on the
    // seeded starting-pair draw
    const run = newRun(SEED, undefined, {
      roster: ["bruiser", "trickster", "hexer", "medic"],
      partyCapacity: 4,
    });
    const result = battleResult(run, {
      cats: run.cats.map((c) =>
        c.classId === "medic"
          ? { classId: c.classId, hp: 1, lives: 0 }
          : { classId: c.classId, hp: c.hp, lives: c.lives },
      ),
    });
    const out = applyBattleResult(run, result);
    expect(out.died).toEqual(["medic"]);
    expect(out.run.marchingOrder).toEqual(["bruiser", "trickster", "hexer"]);
    // the medic slot stays in cats[] (fixed order) but is stripped of gear
    const medic = out.run.cats[3];
    expect(medic.lives).toBe(0);
    expect(medic.weapon).toBeNull();
    // its weapon (uid 4) landed in the shared inventory
    expect(out.griefLoot.map((e) => e.uid)).toEqual([4]);
    expect(
      out.run.inventory.slots.some(
        (s) => s !== null && "uid" in s && s.uid === 4,
      ),
    ).toBe(true);
    expect(out.griefOverflow).toEqual([]);
  });

  it("accumulates score counters", () => {
    const run = newRun(SEED);
    const { run: after } = applyBattleResult(
      run,
      battleResult(run, {
        enemiesDefeated: 3,
        catPiles: 2,
        bossDefeated: true,
      }),
    );
    expect(after.score.enemiesDefeated).toBe(3);
    expect(after.score.catPiles).toBe(2);
    expect(after.score.bossesDefeated).toBe(1);
  });

  it("marks the equipped Ninth Bell spent", () => {
    let run = newRun(SEED);
    const bell = makeEquipInstance(50, "tinBell", 3, "mewthical");
    expect(bell.hook).toBe("ninthBell");
    run = {
      ...run,
      cats: run.cats.map((c, i) => (i === 0 ? { ...c, trinket: bell } : c)),
    };
    const { run: after } = applyBattleResult(
      run,
      battleResult(run, { ninthBellSpent: true }),
    );
    expect(after.cats[0].trinket!.hookSpent).toBe(true);
  });

  it("ticks floorsCleared only for a win on the terminal node", () => {
    const run = generateCurrentFloorMap(newRun(SEED));
    const map = run.floorMap!;

    // a mid-floor pack: no tick
    let out = applyBattleResult(run, battleResult(run), map.entryId);
    expect(out.run.score.floorsCleared).toBe(0);
    // an event fight (no node id at all): no tick
    out = applyBattleResult(out.run, battleResult(out.run));
    expect(out.run.score.floorsCleared).toBe(0);
    // the boss / stairs-guard: the floor is cleared
    out = applyBattleResult(out.run, battleResult(out.run), map.bossId);
    expect(out.run.score.floorsCleared).toBe(1);
    // a defeat at the same node never ticks it
    const lost = applyBattleResult(
      run,
      battleResult(run, { outcome: "defeat" }),
      map.bossId,
    );
    expect(lost.run.score.floorsCleared).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* loot grants & event bookkeeping                                         */
/* ---------------------------------------------------------------------- */

describe("applyLootGrant / markEventFired", () => {
  it("applies shinies + items, tracks score and Mewthical uniques", () => {
    const run = newRun(SEED);
    const mew = makeEquipInstance(10, "driedLuckyBeetle", 4, "mewthical");
    const { run: after } = applyLootGrant(run, {
      shinies: 30,
      equips: [mew],
      consumables: [{ defId: "catnip", count: 2 }],
    });
    expect(after.inventory.shinies).toBe(50);
    expect(after.score.shiniesCollected).toBe(30);
    expect(after.uniquesDropped).toEqual(["catPileDouble"]);
    expect(
      after.inventory.slots.some(
        (s) => s !== null && "uid" in s && s.uid === 10,
      ),
    ).toBe(true);
  });

  it("TITHE (negative shinies) drains the wallet but never the score", () => {
    const run = newRun(SEED);
    const { run: after } = applyLootGrant(run, {
      shinies: -15,
      equips: [],
      consumables: [],
    });
    expect(after.inventory.shinies).toBe(5);
    expect(after.score.shiniesCollected).toBe(0);
  });

  it("records fired events run- and floor-scoped, idempotently", () => {
    let run = newRun(SEED);
    run = markEventFired(run, "pawShrine");
    run = markEventFired(run, "pawShrine");
    run = markEventFired(run, "yarnBall");
    expect(run.firedEventIds).toEqual(["pawShrine", "yarnBall"]);
    expect(run.floorFiredEventIds).toEqual(["pawShrine", "yarnBall"]);
  });
});

/* ---------------------------------------------------------------------- */
/* catnap + descend                                                        */
/* ---------------------------------------------------------------------- */

describe("descend", () => {
  it("catnapHeal heals floor(0.25·maxHP), capped, living cats only", () => {
    const run = newRun(SEED);
    const cats = run.cats.map((c, i) => ({
      ...c,
      hp: i === 0 ? 20 : c.hp,
      lives: i === 3 ? 0 : c.lives,
    }));
    const { cats: healed, healed: amounts } = catnapHeal(cats, 1);
    expect(healed[0].hp).toBe(30); // 20 + floor(0.25·40)
    expect(amounts).toEqual([10, 0, 0, 0]); // full cats + dead medic heal 0
  });

  it("advances the floor: heal, floor-mod expiry, event-id reset, gen", () => {
    let run = generateCurrentFloorMap(newRun(SEED));
    run = {
      ...run,
      cats: run.cats.map((c, i) =>
        i === 0
          ? {
              ...c,
              hp: 20,
              tempMods: [
                {
                  stat: "atk",
                  amount: 2,
                  duration: "floor",
                  sourceEventId: "a",
                },
                { stat: "spd", amount: 1, duration: "run", sourceEventId: "b" },
              ],
            }
          : c,
      ),
      firedEventIds: ["pawShrine"],
      floorFiredEventIds: ["pawShrine"],
    };
    const after = descend(run);
    expect(after.floorNum).toBe(2);
    expect(after.floorMap!.floor).toBe(2);
    expect(after.currentNodeId).toBe(after.floorMap!.entryId);
    expect(after.visitedNodeIds).toEqual([after.floorMap!.entryId]);
    expect(after.score.floorsReached).toBe(2);
    expect(after.floorFiredEventIds).toEqual([]);
    expect(after.firedEventIds).toEqual(["pawShrine"]); // run-scoped persists
    expect(after.cats[0].tempMods).toEqual([
      { stat: "spd", amount: 1, duration: "run", sourceEventId: "b" },
    ]);
    expect(after.cats[0].hp).toBe(30); // healed after expiry
  });

  it("expiring hpMax floor mods clamps current HP to the new max", () => {
    const run = newRun(SEED);
    const buffed: CatRunState = {
      ...run.cats[0],
      hp: 50,
      tempMods: [
        { stat: "hpMax", amount: 10, duration: "floor", sourceEventId: "e" },
      ],
    };
    const after = expireFloorMods(buffed, 1);
    expect(after.tempMods).toEqual([]);
    expect(after.hp).toBe(40);
  });

  it("throws on the last floor (floor 6 has no landing)", () => {
    const run = { ...newRun(SEED), floorNum: 6 };
    expect(() => descend(run)).toThrow();
  });
});

/* ---------------------------------------------------------------------- */
/* score table (gameloop.md §7)                                            */
/* ---------------------------------------------------------------------- */

describe("score", () => {
  const counters: ScoreCounters = {
    floorsCleared: 2,
    floorsReached: 3,
    enemiesDefeated: 14,
    bossesDefeated: 1,
    catPiles: 5,
    shiniesCollected: 120,
  };

  /** 3 events resolved, 1 Mewthical relic turned up. */
  const found = { eventsSurvived: 3, relicsFound: 1 };
  // 2·250 + 3·100 + 14·15 + 1·500 + 5·75 + 3·80 + 1·250 + 120·1
  const DEFEAT_TOTAL = 500 + 300 + 210 + 500 + 375 + 240 + 250 + 120;

  it("hand-computed defeat fixture", () => {
    const s = computeScore(counters, false, 17, found);
    expect(s.total).toBe(DEFEAT_TOTAL);
    expect(s.lines.map((l) => l.points)).toEqual([
      500, 300, 210, 500, 375, 240, 250, 120,
    ]);
    expect(s.lines.some((l) => l.id === "livesRemaining")).toBe(false);
    expect(s.lines.some((l) => l.id === "victoryBonus")).toBe(false);
  });

  it("discoveries default to zero when the caller has only counters", () => {
    const s = computeScore(counters, false, 17);
    expect(s.lines.find((l) => l.id === "eventsSurvived")!.points).toBe(0);
    expect(s.lines.find((l) => l.id === "relicsFound")!.points).toBe(0);
    expect(s.total).toBe(DEFEAT_TOTAL - 240 - 250);
  });

  it("victory adds lives ×25 and the victory bonus", () => {
    const s = computeScore(counters, true, 20, found);
    expect(s.total).toBe(DEFEAT_TOTAL + 20 * 25 + VICTORY_BONUS);
    const lives = s.lines.find((l) => l.id === "livesRemaining")!;
    expect(lives.points).toBe(500);
    expect(s.lines[s.lines.length - 1].id).toBe("victoryBonus");
  });

  it("max lives line: 36 lives → 900", () => {
    const s = computeScore(counters, true, 36, found);
    expect(s.lines.find((l) => l.id === "livesRemaining")!.points).toBe(900);
  });

  it("discoveriesOf reads the run's own ledgers", () => {
    const r = {
      ...newRun(SEED),
      firedEventIds: ["a", "b"],
      uniquesDropped: ["ninthBell"],
    } as RunState;
    expect(discoveriesOf(r)).toEqual({ eventsSurvived: 2, relicsFound: 1 });
  });

  /**
   * SURVIVAL counts the cats that WALKED, not the four data slots.
   *
   * `RunState.cats` always carries all four classes; a run fields
   * `marchingOrder`. Summing `cats` paid 25 points per Life of a cat sitting
   * in Cat Town — a benched cat was a free 225, so fielding fewer cats scored
   * HIGHER — and the results screen printed "3 went down · 1 stayed in town"
   * directly above a count of 36 Lives over three rows of nine.
   */
  describe("survivingLives — only the cats that went down", () => {
    const run = (
      order: RunState["marchingOrder"],
      lives: Partial<Record<string, number>>,
    ): RunState => {
      const base = newRun(SEED);
      return {
        ...base,
        marchingOrder: order,
        cats: base.cats.map((c) => ({
          ...c,
          lives: lives[c.classId] ?? 9,
        })),
      } as RunState;
    };

    it("ignores the cats who never left Cat Town", () => {
      const r = run(["bruiser", "trickster", "hexer"], {});
      expect(r.cats).toHaveLength(4); // the fourth slot is still there
      expect(survivingLives(r)).toBe(27); // …and worth nothing
    });

    it("a fallen cat contributes 0 but is still counted as fielded", () => {
      const r = run(["bruiser", "trickster", "hexer"], { trickster: 0 });
      expect(survivingLives(r)).toBe(18);
    });

    it("a widened party of four is the only way to reach 36", () => {
      const r = run(["bruiser", "trickster", "hexer", "medic"], {});
      expect(survivingLives(r)).toBe(36);
      expect(
        computeScore(
          { ...counters },
          true,
          survivingLives(r),
          found,
        ).lines.find((l) => l.id === "livesRemaining")!.points,
      ).toBe(900);
    });

    it("benching a cat can never score MORE than fielding it", () => {
      const three = survivingLives(run(["bruiser", "trickster", "hexer"], {}));
      const four = survivingLives(
        run(["bruiser", "trickster", "hexer", "medic"], {}),
      );
      expect(four).toBeGreaterThan(three);
    });
  });

  /**
   * THE REBALANCE INVARIANT (score.ts header): shinies ×5 used to be 56-71%
   * of every total, which made eight of the nine other lines decorative.
   * Measured against a real six-floor descent
   * (tests/support/scriptedRun.ts, seed DEEP-0): 6/6 floors, 52 kills, 2
   * bosses, 984 shinies, 35 Lives left, 5 events. No line may own the table.
   */
  it("no single line dominates a full victory", () => {
    const s = computeScore(
      {
        floorsCleared: 6,
        floorsReached: 6,
        enemiesDefeated: 52,
        bossesDefeated: 2,
        catPiles: 4,
        shiniesCollected: 984,
      },
      true,
      35,
      { eventsSurvived: 5, relicsFound: 1 },
    );
    const share = (id: string): number =>
      (s.lines.find((l) => l.id === id)?.points ?? 0) / s.total;
    expect(share("shiniesCollected")).toBeLessThan(0.2);
    for (const l of s.lines) expect(l.points / s.total).toBeLessThan(0.3);
    // depth and deeds together must outweigh the coins by a wide margin
    const depth =
      share("floorsCleared") + share("floorsReached") + share("bossesDefeated");
    expect(depth).toBeGreaterThan(share("shiniesCollected") * 2);
  });
});

/* ---------------------------------------------------------------------- */
/* save round-trip + version gate + MetaFile                               */
/* ---------------------------------------------------------------------- */

describe("save", () => {
  /** A mid-floor fixture: a generated run map, walked a couple of nodes in. */
  function midFloorRun(): RunState {
    let run = generateCurrentFloorMap(newRun(SEED));
    // enrich the run side
    run = applyLootGrant(run, {
      shinies: 42,
      equips: [makeEquipInstance(20, "cardboardCuirass", 2, "pedigree")],
      consumables: [{ defId: "warmMilk", count: 3 }],
    }).run;
    run = markEventFired(run, "strangeBox");
    run = { ...run, xp: 45, level: 2, playTimeMs: 123456 };
    // walk the map like real play would: two committed route choices
    run = advance(run, optionsForRun(run)[0].node.id);
    const onward = optionsForRun(run);
    run = advance(run, onward[onward.length - 1].node.id);
    return run;
  }

  it("serialize → JSON → deserialize round-trips to a deep-equal RunState", () => {
    const run = midFloorRun();

    const sf = serializeRun(run);
    const wire = JSON.parse(JSON.stringify(sf)) as typeof sf;
    const restored = deserializeRun(wire);
    expect(restored).toEqual(run);
    // determinism: doing it again gives the same thing
    expect(
      deserializeRun(JSON.parse(JSON.stringify(serializeRun(restored)))),
    ).toEqual(run);
  });

  it("saveRun/loadRun via the injected storage stub", () => {
    const storage = memoryStorage();
    const run = midFloorRun();
    saveRun(run, { storage });
    const loaded = loadRun({ storage });
    expect(loaded).toEqual(run);
  });

  it("an unknown save version silently deletes the save", () => {
    const storage = memoryStorage();
    const run = midFloorRun();
    const sf = serializeRun(run);
    storage.set(SAVE_KEY, JSON.stringify({ ...sf, version: 99 }));
    expect(loadRun({ storage })).toBeNull();
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("a v1/v2 save migrates forward into a fresh map on the same floor", () => {
    const storage = memoryStorage();
    const run = midFloorRun();
    const sf = serializeRun(run);
    // a pre-run-map payload: version 2, no traversal fields
    const legacy = JSON.parse(JSON.stringify({ ...sf, version: 2 }));
    delete legacy.run.currentNodeId;
    delete legacy.run.visitedNodeIds;
    storage.set(SAVE_KEY, JSON.stringify(legacy));
    const loaded = loadRun({ storage })!;
    expect(storage.get(SAVE_KEY)).not.toBeNull(); // not deleted
    // the party, the wallet and the floor survive; the position resets
    expect(loaded.cats).toEqual(run.cats);
    expect(loaded.inventory).toEqual(run.inventory);
    expect(loaded.floorNum).toBe(run.floorNum);
    expect(loaded.floorMap).toEqual(run.floorMap);
    expect(loaded.currentNodeId).toBe(loaded.floorMap!.entryId);
    expect(loaded.visitedNodeIds).toEqual([loaded.floorMap!.entryId]);
  });

  it("corrupt JSON silently deletes the save; empty storage loads null", () => {
    const storage = memoryStorage();
    expect(loadRun({ storage })).toBeNull();
    storage.set(SAVE_KEY, "{not json");
    expect(loadRun({ storage })).toBeNull();
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("deleteSave removes the blob", () => {
    const storage = memoryStorage();
    const run = midFloorRun();
    saveRun(run, { storage });
    deleteSave({ storage });
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("MetaFile records update on run end", () => {
    const storage = memoryStorage();
    expect(loadMeta({ storage })).toEqual(emptyMeta());

    let meta = emptyMeta();
    meta = recordRunEnd(meta, { victory: false, score: 800, playTimeMs: 100 });
    expect(meta.counters).toEqual({ runs: 1, victories: 0 });
    expect(meta.records).toEqual({ bestScore: 800, fastestVictoryMs: null });

    meta = recordRunEnd(meta, {
      victory: true,
      score: 3000,
      playTimeMs: 2_100_000,
    });
    expect(meta.counters).toEqual({ runs: 2, victories: 1 });
    expect(meta.records).toEqual({
      bestScore: 3000,
      fastestVictoryMs: 2_100_000,
    });

    // slower victory: fastest keeps the min; lower score keeps the best
    meta = recordRunEnd(meta, {
      victory: true,
      score: 2500,
      playTimeMs: 2_500_000,
    });
    expect(meta.records).toEqual({
      bestScore: 3000,
      fastestVictoryMs: 2_100_000,
    });

    saveMeta(meta, { storage });
    expect(loadMeta({ storage })).toEqual(meta);
  });
});
