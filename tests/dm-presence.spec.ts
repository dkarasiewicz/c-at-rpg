/**
 * The DM as a PRESENCE (docs/design/run-map-and-dm.md §4b) — the pure parts.
 *
 * Five things are worth testing without a browser, a DM, or a network:
 *
 *  1. THE BUDGET / COOLDOWN POLICY — "rarity is the point". A handful per run,
 *     an explicit cooldown, and a dedupe rule per beat. Not vibes.
 *  2. BEAT SELECTION — the loudest candidate wins, and the bar to interrupt
 *     rises as the budget is spent, so the last interjection of a run can only
 *     be earned by a dramatic beat.
 *  3. VERDICT VALIDATION AND CLAMPING — an interjection's twist goes through
 *     the SAME client-side lint an answered line does; anything over-budget,
 *     out-of-union or tampered degrades to PURE NARRATION and never reaches
 *     the engine.
 *  4. TRANSCRIPT RECORDING — every interjection and every generated artefact
 *     lands in the run log, monotonically, bounded, and survives the save
 *     round-trip, so a replay reads the run instead of re-asking a model.
 *  5. OFFLINE ⇒ EXACTLY ZERO DM SURFACE — with no DM configured, nothing is
 *     planned, nothing is requested, and `fetch` is never called once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Effect, RunState } from "../src/core/types.js";
import { newRun, generateCurrentFloorMap } from "../src/core/run/runState.js";
import { memoryStorage, saveRun, loadRun } from "../src/core/run/save.js";
import {
  BEAT_DRAMA,
  DM_BEATS,
  INTERJECTION_BUDGET,
  INTERJECTION_COOLDOWN_MS,
  MAX_GENERATED_RECORDS,
  MAX_INTERJECTION_LOG,
  MAX_INVITE,
  MAX_QUEUED_INTERJECTIONS,
  beatKey,
  didDescend,
  dramaThreshold,
  dramaticStateBeats,
  emptyPresence,
  interjectionSchema,
  isDmAvailable,
  planInterjection,
  presenceOf,
  probeDm,
  requestInterjection,
  resetDmProbe,
  setDmBaseUrl,
  takeQueuedInterjection,
  validateInterjection,
  withBeatSpent,
  withGeneratedRecord,
  withInterjectionRecorded,
  withPresenceFloor,
  withQueuedInterjection,
  type DmPresenceState,
  type Interjection,
  type PresenceRun,
} from "../src/services/dm.js";
import { MAX_NARRATION } from "../src/services/tabletop.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function run(floor = 1): PresenceRun {
  const r = generateCurrentFloorMap(newRun("presence-seed")) as PresenceRun;
  return floor === 1 ? r : ({ ...r, floorNum: floor } as PresenceRun);
}

function state(patch: Partial<DmPresenceState> = {}): DmPresenceState {
  return { ...emptyPresence(), ...patch };
}

const AVAILABLE = { nowMs: 1_000_000, floor: 3, available: true };

/** A well-formed interjection payload as the wire would deliver it. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "warning",
    narration: "The vent exhales. It remembers you from floor two.",
    invite: "Well? Do you answer it?",
    effects: [],
    ...over,
  };
}

/* ================================================================== */
/* 1. the budget / cooldown policy                                     */
/* ================================================================== */

describe("interjection policy — the rate limit is a budget, not vibes", () => {
  it("allows the first beat of a run, whatever it is", () => {
    const d = planInterjection(state(), ["arriveNode"], AVAILABLE);
    expect(d.beat).toBe("arriveNode");
    expect(d.reason).toBe("none");
  });

  it("targets a handful per run and then goes quiet forever", () => {
    const spent = state({ used: INTERJECTION_BUDGET, lastAtMs: 0 });
    const d = planInterjection(spent, ["bossLair"], AVAILABLE);
    expect(d.beat).toBeNull();
    expect(d.reason).toBe("budget");
  });

  it("holds a cooldown between beats, even for the loudest one", () => {
    const hot = state({ used: 1, lastAtMs: AVAILABLE.nowMs - 1_000 });
    expect(planInterjection(hot, ["bossLair"], AVAILABLE)).toEqual({
      beat: null,
      reason: "cooldown",
    });
    const cooled = state({
      used: 1,
      lastAtMs: AVAILABLE.nowMs - INTERJECTION_COOLDOWN_MS - 1,
    });
    expect(planInterjection(cooled, ["bossLair"], AVAILABLE).beat).toBe(
      "bossLair",
    );
  });

  it("spends the budget synchronously, so two beats cannot race through it", () => {
    let r = run();
    r = withBeatSpent(r, "ko", 1_000);
    const p = presenceOf(r);
    expect(p.used).toBe(1);
    expect(p.lastAtMs).toBe(1_000);
    // a second beat in the same instant is refused by the cooldown
    expect(
      planInterjection(p, ["catPile"], {
        nowMs: 1_000,
        floor: 1,
        available: true,
      }).reason,
    ).toBe("cooldown");
  });

  it("gives run-state beats exactly one turn each per run", () => {
    const once = state({ fired: ["lastLife"] });
    expect(planInterjection(once, ["lastLife"], AVAILABLE)).toEqual({
      beat: null,
      reason: "repeat",
    });
  });

  it("gives per-floor beats one turn PER FLOOR", () => {
    expect(beatKey("bossLair", 3)).toBe("bossLair@3");
    expect(beatKey("descend", 2)).toBe("descend@2");
    const f3 = state({ fired: ["bossLair@3"] });
    expect(planInterjection(f3, ["bossLair"], AVAILABLE).beat).toBeNull();
    expect(
      planInterjection(f3, ["bossLair"], { ...AVAILABLE, floor: 4 }).beat,
    ).toBe("bossLair");
  });

  it("lets momentary spikes recur — they are governed by budget + cooldown", () => {
    for (const beat of [
      "ko",
      "catPile",
      "nearDeath",
      "finishingCrit",
    ] as const) {
      expect(beatKey(beat, 1)).toBeNull();
    }
    const after = state({ fired: ["ko"] });
    expect(planInterjection(after, ["ko"], AVAILABLE).beat).toBe("ko");
  });

  it("says nothing when nothing was offered", () => {
    expect(planInterjection(state(), [], AVAILABLE)).toEqual({
      beat: null,
      reason: "none",
    });
  });
});

/* ================================================================== */
/* 2. beat selection                                                   */
/* ================================================================== */

describe("beat selection — the loudest thing on the table wins", () => {
  it("prefers the boss lair over the wallet", () => {
    const d = planInterjection(
      state(),
      ["broke", "arriveNode", "bossLair", "benched"],
      AVAILABLE,
    );
    expect(d.beat).toBe("bossLair");
  });

  it("ranks every shipped beat, and the ranking is total", () => {
    const dramas = DM_BEATS.map((b) => BEAT_DRAMA[b]);
    expect(dramas).toHaveLength(DM_BEATS.length);
    expect(new Set(dramas).size).toBe(DM_BEATS.length);
    for (const d of dramas) expect(d).toBeGreaterThan(0);
    expect(Math.max(...dramas)).toBeLessThanOrEqual(1);
  });

  it("raises the bar as the budget is spent — late beats must be dramatic", () => {
    expect(dramaThreshold(0)).toBe(0);
    expect(dramaThreshold(INTERJECTION_BUDGET)).toBe(1);
    // 4 of 5 spent: only lastLife / bossLair clear the bar
    const late = state({ used: INTERJECTION_BUDGET - 1 });
    expect(planInterjection(late, ["arriveNode", "ko"], AVAILABLE)).toEqual({
      beat: null,
      reason: "undramatic",
    });
    expect(
      planInterjection(late, ["arriveNode", "lastLife"], AVAILABLE).beat,
    ).toBe("lastLife");
  });

  it("reads the dramatic run states off the run, not off a guess", () => {
    const base = run();
    expect(dramaticStateBeats(base)).toEqual([]);

    const lastLife: RunState = {
      ...base,
      cats: base.cats.map((c, i) => (i === 0 ? { ...c, lives: 1 } : c)),
    };
    expect(dramaticStateBeats(lastLife)).toContain("lastLife");

    const broke: RunState = {
      ...base,
      inventory: { ...base.inventory, shinies: 0 },
    };
    expect(dramaticStateBeats(broke)).toContain("broke");

    const benched: RunState = {
      ...base,
      cats: base.cats.map((c, i) => (i === 1 ? { ...c, lives: 0 } : c)),
    };
    expect(dramaticStateBeats(benched)).toContain("benched");
  });

  it("detects a descent exactly once, from the stamped floor", () => {
    let r = run(1);
    expect(didDescend(r)).toBe(false); // never looked before
    r = withPresenceFloor(r);
    expect(didDescend(r)).toBe(false);
    r = { ...r, floorNum: 2 };
    expect(didDescend(r)).toBe(true);
    r = withPresenceFloor(r);
    expect(didDescend(r)).toBe(false);
  });
});

/* ================================================================== */
/* 3. verdict validation and clamping                                  */
/* ================================================================== */

describe("interjection validation — defence in depth", () => {
  it("accepts a well-formed pure-narration beat", () => {
    const i = validateInterjection(payload(), 3, "bossLair");
    expect(i).not.toBeNull();
    expect(i!.beat).toBe("bossLair");
    expect(i!.kind).toBe("warning");
    expect(i!.effects).toEqual([]);
    expect(i!.applied).toBe(false);
    expect(i!.invite).toBe("Well? Do you answer it?");
  });

  it("rejects a payload that is not an interjection at all", () => {
    expect(validateInterjection(null, 3, "ko")).toBeNull();
    expect(validateInterjection("a line", 3, "ko")).toBeNull();
    expect(validateInterjection([1, 2], 3, "ko")).toBeNull();
    expect(
      validateInterjection(payload({ narration: "   " }), 3, "ko"),
    ).toBeNull();
    expect(validateInterjection({ kind: "gift" }, 3, "ko")).toBeNull();
  });

  it("clamps an unknown kind to plain narration rather than dropping the beat", () => {
    const i = validateInterjection(payload({ kind: "apocalypse" }), 3, "ko");
    expect(i!.kind).toBe("narration");
  });

  it("clamps narration and invite to their ceilings", () => {
    const i = validateInterjection(
      payload({ narration: "x".repeat(4000), invite: "y".repeat(400) }),
      3,
      "ko",
    );
    expect(i!.narration).toHaveLength(MAX_NARRATION);
    expect(i!.invite).toHaveLength(MAX_INVITE);
  });

  it("treats an empty invite as no invite", () => {
    expect(
      validateInterjection(payload({ invite: "" }), 3, "ko")!.invite,
    ).toBeNull();
    expect(
      validateInterjection(payload({ invite: null }), 3, "ko")!.invite,
    ).toBeNull();
  });

  it("lets a small, legal twist through", () => {
    const effects: Effect[] = [{ kind: "shinies", amount: 12 }];
    const i = validateInterjection(payload({ effects }), 3, "bossLair");
    expect(i!.applied).toBe(true);
    expect(i!.effects).toEqual(effects);
    expect(i!.problems).toEqual([]);
  });

  it("DEGRADES TO PURE NARRATION when the twist is over the floor cap", () => {
    // floor-3 shinies cap is 30 + 10*3 = 60
    const i = validateInterjection(
      payload({ effects: [{ kind: "shinies", amount: 5_000 }] }),
      3,
      "bossLair",
    );
    expect(i!.narration.length).toBeGreaterThan(0);
    expect(i!.applied).toBe(false);
    expect(i!.effects).toEqual([]);
    expect(i!.problems.length).toBeGreaterThan(0);
  });

  it("DEGRADES TO PURE NARRATION on an effect outside the union", () => {
    const i = validateInterjection(
      payload({ effects: [{ kind: "ascend", amount: 1 }] }),
      3,
      "ko",
    );
    expect(i!.applied).toBe(false);
    expect(i!.effects).toEqual([]);
  });

  it("never lets an interjection start a fight — that is the map's job", () => {
    const i = validateInterjection(
      payload({
        effects: [{ kind: "fight", encounter: ["ratThug"], onWinEffects: [] }],
      }),
      3,
      "bossLair",
    );
    expect(i!.applied).toBe(false);
    expect(i!.effects).toEqual([]);
  });

  it("draws its effect vocabulary from the SAME schema an answered line uses", () => {
    const schema = interjectionSchema() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "effects",
      "invite",
      "kind",
      "narration",
    ]);
    expect(schema.required).toContain("invite");
    // the effects member is lifted from encounterVerdictSchema, so it is the
    // events `Effect` union and nothing wider
    const effects = schema.properties.effects as {
      type: string;
      items: { anyOf: unknown[] };
    };
    expect(effects.type).toBe("array");
    expect(effects.items.anyOf.length).toBeGreaterThan(5);
  });
});

/* ================================================================== */
/* 4. transcript recording                                             */
/* ================================================================== */

const entry = (over: Partial<Interjection> = {}) => ({
  beat: "ko" as const,
  kind: "narration" as const,
  narration: "Down goes Baguette. Again.",
  invite: null,
  effects: [] as Effect[],
  applied: false,
  problems: [] as string[],
  floor: 2,
  nodeId: 3,
  delivered: true,
  ...over,
});

describe("the run log — replay never re-consults a model", () => {
  it("stamps monotonic seq numbers and zero rng draws", () => {
    let r = run();
    r = withInterjectionRecorded(r, entry());
    r = withInterjectionRecorded(r, entry({ narration: "And again." }));
    const log = presenceOf(r).log;
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
    expect(log.every((e) => e.rngDraws === 0)).toBe(true);
  });

  it("records the UNDELIVERED and the DROPPED ones too", () => {
    let r = run();
    r = withInterjectionRecorded(
      r,
      entry({ delivered: false, applied: false, problems: ["over cap"] }),
    );
    const [only] = presenceOf(r).log;
    expect(only.delivered).toBe(false);
    expect(only.problems).toEqual(["over cap"]);
  });

  it("bounds the ledger, dropping the OLDEST beats", () => {
    let r = run();
    for (let i = 0; i < MAX_INTERJECTION_LOG + 7; i++) {
      r = withInterjectionRecorded(r, entry({ narration: `beat ${i}` }));
    }
    const log = presenceOf(r).log;
    expect(log).toHaveLength(MAX_INTERJECTION_LOG);
    expect(log[log.length - 1].narration).toBe(
      `beat ${MAX_INTERJECTION_LOG + 6}`,
    );
  });

  it("records generated content with its styleVersion and provenance", () => {
    let r = run();
    r = withGeneratedRecord(r, {
      floor: 2,
      kind: "item",
      ref: "gmLintTrapCrown",
      styleVersion: 1,
      provenance: "dm:the party bribed the rat king",
      published: true,
    });
    const [rec] = presenceOf(r).generated;
    expect(rec).toMatchObject({
      seq: 1,
      ref: "gmLintTrapCrown",
      styleVersion: 1,
      published: true,
    });
    for (let i = 0; i < MAX_GENERATED_RECORDS + 3; i++) {
      r = withGeneratedRecord(r, {
        floor: 2,
        kind: "flavour",
        ref: `f${i}`,
        styleVersion: 1,
        provenance: "dm:x",
        published: true,
      });
    }
    expect(presenceOf(r).generated).toHaveLength(MAX_GENERATED_RECORDS);
  });

  it("queues what could not be rendered, and hands it over exactly once", () => {
    let r = run();
    const a: Interjection = {
      beat: "ko",
      kind: "narration",
      narration: "first",
      invite: null,
      effects: [],
      applied: false,
      problems: [],
    };
    r = withQueuedInterjection(r, a);
    r = withQueuedInterjection(r, { ...a, narration: "second" });
    const taken = takeQueuedInterjection(r);
    expect(taken!.interjection.narration).toBe("first");
    r = taken!.run;
    expect(presenceOf(r).queued).toHaveLength(1);
    r = takeQueuedInterjection(r)!.run;
    expect(takeQueuedInterjection(r)).toBeNull();
  });

  it("bounds the queue so an unattended tab cannot grow the save", () => {
    let r = run();
    for (let i = 0; i < MAX_QUEUED_INTERJECTIONS + 4; i++) {
      r = withQueuedInterjection(r, {
        beat: "ko",
        kind: "narration",
        narration: `q${i}`,
        invite: null,
        effects: [],
        applied: false,
        problems: [],
      });
    }
    expect(presenceOf(r).queued).toHaveLength(MAX_QUEUED_INTERJECTIONS);
  });

  it("survives the save round-trip, so a reloaded run is still replayable", () => {
    let r = run();
    r = withBeatSpent(r, "bossLair", 5_000);
    r = withInterjectionRecorded(r, entry({ narration: "the lair breathes" }));
    r = withQueuedInterjection(r, {
      beat: "catPile",
      kind: "offer",
      narration: "queued",
      invite: "well?",
      effects: [],
      applied: false,
      problems: [],
    });
    const storage = memoryStorage();
    saveRun(r, { storage });
    const back = loadRun({ storage }) as PresenceRun | null;
    const p = presenceOf(back);
    expect(p.used).toBe(1);
    expect(p.lastAtMs).toBe(5_000);
    expect(p.fired).toContain(`bossLair@${r.floorNum}`);
    expect(p.log[0].narration).toBe("the lair breathes");
    expect(p.queued[0].narration).toBe("queued");
  });

  it("reads a run that has never met a DM as an empty presence", () => {
    const p = presenceOf(run());
    expect(p).toEqual(emptyPresence());
    expect(presenceOf(null)).toEqual(emptyPresence());
  });

  it("never mutates the run it is handed", () => {
    const before = run();
    const snapshot = JSON.stringify(before.dmPresence ?? null);
    withBeatSpent(before, "ko", 1);
    withInterjectionRecorded(before, entry());
    withQueuedInterjection(before, {
      beat: "ko",
      kind: "narration",
      narration: "x",
      invite: null,
      effects: [],
      applied: false,
      problems: [],
    });
    expect(JSON.stringify(before.dmPresence ?? null)).toBe(snapshot);
  });
});

/* ================================================================== */
/* 5. offline ⇒ exactly zero DM surface                                */
/* ================================================================== */

describe("offline is silent, and the game reads as finished", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    setDmBaseUrl("");
    resetDmProbe();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setDmBaseUrl("");
    resetDmProbe();
  });

  it("never probes, never reports available, and never plans a beat", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(probeDm()).resolves.toBe(false);
    expect(isDmAvailable()).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    for (const beat of DM_BEATS) {
      expect(
        planInterjection(state(), [beat], { ...AVAILABLE, available: false }),
      ).toEqual({ beat: null, reason: "offline" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null from requestInterjection without touching the network", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await requestInterjection(run(), {
      beat: "bossLair",
      situation: "the lair yawns",
    });
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves the run byte-identical: no presence state is ever created", async () => {
    const r = run();
    const before = JSON.stringify(r);
    await requestInterjection(r, { beat: "ko", situation: "down she goes" });
    expect(JSON.stringify(r)).toBe(before);
    expect(r.dmPresence).toBeUndefined();
  });
});
