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
