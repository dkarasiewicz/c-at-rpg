/**
 * WP-02b — enemies / bosses / floors content tables.
 *
 * Asserts dungeon.md §7.1's stat blocks verbatim, GDD §6's canonical
 * 6-floor table exactly, and GDD §6's boss data (vacuumKing 140 HP/Poise 3;
 * dogfather 200 HP/Poise 4 + one porcelainHound escort).
 */
import { describe, expect, it } from "vitest";
import type { Stats } from "../src/core/types.js";
import { ENEMIES } from "../src/content/enemies.js";
import { SKILLS } from "../src/content/skills.js";
import { BOSS_ENCOUNTERS } from "../src/content/bosses.js";
import { FLOORS, LEVEL_CAP, XP_TO_LEVEL } from "../src/content/floors.js";

const st = (
  hp: number,
  atk: number,
  def: number,
  spd: number,
  crt: number,
): Stats => ({ hp, atk, def, spd, crt, enMax: 0 });

describe("ENEMIES — dungeon.md §7.1 roster", () => {
  // species, tier, threat, row, hp, atk, def, spd, crt, xp — table verbatim
  const roster: [string, 1 | 2 | 3, number, "front" | "back", Stats, number][] =
    [
      ["ratThug", 1, 1, "front", st(18, 7, 1, 5, 5), 10],
      ["sewerBat", 1, 1, "front", st(10, 6, 0, 8, 10), 10],
      ["dustBunny", 1, 1, "front", st(14, 5, 2, 3, 0), 10],
      ["crowShaman", 1, 2, "back", st(14, 8, 0, 7, 5), 20],
      ["roombaScout", 2, 2, "front", st(24, 8, 2, 6, 5), 20],
      ["sprinklerImp", 2, 2, "back", st(20, 9, 1, 7, 5), 20],
      ["yarnGolem", 2, 3, "front", st(40, 9, 4, 3, 0), 35],
      ["porcelainHound", 3, 3, "front", st(34, 11, 3, 6, 5), 35],
      ["laserGhost", 3, 3, "back", st(22, 12, 0, 9, 10), 35],
      ["trashPanda", 3, 4, "front", st(48, 12, 2, 6, 10), 50],
    ];

  it.each(roster)(
    "%s has the canonical block",
    (id, tier, threat, row, stats, xp) => {
      const e = ENEMIES[id];
      expect(e).toBeDefined();
      expect(e.id).toBe(id);
      expect(e.tier).toBe(tier);
      expect(e.threat).toBe(threat);
      expect(e.row).toBe(row);
      expect(e.stats).toEqual(stats);
      expect(e.xp).toBe(xp);
      expect(e.boss).toBeUndefined();
    },
  );

  it("yarnGolem is the only heavy non-boss (elite trait)", () => {
    expect(ENEMIES.yarnGolem.traits).toEqual(["heavy"]);
    for (const [id, e] of Object.entries(ENEMIES)) {
      if (id !== "yarnGolem" && !e.boss)
        expect(e.traits).not.toContain("heavy");
    }
  });

  it("roombaScout uses dungeon.md's stat block (24 HP, not heavy) per GDD ruling", () => {
    expect(ENEMIES.roombaScout.stats.hp).toBe(24);
    expect(ENEMIES.roombaScout.traits).not.toContain("heavy");
  });

  it("sockWraith is the summon-only minion (12 HP, back, 0 threat, 5 xp)", () => {
    const s = ENEMIES.sockWraith;
    expect(s.stats).toEqual(st(12, 6, 0, 6, 0));
    expect(s.row).toBe("back");
    expect(s.threat).toBe(0);
    expect(s.xp).toBe(5);
  });

  it("elderStray matches events.md (55/12/3/7, no traits, moveTarget skill)", () => {
    const e = ENEMIES.elderStray;
    expect(e.stats.hp).toBe(55);
    expect(e.stats.atk).toBe(12);
    expect(e.stats.def).toBe(3);
    expect(e.stats.spd).toBe(7);
    expect(e.tier).toBe(3);
    expect(e.traits).toEqual([]);
    expect(e.skills).toContain("grizzledCuff");
  });

  it("exact doc-named skill ids are referenced", () => {
    expect(ENEMIES.ratThug.skills).toContain("shiv");
    expect(ENEMIES.crowShaman.skills).toContain("hex");
    expect(ENEMIES.crowShaman.skills).toContain("peck");
  });

  it("every enemy has at least one skill, valid look, and enMax 0", () => {
    for (const e of Object.values(ENEMIES)) {
      expect(e.skills.length).toBeGreaterThan(0);
      expect(e.stats.enMax).toBe(0);
      expect(["vermin", "bird", "beast", "construct"]).toContain(e.look.family);
      expect(["minion", "standard", "elite", "boss"]).toContain(
        e.look.sizeGrade,
      );
      expect(e.look.tier).toBe(e.tier);
      expect(e.look.sizeGrade === "boss").toBe(Boolean(e.boss));
    }
  });

  it("every referenced skill id resolves in SKILLS (incl. phases/windup/summon)", () => {
    for (const e of Object.values(ENEMIES)) {
      const referenced = new Set<string>(e.skills);
      if (e.boss) {
        for (const p of e.boss.phases)
          for (const s of p.skills) referenced.add(s);
        if (e.boss.windup) referenced.add(e.boss.windup.skillId);
        if (e.boss.summon) referenced.add(e.boss.summon.skillId);
      }
      for (const skillId of referenced) {
        expect(SKILLS[skillId], `${e.id} → ${skillId}`).toBeDefined();
      }
    }
  });
});

describe("bosses — GDD §6 canonical", () => {
  it("vacuumKing: 140 HP, Poise 3, heavy, doubleTurn, phase @50% MAX SUCTION", () => {
    const b = ENEMIES.vacuumKing;
    expect(b.stats.hp).toBe(140);
    expect(b.traits).toContain("heavy");
    expect(b.threat).toBe(0);
    expect(b.xp).toBe(40);
    expect(b.boss).toBeDefined();
    expect(b.boss!.poise).toBe(3);
    expect(b.boss!.doubleTurn).toBe(true);
    expect(b.boss!.phases[0].hpPct).toBe(1.0);
    expect(b.boss!.phases[1].hpPct).toBe(0.5);
    expect(b.boss!.phases[1].skills).toContain("maxSuction");
    expect(b.skills).toEqual(b.boss!.phases[0].skills);
  });

  it("dogfather: 200 HP, Poise 4, heavy, doubleTurn, windup row nuke", () => {
    const b = ENEMIES.dogfather;
    expect(b.stats.hp).toBe(200);
    expect(b.traits).toContain("heavy");
    expect(b.threat).toBe(0);
    expect(b.xp).toBe(60);
    expect(b.boss).toBeDefined();
    expect(b.boss!.poise).toBe(4);
    expect(b.boss!.doubleTurn).toBe(true);
    expect(b.boss!.phases[0].hpPct).toBe(1.0);
    expect(b.boss!.phases[1].hpPct).toBe(0.5);
    expect(b.boss!.windup).toBeDefined();
    // the windup nuke is a phase-2 skill
    expect(b.boss!.phases[1].skills).toContain(b.boss!.windup!.skillId);
    expect(b.skills).toEqual(b.boss!.phases[0].skills);
  });

  it("ratPrince (SHOULD): 120 HP, Poise 3, heavy, summons ratThug minions", () => {
    const b = ENEMIES.ratPrince;
    expect(b.stats.hp).toBe(120);
    expect(b.boss!.poise).toBe(3);
    expect(b.traits).toContain("heavy");
    expect(b.boss!.summon).toBeDefined();
    expect(ENEMIES[b.boss!.summon!.minion]).toBeDefined();
    expect(b.boss!.summon!.cap).toBe(2);
  });

  it("BOSS_ENCOUNTERS match GDD §6 (dogfather has ONE porcelainHound escort)", () => {
    expect(BOSS_ENCOUNTERS.vacuumKing).toEqual(["vacuumKing"]);
    expect(BOSS_ENCOUNTERS.dogfather).toEqual(["dogfather", "porcelainHound"]);
    expect(BOSS_ENCOUNTERS.ratPrince).toEqual(["ratPrince"]);
    for (const [bossId, encounter] of Object.entries(BOSS_ENCOUNTERS)) {
      expect(ENEMIES[bossId]?.boss).toBeDefined();
      expect(encounter[0]).toBe(bossId); // boss leads its own encounter
      for (const id of encounter) expect(ENEMIES[id]).toBeDefined();
      expect(encounter.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("FLOORS — GDD §6 canonical 6-floor table exactly", () => {
  const T1 = ["ratThug", "sewerBat", "dustBunny", "crowShaman"];
  const T2 = ["roombaScout", "sprinklerImp", "yarnGolem"];
  const T3 = ["porcelainHound", "laserGhost", "trashPanda"];

  it("is byte-for-byte the GDD table", () => {
    expect(FLOORS).toEqual([
      {
        name: "The Cellar",
        w: 31,
        h: 21,
        roomAttempts: 40,
        roamers: 4,
        chests: 2,
        events: 1,
        pool: T1,
        budgetLo: 3,
        budgetHi: 4,
      },
      {
        name: "The Drains",
        w: 31,
        h: 21,
        roomAttempts: 40,
        roamers: 5,
        chests: 2,
        events: 1,
        pool: T1,
        budgetLo: 4,
        budgetHi: 5,
      },
      {
        name: "The Appliance Graveyard",
        w: 27,
        h: 19,
        roomAttempts: 30,
        roamers: 3,
        chests: 3,
        events: 1,
        pool: [...T1, ...T2],
        budgetLo: 5,
        budgetHi: 6,
        boss: { bossId: "vacuumKing", encounter: ["vacuumKing"] },
      },
      {
        name: "The Undergarden",
        w: 35,
        h: 23,
        roomAttempts: 55,
        roamers: 6,
        chests: 3,
        events: 2,
        pool: T2,
        budgetLo: 6,
        budgetHi: 8,
      },
      {
        name: "The Cold Pantry",
        w: 35,
        h: 23,
        roomAttempts: 55,
        roamers: 7,
        chests: 3,
        events: 2,
        pool: [...T2, ...T3],
        budgetLo: 8,
        budgetHi: 10,
      },
      {
        name: "The Hollow Throne",
        w: 29,
        h: 19,
        roomAttempts: 35,
        roamers: 5,
        chests: 4,
        events: 2,
        pool: T3,
        budgetLo: 10,
        budgetHi: 12,
        boss: {
          bossId: "dogfather",
          encounter: ["dogfather", "porcelainHound"],
        },
      },
    ]);
  });

  it("grids are odd-sized (algorithm parity requirement)", () => {
    for (const f of FLOORS) {
      expect(f.w % 2).toBe(1);
      expect(f.h % 2).toBe(1);
    }
  });

  it("pools reference real, non-boss, positive-threat species (no sockWraith/elderStray)", () => {
    for (const f of FLOORS) {
      for (const id of f.pool) {
        const e = ENEMIES[id];
        expect(e).toBeDefined();
        expect(e.boss).toBeUndefined();
        expect(e.threat).toBeGreaterThan(0);
      }
      expect(f.pool).not.toContain("sockWraith");
      expect(f.pool).not.toContain("elderStray");
      expect(f.budgetLo).toBeLessThanOrEqual(f.budgetHi);
      // the cheapest pool member can always seed a pack
      expect(
        Math.min(...f.pool.map((id) => ENEMIES[id].threat)),
      ).toBeLessThanOrEqual(f.budgetLo);
    }
  });

  it("boss floors are 3 and 6; encounters match BOSS_ENCOUNTERS", () => {
    expect(FLOORS.map((f) => Boolean(f.boss))).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(FLOORS[2].boss).toEqual({
      bossId: "vacuumKing",
      encounter: BOSS_ENCOUNTERS.vacuumKing,
    });
    expect(FLOORS[5].boss).toEqual({
      bossId: "dogfather",
      encounter: BOSS_ENCOUNTERS.dogfather,
    });
  });

  it("XP curve matches classes.md §8", () => {
    expect(XP_TO_LEVEL).toEqual([0, 30, 70, 130, 210, 310, 430, 570]);
    expect(LEVEL_CAP).toBe(8);
  });
});
