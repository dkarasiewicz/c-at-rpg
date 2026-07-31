/**
 * WP-02a acceptance tests — classes/skills slice of WP-02 Content.
 *
 * Gates:
 *  - L1 party built from CLASSES equals combat.md §13's table byte-for-byte
 *    (stats, skills, default marching order).
 *  - The 8 reference skills reproduce combat.md §4 / classes.md verbatim.
 *  - Full L1→L8 growth tables match classes.md §§4-7.
 *  - Every skill id referenced by CLASSES (and the dungeon/boss rosters)
 *    exists in SKILLS; table self-consistency invariants hold.
 */
import { describe, expect, it } from "vitest";
import { CLASSES } from "../src/content/classes.js";
import { SKILLS } from "../src/content/skills.js";
import type { ClassId, Skill, Stats } from "../src/core/types.js";

/** Apply growth rows 1..(level-1) to a base — classes.md §8 leveling. */
function statsAtLevel(classId: ClassId, level: number): Stats {
  const cls = CLASSES[classId];
  const s: Stats = { ...cls.base };
  for (let l = 2; l <= level; l++) {
    const row = cls.growth[l - 2];
    for (const [k, v] of Object.entries(row)) {
      s[k as keyof Stats] += v;
    }
  }
  return s;
}

describe("CLASSES — combat.md §13 level-1 party (byte-for-byte)", () => {
  // Default marching order (classes.md §9): R1 Bruno, R2 Pixel, R3 Mora,
  // R4 Baguette.
  const marchingOrder: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

  // combat.md §13 party table: name / HP / ATK / DEF / SPD / CRT.
  const expected: Record<
    ClassId,
    { name: string; stats: Stats; skills: string[] }
  > = {
    bruiser: {
      name: "Bruno",
      stats: { hp: 40, atk: 10, def: 3, spd: 4, crt: 5, enMax: 10 },
      skills: ["clawSwipe", "bodySlam", "hiss"],
    },
    trickster: {
      name: "Pixel",
      stats: { hp: 28, atk: 12, def: 1, spd: 8, crt: 15, enMax: 10 },
      skills: ["clawSwipe", "pounce", "tripWire"],
    },
    hexer: {
      name: "Mora",
      stats: { hp: 24, atk: 11, def: 0, spd: 6, crt: 5, enMax: 10 },
      skills: ["clawSwipe", "yankOfYarn", "hairballHex"],
    },
    medic: {
      name: "Baguette",
      stats: { hp: 26, atk: 9, def: 1, spd: 5, crt: 5, enMax: 10 },
      skills: ["clawSwipe", "soothingPurr", "nineLivesNudge"],
    },
  };

  it("builds the §13 party in default marching order", () => {
    const party = marchingOrder.map((id) => {
      const cls = CLASSES[id];
      return {
        classId: cls.id,
        name: cls.catName,
        stats: { ...cls.base },
        skills: cls.skills
          .filter((s) => s.unlockLevel <= 1)
          .map((s) => s.skillId),
      };
    });
    expect(party).toEqual(
      marchingOrder.map((id) => ({
        classId: id,
        name: expected[id].name,
        stats: expected[id].stats,
        skills: expected[id].skills,
      })),
    );
  });

  it("keys match ids and every class has 7 skills (L1 kit, capstone, milestones)", () => {
    for (const [key, cls] of Object.entries(CLASSES)) {
      expect(cls.id).toBe(key);
      // 3 known at L1 + one milestone unlock each at L2/L4/L6/L8
      // (docs/design/progression.md §2). ARRAY ORDER IS LOAD-BEARING: the
      // legacy kit (Claw Swipe, two L1 skills, the L4 capstone) comes first
      // so the default battle loadout — knownSkills truncated to 4 — is the
      // pre-milestone kit at every level.
      expect(cls.skills).toHaveLength(7);
      const unlocks = cls.skills.map((s) => s.unlockLevel);
      expect(unlocks).toEqual([1, 1, 1, 4, 2, 6, 8]);
      expect(cls.skills[0].skillId).toBe("clawSwipe");
      expect(cls.trait.tier2Level).toBe(7);
      expect(cls.base.enMax).toBe(10);
      expect(cls.growth).toHaveLength(7);
    }
  });

  it("capstones are the documented four", () => {
    expect(CLASSES.bruiser.skills[3].skillId).toBe("dumpsterDunk");
    expect(CLASSES.trickster.skills[3].skillId).toBe("boxAmbush");
    expect(CLASSES.hexer.skills[3].skillId).toBe("phantomCucumber");
    expect(CLASSES.medic.skills[3].skillId).toBe("purrquake");
  });

  it("traits carry the documented ids", () => {
    expect(CLASSES.bruiser.trait.id).toBe("immovableLoaf");
    expect(CLASSES.trickster.trait.id).toBe("opportunist");
    expect(CLASSES.hexer.trait.id).toBe("stringTheory");
    expect(CLASSES.medic.trait.id).toBe("purrEngine");
  });

  it("palettes match classes.md §10", () => {
    expect(CLASSES.bruiser.palette).toEqual({
      body: 0xe08a2e,
      ears: 0xb5661c,
      eyes: 0xf2c14e,
    });
    expect(CLASSES.trickster.palette).toEqual({
      body: 0x9aa7b0,
      ears: 0x6e7b85,
      eyes: 0x7ce577,
    });
    expect(CLASSES.hexer.palette).toEqual({
      body: 0x2b2333,
      ears: 0x1c1626,
      eyes: 0xffd447,
    });
    expect(CLASSES.medic.palette).toEqual({
      body: 0xeed9b7,
      ears: 0xd9b98c,
      eyes: 0x8a5a2b,
    });
  });
});

describe("CLASSES — growth tables L1→L8 (classes.md §§4-7)", () => {
  // Full per-level stat tables, transcribed from the class docs:
  // [hp, atk, def, spd, crt] rows for L1..L8 (enMax fixed at 10).
  const tables: Record<ClassId, number[][]> = {
    bruiser: [
      [40, 10, 3, 4, 5],
      [44, 11, 3, 4, 5],
      [48, 11, 4, 4, 5],
      [52, 12, 4, 4, 5],
      [56, 12, 4, 5, 5],
      [60, 13, 4, 5, 5],
      [64, 13, 5, 5, 5],
      [68, 14, 5, 5, 5],
    ],
    trickster: [
      [28, 12, 1, 8, 15],
      [30, 13, 1, 8, 15],
      [32, 13, 1, 8, 17],
      [34, 13, 1, 9, 17],
      [36, 14, 1, 9, 17],
      [38, 14, 1, 9, 19],
      [40, 15, 1, 9, 19],
      [42, 16, 1, 10, 19],
    ],
    hexer: [
      [24, 11, 0, 6, 5],
      [26, 12, 0, 6, 5],
      [28, 12, 0, 7, 5],
      [30, 13, 0, 7, 5],
      [32, 13, 1, 7, 5],
      [34, 14, 1, 7, 5],
      [36, 14, 1, 8, 5],
      [38, 15, 1, 8, 5],
    ],
    medic: [
      [26, 9, 1, 5, 5],
      [29, 9, 1, 5, 5],
      [32, 10, 1, 5, 5],
      [35, 10, 2, 5, 5],
      [38, 11, 2, 5, 5],
      [41, 11, 2, 6, 5],
      [44, 12, 2, 6, 5],
      [47, 12, 3, 6, 5],
    ],
  };

  for (const classId of Object.keys(tables) as ClassId[]) {
    it(`${classId} matches its per-level table`, () => {
      for (let level = 1; level <= 8; level++) {
        const [hp, atk, def, spd, crt] = tables[classId][level - 1];
        expect(statsAtLevel(classId, level), `${classId} L${level}`).toEqual({
          hp,
          atk,
          def,
          spd,
          crt,
          enMax: 10,
        });
      }
    });
  }
});

describe("SKILLS — reference set verbatim (combat.md §4 / classes.md)", () => {
  it("Claw Swipe", () => {
    expect(SKILLS.clawSwipe).toMatchObject({
      cost: 0,
      usableFrom: [1, 2],
      target: { side: "enemy", ranks: [1, 2], pattern: "single" },
      power: 100,
      kind: "damage",
      energyGain: 1,
    });
  });

  it("Body Slam", () => {
    expect(SKILLS.bodySlam).toMatchObject({
      cost: 4,
      usableFrom: [1, 2],
      target: { side: "enemy", ranks: [1, 2], pattern: "single" },
      power: 120,
      kind: "damage",
      moveTarget: 2,
    });
  });

  it("Hiss", () => {
    expect(SKILLS.hiss).toMatchObject({
      cost: 2,
      usableFrom: [1, 2],
      target: { side: "self", ranks: [1, 2, 3, 4], pattern: "single" },
      power: 0,
      kind: "utility",
      applies: [
        { status: "guarded", chance: 1.0, to: "self" },
        { status: "provoked", chance: 1.0, to: "allEnemies" },
      ],
    });
  });

  it("Pounce", () => {
    expect(SKILLS.pounce).toMatchObject({
      cost: 3,
      usableFrom: [3, 4],
      target: { side: "enemy", ranks: [1, 2], pattern: "single" },
      power: 150,
      kind: "damage",
      moveSelf: -2,
    });
  });

  it("Trip Wire", () => {
    expect(SKILLS.tripWire).toMatchObject({
      cost: 4,
      usableFrom: [2, 3],
      target: { side: "enemy", ranks: [1, 2], pattern: "row" },
      power: 60,
      kind: "damage",
      moveTarget: 1,
    });
  });

  it("Yank of Yarn", () => {
    expect(SKILLS.yankOfYarn).toMatchObject({
      cost: 3,
      usableFrom: [3, 4],
      target: { side: "enemy", ranks: [2, 3, 4], pattern: "single" },
      power: 60,
      kind: "damage",
      moveTarget: -2,
    });
  });

  it("Hairball Hex", () => {
    expect(SKILLS.hairballHex).toMatchObject({
      cost: 3,
      usableFrom: [2, 3, 4],
      target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
      power: 40,
      kind: "damage",
      applies: [{ status: "scratched", chance: 0.9, value: 3 }],
    });
  });

  it("Soothing Purr", () => {
    expect(SKILLS.soothingPurr).toMatchObject({
      cost: 4,
      usableFrom: [3, 4],
      target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
      power: 120,
      kind: "heal",
      cleanses: ["scratched"],
    });
  });

  it("Nine Lives Nudge", () => {
    expect(SKILLS.nineLivesNudge).toMatchObject({
      cost: 6,
      usableFrom: [3, 4],
      target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "single" },
      power: 0,
      kind: "utility",
      revivePct: 0.3,
      oncePerBattle: true,
    });
  });

  it("capstones — Dumpster Dunk / Box Ambush / Phantom Cucumber / Purrquake", () => {
    expect(SKILLS.dumpsterDunk).toMatchObject({
      cost: 6,
      usableFrom: [1],
      target: { side: "enemy", ranks: [1, 2], pattern: "single" },
      power: 150,
      kind: "damage",
      moveTarget: 3,
    });
    expect(SKILLS.boxAmbush).toMatchObject({
      cost: 6,
      usableFrom: [1, 2, 3, 4],
      target: { side: "enemy", ranks: [1, 2, 3, 4, 5], pattern: "single" },
      power: 150,
      kind: "damage",
    });
    expect(SKILLS.boxAmbush.moveTarget).toBeUndefined();
    expect(SKILLS.boxAmbush.moveSelf).toBeUndefined();
    expect(SKILLS.phantomCucumber).toMatchObject({
      cost: 5,
      usableFrom: [3, 4],
      target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
      power: 30,
      kind: "damage",
      applies: [{ status: "frazzled", chance: 0.8 }],
    });
    expect(SKILLS.purrquake).toMatchObject({
      cost: 6,
      usableFrom: [3, 4],
      target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "row" },
      power: 60,
      kind: "heal",
      applies: [{ status: "mending", chance: 1.0, value: 3 }],
    });
  });
});

describe("SKILLS — enemy & boss coverage", () => {
  it("contains a skill for every doc-referenced enemy/boss id", () => {
    const required = [
      // dungeon.md §7.1 roster + combat.md §13 + events.md §4:
      "shiv", // ratThug
      "swoop", // sewerBat
      "nibble", // dustBunny
      "peck", // crowShaman (combat.md §13)
      "hex", // crowShaman
      "ram", // roombaScout
      "spray", // sprinklerImp
      "squirt", // sprinklerImp filler
      "yarnSlam", // yarnGolem
      "bite", // porcelainHound
      "laserZap", // laserGhost
      "lidBash", // trashPanda
      "trashToss", // trashPanda filler
      "dampSlap", // sockWraith
      "grizzledCuff", // elderStray (events.md §4, spelled)
      // bosses (GDD §6):
      "hoseWhack",
      "dustBlast",
      "maxSuction",
      "maul",
      "junkyardToss",
      "theBigBark",
      "scepterBonk",
      "summonVermin",
    ];
    for (const id of required) {
      expect(SKILLS[id], `missing skill '${id}'`).toBeDefined();
    }
  });

  it("worked-example enemy numbers: Shiv/Peck are power-100 front pokes", () => {
    // combat.md §13: Rat A Shiv base 7 with ATK 7; Crow Peck base 8.0 with
    // ATK 8 → both power 100 (base = power/100 × atk).
    for (const id of ["shiv", "peck"]) {
      expect(SKILLS[id]).toMatchObject({
        cooldown: 0,
        usableFrom: [1, 2],
        target: { side: "enemy", ranks: [1, 2], pattern: "single" },
        power: 100,
        kind: "damage",
      });
    }
  });

  it("doc-specified enemy skill mechanics", () => {
    // crowShaman's hex is usableFrom [2,3,4] — shoving it to rank 1
    // silences it (dungeon.md §7.1).
    expect(SKILLS.hex.usableFrom).toEqual([2, 3, 4]);
    // roombaScout rams: moveTarget +1.
    expect(SKILLS.ram.moveTarget).toBe(1);
    // sprinklerImp: row-hitting spray, cooldown 2.
    expect(SKILLS.spray.cooldown).toBe(2);
    expect(SKILLS.spray.target.pattern).toBe("row");
    // porcelainHound shoves.
    expect(SKILLS.bite.moveTarget).toBe(1);
    // elderStray's Grizzled Cuff is a moveTarget +1 skill (events.md §4).
    expect(SKILLS.grizzledCuff.moveTarget).toBe(1);
  });

  it("boss skill mechanics per combat.md §11 / GDD §6", () => {
    // MAX SUCTION pulls all cats 1 rank forward (forced move toward rank 1).
    expect(SKILLS.maxSuction.moveTarget).toBe(-1);
    expect(SKILLS.maxSuction.target.pattern).toBe("row");
    // Telegraphed nuke: row-hitting, power 200, cooldown 3.
    expect(SKILLS.theBigBark).toMatchObject({
      cooldown: 3,
      power: 200,
      target: { side: "enemy", ranks: [1, 2], pattern: "row" },
      kind: "damage",
    });
    // Summon skill is an inert utility (boss.ts does the spawning).
    expect(SKILLS.summonVermin).toMatchObject({
      power: 0,
      kind: "utility",
    });
  });
});

describe("SKILLS — table invariants", () => {
  it("key === entry.id for every skill", () => {
    for (const [key, skill] of Object.entries(SKILLS)) {
      expect(skill.id).toBe(key);
    }
  });

  it("cat kit is Claw Swipe + 24 class skills (6 per cat — progression.md §2)", () => {
    const catSkillIds = new Set(
      Object.values(CLASSES).flatMap((c) => c.skills.map((s) => s.skillId)),
    );
    expect(catSkillIds.size).toBe(25);
    // the 12 milestone unlocks are all new ids, 3 per class
    for (const cls of Object.values(CLASSES)) {
      const milestones = cls.skills.filter(
        (s) => s.unlockLevel > 1 && s.unlockLevel !== 4,
      );
      expect(milestones.map((s) => s.unlockLevel)).toEqual([2, 6, 8]);
    }
  });

  it("every class skillId resolves in SKILLS", () => {
    for (const cls of Object.values(CLASSES)) {
      for (const { skillId } of cls.skills) {
        expect(SKILLS[skillId], `${cls.id} → '${skillId}'`).toBeDefined();
      }
    }
  });

  it("status chances are in (0, 1]; chance-1.0 marks the no-roll cases", () => {
    for (const skill of Object.values(SKILLS)) {
      for (const app of skill.applies ?? []) {
        expect(app.chance).toBeGreaterThan(0);
        expect(app.chance).toBeLessThanOrEqual(1);
      }
    }
  });

  it("field sanity: powers, costs, cooldowns, ranks", () => {
    const isCatSkill = (s: Skill) => s.cooldown === undefined; // cats: energy-gated, no cooldown field
    for (const skill of Object.values(SKILLS)) {
      expect(skill.power).toBeGreaterThanOrEqual(0);
      expect(skill.usableFrom.length).toBeGreaterThan(0);
      expect(skill.target.ranks.length).toBeGreaterThan(0);
      for (const r of [...skill.usableFrom, ...skill.target.ranks]) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(5);
      }
      if (isCatSkill(skill)) {
        expect(skill.cost).toBeGreaterThanOrEqual(0);
        expect(skill.cost).toBeLessThanOrEqual(10);
      } else {
        expect(skill.cost).toBe(0);
        expect(skill.cooldown).toBeGreaterThanOrEqual(0);
      }
      // Cats occupy ranks 1-4: only enemy-side targets may reach rank 5.
      if (skill.target.side !== "enemy") {
        for (const r of skill.target.ranks) {
          expect(r).toBeLessThanOrEqual(4);
        }
      }
    }
  });
});
