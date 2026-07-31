/**
 * GM service scaffold tests (docs/design/gm-system.md):
 *  - pure constraint lints (party budgets, event caps, item hooks, steer
 *    bounds) from api/_lib/constraints;
 *  - pool-first probability + MemoryPool behavior;
 *  - generateValidated's one regenerate-on-invalid retry;
 *  - a local smoke of the /api/gm/party endpoint logic with a MOCKED
 *    Anthropic client (no real API call).
 */
import { describe, expect, it } from "vitest";
import type { GameEvent, Skill } from "../src/core/types";
import type {
  GeneratedCatKit,
  GeneratedEquip,
  GmRole,
  GmSteerNudges,
  InteractionRule,
  PowerScript,
  StoredInteraction,
} from "../src/services/gmTypes";
import {
  EVENT_CAPS,
  lintEvent,
  lintEventCaps,
  lintItem,
  lintParty,
  lintSteer,
  ROLE_STAT_TOTALS,
} from "../api/_lib/constraints";
import { MemoryPool, poolPickProbability } from "../api/_lib/pool";
import {
  GmGenerationError,
  generateValidated,
  type StructuredGenClient,
} from "../api/_lib/generate";
import {
  BUDGET_CAPS,
  lintInteractionRule,
  lintPowerScript,
  normalizePower,
  POWER_FRAMEWORK_VERSION,
  powerBudget,
  resonancePairKey,
  STOCK_POWERS,
} from "../api/_lib/powers";
import { ART_STYLE } from "../src/content/artStyle";
import { resonancePairKey as clientPairKey } from "../src/services/gm";
import { createPartyHandler } from "../api/gm/party";
import { createResonanceHandler } from "../api/gm/resonance";
import {
  createEventResolveHandler,
  lintResolvePayload,
} from "../api/gm/eventResolve";
import type { BattleSetup, ClassId, Effect } from "../src/core/types";
import type {
  PoweredBattleSetup,
  PoweredBattleState,
} from "../src/core/combat/powerTypes";
import { CLASSES } from "../src/content/classes";
import { createBattle } from "../src/core/combat/setup";
import { startRound } from "../src/core/combat/turns";
import { mulberry32 } from "../src/core/rng";

/* ------------------------------------------------------------------------ */
/* fixtures                                                                  */
/* ------------------------------------------------------------------------ */

function basicSkill(id: string): Skill {
  return {
    id,
    name: "Swipe",
    desc: "A quick rake.",
    cost: 0,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power: 100,
    kind: "damage",
    energyGain: 1,
  };
}

function costedSkill(id: string, cost: number, power: number): Skill {
  return {
    id,
    name: id,
    desc: "d",
    cost,
    usableFrom: [1, 2],
    target: { side: "enemy", ranks: [1, 2], pattern: "single" },
    power,
    kind: "damage",
  };
}

const ROLE_BASES: Record<GmRole, GeneratedCatKit["base"]> = {
  tank: { hp: 40, atk: 10, def: 3, spd: 4, crt: 5, enMax: 10 },
  striker: { hp: 28, atk: 12, def: 1, spd: 8, crt: 15, enMax: 10 },
  control: { hp: 24, atk: 11, def: 0, spd: 6, crt: 5, enMax: 10 },
  support: { hp: 26, atk: 9, def: 1, spd: 5, crt: 5, enMax: 10 },
};

function makePower(role: GmRole): PowerScript {
  return normalizePower({
    id: `power:${role}TestPower`,
    version: POWER_FRAMEWORK_VERSION,
    name: "THE EXAMPLE HAND",
    flavor: "A spectral paw descends.",
    trigger: "onCrit",
    conditions: [],
    effects: [{ kind: "energy", target: "self", amount: 1 }],
  });
}

function makeKit(role: GmRole, name: string): GeneratedCatKit {
  return {
    role,
    catName: name,
    className: "Test Class",
    epithet: "The Tested",
    base: { ...ROLE_BASES[role] },
    growth: Array.from({ length: 7 }, () => ({ hp: 2, atk: 1 })),
    skills: [
      basicSkill(`${role}Basic`),
      costedSkill(`${role}Alpha`, 4, 120),
      costedSkill(`${role}Beta`, 2, 60),
      costedSkill(`${role}Gamma`, 6, 150),
    ],
    trait: { name: "Test Trait", desc: "Does test things." },
    stand: {
      name: "THE EXAMPLE",
      visualPrompt:
        "a scarred orange tomcat mid-pounce, spectral boxer looming",
    },
    power: makePower(role),
    flavor: {
      bio: "A cat.",
      barks: { crit: "!", ko: "...", catPile: "PILE" },
    },
  };
}

function makeParty(): GeneratedCatKit[] {
  return [
    makeKit("tank", "Slab"),
    makeKit("striker", "Zip"),
    makeKit("control", "Umbra"),
    makeKit("support", "Crumb"),
  ];
}

function makeEvent(overrides: Partial<GameEvent> = {}): GameEvent {
  return {
    id: "gmTestOmen",
    title: "A Suspicious Sock",
    prompt: "The sock stares back.",
    weight: 10,
    floors: [1, 3],
    options: [
      {
        label: "Poke it",
        outcomes: [
          {
            weight: 1,
            text: "Shinies fall out.",
            effects: [{ kind: "shinies", amount: 10 }],
          },
        ],
      },
      {
        label: "Walk away",
        outcomes: [
          { weight: 1, text: "You leave.", effects: [{ kind: "nothing" }] },
        ],
      },
    ],
    ...overrides,
  };
}

function makeEquip(overrides: Partial<GeneratedEquip> = {}): GeneratedEquip {
  return {
    id: "gmYarnCleaver",
    name: "Yarn Cleaver",
    icon: "⚔",
    slot: "weapon",
    classId: "bruiser",
    primary: "atk",
    secondaryPool: ["hp", "spd"],
    iconPrompt: "a cleaver made of yarn, bold ink, flat #1a1626 background",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* party constraints                                                         */
/* ------------------------------------------------------------------------ */

describe("lintParty (classes.md budgets)", () => {
  it("accepts a canonical-budget party", () => {
    expect(lintParty(makeParty())).toEqual([]);
  });

  it("rejects a wrong stat total for the role", () => {
    const party = makeParty();
    party[0].base.atk += 1; // tank total 63 != 62
    const errors = lintParty(party);
    expect(errors.join("\n")).toMatch(
      `stat total 63 != ${ROLE_STAT_TOTALS.tank}`,
    );
  });

  it("rejects a party that misses a role", () => {
    const party = makeParty();
    party[3] = makeKit("tank", "Slab II");
    expect(lintParty(party).join("\n")).toMatch("missing the 'support' role");
  });

  it("rejects enMax != 10 and out-of-bounds stats", () => {
    const party = makeParty();
    party[1].base.enMax = 12;
    party[1].base.crt = 40;
    const errors = lintParty(party).join("\n");
    expect(errors).toMatch("enMax must be exactly 10");
    expect(errors).toMatch("crt=40 outside 5..15");
  });

  it("rejects kits without exactly one cost-0 basic", () => {
    const party = makeParty();
    party[2].skills[0] = costedSkill("noBasic", 3, 100);
    expect(lintParty(party).join("\n")).toMatch(
      "exactly one cost-0 basic (has 0)",
    );
  });

  it("rejects skill budget overruns (cost, count, power)", () => {
    const party = makeParty();
    party[0].skills[1] = costedSkill("tooExpensive", 7, 120);
    party[1].skills.push(costedSkill("fifth", 1, 50));
    party[2].skills[3] = costedSkill("nuke", 6, 200);
    const errors = lintParty(party).join("\n");
    expect(errors).toMatch("cost must be an integer 0..6");
    expect(errors).toMatch("exactly 4 skills");
    expect(errors).toMatch("damage power above 150");
  });

  it("rejects malformed growth", () => {
    const party = makeParty();
    party[3].growth = Array.from({ length: 6 }, () => ({ hp: 2 }));
    expect(lintParty(party).join("\n")).toMatch("exactly 7 rows");
    party[3].growth = Array.from({ length: 7 }, () => ({ enMax: 1 }));
    expect(lintParty(party).join("\n")).toMatch("illegal key 'enMax'");
  });
});

/* ------------------------------------------------------------------------ */
/* event constraints                                                         */
/* ------------------------------------------------------------------------ */

describe("lintEvent (core validator + per-floor caps)", () => {
  it("accepts a valid gm event", () => {
    expect(lintEvent(makeEvent())).toEqual([]);
  });

  it("rejects ids without the gm prefix", () => {
    const errors = lintEventCaps(makeEvent({ id: "suspiciousSock" }));
    expect(errors.join("\n")).toMatch("gm prefix");
  });

  it("rejects damage above the per-floor cap", () => {
    const ev = makeEvent();
    ev.options[0].outcomes[0].effects = [
      { kind: "damage", target: "random", amount: { base: 50, perFloor: 0 } },
    ];
    const errors = lintEventCaps(ev).join("\n");
    expect(errors).toMatch(`above cap ${EVENT_CAPS.damageMax(1)} on floor 1`);
  });

  it("rejects unknown enemy ids via the shipped validator", () => {
    const ev = makeEvent();
    ev.options[0].outcomes[0].effects = [
      { kind: "fight", encounter: ["notARealEnemy"], loot: "normal" },
    ];
    expect(lintEvent(ev).join("\n")).toMatch("unknown enemy id");
  });

  it("rejects events without a walk-away option", () => {
    const ev = makeEvent();
    for (const opt of ev.options) {
      opt.outcomes[0].effects = [
        { kind: "damage", target: "party", amount: 2 },
      ];
    }
    expect(lintEvent(ev).join("\n")).toMatch("walk-away");
  });
});

/* ------------------------------------------------------------------------ */
/* item constraints                                                          */
/* ------------------------------------------------------------------------ */

describe("lintItem (loot.md shapes, existing hook menu)", () => {
  it("accepts a valid non-mewthical equip", () => {
    expect(lintItem(makeEquip(), "sleek")).toEqual([]);
  });

  it("accepts a mewthical equip with a menu hook", () => {
    const equip = makeEquip({
      uniqueId: "ninthBell",
      uniqueName: "The Ninth Bell of Crumb",
    });
    expect(lintItem(equip, "mewthical")).toEqual([]);
  });

  it("rejects mewthical items without a hook from the menu", () => {
    expect(lintItem(makeEquip(), "mewthical").join("\n")).toMatch(
      "uniqueId from the existing hook menu",
    );
  });

  it("rejects hooks on non-mewthical items", () => {
    const equip = makeEquip({ uniqueId: "catPileDouble", uniqueName: "X" });
    expect(lintItem(equip, "pedigree").join("\n")).toMatch(
      "only mewthical items may carry a hook",
    );
  });

  it("rejects id collisions with shipped equipment", () => {
    const equip = makeEquip({ id: "mittsOfMenace" });
    expect(lintItem(equip, "sleek").join("\n")).toMatch(
      "collides with a shipped equip def",
    );
  });

  it("rejects duplicate secondary stats", () => {
    const equip = makeEquip({ secondaryPool: ["hp", "hp"] });
    expect(lintItem(equip, "sleek").join("\n")).toMatch("2 distinct stat keys");
  });
});

/* ------------------------------------------------------------------------ */
/* steer constraints                                                         */
/* ------------------------------------------------------------------------ */

describe("lintSteer (bounded nudge menu)", () => {
  const ok: GmSteerNudges = {
    encounterBudgetDelta: 1,
    shopBias: "consumables",
    nextEventTheme: "laundromat dread",
    floorIntro: "THE BASEMENT BREATHES. Somewhere, a dryer starts by itself.",
  };

  it("accepts valid nudges", () => {
    expect(lintSteer(ok)).toEqual([]);
  });

  it("rejects out-of-menu values", () => {
    const bad = {
      ...ok,
      encounterBudgetDelta: 2,
      shopBias: "weapons",
      nextEventTheme: "x".repeat(61),
    } as unknown as GmSteerNudges;
    const errors = lintSteer(bad).join("\n");
    expect(errors).toMatch("encounterBudgetDelta");
    expect(errors).toMatch("shopBias");
    expect(errors).toMatch("nextEventTheme");
  });
});

/* ------------------------------------------------------------------------ */
/* pool                                                                      */
/* ------------------------------------------------------------------------ */

describe("shared content pool", () => {
  it("pool-first probability is min(0.7, size/200)", () => {
    expect(poolPickProbability(0)).toBe(0);
    expect(poolPickProbability(100)).toBe(0.5);
    expect(poolPickProbability(200)).toBe(0.7);
    expect(poolPickProbability(10_000)).toBe(0.7);
  });

  it("MemoryPool add/size/sample", async () => {
    const pool = new MemoryPool();
    expect(await pool.size("events")).toBe(0);
    expect(await pool.sample("events")).toBeNull();
    await pool.add("events", '{"a":1}');
    await pool.add("events", '{"b":2}');
    expect(await pool.size("events")).toBe(2);
    expect(await pool.size("items")).toBe(0);
    const got = await pool.sample("events");
    expect(['{"a":1}', '{"b":2}']).toContain(got);
  });
});

/* ------------------------------------------------------------------------ */
/* generation pipeline + party endpoint smoke (mocked Anthropic client)      */
/* ------------------------------------------------------------------------ */

class FakeGen implements StructuredGenClient {
  calls: { model: string; messages: { role: string; content: string }[] }[] =
    [];

  constructor(private readonly outputs: string[]) {}

  generate(opts: {
    model: string;
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    schema: Record<string, unknown>;
  }): Promise<string> {
    this.calls.push({ model: opts.model, messages: opts.messages });
    const i = Math.min(this.calls.length - 1, this.outputs.length - 1);
    return Promise.resolve(this.outputs[i]);
  }
}

function partyRequest(body: unknown): Request {
  return new Request("http://localhost/api/gm/party", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // node's undici requires duplex when a body is present
    ...({ duplex: "half" } as object),
  });
}

describe("POST /api/gm/party (mocked client)", () => {
  const validJson = JSON.stringify({ kits: makeParty() });

  it("returns 4 linted kits and writes them to the stands pool", async () => {
    const gen = new FakeGen([validJson]);
    const pool = new MemoryPool();
    const handler = createPartyHandler({ gen, pool });

    const res = await handler(
      partyRequest({ descriptions: ["a paranoid sphynx with static powers"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kits: GeneratedCatKit[];
      source: string;
    };
    expect(body.source).toBe("generated");
    expect(body.kits).toHaveLength(4);
    expect(new Set(body.kits.map((k) => k.role)).size).toBe(4);
    expect(gen.calls).toHaveLength(1);
    expect(await pool.size("stands")).toBe(1);
    // visualPrompts are composed from the style contract, never ad-hoc:
    for (const kit of body.kits) {
      expect(kit.stand.visualPrompt).toContain(ART_STYLE.basePrompt);
      expect(kit.stand.visualPrompt).toContain(ART_STYLE.framing.battleSprite);
      // budgets are server-stamped
      expect(kit.power.budget).toBe(powerBudget(kit.power));
    }
  });

  it("falls back to a stock power when a power fails the lint twice", async () => {
    const broken = makeParty();
    broken[1].power = {
      ...makePower("striker"),
      effects: [{ kind: "damage", target: "enemies", pct: 999 }],
    };
    const bad = JSON.stringify({ kits: broken });
    const gen = new FakeGen([bad, bad]);
    const handler = createPartyHandler({ gen, pool: new MemoryPool() });

    const res = await handler(partyRequest({ descriptions: ["a cat"] }));
    expect(res.status).toBe(200);
    expect(gen.calls).toHaveLength(2); // one regenerate happened first
    const body = (await res.json()) as { kits: GeneratedCatKit[] };
    expect(body.kits[1].power.id).toBe(STOCK_POWERS.striker.id);
    // the valid powers of the other kits are kept, not replaced
    expect(body.kits[0].power.id).toBe("power:tankTestPower");
  });

  it("regenerates ONCE when the first output fails the lint", async () => {
    const broken = makeParty();
    broken[0].base.atk += 3; // busts the tank stat total
    const gen = new FakeGen([JSON.stringify({ kits: broken }), validJson]);
    const handler = createPartyHandler({ gen, pool: new MemoryPool() });

    const res = await handler(partyRequest({ descriptions: ["a cat"] }));
    expect(res.status).toBe(200);
    expect(gen.calls).toHaveLength(2);
    // the retry turn carries the violation list back to the model
    const retryMessages = gen.calls[1].messages;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[2].content).toMatch("stat total");
  });

  it("gives up with 502 after the second invalid output", async () => {
    const broken = makeParty();
    broken.pop(); // only 3 kits
    const bad = JSON.stringify({ kits: broken });
    const gen = new FakeGen([bad, bad]);
    const handler = createPartyHandler({ gen, pool: new MemoryPool() });

    const res = await handler(partyRequest({ descriptions: ["a cat"] }));
    expect(res.status).toBe(502);
    expect(gen.calls).toHaveLength(2);
  });

  it("rejects malformed requests without calling the model", async () => {
    const gen = new FakeGen([validJson]);
    const handler = createPartyHandler({ gen, pool: new MemoryPool() });
    expect((await handler(partyRequest({ descriptions: [] }))).status).toBe(
      400,
    );
    expect((await handler(partyRequest({}))).status).toBe(400);
    expect(gen.calls).toHaveLength(0);
  });
});

describe("generateValidated", () => {
  it("throws GmGenerationError with the lint errors after two failures", async () => {
    const gen = new FakeGen(["not json at all"]);
    await expect(
      generateValidated(gen, {
        model: "m",
        system: "s",
        user: "u",
        schema: {},
        lint: () => ({ errors: ["boom"] }),
      }),
    ).rejects.toThrowError(GmGenerationError);
    expect(gen.calls).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------ */
/* power budget lint (stand-powers.md §Balance — vendored server copy)       */
/* ------------------------------------------------------------------------ */

describe("powerBudget + lintPowerScript (service wrapper over core)", () => {
  it("all stock fallback powers pass the cat cap with true budgets", () => {
    for (const power of Object.values(STOCK_POWERS)) {
      expect(lintPowerScript(power, BUDGET_CAPS.cat)).toEqual([]);
      // same 1e-9 tolerance the core lint uses for declared-vs-computed
      expect(power.budget).toBeCloseTo(powerBudget(power), 9);
      expect(power.budget).toBeLessThanOrEqual(BUDGET_CAPS.cat);
    }
  });

  it("prices frequent triggers above rare ones and discounts conditions", () => {
    const base = makePower("tank");
    const frequent = normalizePower({ ...base, trigger: "onTurnStart" });
    const rare = normalizePower({ ...base, trigger: "onBattleStart" });
    expect(powerBudget(frequent)).toBeGreaterThan(powerBudget(rare));
    const conditioned = normalizePower({
      ...frequent,
      conditions: [{ kind: "chance", pct: 25 }],
    });
    expect(powerBudget(conditioned)).toBeLessThan(powerBudget(frequent));
  });

  it("rejects hard-cap violations (damage pct, move delta, effect count)", () => {
    const power = makePower("striker");
    const cap = BUDGET_CAPS.enemyByTier[3];
    const overDamage = {
      ...power,
      effects: [
        { kind: "damage" as const, target: "other" as const, pct: 999 },
      ],
    };
    expect(lintPowerScript(overDamage, cap).join("\n")).toMatch("damage pct");
    const overMove = {
      ...power,
      effects: [{ kind: "move" as const, target: "other" as const, delta: 4 }],
    };
    expect(lintPowerScript(overMove, cap).join("\n")).toMatch("move delta");
    const tooMany = {
      ...power,
      effects: Array.from({ length: 4 }, () => ({
        kind: "energy" as const,
        target: "self" as const,
        amount: 1,
      })),
    };
    expect(lintPowerScript(tooMany, cap).join("\n")).toMatch(
      "effects must have 1..3 entries",
    );
  });

  it("rejects budget overruns against the given cap", () => {
    const nuke = normalizePower({
      id: "power:overkill",
      version: POWER_FRAMEWORK_VERSION,
      name: "OVERKILL",
      flavor: "Far too much.",
      trigger: "onTurnStart",
      conditions: [],
      effects: [{ kind: "damage", target: "enemies", pct: 150 }],
    });
    expect(lintPowerScript(nuke, BUDGET_CAPS.cat).join("\n")).toMatch(
      "exceeds cap",
    );
  });

  it("server and client pair keys agree (sortedPair + framework version)", () => {
    const key = resonancePairKey("power:b", "power:a");
    expect(key).toBe(`power:a+power:b@v${POWER_FRAMEWORK_VERSION}`);
    expect(key).toBe(
      clientPairKey("power:b", "power:a", POWER_FRAMEWORK_VERSION),
    );
  });
});

/* ------------------------------------------------------------------------ */
/* POST /api/gm/resonance (mocked client)                                    */
/* ------------------------------------------------------------------------ */

function resonanceRequest(body: unknown): Request {
  return new Request("http://localhost/api/gm/resonance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...({ duplex: "half" } as object),
  });
}

describe("POST /api/gm/resonance (mocked client)", () => {
  const powerA = STOCK_POWERS.striker;
  const powerB = STOCK_POWERS.control;
  const pairKey = resonancePairKey(powerA.id, powerB.id);
  const ruleBody = {
    trigger: "onCrit",
    conditions: [],
    effects: [{ kind: "energy", target: "other", amount: -1 }],
  } as const;
  const flavorLine = "Static arcs along the invisible threads.";
  const announceLine =
    "STAND RESONANCE DISCOVERED: STRING THEORY conducts BOX AMBUSH.";
  /** What the handler stamps + stores from ruleBody. */
  const validRule: InteractionRule = {
    pairKey,
    version: POWER_FRAMEWORK_VERSION,
    trigger: ruleBody.trigger,
    conditions: [],
    effects: [{ kind: "energy", target: "other", amount: -1 }],
    flavor: flavorLine,
    announce: announceLine,
    budget: 3, // onCrit 1.5 x energy 2·|−1|
  };
  const resonantJson = JSON.stringify({
    hasResonance: true,
    rule: ruleBody,
    flavor: flavorLine,
    announce: announceLine,
  });
  const nullJson = JSON.stringify({
    hasResonance: false,
    rule: null,
    flavor: "These two powers politely ignore each other.",
    announce: "",
  });
  const body = (sessionId?: string): unknown => ({
    pairKey,
    powers: [powerA, powerB],
    sessionId,
  });

  it("pool hit short-circuits without a model call", async () => {
    const pool = new MemoryPool();
    const row: StoredInteraction = {
      pairKey,
      version: POWER_FRAMEWORK_VERSION,
      json: validRule,
      flavor: "f",
      announce: "STAND RESONANCE DISCOVERED: x",
      first_discovered_by: "session-0",
    };
    await pool.setEntry("interactions", pairKey, JSON.stringify(row));
    const gen = new FakeGen([resonantJson]);
    const handler = createResonanceHandler({ gen, pool });

    const res = await handler(resonanceRequest(body()));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      source: string;
      rule: unknown;
      firstDiscoveredBy?: string;
    };
    expect(out.source).toBe("pool");
    expect(out.rule).toEqual(validRule);
    expect(out.firstDiscoveredBy).toBe("session-0");
    expect(gen.calls).toHaveLength(0);
  });

  it("miss → compile → store; the next call is served from the memo", async () => {
    const pool = new MemoryPool();
    const gen = new FakeGen([resonantJson]);
    const handler = createResonanceHandler({ gen, pool });

    const first = await handler(resonanceRequest(body("sess-42")));
    expect(first.status).toBe(200);
    const out = (await first.json()) as {
      source: string;
      rule: InteractionRule;
      announce: string;
    };
    expect(out.source).toBe("generated");
    expect(out.rule).toEqual(validRule);
    expect(out.announce).toMatch(/^STAND RESONANCE DISCOVERED:/);
    expect(gen.calls).toHaveLength(1);

    const stored = await pool.getEntry("interactions", pairKey);
    expect(stored).not.toBeNull();
    const row = JSON.parse(stored ?? "") as StoredInteraction;
    expect(row.version).toBe(POWER_FRAMEWORK_VERSION);
    expect(row.first_discovered_by).toBe("sess-42");

    const second = await handler(resonanceRequest(body()));
    const out2 = (await second.json()) as {
      source: string;
      firstDiscoveredBy?: string;
    };
    expect(out2.source).toBe("pool");
    expect(out2.firstDiscoveredBy).toBe("sess-42");
    expect(gen.calls).toHaveLength(1); // no second model call
  });

  it("memoizes a null verdict (no resonance is a stored answer)", async () => {
    const pool = new MemoryPool();
    const gen = new FakeGen([nullJson]);
    const handler = createResonanceHandler({ gen, pool });

    const first = await handler(resonanceRequest(body()));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { rule: unknown }).rule).toBeNull();
    expect(gen.calls).toHaveLength(1);

    const second = await handler(resonanceRequest(body()));
    const out = (await second.json()) as { rule: unknown; source: string };
    expect(out.rule).toBeNull();
    expect(out.source).toBe("pool");
    expect(gen.calls).toHaveLength(1); // memoized null → no recompile
  });

  it("gives up with 502 after two cap-busting outputs", async () => {
    const overBudget = JSON.stringify({
      hasResonance: true,
      rule: {
        trigger: "onTurnStart",
        conditions: [],
        effects: [{ kind: "damage", target: "enemies", pct: 150 }],
      },
      flavor: "WAY too strong.",
      announce: "STAND RESONANCE DISCOVERED: OVERKILL.",
    });
    const pool = new MemoryPool();
    const gen = new FakeGen([overBudget, overBudget]);
    const handler = createResonanceHandler({ gen, pool });

    const res = await handler(resonanceRequest(body()));
    expect(res.status).toBe(502);
    expect(gen.calls).toHaveLength(2);
    // a failed compile is NOT memoized — the next battle retries
    expect(await pool.getEntry("interactions", pairKey)).toBeNull();
  });

  it("rejects tampered powers and mismatched pair keys without a model call", async () => {
    const gen = new FakeGen([resonantJson]);
    const handler = createResonanceHandler({ gen, pool: new MemoryPool() });

    const tampered = {
      pairKey,
      powers: [
        {
          ...powerA,
          effects: [{ kind: "damage", target: "enemies", pct: 400 }],
        },
        powerB,
      ],
    };
    expect((await handler(resonanceRequest(tampered))).status).toBe(400);

    const wrongKey = { pairKey: "nonsense@v1", powers: [powerA, powerB] };
    expect((await handler(resonanceRequest(wrongKey))).status).toBe(400);
    expect(gen.calls).toHaveLength(0);
  });

  it("lintInteractionRule enforces the tighter resonance cap", () => {
    expect(BUDGET_CAPS.resonance).toBeLessThan(BUDGET_CAPS.cat);
    expect(lintInteractionRule(validRule)).toEqual([]);
    const tooStrong = {
      trigger: "onTurnStart",
      conditions: [],
      effects: [{ kind: "damage", target: "enemies", pct: 100 }],
    } as const;
    expect(lintInteractionRule(tooStrong).join("\n")).toMatch("exceeds cap");
  });
});

/* ------------------------------------------------------------------------ */
/* POST /api/gm/eventResolve (mocked client)                                 */
/* ------------------------------------------------------------------------ */

function resolveRequest(body: unknown): Request {
  return new Request("http://localhost/api/gm/eventResolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...({ duplex: "half" } as object),
  });
}

describe("POST /api/gm/eventResolve (mocked client)", () => {
  const goodEffects: Effect[] = [
    { kind: "shinies", amount: 8 },
    { kind: "damage", target: "random", amount: 3 },
  ];
  const goodJson = JSON.stringify({
    outcome: { text: "The sock yields, grudgingly.", effects: goodEffects },
  });
  const body = (over: Record<string, unknown> = {}): unknown => ({
    floor: 1,
    text: "I bat the sock off the ledge with great ceremony",
    eventId: "gmTestOmen",
    eventPrompt: "The sock stares back.",
    optionLabels: ["Poke it", "Walk away"],
    partyHp: [30, 28, 24, 26],
    shinies: 12,
    ...over,
  });

  it("returns a bounded Outcome-shaped verdict (memoizing nothing)", async () => {
    const gen = new FakeGen([goodJson]);
    const handler = createEventResolveHandler({ gen });

    const res = await handler(resolveRequest(body()));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      outcome: { text: string; effects: Effect[] };
      source: string;
    };
    expect(out.source).toBe("generated");
    expect(out.outcome.effects).toEqual(goodEffects);
    expect(gen.calls).toHaveLength(1);
    // the request context reaches the model verbatim
    expect(gen.calls[0].messages[0].content).toMatch("The sock stares back.");
    expect(gen.calls[0].messages[0].content).toMatch("bat the sock");
  });

  it("allows a trailing fight effect (same rules as fixed options)", async () => {
    const withFight = JSON.stringify({
      outcome: {
        text: "The sock was three rats. It is ALWAYS three rats.",
        effects: [
          { kind: "shinies", amount: 5 },
          { kind: "fight", encounter: ["ratThug", "ratThug"], loot: "normal" },
        ],
      },
    });
    const gen = new FakeGen([withFight]);
    const res = await createEventResolveHandler({ gen })(
      resolveRequest(body()),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { outcome: { effects: Effect[] } };
    expect(out.outcome.effects[1].kind).toBe("fight");
  });

  it("regenerates ONCE on a cap-busting verdict, echoing the violation", async () => {
    const overCap = JSON.stringify({
      outcome: {
        text: "Everything explodes.",
        effects: [{ kind: "damage", target: "party", amount: 50 }],
      },
    });
    const gen = new FakeGen([overCap, goodJson]);
    const res = await createEventResolveHandler({ gen })(
      resolveRequest(body()),
    );
    expect(res.status).toBe(200);
    expect(gen.calls).toHaveLength(2);
    // the retry turn carries the exact cap violation back to the model
    expect(gen.calls[1].messages[2].content).toMatch(
      `above cap ${EVENT_CAPS.damageMax(1)} on floor 1`,
    );
  });

  it("gives up with 502 after two invalid outputs", async () => {
    const overCap = JSON.stringify({
      outcome: {
        text: "No.",
        effects: [{ kind: "shinies", amount: 999 }],
      },
    });
    const gen = new FakeGen([overCap, overCap]);
    const res = await createEventResolveHandler({ gen })(
      resolveRequest(body()),
    );
    expect(res.status).toBe(502);
    expect(gen.calls).toHaveLength(2);
  });

  it("rejects malformed requests without calling the model", async () => {
    const gen = new FakeGen([goodJson]);
    const handler = createEventResolveHandler({ gen });
    expect((await handler(resolveRequest({ text: "hi" }))).status).toBe(400);
    expect((await handler(resolveRequest({ floor: 2 }))).status).toBe(400);
    expect(
      (await handler(resolveRequest(body({ text: "x".repeat(281) })))).status,
    ).toBe(400);
    expect(gen.calls).toHaveLength(0);
  });

  it("lintResolvePayload rejects gateCat targets and oversized bundles", () => {
    const gate = lintResolvePayload(
      {
        outcome: {
          text: "t",
          effects: [{ kind: "damage", target: "gateCat", amount: 2 }],
        },
      },
      1,
    );
    expect(gate.errors.join("\n")).toMatch("gateCat");
    const four = lintResolvePayload(
      {
        outcome: {
          text: "t",
          effects: Array.from({ length: 4 }, () => ({ kind: "nothing" })),
        },
      },
      1,
    );
    expect(four.errors.join("\n")).toMatch("0..3");
    const empty = lintResolvePayload({ outcome: { text: "", effects: [] } }, 1);
    expect(empty.errors.join("\n")).toMatch("1..400");
  });
});

/* ------------------------------------------------------------------------ */
/* Resonance attachment — rules execute as extra owner-side powers           */
/* ------------------------------------------------------------------------ */

describe("PoweredBattleSetup.interactions (stand-powers.md L3 wiring)", () => {
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

  function rule(overrides: Partial<InteractionRule> = {}): InteractionRule {
    // energy self +2 on battle start: budget = 1 × (2·|2|) = 4 (cap 8)
    return {
      pairKey: "power:a+power:b@v1",
      version: POWER_FRAMEWORK_VERSION,
      trigger: "onBattleStart",
      conditions: [],
      effects: [{ kind: "energy", target: "self", amount: 2 }],
      flavor: "The threads hum in sympathy.",
      announce: "STAND RESONANCE DISCOVERED: A+B.",
      budget: 4,
      ...overrides,
    };
  }

  it("an attached rule fires as an extra chargeless power of its owner", () => {
    const setup: PoweredBattleSetup = {
      cats: l1Cats(),
      enemies: ["ratThug"],
      encounterIndex: 1,
      canFlee: true,
      interactions: [{ ownerId: "cat:bruiser", rule: rule() }],
    };
    const bs = createBattle(setup);
    const powers = (bs as PoweredBattleState).powers;
    expect(powers?.resonances?.["cat:bruiser"]).toHaveLength(1);

    const r = startRound(bs, mulberry32(7)); // round 1 → onBattleStart consults
    const logs = r.events.filter(
      (e) => e.t === "log" && e.text.includes("「RESONANCE」"),
    );
    expect(logs).toHaveLength(1);
    const energy = r.events.find(
      (e) => e.t === "energy" && e.id === "cat:bruiser",
    );
    expect(energy).toBeTruthy();
    const bruno = r.state.combatants.find((c) => c.id === "cat:bruiser");
    expect(bruno?.energy).toBe(6); // 4 start + 2 resonance
  });

  it("rules busting the resonance cap (or lying budgets) are dropped", () => {
    const overCap = rule({
      trigger: "onTurnStart",
      effects: [{ kind: "damage", target: "enemies", pct: 100 }],
      budget: 60,
    });
    const lying = rule({ budget: 1 }); // declared != computed
    const setup: PoweredBattleSetup = {
      cats: l1Cats(),
      enemies: ["ratThug"],
      encounterIndex: 1,
      canFlee: true,
      interactions: [
        { ownerId: "cat:bruiser", rule: overCap },
        { ownerId: "cat:hexer", rule: lying },
        { ownerId: "cat:nobody", rule: rule() }, // unknown owner id
      ],
    };
    const bs = createBattle(setup);
    // nothing valid attached → no powers key at all (legacy behavior)
    expect((bs as PoweredBattleState).powers).toBeUndefined();
  });

  it("interactions ride alongside per-combatant scripts without changes", () => {
    const setup: PoweredBattleSetup = {
      cats: l1Cats(),
      enemies: ["ratThug"],
      encounterIndex: 1,
      canFlee: true,
      powers: { "cat:medic": STOCK_POWERS.support },
      interactions: [{ ownerId: "cat:medic", rule: rule() }],
    };
    const bs = createBattle(setup);
    const powers = (bs as PoweredBattleState).powers;
    expect(powers?.scripts["cat:medic"]?.id).toBe(STOCK_POWERS.support.id);
    expect(powers?.resonances?.["cat:medic"]).toHaveLength(1);
  });
});
