/**
 * WP-02c acceptance tests: items/events content slice.
 *
 * Covers ONLY the files owned by WP-02c: content/equipment.ts,
 * content/consumables.ts, content/lootTables.ts, content/events.ts.
 * Cross-references to skills/enemies tables belong to tests/content.spec.ts.
 */
import { describe, expect, it } from "vitest";
import type { Effect, EventOption, MewHookId } from "../src/core/types";
import { EQUIP_DEFS, RARITY_TABLE } from "../src/content/equipment";
import { CONSUMABLES } from "../src/content/consumables";
import {
  BOSS_RARITY,
  BUNDLES,
  CHEST_DRAWS,
  CONSUMABLE_WEIGHTS,
  FIGHT_DROPS,
  RARITY_WEIGHTS,
  SHOP_GEAR_RARITY,
  STARTING_KIT,
} from "../src/content/lootTables";
import { EVENTS } from "../src/content/events";

/* ------------------------------------------------------------------------ */
/* Equipment — loot.md §§2-4                                                 */
/* ------------------------------------------------------------------------ */

describe("EQUIP_DEFS", () => {
  const defs = Object.values(EQUIP_DEFS);
  const weapons = defs.filter((d) => d.slot === "weapon");
  const trinkets = defs.filter((d) => d.slot === "trinket");

  it("has exactly 10 defs: 4 weapons + 6 trinkets, keyed by id", () => {
    expect(defs).toHaveLength(10);
    expect(weapons).toHaveLength(4);
    expect(trinkets).toHaveLength(6);
    for (const [key, def] of Object.entries(EQUIP_DEFS)) {
      expect(def.id).toBe(key);
    }
  });

  it("class-locks each weapon to a distinct class; weapon primary is atk", () => {
    expect(new Set(weapons.map((w) => w.classId))).toEqual(
      new Set(["bruiser", "trickster", "hexer", "medic"]),
    );
    for (const w of weapons) expect(w.primary).toBe("atk");
    for (const t of trinkets) expect(t.classId).toBeUndefined();
  });

  it("matches the loot.md §2 archetype table", () => {
    expect(EQUIP_DEFS.mittsOfMenace.secondaryPool).toEqual(["hp", "def"]);
    expect(EQUIP_DEFS.ribbonRapier.secondaryPool).toEqual(["spd", "crt"]);
    expect(EQUIP_DEFS.tangleTalisman.secondaryPool).toEqual(["crt", "enMax"]);
    expect(EQUIP_DEFS.chimeBell.secondaryPool).toEqual(["hp", "enMax"]);

    expect(EQUIP_DEFS.fluffyCollar.primary).toBe("hp");
    expect(EQUIP_DEFS.fluffyCollar.secondaryPool).toEqual(["def", "spd"]);
    expect(EQUIP_DEFS.cardboardCuirass.primary).toBe("def");
    expect(EQUIP_DEFS.cardboardCuirass.secondaryPool).toEqual(["hp", "spd"]);
    expect(EQUIP_DEFS.tinBell.primary).toBe("spd");
    expect(EQUIP_DEFS.tinBell.secondaryPool).toEqual(["crt", "enMax"]);
    expect(EQUIP_DEFS.driedLuckyBeetle.primary).toBe("crt");
    expect(EQUIP_DEFS.driedLuckyBeetle.secondaryPool).toEqual(["spd", "atk"]);
    expect(EQUIP_DEFS.yarnBangle.primary).toBe("enMax");
    expect(EQUIP_DEFS.yarnBangle.secondaryPool).toEqual(["hp", "crt"]);
    expect(EQUIP_DEFS.spikedCollar.primary).toBe("atk");
    expect(EQUIP_DEFS.spikedCollar.secondaryPool).toEqual(["def", "crt"]);
  });

  it("carries the 8 Mewthical uniques (all hooks once) and none on Cuirass/Spiked Collar", () => {
    const hooks = defs.flatMap((d) => (d.uniqueId ? [d.uniqueId] : []));
    const allHooks: MewHookId[] = [
      "poiseChip2",
      "critOffBalance",
      "appliesAlwaysHit",
      "healsGrantMending",
      "moverOffBalance",
      "ninthBell",
      "catPileDouble",
      "startEnergy6",
    ];
    expect(new Set(hooks)).toEqual(new Set(allHooks));
    expect(hooks).toHaveLength(8);
    expect(EQUIP_DEFS.cardboardCuirass.uniqueId).toBeUndefined();
    expect(EQUIP_DEFS.spikedCollar.uniqueId).toBeUndefined();

    // unique names per loot.md §4
    expect(EQUIP_DEFS.mittsOfMenace.uniqueName).toBe("Dumpster Lid Mitts");
    expect(EQUIP_DEFS.ribbonRapier.uniqueName).toBe("The Red Dot");
    expect(EQUIP_DEFS.tangleTalisman.uniqueName).toBe(
      "Grandmother's Cursed Yarn",
    );
    expect(EQUIP_DEFS.chimeBell.uniqueName).toBe("Bell of Purrfect Pitch");
    expect(EQUIP_DEFS.fluffyCollar.uniqueName).toBe("Static-Charged Fluff");
    expect(EQUIP_DEFS.tinBell.uniqueName).toBe("The Ninth Bell");
    expect(EQUIP_DEFS.driedLuckyBeetle.uniqueName).toBe("Alpha Beetle");
    expect(EQUIP_DEFS.yarnBangle.uniqueName).toBe("Ball of Pure Yarn");
  });

  it("rarity table matches loot.md §3 (mult and secondary lines)", () => {
    expect(RARITY_TABLE.stray).toMatchObject({ mult: 1.0, secondaryLines: 0 });
    expect(RARITY_TABLE.sleek).toMatchObject({ mult: 1.25, secondaryLines: 1 });
    expect(RARITY_TABLE.pedigree).toMatchObject({
      mult: 1.5,
      secondaryLines: 2,
    });
    expect(RARITY_TABLE.mewthical).toMatchObject({
      mult: 1.75,
      secondaryLines: 2,
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Consumables — loot.md §7                                                  */
/* ------------------------------------------------------------------------ */

describe("CONSUMABLES", () => {
  const defs = Object.values(CONSUMABLES);

  it("has exactly the 10 loot.md §7 items, keyed by id", () => {
    expect(new Set(Object.keys(CONSUMABLES))).toEqual(
      new Set([
        "tunaSnack",
        "sardineTin",
        "warmMilk",
        "catnip",
        "theCucumber",
        "squeakyToy",
        "bagOfFleas",
        "cardboardBox",
        "canOpenerRecording",
        "featherWand",
      ]),
    );
    for (const [key, def] of Object.entries(CONSUMABLES)) {
      expect(def.id).toBe(key);
      expect(def.battleSkill.id).toBe(key);
    }
  });

  it("prices match the §7 table", () => {
    const prices: Record<string, number> = {
      tunaSnack: 20,
      sardineTin: 45,
      warmMilk: 30,
      catnip: 25,
      theCucumber: 40,
      squeakyToy: 25,
      bagOfFleas: 25,
      cardboardBox: 20,
      canOpenerRecording: 35,
      featherWand: 60,
    };
    for (const def of defs) expect(def.price).toBe(prices[def.id]);
  });

  it("battle skills are cost 0, power 0, usable from any rank, all applies chance exactly 1.0", () => {
    for (const def of defs) {
      const s = def.battleSkill;
      expect(s.cost).toBe(0);
      expect(s.power).toBe(0); // items consume zero battle-stream rolls (§5e)
      expect(s.usableFrom).toEqual([1, 2, 3, 4]);
      for (const a of s.applies ?? []) expect(a.chance).toBe(1.0);
    }
  });

  it("explore field only on tunaSnack (12) and sardineTin ('full')", () => {
    expect(CONSUMABLES.tunaSnack.explore).toEqual({ heal: 12 });
    expect(CONSUMABLES.sardineTin.explore).toEqual({ heal: "full" });
    for (const def of defs) {
      if (def.id !== "tunaSnack" && def.id !== "sardineTin") {
        expect(def.explore).toBeUndefined();
      }
    }
  });

  it("encodes the locked effect numbers and flags", () => {
    // Cucumber: guaranteed Frazzle, any rank, once per battle
    expect(CONSUMABLES.theCucumber.oncePerBattle).toBe(true);
    expect(CONSUMABLES.theCucumber.battleSkill.applies).toEqual([
      { status: "frazzled", chance: 1.0 },
    ]);
    expect(CONSUMABLES.theCucumber.battleSkill.target.ranks).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // Squeaky Toy: push 1, enemy ranks 1-3
    expect(CONSUMABLES.squeakyToy.battleSkill.moveTarget).toBe(1);
    expect(CONSUMABLES.squeakyToy.battleSkill.target.ranks).toEqual([1, 2, 3]);
    // Bag of Fleas: Scratched value 3
    expect(CONSUMABLES.bagOfFleas.battleSkill.applies).toEqual([
      { status: "scratched", chance: 1.0, value: 3 },
    ]);
    // Warm Milk: Mending value 4
    expect(CONSUMABLES.warmMilk.battleSkill.applies).toEqual([
      { status: "mending", chance: 1.0, value: 4 },
    ]);
    // Cardboard Box: Guarded
    expect(CONSUMABLES.cardboardBox.battleSkill.applies).toEqual([
      { status: "guarded", chance: 1.0 },
    ]);
    // Catnip: +2 energy to the targeted ally
    expect(CONSUMABLES.catnip.battleSkill.energyGain).toBe(2);
    expect(CONSUMABLES.catnip.battleSkill.target.side).toBe("ally");
    // Feather Wand: revive at 25%, mirrors Nine Lives Nudge's fraction encoding
    expect(CONSUMABLES.featherWand.battleSkill.revivePct).toBe(0.25);
    // Can-Opener Recording: non-boss only
    expect(CONSUMABLES.canOpenerRecording.nonBoss).toBe(true);
    // no other def carries the latch flags
    for (const def of defs) {
      if (def.id !== "theCucumber") expect(def.oncePerBattle).toBeUndefined();
      if (def.id !== "canOpenerRecording") expect(def.nonBoss).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Loot tables — loot.md §§5-7                                               */
/* ------------------------------------------------------------------------ */

describe("lootTables", () => {
  it("CONSUMABLE_WEIGHTS sums to exactly 100 over the 10 consumables, in table order", () => {
    expect(CONSUMABLE_WEIGHTS.reduce((s, w) => s + w.weight, 0)).toBe(100);
    expect(CONSUMABLE_WEIGHTS.map((w) => w.id)).toEqual([
      "tunaSnack",
      "sardineTin",
      "warmMilk",
      "catnip",
      "theCucumber",
      "squeakyToy",
      "bagOfFleas",
      "cardboardBox",
      "canOpenerRecording",
      "featherWand",
    ]);
    for (const w of CONSUMABLE_WEIGHTS) {
      expect(w.weight).toBeGreaterThan(0);
      expect(CONSUMABLES[w.id]).toBeDefined();
    }
  });

  it("RARITY_WEIGHTS matches the loot.md §5 floor bands and each sums to 100", () => {
    expect(RARITY_WEIGHTS.f12).toEqual({
      stray: 55,
      sleek: 35,
      pedigree: 9,
      mewthical: 1,
    });
    expect(RARITY_WEIGHTS.f34).toEqual({
      stray: 30,
      sleek: 40,
      pedigree: 25,
      mewthical: 5,
    });
    expect(RARITY_WEIGHTS.f56).toEqual({
      stray: 15,
      sleek: 35,
      pedigree: 40,
      mewthical: 10,
    });
    for (const band of Object.values(RARITY_WEIGHTS)) {
      expect(Object.values(band).reduce((s, w) => s + w, 0)).toBe(100);
    }
  });

  it("CHEST_DRAWS is consumable 60 / equipment 30 / shinyPile 10", () => {
    expect(CHEST_DRAWS).toEqual([
      { kind: "consumable", weight: 60 },
      { kind: "equipment", weight: 30 },
      { kind: "shinyPile", weight: 10 },
    ]);
  });

  it("fight/boss/shop draw constants match loot.md §§5a, 5c, 6", () => {
    expect(FIGHT_DROPS).toEqual({
      consumableChance: 0.25,
      equipmentChance: 0.1,
    });
    expect(BOSS_RARITY.pedigree).toBe(70);
    expect(BOSS_RARITY.mewthical).toBe(30);
    expect(SHOP_GEAR_RARITY).toEqual({
      stray: 0,
      sleek: 50,
      pedigree: 40,
      mewthical: 10,
    });
  });

  it("BUNDLES carries the six §5d bundles with their exact numbers", () => {
    expect(Object.keys(BUNDLES).sort()).toEqual([
      "GEAR",
      "GEAR_FANCY",
      "MOULT",
      "SHINY_HOARD",
      "SNACK_STASH",
      "TITHE",
    ]);
    expect(BUNDLES.SNACK_STASH).toEqual({ kind: "consumableRolls", rolls: 2 });
    expect(BUNDLES.SHINY_HOARD).toEqual({
      kind: "shinies",
      base: 30,
      perFloor: 10,
    });
    expect(BUNDLES.GEAR).toEqual({
      kind: "gear",
      level: "floor",
      rarity: "band",
    });
    expect(BUNDLES.GEAR_FANCY).toEqual({
      kind: "gear",
      level: "floorPlus1",
      rarity: { stray: 0, sleek: 0, pedigree: 70, mewthical: 30 },
    });
    expect(BUNDLES.TITHE).toEqual({ kind: "tithe", base: 20, perFloor: 5 });
    expect(BUNDLES.MOULT).toEqual({ kind: "moult", fallbackDamage: 12 });
  });

  it("STARTING_KIT is 20 shinies, 2 Tuna Snacks, 1 Cardboard Box", () => {
    expect(STARTING_KIT).toEqual({
      shinies: 20,
      consumables: [
        { defId: "tunaSnack", count: 2 },
        { defId: "cardboardBox", count: 1 },
      ],
    });
    for (const c of STARTING_KIT.consumables) {
      expect(CONSUMABLES[c.defId]).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Events — events.md §§1, 4 with GDD id fixes                               */
/* ------------------------------------------------------------------------ */

/** Recursively collect effects, including fight onWinEffects. */
function allEffects(effects: Effect[]): Effect[] {
  return effects.flatMap((e) =>
    e.kind === "fight" ? [e, ...allEffects(e.onWinEffects ?? [])] : [e],
  );
}

function optionEffects(option: EventOption): Effect[] {
  return option.outcomes.flatMap((o) => allEffects(o.effects));
}

describe("EVENTS", () => {
  it("ships exactly the 10 authored events in order", () => {
    expect(EVENTS.map((e) => e.id)).toEqual([
      "yarnBall",
      "suspiciousHuman",
      "cursedPost",
      "shrineOfNine",
      "perfectBox",
      "milkBowl",
      "redDot",
      "dormantRoomba",
      "catnipPatch",
      "elderStray",
    ]);
  });

  it("carries the authored weights, floor ranges, and once flags", () => {
    const meta = Object.fromEntries(
      EVENTS.map((e) => [e.id, [e.weight, e.floors, e.once ?? false]]),
    );
    expect(meta).toEqual({
      yarnBall: [10, [1, 6], false],
      suspiciousHuman: [8, [1, 4], false],
      cursedPost: [8, [2, 6], false],
      shrineOfNine: [6, [3, 6], true],
      perfectBox: [10, [1, 6], false],
      milkBowl: [8, [1, 5], false],
      redDot: [7, [2, 6], false],
      dormantRoomba: [7, [3, 6], false],
      catnipPatch: [9, [1, 6], false],
      elderStray: [7, [2, 6], true],
    });
  });

  it("applies the 'rat' -> 'ratThug' id fix; all encounters use roster ids", () => {
    const encounterIds = new Set(
      EVENTS.flatMap((e) => e.options)
        .flatMap(optionEffects)
        .flatMap((fx) => (fx.kind === "fight" ? fx.encounter : [])),
    );
    expect(encounterIds.has("rat")).toBe(false);
    expect(encounterIds).toEqual(
      new Set(["ratThug", "roombaScout", "elderStray"]),
    );
    const ambush = EVENTS.find((e) => e.id === "perfectBox")!.options[0]
      .outcomes[1].effects[1];
    expect(ambush).toMatchObject({
      kind: "fight",
      encounter: ["ratThug", "ratThug", "ratThug"],
      loot: "normal",
    });
  });

  it("item references resolve against CONSUMABLES", () => {
    for (const event of EVENTS) {
      for (const option of event.options) {
        if (option.requires?.kind === "item") {
          expect(CONSUMABLES[option.requires.item]).toBeDefined();
        }
        for (const fx of optionEffects(option)) {
          if (fx.kind === "giveItem" || fx.kind === "takeItem") {
            expect(CONSUMABLES[fx.item]).toBeDefined();
          }
        }
      }
    }
  });

  it("obeys the authoring invariants (events.md §1)", () => {
    for (const event of EVENTS) {
      // 2-4 options, 1-4 outcomes, weights > 0, floors within 1..6
      expect(event.options.length).toBeGreaterThanOrEqual(2);
      expect(event.options.length).toBeLessThanOrEqual(4);
      expect(event.weight).toBeGreaterThan(0);
      expect(event.floors[0]).toBeGreaterThanOrEqual(1);
      expect(event.floors[1]).toBeLessThanOrEqual(6);
      expect(event.floors[0]).toBeLessThanOrEqual(event.floors[1]);

      // walk-away rule: >= 1 requirement-free option with no damage/fight
      const walkAway = event.options.some(
        (o) =>
          !o.requires &&
          optionEffects(o).every(
            (fx) => fx.kind !== "damage" && fx.kind !== "fight",
          ),
      );
      expect(walkAway).toBe(true);

      for (const option of event.options) {
        expect(option.outcomes.length).toBeGreaterThanOrEqual(1);
        expect(option.outcomes.length).toBeLessThanOrEqual(4);
        expect(option.label.length).toBeLessThanOrEqual(60);
        for (const outcome of option.outcomes) {
          expect(outcome.weight).toBeGreaterThan(0);
          // fight is the LAST effect and at most one per outcome
          const fightIdx = outcome.effects.findIndex(
            (fx) => fx.kind === "fight",
          );
          if (fightIdx !== -1) {
            expect(fightIdx).toBe(outcome.effects.length - 1);
            expect(
              outcome.effects.filter((fx) => fx.kind === "fight"),
            ).toHaveLength(1);
          }
          // gateCat only behind class/stat requirements
          for (const fx of allEffects(outcome.effects)) {
            if ("target" in fx && fx.target === "gateCat") {
              expect(["class", "stat"]).toContain(option.requires?.kind);
            }
          }
        }
      }
    }
  });

  it("floor-1 candidate pool has the documented 5 events", () => {
    const f1 = EVENTS.filter((e) => e.floors[0] <= 1 && e.floors[1] >= 1).map(
      (e) => e.id,
    );
    expect(new Set(f1)).toEqual(
      new Set([
        "yarnBall",
        "suspiciousHuman",
        "perfectBox",
        "milkBowl",
        "catnipPatch",
      ]),
    );
  });
});
