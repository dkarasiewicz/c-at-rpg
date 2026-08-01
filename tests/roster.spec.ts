/**
 * THE ROSTER — acceptance tests for docs/design/roster-and-persistence.md
 * §0-§3: cat instances, the player's pick, perma-death + the memorial, the
 * no-dead-end guard rail, and migration in both directions.
 *
 * The load-bearing claim these tests defend is that the contract change is
 * BEHAVIOURALLY INERT for a default descent: the four Strays still play
 * exactly as they did, because a seeded Stray's instance id is its class.
 */
import { describe, expect, it } from "vitest";
import {
  addCat,
  applyUnlocks,
  bankCat,
  bankRun,
  buryCat,
  descendingCats,
  emptyProfile,
  ensureRoster,
  GATE_STRAY_ORIGIN,
  livingRoster,
  migrateMeta,
  purchase,
  rosterCat,
  runCat,
  runCats,
  setDescending,
  settleRun,
  startRun,
  syncRoster,
  type MetaCat,
  type MetaProfile,
} from "../src/core/meta/index.js";
import {
  benchedCats,
  catById,
  fieldedCats,
  makeCat,
  newRun,
  partyCapacity,
  recruitCat,
} from "../src/core/run/runState.js";
import { applyBattleResult } from "../src/core/run/runState.js";
import {
  loadRun,
  memoryStorage,
  migrateSave,
  SAVE_KEY,
  SAVE_VERSION,
  saveRun,
  serializeRun,
} from "../src/core/run/save.js";
import { createBattle } from "../src/core/combat/setup.js";
import { generateCurrentFloorMap } from "../src/core/run/runState.js";
import { CLASSES } from "../src/content/classes.js";
import { EQUIP_DEFS } from "../src/content/equipment.js";
import { CAT_POWERS } from "../src/content/powers.js";
import {
  conditionLine,
  gearLine,
  livesLine,
  memorialLine,
  rosterNote,
  toggleDescending,
} from "../src/ui/overlays/rosterPanel.js";
import type { BattleResult, CatRunState, RunState } from "../src/core/types.js";

const SEED = "MEOW-1987";

const rich = (): MetaProfile => ({ ...emptyProfile(), shinies: 10_000 });

const buyAll = (): MetaProfile => {
  let meta = rich();
  meta = purchase(meta, "class:hexer").meta;
  meta = purchase(meta, "class:medic").meta;
  return meta;
};

/* ------------------------------------------------------------------ */
/* §1 — cats are instances, class is an attribute                      */
/* ------------------------------------------------------------------ */

describe("§1 cat instances", () => {
  it("a run cat carries who it is AND what it is", () => {
    const run = newRun(SEED);
    const bruno = catById(run, "bruiser")!;
    expect(bruno.id).toBe("bruiser");
    expect(bruno.name).toBe("Bruno");
    expect(bruno.classId).toBe("bruiser");
    expect(bruno.standName).toBe(CAT_POWERS.bruiser!.name);
  });

  it("marchingOrder is instance ids, and selectors key on them", () => {
    const run = newRun(SEED, undefined, {
      roster: ["bruiser", "trickster", "hexer"],
      partyCapacity: 4,
    });
    expect(run.marchingOrder).toEqual(["bruiser", "trickster", "hexer"]);
    expect(fieldedCats(run).map((c) => c.id)).toEqual(run.marchingOrder);
    expect(benchedCats(run).map((c) => c.id)).toEqual(["medic"]);
  });

  it("TWO CATS OF THE SAME CLASS coexist — the identity is the id", () => {
    let meta = rich();
    const first = addCat(meta, "bruiser", { name: "Bruno" });
    meta = first.meta;
    const second = addCat(meta, "bruiser", { name: "Other Bruno" });
    meta = second.meta;
    expect(second.cat.id).not.toBe(first.cat.id);
    expect(second.cat.classId).toBe("bruiser");

    const both = [first.cat, second.cat];
    const { cats, level } = runCats(both);
    expect(cats.map((c) => c.id)).toEqual([first.cat.id, second.cat.id]);
    // …and the battle seam mints two DISTINCT combatants for them
    const bs = createBattle({
      cats: cats.map((c) => ({
        catId: c.id,
        classId: c.classId,
        name: c.name,
        stats: { hp: 20, atk: 5, def: 1, spd: 5, crt: 5, enMax: 10 },
        hp: 20,
        lives: c.lives,
        skills: ["clawSwipe"],
        traits: [],
        hooks: [],
        startEnergyBonus: 0,
      })),
      enemies: ["ratThug"],
      encounterIndex: 1,
      canFlee: true,
    });
    const ids = bs.combatants.filter((c) => c.side === "cat").map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(level).toBe(1);
  });

  it("a setup with no catId keys on the class — the §13 fixture, unchanged", () => {
    const bs = createBattle({
      cats: [
        {
          classId: "bruiser",
          name: "Bruno",
          stats: { hp: 40, atk: 10, def: 3, spd: 4, crt: 5, enMax: 10 },
          hp: 40,
          lives: 9,
          skills: ["clawSwipe"],
          traits: [],
          hooks: [],
          startEnergyBonus: 0,
        },
      ],
      enemies: ["ratThug"],
      encounterIndex: 1,
      canFlee: true,
    });
    expect(bs.combatants[0].id).toBe("cat:bruiser");
    expect(bs.combatants[0].catId).toBeUndefined();
  });

  it("a default four-Stray run is byte-identical apart from identity", () => {
    const a = newRun(SEED);
    const b = newRun(SEED);
    expect(serializeRun(generateCurrentFloorMap(a))).toEqual(
      serializeRun(generateCurrentFloorMap(b)),
    );
    // the numbers the engine plays with are untouched by the rename
    expect(a.cats.map((c) => c.hp)).toEqual([40, 28, 24, 26]);
    expect(a.marchingOrder).toHaveLength(2);
    expect(a.marchingOrder[0]).toBe("bruiser");
  });
});

/* ------------------------------------------------------------------ */
/* §0/§2 — the town roster: unlocks deliver cats, the player picks     */
/* ------------------------------------------------------------------ */

describe("§0 the reported bug: a class unlock delivers a fieldable cat", () => {
  it("a fresh town houses one or two, not four", () => {
    const meta = emptyProfile();
    expect(livingRoster(meta)).toHaveLength(2);
    expect(livingRoster(meta).map((c) => c.classId)).toEqual([
      "bruiser",
      "trickster",
    ]);
  });

  it("buying the class puts the cat in town AND in the party", () => {
    const meta = purchase(rich(), "class:medic").meta;
    const baguette = livingRoster(meta).find((c) => c.classId === "medic");
    expect(baguette).toBeDefined();
    const picked = setDescending(meta, ["bruiser", baguette!.id]);
    const run = startRun(SEED, applyUnlocks(picked), { meta: picked });
    expect(run.marchingOrder).toEqual(["bruiser", baguette!.id]);
    expect(fieldedCats(run).map((c) => c.name)).toEqual(["Bruno", "Baguette"]);
  });

  it("a class whose cat DIED is not restocked by the unlock", () => {
    let meta = purchase(rich(), "class:hexer").meta;
    meta = buryCat(meta, rosterCat(meta, "hexer")!, {
      floor: 2,
      cause: "a rat with a plan",
      seed: SEED,
    });
    meta = syncRoster(meta, applyUnlocks(meta));
    expect(livingRoster(meta).some((c) => c.classId === "hexer")).toBe(false);
    expect(meta.memorial).toHaveLength(1);
  });

  it("recruitCat now has a caller shape for mid-run joins", () => {
    const run = newRun(SEED, undefined, {
      cats: [makeCat("bruiser")],
      partyCapacity: 3,
    });
    expect(run.cats).toHaveLength(1);
    const stray = makeCat("medic", { id: "cat-9", name: "Crumb" });
    const out = recruitCat(run, stray);
    expect(out.recruited).toBe("cat-9");
    expect(out.run.marchingOrder).toEqual(["bruiser", "cat-9"]);
    expect(catById(out.run, "cat-9")!.name).toBe("Crumb");
  });
});

describe("§3 the pick", () => {
  it("order is the marching order and capacity is the ceiling", () => {
    const meta = setDescending(buyAll(), [
      "medic",
      "hexer",
      "trickster",
      "bruiser",
    ]);
    const overlay = applyUnlocks(meta);
    const run = startRun(SEED, overlay, { meta });
    expect(run.marchingOrder).toEqual(["medic", "hexer", "trickster"]);
    expect(partyCapacity(run)).toBe(overlay.partyCapacity);
    expect(benchedCats(run)).toEqual([]);
  });

  it("the fourth bowl raises the ceiling to four", () => {
    let meta = buyAll();
    meta = purchase(meta, "slot:fourth").meta;
    meta = setDescending(meta, ["bruiser", "trickster", "hexer", "medic"]);
    const run = startRun(SEED, applyUnlocks(meta), { meta });
    expect(run.marchingOrder).toHaveLength(4);
  });

  it("the party descends at the MOST experienced cat's level", () => {
    let meta = buyAll();
    const veteran: MetaCat = {
      ...rosterCat(meta, "hexer")!,
      xp: 210,
      level: 5,
    };
    meta = {
      ...meta,
      roster: meta.roster!.map((c) => (c.id === "hexer" ? veteran : c)),
    };
    meta = setDescending(meta, ["hexer", "bruiser"]);
    const run = startRun(SEED, applyUnlocks(meta), { meta });
    expect(run.xp).toBe(210);
    expect(run.level).toBe(5);
    // the rookie is carried, at full HP for that level
    const bruno = catById(run, "bruiser")!;
    expect(bruno.hp).toBeGreaterThan(40);
  });

  it("setDescending drops unknown and dead ids", () => {
    const meta = setDescending(emptyProfile(), [
      "bruiser",
      "bruiser",
      "nobody",
    ]);
    expect(meta.descending).toEqual(["bruiser"]);
  });

  it("no pick at all still descends", () => {
    const meta = emptyProfile();
    expect(descendingCats(meta, 3).map((c) => c.id)).toEqual([
      "bruiser",
      "trickster",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* §2 — perma-death, the memorial, and the guard rail                  */
/* ------------------------------------------------------------------ */

describe("§2 perma-death", () => {
  it("a cat out of Lives leaves the roster forever and gets a memorial", () => {
    const meta = buyAll();
    const mora = rosterCat(meta, "hexer")!;
    const after = buryCat(meta, mora, {
      floor: 4,
      cause: "the Vacuum King",
      seed: SEED,
    });
    expect(rosterCat(after, "hexer")).toBeUndefined();
    expect(after.memorial).toHaveLength(1);
    expect(after.memorial![0]).toMatchObject({
      catId: "hexer",
      name: "Mora",
      floor: 4,
      cause: "the Vacuum King",
      standName: CAT_POWERS.hexer!.name,
    });
    // the gear comes HOME (kinder to a small roster — see buryCat)
    expect(after.stash!.map((e) => e.uid)).toEqual([mora.weapon!.uid]);
  });

  it("a run settles: survivors bank, the fallen are buried", () => {
    let meta = setDescending(buyAll(), ["bruiser", "hexer"]);
    const run = startRun(SEED, applyUnlocks(meta), { meta });
    const ran = run.cats.map((c) =>
      c.id === "hexer" ? { ...c, lives: 0, weapon: null } : { ...c, lives: 4 },
    );
    meta = settleRun(meta, {
      cats: ran,
      seed: SEED,
      floorsReached: 3,
      cause: "a dog the size of a car",
      xp: 130,
    });
    expect(rosterCat(meta, "hexer")).toBeUndefined();
    expect(meta.memorial![0].name).toBe("Mora");
    const bruno = rosterCat(meta, "bruiser")!;
    expect(bruno.lives).toBe(4);
    expect(bruno.xp).toBe(130);
    expect(bruno.level).toBe(4);
    expect(bruno.runs).toBe(1);
  });

  it("bankRun does the same write through the results screen's door", () => {
    const meta = setDescending(buyAll(), ["bruiser", "hexer"]);
    const run = startRun(SEED, applyUnlocks(meta), { meta });
    const { meta: after } = bankRun(meta, {
      seed: SEED,
      victory: false,
      floorsReached: 2,
      floorsCleared: 1,
      enemiesDefeated: 3,
      bossesDefeated: 0,
      catPiles: 0,
      shiniesCarried: 0,
      score: 500,
      playTimeMs: 1000,
      cats: run.cats.map((c) => ({ ...c, lives: c.id === "hexer" ? 0 : 9 })),
      cause: "the stairs went the wrong way",
      xp: 70,
    });
    expect(after.memorial!.map((m) => m.name)).toEqual(["Mora"]);
    expect(rosterCat(after, "bruiser")!.xp).toBe(70);
    expect(after.counters.runs).toBe(1);
  });

  it("a summary with no cats leaves the roster alone (pre-roster callers)", () => {
    const meta = emptyProfile();
    const { meta: after } = bankRun(meta, {
      seed: SEED,
      victory: true,
      floorsReached: 6,
      floorsCleared: 6,
      enemiesDefeated: 40,
      bossesDefeated: 3,
      catPiles: 2,
      shiniesCarried: 100,
      score: 9000,
      playTimeMs: 10,
    });
    expect(after.roster!.map((c) => c.id)).toEqual(["bruiser", "trickster"]);
    expect(after.memorial).toEqual([]);
  });

  it("a cat the run picked up is ADOPTED on the way home", () => {
    const meta = emptyProfile();
    const stray: CatRunState = makeCat("medic", {
      id: "cat-42",
      name: "Crumb",
    });
    const after = settleRun(meta, {
      cats: [stray],
      seed: SEED,
      floorsReached: 2,
      xp: 30,
    });
    const crumb = rosterCat(after, "cat-42");
    expect(crumb).toBeDefined();
    expect(crumb!.name).toBe("Crumb");
    expect(crumb!.xp).toBe(30);
  });
});

describe("§2 GUARD RAIL — the roster can never be empty", () => {
  it("killing EVERY cat still leaves a way back down", () => {
    let meta = buyAll();
    meta = purchase(meta, "slot:fourth").meta;
    expect(livingRoster(meta)).toHaveLength(4);

    // wipe: every cat in town runs out of Lives, one run at a time
    for (let i = 0; i < 6 && livingRoster(meta).length > 0; i++) {
      const doomed = livingRoster(meta);
      meta = settleRun(
        meta,
        {
          cats: doomed.map((c) => ({ ...runCat(c, c.level), lives: 0 })),
          seed: `WIPE-${i}`,
          floorsReached: 1,
          cause: "everything, all at once",
        },
        applyUnlocks(meta),
      );
      // …and the town is STILL playable after every single wipe
      expect(livingRoster(meta).length).toBeGreaterThan(0);
      const run = startRun("AFTER", applyUnlocks(meta), { meta });
      expect(run.cats.length).toBeGreaterThan(0);
      expect(run.marchingOrder.length).toBeGreaterThan(0);
    }
    // the fallen are all remembered, and the survivor is a free gate stray
    expect(meta.memorial!.length).toBeGreaterThanOrEqual(4);
    expect(livingRoster(meta)[0].origin).toBe(GATE_STRAY_ORIGIN);
  });

  it("ensureRoster is idempotent and only fires on an empty town", () => {
    const meta = emptyProfile();
    expect(ensureRoster(meta)).toBe(meta);
    const empty: MetaProfile = { ...meta, roster: [] };
    const fixed = ensureRoster(empty);
    expect(livingRoster(fixed)).toHaveLength(1);
    expect(ensureRoster(fixed)).toBe(fixed);
  });

  it("a hand-emptied profile loads back with a cat in it", () => {
    const wiped = JSON.stringify({ ...emptyProfile(), roster: [] });
    const loaded = migrateMeta(JSON.parse(wiped))!;
    expect(livingRoster(loaded).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* §5 — migration, both directions                                     */
/* ------------------------------------------------------------------ */

describe("§5 migration", () => {
  it("a v3 SAVE (class slots) becomes instances without moving a number", () => {
    const modern = generateCurrentFloorMap(newRun(SEED));
    const sf = serializeRun(modern);
    // strip the instance fields back out — that IS a v3 payload
    const legacy = JSON.parse(JSON.stringify(sf)) as typeof sf;
    legacy.version = 3;
    legacy.run.cats = legacy.run.cats.map((c) => {
      const { ...rest } = c as CatRunState & Record<string, unknown>;
      delete (rest as Record<string, unknown>).id;
      delete (rest as Record<string, unknown>).name;
      delete (rest as Record<string, unknown>).standName;
      return rest as CatRunState;
    });

    const migrated = migrateSave(legacy)!;
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.run.cats.map((c) => c.id)).toEqual([
      "bruiser",
      "trickster",
      "hexer",
      "medic",
    ]);
    expect(migrated.run.cats.map((c) => c.name)).toEqual([
      "Bruno",
      "Pixel",
      "Mora",
      "Baguette",
    ]);
    // everything else is untouched — HP, gear, marching order, traversal
    expect(migrated.run.cats.map((c) => c.hp)).toEqual(
      modern.cats.map((c) => c.hp),
    );
    expect(migrated.run.marchingOrder).toEqual(modern.marchingOrder);
    expect(migrated.run.currentNodeId).toBe(modern.currentNodeId);
  });

  it("round-trips a live run through storage", () => {
    const storage = memoryStorage();
    let meta = setDescending(buyAll(), ["medic", "bruiser"]);
    meta = { ...meta, descending: ["medic", "bruiser"] };
    const run = generateCurrentFloorMap(
      startRun(SEED, applyUnlocks(meta), { meta }),
    );
    saveRun(run, { storage });
    const back = loadRun({ storage })!;
    expect(back.marchingOrder).toEqual(["medic", "bruiser"]);
    expect(back.cats.map((c) => c.name)).toEqual(["Baguette", "Bruno"]);
    expect(JSON.parse(storage.get(SAVE_KEY)!).version).toBe(SAVE_VERSION);
  });

  it("a v3 META (classes, no cats) grows the clowder it always implied", () => {
    const v3 = {
      version: 3,
      counters: { runs: 7, victories: 1 },
      records: { bestScore: 4200, fastestVictoryMs: 900_000 },
      shinies: 120,
      lifetimeShinies: 900,
      unlocked: ["class:hexer", "slot:fourth"],
      history: [],
      bestiary: {},
    };
    const meta = migrateMeta(v3)!;
    expect(meta.version).toBe(4);
    // nothing the player earned is lost
    expect(meta.shinies).toBe(120);
    expect(meta.records.bestScore).toBe(4200);
    expect(meta.unlocked).toContain("class:hexer");
    // and the town it describes now actually contains those cats
    expect(livingRoster(meta).map((c) => c.classId)).toEqual([
      "bruiser",
      "trickster",
      "hexer",
    ]);
    expect(meta.memorial).toEqual([]);
  });

  it("a v4 META round-trips its roster, memorial and stash", () => {
    let meta = buyAll();
    meta = buryCat(meta, rosterCat(meta, "medic")!, {
      floor: 5,
      cause: "the Dogfather",
      seed: SEED,
    });
    meta = setDescending(meta, ["hexer", "bruiser"]);
    const back = migrateMeta(JSON.parse(JSON.stringify(meta)))!;
    expect(back.roster!.map((c) => c.id)).toEqual(
      meta.roster!.map((c) => c.id),
    );
    expect(back.memorial).toEqual(meta.memorial);
    expect(back.stash).toEqual(meta.stash);
    expect(back.descending).toEqual(["hexer", "bruiser"]);
  });

  it("drops stash and worn entries that are not equipment this build ships", () => {
    // A `ConsumableStack` is `{defId, count}` — the same duck as an
    // EquipInstance minus its uid — and an ItemId from another build is a
    // plain string too. Both used to survive the load and then crash the
    // first screen that asked `EQUIP_DEFS[defId].slot`: opening The Den on a
    // town holding one was an uncaught TypeError, i.e. an unusable town.
    const meta = migrateMeta({
      ...emptyProfile(),
      stash: [
        { defId: "tunaSnack", count: 2 }, // a consumable, not gear
        { defId: "dreamedByAnotherBuild", uid: 7, itemLevel: 1 },
        { uid: 8, itemLevel: 1 }, // no defId at all
        { defId: "mittsOfMenace", uid: 9, itemLevel: 1, stats: { atk: 2 } },
      ],
      roster: [
        {
          id: "bruiser",
          classId: "bruiser",
          name: "Bruno",
          lives: 9,
          weapon: { defId: "tunaSnack", count: 1 },
          trinket: { defId: "cardboardCuirass", uid: 4, itemLevel: 1 },
        },
      ],
    })!;
    expect(meta.stash!.map((e) => e.defId)).toEqual(["mittsOfMenace"]);
    const bruno = rosterCat(meta, "bruiser")!;
    expect(bruno.weapon).toBeNull();
    expect(bruno.trinket?.defId).toBe("cardboardCuirass");
    // and every survivor answers the question the Den asks of it
    for (const e of [...meta.stash!, bruno.trinket!]) {
      expect(EQUIP_DEFS[e.defId]).toBeDefined();
    }
  });

  it("repairs a corrupt roster instead of trusting it", () => {
    const meta = migrateMeta({
      ...emptyProfile(),
      roster: [
        { id: "x", classId: "wizard", name: "Nope" },
        { id: "dup", classId: "bruiser", name: "A", lives: 4 },
        { id: "dup", classId: "bruiser", name: "B", lives: 4 },
        { id: "dead", classId: "medic", lives: 0 },
        { id: "ok", classId: "medic", name: "Fine", lives: 99, xp: 1e9 },
      ],
    })!;
    const ids = meta.roster!.map((c) => c.id);
    expect(ids).toContain("dup");
    expect(ids).not.toContain("x"); // unknown class
    expect(ids).not.toContain("dead"); // 0 lives is not a roster entry
    expect(ids.filter((i) => i === "dup")).toHaveLength(1);
    const ok = rosterCat(meta, "ok")!;
    expect(ok.lives).toBe(9);
    expect(ok.xp).toBe(570);
  });
});

/* ------------------------------------------------------------------ */
/* the write-back seam applyBattleResult → settleRun                   */
/* ------------------------------------------------------------------ */

describe("applyBattleResult reports the cats, not the classes", () => {
  it("died carries the instances a memorial needs", () => {
    const meta = setDescending(buyAll(), ["bruiser", "hexer"]);
    const run: RunState = startRun(SEED, applyUnlocks(meta), { meta });
    const result: BattleResult = {
      outcome: "victory",
      cats: run.cats.map((c) => ({
        catId: c.id,
        classId: c.classId,
        hp: c.id === "hexer" ? 0 : c.hp,
        lives: c.id === "hexer" ? 0 : c.lives,
      })),
      xpGained: 0,
      catPiles: 0,
      enemiesDefeated: 1,
      bossDefeated: false,
      ninthBellSpent: false,
      events: [],
    };
    const out = applyBattleResult(run, result);
    expect(out.died.map((c) => c.id)).toEqual(["hexer"]);
    expect(out.died[0].standName).toBe(CAT_POWERS.hexer!.name);
    expect(out.run.marchingOrder).toEqual(["bruiser"]);
    // the dead cat's gear went into the backpack, which carries it home
    expect(out.griefLoot.length).toBeGreaterThan(0);
  });

  it("bankCat never lowers a cat's experience", () => {
    const meta = buyAll();
    const cat = { ...rosterCat(meta, "hexer")!, xp: 310, level: 6 };
    const banked = bankCat(cat, runCat(cat, 6), 70);
    expect(banked.xp).toBe(310);
    expect(banked.level).toBe(6);
  });
});

/* ------------------------------------------------------------------ */
/* §3 — the roster screen's pure half                                  */
/* ------------------------------------------------------------------ */

describe("§3 roster screen", () => {
  it("tapping an unsent cat sends it; tapping a sent one moves it forward", () => {
    expect(toggleDescending([], "a", 3)).toEqual(["a"]);
    expect(toggleDescending(["a"], "b", 3)).toEqual(["a", "b"]);
    expect(toggleDescending(["a", "b"], "b", 3)).toEqual(["b", "a"]);
    // the front cat has nowhere forward to go: tapping it benches it
    expect(toggleDescending(["a", "b"], "a", 3)).toEqual(["b"]);
    // shift-tap always benches
    expect(toggleDescending(["a", "b"], "b", 3, { remove: true })).toEqual([
      "a",
    ]);
  });

  it("a full party refuses one more", () => {
    expect(toggleDescending(["a", "b"], "c", 2)).toEqual(["a", "b"]);
  });

  it("the cards say what a choice costs", () => {
    const meta = emptyProfile();
    const bruno = rosterCat(meta, "bruiser")!;
    expect(gearLine(bruno)).toMatch(/ · — · —$/);
    expect(livesLine(bruno.lives)).toBe("9 lives");
    expect(livesLine(1)).toBe("1 life");
    expect(conditionLine(bruno)).toBe("rested");
    expect(
      conditionLine({
        ...bruno,
        conditions: [{ id: "hunger", label: "hungry" }],
      }),
    ).toBe("hungry");
    expect(rosterNote(0, 3)).toMatch(/Nobody is going down/);
    expect(rosterNote(2, 3)).toMatch(/2 of 3/);
    expect(rosterNote(3, 3)).toMatch(/full at 3/);
  });

  it("a memorial line names who, how far and what did it", () => {
    const meta = buryCat(
      emptyProfile(),
      rosterCat(emptyProfile(), "bruiser")!,
      {
        floor: 6,
        cause: "the Dogfather",
        seed: SEED,
      },
    );
    expect(memorialLine(meta.memorial![0])).toBe(
      "Bruno · Lv 1 · floor 6 · the Dogfather",
    );
  });

  it("every class in town is drawable (the card reads the class table)", () => {
    for (const cat of livingRoster(buyAll())) {
      expect(CLASSES[cat.classId]).toBeDefined();
      expect(cat.standName.length).toBeGreaterThan(0);
    }
  });
});
