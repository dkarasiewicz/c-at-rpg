/**
 * Progression depth acceptance tests — docs/design/progression.md.
 *
 * Covers the four new systems and the one hard rule that binds them:
 *  §1 Whisker Points — earn rate, per-stat caps, the HP delta rule, the
 *     fold order inside effectiveStats, purity/no-op on illegal spends.
 *  §2 Milestone unlocks — 3 known at L1, +1 at L2/L4/L6/L8 = 7 at cap, and
 *     the authored content's budget/vocabulary invariants.
 *  §3 Loadout — the default kit is byte-identical to the pre-progression
 *     kit at every level, plus ownership/length validation.
 *  §4 Collars — third slot folds into effectiveStats, equip/unequip HP rule,
 *     slot-generic inventory helpers, drop table presence.
 *  §5 Save v1 → v2 migration loads without loss.
 *
 * THE RULE: every new CatRunState field is optional and, when absent, every
 * function behaves exactly as it did before. Each section asserts that.
 */
import { describe, expect, it } from "vitest";
import type { CatRunState, ClassId, SkillId } from "../src/core/types.js";
import { EQUIP_SLOTS } from "../src/core/types.js";
import { CLASSES } from "../src/content/classes.js";
import { SKILLS } from "../src/content/skills.js";
import { EQUIP_DEFS } from "../src/content/equipment.js";
import {
  EQUIP_SLOT_WEIGHTS,
  SHOP_GEAR_SLOT_WEIGHTS,
} from "../src/content/lootTables.js";
import { hash, mulberry32 } from "../src/core/rng.js";
import {
  BASIC_SKILL_ID,
  LOADOUT_SIZE,
  POINT_MENU,
  activeSkills,
  benchedSkills,
  clearLoadout,
  clearPoints,
  effectiveStats,
  growthStats,
  knownSkills,
  maxHp,
  pointsSpent,
  setLoadout,
  skillsForLevel,
  spendPoint,
  unspentPoints,
} from "../src/core/run/party.js";
import {
  applyGriefLoot,
  applyMoult,
  canEquip,
  emptyInventory,
  equipItem,
  sortInventory,
  unequipItem,
} from "../src/core/loot/inventory.js";
import { makeEquipInstance, rollOneEquip } from "../src/core/loot/roll.js";
import { rollShopStock } from "../src/core/loot/shop.js";
import {
  SAVE_KEY,
  SAVE_VERSION,
  loadRun,
  memoryStorage,
  migrateSave,
  serializeRun,
} from "../src/core/run/save.js";
import { generateCurrentFloorMap, newRun } from "../src/core/run/runState.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function cat(classId: ClassId = "bruiser", over: Partial<CatRunState> = {}) {
  const base: CatRunState = {
    classId,
    hp: 40,
    lives: 9,
    weapon: null,
    trinket: null,
    tempMods: [],
    energyNextBattle: 0,
  };
  return { ...base, ...over };
}

const ALL_CLASSES: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

/* ================================================================== */
/* §1 Whisker Points                                                   */
/* ================================================================== */

describe("Whisker Points (progression.md §1)", () => {
  it("grants one point per level from L2..L8 — 7 over a full run", () => {
    const c = cat();
    expect(unspentPoints(c, 1)).toBe(0);
    expect(unspentPoints(c, 2)).toBe(1);
    expect(unspentPoints(c, 5)).toBe(4);
    expect(unspentPoints(c, 8)).toBe(7);
    // over-cap levels never mint extra points
    expect(unspentPoints(c, 99)).toBe(7);
  });

  it("the menu is the contract: 6 stats, fixed amounts, per-stat cap 4", () => {
    expect(POINT_MENU.map((e) => e.stat)).toEqual([
      "hp",
      "atk",
      "def",
      "spd",
      "crt",
      "enMax",
    ]);
    const amounts = Object.fromEntries(
      POINT_MENU.map((e) => [e.stat, e.amount]),
    );
    expect(amounts).toEqual({
      hp: 3,
      atk: 1,
      def: 1,
      spd: 1,
      crt: 3,
      enMax: 1,
    });
    for (const e of POINT_MENU) expect(e.cap).toBe(4);
    // caps keep builds bounded: one stat can never eat the whole budget
    const totalCap = POINT_MENU.reduce((n, e) => n + e.cap, 0);
    expect(totalCap).toBeGreaterThan(7);
    for (const e of POINT_MENU) expect(e.cap).toBeLessThan(7);
  });

  it("spending folds into effectiveStats after growth, before equipment", () => {
    const base = cat("trickster", { hp: 28 });
    const grown = growthStats("trickster", 5);
    let c = spendPoint(base, "atk", 5);
    c = spendPoint(c, "crt", 5);
    const s = effectiveStats(c, 5);
    expect(s.atk).toBe(grown.atk + 1);
    expect(s.crt).toBe(grown.crt + 3);
    // and it stacks on top of gear rather than replacing it
    const bangle = makeEquipInstance(1, "yarnBangle", 3, "stray"); // enMax
    const geared = equipItem(c, bangle).cat;
    expect(effectiveStats(geared, 5).enMax).toBe(
      grown.enMax + (bangle.stats.enMax ?? 0),
    );
  });

  it("an hp point raises CURRENT hp by the same delta (the level-up rule)", () => {
    const c = cat("medic", { hp: 20 });
    const after = spendPoint(c, "hp", 4);
    expect(after.hp).toBe(23);
    expect(maxHp(after, 4)).toBe(maxHp(c, 4) + 3);
    // a non-hp point never touches current hp
    expect(spendPoint(c, "spd", 4).hp).toBe(20);
  });

  it("refuses illegal spends by returning the SAME state (pure no-op)", () => {
    const c = cat();
    // no points earned yet at L1
    expect(spendPoint(c, "atk", 1)).toBe(c);
    // over the per-stat cap: 5 hp points at L8 (7 available, cap 4)
    let maxed = c;
    for (let i = 0; i < 4; i++) maxed = spendPoint(maxed, "hp", 8);
    expect(maxed.points).toEqual({ hp: 4 });
    expect(spendPoint(maxed, "hp", 8)).toBe(maxed);
    // budget exhausted across stats
    let broke = c;
    for (const stat of ["hp", "atk", "def"] as const) {
      for (let i = 0; i < 4; i++) broke = spendPoint(broke, stat, 8);
    }
    expect(pointsSpent(broke)).toBe(7); // 4 + 3, then the wallet is empty
    expect(spendPoint(broke, "spd", 8)).toBe(broke);
    expect(unspentPoints(broke, 8)).toBe(0);
  });

  it("never mutates its input", () => {
    const c = cat();
    const snapshot = JSON.parse(JSON.stringify(c));
    spendPoint(c, "hp", 8);
    expect(c).toEqual(snapshot);
  });

  it("clearPoints refunds the budget and the hp it bought (min 1)", () => {
    let c = cat("hexer", { hp: 24 });
    c = spendPoint(c, "hp", 8);
    c = spendPoint(c, "hp", 8);
    expect(c.hp).toBe(30);
    const reset = clearPoints(c);
    expect(pointsSpent(reset)).toBe(0);
    expect(reset.hp).toBe(24);
    expect(unspentPoints(reset, 8)).toBe(7);
    expect(clearPoints(reset)).toBe(reset); // nothing to refund
    expect(clearPoints({ ...c, hp: 2 }).hp).toBe(1); // never below 1
  });

  it("BACKWARD COMPAT: a cat with no `points` stats exactly as before", () => {
    for (const id of ALL_CLASSES) {
      for (let lvl = 1; lvl <= 8; lvl++) {
        expect(effectiveStats(cat(id), lvl)).toEqual(growthStats(id, lvl));
      }
    }
  });
});

/* ================================================================== */
/* §2 Milestone unlocks                                                */
/* ================================================================== */

describe("milestone skill unlocks (progression.md §2)", () => {
  it("3 known at L1, +1 at L2 / L4 / L6 / L8 → 7 at cap", () => {
    for (const id of ALL_CLASSES) {
      const counts = [1, 2, 3, 4, 5, 6, 7, 8].map(
        (lvl) => knownSkills(id, lvl).length,
      );
      expect(counts).toEqual([3, 4, 4, 5, 5, 6, 6, 7]);
    }
  });

  it("keeps skillsForLevel working as the legacy alias", () => {
    expect(skillsForLevel).toBe(knownSkills);
    expect(skillsForLevel("bruiser", 1)).toEqual([
      "clawSwipe",
      "bodySlam",
      "hiss",
    ]);
    expect(skillsForLevel("bruiser", 4)).toContain("dumpsterDunk");
  });

  it("the 12 new skills exist, resolve, and stay inside the vocabulary", () => {
    const milestones = ALL_CLASSES.flatMap((id) =>
      CLASSES[id].skills.filter((s) => [2, 6, 8].includes(s.unlockLevel)),
    );
    expect(milestones).toHaveLength(12);
    for (const { skillId, unlockLevel } of milestones) {
      const sk = SKILLS[skillId];
      expect(sk, `missing skill '${skillId}'`).toBeDefined();
      expect(sk.id).toBe(skillId);
      // classes.md skill budget: cats are gated by energy (max 10), never
      // by cooldown, and later unlocks cost more than the L1 kit.
      expect(sk.cooldown).toBeUndefined();
      expect(sk.cost).toBeGreaterThan(0);
      expect(sk.cost).toBeLessThanOrEqual(8);
      if (unlockLevel === 2) expect(sk.cost).toBeLessThanOrEqual(4);
      if (unlockLevel === 8) expect(sk.cost).toBeGreaterThanOrEqual(7);
      expect(sk.usableFrom.length).toBeGreaterThan(0);
      for (const app of sk.applies ?? []) {
        expect(app.chance).toBeGreaterThan(0);
        expect(app.chance).toBeLessThanOrEqual(1);
      }
      expect(sk.desc.length).toBeGreaterThan(20); // every one has flavour
    }
  });

  it("each milestone gives its cat a tool its L1 kit did not have", () => {
    // bruiser: his only PULL, a party shield, and a row shove
    expect(SKILLS.scruffToss.moveTarget).toBeLessThan(0);
    expect(SKILLS.binLidBulwark.target.side).toBe("ally");
    expect(SKILLS.trashCompactor.target.pattern).toBe("row");
    // trickster: hit-and-run, Off-Balance without displacement, an AoE
    expect(SKILLS.bottleCapFlick.moveSelf).toBe(1);
    expect(SKILLS.whiskerFeint.applies?.[0].status).toBe("offBalance");
    expect(SKILLS.whiskerFeint.moveTarget).toBeUndefined();
    expect(SKILLS.everyBoxAtOnce.target.ranks).toEqual([1, 2, 3, 4, 5]);
    // hexer: row pull, guaranteed bleed, mass frazzle
    expect(SKILLS.snarlOfThreads.target.pattern).toBe("row");
    expect(SKILLS.snarlOfThreads.moveTarget).toBe(-1);
    expect(SKILLS.ninthKnotCurse.applies?.[0]).toMatchObject({
      status: "scratched",
      chance: 1.0,
    });
    expect(SKILLS.fullUnravel.applies?.[0].status).toBe("frazzled");
    // medic: tempo cleanse, pre-buff, a second revive
    expect(SKILLS.kneadTheKnots.cleanses).toEqual(["offBalance", "frazzled"]);
    expect(SKILLS.warmLoafPress.kind).toBe("utility");
    expect(SKILLS.ovenSpring.revivePct).toBeGreaterThan(0.3);
    expect(SKILLS.ovenSpring.oncePerBattle).toBe(true);
  });
});

/* ================================================================== */
/* §3 Loadout                                                          */
/* ================================================================== */

describe("skill loadout (progression.md §3)", () => {
  it("BACKWARD COMPAT: no loadout ⇒ the pre-progression kit at every level", () => {
    // The legacy kit is exactly "the first four entries of the class table":
    // Claw Swipe, the two L1 skills, then the L4 capstone once it unlocks.
    for (const id of ALL_CLASSES) {
      const table = CLASSES[id].skills;
      const legacy = (lvl: number): SkillId[] =>
        table
          .slice(0, 4)
          .filter((s) => s.unlockLevel <= lvl)
          .map((s) => s.skillId);
      const l2Unlock = table.find((s) => s.unlockLevel === 2)!.skillId;
      for (let lvl = 1; lvl <= 8; lvl++) {
        const active = activeSkills(cat(id), lvl);
        expect(active.length).toBeLessThanOrEqual(LOADOUT_SIZE);
        expect(active[0]).toBe(BASIC_SKILL_ID);
        if (lvl === 1 || lvl >= 4) {
          // L1 and L4+ (every level the shipped content ever reached with a
          // full four-skill bar) are byte-identical to the legacy kit
          expect(active).toEqual(legacy(lvl));
        } else {
          // L2/L3 fill the previously-EMPTY fourth slot with the new unlock
          expect(active).toEqual([...legacy(lvl), l2Unlock]);
        }
      }
    }
  });

  it("Claw Swipe is always slot 1 and the player picks the other 3", () => {
    const c = setLoadout(cat("bruiser"), 8, [
      "dumpsterDunk",
      "scruffToss",
      "trashCompactor",
    ]);
    expect(c.loadout).toEqual(["dumpsterDunk", "scruffToss", "trashCompactor"]);
    expect(activeSkills(c, 8)).toEqual([
      "clawSwipe",
      "dumpsterDunk",
      "scruffToss",
      "trashCompactor",
    ]);
    expect(benchedSkills(c, 8)).toEqual(["bodySlam", "hiss", "binLidBulwark"]);
  });

  it("rejects illegal loadouts (length, unknown, unlearned, dupes, basic)", () => {
    const c = cat("medic");
    const bad: SkillId[][] = [
      ["soothingPurr"], // too short
      ["soothingPurr", "nineLivesNudge", "purrquake", "ovenSpring"], // too long
      ["soothingPurr", "nineLivesNudge", "bodySlam"], // another class's skill
      ["soothingPurr", "nineLivesNudge", "ovenSpring"], // not known at L1
      ["soothingPurr", "soothingPurr", "nineLivesNudge"], // duplicate
      ["clawSwipe", "soothingPurr", "nineLivesNudge"], // basic is not a pick
      ["soothingPurr", "nineLivesNudge", "notASkill"], // nonsense id
    ];
    for (const ids of bad) expect(setLoadout(c, 1, ids)).toBe(c);
    // legal at the right level
    const ok = setLoadout(c, 8, [
      "soothingPurr",
      "nineLivesNudge",
      "ovenSpring",
    ]);
    expect(ok).not.toBe(c);
    expect(activeSkills(ok, 8)).toHaveLength(4);
  });

  it("silently drops picks the cat does not know yet, keeping Claw Swipe", () => {
    // a loadout chosen at L8, then inspected at L4 (shouldn't happen in the
    // run, but the engine must not hand the battle an unknown skill)
    const c = setLoadout(cat("hexer"), 8, [
      "phantomCucumber",
      "ninthKnotCurse",
      "fullUnravel",
    ]);
    expect(activeSkills(c, 4)).toEqual(["clawSwipe", "phantomCucumber"]);
    expect(activeSkills(c, 8)).toHaveLength(4);
  });

  it("clearLoadout returns to the default kit", () => {
    const c = setLoadout(cat("trickster"), 8, [
      "whiskerFeint",
      "everyBoxAtOnce",
      "bottleCapFlick",
    ]);
    const back = clearLoadout(c);
    expect(back.loadout).toBeUndefined();
    expect(activeSkills(back, 8)).toEqual(activeSkills(cat("trickster"), 8));
  });
});

/* ================================================================== */
/* §4 Collars — the third slot                                         */
/* ================================================================== */

describe("collar slot (progression.md §4)", () => {
  it("EQUIP_SLOTS is the canonical, ordered slot list", () => {
    expect(EQUIP_SLOTS).toEqual(["weapon", "trinket", "collar"]);
  });

  it("folds into effectiveStats alongside weapon and trinket", () => {
    const collar = makeEquipInstance(1, "wovenCollar", 4, "pedigree");
    const c = cat("bruiser", { collar });
    const bare = effectiveStats(cat("bruiser"), 4);
    const worn = effectiveStats(c, 4);
    expect(worn.def).toBe(bare.def + (collar.stats.def ?? 0));
    expect(worn.hp).toBe(bare.hp + (collar.stats.hp ?? 0));
    // absent (undefined) collar === empty (null) collar
    expect(effectiveStats(cat("bruiser", { collar: null }), 4)).toEqual(bare);
  });

  it("equips universally, with the hp rule on both directions", () => {
    const collar = makeEquipInstance(1, "quiltedGorget", 3, "stray"); // hp
    for (const id of ALL_CLASSES) {
      expect(canEquip(cat(id), collar)).toBe(true);
    }
    const e = equipItem(cat("medic", { hp: 26 }), collar);
    expect(e.cat.collar).toEqual(collar);
    expect(e.cat.hp).toBe(26 + (collar.stats.hp ?? 0));
    const u = unequipItem(e.cat, "collar");
    expect(u.removed).toEqual(collar);
    expect(u.cat.collar).toBeNull();
    expect(u.cat.hp).toBe(26);
    // unequipping an empty/absent slot is a no-op
    expect(unequipItem(cat(), "collar").removed).toBeNull();
  });

  it("replacing a worn collar returns the old one", () => {
    const a = makeEquipInstance(1, "wovenCollar", 1, "stray");
    const b = makeEquipInstance(2, "leadLinedCollar", 4, "pedigree");
    const worn = equipItem(cat("hexer", { hp: 24 }), a).cat;
    const r = equipItem(worn, b);
    expect(r.replaced).toEqual(a);
    expect(r.cat.collar).toEqual(b);
  });

  it("slot-generic helpers see it: grief loot, MOULT, inventory sort", () => {
    const weapon = makeEquipInstance(1, "chimeBell", 2, "stray");
    const collar = makeEquipInstance(2, "flealessBand", 2, "stray");
    const dead = cat("medic", { hp: 0, lives: 0, weapon, collar });
    const g = applyGriefLoot(dead, emptyInventory());
    expect(g.dropped).toEqual([weapon, collar]); // EQUIP_SLOTS order
    expect(g.cat.collar).toBeNull();

    // MOULT can pick the collar (index 1 of the two equipped pieces)
    const rng = { float: () => 0.75, int: (lo: number, hi: number) => hi };
    const m = applyMoult(
      rng,
      [cat("medic", { weapon, collar })],
      emptyInventory(),
    );
    expect(m.kind).toBe("downgrade");
    if (m.kind === "downgrade") expect(m.slot).toBe("collar");

    // sort ranks weapons, then trinkets, then collars
    const inv = {
      ...emptyInventory(),
      slots: [
        collar,
        makeEquipInstance(3, "tinBell", 1, "stray"),
        weapon,
        ...new Array(13).fill(null),
      ],
    };
    const sorted = sortInventory(inv, []);
    expect(
      sorted.slots
        .slice(0, 3)
        .map((s) => EQUIP_DEFS[(s as { defId: string }).defId].slot),
    ).toEqual(["weapon", "trinket", "collar"]);
  });

  it("appears in the wild drop ladder (weapon 40 / trinket 40 / collar 20)", () => {
    expect(EQUIP_SLOT_WEIGHTS.reduce((n, w) => n + w.weight, 0)).toBe(100);
    expect(EQUIP_SLOT_WEIGHTS.map((w) => w.slot)).toEqual([
      "weapon",
      "trinket",
      "collar",
    ]);
    // the weapon band keeps its 1..40 range, so no recorded stream moves
    expect(EQUIP_SLOT_WEIGHTS[0]).toEqual({ slot: "weapon", weight: 40 });
    expect(SHOP_GEAR_SLOT_WEIGHTS.reduce((n, w) => n + w.weight, 0)).toBe(100);

    // d100 = 81..100 lands on a collar
    const d100 = (v: number) => (v - 0.5) / 100;
    const vals = [d100(1), d100(90), 0.5];
    let i = 0;
    const rng = {
      float: () => vals[i++] ?? 0.5,
      int(lo: number, hi: number) {
        return lo + Math.floor(this.float() * (hi - lo + 1));
      },
    };
    const drop = rollOneEquip(
      rng,
      3,
      { stray: 100, sleek: 0, pedigree: 0, mewthical: 0 },
      { floor: 3, livingClasses: ALL_CLASSES, uniquesDropped: [], nextUid: 1 },
    );
    expect(EQUIP_DEFS[drop.defId].slot).toBe("collar");
  });

  it("the Peddler stocks one collar every landing, after the gear slot", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const stock = rollShopStock(mulberry32(hash("MEOW-1987", "shop", n)), {
        floor: n,
        livingClasses: ALL_CLASSES,
        uniquesDropped: [],
        nextUid: 1,
      });
      expect(stock.slots).toHaveLength(6);
      const last = stock.slots[5];
      expect(last.kind).toBe("equip");
      if (last.kind === "equip") {
        expect(EQUIP_DEFS[last.item.defId].slot).toBe("collar");
        expect(last.item.itemLevel).toBe(n + 1);
      }
    }
  });
});

/* ================================================================== */
/* §5 Save compatibility                                               */
/* ================================================================== */

describe("save v1 → v3 (progression.md §5 + run-map-and-dm.md §2)", () => {
  const seededRun = () => generateCurrentFloorMap(newRun("MEOW-1987"));

  it("SAVE_VERSION is 3 and serializeRun stamps it", () => {
    expect(SAVE_VERSION).toBe(3);
    expect(serializeRun(seededRun()).version).toBe(3);
  });

  it("migrates a v1 payload forward with no PROGRESSION loss", () => {
    const run = seededRun();
    const v3 = serializeRun(run);
    // a genuine v1 blob: version 1 and no progression fields anywhere
    const v1 = JSON.parse(JSON.stringify({ ...v3, version: 1 }));
    for (const c of v1.run.cats) {
      delete c.collar;
      delete c.points;
      delete c.loadout;
    }
    const migrated = migrateSave(v1)!;
    expect(migrated.version).toBe(3);
    // the progression fields stay absent (= v1 behaviour); only the run-map
    // traversal fields are stamped on, and the party is put back at the entry
    expect(migrated.run.cats).toEqual(v1.run.cats);
    expect(migrated.run.inventory).toEqual(v1.run.inventory);
    expect(migrated.run.currentNodeId).toBeNull();

    const storage = memoryStorage();
    storage.set(SAVE_KEY, JSON.stringify(v1));
    const loaded = loadRun(storage)!;
    expect(loaded).not.toBeNull();
    expect(loaded.cats.map((c) => c.classId)).toEqual(
      run.cats.map((c) => c.classId),
    );
    // and the loaded cats behave like v1 cats: full point budget, default kit
    for (const c of loaded.cats) {
      expect(unspentPoints(c, loaded.level)).toBe(loaded.level - 1);
      expect(activeSkills(c, loaded.level)).toEqual(
        activeSkills(cat(c.classId), loaded.level),
      );
      expect(c.collar).toBeUndefined();
    }
  });

  it("round-trips the new optional fields when they ARE present", () => {
    const run = seededRun();
    let bruno = run.cats[0];
    bruno = spendPoint(bruno, "hp", 4);
    bruno = spendPoint(bruno, "crt", 4);
    bruno = setLoadout(bruno, 4, ["hiss", "dumpsterDunk", "scruffToss"]);
    bruno = equipItem(
      bruno,
      makeEquipInstance(90, "wardCollar", 3, "stray"),
    ).cat;
    const withProgress = {
      ...run,
      level: 4,
      cats: [bruno, ...run.cats.slice(1)],
    };

    const storage = memoryStorage();
    storage.set(SAVE_KEY, JSON.stringify(serializeRun(withProgress)));
    const loaded = loadRun(storage)!;
    const back = loaded.cats[0];
    expect(back.points).toEqual({ hp: 1, crt: 1 });
    expect(back.loadout).toEqual(["hiss", "dumpsterDunk", "scruffToss"]);
    expect(back.collar?.defId).toBe("wardCollar");
    expect(effectiveStats(back, 4)).toEqual(effectiveStats(bruno, 4));
    expect(activeSkills(back, 4)).toEqual([
      "clawSwipe",
      "hiss",
      "dumpsterDunk",
      "scruffToss",
    ]);
  });

  it("an unknown version is rejected (deleted by loadRun)", () => {
    const v = serializeRun(seededRun());
    expect(migrateSave({ ...v, version: 7 } as never)).toBeNull();
  });
});
