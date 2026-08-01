/**
 * THE CAMP — the beat between fights (docs/design/roster-and-persistence.md §4).
 *
 * Two halves, both pinned here:
 *
 *  THE FIRE     the writing. §4 says camp is where the party becomes
 *               characters, and the hard offline-first rule says it has to be
 *               that with no DM at all — so these tests walk every situation a
 *               camp can be in and assert an exchange comes back, in the
 *               cats' own names, every time.
 *  THE EMBERS   the mechanics. Three embers, five actions, everything
 *               expressed in the existing vocabulary (HP, `TempMod`,
 *               `energyNextBattle`, `CatCondition`) and nothing outside it.
 */
import { describe, expect, it } from "vitest";
import type { CatRunState, RunState } from "../src/core/types.js";
import {
  CAMP_ACTIONS,
  CAMP_BANDAGE_PCT,
  CAMP_EMBERS,
  ENERGY_NEXT_CAP,
  campAction,
  campExchange,
  campFood,
  campOpener,
  campPair,
  campTags,
  canTakeCamp,
  newCampSession,
  takeCampAction,
  untendedScar,
  type CampActionId,
} from "../src/core/run/camp.js";
import {
  hungerOf,
  isTended,
  quirksOf,
  withConditions,
  withHunger,
} from "../src/core/run/conditions.js";
import {
  CAMP_ACTION_LINES,
  CAMP_EXCHANGES,
  CAMP_OPENERS,
} from "../src/content/camp.js";
import { QUIRKS } from "../src/content/conditions.js";
import { maxHp } from "../src/core/run/party.js";
import { generateCurrentFloorMap, newRun } from "../src/core/run/runState.js";
import { generateFloorMap } from "../src/core/map/generate.js";
import { FLOORS } from "../src/content/floors.js";
import { addConsumables } from "../src/core/loot/inventory.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A three-cat run standing on floor `f`, everybody a bit chewed up. */
function campRun(f = 4): RunState {
  let run = newRun("CAMP-1");
  run = {
    ...run,
    floorNum: f,
    level: 4,
    marchingOrder: ["bruiser", "trickster", "hexer"],
  };
  run = generateCurrentFloorMap(run);
  return {
    ...run,
    cats: run.cats.map((c) => ({ ...c, hp: Math.floor(maxHp(c, 4) / 2) })),
  };
}

const catOf = (run: RunState, id: string): CatRunState =>
  run.cats.find((c) => c.id === id)!;

const patchCat = (
  run: RunState,
  id: string,
  fn: (c: CatRunState) => CatRunState,
): RunState => ({
  ...run,
  cats: run.cats.map((c) => (c.id === id ? fn(c) : c)),
});

/* ------------------------------------------------------------------ */
/* the writing                                                         */
/* ------------------------------------------------------------------ */

describe("the fire always has something to say (offline-first)", () => {
  it("authors unique, non-empty exchanges", () => {
    const ids = new Set<string>();
    for (const ex of CAMP_EXCHANGES) {
      expect(ids.has(ex.id), `duplicate exchange id ${ex.id}`).toBe(false);
      ids.add(ex.id);
      expect(ex.lines.length).toBeGreaterThanOrEqual(2);
      for (const l of ex.lines) {
        expect(l.text.trim().length).toBeGreaterThan(0);
        expect(["a", "b"]).toContain(l.who);
      }
    }
    expect(CAMP_OPENERS.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a deep always-there pool, so no situation can go silent", () => {
    const generic = CAMP_EXCHANGES.filter((e) => e.tags.length === 0);
    expect(generic.length).toBeGreaterThanOrEqual(8);
  });

  it("covers every tag it can produce", () => {
    const tagged = new Set(CAMP_EXCHANGES.flatMap((e) => e.tags));
    for (const tag of [
      "hungry",
      "scarred",
      "hurt",
      "lastLife",
      "fallen",
      "boss",
      "deep",
      "early",
      "flush",
      "broke",
      "bonded",
    ]) {
      expect(tagged.has(tag as never), `no exchange tagged ${tag}`).toBe(true);
    }
  });

  it("names the two cats — no unresolved placeholders, ever", () => {
    const run = campRun();
    for (let seed = 0; seed < 200; seed++) {
      const ex = campExchange(run, seed, { isBossFloor: seed % 2 === 0 });
      expect(ex).not.toBeNull();
      expect(ex!.lines.length).toBeGreaterThan(0);
      for (const line of ex!.lines) {
        expect(line).not.toContain("{a}");
        expect(line).not.toContain("{b}");
      }
    }
  });

  it("answers for every floor and every state the party can be in", () => {
    for (let floor = 1; floor <= FLOORS.length; floor++) {
      let run = campRun(floor);
      // hungry, scarred, wounded, on the last life, broke, one cat down
      run = patchCat(run, "bruiser", (c) =>
        withConditions(c, [
          ...withHunger([], 4),
          { id: "scar:notchedEar", label: "Notched Ear" },
        ]),
      );
      run = patchCat(run, "trickster", (c) => ({ ...c, lives: 1, hp: 1 }));
      run = patchCat(run, "hexer", (c) => ({ ...c, lives: 0 }));
      run = { ...run, inventory: { ...run.inventory, shinies: 0 } };
      for (let seed = 0; seed < 40; seed++) {
        const ex = campExchange(run, seed, { isBossFloor: true });
        expect(ex, `floor ${floor} seed ${seed}`).not.toBeNull();
        expect(ex!.lines.length).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic — the same fire says the same thing", () => {
    const run = campRun();
    expect(campExchange(run, 77)).toEqual(campExchange(run, 77));
    expect(campOpener(5)).toBe(campOpener(5));
    expect(CAMP_OPENERS).toContain(campOpener(12345));
  });

  it("seats two DIFFERENT cats when there are two to seat", () => {
    const run = campRun();
    for (let seed = 0; seed < 60; seed++) {
      const pair = campPair(run, seed);
      expect(pair).toHaveLength(2);
      expect(pair[0].id).not.toBe(pair[1].id);
    }
  });

  it("degrades to a monologue with a party of one", () => {
    const run = { ...campRun(), marchingOrder: ["bruiser"] };
    const pair = campPair(run, 3);
    expect(pair).toHaveLength(1);
    const ex = campExchange(run, 3);
    expect(ex!.lines.length).toBeGreaterThan(0);
  });

  it("reads the situation off the run", () => {
    let run = campRun(5);
    run = patchCat(run, "bruiser", (c) => withConditions(c, withHunger([], 3)));
    const tags = campTags(run, true);
    expect(tags).toContain("hungry");
    expect(tags).toContain("hurt");
    expect(tags).toContain("deep");
    expect(tags).toContain("boss");
    expect(tags).not.toContain("early");
  });

  it("authors flavour for every action", () => {
    for (const def of CAMP_ACTIONS) {
      const rows = CAMP_ACTION_LINES[def.id];
      expect(rows, `no lines for ${def.id}`).toBeDefined();
      expect(rows.length).toBeGreaterThanOrEqual(2);
    }
  });
});

/* ------------------------------------------------------------------ */
/* the embers                                                          */
/* ------------------------------------------------------------------ */

describe("the shared resource", () => {
  it("starts with CAMP_EMBERS and every action costs one", () => {
    const s = newCampSession();
    expect(s.embers).toBe(CAMP_EMBERS);
    for (const a of CAMP_ACTIONS) expect(a.cost).toBe(1);
  });

  it("cannot spend more than the fire is worth", () => {
    let run = campRun();
    let session = newCampSession();
    let taken = 0;
    for (let i = 0; i < 12; i++) {
      const cat = run.cats.find(
        (c) => canTakeCamp(run, session, "bandage", [c.id]).ok,
      );
      const who = cat ? [cat.id] : ["bruiser"];
      const out = takeCampAction(run, session, "bandage", who);
      if (out.session.embers < session.embers) taken += 1;
      run = out.run;
      session = out.session;
    }
    expect(taken).toBe(CAMP_EMBERS);
    expect(session.embers).toBe(0);
    expect(canTakeCamp(run, session, "eat", ["bruiser"]).why).toBe(
      "the fire is out",
    );
  });

  it("refuses a second helping for the same cat, but not for another", () => {
    const run = campRun();
    const s0 = newCampSession();
    const out = takeCampAction(run, s0, "bandage", ["bruiser"]);
    expect(canTakeCamp(out.run, out.session, "bandage", ["bruiser"]).ok).toBe(
      false,
    );
    expect(canTakeCamp(out.run, out.session, "bandage", ["trickster"]).ok).toBe(
      true,
    );
  });

  it("keeps the once-per-camp actions once per camp", () => {
    const run = campRun();
    const out = takeCampAction(run, newCampSession(), "watch", ["bruiser"]);
    expect(campAction("watch").once).toBe(true);
    expect(canTakeCamp(out.run, out.session, "watch", ["trickster"]).ok).toBe(
      false,
    );
  });

  it("is pure: an illegal action returns the run untouched", () => {
    const run = campRun();
    const session = newCampSession();
    const out = takeCampAction(run, session, "tend", ["bruiser"]); // no scars
    expect(out.run).toBe(run);
    expect(out.session).toBe(session);
    expect(out.results).toEqual([]);
    // …and an unknown cat is a plain no, never a throw
    expect(takeCampAction(run, session, "eat", ["nobody"]).run).toBe(run);
    expect(canTakeCamp(run, session, "talk", ["bruiser", "bruiser"]).ok).toBe(
      false,
    );
  });
});

describe("what an ember buys", () => {
  it("bandage: a quarter of max HP, never past full", () => {
    const run = campRun();
    const before = catOf(run, "bruiser");
    const out = takeCampAction(run, newCampSession(), "bandage", ["bruiser"]);
    const after = catOf(out.run, "bruiser");
    const max = maxHp(after, run.level);
    expect(after.hp).toBe(
      Math.min(max, before.hp + Math.floor(CAMP_BANDAGE_PCT * max)),
    );
    expect(after.hp).toBeLessThanOrEqual(max);
    // a cat at full is not worth an ember
    const full = patchCat(run, "hexer", (c) => ({
      ...c,
      hp: maxHp(c, run.level),
    }));
    expect(canTakeCamp(full, newCampSession(), "bandage", ["hexer"]).ok).toBe(
      false,
    );
  });

  it("eat: spends real food when there is some, hunger down either way", () => {
    let run = campRun();
    run = patchCat(run, "bruiser", (c) => withConditions(c, withHunger([], 3)));
    expect(campFood(run)).not.toBeNull(); // the starting kit carries snacks
    const before = run.inventory;
    const out = takeCampAction(run, newCampSession(), "eat", ["bruiser"]);
    const after = catOf(out.run, "bruiser");
    expect(hungerOf(after.conditions)).toBe(1); // a proper meal is worth 2
    expect(after.hp).toBeGreaterThan(catOf(run, "bruiser").hp);
    expect(JSON.stringify(out.run.inventory)).not.toBe(JSON.stringify(before));
  });

  it("eat: scraps still take the edge off with an empty bag", () => {
    let run = campRun();
    run = {
      ...run,
      inventory: {
        ...run.inventory,
        slots: run.inventory.slots.map(() => null),
      },
    };
    run = patchCat(run, "bruiser", (c) => withConditions(c, withHunger([], 2)));
    expect(campFood(run)).toBeNull();
    const out = takeCampAction(run, newCampSession(), "eat", ["bruiser"]);
    expect(hungerOf(catOf(out.run, "bruiser").conditions)).toBe(1);
  });

  it("tend: the scar stops pulling for the floor and stays forever", () => {
    let run = campRun();
    run = patchCat(run, "bruiser", (c) =>
      withConditions(c, [
        { id: "scar:stiffShoulder", label: "Stiff Shoulder" },
      ]),
    );
    expect(untendedScar(catOf(run, "bruiser"))?.id).toBe("scar:stiffShoulder");
    const out = takeCampAction(run, newCampSession(), "tend", ["bruiser"]);
    const after = catOf(out.run, "bruiser");
    expect(isTended(after, "scar:stiffShoulder")).toBe(true);
    expect(after.conditions?.some((c) => c.id === "scar:stiffShoulder")).toBe(
      true,
    );
    // the relief is a FLOOR mod — the stairs down take it away again
    const relief = after.tempMods.filter((m) =>
      m.sourceEventId.startsWith("tend:"),
    );
    expect(relief.length).toBeGreaterThan(0);
    expect(relief.every((m) => m.duration === "floor")).toBe(true);
    // and it cannot be tended twice
    expect(canTakeCamp(out.run, out.session, "tend", ["bruiser"]).ok).toBe(
      false,
    );
  });

  it("talk: both of them carry the bond home, and only ever one", () => {
    const run = campRun();
    const out = takeCampAction(run, newCampSession(), "talk", [
      "bruiser",
      "trickster",
    ]);
    for (const id of ["bruiser", "trickster"]) {
      const cat = catOf(out.run, id);
      expect(quirksOf(cat.conditions).map((q) => q.id)).toContain("quirk:bond");
      expect(cat.energyNextBattle).toBe(1);
      // the bond names the other cat
      const bond = cat.conditions!.find((c) => c.id === "quirk:bond")!;
      expect(bond.label).toContain(id === "bruiser" ? "Pixel" : "Bruno");
    }
    // a SECOND bond never lands: one per cat, ever
    const again = takeCampAction(out.run, newCampSession(), "talk", [
      "bruiser",
      "hexer",
    ]);
    expect(
      quirksOf(catOf(again.run, "bruiser").conditions).filter(
        (q) => q.id === "quirk:bond",
      ),
    ).toHaveLength(1);
  });

  it("watch: the whole party starts the next fight with energy", () => {
    const run = campRun();
    const out = takeCampAction(run, newCampSession(), "watch", ["trickster"]);
    expect(catOf(out.run, "bruiser").energyNextBattle).toBe(1);
    expect(catOf(out.run, "hexer").energyNextBattle).toBe(1);
    expect(catOf(out.run, "trickster").energyNextBattle).toBe(2); // the watcher
    expect(
      quirksOf(catOf(out.run, "trickster").conditions).map((q) => q.id),
    ).toContain("quirk:watchful");
  });

  it("never pushes owed energy past the events.md cap", () => {
    let run = campRun();
    run = {
      ...run,
      cats: run.cats.map((c) => ({ ...c, energyNextBattle: ENERGY_NEXT_CAP })),
    };
    const out = takeCampAction(run, newCampSession(), "watch", ["bruiser"]);
    for (const c of out.run.cats) {
      expect(c.energyNextBattle).toBeLessThanOrEqual(ENERGY_NEXT_CAP);
    }
  });

  it("touches nothing outside the existing vocabulary", () => {
    const run = campRun();
    let out = takeCampAction(run, newCampSession(), "watch", ["bruiser"]);
    out = takeCampAction(out.run, out.session, "talk", ["bruiser", "hexer"]);
    // the map, the score, the seed and the wallet are none of camp's business
    expect(out.run.floorMap).toBe(run.floorMap);
    expect(out.run.score).toEqual(run.score);
    expect(out.run.runSeed).toBe(run.runSeed);
    expect(out.run.inventory.shinies).toBe(run.inventory.shinies);
    for (const c of out.run.cats) {
      for (const m of c.tempMods) {
        expect(["run", "floor"]).toContain(m.duration);
      }
    }
  });

  it("every camp quirk it can grant is authored", () => {
    const granted = ["quirk:bond", "quirk:watchful"];
    for (const id of granted) {
      const def = QUIRKS.find((q) => q.id === id);
      expect(def, `${id} is not in QUIRKS`).toBeDefined();
      expect(def!.trigger).toBe("camp");
    }
  });

  it("a full camp is bounded: three embers, and the run is still legal", () => {
    let run = campRun();
    let session = newCampSession();
    const plan: { id: CampActionId; who: string[] }[] = [
      { id: "bandage", who: ["bruiser"] },
      { id: "talk", who: ["trickster", "hexer"] },
      { id: "watch", who: ["hexer"] },
      { id: "bandage", who: ["trickster"] },
    ];
    for (const step of plan) {
      const out = takeCampAction(run, session, step.id, step.who);
      run = out.run;
      session = out.session;
    }
    expect(session.embers).toBe(0);
    for (const c of run.cats) {
      expect(c.hp).toBeGreaterThan(0);
      expect(c.hp).toBeLessThanOrEqual(maxHp(c, run.level));
    }
  });
});

/* ------------------------------------------------------------------ */
/* the node                                                            */
/* ------------------------------------------------------------------ */

describe("consumables at the fire", () => {
  it("finds only food that heals out of combat", () => {
    let run = campRun();
    run = {
      ...run,
      inventory: {
        ...run.inventory,
        slots: run.inventory.slots.map(() => null),
      },
    };
    expect(campFood(run)).toBeNull();
    const { inv } = addConsumables(run.inventory, "theCucumber", 1);
    expect(campFood({ ...run, inventory: inv })).toBeNull(); // not food
    const withTuna = addConsumables(inv, "tunaSnack", 1).inv;
    expect(campFood({ ...run, inventory: withTuna })).toBe("tunaSnack");
  });
});

describe("the camp on the map", () => {
  it("turns up on the floors that authorise it, and only there", () => {
    const seen = new Map<number, number>();
    for (let s = 0; s < 40; s++) {
      for (let f = 1; f <= FLOORS.length; f++) {
        const map = generateFloorMap(`CAMPMAP-${s}`, f, FLOORS[f - 1]);
        const n = map.nodes.filter((x) => x.type === "camp").length;
        seen.set(f, (seen.get(f) ?? 0) + n);
      }
    }
    expect(seen.get(1)).toBe(0);
    expect(seen.get(2)).toBe(0);
    for (let f = 3; f <= FLOORS.length; f++) {
      expect(seen.get(f), `floor ${f} never camps`).toBeGreaterThan(0);
    }
  });
});
