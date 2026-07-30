/**
 * WP-07 acceptance tests — run state, progression & save (ARCHITECTURE §5).
 *
 * Covers: newRun starting kit + stray L1 weapons, effectiveStats folding
 * (growth/equip/tempMods + clamps), level-ups (multi-level, delta-HP rule,
 * capstone at 4 / trait tier 2 at 7, surplus XP ignored), applyBattleResult
 * write-back (hp/lives, deaths + grief loot + marching-order compression,
 * score counters, Ninth Bell), descend (catnap heal + floor-scoped resets),
 * the gameloop.md §7 score table, and the save round-trip (floor regenerated
 * from seed + delta overlay), version gate, and MetaFile records.
 */
import { describe, expect, it } from "vitest";
import { recomputeVisibility } from "../src/core/dungeon/floor";
import type {
  BattleResult,
  CatRunState,
  RunState,
  ScoreCounters,
} from "../src/core/types";
import { EQUIP_DEFS } from "../src/content/equipment";
import { makeEquipInstance } from "../src/core/loot/roll";
import { isStack } from "../src/core/loot/inventory";
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
} from "../src/core/run/party";
import {
  applyBattleResult,
  applyLootGrant,
  catnapHeal,
  descend,
  generateCurrentFloor,
  markEventFired,
  newRun,
  PARTY_ORDER,
} from "../src/core/run/runState";
import { computeScore, VICTORY_BONUS } from "../src/core/run/score";
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
} from "../src/core/run/save";

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
    expect(run.marchingOrder).toEqual(PARTY_ORDER);
    expect(run.cats.map((c) => c.classId)).toEqual(PARTY_ORDER);
    expect(run.cats.every((c) => c.lives === 9)).toBe(true);
    // full HP = class base hp (stray weapons add atk only)
    expect(run.cats.map((c) => c.hp)).toEqual([40, 28, 24, 26]);
    for (const cat of run.cats) expect(cat.hp).toBe(maxHp(cat, run.level));
  });

  it("starts on floor 1 (reached), no floor generated yet, clean books", () => {
    expect(run.floorNum).toBe(1);
    expect(run.floor).toBeNull();
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
    const run = newRun(SEED);
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

  it("kills the pack on the floor and ticks floorsCleared on the last one", () => {
    const run = generateCurrentFloor(newRun(SEED));
    const floor = run.floor!;
    const packs = floor.entities.filter(
      (e) => e.kind === "roamer" || e.kind === "boss",
    );
    expect(packs.length).toBeGreaterThan(1);
    // all but the last already dead
    for (const p of packs.slice(0, -1)) (p as { dead: boolean }).dead = true;
    const last = packs[packs.length - 1];

    let out = applyBattleResult(run, battleResult(run), last.id);
    expect((out.run.floor!.entities[last.id] as { dead: boolean }).dead).toBe(
      true,
    );
    expect(out.run.score.floorsCleared).toBe(1);

    // an event fight afterwards (no roamerId) must not double-count
    out = applyBattleResult(out.run, battleResult(out.run));
    expect(out.run.score.floorsCleared).toBe(1);
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
    let run = generateCurrentFloor(newRun(SEED));
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
    expect(after.floor!.floor).toBe(2);
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

  it("hand-computed defeat fixture", () => {
    // 2·100 + 3·50 + 14·10 + 1·300 + 120·5 + 5·20 = 1490
    const s = computeScore(counters, false, 17);
    expect(s.total).toBe(1490);
    expect(s.lines.map((l) => l.points)).toEqual([
      200, 150, 140, 300, 600, 100,
    ]);
    expect(s.lines.some((l) => l.id === "livesRemaining")).toBe(false);
    expect(s.lines.some((l) => l.id === "victoryBonus")).toBe(false);
  });

  it("victory adds lives ×25 and the 1000 bonus", () => {
    const s = computeScore(counters, true, 20);
    expect(s.total).toBe(1490 + 20 * 25 + VICTORY_BONUS);
    const lives = s.lines.find((l) => l.id === "livesRemaining")!;
    expect(lives.points).toBe(500);
    expect(s.lines[s.lines.length - 1].id).toBe("victoryBonus");
  });

  it("max lives line: 36 lives → 900", () => {
    const s = computeScore(counters, true, 36);
    expect(s.lines.find((l) => l.id === "livesRemaining")!.points).toBe(900);
  });
});

/* ---------------------------------------------------------------------- */
/* save round-trip + version gate + MetaFile                               */
/* ---------------------------------------------------------------------- */

describe("save", () => {
  /** A mid-floor fixture: generated floor with real play-state mutations. */
  function midFloorRun(): RunState {
    let run = generateCurrentFloor(newRun(SEED));
    // enrich the run side
    run = applyLootGrant(run, {
      shinies: 42,
      equips: [makeEquipInstance(20, "cardboardCuirass", 2, "pedigree")],
      consumables: [{ defId: "warmMilk", count: 3 }],
    }).run;
    run = markEventFired(run, "strangeBox");
    run = { ...run, xp: 45, level: 2, playTimeMs: 123456 };
    // mutate the floor like real play would
    const f = run.floor!;
    f.stepCount = 42;
    const chest = f.entities.find((e) => e.kind === "chest");
    if (chest && chest.kind === "chest") chest.opened = true;
    const roamers = f.entities.filter((e) => e.kind === "roamer");
    const r0 = roamers[0];
    if (r0.kind === "roamer") {
      r0.dead = true;
    }
    const r1 = roamers[1];
    if (r1.kind === "roamer") {
      r1.state = "chase";
      r1.lostSightFor = 2;
      r1.wpIndex = 1;
      r1.x += 1;
    }
    // move the party somewhere else and refresh fog
    if (chest) {
      f.party = { x: chest.x, y: chest.y };
    }
    f.explored[0] = 1; // an extra hand-explored tile
    recomputeVisibility(f); // refresh fog for the moved party
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
    saveRun(run, storage);
    const loaded = loadRun(storage);
    expect(loaded).toEqual(run);
  });

  it("version mismatch silently deletes the save", () => {
    const storage = memoryStorage();
    const run = midFloorRun();
    const sf = serializeRun(run);
    storage.set(SAVE_KEY, JSON.stringify({ ...sf, version: 2 }));
    expect(loadRun(storage)).toBeNull();
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("corrupt JSON silently deletes the save; empty storage loads null", () => {
    const storage = memoryStorage();
    expect(loadRun(storage)).toBeNull();
    storage.set(SAVE_KEY, "{not json");
    expect(loadRun(storage)).toBeNull();
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("deleteSave removes the blob", () => {
    const storage = memoryStorage();
    const run = midFloorRun();
    saveRun(run, storage);
    deleteSave(storage);
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("MetaFile records update on run end", () => {
    const storage = memoryStorage();
    expect(loadMeta(storage)).toEqual(emptyMeta());

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

    saveMeta(meta, storage);
    expect(loadMeta(storage)).toEqual(meta);
  });
});
