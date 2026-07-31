/**
 * CAT TOWN — the pure meta layer (balance-and-meta.md §4).
 *
 * Earning (win AND lose), spending, prerequisites, idempotent unlocks, the
 * v1 → v2 save migration, the overlay fold (including pooled/generated
 * content ids nobody wrote code for), and the rule that matters most: an
 * unlock bought in town can never reach a run already in progress.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  affordableUnlocks,
  applyOverlayToRun,
  applyUnlocks,
  BASE_PARTY_CAPACITY,
  bankRun,
  BUILTIN_UNLOCKS,
  catalogCost,
  computePayout,
  earnShinies,
  emptyProfile,
  HISTORY_LIMIT,
  eligibleClasses,
  isUnlocked,
  LOSS_RATE,
  MAX_PARTY_CAPACITY,
  META_VERSION,
  migrateMeta,
  MIN_PAYOUT,
  newlyAffordable,
  PLACES,
  purchase,
  registerUnlocks,
  resetUnlockRegistry,
  startRun,
  startingRoster,
  STARTING_PARTY_SIZE,
  unlockCatalog,
  unlocksAt,
  unlockState,
  VICTORY_BONUS,
  type MetaProfile,
  type RunSummary,
  type UnlockDef,
} from "../src/core/meta/index.js";
import {
  emptyMeta,
  loadMeta,
  memoryStorage,
  META_KEY,
  recordRunEnd,
  saveMeta,
} from "../src/core/run/save.js";
import { newRun } from "../src/core/run/runState.js";

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  seed: "MEOW-1987",
  victory: false,
  floorsReached: 1,
  floorsCleared: 0,
  enemiesDefeated: 0,
  bossesDefeated: 0,
  catPiles: 0,
  shiniesCarried: 0,
  score: 0,
  playTimeMs: 0,
  ...over,
});

const rich = (shinies: number): MetaProfile => ({
  ...emptyProfile(),
  shinies,
  lifetimeShinies: shinies,
});

beforeEach(() => {
  resetUnlockRegistry();
});

/* ------------------------------------------------------------------ */
/* the catalog                                                         */
/* ------------------------------------------------------------------ */

describe("unlock catalog", () => {
  it("is well-formed: unique ids, namespaced, priced, placed", () => {
    const ids = new Set<string>();
    for (const def of BUILTIN_UNLOCKS) {
      expect(ids.has(def.id), `duplicate ${def.id}`).toBe(false);
      ids.add(def.id);
      expect(def.id).toMatch(/^[a-z]+:.+$/); // "<namespace>:<localId>"
      expect(def.cost).toBeGreaterThan(0);
      expect(def.pitch.length).toBeGreaterThan(10);
      expect(PLACES.some((p) => p.id === def.place)).toBe(true);
    }
  });

  it("has no dangling or self-referential prerequisites", () => {
    const ids = new Set(BUILTIN_UNLOCKS.map((d) => d.id));
    for (const def of BUILTIN_UNLOCKS) {
      for (const req of def.requires) {
        expect(req).not.toBe(def.id);
        expect(ids.has(req), `${def.id} needs missing ${req}`).toBe(true);
      }
    }
  });

  it("prices the whole town at 2650 ✦ — ~4 victories or ~a dozen failures", () => {
    expect(catalogCost()).toBe(2650);
    expect(BUILTIN_UNLOCKS).toHaveLength(13);
  });

  it("every place has something to sell", () => {
    for (const place of PLACES) {
      expect(unlocksAt(place.id).length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* earning — win OR lose                                               */
/* ------------------------------------------------------------------ */

describe("payout", () => {
  it("pays a total wipe on floor 1 the floor, never nothing", () => {
    const p = computePayout(summary({ victory: false }));
    expect(p.total).toBe(MIN_PAYOUT);
    expect(p.total).toBeGreaterThan(0);
  });

  it("pays a failed mid-run properly (measured: 72 ✦)", () => {
    const p = computePayout(
      summary({
        floorsReached: 2,
        floorsCleared: 1,
        enemiesDefeated: 8,
        shiniesCarried: 60,
      }),
    );
    expect(p.earned).toBe(50 + 40 + 16 + 15);
    expect(p.lossRate).toBe(LOSS_RATE);
    expect(p.total).toBe(Math.floor(121 * LOSS_RATE)); // 72
  });

  it("pays a clean victory (measured: 757 ✦) and the same run loses less", () => {
    const won = summary({
      victory: true,
      floorsReached: 6,
      floorsCleared: 6,
      enemiesDefeated: 50,
      bossesDefeated: 1,
      catPiles: 4,
      shiniesCarried: 150,
      score: 4200,
    });
    const win = computePayout(won);
    expect(win.earned).toBe(150 + 240 + 100 + 60 + 20 + 37);
    expect(win.bonus).toBe(VICTORY_BONUS);
    expect(win.total).toBe(607 + VICTORY_BONUS); // 757
    const lost = computePayout({ ...won, victory: false });
    expect(lost.total).toBeLessThan(win.total);
    expect(lost.total).toBe(Math.floor(607 * LOSS_RATE)); // 364
  });

  it("is pure: same summary in, deep-equal payout out", () => {
    const s = summary({ floorsReached: 3, enemiesDefeated: 11 });
    expect(computePayout(s)).toEqual(computePayout(s));
  });
});

describe("banking a run", () => {
  it("banks the payout, ticks the records and records the run", () => {
    const before = emptyProfile();
    const { meta, payout } = bankRun(
      before,
      summary({ victory: true, floorsReached: 6, score: 3000, playTimeMs: 90 }),
    );
    expect(meta.shinies).toBe(payout.total);
    expect(meta.lifetimeShinies).toBe(payout.total);
    expect(meta.counters).toEqual({ runs: 1, victories: 1 });
    expect(meta.records).toEqual({ bestScore: 3000, fastestVictoryMs: 90 });
    expect(meta.history[0]).toEqual({
      seed: "MEOW-1987",
      victory: true,
      floor: 6,
      score: 3000,
      payout: payout.total,
      playTimeMs: 90,
    });
    expect(before.shinies).toBe(0); // pure: the input is untouched
  });

  it("a losing run still pays into the tin", () => {
    const { meta, payout } = bankRun(emptyProfile(), summary());
    expect(payout.total).toBeGreaterThan(0);
    expect(meta.shinies).toBe(payout.total);
    expect(meta.counters).toEqual({ runs: 1, victories: 0 });
  });

  it("keeps only the last HISTORY_LIMIT runs, newest first", () => {
    let meta = emptyProfile();
    for (let i = 0; i < HISTORY_LIMIT + 4; i++) {
      meta = bankRun(meta, summary({ seed: `S${i}` })).meta;
    }
    expect(meta.history).toHaveLength(HISTORY_LIMIT);
    expect(meta.history[0].seed).toBe(`S${HISTORY_LIMIT + 3}`);
    expect(meta.counters.runs).toBe(HISTORY_LIMIT + 4);
  });

  it("earnShinies grants outside a run and never goes negative", () => {
    expect(earnShinies(emptyProfile(), 40).shinies).toBe(40);
    expect(earnShinies(emptyProfile(), -40).shinies).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* spending: prerequisites + idempotence                               */
/* ------------------------------------------------------------------ */

describe("spending", () => {
  it("charges the cost once and marks the unlock owned", () => {
    const meta = rich(200);
    const r = purchase(meta, "class:hexer");
    expect(r.ok).toBe(true);
    expect(r.meta.shinies).toBe(110);
    expect(isUnlocked(r.meta, "class:hexer")).toBe(true);
    expect(meta.shinies).toBe(200); // input untouched
  });

  it("is idempotent: buying an owned unlock never charges twice", () => {
    const first = purchase(rich(200), "class:hexer");
    const second = purchase(first.meta, "class:hexer");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("owned");
    expect(second.meta).toBe(first.meta); // same object, nothing spent
    expect(second.meta.shinies).toBe(110);
    expect(second.meta.unlocked).toEqual(["class:hexer"]);
  });

  it("refuses what the tin cannot cover", () => {
    const r = purchase(rich(50), "class:hexer");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unaffordable");
    expect(r.meta.shinies).toBe(50);
  });

  it("gates on prerequisites, not on price", () => {
    const meta = rich(9999);
    expect(unlockState(meta, "slot:fourth")).toBe("locked");
    expect(purchase(meta, "slot:fourth").ok).toBe(false);
    const hexer = purchase(meta, "class:hexer");
    expect(hexer.ok).toBe(true);
    expect(unlockState(hexer.meta, "slot:fourth")).toBe("available");
    expect(purchase(hexer.meta, "slot:fourth").ok).toBe(true);
  });

  it("reports an unknown id instead of throwing", () => {
    const r = purchase(rich(9999), "nope:whatever");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown");
  });

  it("newlyAffordable is what the payout just put in reach", () => {
    const poor = rich(80);
    const banked = bankRun(
      poor,
      summary({ floorsReached: 3, floorsCleared: 2, enemiesDefeated: 20 }),
    );
    expect(affordableUnlocks(poor)).toEqual([]);
    const fresh = newlyAffordable(poor, banked.meta);
    expect(fresh).toContain("class:hexer");
    expect(fresh).not.toContain("slot:fourth"); // still gated
    expect(newlyAffordable(banked.meta, banked.meta)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the OPEN catalog: pooled / generated content                        */
/* ------------------------------------------------------------------ */

describe("the unlock IS the content pool", () => {
  const generated: UnlockDef = {
    id: "stand:heavyRotation",
    name: "HEAVY ROTATION",
    pitch: "A Stand another cat dreamt up, looking for a partner.",
    cost: 30,
    requires: ["pool:stand"],
    place: "shrineOfSomeoneElse", // an unknown place
  };

  it("registers generated content and sells it at the fallback place", () => {
    registerUnlocks([generated]);
    expect(unlockCatalog()).toHaveLength(BUILTIN_UNLOCKS.length + 1);
    expect(unlocksAt("board").map((d) => d.id)).toContain(
      "stand:heavyRotation",
    );
    resetUnlockRegistry();
    expect(unlockCatalog()).toHaveLength(BUILTIN_UNLOCKS.length);
  });

  it("still gates generated content on its prerequisite", () => {
    registerUnlocks([generated]);
    expect(unlockState(rich(9999), "stand:heavyRotation")).toBe("locked");
  });

  it("folds an unlock id nobody wrote code for into its own pool", () => {
    const meta: MetaProfile = {
      ...emptyProfile(),
      unlocked: ["stand:heavyRotation", "biome:3", "encounter:strayPatrol"],
    };
    const overlay = applyUnlocks(meta);
    expect(overlay.pool.stand).toEqual(["heavyRotation"]);
    expect(overlay.pool.encounter).toEqual(["strayPatrol"]);
    expect(overlay.maxBiome).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* applyUnlocks → the run overlay                                      */
/* ------------------------------------------------------------------ */

describe("applyUnlocks", () => {
  it("a fresh profile is the vanilla run: two cats, room for three", () => {
    const o = applyUnlocks(emptyProfile());
    expect(o.partyCapacity).toBe(BASE_PARTY_CAPACITY);
    expect(o.startingShinies).toBe(0);
    expect(o.maxBiome).toBe(1);
    expect(o.gear).toEqual([]);
    expect(o.openPools).toEqual([]);
    expect(eligibleClasses(o)).toEqual(["bruiser", "trickster"]);
    expect(startingRoster("MEOW-1987", o)).toEqual(["bruiser", "trickster"]);
    expect(startingRoster("MEOW-1987", o)).toHaveLength(STARTING_PARTY_SIZE);
  });

  it("folds every namespace and caps the clowder at four", () => {
    const meta: MetaProfile = {
      ...emptyProfile(),
      unlocked: [
        "slot:fourth",
        "class:hexer",
        "class:medic",
        "gear:cardboardCuirass",
        "shinies:tin",
        "shop:bigBlanket",
        "pool:event",
        "biome:2",
      ],
    };
    const o = applyUnlocks(meta);
    expect(o.partyCapacity).toBe(MAX_PARTY_CAPACITY);
    expect(o.startingShinies).toBe(20);
    expect(o.maxBiome).toBe(2);
    expect(o.gear).toEqual(["cardboardCuirass"]);
    expect(o.shopUpgrades).toEqual(["bigBlanket"]);
    expect(o.openPools).toEqual(["event"]);
    expect(eligibleClasses(o)).toEqual([
      "bruiser",
      "trickster",
      "hexer",
      "medic",
    ]);
    // the second cat is now drawn from a wider town, still deterministically
    expect(startingRoster("MEOW-1987", o)).toEqual(
      startingRoster("MEOW-1987", o),
    );
    expect(startingRoster("MEOW-1987", o)[0]).toBe("bruiser");
  });

  it("never exceeds four slots however many bowls are bought", () => {
    registerUnlocks([
      {
        id: "slot:absurd",
        name: "Too Many Bowls",
        pitch: "A test def that tries to overfill the clowder.",
        cost: 1,
        requires: [],
        place: "bowls",
        grants: { slots: 9 },
      },
    ]);
    const o = applyUnlocks({ ...emptyProfile(), unlocked: ["slot:absurd"] });
    expect(o.partyCapacity).toBe(MAX_PARTY_CAPACITY);
  });

  it("returns a fresh object every call (no shared mutable overlay)", () => {
    const meta = { ...emptyProfile(), unlocked: ["class:hexer"] };
    const a = applyUnlocks(meta);
    const b = applyUnlocks(meta);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.pool).not.toBe(b.pool);
  });
});

/* ------------------------------------------------------------------ */
/* the run seam                                                        */
/* ------------------------------------------------------------------ */

describe("startRun", () => {
  it("fields two cats from the town roster and banks the starting tin", () => {
    const meta: MetaProfile = {
      ...emptyProfile(),
      unlocked: ["slot:fourth", "class:hexer", "shinies:tin"],
    };
    const overlay = applyUnlocks(meta);
    const run = startRun("MEOW-1987", overlay);
    // all four slots still exist on the run (the bench); only two are fielded
    expect(run.cats).toHaveLength(4);
    expect(run.marchingOrder).toEqual(startingRoster("MEOW-1987", overlay));
    expect(run.marchingOrder).toHaveLength(STARTING_PARTY_SIZE);
    expect(run.marchingOrder[0]).toBe("bruiser");
    expect(run.partyCapacity).toBe(MAX_PARTY_CAPACITY);
    expect(run.inventory.shinies).toBe(newRun("X").inventory.shinies + 20);
  });

  it("a town with nothing unlocked can only field Bruno + Pixel", () => {
    const run = startRun("MEOW-1987", applyUnlocks(emptyProfile()));
    expect(run.marchingOrder).toEqual(["bruiser", "trickster"]);
    expect(run.partyCapacity).toBe(BASE_PARTY_CAPACITY);
  });

  it("hands over unlocked starting gear as a backpack item", () => {
    const meta: MetaProfile = {
      ...emptyProfile(),
      unlocked: ["gear:cardboardCuirass"],
    };
    const run = startRun("MEOW-1987", applyUnlocks(meta));
    const owned = run.inventory.slots.filter(
      (s) => s !== null && "defId" in s && s.defId === "cardboardCuirass",
    );
    expect(owned).toHaveLength(1);
  });

  it("ignores gear ids this build does not ship", () => {
    const overlay = {
      ...applyUnlocks(emptyProfile()),
      gear: ["someGeneratedThingNotInThisBuild"],
    };
    expect(() => startRun("MEOW-1987", overlay)).not.toThrow();
  });

  it("is deterministic for a fixed seed and overlay", () => {
    const overlay = applyUnlocks({
      ...emptyProfile(),
      unlocked: ["class:hexer", "slot:third"],
    });
    expect(startRun("MEOW-1987", overlay)).toEqual(
      startRun("MEOW-1987", overlay),
    );
  });

  it("an unlock bought later NEVER mutates a run already in progress", () => {
    let meta = rich(9999);
    const run = startRun("MEOW-1987", applyUnlocks(meta));
    const snapshot = JSON.parse(JSON.stringify(run)) as unknown;
    const capacityDuringRun = run.partyCapacity;
    const walletDuringRun = run.inventory.shinies;

    meta = purchase(meta, "class:hexer").meta;
    meta = purchase(meta, "slot:fourth").meta;
    meta = purchase(meta, "shinies:tin").meta;
    const later = applyUnlocks(meta);

    expect(JSON.parse(JSON.stringify(run))).toEqual(snapshot);
    expect(run.partyCapacity).toBe(capacityDuringRun);
    expect(run.inventory.shinies).toBe(walletDuringRun);
    // …and the NEXT run does see them
    const next = applyOverlayToRun(newRun("MEOW-1987"), later);
    expect(next.partyCapacity).toBe(MAX_PARTY_CAPACITY);
    expect(next.inventory.shinies).toBe(walletDuringRun + 20);
  });
});

/* ------------------------------------------------------------------ */
/* persistence: migration + round-trip                                 */
/* ------------------------------------------------------------------ */

describe("meta persistence", () => {
  it("migrates a v1 records-only file forward, keeping the records", () => {
    const v1 = {
      version: 1,
      counters: { runs: 7, victories: 2 },
      records: { bestScore: 4200, fastestVictoryMs: 900_000 },
    };
    const m = migrateMeta(v1)!;
    expect(m.version).toBe(META_VERSION);
    expect(m.counters).toEqual(v1.counters);
    expect(m.records).toEqual(v1.records);
    expect(m.shinies).toBe(0);
    expect(m.unlocked).toEqual([]);
    expect(m.history).toEqual([]);
  });

  it("discards unknown / corrupt payloads", () => {
    expect(migrateMeta({ version: 99 })).toBeNull();
    expect(migrateMeta(null)).toBeNull();
    expect(migrateMeta("nope")).toBeNull();
  });

  it("repairs a hand-edited file instead of trusting it", () => {
    const m = migrateMeta({
      version: 2,
      counters: { runs: "x", victories: 3 },
      records: { bestScore: 10, fastestVictoryMs: "soon" },
      shinies: 40.7,
      lifetimeShinies: 0,
      unlocked: ["class:hexer", "class:hexer", 7],
      history: "not an array",
    })!;
    expect(m.counters.runs).toBe(0);
    expect(m.records.fastestVictoryMs).toBeNull();
    expect(m.shinies).toBe(40);
    expect(m.lifetimeShinies).toBe(40); // never less than what is banked
    expect(m.unlocked).toEqual(["class:hexer"]);
    expect(m.history).toEqual([]);
  });

  it("round-trips a v2 profile through the save slot", () => {
    const storage = memoryStorage();
    expect(loadMeta(storage)).toEqual(emptyMeta());
    const meta = bankRun(
      purchase(rich(400), "class:hexer").meta,
      summary({ victory: true, floorsReached: 6, score: 5000 }),
    ).meta;
    saveMeta(meta, storage);
    expect(loadMeta(storage)).toEqual(meta);
  });

  it("a v1 blob on disk loads as a playable v2 profile", () => {
    const storage = memoryStorage();
    storage.set(
      META_KEY,
      JSON.stringify({
        version: 1,
        counters: { runs: 3, victories: 1 },
        records: { bestScore: 900, fastestVictoryMs: null },
      }),
    );
    const meta = loadMeta(storage);
    expect(meta.version).toBe(META_VERSION);
    expect(meta.counters.runs).toBe(3);
    expect(meta.shinies).toBe(0);
    expect(applyUnlocks(meta).partyCapacity).toBe(BASE_PARTY_CAPACITY);
  });

  it("garbage in the slot falls back to a fresh profile", () => {
    const storage = memoryStorage();
    storage.set(META_KEY, "{not json");
    expect(loadMeta(storage)).toEqual(emptyProfile());
  });

  it("recordRunEnd still folds records only and keeps the town intact", () => {
    const meta = purchase(rich(400), "class:hexer").meta;
    const after = recordRunEnd(meta, {
      victory: true,
      score: 10,
      playTimeMs: 5,
    });
    expect(after.counters.runs).toBe(1);
    expect(after.shinies).toBe(meta.shinies);
    expect(after.unlocked).toEqual(["class:hexer"]);
  });
});
