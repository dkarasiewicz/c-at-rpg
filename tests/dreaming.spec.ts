/**
 * THE DREAMING — the client read path (docs/design/roster-and-persistence.md
 * §5). Three things are worth a test and all three are pure or observable:
 *
 *  1. **The probability.** `p = min(0.7, size/200)`, and — the part that
 *     actually matters — the ROLL CONSUMES NO DRAWS when there is nothing to
 *     pick. The whole offline game is seeded and asserted elsewhere against
 *     exact outputs, so "a run with no pool is byte-identical" is a statement
 *     about rng stream positions, not about vibes.
 *  2. **Arrival validation.** Every row is re-linted with the SHIPPED
 *     validators before the engine sees it. A poisoned row is dropped, and a
 *     row that claims a shipped id resolves to the SHIPPED def rather than
 *     redefining it.
 *  3. **Offline means offline.** With the pool unconfigured, priming makes
 *     ZERO requests and every reader answers empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnemyDef,
  EquipDef,
  GameEvent,
  MapNode,
  Rng,
} from "../src/core/types.js";
import { mulberry32 } from "../src/core/rng.js";
import {
  DREAM_P_MAX,
  dreamedChance,
  dreamedTag,
  pickDreamed,
  type Dreamed,
  type DreamedChoice,
} from "../src/core/loot/dreamed.js";
import { rollChest, type LootCtx } from "../src/core/loot/roll.js";
import { selectEvent } from "../src/core/events/select.js";
import { encounterFor } from "../src/core/map/encounter.js";
import {
  dreamedBackdrops,
  dreamedEnemies,
  dreamedEquips,
  dreamedEvents,
  poolReady,
  primeDreaming,
  resetDreaming,
  resetPoolConfig,
  validateDreamedBackdrop,
  validateDreamedEnemy,
  validateDreamedEvent,
  validateDreamedItem,
  type DreamedRow,
} from "../src/services/pool.js";
import { EVENTS } from "../src/content/events.js";
import { EQUIP_DEFS } from "../src/content/equipment.js";
import { ENEMIES } from "../src/content/enemies.js";
import { FLOORS } from "../src/content/floors.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** An Rng that records every draw, so "no draw" is testable. */
function spyRng(
  floats: number[] = [],
  ints: number[] = [],
): Rng & {
  calls: string[];
} {
  let fi = 0;
  let ii = 0;
  const calls: string[] = [];
  return {
    calls,
    float(): number {
      calls.push("float");
      return floats[fi++] ?? 0.5;
    },
    int(lo: number, hi: number): number {
      calls.push(`int(${lo},${hi})`);
      const v = ints[ii++];
      return v === undefined ? lo : Math.min(hi, Math.max(lo, v));
    },
  };
}

function row(over: Partial<DreamedRow> & Pick<DreamedRow, "id" | "kind">) {
  return {
    payload: {},
    artUrl: null,
    styleVersion: 1,
    floorMin: 1,
    floorMax: 6,
    tier: null,
    provenance: "generation-zero",
    createdAt: null,
    ...over,
  } as DreamedRow;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function choiceOf<T>(values: T[], poolSize: number): DreamedChoice<T> {
  return {
    poolSize,
    candidates: values.map((value, i): Dreamed<T> => ({
      value,
      origin: {
        rowId: `row:${i}`,
        provenance: "generation-zero",
        byStray: false,
      },
    })),
  };
}

/* ================================================================== */
/* 1. the probability, and the draw contract                           */
/* ================================================================== */

describe("dreamedChance", () => {
  it("is p = min(0.7, size/200)", () => {
    expect(dreamedChance(0)).toBe(0);
    expect(dreamedChance(20)).toBeCloseTo(0.1, 10);
    expect(dreamedChance(66)).toBeCloseTo(0.33, 10);
    expect(dreamedChance(140)).toBeCloseTo(DREAM_P_MAX, 10);
    expect(dreamedChance(10_000)).toBe(DREAM_P_MAX);
  });

  it("rises with the pool — a big world visibly changes a run", () => {
    const sizes = [0, 10, 40, 100, 140, 400];
    const ps = sizes.map(dreamedChance);
    for (let i = 1; i < ps.length; i++)
      expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
    expect(ps[1]).toBeLessThan(0.06); // a tiny pool barely shows
    expect(ps.at(-1)).toBe(DREAM_P_MAX); // a huge one mostly does
  });

  it("treats nonsense sizes as an empty world", () => {
    expect(dreamedChance(-5)).toBe(0);
    expect(dreamedChance(Number.NaN)).toBe(0);
    expect(dreamedChance(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("pickDreamed draw contract", () => {
  it("consumes NO draws when there is nothing to pick", () => {
    const a = spyRng();
    expect(pickDreamed(a, undefined)).toBeNull();
    expect(a.calls).toEqual([]);

    const b = spyRng();
    expect(pickDreamed(b, choiceOf<number>([], 500))).toBeNull();
    expect(b.calls).toEqual([]);

    // candidates but an empty world (size 0 ⇒ p 0): still not one draw.
    const c = spyRng();
    expect(pickDreamed(c, choiceOf([1, 2], 0))).toBeNull();
    expect(c.calls).toEqual([]);
  });

  it("spends exactly one draw on a miss and two on a hit", () => {
    const miss = spyRng([0.9]); // 0.9 >= p(66)=0.33
    expect(pickDreamed(miss, choiceOf(["a", "b"], 66))).toBeNull();
    expect(miss.calls).toEqual(["float"]);

    const hit = spyRng([0.1], [1]);
    expect(pickDreamed(hit, choiceOf(["a", "b"], 66))?.value).toBe("b");
    expect(hit.calls).toEqual(["float", "int(0,1)"]);
  });

  it("gates on p exactly — the boundary is a miss", () => {
    const p = dreamedChance(66);
    expect(pickDreamed(spyRng([p]), choiceOf(["a"], 66))).toBeNull();
    expect(pickDreamed(spyRng([p - 1e-9]), choiceOf(["a"], 66))).not.toBeNull();
  });

  it("hits at about p over many rolls", () => {
    const rng = mulberry32(4242);
    const choice = choiceOf(["a", "b", "c"], 100); // p = 0.5
    let hits = 0;
    for (let i = 0; i < 4000; i++) if (pickDreamed(rng, choice)) hits++;
    expect(hits / 4000).toBeGreaterThan(0.46);
    expect(hits / 4000).toBeLessThan(0.54);
  });
});

describe("dreamedTag", () => {
  it("names who dreamed it", () => {
    expect(
      dreamedTag({ rowId: "x", provenance: "dm:a chest", byStray: true }),
    ).toBe("dreamed by another stray");
    expect(
      dreamedTag({ rowId: "x", provenance: "generation-zero", byStray: false }),
    ).toBe("from the dreaming");
  });
});

/* ================================================================== */
/* 2. arrival validation                                               */
/* ================================================================== */

describe("arrival validation — items", () => {
  it("accepts a generation-zero row and resolves it to the shipped def", () => {
    const ok = validateDreamedItem(
      row({
        id: "item:mittsOfMenace",
        kind: "items",
        payload: { equip: clone(EQUIP_DEFS.mittsOfMenace) },
      }),
    );
    expect(ok?.value).toBe(EQUIP_DEFS.mittsOfMenace);
    expect(ok?.origin.rowId).toBe("item:mittsOfMenace");
  });

  it("CANNOT redefine shipped content — a poisoned collision is ignored", () => {
    const poisoned = {
      ...clone(EQUIP_DEFS.mittsOfMenace),
      primary: "hp",
      secondaryPool: ["hp", "crt"],
      uniqueId: "startEnergy6",
      name: "Mitts of Menace (definitely legit)",
    };
    const ok = validateDreamedItem(
      row({ id: "item:evil", kind: "items", payload: { equip: poisoned } }),
    );
    // The SHIPPED def comes back, unchanged, and the table is untouched.
    expect(ok?.value).toBe(EQUIP_DEFS.mittsOfMenace);
    expect(EQUIP_DEFS.mittsOfMenace.primary).toBe("atk");
    expect(EQUIP_DEFS.mittsOfMenace.name).toBe("Mitts of Menace");
  });

  it("drops a new item that fails the SHIPPED lintItem", () => {
    const base = {
      id: "dreamedFang",
      name: "Dreamed Fang",
      icon: "†",
      slot: "trinket",
      primary: "atk",
      secondaryPool: ["hp", "spd"],
      iconPrompt: "a fang",
    };
    // a hook on a non-mewthical item is exactly what lintItem forbids
    expect(
      validateDreamedItem(
        row({
          id: "item:bad",
          kind: "items",
          payload: { equip: { ...base, uniqueId: "startEnergy6" } },
        }),
      ),
    ).toBeNull();
    // an unknown stat key
    expect(
      validateDreamedItem(
        row({
          id: "item:bad2",
          kind: "items",
          payload: { equip: { ...base, primary: "luck" } },
        }),
      ),
    ).toBeNull();
    // a hostile secondary pool
    expect(
      validateDreamedItem(
        row({
          id: "item:bad3",
          kind: "items",
          payload: { equip: { ...base, secondaryPool: ["hp", "hp", "hp"] } },
        }),
      ),
    ).toBeNull();
  });

  it("drops garbage payloads without throwing", () => {
    for (const payload of [null, 42, "nope", [], {}, { equip: 7 }]) {
      expect(
        validateDreamedItem(row({ id: "x", kind: "items", payload })),
      ).toBeNull();
    }
  });
});

describe("arrival validation — events", () => {
  it("accepts a generation-zero event row", () => {
    const ev = EVENTS[0];
    const ok = validateDreamedEvent(
      row({ id: `event:${ev.id}`, kind: "events", payload: clone(ev) }),
    );
    expect(ok?.value.id).toBe(ev.id);
    expect(ok?.value.options.length).toBe(ev.options.length);
  });

  it("drops a card whose damage blows the per-floor cap", () => {
    const ev = clone(EVENTS.find((e) => e.floors[0] === 1)!) as GameEvent;
    ev.options[ev.options.length - 1].outcomes[0].effects = [
      { kind: "damage", target: "party", amount: 9999 },
    ];
    expect(
      validateDreamedEvent(row({ id: "event:x", kind: "events", payload: ev })),
    ).toBeNull();
  });

  it("drops a card that breaks the walk-away rule", () => {
    const ev = clone(EVENTS[0]) as GameEvent;
    for (const opt of ev.options) {
      opt.outcomes[0].effects = [
        { kind: "damage", target: "party", amount: 1 },
      ];
    }
    expect(
      validateDreamedEvent(row({ id: "event:x", kind: "events", payload: ev })),
    ).toBeNull();
  });

  it("drops a card carrying an effect kind the resolver does not implement", () => {
    const ev = clone(EVENTS[0]) as unknown as {
      options: { outcomes: { effects: unknown[] }[] }[];
    };
    ev.options[0].outcomes[0].effects = [{ kind: "grantOmnipotence" }];
    expect(
      validateDreamedEvent(row({ id: "event:x", kind: "events", payload: ev })),
    ).toBeNull();
  });

  it("drops a card referencing an enemy this build does not ship", () => {
    const ev = clone(EVENTS[0]) as GameEvent;
    const last = ev.options[ev.options.length - 1];
    last.outcomes[0].effects = [
      { kind: "fight", encounter: ["worldEater"], loot: "normal" },
    ];
    expect(
      validateDreamedEvent(row({ id: "event:x", kind: "events", payload: ev })),
    ).toBeNull();
  });

  it("drops structural garbage without throwing", () => {
    for (const payload of [
      null,
      { id: "x" },
      { id: "x", title: "t", prompt: "p", floors: [1, 6], weight: 1 },
      {
        id: "x",
        title: "t",
        prompt: "p",
        floors: [6, 1],
        weight: 1,
        options: [],
      },
      {
        id: "x",
        title: "t",
        prompt: "p",
        floors: [1, 6],
        weight: 0,
        options: [],
      },
    ]) {
      expect(
        validateDreamedEvent(row({ id: "x", kind: "events", payload })),
      ).toBeNull();
    }
  });
});

describe("arrival validation — enemies", () => {
  it("accepts a generation-zero enemy row as the shipped def", () => {
    const ok = validateDreamedEnemy(
      row({
        id: "enemy:ratThug",
        kind: "enemies",
        payload: clone(ENEMIES.ratThug),
      }),
    );
    expect(ok?.value).toBe(ENEMIES.ratThug);
  });

  it("refuses a BOSS — a boss is never a corridor pack member", () => {
    const bossId = FLOORS[2].boss!.bossId;
    expect(
      validateDreamedEnemy(
        row({
          id: `enemy:${bossId}`,
          kind: "enemies",
          payload: clone(ENEMIES[bossId]),
        }),
      ),
    ).toBeNull();
  });

  const newEnemy = (): Record<string, unknown> => ({
    id: "dreamedMothKing",
    name: "Moth King",
    tier: 1,
    level: 2,
    description: "A moth that learned the word 'king' and never let it go.",
    tell: "Turns its wings edge-on to the light.",
    weaknesses: ["shove"],
    resistances: [],
    threat: 2,
    row: "front",
    stats: { hp: 20, atk: 5, def: 0, spd: 4, crt: 5, enMax: 0 },
    skills: [ENEMIES.ratThug.skills[0]],
    traits: [],
    xp: 8,
    look: { family: "vermin", sizeGrade: "standard", tier: 1 },
  });

  it("accepts a well-formed new body and registers it for lookup", () => {
    const ok = validateDreamedEnemy(
      row({
        id: "enemy:dreamedMothKing",
        kind: "enemies",
        payload: newEnemy(),
      }),
    );
    expect(ok?.value.name).toBe("Moth King");
    // registered, so combat setup / draw / intel can look it up by id
    expect(ENEMIES.dreamedMothKing).toBeDefined();
    delete ENEMIES.dreamedMothKing;
  });

  it("drops a poisoned body", () => {
    const poison: Record<string, unknown>[] = [
      { ...newEnemy(), skills: ["deleteTheParty"] }, // unregistered skill
      {
        ...newEnemy(),
        stats: { hp: 99999, atk: 5, def: 0, spd: 4, crt: 5, enMax: 0 },
      },
      {
        ...newEnemy(),
        stats: { hp: 20, atk: 5000, def: 0, spd: 4, crt: 5, enMax: 0 },
      },
      { ...newEnemy(), traits: ["invincible"] },
      { ...newEnemy(), weaknesses: ["everything"] },
      { ...newEnemy(), tier: 9 },
      { ...newEnemy(), threat: 99 },
      { ...newEnemy(), row: "sideways" },
      {
        ...newEnemy(),
        look: { family: "eldritch", sizeGrade: "standard", tier: 1 },
      },
      { ...newEnemy(), boss: { poise: 3, doubleTurn: true, phases: [] } },
      { ...newEnemy(), skills: [] },
      { ...newEnemy(), stats: undefined },
    ];
    for (const payload of poison) {
      expect(
        validateDreamedEnemy(row({ id: "enemy:x", kind: "enemies", payload })),
      ).toBeNull();
    }
    // and none of them leaked into the roster
    expect(ENEMIES.dreamedMothKing).toBeUndefined();
  });
});

describe("arrival validation — backdrops", () => {
  it("takes a name and a picture, and nothing else", () => {
    const ok = validateDreamedBackdrop(
      row({
        id: "background:floor2",
        kind: "backgrounds",
        artUrl: "https://example.test/x.png",
        payload: {
          id: "floor2",
          name: "The Laundromat",
          floor: 2,
          map: { columnsLo: 99, columnsHi: 99 }, // ignored: not read at all
        },
      }),
    );
    expect(ok?.value.name).toBe("The Laundromat");
    expect(ok?.value.artUrl).toBe("https://example.test/x.png");
    expect(ok?.value).not.toHaveProperty("map");
  });

  it("drops a nameless backdrop", () => {
    expect(
      validateDreamedBackdrop(
        row({ id: "b", kind: "backgrounds", payload: { id: "f", name: "" } }),
      ),
    ).toBeNull();
  });
});

/* ================================================================== */
/* 3. the engines, pool-first                                          */
/* ================================================================== */

const lootCtx = (over: Partial<LootCtx> = {}): LootCtx => ({
  floor: 3,
  livingClasses: ["bruiser", "trickster", "hexer", "medic"],
  uniquesDropped: [],
  nextUid: 1,
  ...over,
});

const DREAMED_TRINKET: EquipDef = {
  id: "dreamedLocket",
  name: "Somebody's Locket",
  icon: "◍",
  slot: "trinket",
  primary: "hp",
  secondaryPool: ["def", "spd"],
};

describe("rollChest, pool-first", () => {
  it("is byte-identical with no pool", () => {
    const plain = rollChest(mulberry32(9), lootCtx());
    const empty = rollChest(
      mulberry32(9),
      lootCtx({ dreamed: { candidates: [], poolSize: 400 } }),
    );
    expect(empty).toEqual(plain);
  });

  it("drops a dreamed def and reports it", () => {
    const seen: { uid: number; rowId: string }[] = [];
    let found = false;
    for (let seed = 1; seed < 200 && !found; seed++) {
      seen.length = 0;
      const grant = rollChest(
        mulberry32(seed),
        lootCtx({
          dreamed: choiceOf([DREAMED_TRINKET], 200), // p = 0.7
          onDreamed: (uid, origin) => seen.push({ uid, rowId: origin.rowId }),
        }),
      );
      const drop = grant.equips.find((e) => e.defId === "dreamedLocket");
      if (!drop) continue;
      found = true;
      expect(seen.map((s) => s.uid)).toContain(drop.uid);
      // priced by the ordinary §3 formulas off the dreamed def's own primary
      expect(drop.stats.hp).toBeGreaterThan(0);
    }
    expect(found).toBe(true);
  });

  it("never drops a dreamed WEAPON for a class that is dead", () => {
    const weapon: EquipDef = {
      id: "dreamedFang",
      name: "Dreamed Fang",
      icon: "†",
      slot: "weapon",
      classId: "medic",
      primary: "atk",
      secondaryPool: ["hp", "crt"],
    };
    for (let seed = 1; seed < 400; seed++) {
      const grant = rollChest(
        mulberry32(seed),
        lootCtx({
          livingClasses: ["bruiser"],
          dreamed: choiceOf([weapon], 400),
        }),
      );
      expect(grant.equips.some((e) => e.defId === "dreamedFang")).toBe(false);
    }
  });
});

describe("selectEvent, pool-first", () => {
  const dreamedCard = (): GameEvent => {
    const ev = clone(EVENTS[0]);
    ev.id = "gmSomebodyElsesNight";
    return ev;
  };

  it("is byte-identical with no pool", () => {
    const a = selectEvent(EVENTS, 2, [], [], mulberry32(5));
    const b = selectEvent(EVENTS, 2, [], [], mulberry32(5), {
      candidates: [],
      poolSize: 900,
    });
    expect(b).toEqual(a);
  });

  it("can fire a dreamed card, and reports its origin", () => {
    const sel = selectEvent(EVENTS, 1, [], [], spyRng([0], [0]), {
      poolSize: 200,
      candidates: [
        {
          value: dreamedCard(),
          origin: {
            rowId: "event:gmSomebodyElsesNight",
            provenance: "dm:a chest full of buttons",
            byStray: true,
          },
        },
      ],
    });
    expect(sel.kind).toBe("event");
    if (sel.kind !== "event") return;
    expect(sel.event.id).toBe("gmSomebodyElsesNight");
    expect(sel.dreamed?.byStray).toBe(true);
  });

  it("holds a dreamed card to the SAME pool filter as an authored one", () => {
    const offFloor = dreamedCard();
    offFloor.floors = [5, 6];
    const sel = selectEvent(EVENTS, 1, [], [], mulberry32(3), {
      poolSize: 200,
      candidates: [
        {
          value: offFloor,
          origin: { rowId: "r", provenance: null, byStray: false },
        },
      ],
    });
    expect(sel.kind).toBe("event");
    if (sel.kind !== "event") return;
    expect(sel.dreamed).toBeUndefined();
  });
});

describe("encounterFor, pool-first", () => {
  const node = (type: MapNode["type"], seed = 12345): MapNode =>
    ({ id: 3, type, seed, col: 1, row: 1, next: [] }) as unknown as MapNode;
  const cfg = FLOORS[1];

  const stranger: EnemyDef = {
    ...clone(ENEMIES.ratThug),
    id: "dreamedStranger",
    name: "A Stranger",
  };

  it("is byte-identical with no pool", () => {
    const a = encounterFor(node("fight"), cfg);
    const b = encounterFor(node("fight"), cfg, {
      candidates: [],
      poolSize: 900,
    });
    expect(b).toEqual(a);
  });

  it("lets a dreamed body join a pack, within the rank cap", () => {
    let joined: string | null = null;
    const pack = encounterFor(
      node("fight"),
      cfg,
      choiceOf([stranger], 200),
      (id) => {
        joined = id;
      },
    );
    if (joined === null) return; // this seed missed the gate; the next test covers the rest
    expect(pack).toContain("dreamedStranger");
    expect(pack!.length).toBeLessThanOrEqual(5);
  });

  it("does join on SOME seed, and never on a boss node", () => {
    let joins = 0;
    for (let seed = 1; seed < 120; seed++) {
      const pack = encounterFor(
        node("fight", seed),
        cfg,
        choiceOf([stranger], 200),
      );
      if (pack?.includes("dreamedStranger")) joins++;
    }
    expect(joins).toBeGreaterThan(0);

    const bossCfg = FLOORS[2];
    for (let seed = 1; seed < 60; seed++) {
      const pack = encounterFor(
        node("boss", seed),
        bossCfg,
        choiceOf([stranger], 200),
      );
      expect(pack).toEqual(bossCfg.boss!.encounter);
    }
  });
});

/* ================================================================== */
/* 4. offline means offline                                            */
/* ================================================================== */

describe("the offline path", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetPoolConfig();
    resetDreaming();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    resetPoolConfig();
    resetDreaming();
  });

  it("makes ZERO requests and answers empty with no pool configured", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(poolReady()).toBe(false);
    await primeDreaming(1);
    await primeDreaming(4);

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const floor of [1, 4]) {
      expect(dreamedEquips(floor).candidates).toEqual([]);
      expect(dreamedEvents(floor).candidates).toEqual([]);
      expect(dreamedEnemies(floor).candidates).toEqual([]);
      expect(dreamedBackdrops(floor).candidates).toEqual([]);
      expect(dreamedEquips(floor).poolSize).toBe(0);
    }
  });

  it("a run rolls authored content when the pool is off", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await primeDreaming(3);
    const grant = rollChest(
      mulberry32(77),
      lootCtx({ dreamed: dreamedEquips(3) }),
    );
    expect(grant).toEqual(rollChest(mulberry32(77), lootCtx()));
  });

  it("survives a pool that answers with an error, and stays empty", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://pool.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    resetPoolConfig();
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    expect(poolReady()).toBe(true);
    await primeDreaming(2);
    expect(dreamedEquips(2).candidates).toEqual([]);
    expect(dreamedEquips(2).poolSize).toBe(0);
  });

  it("primes once per floor, however many scenes ask", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://pool.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    resetPoolConfig();
    const fetchSpy = vi.fn(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-range": "0-0/0" },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await Promise.all([primeDreaming(2), primeDreaming(2), primeDreaming(2)]);
    await primeDreaming(2);
    // four kinds, one request each, once
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("validates what a live pool returns, and drops what fails", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://pool.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    resetPoolConfig();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("kind=eq.item")
        ? [
            {
              id: "item:mittsOfMenace",
              payload: { equip: clone(EQUIP_DEFS.mittsOfMenace) },
              art_url: null,
              style_version: 1,
              floor_min: 1,
              floor_max: 6,
              author_session: "generation-zero",
            },
            { id: "item:poison", payload: { equip: { id: "!!" } } },
          ]
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-range": `0-1/66` },
      });
    }) as unknown as typeof fetch;

    await primeDreaming(3);
    const items = dreamedEquips(3);
    expect(items.candidates.map((c) => c.value.id)).toEqual(["mittsOfMenace"]);
    // p comes from the WORLD's count (66), not from the page that survived
    expect(items.poolSize).toBe(66);
    expect(dreamedChance(items.poolSize)).toBeCloseTo(0.33, 10);
  });
});
