/**
 * Party creator (GM custom parties) — the ui-side kit mapping + content
 * overlay in src/ui/scenes/partyCreator.ts and the additive customParty
 * plumbing in core/run/runState.ts.
 *
 * Invariants under test:
 *  - role → fixed ClassId slot mapping (tank→bruiser … support→medic),
 *    duplicate roles spill into free slots, skill ids are namespaced;
 *  - applyPartyContent overlays CLASSES / CAT_POWERS / SKILLS and restores
 *    the stock Strays EXACTLY (same object references) on reset;
 *  - custom skills resolve through the combat engine's lookupSkill and the
 *    class table drives skillsForLevel / growthStats as usual;
 *  - newRun(seed, customParty) records the kits and derives starting HP
 *    from the overlaid custom bases; newRun(seed) is byte-identical to the
 *    pre-feature behavior;
 *  - customParty survives the serializeRun/deserializeRun roundtrip.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Stats } from "../src/core/types.js";
import {
  generateCurrentFloorMap,
  newRun,
  PARTY_ORDER,
} from "../src/core/run/runState.js";
import {
  effectiveStats,
  growthStats,
  maxHp,
  skillsForLevel,
} from "../src/core/run/party.js";
import { deserializeRun, serializeRun } from "../src/core/run/save.js";
import { lookupSkill } from "../src/core/combat/state.js";
import { createBattle } from "../src/core/combat/setup.js";
import { startRound } from "../src/core/combat/turns.js";
import type {
  PoweredBattleSetup,
  PoweredBattleState,
} from "../src/core/combat/powerTypes.js";
import { mulberry32 } from "../src/core/rng.js";
import { CLASSES } from "../src/content/classes.js";
import { SKILLS } from "../src/content/skills.js";
import { CAT_POWERS } from "../src/content/powers.js";
import type { GeneratedCatKit, GmRole } from "../src/services/gmTypes.js";
import {
  applyPartyContent,
  mapKitsToCustomParty,
} from "../src/ui/scenes/partyCreator.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const BASE: Stats = { hp: 44, atk: 9, def: 4, spd: 5, crt: 6, enMax: 10 };

function fakeKit(role: GmRole, name: string): GeneratedCatKit {
  return {
    role,
    catName: name,
    className: `${name}-class`,
    epithet: `The ${name}`,
    base: { ...BASE },
    growth: Array.from({ length: 7 }, () => ({ hp: 3, atk: 1 })),
    skills: [
      {
        id: `gm-basic-${name}`,
        name: "Paw Jab",
        desc: "basic",
        cost: 0,
        usableFrom: [1, 2],
        target: { side: "enemy", ranks: [1, 2], pattern: "single" },
        power: 60,
        kind: "damage",
        energyGain: 1,
      },
      {
        id: `gm-two-${name}`,
        name: "Yowl",
        desc: "utility",
        cost: 2,
        usableFrom: [1, 2, 3, 4],
        target: { side: "ally", ranks: [1, 2, 3, 4], pattern: "row" },
        power: 0,
        kind: "utility",
      },
      {
        id: `gm-three-${name}`,
        name: "Rake",
        desc: "damage",
        cost: 3,
        usableFrom: [1],
        target: { side: "enemy", ranks: [1], pattern: "single" },
        power: 90,
        kind: "damage",
      },
      {
        id: `gm-cap-${name}`,
        name: "Nine Tails",
        desc: "capstone",
        cost: 5,
        usableFrom: [1, 2],
        target: { side: "enemy", ranks: [1, 2, 3], pattern: "row" },
        power: 70,
        kind: "damage",
      },
    ],
    trait: { name: "Weird Aura", desc: "prose only" },
    stand: {
      name: `STAND ${name.toUpperCase()}`,
      visualPrompt: `a ghostly stand for ${name}`,
    },
    power: {
      id: `power:custom-${name}`,
      version: 1,
      name: `STAND ${name.toUpperCase()}`,
      flavor: "It looms.",
      budget: 5.145,
      trigger: "onTakeHit",
      conditions: [{ kind: "chance", pct: 35 }],
      effects: [
        { kind: "move", target: "other", delta: 1 },
        { kind: "status", target: "self", status: "guarded" },
      ],
      charges: { perRound: 1 },
    },
    flavor: {
      bio: `${name} came from nowhere.`,
      barks: { crit: "!", ko: "…", catPile: "pile!" },
    },
  };
}

const FOUR_ROLES: GmRole[] = ["support", "tank", "striker", "control"];

function fakeParty(): GeneratedCatKit[] {
  return FOUR_ROLES.map((r, i) => fakeKit(r, `cat${i}`));
}

afterEach(() => {
  applyPartyContent(null); // never leak an overlay into other tests
});

/* ------------------------------------------------------------------ */
/* mapping                                                             */
/* ------------------------------------------------------------------ */

describe("mapKitsToCustomParty", () => {
  it("maps roles onto the fixed ClassId slots regardless of kit order", () => {
    const party = mapKitsToCustomParty(fakeParty());
    expect(party.map((k) => [k.role, k.classId])).toEqual([
      ["support", "medic"],
      ["tank", "bruiser"],
      ["striker", "trickster"],
      ["control", "hexer"],
    ]);
  });

  it("spills duplicated roles into free slots (defensive)", () => {
    const kits = [
      fakeKit("tank", "a"),
      fakeKit("tank", "b"),
      fakeKit("tank", "c"),
      fakeKit("tank", "d"),
    ];
    const party = mapKitsToCustomParty(kits);
    expect(new Set(party.map((k) => k.classId)).size).toBe(4);
  });

  it("namespaces skill ids per slot and keeps stand/visual data", () => {
    const party = mapKitsToCustomParty(fakeParty());
    const medic = party[0];
    expect(medic.classId).toBe("medic");
    expect(medic.skills.map((s) => s.id)).toEqual([
      "custom:medic:1",
      "custom:medic:2",
      "custom:medic:3",
      "custom:medic:4",
    ]);
    expect(medic.standName).toBe("STAND CAT0");
    expect(medic.visualPrompt).toContain("cat0");
    expect(medic.power.id).toBe("power:custom-cat0");
  });
});

/* ------------------------------------------------------------------ */
/* content overlay                                                     */
/* ------------------------------------------------------------------ */

describe("applyPartyContent", () => {
  it("overlays CLASSES/CAT_POWERS/SKILLS and restores the stock tables", () => {
    const stockRefs = PARTY_ORDER.map((id) => CLASSES[id]);
    const stockPowerRefs = PARTY_ORDER.map((id) => CAT_POWERS[id]);
    const party = mapKitsToCustomParty(fakeParty());

    applyPartyContent(party);
    expect(CLASSES.bruiser.catName).toBe("cat1");
    expect(CLASSES.medic.catName).toBe("cat0");
    expect(CAT_POWERS.bruiser?.id).toBe("power:custom-cat1");
    expect(SKILLS["custom:medic:1"]?.name).toBe("Paw Jab");
    // engine-side resolution: battle UI + resolver use lookupSkill
    expect(lookupSkill("custom:hexer:4").name).toBe("Nine Tails");
    // class table drives progression as usual
    expect(skillsForLevel("medic", 1)).toEqual([
      "custom:medic:1",
      "custom:medic:2",
      "custom:medic:3",
    ]);
    expect(skillsForLevel("medic", 4)).toContain("custom:medic:4");
    expect(growthStats("bruiser", 2).hp).toBe(BASE.hp + 3);
    // the custom trait id is outside every executable TraitId (inert)
    expect(CLASSES.bruiser.trait.id).toBe("custom:bruiser");

    applyPartyContent(null);
    PARTY_ORDER.forEach((id, i) => {
      expect(CLASSES[id]).toBe(stockRefs[i]); // exact same objects back
      expect(CAT_POWERS[id]).toBe(stockPowerRefs[i]);
    });
    expect(SKILLS["custom:medic:1"]).toBeUndefined();
    expect(() => lookupSkill("custom:medic:1")).toThrow();
  });

  it("is idempotent — re-applying restores first, never stacks", () => {
    const party = mapKitsToCustomParty(fakeParty());
    applyPartyContent(party);
    applyPartyContent(party);
    applyPartyContent(null);
    expect(CLASSES.bruiser.catName).toBe("Bruno");
    expect(Object.keys(SKILLS).some((k) => k.startsWith("custom:"))).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* run state plumbing                                                  */
/* ------------------------------------------------------------------ */

describe("newRun customParty (additive)", () => {
  it("default newRun is unchanged and carries no customParty key", () => {
    const run = newRun("AAAAAAAA");
    expect("customParty" in run).toBe(false);
    expect(run.cats.map((c) => c.classId)).toEqual([...PARTY_ORDER]);
    expect(run.cats[0].hp).toBe(maxHp(run.cats[0], 1)); // stock Bruno HP
  });

  it("records the kits and derives starting HP from the overlaid bases", () => {
    const party = mapKitsToCustomParty(fakeParty());
    applyPartyContent(party); // the creator scene does this before newRun
    const run = newRun("BBBBBBBB", party);
    expect(run.customParty).toHaveLength(4);
    // maxHp = custom base hp (stray class weapons add atk, not hp)
    for (const cat of run.cats) {
      expect(cat.hp).toBe(BASE.hp);
      expect(cat.hp).toBe(maxHp(cat, 1));
    }
    expect(
      run.customParty?.find((k) => k.classId === "trickster")?.standName,
    ).toBe("STAND CAT2");
  });

  it("a battle sets up from the overlaid tables with the kit powers attached", () => {
    // mirrors battle.ts buildSetup: stats/skills come from the (overlaid)
    // CLASSES table via party.ts, powers from CAT_POWERS keyed by class
    const party = mapKitsToCustomParty(fakeParty());
    applyPartyContent(party);
    // Fields all four kits: the point here is that every generated
    // PowerScript survives the lint, not the §2 starting roster size.
    const run = newRun("DDDDDDDD", party, {
      roster: ["bruiser", "trickster", "hexer", "medic"],
      partyCapacity: 4,
    });
    const setup: PoweredBattleSetup = {
      cats: run.marchingOrder.map((classId) => {
        const cat = run.cats.find((c) => c.classId === classId)!;
        const stats = effectiveStats(cat, run.level);
        return {
          classId,
          name: CLASSES[classId].catName,
          stats,
          hp: Math.min(cat.hp, stats.hp),
          lives: cat.lives,
          skills: skillsForLevel(classId, run.level),
          traits: [CLASSES[classId].trait.id],
          hooks: [],
          startEnergyBonus: 0,
        };
      }),
      enemies: ["ratThug", "sewerBat"],
      encounterIndex: 1,
      canFlee: true,
      powers: Object.fromEntries(
        party.map((k) => [`cat:${k.classId}`, k.power]),
      ),
    };
    const state = createBattle(setup) as PoweredBattleState;
    // the generated PowerScripts survived the engine's budget lint
    expect(Object.keys(state.powers?.scripts ?? {}).sort()).toEqual([
      "cat:bruiser",
      "cat:hexer",
      "cat:medic",
      "cat:trickster",
    ]);
    expect(state.powers?.scripts["cat:bruiser"].name).toBe("STAND CAT1");
    // a round starts cleanly (custom skills resolve via lookupSkill)
    const r1 = startRound(state, mulberry32(7));
    expect(r1.state.round).toBe(1);
    const bruiser = r1.state.combatants.find((c) => c.id === "cat:bruiser");
    expect(bruiser?.skills).toEqual([
      "custom:bruiser:1",
      "custom:bruiser:2",
      "custom:bruiser:3",
    ]);
    expect(bruiser?.hp).toBe(BASE.hp);
  });

  it("customParty survives the save/load roundtrip", () => {
    const party = mapKitsToCustomParty(fakeParty());
    applyPartyContent(party);
    let run = newRun("CCCCCCCC", party);
    run = generateCurrentFloorMap(run);
    const restored = deserializeRun(serializeRun(run));
    expect(restored.customParty).toEqual(run.customParty);
    expect(restored.customParty?.[0].visualPrompt).toContain("ghostly stand");
  });
});
