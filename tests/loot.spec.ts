/**
 * WP-05 acceptance tests — loot & economy engine (loot.md, ARCHITECTURE §5).
 *
 * Covers: §5e roll order with an instrumented scripted Rng (unneeded rolls
 * skipped, not burned), §3 value formulas against the doc's reference
 * tables, rarity bands, slot 40/60, living-classes weapon pick, Mewthical
 * unique-or-downgrade, prices/sell/Warm Lap, inventory invariants, grief
 * loot, MOULT, and a recorded shop fixture for a known seed.
 */
import { describe, expect, it } from "vitest";
import type {
  CatRunState,
  ClassId,
  EquipInstance,
  Rarity,
  Rng,
} from "../src/core/types.js";
import { hash, mulberry32 } from "../src/core/rng.js";
import { EQUIP_DEFS } from "../src/content/equipment.js";
import {
  baseValue,
  floorBand,
  makeEquipInstance,
  primaryValue,
  rollBossLoot,
  rollBundle,
  rollChest,
  rollOneEquip,
  rollVictory,
  secondaryValue,
  type LootCtx,
} from "../src/core/loot/roll.js";
import {
  INVENTORY_SLOTS,
  addConsumables,
  addEquip,
  addShinies,
  applyGrant,
  applyGriefLoot,
  applyMoult,
  canEquip,
  downgradeEquip,
  emptyInventory,
  equipItem,
  isStack,
  removeConsumable,
  takeReplacing,
  unequipItem,
} from "../src/core/loot/inventory.js";
import {
  buyStockItem,
  buyWarmLap,
  equipValue,
  rollShopStock,
  sellFromInventory,
  sellValue,
  warmLapCost,
  warmLapHeal,
} from "../src/core/loot/shop.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Scripted Rng: yields exact float draws; throws when over-consumed. */
function scripted(vals: number[]): { rng: Rng; used: () => number } {
  let i = 0;
  const rng: Rng = {
    float() {
      if (i >= vals.length) throw new Error(`scripted rng exhausted at ${i}`);
      return vals[i++];
    },
    int(lo, hi) {
      return lo + Math.floor(rng.float() * (hi - lo + 1));
    },
  };
  return { rng, used: () => i };
}

/** Float that makes `rng.int(1,100)` yield exactly `v` (robust mid-point). */
const d100 = (v: number) => (v - 0.5) / 100;
/** Float that makes `rng.int(0, n-1)` yield exactly `k`. */
const idx = (k: number, n: number) => (k + 0.5) / n;

const ALL_CLASSES: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

function ctx(over: Partial<LootCtx> = {}): LootCtx {
  return {
    floor: 1,
    livingClasses: ALL_CLASSES,
    uniquesDropped: [],
    nextUid: 1,
    ...over,
  };
}

function cat(classId: ClassId, hp = 20, lives = 9): CatRunState {
  return {
    classId,
    hp,
    lives,
    weapon: null,
    trinket: null,
    tempMods: [],
    energyNextBattle: 0,
  };
}

/* ------------------------------------------------------------------ */
/* §3 value formulas                                                   */
/* ------------------------------------------------------------------ */

describe("value formulas (loot.md §3)", () => {
  const RARITIES: Rarity[] = ["stray", "sleek", "pedigree", "mewthical"];

  it("matches the weapon atk primary reference table", () => {
    const table: Record<number, number[]> = {
      1: [2, 3, 3, 4],
      3: [4, 5, 6, 7],
      6: [7, 9, 11, 12],
    };
    for (const [L, row] of Object.entries(table)) {
      RARITIES.forEach((r, i) => {
        expect(primaryValue("atk", Number(L), r, "weapon")).toBe(row[i]);
      });
    }
  });

  it("matches the hp primary reference values", () => {
    expect(RARITIES.map((r) => primaryValue("hp", 1, r, "trinket"))).toEqual([
      5, 6, 8, 9,
    ]);
    expect(RARITIES.map((r) => primaryValue("hp", 6, r, "trinket"))).toEqual([
      15, 19, 23, 26,
    ]);
  });

  it("uses the reduced trinket-atk base ceil((1+L)/2)", () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((L) => baseValue("atk", L, "trinket")),
    ).toEqual([1, 2, 2, 3, 3, 4]);
    expect(
      [1, 2, 3, 4, 5, 6].map((L) => baseValue("atk", L, "weapon")),
    ).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("def/spd/enMax are 1 through L3 and 2 after; crt is 3+L; hp is 3+2L", () => {
    expect(baseValue("def", 3, "trinket")).toBe(1);
    expect(baseValue("spd", 4, "trinket")).toBe(2);
    expect(baseValue("enMax", 6, "trinket")).toBe(2);
    expect(baseValue("crt", 5, "trinket")).toBe(8);
    expect(baseValue("hp", 4, "trinket")).toBe(11);
  });

  it("secondaries are half base, round half up, min 1", () => {
    expect(secondaryValue("def", 1, "sleek", "trinket")).toBe(1); // 0.625 → 1
    expect(secondaryValue("hp", 6, "mewthical", "trinket")).toBe(13); // 13.125
    expect(secondaryValue("crt", 6, "mewthical", "trinket")).toBe(8); // 7.875
  });

  it("reproduces the worked item examples", () => {
    // Pedigree Cardboard Cuirass, L5: def +3, hp +10, spd +2
    const cuirass = makeEquipInstance(1, "cardboardCuirass", 5, "pedigree");
    expect(cuirass.stats).toEqual({ def: 3, hp: 10, spd: 2 });
    expect(cuirass.hook).toBeUndefined();
    // Mewthical Yarn Bangle "Ball of Pure Yarn", L6: enMax +4, hp +13, crt +8
    const bangle = makeEquipInstance(2, "yarnBangle", 6, "mewthical");
    expect(bangle.stats).toEqual({ enMax: 4, hp: 13, crt: 8 });
    expect(bangle.hook).toBe("startEnergy6");
    // Sleek carries exactly one secondary — the rolled one
    const rapier = makeEquipInstance(3, "ribbonRapier", 3, "sleek", "crt");
    expect(rapier.stats).toEqual({ atk: 5, crt: 4 });
  });

  it("floor bands are 1-2 / 3-4 / 5-6", () => {
    expect([1, 2, 3, 4, 5, 6].map(floorBand)).toEqual([
      "f12",
      "f12",
      "f34",
      "f34",
      "f56",
      "f56",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* §5e roll order (skip, don't burn)                                   */
/* ------------------------------------------------------------------ */

describe("roll order (loot.md §5e)", () => {
  it("victory with both drops missed consumes exactly 3 draws", () => {
    const { rng, used } = scripted([0.5, 0.9, 0.95]);
    const g = rollVictory(rng, ctx());
    expect(g.shinies).toBe(8 + 4 + 2); // 8+4n + int(0,4)=2
    expect(g.equips).toEqual([]);
    expect(g.consumables).toEqual([]);
    expect(used()).toBe(3); // variance + 2 chance rolls, nothing burned
  });

  it("victory rolls in order: variance, chances, consumable pick, equip ladder", () => {
    const { rng, used } = scripted([
      0, // ① variance → +0
      0.2, // ② consumable chance (< .25 hit)
      0.05, // ② equipment chance (< .10 hit)
      d100(1), // consumable pick → tunaSnack
      d100(56), // ④ rarity (f12: 56 → sleek)
      d100(41), // ⑤ slot (41 → trinket)
      idx(0, 6), // ⑥ def → fluffyCollar
      idx(0, 2), // ⑦ sleek secondary → def
    ]);
    const g = rollVictory(rng, ctx());
    expect(g.shinies).toBe(12);
    expect(g.consumables).toEqual([{ defId: "tunaSnack", count: 1 }]);
    expect(g.equips).toEqual([
      {
        uid: 1,
        defId: "fluffyCollar",
        itemLevel: 1,
        rarity: "sleek",
        stats: { hp: 6, def: 1 },
      },
    ]);
    expect(used()).toBe(8);
  });

  it("chest: 2 draws; stray equipment skips the secondary roll", () => {
    const { rng, used } = scripted([
      d100(1), // draw 1 → consumable
      d100(21), // pick → sardineTin
      d100(61), // draw 2 → equipment
      d100(1), // rarity → stray
      d100(1), // slot → weapon
      idx(0, 4), // class → bruiser
      // no ⑦ roll for stray — skipped, not burned
    ]);
    const g = rollChest(rng, ctx());
    expect(g.shinies).toBe(15 + 8); // 15+8n, no roll
    expect(g.consumables).toEqual([{ defId: "sardineTin", count: 1 }]);
    expect(g.equips).toEqual([
      {
        uid: 1,
        defId: "mittsOfMenace",
        itemLevel: 1,
        rarity: "stray",
        stats: { atk: 2 },
      },
    ]);
    expect(used()).toBe(6);
  });

  it("chest shiny-pile draws add 15+8n each with no further rolls", () => {
    const { rng, used } = scripted([d100(91), d100(100)]);
    const g = rollChest(rng, ctx({ floor: 3 }));
    expect(g.shinies).toBe(3 * (15 + 24)); // open + two piles
    expect(used()).toBe(2);
  });

  it("is deterministic: same seed, same grant", () => {
    const seed = hash("MEOW-1987", 2, "loot", 0);
    const a = rollChest(mulberry32(seed), ctx({ floor: 2 }));
    const b = rollChest(mulberry32(seed), ctx({ floor: 2 }));
    expect(a).toEqual(b);
  });
});

/* ------------------------------------------------------------------ */
/* equipment ladder: slot, living classes, mewthical rule              */
/* ------------------------------------------------------------------ */

describe("equipment roll ladder (loot.md §5)", () => {
  const F12 = { stray: 55, sleek: 35, pedigree: 9, mewthical: 1 } as const;

  it("weapon class is uniform over LIVING classes only", () => {
    const living: ClassId[] = ["trickster", "medic"];
    const a = rollOneEquip(
      scripted([d100(1), d100(1), idx(0, 2)]).rng,
      1,
      F12,
      ctx({ livingClasses: living }),
    );
    expect(a.defId).toBe("ribbonRapier");
    const b = rollOneEquip(
      scripted([d100(1), d100(1), idx(1, 2)]).rng,
      1,
      F12,
      ctx({ livingClasses: living }),
    );
    expect(b.defId).toBe("chimeBell"); // a dead class's weapon never drops
  });

  it("slot roll is weapon 40 / trinket 60", () => {
    const w = rollOneEquip(
      scripted([d100(1), d100(40), idx(0, 4)]).rng,
      1,
      F12,
      ctx(),
    );
    expect(w.defId).toBe("mittsOfMenace");
    const t = rollOneEquip(
      scripted([d100(1), d100(41), idx(0, 6)]).rng,
      1,
      F12,
      ctx(),
    );
    expect(t.defId).toBe("fluffyCollar");
  });

  it("a Mewthical roll becomes the def's unique with its hook", () => {
    const inst = rollOneEquip(
      scripted([d100(100), d100(41), idx(2, 6)]).rng, // mewthical, trinket, tinBell
      1,
      F12,
      ctx(),
    );
    expect(inst.rarity).toBe("mewthical");
    expect(inst.hook).toBe("ninthBell");
    expect(inst.stats).toEqual({ spd: 2, crt: 4, enMax: 1 });
  });

  it("an already-dropped unique downgrades to Pedigree of the same def", () => {
    const inst = rollOneEquip(
      scripted([d100(100), d100(41), idx(2, 6)]).rng,
      1,
      F12,
      ctx({ uniquesDropped: ["ninthBell"] }),
    );
    expect(inst.rarity).toBe("pedigree");
    expect(inst.defId).toBe("tinBell");
    expect(inst.hook).toBeUndefined();
  });

  it("defs without a unique (Spiked Collar) downgrade to Pedigree", () => {
    const inst = rollOneEquip(
      scripted([d100(100), d100(41), idx(5, 6)]).rng,
      1,
      F12,
      ctx(),
    );
    expect(inst.defId).toBe("spikedCollar");
    expect(inst.rarity).toBe("pedigree");
    expect(inst.hook).toBeUndefined();
  });

  it("two mewthical rolls of one def in the SAME chest: second downgrades", () => {
    const equipDraw = [d100(61), d100(100), d100(41), idx(2, 6)];
    const { rng } = scripted([...equipDraw, ...equipDraw]);
    const g = rollChest(rng, ctx());
    expect(g.equips.map((e) => e.rarity)).toEqual(["mewthical", "pedigree"]);
    expect(g.equips.map((e) => e.defId)).toEqual(["tinBell", "tinBell"]);
    expect(g.equips.map((e) => e.uid)).toEqual([1, 2]);
  });
});

/* ------------------------------------------------------------------ */
/* boss loot & bundles                                                 */
/* ------------------------------------------------------------------ */

describe("boss loot (loot.md §5c) and bundles (§5d)", () => {
  it("boss: shinies 60+25n, 1 equip at L=floor+1 (pedigree/mewthical), 2 consumables", () => {
    const { rng, used } = scripted([
      d100(1), // rarity → pedigree (70/30, zero-weight stray/sleek skipped)
      d100(1), // slot → weapon
      idx(0, 4), // class → bruiser
      d100(1), // consumable 1 → tuna
      d100(1), // consumable 2 → tuna
    ]);
    const g = rollBossLoot(rng, ctx({ floor: 3 }));
    expect(g.shinies).toBe(60 + 75);
    expect(g.equips).toEqual([
      {
        uid: 1,
        defId: "mittsOfMenace",
        itemLevel: 4, // floor + 1
        rarity: "pedigree",
        stats: { atk: 8, hp: 8, def: 2 },
      },
    ]);
    expect(g.consumables).toEqual([{ defId: "tunaSnack", count: 2 }]);
    expect(used()).toBe(5);
  });

  it("SNACK_STASH rolls 2 consumables; SHINY_HOARD pays 30+10n roll-free", () => {
    const snack = rollBundle(
      scripted([d100(1), d100(21)]).rng,
      "SNACK_STASH",
      ctx(),
    );
    expect(snack.consumables).toEqual([
      { defId: "tunaSnack", count: 1 },
      { defId: "sardineTin", count: 1 },
    ]);
    const { rng, used } = scripted([]);
    const hoard = rollBundle(rng, "SHINY_HOARD", ctx({ floor: 2 }));
    expect(hoard.shinies).toBe(50);
    expect(used()).toBe(0);
  });

  it("GEAR_FANCY rolls L=floor+1 at pedigree 70 / mewthical 30", () => {
    const g = rollBundle(
      scripted([d100(70), d100(41), idx(0, 6)]).rng,
      "GEAR_FANCY",
      ctx({ floor: 2 }),
    );
    expect(g.equips[0].itemLevel).toBe(3);
    expect(g.equips[0].rarity).toBe("pedigree");
    expect(g.equips[0].stats).toEqual({ hp: 14, def: 1, spd: 1 });
  });

  it("TITHE loses min(current, 20+5n) as negative shinies", () => {
    const poor = rollBundle(
      scripted([]).rng,
      "TITHE",
      ctx({ floor: 3, currentShinies: 20 }),
    );
    expect(poor.shinies).toBe(-20);
    const rich = rollBundle(
      scripted([]).rng,
      "TITHE",
      ctx({ floor: 3, currentShinies: 100 }),
    );
    expect(rich.shinies).toBe(-35);
  });

  it("MOULT is not a grant bundle", () => {
    expect(() =>
      rollBundle(scripted([]).rng, "MOULT" as never, ctx()),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* inventory (loot.md §8)                                              */
/* ------------------------------------------------------------------ */

describe("inventory (loot.md §8)", () => {
  it("starts with 16 empty slots", () => {
    const inv = emptyInventory();
    expect(inv.slots).toHaveLength(INVENTORY_SLOTS);
    expect(inv.slots.every((s) => s === null)).toBe(true);
  });

  it("merges same-id stacks up to 5, then opens new stacks", () => {
    let inv = emptyInventory();
    inv = addConsumables(inv, "tunaSnack", 4).inv;
    const r = addConsumables(inv, "tunaSnack", 3);
    expect(r.leftover).toBe(0);
    expect(r.inv.slots[0]).toEqual({ defId: "tunaSnack", count: 5 });
    expect(r.inv.slots[1]).toEqual({ defId: "tunaSnack", count: 2 });
  });

  it("reports overflow when the 16 slots are full", () => {
    let inv = emptyInventory();
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      inv = addEquip(inv, makeEquipInstance(i + 1, "tinBell", 1, "stray")).inv;
    }
    const eq = addEquip(inv, makeEquipInstance(99, "tinBell", 1, "stray"));
    expect(eq.added).toBe(false);
    const cons = addConsumables(inv, "tunaSnack", 2);
    expect(cons.leftover).toBe(2);
    const grant = applyGrant(inv, {
      shinies: 5,
      equips: [makeEquipInstance(100, "tinBell", 2, "stray")],
      consumables: [{ defId: "catnip", count: 1 }],
    });
    expect(grant.overflow.equips).toHaveLength(1);
    expect(grant.overflow.consumables).toEqual([{ defId: "catnip", count: 1 }]);
    expect(grant.inv.shinies).toBe(5);
    expect(grant.inv.nextUid).toBe(101); // uid consumed even on overflow
  });

  it("clamps shinies to 0..999 (overflow discarded, tithe floors at 0)", () => {
    let inv = { ...emptyInventory(), shinies: 990 };
    inv = addShinies(inv, 50);
    expect(inv.shinies).toBe(999);
    inv = addShinies(inv, -2000);
    expect(inv.shinies).toBe(0);
  });

  it("removes consumables across stacks and drops empty stacks", () => {
    let inv = emptyInventory();
    inv = addConsumables(inv, "tunaSnack", 5).inv;
    inv = addConsumables(inv, "tunaSnack", 2).inv;
    const r = removeConsumable(inv, "tunaSnack", 6);
    expect(r.removed).toBe(6);
    const stacks = r.inv.slots.filter(isStack);
    expect(stacks).toEqual([{ defId: "tunaSnack", count: 1 }]);
  });

  it("full-inventory Take path replaces a chosen slot and returns the dropped item", () => {
    let inv = emptyInventory();
    const old = makeEquipInstance(1, "tinBell", 1, "stray");
    inv = addEquip(inv, old).inv;
    const incoming = makeEquipInstance(2, "yarnBangle", 3, "pedigree");
    const r = takeReplacing(inv, 0, incoming);
    expect(r.dropped).toEqual(old);
    expect(r.inv.slots[0]).toEqual(incoming);
    expect(r.inv.nextUid).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* equip / unequip / grief loot                                        */
/* ------------------------------------------------------------------ */

describe("equip & unequip (loot.md §2)", () => {
  it("hp bonus raises current HP on equip and removes it on unequip", () => {
    const collar = makeEquipInstance(1, "fluffyCollar", 1, "stray"); // hp +5
    const e = equipItem(cat("bruiser", 20), collar);
    expect(e.cat.hp).toBe(25);
    expect(e.cat.trinket).toEqual(collar);
    const u = unequipItem(e.cat, "trinket");
    expect(u.cat.hp).toBe(20);
    expect(u.removed).toEqual(collar);
  });

  it("unequip never drops current HP below 1", () => {
    const collar = makeEquipInstance(1, "fluffyCollar", 1, "stray"); // hp +5
    const worn = equipItem(cat("medic", 20), collar).cat;
    const hurt = { ...worn, hp: 3 };
    expect(unequipItem(hurt, "trinket").cat.hp).toBe(1);
  });

  it("weapons are class-locked; trinkets are universal", () => {
    const rapier = makeEquipInstance(1, "ribbonRapier", 1, "stray");
    expect(canEquip(cat("bruiser"), rapier)).toBe(false);
    expect(() => equipItem(cat("bruiser"), rapier)).toThrow();
    expect(canEquip(cat("trickster"), rapier)).toBe(true);
    expect(
      canEquip(cat("hexer"), makeEquipInstance(2, "tinBell", 1, "stray")),
    ).toBe(true);
  });

  it("equipping over a worn item returns the replaced piece", () => {
    const oldMitts = makeEquipInstance(1, "mittsOfMenace", 1, "stray");
    const newMitts = makeEquipInstance(2, "mittsOfMenace", 3, "sleek", "hp");
    const worn = equipItem(cat("bruiser", 20), oldMitts).cat;
    const r = equipItem(worn, newMitts);
    expect(r.replaced).toEqual(oldMitts);
    expect(r.cat.weapon).toEqual(newMitts);
    expect(r.cat.hp).toBe(20 + (newMitts.stats.hp ?? 0));
  });

  it("grief loot drops a dead cat's gear into the shared inventory", () => {
    const weapon = makeEquipInstance(1, "chimeBell", 2, "sleek", "hp");
    const trinket = makeEquipInstance(2, "tinBell", 1, "stray");
    const dead: CatRunState = { ...cat("medic", 0, 0), weapon, trinket };
    const r = applyGriefLoot(dead, emptyInventory());
    expect(r.cat.weapon).toBeNull();
    expect(r.cat.trinket).toBeNull();
    expect(r.dropped).toEqual([weapon, trinket]);
    expect(r.inv.slots[0]).toEqual(weapon);
    expect(r.inv.slots[1]).toEqual(trinket);
    expect(r.overflow).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* MOULT downgrade (loot.md §5d)                                       */
/* ------------------------------------------------------------------ */

describe("MOULT downgrade", () => {
  it("downgrades one tier with values recomputed per §3", () => {
    // mewthical → pedigree: hook gone, both secondaries at ×1.5
    const bangle = makeEquipInstance(1, "yarnBangle", 6, "mewthical");
    const ped = downgradeEquip(bangle, scripted([]).rng)!;
    expect(ped.rarity).toBe("pedigree");
    expect(ped.hook).toBeUndefined();
    expect(ped.stats).toEqual({ enMax: 3, hp: 11, crt: 7 });
    // pedigree → sleek: keeps ONE secondary (rng pick over the pool)
    const collar = makeEquipInstance(2, "fluffyCollar", 1, "pedigree");
    const sleek = downgradeEquip(collar, scripted([idx(0, 2)]).rng)!;
    expect(sleek.rarity).toBe("sleek");
    expect(sleek.stats).toEqual({ hp: 6, def: 1 });
    // sleek → stray: drops its secondary
    const stray = downgradeEquip(sleek, scripted([]).rng)!;
    expect(stray.stats).toEqual({ hp: 5 });
    // stray → destroyed
    expect(downgradeEquip(stray, scripted([]).rng)).toBeNull();
  });

  it("moults a seeded-random equipped item into the inventory", () => {
    const mitts = makeEquipInstance(1, "mittsOfMenace", 1, "sleek", "hp"); // atk 3, hp 1
    const bruiser = equipItem(cat("bruiser", 20), mitts).cat;
    const cats = [bruiser, cat("trickster", 20)];
    const r = applyMoult(scripted([idx(0, 1)]).rng, cats, emptyInventory());
    expect(r.kind).toBe("downgrade");
    if (r.kind !== "downgrade") return;
    expect(r.catIndex).toBe(0);
    expect(r.slot).toBe("weapon");
    expect(r.before).toEqual(mitts);
    expect(r.after).toEqual(makeEquipInstance(1, "mittsOfMenace", 1, "stray"));
    expect(r.cats[0].weapon).toBeNull();
    expect(r.cats[0].hp).toBe(20); // wore +1 hp → 21, unequip → 20
    expect(r.inv.slots[0]).toEqual(r.after);
  });

  it("destroys a Stray item outright (nothing enters the inventory)", () => {
    const bell = makeEquipInstance(1, "tinBell", 1, "stray");
    const worn = equipItem(cat("hexer", 20), bell).cat;
    const r = applyMoult(scripted([idx(0, 1)]).rng, [worn], emptyInventory());
    expect(r.kind).toBe("downgrade");
    if (r.kind !== "downgrade") return;
    expect(r.after).toBeNull();
    expect(r.inv.slots.every((s) => s === null)).toBe(true);
  });

  it("with nothing equipped, a seeded-random cat loses 12 HP, min 1 left", () => {
    const cats = [cat("bruiser", 30), cat("trickster", 5)];
    const r = applyMoult(scripted([idx(1, 2)]).rng, cats, emptyInventory(), 12);
    expect(r.kind).toBe("damage");
    if (r.kind !== "damage") return;
    expect(r.catIndex).toBe(1);
    expect(r.cats[1].hp).toBe(1); // 5 − 12 clamps at 1
    expect(r.damage).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* shop (loot.md §6)                                                   */
/* ------------------------------------------------------------------ */

describe("Peddler prices (loot.md §6)", () => {
  it("equipValue = round((15+9L)·pmult): L4 pedigree = 128", () => {
    expect(equipValue(4, "pedigree")).toBe(128);
    expect(equipValue(2, "sleek")).toBe(53); // 33·1.6 = 52.8
    expect(equipValue(1, "stray")).toBe(24);
  });

  it("sell = floor(buy/4) min 1; mewthical L sells for 15+9L", () => {
    const mew: EquipInstance = makeEquipInstance(
      1,
      "yarnBangle",
      5,
      "mewthical",
    );
    expect(sellValue(mew)).toBe(15 + 9 * 5); // the documented payday
    expect(sellValue("tunaSnack")).toBe(5); // floor(20/4)
    expect(sellValue("cardboardBox")).toBe(5);
    expect(sellValue(makeEquipInstance(2, "tinBell", 1, "stray"))).toBe(6);
  });

  it("Warm Lap costs 30+15n and heals round(0.40·maxHp)", () => {
    expect([1, 2, 3, 4, 5].map(warmLapCost)).toEqual([45, 60, 75, 90, 105]);
    expect(warmLapHeal(30)).toBe(12);
    expect(warmLapHeal(29)).toBe(12); // 11.6 rounds half up → 12
  });
});

describe("Peddler stock roll (shop stream)", () => {
  const shopCtx = ctx({ floor: 1 });

  it("matches the recorded fixture for runSeed 'MEOW-1987', landing 1", () => {
    const rng = mulberry32(hash("MEOW-1987", "shop", 1));
    const stock = rollShopStock(rng, shopCtx);
    expect(stock).toEqual({
      slots: [
        { kind: "consumable", defId: "tunaSnack", price: 20, sold: false },
        { kind: "consumable", defId: "warmMilk", price: 30, sold: false },
        { kind: "consumable", defId: "sardineTin", price: 45, sold: false },
        { kind: "consumable", defId: "tunaSnack", price: 20, sold: false },
        {
          kind: "equip",
          item: {
            uid: 1,
            defId: "fluffyCollar",
            itemLevel: 2, // L = n + 1
            rarity: "sleek",
            stats: { hp: 9, def: 1 },
          },
          price: 53,
          sold: false,
        },
        // slot 6: the Peddler's dedicated collar (progression.md §4) —
        // rolled AFTER the gear slot, so slots 1-5 are the same draws (and
        // the same items) as the pre-collar recording.
        {
          kind: "equip",
          item: {
            uid: 2,
            defId: "quiltedGorget",
            itemLevel: 2,
            rarity: "sleek",
            stats: { hp: 9, spd: 1 },
          },
          price: 53,
          sold: false,
        },
      ],
      warmLapCost: 45,
      warmLapUsed: false,
    });
  });

  it("is deterministic and always leads with a Tuna Snack", () => {
    const seed = hash("MEOW-1987", "shop", 3);
    const a = rollShopStock(mulberry32(seed), ctx({ floor: 3 }));
    const b = rollShopStock(mulberry32(seed), ctx({ floor: 3 }));
    expect(a).toEqual(b);
    expect(a.slots[0]).toEqual({
      kind: "consumable",
      defId: "tunaSnack",
      price: 20,
      sold: false,
    });
    expect(["sardineTin", "warmMilk"]).toContain(
      (a.slots[1] as { defId: string }).defId,
    );
    const gear = a.slots[4];
    expect(gear.kind).toBe("equip");
    if (gear.kind === "equip") {
      expect(gear.item.itemLevel).toBe(4);
      expect(["sleek", "pedigree", "mewthical"]).toContain(gear.item.rarity);
      expect(EQUIP_DEFS[gear.item.defId].slot).not.toBe("collar");
    }
    const collar = a.slots[5];
    expect(collar.kind).toBe("equip");
    if (collar.kind === "equip") {
      expect(EQUIP_DEFS[collar.item.defId].slot).toBe("collar");
      expect(collar.item.itemLevel).toBe(4);
      expect(collar.item.uid).toBe(
        gear.kind === "equip" ? gear.item.uid + 1 : 0,
      );
    }
    expect(a.warmLapCost).toBe(75);
  });

  it("buys deduct shinies, mark sold, and land in the inventory", () => {
    const rng = mulberry32(hash("MEOW-1987", "shop", 1));
    const stock = rollShopStock(rng, shopCtx);
    const inv = { ...emptyInventory(), shinies: 100 };
    const buy = buyStockItem(stock, 0, inv);
    expect(buy.ok).toBe(true);
    expect(buy.inv.shinies).toBe(80);
    expect(buy.inv.slots[0]).toEqual({ defId: "tunaSnack", count: 1 });
    expect(buy.stock.slots[0].sold).toBe(true);
    // sold-out slots and empty wallets refuse
    expect(buyStockItem(buy.stock, 0, buy.inv).ok).toBe(false);
    expect(buyStockItem(stock, 2, { ...inv, shinies: 10 }).ok).toBe(false);
  });

  it("Warm Lap can be bought once per landing", () => {
    const stock = rollShopStock(
      mulberry32(hash("s", "shop", 2)),
      ctx({ floor: 2 }),
    );
    const inv = { ...emptyInventory(), shinies: 100 };
    const first = buyWarmLap(stock, inv);
    expect(first.ok).toBe(true);
    expect(first.inv.shinies).toBe(100 - 60);
    expect(first.stock.warmLapUsed).toBe(true);
    expect(buyWarmLap(first.stock, first.inv).ok).toBe(false);
  });

  it("selling from the inventory pays floor(buy/4) min 1", () => {
    let inv = { ...emptyInventory(), shinies: 0 };
    inv = addEquip(inv, makeEquipInstance(1, "tinBell", 1, "stray")).inv; // buy 24
    inv = addConsumables(inv, "tunaSnack", 3).inv;
    const gear = sellFromInventory(inv, 0);
    expect(gear.gained).toBe(6);
    expect(gear.inv.slots[0]).toBeNull();
    expect(gear.inv.shinies).toBe(6);
    const snacks = sellFromInventory(gear.inv, 1, 2);
    expect(snacks.gained).toBe(10);
    expect(snacks.inv.slots[1]).toEqual({ defId: "tunaSnack", count: 1 });
    expect(snacks.inv.shinies).toBe(16);
  });
});
