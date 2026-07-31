/**
 * The tabletop layer (docs/design/run-map-and-dm.md §3) — the pure parts.
 *
 * Four things are worth testing without a browser or a DM:
 *
 *  1. VERDICT VALIDATION — the client-side half of the defence in depth. A
 *     tampered, over-budget, out-of-union or unaffordable verdict must
 *     degrade to pure narration and never reach the engine.
 *  2. EFFECT CLAMPING — the floor ramp and the per-floor cap tables. They
 *     have exactly one home now (`services/caps.ts`), which both the browser
 *     and the agent import, so there is nothing left to drift.
 *  3. THE ENGINE PATH — `resolveAction({ type: 'improvise' })` really is an
 *     ordinary turn: turn-start phase, energy spent, effects executed by the
 *     Stand-power interpreter, zero RNG drawn.
 *  4. TRANSCRIPT RECORDING — every adjudication is logged, and the log
 *     survives the save round-trip so a reloaded run is still replayable.
 */
import { describe, expect, it } from "vitest";
import type {
  BattleSetup,
  BattleState,
  ClassId,
  Rng,
  RunState,
} from "../src/core/types.js";
import type { EffectSpec } from "../src/core/combat/powerTypes.js";
import { CLASSES } from "../src/content/classes.js";
import { createBattle } from "../src/core/combat/setup.js";
import { byId } from "../src/core/combat/state.js";
import { resolveAction } from "../src/core/combat/resolve.js";
import {
  BUDGET_CAPS,
  EFFECT_CAPS,
  improvisationScript,
  lintImprovisation,
} from "../src/core/combat/powers.js";
import { newRun, generateCurrentFloorMap } from "../src/core/run/runState.js";
import {
  deserializeRun,
  loadRun,
  memoryStorage,
  saveRun,
} from "../src/core/run/save.js";
import {
  EVENT_CAPS,
  MAX_ENERGY_COST,
  MAX_TRANSCRIPT_ENTRIES,
  canAffordImprovisation,
  emptyTabletopLog,
  floorDamageCap,
  floorHealCap,
  floorRamp,
  improvBudgetCap,
  improviseActionFor,
  isLiveTarget,
  recordAdjudication,
  tabletopLogOf,
  validateCombatVerdict,
  ENCOUNTER_EFFECT_KINDS,
  validateEncounterVerdict,
  withAdjudication,
  withDmSession,
  type TabletopRun,
} from "../src/services/tabletop.js";
import { probeDm, resetDmProbe, setDmBaseUrl } from "../src/services/dm.js";
// The agent's lint, to check the DM is briefed against the same budget the
// client enforces. The per-floor TABLES are no longer asserted for parity:
// `agent/lib/effects.ts` and `services/tabletop.ts` both re-export them from
// `services/caps.ts`, so there is nothing left that could drift.
import { lintImprovisedEffects } from "../agent/lib/effects.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

class ScriptedRng implements Rng {
  private i = 0;
  constructor(private rolls: number[] = []) {}
  float(): number {
    if (this.i >= this.rolls.length) {
      throw new Error(`ScriptedRng exhausted at draw ${this.i}`);
    }
    return this.rolls[this.i++];
  }
  int(lo: number, hi: number): number {
    const v = this.float();
    if (v < lo || v > hi) throw new Error("out of range");
    return v;
  }
  get used(): number {
    return this.i;
  }
}

const ORDER: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];

function l1Cats(): BattleSetup["cats"] {
  return ORDER.map((id) => {
    const cls = CLASSES[id];
    return {
      classId: id,
      name: cls.catName,
      stats: { ...cls.base },
      hp: cls.base.hp,
      lives: 9,
      skills: cls.skills
        .filter((s) => s.unlockLevel <= 1)
        .map((s) => s.skillId),
      traits: [],
      hooks: [],
      startEnergyBonus: 0,
    };
  });
}

/** A battle with a frozen queue so the improvising cat acts first. */
function makeBattle(actorId = "cat:bruiser"): BattleState {
  const bs = createBattle({
    cats: l1Cats(),
    enemies: ["ratThug", "ratThug"],
    encounterIndex: 1,
    canFlee: true,
  });
  bs.round = 1;
  bs.queue = [
    { combatantId: actorId, initiative: 9, acted: false },
    ...bs.combatants
      .filter((c) => c.id !== actorId)
      .map((c) => ({ combatantId: c.id, initiative: 1, acted: false })),
  ];
  bs.queueIndex = 0;
  return bs;
}

const verdict = (over: Partial<Record<string, unknown>> = {}) => ({
  allowed: true,
  narration: "The lantern shatters across the slick and the alley goes gold.",
  effects: [{ kind: "damage", target: "other", pct: 40 }],
  energyCost: 3,
  target: "e0:ratThug",
  ...over,
});

/* ================================================================== */
/* 1. One cap table, briefed and enforced from the same numbers        */
/* ================================================================== */

describe("per-floor caps", () => {
  it("the client lint agrees with the lint the DM self-corrects against", () => {
    const effects: EffectSpec[] = [
      { kind: "damage", target: "other", pct: 60 },
      { kind: "status", target: "other", status: "offBalance" },
    ];
    for (let f = 1; f <= 6; f++) {
      const server = lintImprovisedEffects(effects, f);
      const client = lintImprovisation(effects, improvBudgetCap(f));
      expect(client.budget).toBeCloseTo(server.budget, 9);
      // (the server also layers the floor damage/heal ramp, which
      // validateCombatVerdict re-applies — asserted in its own block)
      expect(client.ok).toBe(server.problems.length === 0 || client.ok);
    }
  });

  it("floor 1 improvisation is 3/8 of a Stand power, floor 6 exactly one", () => {
    expect(floorRamp(1)).toBeCloseTo(3 / 8, 9);
    expect(floorRamp(6)).toBe(1);
    expect(improvBudgetCap(1)).toBeCloseTo(BUDGET_CAPS.cat * (3 / 8), 9);
    expect(improvBudgetCap(6)).toBe(BUDGET_CAPS.cat);
    expect(floorDamageCap(6)).toBe(EFFECT_CAPS.damagePct);
    expect(floorHealCap(6)).toBe(EFFECT_CAPS.healPct);
  });
});

/* ================================================================== */
/* 2. Verdict validation + effect clamping                             */
/* ================================================================== */

describe("validateCombatVerdict — defence in depth", () => {
  it("accepts a legal verdict and hands the effects on", () => {
    const check = validateCombatVerdict(verdict(), 6);
    expect(check.applied).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.verdict?.effects).toHaveLength(1);
    expect(check.verdict?.energyCost).toBe(3);
  });

  it("treats a refusal as a VALID verdict with no mechanics", () => {
    const check = validateCombatVerdict(
      verdict({ allowed: false, narration: "You cannot fly. You are a cat." }),
      3,
    );
    expect(check.verdict).not.toBeNull();
    expect(check.verdict?.allowed).toBe(false);
    expect(check.verdict?.effects).toEqual([]);
    expect(check.verdict?.energyCost).toBe(0);
    expect(check.applied).toBe(false);
    expect(check.problems).toEqual([]); // a refusal is not a failure
  });

  it("degrades an over-budget verdict to pure narration", () => {
    const check = validateCombatVerdict(
      verdict({
        effects: [
          { kind: "damage", target: "enemies", pct: 150 },
          { kind: "status", target: "enemies", status: "frazzled" },
        ],
      }),
      6,
    );
    expect(check.applied).toBe(false);
    expect(check.problems.length).toBeGreaterThan(0);
    expect(check.verdict?.narration.length).toBeGreaterThan(0);
    expect(check.verdict?.effects).toEqual([]);
  });

  it("the floor ramp tightens what is legal: floor 6 yes, floor 1 no", () => {
    const big = verdict({
      effects: [{ kind: "damage", target: "other", pct: 60 }],
      energyCost: 6,
    });
    // 60% is a full-price cat power: legal on floor 6, far past floor 1's
    // 3/8 share of the same budget.
    expect(validateCombatVerdict(big, 6).applied).toBe(true);
    const shallow = validateCombatVerdict(big, 1);
    expect(shallow.applied).toBe(false);
    expect(shallow.problems.join(" ")).toMatch(/exceeds cap/);
    expect(floorDamageCap(1)).toBeLessThan(floorDamageCap(6));
  });

  it("rejects effects outside the engine's closed union", () => {
    const check = validateCombatVerdict(
      verdict({ effects: [{ kind: "explode", target: "enemies", pct: 10 }] }),
      6,
    );
    expect(check.applied).toBe(false);
    expect(check.problems).toContain("effect outside the union");
  });

  it("rejects more than three effects", () => {
    const one = { kind: "status", target: "self", status: "guarded" };
    const check = validateCombatVerdict(
      verdict({ effects: [one, one, one, one] }),
      6,
    );
    expect(check.applied).toBe(false);
    expect(check.problems).toContain("more than 3 effects");
  });

  it("clamps a silly energy cost instead of rejecting the verdict", () => {
    expect(
      validateCombatVerdict(verdict({ energyCost: 99 }), 6).verdict,
    ).toMatchObject({ energyCost: MAX_ENERGY_COST });
    expect(
      validateCombatVerdict(verdict({ energyCost: -4 }), 6).verdict?.energyCost,
    ).toBe(0);
    expect(
      validateCombatVerdict(verdict({ energyCost: "three" }), 6).verdict
        ?.energyCost,
    ).toBe(0);
  });

  it("returns no verdict at all for a non-verdict", () => {
    for (const junk of [null, 42, "ok", {}, { allowed: true }, []]) {
      expect(validateCombatVerdict(junk, 3).verdict).toBeNull();
    }
  });

  it("truncates an over-long narration rather than dropping the beat", () => {
    const check = validateCombatVerdict(
      verdict({ narration: "a".repeat(900) }),
      6,
    );
    expect(check.verdict?.narration).toHaveLength(400);
  });

  it("an allowed verdict with no effects is a flourish, not a failure", () => {
    const check = validateCombatVerdict(verdict({ effects: [] }), 6);
    expect(check.verdict?.allowed).toBe(true);
    expect(check.applied).toBe(false);
    expect(check.problems).toEqual([]);
  });
});

describe("verdict → engine action", () => {
  it("carries the floor-ramped budget cap and drops a null target", () => {
    const v = validateCombatVerdict(verdict({ target: null }), 4).verdict!;
    const action = improviseActionFor(v, 4);
    expect(action.type).toBe("improvise");
    expect(action.budgetCap).toBe(improvBudgetCap(4));
    expect(action.targetId).toBeUndefined();
    expect(action.narration).toBe(v.narration);
  });

  it("knows an unaffordable verdict and a dead target", () => {
    const bs = makeBattle();
    const actor = byId(bs, "cat:bruiser");
    actor.energy = 1;
    const v = validateCombatVerdict(verdict({ energyCost: 5 }), 6).verdict!;
    expect(canAffordImprovisation(bs, "cat:bruiser", v)).toBe(false);
    expect(isLiveTarget(bs, "e0:ratThug")).toBe(true);
    expect(isLiveTarget(bs, "e9:nobody")).toBe(false);
    expect(isLiveTarget(bs, null)).toBe(false);
    byId(bs, "e0:ratThug").ko = true;
    expect(isLiveTarget(bs, "e0:ratThug")).toBe(false);
  });
});

describe("validateEncounterVerdict — the out-of-combat vocabulary", () => {
  it("accepts a bounded event effect", () => {
    const check = validateEncounterVerdict(
      {
        allowed: true,
        narration: "The grate gives, and something glitters underneath.",
        effects: [{ kind: "shinies", amount: 20 }],
      },
      2,
    );
    expect(check.applied).toBe(true);
    expect(check.verdict?.effects).toHaveLength(1);
  });

  it("rejects a payout above the floor's shinies cap", () => {
    const check = validateEncounterVerdict(
      {
        allowed: true,
        narration: "A hoard!",
        effects: [{ kind: "shinies", amount: EVENT_CAPS.shiniesMax(1) + 1 }],
      },
      1,
    );
    expect(check.applied).toBe(false);
    expect(check.verdict?.effects).toEqual([]);
  });

  it("never lets the DM start a fight from a typed line", () => {
    const check = validateEncounterVerdict(
      {
        allowed: true,
        narration: "Rats pour out of the dark.",
        effects: [{ kind: "fight", encounter: ["ratThug"], loot: "normal" }],
      },
      3,
    );
    expect(check.applied).toBe(false);
    expect(check.problems).toContain("fight is not an improvisable effect");
  });

  it("rejects an effect the shipped event validator would reject", () => {
    const check = validateEncounterVerdict(
      {
        allowed: true,
        narration: "You are handed a thing that does not exist.",
        effects: [{ kind: "giveItem", item: "notAnItemId" }],
      },
      3,
    );
    expect(check.applied).toBe(false);
    expect(check.problems.length).toBeGreaterThan(0);
  });

  it("carries a refusal through as an answer", () => {
    const check = validateEncounterVerdict(
      {
        allowed: false,
        narration: "The elder stray just stares at you.",
        effects: [],
      },
      1,
    );
    expect(check.verdict?.allowed).toBe(false);
    expect(check.applied).toBe(false);
    expect(check.problems).toEqual([]);
  });

  /* -- the closed union ------------------------------------------------ */
  //
  // `validateEvents` only inspects the kinds it recognises: it has no opinion
  // on one it has never heard of, so a made-up `kind` used to pass the
  // structural gate untouched and reach `resolveOption` as an unhandled
  // branch. Defence in depth means unknown is REJECTED, not ignored.

  it("rejects an effect kind outside the engine's union", () => {
    const check = validateEncounterVerdict(
      {
        allowed: true,
        narration: "The DM invents a new rule.",
        effects: [{ kind: "grantOmnipotence", target: "party", amount: 1 }],
      },
      3,
    );
    expect(check.applied).toBe(false);
    expect(check.verdict?.effects).toEqual([]);
    expect(check.problems).toContain("effect kind outside the engine's union");
  });

  it("rejects a batch where only ONE effect is off-union", () => {
    const check = validateEncounterVerdict(
      {
        allowed: true,
        narration: "Two coins and a miracle.",
        effects: [
          { kind: "shinies", amount: 10 },
          { kind: "ascend", amount: 1 },
        ],
      },
      2,
    );
    expect(check.applied).toBe(false);
    expect(check.verdict?.effects).toEqual([]);
  });

  it("rejects an effect with no `kind` at all", () => {
    const check = validateEncounterVerdict(
      { allowed: true, narration: "Something.", effects: [{ amount: 3 }] },
      2,
    );
    expect(check.applied).toBe(false);
  });

  it("the declared union is exactly the shipped one", () => {
    // If core/types.ts gains an Effect kind, this list and the per-kind cap
    // switch in validateEncounterVerdict both have to learn about it.
    expect([...ENCOUNTER_EFFECT_KINDS].sort()).toEqual(
      [
        "buff",
        "damage",
        "energyNextBattle",
        "fight",
        "giveItem",
        "heal",
        "nothing",
        "restoreLife",
        "shinies",
        "takeItem",
      ].sort(),
    );
  });
});

/* ================================================================== */
/* 3. The engine really executes it as an ordinary turn                */
/* ================================================================== */

describe("resolveAction({ type: 'improvise' })", () => {
  it("spends energy, executes the effects, and draws NO rng", () => {
    const bs = makeBattle();
    byId(bs, "cat:bruiser").energy = 6;
    const before = byId(bs, "e0:ratThug").hp;
    const rng = new ScriptedRng([]); // any draw throws
    const v = validateCombatVerdict(verdict(), 6).verdict!;
    const r = resolveAction(bs, improviseActionFor(v, 6), rng);
    expect(rng.used).toBe(0);
    expect(byId(r.state, "e0:ratThug").hp).toBeLessThan(before);
    expect(byId(r.state, "cat:bruiser").energy).toBe(6 + 2 - 3); // regen, cost
    expect(r.events.some((e) => e.t === "log" && e.text === v.narration)).toBe(
      true,
    );
    expect(r.events.some((e) => e.t === "damage")).toBe(true);
    // the queue slot is consumed, exactly like any other action
    expect(r.state.queue[0].acted).toBe(true);
  });

  it("does not mutate the state it was given", () => {
    const bs = makeBattle();
    byId(bs, "cat:bruiser").energy = 6;
    const before = byId(bs, "e0:ratThug").hp;
    const v = validateCombatVerdict(verdict(), 6).verdict!;
    resolveAction(bs, improviseActionFor(v, 6), new ScriptedRng([]));
    expect(byId(bs, "e0:ratThug").hp).toBe(before);
  });

  it("drops a tampered over-budget list ENGINE-side and keeps the narration", () => {
    const bs = makeBattle();
    byId(bs, "cat:bruiser").energy = 6;
    const before = byId(bs, "e0:ratThug").hp;
    // straight past the client lint, as a tampered response would be
    const r = resolveAction(
      bs,
      {
        type: "improvise",
        effects: [{ kind: "damage", target: "enemies", pct: 150 }],
        energyCost: 1,
        targetId: "e0:ratThug",
        narration: "the alley folds in half",
        budgetCap: improvBudgetCap(1),
      },
      new ScriptedRng([]),
    );
    expect(byId(r.state, "e0:ratThug").hp).toBe(before);
    expect(byId(r.state, "cat:bruiser").energy).toBe(6 + 2); // nothing spent
    expect(
      r.events.some(
        (e) => e.t === "log" && e.text === "the alley folds in half",
      ),
    ).toBe(true);
  });

  it("prices the improvisation exactly as a Stand power", () => {
    const effects: EffectSpec[] = [{ kind: "heal", target: "allies", pct: 30 }];
    const script = improvisationScript(effects);
    expect(script.trigger).toBe("activated");
    expect(script.conditions).toEqual([]);
    expect(lintImprovisation(effects, BUDGET_CAPS.cat).budget).toBe(
      script.budget,
    );
    // whatever cap is asked for, a cat power's cap is the ceiling
    expect(lintImprovisation(effects, 999).cap).toBe(BUDGET_CAPS.cat);
  });
});

/* ================================================================== */
/* 4. The transcript                                                   */
/* ================================================================== */

const draft = (prompt: string) => ({
  where: "combat" as const,
  floor: 2,
  nodeId: 3,
  prompt,
  narration: "so it goes",
  allowed: true,
  effects: [] as EffectSpec[],
  applied: false,
  problems: [],
});

describe("transcript recording", () => {
  it("stamps a monotonic seq and zero rng draws", () => {
    let log = emptyTabletopLog();
    log = recordAdjudication(log, draft("one"));
    log = recordAdjudication(log, draft("two"));
    expect(log.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(log.entries.map((e) => e.prompt)).toEqual(["one", "two"]);
    expect(log.entries.every((e) => e.rngDraws === 0)).toBe(true);
  });

  it("is pure — the input log is never touched", () => {
    const log = emptyTabletopLog();
    const next = recordAdjudication(log, draft("one"));
    expect(log.entries).toHaveLength(0);
    expect(next.entries).toHaveLength(1);
  });

  it("keeps the newest entries when a run runs long", () => {
    let log = emptyTabletopLog();
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 5; i++) {
      log = recordAdjudication(log, draft(`beat ${i}`));
    }
    expect(log.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(log.entries[0].prompt).toBe("beat 5");
    expect(log.entries.at(-1)?.seq).toBe(MAX_TRANSCRIPT_ENTRIES + 5);
  });

  it("records refusals and dropped verdicts, not just applied ones", () => {
    let log = emptyTabletopLog();
    log = recordAdjudication(log, {
      ...draft("i fly up to the rafters"),
      narration: "You cannot fly. You are a cat.",
      allowed: false,
    });
    log = recordAdjudication(log, {
      ...draft("i delete the boss"),
      allowed: true,
      applied: false,
      problems: ["budget 40 exceeds cap 12"],
    });
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0].allowed).toBe(false);
    expect(log.entries[1].problems).toHaveLength(1);
  });

  it("rides the run and survives the save round-trip", () => {
    const storage = memoryStorage();
    let run: TabletopRun = generateCurrentFloorMap(newRun("seed-tabletop"));
    run = withDmSession(run, {
      sessionId: "ses_01",
      continuationToken: "eve:abc",
      streamIndex: 7,
    });
    run = withAdjudication(run, draft("pry the grate open"));
    run = withAdjudication(run, draft("bribe the rat king"));

    saveRun(run, { storage });
    const loaded = loadRun({ storage }) as TabletopRun | null;
    expect(loaded).not.toBeNull();
    expect(tabletopLogOf(loaded).entries.map((e) => e.prompt)).toEqual([
      "pry the grate open",
      "bribe the rat king",
    ]);
    // a reload rejoins the SAME durable session, with its cursor
    expect(loaded?.dm).toEqual({
      sessionId: "ses_01",
      continuationToken: "eve:abc",
      streamIndex: 7,
    });
  });

  it("a run saved before the tabletop layer loads with an empty log", () => {
    const storage = memoryStorage();
    const plain: RunState = generateCurrentFloorMap(newRun("seed-legacy"));
    saveRun(plain, { storage });
    const loaded = loadRun({ storage }) as TabletopRun | null;
    expect(loaded?.tabletop).toBeUndefined();
    expect(tabletopLogOf(loaded).entries).toEqual([]);
    expect(loaded?.dm).toBeUndefined();
  });

  it("deserializes a hand-written save carrying a transcript", () => {
    const run: TabletopRun = withAdjudication(
      generateCurrentFloorMap(newRun("seed-3")),
      draft("look under the fridge"),
    );
    const sf = JSON.parse(
      JSON.stringify({ version: 3, run: { ...run, floorMap: undefined } }),
    ) as Parameters<typeof deserializeRun>[0];
    const back = deserializeRun(sf) as TabletopRun;
    expect(back.tabletop?.entries[0].prompt).toBe("look under the fridge");
  });
});

/* ================================================================== */
/* 5. Offline-first                                                    */
/* ================================================================== */

describe("offline-first", () => {
  it("probes false WITHOUT a request when no DM is configured", async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called += 1;
      return Promise.reject(new Error("no network in tests"));
    }) as typeof fetch;
    try {
      setDmBaseUrl("");
      resetDmProbe();
      await expect(probeDm()).resolves.toBe(false);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = original;
      resetDmProbe();
    }
  });

  it("caches the probe verdict for the rest of the session", async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called += 1;
      return Promise.reject(new Error("dm is down"));
    }) as typeof fetch;
    try {
      setDmBaseUrl("https://dm.example");
      resetDmProbe();
      await expect(probeDm()).resolves.toBe(false);
      await expect(probeDm()).resolves.toBe(false);
      await expect(probeDm()).resolves.toBe(false);
      expect(called).toBe(1);
    } finally {
      globalThis.fetch = original;
      setDmBaseUrl("");
      resetDmProbe();
    }
  });
});
