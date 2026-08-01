/**
 * CONDITIONS — hunger, scars and quirks that survive the run
 * (docs/design/roster-and-persistence.md §3).
 *
 * What this pins:
 *  - the two `CatCondition` declarations (core/run vs core/meta) stay
 *    structurally identical, because core/run may not import core/meta and
 *    the day they drift is the day a save silently loses a scar;
 *  - a condition is ONLY ever a `TempMod` — the existing events.md §1
 *    vocabulary — so nothing here can become a mechanic of its own;
 *  - what a descent costs (`afterRun`) is deterministic, bounded, and never
 *    grants two quirks or a repeat scar;
 *  - a cat with no conditions produces the pre-conditions engine exactly.
 */
import { describe, expect, it } from "vitest";
import type { CatRunState, TempMod } from "../src/core/types.js";
import type { CatCondition as MetaCondition } from "../src/core/meta/types.js";
import {
  afterRun,
  conditionBlurb,
  conditionLine,
  conditionMods,
  feedCost,
  fed,
  firedTriggers,
  grantCondition,
  hasCondition,
  hungerLabel,
  hungerOf,
  hungerStage,
  isTended,
  modsOf,
  quirksOf,
  scarsOf,
  tendMods,
  trim,
  withConditions,
  withHunger,
  type CatCondition,
} from "../src/core/run/conditions.js";
import {
  FEED_COST_PER_POINT,
  HUNGER_MAX,
  MAX_CONDITIONS,
  QUIRKS,
  SCARS,
} from "../src/content/conditions.js";
import { effectiveStats, maxHp } from "../src/core/run/party.js";
import { makeCat } from "../src/core/run/runState.js";
import {
  bankCat,
  feedCat,
  feedPrice,
  runCat,
  settleRun,
} from "../src/core/meta/roster.js";
import { emptyProfile, migrateMeta } from "../src/core/meta/profile.js";
import type { MetaCat } from "../src/core/meta/types.js";

/* ------------------------------------------------------------------ */
/* the two declarations must not drift                                 */
/* ------------------------------------------------------------------ */

describe("CatCondition — one shape, declared twice on purpose", () => {
  it("is assignable in both directions", () => {
    const fromRun: CatCondition = {
      id: "scar:notchedEar",
      label: "Notched Ear",
      value: 1,
      data: { with: "Pixel" },
    };
    // if either declaration grows a field the other lacks, this stops
    // compiling — which is the whole point of the test
    const asMeta: MetaCondition = fromRun;
    const backAgain: CatCondition = asMeta;
    expect(backAgain).toEqual(fromRun);
  });
});

/* ------------------------------------------------------------------ */
/* hunger                                                              */
/* ------------------------------------------------------------------ */

const hungry = (n: number): CatCondition[] => withHunger([], n);

describe("hunger", () => {
  it("reads 0 from an absent or empty list", () => {
    expect(hungerOf(undefined)).toBe(0);
    expect(hungerOf([])).toBe(0);
  });

  it("clamps into 0..HUNGER_MAX and drops the entry at 0", () => {
    expect(hungerOf(hungry(99))).toBe(HUNGER_MAX);
    expect(hungerOf(hungry(-4))).toBe(0);
    expect(hungry(0)).toEqual([]);
  });

  it("labels every stage, and the first descent costs nothing", () => {
    expect(hungerStage(0).mods).toEqual([]);
    expect(hungerStage(1).mods).toEqual([]);
    expect(hungerStage(2).mods.length).toBeGreaterThan(0);
    expect(hungerLabel(0)).toBe("fed");
    expect(hungerLabel(HUNGER_MAX)).toBe("wasting");
    // stages are monotone: hungrier is never better
    let worst = 0;
    for (let v = 0; v <= HUNGER_MAX; v++) {
      const cost = hungerStage(v).mods.reduce((n, m) => n - m.amount, 0);
      expect(cost).toBeGreaterThanOrEqual(worst);
      worst = cost;
    }
  });

  it("keeps its label in step with its value", () => {
    for (let v = 0; v <= HUNGER_MAX; v++) {
      const cs = hungry(v);
      if (v === 0) continue;
      expect(cs[0].label).toBe(hungerLabel(v));
      expect(conditionBlurb(cs[0])).toBe(hungerStage(v).blurb);
    }
  });
});

/* ------------------------------------------------------------------ */
/* the stat cost is the EXISTING vocabulary                            */
/* ------------------------------------------------------------------ */

describe("conditions as tempMods", () => {
  it("emits run-scoped TempMods and nothing else", () => {
    const mods = conditionMods([
      ...hungry(4),
      { id: "scar:notchedEar", label: "Notched Ear" },
    ]);
    expect(mods.length).toBeGreaterThan(0);
    for (const m of mods) {
      expect(m.duration).toBe("run");
      expect(m.sourceEventId.startsWith("condition:")).toBe(true);
      expect(["atk", "def", "spd", "crt", "hpMax"]).toContain(m.stat);
    }
  });

  it("never emits a zero delta", () => {
    for (const def of [...SCARS, ...QUIRKS]) {
      const mods = conditionMods([{ id: def.id, label: def.label }]);
      expect(mods.every((m: TempMod) => m.amount !== 0)).toBe(true);
    }
  });

  it("makes a starving cat measurably worse, through effectiveStats", () => {
    const fedCat = makeCat("bruiser");
    const starving = withConditions(makeCat("bruiser"), hungry(4));
    const a = effectiveStats(fedCat, 4);
    const b = effectiveStats(starving, 4);
    expect(b.crt).toBeLessThan(a.crt);
    expect(b.spd).toBeLessThan(a.spd);
    expect(b.hp).toBeLessThan(a.hp);
  });

  /**
   * THE BALANCE GUARD (roster-and-persistence.md §3: "texture, not a
   * difficulty spike"). One point of ATK across the party is worth ~9 points
   * of clear rate in the scripted-run harness, which is an order of magnitude
   * more than a condition is allowed to be worth — so no condition may spend
   * more than one point of it, and only at the very bottom of the curve.
   */
  it("keeps its hands off ATK", () => {
    const atkOf = (mods: readonly { stat: string; amount: number }[]): number =>
      mods.filter((m) => m.stat === "atk").reduce((n, m) => n + m.amount, 0);
    for (const def of [...SCARS, ...QUIRKS]) {
      expect(atkOf(def.mods), `${def.id} moves ATK`).toBe(0);
    }
    for (let v = 0; v < HUNGER_MAX; v++) {
      expect(atkOf(hungerStage(v).mods), `hunger ${v} moves ATK`).toBe(0);
    }
    expect(Math.abs(atkOf(hungerStage(HUNGER_MAX).mods))).toBeLessThanOrEqual(
      1,
    );
  });

  it("an unknown condition id costs nothing (forward compatibility)", () => {
    expect(modsOf({ id: "quirk:dreamedUpLater", label: "?" })).toEqual([]);
    expect(conditionMods([{ id: "nonsense", label: "?" }])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* scars, quirks, the line the card prints                             */
/* ------------------------------------------------------------------ */

describe("reading a cat's conditions", () => {
  const cs: CatCondition[] = [
    ...hungry(2),
    { id: "scar:brokenFang", label: "Broken Fang" },
    { id: "quirk:bond", label: "Bonded · Pixel", data: { with: "Pixel" } },
  ];

  it("splits scars from quirks", () => {
    expect(scarsOf(cs).map((c) => c.id)).toEqual(["scar:brokenFang"]);
    expect(quirksOf(cs).map((c) => c.id)).toEqual(["quirk:bond"]);
  });

  it("prints one line, and says 'rested' when there is nothing", () => {
    expect(conditionLine(cs)).toBe("hungry · Broken Fang · Bonded · Pixel");
    expect(conditionLine([])).toBe("rested");
    expect(conditionLine(undefined)).toBe("rested");
  });
});

/* ------------------------------------------------------------------ */
/* tending (the camp's floor-long relief)                              */
/* ------------------------------------------------------------------ */

describe("tending a scar", () => {
  const scar: CatCondition = { id: "scar:shortWind", label: "Short Wind" };

  it("cancels the scar for the FLOOR and never removes it", () => {
    const mods = tendMods(scar);
    expect(mods).toEqual([
      {
        stat: "hpMax",
        amount: 3,
        duration: "floor",
        sourceEventId: "tend:scar:shortWind",
      },
    ]);
  });

  it("is visible to `isTended`, and expires with the floor", () => {
    const cat: CatRunState = {
      ...withConditions(makeCat("medic"), [scar]),
      tempMods: [],
    };
    expect(isTended(cat, scar.id)).toBe(false);
    const tended = { ...cat, tempMods: [...cat.tempMods, ...tendMods(scar)] };
    expect(isTended(tended, scar.id)).toBe(true);
    // `expireFloorMods` is what the stairs down call; the relief goes, the
    // scar stays on the cat
    expect(tended.conditions?.map((c) => c.id)).toEqual([scar.id]);
  });
});

/* ------------------------------------------------------------------ */
/* what a descent costs                                                */
/* ------------------------------------------------------------------ */

const CTX = {
  seed: "SEED-1",
  catId: "bruiser",
  livesLost: 0,
  victory: true,
  floorsReached: 3,
  bossesDefeated: 0,
  runs: 0,
};

describe("afterRun — what a descent does to a cat", () => {
  it("raises hunger by one, and by two when the run fell apart", () => {
    expect(hungerOf(afterRun([], CTX))).toBe(1);
    expect(hungerOf(afterRun([], { ...CTX, victory: false }))).toBe(2);
  });

  it("never pushes hunger past the cap", () => {
    let cs = hungry(HUNGER_MAX);
    for (let i = 0; i < 4; i++) cs = afterRun(cs, { ...CTX, runs: i });
    expect(hungerOf(cs)).toBe(HUNGER_MAX);
  });

  it("scars a cat that burned a Life, and only that cat", () => {
    const clean = afterRun([], CTX);
    expect(scarsOf(clean)).toHaveLength(0);
    const marked = afterRun([], { ...CTX, livesLost: 1 });
    expect(scarsOf(marked)).toHaveLength(1);
    expect(SCARS.map((s) => s.id)).toContain(scarsOf(marked)[0].id);
  });

  it("is deterministic — the same run always leaves the same scar", () => {
    const a = afterRun([], { ...CTX, livesLost: 2 });
    const b = afterRun([], { ...CTX, livesLost: 2 });
    expect(a).toEqual(b);
  });

  it("never repeats a scar until the table is exhausted", () => {
    let cs: CatCondition[] = [];
    const seen = new Set<string>();
    for (let run = 0; run < SCARS.length; run++) {
      cs = afterRun(cs, { ...CTX, livesLost: 1, runs: run });
      for (const s of scarsOf(cs)) seen.add(s.id);
      // the trim can drop old ones, so count what we ever saw
      expect(new Set(scarsOf(cs).map((s) => s.id)).size).toBe(
        scarsOf(cs).length,
      );
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("grants at most ONE quirk per run, from what actually happened", () => {
    const out = afterRun([], {
      ...CTX,
      victory: true,
      bossesDefeated: 2,
      floorsReached: 6,
      livesLost: 1,
    });
    expect(quirksOf(out)).toHaveLength(1);
    // most dramatic trigger first: a boss beats "came home"
    expect(quirksOf(out)[0].id).toBe("quirk:bossBlooded");
  });

  it("does not grant the same quirk twice", () => {
    let cs = afterRun([], { ...CTX, bossesDefeated: 1 });
    expect(quirksOf(cs).map((q) => q.id)).toEqual(["quirk:bossBlooded"]);
    cs = afterRun(cs, { ...CTX, bossesDefeated: 1, runs: 1 });
    expect(
      quirksOf(cs).filter((q) => q.id === "quirk:bossBlooded"),
    ).toHaveLength(1);
  });

  it("never grants a camp quirk at settle time", () => {
    const campOnly = QUIRKS.filter((q) => q.trigger === "camp").map(
      (q) => q.id,
    );
    let cs: CatCondition[] = [];
    for (let i = 0; i < 8; i++) {
      cs = afterRun(cs, { ...CTX, runs: i, livesLost: 1, floorsReached: 6 });
    }
    for (const id of campOnly) expect(hasCondition(cs, id)).toBe(false);
  });

  it("reads the triggers off the run, in drama order", () => {
    expect(firedTriggers({ ...CTX, bossesDefeated: 1 })).toContain("boss");
    expect(firedTriggers({ ...CTX, floorsReached: 6 })).toContain("deep");
    expect(
      firedTriggers({ ...CTX, victory: false, floorsReached: 1 }),
    ).toContain("routed");
    expect(firedTriggers({ ...CTX, livesLost: 3 })).toContain("mauled");
  });

  it("keeps the list bounded, and never trims hunger away", () => {
    let cs: CatCondition[] = [];
    for (let i = 0; i < 20; i++) {
      cs = afterRun(cs, { ...CTX, runs: i, livesLost: 1, floorsReached: 6 });
    }
    expect(cs.length).toBeLessThanOrEqual(MAX_CONDITIONS);
    expect(hungerOf(cs)).toBe(HUNGER_MAX);
  });

  it("trims the OLDEST non-hunger entry first", () => {
    const many: CatCondition[] = [
      ...hungry(1),
      ...SCARS.slice(0, MAX_CONDITIONS + 2).map((s) => ({
        id: s.id,
        label: s.label,
      })),
    ];
    const cut = trim(many);
    expect(cut).toHaveLength(MAX_CONDITIONS);
    expect(cut[0].id).toBe("hunger");
    expect(cut.map((c) => c.id)).not.toContain(SCARS[0].id);
  });
});

/* ------------------------------------------------------------------ */
/* feeding: the town's side                                            */
/* ------------------------------------------------------------------ */

describe("feeding", () => {
  it("prices a meal per point of hunger", () => {
    expect(feedCost([])).toBe(0);
    expect(feedCost(hungry(3))).toBe(3 * FEED_COST_PER_POINT);
  });

  it("buys as many points as the wallet covers, and no more", () => {
    const poor = fed(hungry(3), FEED_COST_PER_POINT + 3);
    expect(poor.points).toBe(1);
    expect(poor.spent).toBe(FEED_COST_PER_POINT);
    expect(hungerOf(poor.conditions)).toBe(2);

    const rich = fed(hungry(3), 9999);
    expect(rich.points).toBe(3);
    expect(hungerOf(rich.conditions)).toBe(0);
  });

  it("is a no-op on a fed cat or an empty wallet", () => {
    expect(fed(hungry(2), 0).points).toBe(0);
    expect(fed([], 9999).points).toBe(0);
  });

  it("spends the town wallet through `feedCat`", () => {
    let meta = emptyProfile();
    const id = meta.roster![0].id;
    meta = {
      ...meta,
      shinies: 100,
      roster: meta.roster!.map((c) =>
        c.id === id ? { ...c, conditions: hungry(3) } : c,
      ),
    };
    expect(feedPrice(meta, id)).toBe(3 * FEED_COST_PER_POINT);
    const out = feedCat(meta, id);
    expect(out.points).toBe(3);
    expect(out.meta.shinies).toBe(100 - 3 * FEED_COST_PER_POINT);
    expect(
      hungerOf(out.meta.roster!.find((c) => c.id === id)!.conditions),
    ).toBe(0);
    // and it never goes below zero, or feeds a cat that does not live here
    expect(feedCat(out.meta, id).spent).toBe(0);
    expect(feedCat(out.meta, "nobody").meta).toBe(out.meta);
  });
});

/* ------------------------------------------------------------------ */
/* the seams: runCat / bankCat / settleRun                             */
/* ------------------------------------------------------------------ */

const townCat = (over: Partial<MetaCat> = {}): MetaCat => ({
  id: "bruiser",
  name: "Bruno",
  classId: "bruiser",
  standName: "THE DUMPSTER KING",
  level: 1,
  xp: 0,
  lives: 9,
  weapon: null,
  trinket: null,
  collar: null,
  conditions: [],
  runs: 0,
  ...over,
});

describe("the run seam", () => {
  it("a cat with NO conditions descends exactly as it always did", () => {
    const ran = runCat(townCat(), 1);
    expect(ran.tempMods).toEqual([]);
    expect("conditions" in ran).toBe(false);
  });

  it("a hungry cat descends at its reduced maximum, already full", () => {
    const plain = runCat(townCat(), 4);
    const starving = runCat(townCat({ conditions: hungry(5) }), 4);
    expect(starving.hp).toBe(maxHp(starving, 4));
    expect(starving.hp).toBeLessThan(plain.hp);
    expect(starving.conditions).toHaveLength(1);
  });

  it("bankCat only charges for the descent when told about it", () => {
    const cat = townCat({ conditions: hungry(1) });
    const ran = runCat(cat, 1);
    expect(hungerOf(bankCat(cat, ran, 0).conditions)).toBe(1);
    expect(
      hungerOf(
        bankCat(cat, ran, 0, {
          seed: "S",
          victory: true,
          floorsReached: 2,
          bossesDefeated: 0,
        }).conditions,
      ),
    ).toBe(2);
  });

  it("carries a condition the CAMP granted mid-run home", () => {
    const cat = townCat();
    const ran = grantCondition(runCat(cat, 1), {
      id: "quirk:watchful",
      label: "Watchful",
    });
    const home = bankCat(cat, ran, 0, {
      seed: "S",
      victory: true,
      floorsReached: 2,
      bossesDefeated: 0,
    });
    expect(hasCondition(home.conditions, "quirk:watchful")).toBe(true);
  });

  it("settles a whole run: hunger up, a Life burned means a scar", () => {
    let meta = emptyProfile();
    const cat = meta.roster![0];
    const ran = { ...runCat(cat, 1), lives: cat.lives - 1 };
    meta = settleRun(meta, {
      seed: "SETTLE-1",
      floorsReached: 4,
      cats: [ran],
      victory: false,
      bossesDefeated: 1,
    });
    const home = meta.roster!.find((c) => c.id === cat.id)!;
    expect(hungerOf(home.conditions)).toBe(2); // +1 run, +1 defeat
    expect(scarsOf(home.conditions)).toHaveLength(1);
    expect(quirksOf(home.conditions)).toHaveLength(1);
  });

  it("survives a meta round-trip", () => {
    let meta = emptyProfile();
    const id = meta.roster![0].id;
    meta = {
      ...meta,
      roster: meta.roster!.map((c) =>
        c.id === id
          ? {
              ...c,
              conditions: [
                ...hungry(2),
                { id: "scar:tornPad", label: "Torn Pad" },
                {
                  id: "quirk:bond",
                  label: "Bonded · Pixel",
                  data: { with: "Pixel" },
                },
              ],
            }
          : c,
      ),
    };
    const back = migrateMeta(JSON.parse(JSON.stringify(meta)));
    expect(back).not.toBeNull();
    const home = back!.roster!.find((c) => c.id === id)!;
    expect(home.conditions).toEqual(
      meta.roster!.find((c) => c.id === id)!.conditions,
    );
  });
});
