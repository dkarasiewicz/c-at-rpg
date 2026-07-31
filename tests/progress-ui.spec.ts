/**
 * THE DEN — progression UI view-model tests (src/ui/overlays/progressPanel.ts).
 *
 * Everything the Den decides before it paints a pixel lives in pure helpers,
 * so it is testable headless: the stat-contribution breakdown, the XP band,
 * the Whisker Point rows (engine-validated, never UI-guessed), the loadout
 * slot model + its swap/validation rules, the skill and gear row models, the
 * keyboard focus model, and the level-up summary the loot overlay renders.
 *
 * The invariant that binds them: the UI NEVER decides legality — every
 * mutation helper defers to core/run/party and returns the SAME object when
 * the engine says no.
 */
import { describe, expect, it } from "vitest";
import type {
  CatRunState,
  EquipInstance,
  RunState,
  StatKey,
} from "../src/core/types.js";
import { newRun } from "../src/core/run/runState.js";
import {
  BASIC_SKILL_ID,
  LOADOUT_SIZE,
  POINT_MENU,
  activeSkills,
  effectiveStats,
  knownSkills,
  spendPoint,
  unspentPoints,
} from "../src/core/run/party.js";
import { CLASSES } from "../src/content/classes.js";
import { addEquip } from "../src/core/loot/inventory.js";
import {
  DEN_SECTIONS,
  assignToSlot,
  buildBackpackRows,
  buildGearRows,
  buildLevelUpSummary,
  buildPointRows,
  buildSkillRows,
  buildStatRows,
  canEditLoadout,
  catsNeedingPoints,
  cycleSection,
  levelUpCardHeight,
  loadoutPicks,
  loadoutSlots,
  moveFocus,
  skillName,
  standName,
  totalUnspentPoints,
  xpProgress,
  type DenFocus,
  type DenSection,
} from "../src/ui/overlays/progressPanel.js";

/* ---------------------------------------------------------------------- */
/* fixtures                                                                */
/* ---------------------------------------------------------------------- */

const run = (): RunState => newRun("DEN-TEST");

/** run.cats is the fixed [bruiser, trickster, hexer, medic] order. */
const BRUNO = 0;

const collar = (uid = 900): EquipInstance => ({
  uid,
  defId: "wovenCollar",
  itemLevel: 3,
  rarity: "sleek",
  stats: { hp: 5, def: 2 },
});

const trinket = (uid = 901): EquipInstance => ({
  uid,
  defId: "tinBell",
  itemLevel: 2,
  rarity: "stray",
  stats: { spd: 2 },
});

/** A trickster weapon — Bruno may never wear it (class lock). */
const rapier = (uid = 902): EquipInstance => ({
  uid,
  defId: "ribbonRapier",
  itemLevel: 2,
  rarity: "stray",
  stats: { atk: 3 },
});

/* ---------------------------------------------------------------------- */
/* flavour lookups                                                         */
/* ---------------------------------------------------------------------- */

describe("standName / skillName", () => {
  it("lifts each cat's Stand out of its bio", () => {
    expect(standName("bruiser")).toBe("THE DUMPSTER KING");
    expect(standName("trickster")).toBe("BOX AMBUSH");
    expect(standName("hexer")).toBe("STRING THEORY");
    expect(standName("medic")).toBe("PURR ENGINE");
  });

  it("resolves skill display names and survives unknown ids", () => {
    expect(skillName(BASIC_SKILL_ID)).toBe("Claw Swipe");
    expect(skillName("nope:notAThing")).toBe("nope:notAThing");
  });
});

/* ---------------------------------------------------------------------- */
/* stat breakdown                                                          */
/* ---------------------------------------------------------------------- */

describe("buildStatRows", () => {
  it("has one row per stat, in POINT_MENU order", () => {
    const r = run();
    const rows = buildStatRows(r.cats[BRUNO], r.level);
    expect(rows.map((x) => x.stat)).toEqual(POINT_MENU.map((e) => e.stat));
  });

  it("columns sum to the engine's effective total", () => {
    const r = run();
    let cat = r.cats[BRUNO];
    cat = { ...cat, collar: collar(), tempMods: [] };
    cat = spendPoint(cat, "atk", 5);
    const rows = buildStatRows(cat, 5);
    const eff = effectiveStats(cat, 5);
    for (const row of rows) {
      expect(row.base + row.points + row.gear + row.temp).toBe(row.total);
      expect(row.total).toBe(eff[row.stat]);
    }
  });

  it("attributes each contribution to the right column", () => {
    const r = run();
    const base = buildStatRows(r.cats[BRUNO], 1);
    const baseAtk = base.find((x) => x.stat === "atk")!;
    expect(baseAtk.points).toBe(0);
    expect(baseAtk.temp).toBe(0);

    let cat = spendPoint(r.cats[BRUNO], "atk", 3);
    cat = {
      ...cat,
      collar: collar(),
      tempMods: [
        { stat: "def", amount: 2, duration: "floor", sourceEventId: "e" },
      ],
    };
    const rows = buildStatRows(cat, 3);
    const atk = rows.find((x) => x.stat === "atk")!;
    const def = rows.find((x) => x.stat === "def")!;
    const hp = rows.find((x) => x.stat === "hp")!;
    expect(atk.points).toBe(1); // +1 ATK per point
    expect(def.gear).toBe(2); // the collar
    expect(def.temp).toBe(2); // the event buff
    expect(hp.gear).toBe(5);
    // the weapon Bruno starts with lives in the gear column, not in base
    expect(rows.find((x) => x.stat === "atk")!.gear).toBeGreaterThan(0);
  });

  it("folds every worn slot, including an absent collar (v1 cat)", () => {
    const r = run();
    const cat = r.cats[BRUNO];
    expect(cat.collar).toBeUndefined();
    const rows = buildStatRows(cat, 1);
    expect(rows.every((x) => Number.isFinite(x.gear))).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* XP band                                                                 */
/* ---------------------------------------------------------------------- */

describe("xpProgress", () => {
  it("measures position inside the current level band", () => {
    const p = xpProgress(15, 1); // band 0..30
    expect(p.inLevel).toBe(15);
    expect(p.span).toBe(30);
    expect(p.frac).toBeCloseTo(0.5);
    expect(p.toNext).toBe(15);
    expect(p.capped).toBe(false);
  });

  it("reads empty at a fresh band and full at the cap", () => {
    expect(xpProgress(30, 2).inLevel).toBe(0);
    expect(xpProgress(30, 2).frac).toBe(0);
    const capped = xpProgress(999, 8);
    expect(capped.capped).toBe(true);
    expect(capped.frac).toBe(1);
    expect(capped.toNext).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* Whisker Points                                                          */
/* ---------------------------------------------------------------------- */

describe("buildPointRows", () => {
  it("mirrors POINT_MENU and blocks spending with no points banked", () => {
    const r = run(); // level 1 ⇒ 0 points earned
    const rows = buildPointRows(r.cats[BRUNO], 1);
    expect(rows).toHaveLength(POINT_MENU.length);
    expect(rows.every((x) => !x.canSpend)).toBe(true);
    expect(rows.every((x) => x.blockedBy === "no-points")).toBe(true);
    expect(rows.map((x) => x.cap)).toEqual(POINT_MENU.map((e) => e.cap));
  });

  it("opens every row once a point is banked and tracks what was spent", () => {
    const r = run();
    const cat = spendPoint(r.cats[BRUNO], "hp", 5); // 4 points banked at L5
    const rows = buildPointRows(cat, 5);
    expect(rows.every((x) => x.canSpend)).toBe(true);
    expect(rows.find((x) => x.stat === "hp")!.spent).toBe(1);
  });

  it("reports a capped stat as MAXED, not as 'no points'", () => {
    const r = run();
    let cat = r.cats[BRUNO];
    const cap = POINT_MENU[0].cap;
    for (let i = 0; i < cap; i++) cat = spendPoint(cat, "hp", 8);
    const rows = buildPointRows(cat, 8);
    const hp = rows.find((x) => x.stat === "hp")!;
    expect(hp.spent).toBe(cap);
    expect(hp.canSpend).toBe(false);
    expect(hp.blockedBy).toBe("capped");
    // other rows are still live (7 points at L8, 4 spent)
    expect(rows.find((x) => x.stat === "atk")!.canSpend).toBe(true);
  });
});

describe("point badges", () => {
  it("counts nothing at level 1 and every cat's point after a level-up", () => {
    const r = run();
    expect(totalUnspentPoints(r)).toBe(0);
    expect(catsNeedingPoints(r)).toEqual([]);

    const leveled: RunState = { ...r, level: 3 }; // 2 points each
    expect(totalUnspentPoints(leveled)).toBe(2 * leveled.cats.length);
    expect(catsNeedingPoints(leveled)).toEqual([0, 1, 2, 3]);
  });

  it("ignores cats that are out of Lives", () => {
    const r = run();
    const cats = r.cats.slice();
    cats[BRUNO] = { ...cats[BRUNO], lives: 0 };
    const leveled: RunState = { ...r, level: 2, cats };
    expect(catsNeedingPoints(leveled)).toEqual([1, 2, 3]);
    expect(totalUnspentPoints(leveled)).toBe(3);
  });
});

/* ---------------------------------------------------------------------- */
/* loadout                                                                 */
/* ---------------------------------------------------------------------- */

describe("loadout slot model", () => {
  it("pads to 4 slots with Claw Swipe pinned to slot 1", () => {
    const r = run();
    const slots = loadoutSlots(r.cats[BRUNO], 1);
    expect(slots).toHaveLength(LOADOUT_SIZE);
    expect(slots[0]).toBe(BASIC_SKILL_ID);
    expect(slots[3]).toBeNull(); // only 3 skills known at L1
    expect(loadoutPicks(r.cats[BRUNO], 1)).toHaveLength(2);
  });

  it("cannot be edited until 3 non-basic skills are known", () => {
    const r = run();
    expect(canEditLoadout(r.cats[BRUNO], 1)).toBe(false);
    expect(canEditLoadout(r.cats[BRUNO], 2)).toBe(true);
  });

  it("mirrors activeSkills exactly", () => {
    const r = run();
    const cat = r.cats[BRUNO];
    expect(loadoutSlots(cat, 6).filter((x) => x !== null)).toEqual(
      activeSkills(cat, 6),
    );
  });
});

describe("assignToSlot", () => {
  const bruno = (): CatRunState => run().cats[BRUNO];

  it("benches the old occupant when a benched skill takes a slot", () => {
    const cat = bruno();
    const level = 6;
    const before = loadoutPicks(cat, level);
    const benchedId = knownSkills("bruiser", level).find(
      (id) => id !== BASIC_SKILL_ID && !before.includes(id),
    )!;
    const next = assignToSlot(cat, level, 2, benchedId);
    const after = loadoutPicks(next, level);
    expect(after[1]).toBe(benchedId);
    expect(after).not.toContain(before[1]);
    expect(after).toHaveLength(LOADOUT_SIZE - 1);
    expect(new Set(after).size).toBe(after.length);
  });

  it("swaps in place when the skill already sits in another slot", () => {
    const cat = bruno();
    const level = 6;
    const picks = loadoutPicks(cat, level);
    const next = assignToSlot(cat, level, 1, picks[2]);
    expect(loadoutPicks(next, level)).toEqual([picks[2], picks[1], picks[0]]);
  });

  it("refuses slot 1, unknown ids, unlearned skills and Claw Swipe", () => {
    const cat = bruno();
    const level = 6;
    const picks = loadoutPicks(cat, level);
    expect(assignToSlot(cat, level, 0, picks[0])).toBe(cat); // slot 1 is locked
    expect(assignToSlot(cat, level, 4, picks[0])).toBe(cat); // no such slot
    expect(assignToSlot(cat, level, 2, BASIC_SKILL_ID)).toBe(cat);
    expect(assignToSlot(cat, level, 2, "notARealSkill")).toBe(cat);
    // known to the class but not yet unlocked at this level
    expect(assignToSlot(cat, 2, 2, "trashCompactor")).toBe(cat);
  });

  it("is a no-op while the cat has fewer than 3 skills to choose from", () => {
    const cat = bruno();
    expect(assignToSlot(cat, 1, 2, "hiss")).toBe(cat);
  });

  it("never produces a loadout the engine would reject", () => {
    const cat = bruno();
    const level = 8;
    const known = knownSkills("bruiser", level).filter(
      (id) => id !== BASIC_SKILL_ID,
    );
    let next = cat;
    for (const id of known) next = assignToSlot(next, level, 3, id);
    const picks = loadoutPicks(next, level);
    expect(picks).toHaveLength(3);
    expect(new Set(picks).size).toBe(3);
    expect(picks).not.toContain(BASIC_SKILL_ID);
    expect(activeSkills(next, level)[0]).toBe(BASIC_SKILL_ID);
  });
});

/* ---------------------------------------------------------------------- */
/* skill rows                                                              */
/* ---------------------------------------------------------------------- */

describe("buildSkillRows", () => {
  it("lists every skill the class will ever have, ordered by unlock level", () => {
    const r = run();
    const rows = buildSkillRows(r.cats[BRUNO], 1);
    expect(rows).toHaveLength(CLASSES.bruiser.skills.length);
    const levels = rows.map((x) => x.unlockLevel);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
  });

  it("marks locked skills with their unlock level and no slot", () => {
    const r = run();
    const rows = buildSkillRows(r.cats[BRUNO], 1);
    const locked = rows.filter((x) => !x.known);
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every((x) => x.slot === null)).toBe(true);
    expect(locked.every((x) => x.unlockLevel > 1)).toBe(true);
  });

  it("marks slot occupancy, the bench, and slot 1's basic", () => {
    const r = run();
    const rows = buildSkillRows(r.cats[BRUNO], 8);
    const basic = rows.find((x) => x.skillId === BASIC_SKILL_ID)!;
    expect(basic.basic).toBe(true);
    expect(basic.slot).toBe(0);
    const inSlots = rows.filter((x) => x.slot !== null);
    expect(inSlots).toHaveLength(LOADOUT_SIZE);
    const benched = rows.filter((x) => x.known && x.slot === null);
    expect(benched.length).toBe(rows.filter((x) => x.known).length - 4);
    expect(rows.every((x) => typeof x.cost === "number")).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* gear rows                                                               */
/* ---------------------------------------------------------------------- */

describe("gear rows", () => {
  it("always shows all three slots, empty collar included", () => {
    const r = run();
    const rows = buildGearRows(r.cats[BRUNO]);
    expect(rows.map((x) => x.slot)).toEqual(["weapon", "trinket", "collar"]);
    expect(rows[0].item).not.toBeNull(); // the starting weapon
    expect(rows[2].item).toBeNull(); // no collar, and no crash
  });

  it("lists only backpack pieces this cat can actually wear", () => {
    const r = run();
    let inv = addEquip(r.inventory, collar()).inv;
    inv = addEquip(inv, trinket()).inv;
    inv = addEquip(inv, rapier()).inv; // trickster-only weapon
    const withInv: RunState = { ...r, inventory: inv };
    const rows = buildBackpackRows(withInv, BRUNO);
    const defIds = rows.map((x) => x.item.defId);
    expect(defIds).toContain("wovenCollar");
    expect(defIds).toContain("tinBell");
    expect(defIds).not.toContain("ribbonRapier");
    expect(rows.find((x) => x.item.defId === "wovenCollar")!.slot).toBe(
      "collar",
    );
  });

  it("computes the stat delta against the slot the cat currently wears", () => {
    const r = run();
    const cats = r.cats.slice();
    cats[BRUNO] = { ...cats[BRUNO], collar: collar(800) };
    const inv = addEquip(r.inventory, {
      ...collar(801),
      stats: { hp: 9, def: 2 },
    }).inv;
    const rows = buildBackpackRows({ ...r, cats, inventory: inv }, BRUNO);
    const row = rows.find((x) => x.item.uid === 801)!;
    expect(row.delta).toBe("HP +4"); // 9 vs the worn 5; DEF unchanged
  });

  it("offers nothing to a cat that is gone for good", () => {
    const r = run();
    const cats = r.cats.slice();
    cats[BRUNO] = { ...cats[BRUNO], lives: 0 };
    const inv = addEquip(r.inventory, collar()).inv;
    expect(buildBackpackRows({ ...r, cats, inventory: inv }, BRUNO)).toEqual(
      [],
    );
  });
});

/* ---------------------------------------------------------------------- */
/* focus model                                                             */
/* ---------------------------------------------------------------------- */

describe("focus model", () => {
  const at = (section: DenSection, index: number): DenFocus => ({
    section,
    index,
  });

  it("wraps the row cursor inside the section", () => {
    expect(moveFocus(at("points", 0), 6, -1).index).toBe(5);
    expect(moveFocus(at("points", 5), 6, 1).index).toBe(0);
    expect(moveFocus(at("points", 2), 6, 1).index).toBe(3);
  });

  it("clamps into range when the section shrank under the cursor", () => {
    expect(moveFocus(at("gear", 9), 3, 1).index).toBe(0);
    expect(moveFocus(at("gear", 4), 0, 1)).toEqual(at("gear", 0));
  });

  it("cycles sections in both directions and resets the row", () => {
    const counts = { points: 6, skills: 7, gear: 3 };
    expect(cycleSection(at("points", 4), counts, 1)).toEqual(at("skills", 0));
    expect(cycleSection(at("points", 4), counts, -1)).toEqual(at("gear", 0));
    expect(cycleSection(at("gear", 0), counts, 1)).toEqual(at("points", 0));
  });

  it("skips empty sections", () => {
    const counts = { points: 6, skills: 0, gear: 3 };
    expect(cycleSection(at("points", 0), counts, 1)).toEqual(at("gear", 0));
  });

  it("stays put when nothing has rows", () => {
    const counts = { points: 0, skills: 0, gear: 0 };
    expect(cycleSection(at("points", 3), counts, 1)).toEqual(at("points", 0));
    expect(DEN_SECTIONS).toEqual(["points", "skills", "gear"]);
  });
});

/* ---------------------------------------------------------------------- */
/* level-up summary                                                        */
/* ---------------------------------------------------------------------- */

describe("buildLevelUpSummary", () => {
  it("reports the growth rows a single level actually granted", () => {
    const r = run();
    const s = buildLevelUpSummary(r.cats, 1, 2);
    expect(s.fromLevel).toBe(1);
    expect(s.toLevel).toBe(2);
    expect(s.pointsEach).toBe(1);
    expect(s.cats).toHaveLength(4);
    const bruno = s.cats[0];
    const row = CLASSES.bruiser.growth[0];
    for (const g of bruno.gains) {
      expect(g.amount).toBe(row[g.stat as StatKey]);
    }
    expect(bruno.gains.map((g) => g.stat).sort()).toEqual(
      Object.keys(row).sort(),
    );
  });

  it("accumulates multi-level jumps and every skill unlocked on the way", () => {
    const r = run();
    const s = buildLevelUpSummary(r.cats, 1, 4);
    expect(s.pointsEach).toBe(3);
    const before = knownSkills("bruiser", 1);
    const after = knownSkills("bruiser", 4);
    expect(s.cats[0].newSkills).toEqual(
      after.filter((id) => !before.includes(id)),
    );
    expect(s.cats[0].newSkills.length).toBe(2); // the L2 and L4 unlocks
    const hp = s.cats[0].gains.find((g) => g.stat === "hp")!;
    expect(hp.amount).toBe(
      CLASSES.bruiser.growth.slice(0, 3).reduce((n, g) => n + (g.hp ?? 0), 0),
    );
  });

  it("skips cats that are out of Lives", () => {
    const r = run();
    const cats = r.cats.slice();
    cats[BRUNO] = { ...cats[BRUNO], lives: 0 };
    const s = buildLevelUpSummary(cats, 2, 3);
    expect(s.cats).toHaveLength(3);
    expect(s.cats.some((c) => c.classId === "bruiser")).toBe(false);
  });

  it("is empty (and zero-height) when nothing changed", () => {
    const r = run();
    expect(buildLevelUpSummary(r.cats, 4, 4).pointsEach).toBe(0);
    expect(levelUpCardHeight(r.cats, 4, 4)).toBe(0);
    expect(levelUpCardHeight(r.cats, 5, 4)).toBe(0);
  });

  it("grows the card when there is more to say", () => {
    const r = run();
    const one = levelUpCardHeight(r.cats, 2, 3); // no unlocks at L3
    const two = levelUpCardHeight(r.cats, 3, 4); // every cat's capstone
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
  });
});

/* ---------------------------------------------------------------------- */
/* the binding invariant                                                   */
/* ---------------------------------------------------------------------- */

describe("the UI never overrides the engine", () => {
  it("point rows agree with unspentPoints at every level", () => {
    const r = run();
    for (let level = 1; level <= 8; level++) {
      let cat = r.cats[BRUNO];
      // spend everything available, one row at a time
      for (let i = 0; i < 12; i++) {
        const row = buildPointRows(cat, level).find((x) => x.canSpend);
        if (!row) break;
        const next = spendPoint(cat, row.stat as StatKey, level);
        expect(next).not.toBe(cat); // the row promised it was legal
        cat = next;
      }
      expect(unspentPoints(cat, level)).toBe(0);
      expect(buildPointRows(cat, level).some((x) => x.canSpend)).toBe(false);
    }
  });
});
