/**
 * Generated-content rules (docs/design/gm-system.md, stand-powers.md).
 *
 * These lints used to run inside the `api/gm/*` Vercel functions, on the
 * server, where the model call was. The endpoints are gone; the DM owns the
 * prompts and the model credential, and the lints run where the payload is
 * consumed. So this file tests:
 *
 *  - the pure constraint lints (party budgets, event caps, item hooks) from
 *    `src/services/contentLint.ts` — the SAME module the browser runs on a
 *    generated party and the agent runs before publishing to the pool;
 *  - Power Script pricing and stamping from `src/services/powerLint.ts`;
 *  - the two client-side one-shot pipelines in `src/services/oneshot.ts`
 *    (`lintPartyPayload` → retry → `salvagePartyPowers`, `readResonanceVerdict`)
 *    — the half of the retired
 *    endpoints that was never the model's job: re-lint, salvage, stamp;
 *  - pool-first probability + MemoryPool behaviour (`agent/lib/pool.ts`,
 *    which outlived `api/` because the DM's `contribute_content` writes to it);
 *  - the engine wiring a compiled resonance rule ends up in.
 */
import { describe, expect, it } from "vitest";
import type { GameEvent, Skill } from "../src/core/types.js";
import type {
  GeneratedCatKit,
  GeneratedEquip,
  GmRole,
  InteractionRule,
  PowerScript,
} from "../src/services/gmTypes.js";
import { EVENT_CAPS, ROLE_STAT_TOTALS } from "../src/services/caps.js";
import {
  lintEvent,
  lintEventCaps,
  lintItem,
  lintParty,
} from "../src/services/contentLint.js";
import { MemoryPool, poolPickProbability } from "../agent/lib/pool.js";
import {
  BUDGET_CAPS,
  lintInteractionRule,
  lintPowerScript,
  normalizePower,
  POWER_FRAMEWORK_VERSION,
  powerBudget,
  resonancePairKey,
  STOCK_POWERS,
} from "../src/services/powerLint.js";
import {
  lintPartyPayload,
  readResonanceVerdict,
  salvagePartyPowers,
} from "../src/services/oneshot.js";
import { parseEmbeddedJson } from "../src/services/dm.js";
import { ART_STYLE } from "../src/content/artStyle.js";
import type { BattleSetup, ClassId } from "../src/core/types.js";
import type {
  PoweredBattleSetup,
  PoweredBattleState,
} from "../src/core/combat/powerTypes.js";
import { CLASSES } from "../src/content/classes.js";
import { createBattle } from "../src/core/combat/setup.js";
import { startRound } from "../src/core/combat/turns.js";
import { mulberry32 } from "../src/core/rng.js";

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
/* the one-shot party pipeline (was the server half of POST /api/gm/party)  */
/* ------------------------------------------------------------------------ */

describe("lintPartyPayload (client-side re-lint and stamp)", () => {
  it("accepts a legal party, stamps budgets and composes the art style", () => {
    const { value: kits, errors } = lintPartyPayload({ kits: makeParty() });
    expect(errors).toEqual([]);
    expect(kits).toHaveLength(4);
    expect(new Set(kits?.map((k) => k.role)).size).toBe(4);
    for (const kit of kits ?? []) {
      // budgets are stamped here, never trusted from the model
      expect(kit.power.budget).toBeCloseTo(powerBudget(kit.power), 9);
      // visualPrompts are composed from the versioned style contract
      expect(kit.stand.visualPrompt).toContain(ART_STYLE.basePrompt);
      expect(kit.stand.visualPrompt).toContain(ART_STYLE.framing.battleSprite);
    }
  });

  it("recomputes a lying budget rather than believing it", () => {
    const party = makeParty();
    party[0].power = { ...party[0].power, budget: 0.01 };
    const kits = lintPartyPayload({ kits: party }).value;
    expect(kits?.[0].power.budget).toBeCloseTo(powerBudget(kits![0].power), 9);
    expect(kits?.[0].power.budget).toBeGreaterThan(0.01);
  });

  it("REPORTS the violations rather than swallowing them — they are the retry", () => {
    const party = makeParty();
    party[0].base.atk += 3; // tank stat total no longer 62
    party[1].power = {
      ...makePower("striker"),
      effects: [{ kind: "damage", target: "enemies", pct: 999 }],
    };
    const { value, errors } = lintPartyPayload({ kits: party });
    expect(value).toBeUndefined();
    const joined = errors.join("\n");
    expect(joined).toMatch("stat total");
    expect(joined).toMatch("damage pct");
    // the failing power is named, so the DM knows which kit to fix
    expect(joined).toMatch("power:strikerTestPower");
  });

  it("rejects a payload that is not a party at all", () => {
    for (const bad of [null, undefined, {}, { kits: "four" }]) {
      expect(lintPartyPayload(bad).value).toBeUndefined();
      expect(lintPartyPayload(bad).errors.length).toBeGreaterThan(0);
    }
  });
});

describe("salvagePartyPowers (the last resort after the retry)", () => {
  it("swaps a cap-busting power for the role's stock power, keeping the kit", () => {
    const party = makeParty();
    party[1].power = {
      ...makePower("striker"),
      effects: [{ kind: "damage", target: "enemies", pct: 999 }],
    };
    const kits = salvagePartyPowers({ kits: party });
    expect(kits?.[1].power.id).toBe(STOCK_POWERS.striker.id);
    // every other kit keeps the power it was given
    expect(kits?.[0].power.id).toBe("power:tankTestPower");
    // and the salvaged party is still stamped and styled
    expect(kits?.[1].power.budget).toBeCloseTo(powerBudget(kits![1].power), 9);
    expect(kits?.[0].stand.visualPrompt).toContain(ART_STYLE.basePrompt);
  });

  it("gives up on a KIT-level violation (a stock power cannot fix stats)", () => {
    const busted = makeParty();
    busted[0].base.atk += 3;
    expect(salvagePartyPowers({ kits: busted })).toBeUndefined();

    const short = makeParty();
    short.pop();
    expect(salvagePartyPowers({ kits: short })).toBeUndefined();
    expect(salvagePartyPowers(null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/* power budget lint (stand-powers.md §Balance)                              */
/* ------------------------------------------------------------------------ */

describe("powerBudget + lintPowerScript", () => {
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

  it("the pair key is sortedPair + framework version, from one function", () => {
    // There is exactly one `resonancePairKey` now. It used to exist twice —
    // once in api/_lib/powers.ts and once in src/services/gm.ts — with a test
    // right here asserting the copies agreed.
    const key = resonancePairKey("power:b", "power:a");
    expect(key).toBe(`power:a+power:b@v${POWER_FRAMEWORK_VERSION}`);
    expect(resonancePairKey("power:a", "power:b")).toBe(key);
  });
});

/* ------------------------------------------------------------------------ */
/* schema recovery: the structured answer that arrived as prose             */
/* ------------------------------------------------------------------------ */

describe("parseEmbeddedJson (fallback when a schema'd turn emits no result)", () => {
  it("reads the object out of a fenced block, prose, or a bare answer", () => {
    const want = { hasResonance: false, rule: null };
    expect(
      parseEmbeddedJson('```json\n{"hasResonance":false,"rule":null}\n```'),
    ).toEqual(want);
    expect(
      parseEmbeddedJson('Here you go: {"hasResonance":false,"rule":null}'),
    ).toEqual(want);
    expect(parseEmbeddedJson('{"hasResonance":false,"rule":null}')).toEqual(
      want,
    );
  });

  it("brace-matches instead of greedily eating the rest of the message", () => {
    const got = parseEmbeddedJson('{"a":{"b":1}} and then some chatter { oops');
    expect(got).toEqual({ a: { b: 1 } });
  });

  it("is not fooled by braces inside strings", () => {
    expect(parseEmbeddedJson('{"flavor":"a } brace","n":1}')).toEqual({
      flavor: "a } brace",
      n: 1,
    });
    expect(
      parseEmbeddedJson('{"flavor":"an escaped \\" quote }","n":2}'),
    ).toEqual({
      flavor: 'an escaped " quote }',
      n: 2,
    });
  });

  it("returns undefined rather than guessing", () => {
    expect(parseEmbeddedJson("no object here at all")).toBeUndefined();
    expect(parseEmbeddedJson('{"unterminated": ')).toBeUndefined();
    expect(parseEmbeddedJson("{not json}")).toBeUndefined();
    expect(parseEmbeddedJson("")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/* the one-shot resonance pipeline (was POST /api/gm/resonance)             */
/* ------------------------------------------------------------------------ */

describe("readResonanceVerdict (client-side lint + envelope stamp)", () => {
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
  const resonant = {
    hasResonance: true,
    rule: ruleBody,
    flavor: flavorLine,
    announce: announceLine,
  };

  it("stamps pairKey, framework version and a RECOMPUTED budget", () => {
    const verdict = readResonanceVerdict(resonant, pairKey);
    expect(verdict).not.toBeNull();
    const rule = verdict?.rule as InteractionRule;
    expect(rule.pairKey).toBe(pairKey);
    expect(rule.version).toBe(POWER_FRAMEWORK_VERSION);
    expect(rule.trigger).toBe("onCrit");
    expect(rule.flavor).toBe(flavorLine);
    expect(rule.announce).toBe(announceLine);
    // onCrit 1.5 x energy 2·|-1| = 3 — computed here, never sent
    expect(rule.budget).toBe(3);
    expect(rule.budget).toBeLessThanOrEqual(BUDGET_CAPS.resonance);
  });

  it("treats 'no resonance' as a first-class, cacheable answer", () => {
    const verdict = readResonanceVerdict(
      {
        hasResonance: false,
        rule: null,
        flavor: "These two powers politely ignore each other.",
        announce: "",
      },
      pairKey,
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.rule).toBeNull();
    expect(verdict?.announce).toBe("");
  });

  it("rejects a cap-busting rule (the battle then runs on base rules)", () => {
    const overBudget = {
      hasResonance: true,
      rule: {
        trigger: "onTurnStart",
        conditions: [],
        effects: [{ kind: "damage", target: "enemies", pct: 150 }],
      },
      flavor: "WAY too strong.",
      announce: "STAND RESONANCE DISCOVERED: OVERKILL.",
    };
    expect(readResonanceVerdict(overBudget, pairKey)).toBeNull();
  });

  it("rejects a malformed or unannounced verdict", () => {
    expect(readResonanceVerdict(null, pairKey)).toBeNull();
    expect(
      readResonanceVerdict({ ...resonant, announce: "it happened" }, pairKey),
    ).toBeNull();
    expect(
      readResonanceVerdict({ ...resonant, flavor: "x".repeat(201) }, pairKey),
    ).toBeNull();
  });

  it("lintInteractionRule enforces the tighter resonance cap", () => {
    expect(BUDGET_CAPS.resonance).toBeLessThan(BUDGET_CAPS.cat);
    expect(lintInteractionRule(ruleBody)).toEqual([]);
    const tooStrong = {
      trigger: "onTurnStart",
      conditions: [],
      effects: [{ kind: "damage", target: "enemies", pct: 100 }],
    } as const;
    expect(lintInteractionRule(tooStrong).join("\n")).toMatch("exceeds cap");
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
