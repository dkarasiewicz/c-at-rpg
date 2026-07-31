/**
 * Run-map engine acceptance tests (docs/design/run-map-and-dm.md §2).
 *
 * Covers, across every floor and a spread of seeds:
 *  - determinism (same seed ⇒ byte-identical graph; different seeds diverge),
 *  - shape (4-7 columns, 1-4 nodes per column, single entry, single terminal,
 *    edges only to the next column, ≤3 routes per node),
 *  - topology (full reachability, no orphans, no dead ends, no crossings),
 *  - the authored budget (guaranteed shop + rest, elites only from floor 2,
 *    never two adjacent rests, types confined to the floor's weight table),
 *  - traversal (`optionsFrom`, `advance`, the non-adjacency guard),
 *  - save migration (v1/v2 tile saves load into a fresh map at the same floor).
 */
import { describe, expect, it } from "vitest";
import { FLOORS } from "../src/content/floors.js";
import { hash, mulberry32 } from "../src/core/rng.js";
import type { FloorMap, NodeType, RunState } from "../src/core/types.js";
import {
  ELITE_MIN_FLOOR,
  MAX_COLUMNS,
  MAX_OUT_EDGES,
  MAX_ROWS,
  MIN_COLUMNS,
  MIN_ROWS,
} from "../src/core/map/types.js";
import {
  columnSizes,
  generateFloorMap,
  MAP_STREAM,
  mapRng,
  nodeSeed,
  spanColumns,
  validateFloorMap,
} from "../src/core/map/generate.js";
import {
  ELITE_BUDGET_BONUS,
  encounterFor,
  encounterIndexOf,
  MAX_PACK,
  rollPack,
} from "../src/core/map/encounter.js";
import { ENEMIES } from "../src/content/enemies.js";
import {
  advance,
  atTerminal,
  canAdvance,
  closedNodes,
  incoming,
  isAdjacent,
  optionsForRun,
  optionsFrom,
  outgoing,
} from "../src/core/map/traverse.js";
import {
  descend,
  generateCurrentFloorMap,
  newRun,
} from "../src/core/run/runState.js";
import {
  deserializeRun,
  loadRun,
  memoryStorage,
  migrateSave,
  SAVE_KEY,
  SAVE_VERSION,
  saveRun,
  serializeRun,
} from "../src/core/run/save.js";

const SEED = "MEOW-1987";

/** A decent spread of seeds — enough to shake out rare shapes. */
const SEEDS = [
  "MEOW-1987",
  "PURR-0001",
  "a",
  "",
  "00000000",
  "ffffffff",
  "The Sunbeam",
  "9lives",
  "zzz",
  "cat/rpg",
];

const FLOOR_NUMS = [1, 2, 3, 4, 5, 6];

function mapFor(seed: string, floorNum: number): FloorMap {
  return generateFloorMap(seed, floorNum, FLOORS[floorNum - 1]);
}

/** Every (seed, floor) pair, generated once. */
const ALL: { seed: string; floorNum: number; map: FloorMap }[] = [];
for (const seed of SEEDS) {
  for (const floorNum of FLOOR_NUMS) {
    ALL.push({ seed, floorNum, map: mapFor(seed, floorNum) });
  }
}

/* ---------------------------------------------------------------------- */
/* determinism                                                             */
/* ---------------------------------------------------------------------- */

describe("determinism (combat.md §3 contract, extended)", () => {
  it("same seed + floor ⇒ deep-equal graph, every floor, every seed", () => {
    for (const { seed, floorNum, map } of ALL) {
      expect(mapFor(seed, floorNum)).toEqual(map);
    }
  });

  it("survives a JSON round-trip unchanged (it is plain data)", () => {
    for (const { map } of ALL) {
      expect(JSON.parse(JSON.stringify(map))).toEqual(map);
    }
  });

  it("different seeds and different floors produce different maps", () => {
    const shapes = new Set(ALL.map(({ map }) => JSON.stringify(map)));
    // 60 maps; a handful of tiny floors may legitimately coincide, but the
    // overwhelming majority must be distinct
    expect(shapes.size).toBeGreaterThan(ALL.length * 0.8);
    expect(mapFor("MEOW-1987", 1)).not.toEqual(mapFor("PURR-0001", 1));
  });

  it("draws from its own stream, keyed hash(runSeed, floor, 'map')", () => {
    expect(MAP_STREAM).toBe("map");
    const a = mapRng(SEED, 1);
    const b = mulberry32(hash(SEED, 1, "map"));
    expect([a.float(), a.float(), a.int(0, 99)]).toEqual([
      b.float(),
      b.float(),
      b.int(0, 99),
    ]);
    // and it is NOT the battle / loot / event stream for the same floor
    expect(hash(SEED, 1, "map")).not.toBe(hash(SEED, 1, "gen"));
    expect(hash(SEED, 1, "map")).not.toBe(hash(SEED, 1, "event", 0));
  });

  it("node payload seeds are derived, not drawn (visit order can't matter)", () => {
    for (const { seed, floorNum, map } of ALL) {
      for (const node of map.nodes) {
        expect(node.seed).toBe(nodeSeed(seed, floorNum, node.id));
      }
      // and they are distinct within a floor
      expect(new Set(map.nodes.map((n) => n.seed)).size).toBe(map.nodes.length);
    }
  });
});

/* ---------------------------------------------------------------------- */
/* shape                                                                   */
/* ---------------------------------------------------------------------- */

describe("graph shape", () => {
  it("validates clean for every floor of every seed", () => {
    for (const { seed, floorNum, map } of ALL) {
      expect(validateFloorMap(map), `${seed} floor ${floorNum}`).toEqual([]);
    }
  });

  it("has 4-7 columns, one entry node and one terminal node", () => {
    for (const { map } of ALL) {
      expect(map.columns).toBeGreaterThanOrEqual(MIN_COLUMNS);
      expect(map.columns).toBeLessThanOrEqual(MAX_COLUMNS);
      const byDepth = map.nodes.filter((n) => n.depth === 0);
      expect(byDepth).toHaveLength(1);
      expect(byDepth[0].id).toBe(map.entryId);
      const last = map.nodes.filter((n) => n.depth === map.columns - 1);
      expect(last).toHaveLength(1);
      expect(last[0].id).toBe(map.bossId);
    }
  });

  it("holds 1-4 nodes per column and stamps rowCount to match", () => {
    for (const { map } of ALL) {
      for (let c = 0; c < map.columns; c++) {
        const col = map.nodes.filter((n) => n.depth === c);
        expect(col.length).toBeGreaterThanOrEqual(MIN_ROWS);
        expect(col.length).toBeLessThanOrEqual(MAX_ROWS);
        expect(col.map((n) => n.row)).toEqual(col.map((_, i) => i));
        for (const n of col) expect(n.rowCount).toBe(col.length);
      }
    }
  });

  it("only ever links to the next column", () => {
    for (const { map } of ALL) {
      for (const e of map.edges) {
        expect(map.nodes[e.to].depth).toBe(map.nodes[e.from].depth + 1);
      }
      // no duplicate edges
      expect(new Set(map.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(
        map.edges.length,
      );
    }
  });

  it("offers at most 3 routes from any node — the choice stays legible", () => {
    for (const { map } of ALL) {
      for (const n of map.nodes) {
        expect(outgoing(map, n.id).length).toBeLessThanOrEqual(MAX_OUT_EDGES);
      }
    }
  });

  it("actually branches: every floor poses a real 2-3 way choice", () => {
    for (const { seed, floorNum, map } of ALL) {
      const branchy = map.nodes.filter(
        (n) => outgoing(map, n.id).length >= 2,
      ).length;
      expect(branchy, `${seed} floor ${floorNum}`).toBeGreaterThan(0);
    }
  });

  it("branches wherever the layout allows one", () => {
    // A node can only branch when its next column holds 2+ nodes; a strictly
    // non-crossing layer can carry at most `next - 1` branching nodes, so this
    // ratio has a hard ceiling well under 1.
    let branching = 0;
    let couldBranch = 0;
    for (const { map } of ALL) {
      const sizes = new Array<number>(map.columns).fill(0);
      for (const n of map.nodes) sizes[n.depth]++;
      for (const n of map.nodes) {
        if (n.id === map.bossId || sizes[n.depth + 1] < 2) continue;
        couldBranch++;
        if (outgoing(map, n.id).length >= 2) branching++;
      }
    }
    expect(branching / couldBranch).toBeGreaterThan(0.45);
  });
});

/* ---------------------------------------------------------------------- */
/* topology                                                                */
/* ---------------------------------------------------------------------- */

describe("topology", () => {
  it("reaches every node from the entry (no orphans)", () => {
    for (const { seed, floorNum, map } of ALL) {
      const seen = new Set([map.entryId]);
      const q = [map.entryId];
      for (let h = 0; h < q.length; h++) {
        for (const to of outgoing(map, q[h])) {
          if (!seen.has(to)) {
            seen.add(to);
            q.push(to);
          }
        }
      }
      expect(seen.size, `${seed} floor ${floorNum}`).toBe(map.nodes.length);
      for (const n of map.nodes) {
        if (n.id !== map.entryId) {
          expect(incoming(map, n.id).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("has no dead ends: every path terminates at the boss/stairs node", () => {
    for (const { map } of ALL) {
      for (const n of map.nodes) {
        const out = outgoing(map, n.id);
        if (n.id === map.bossId) expect(out).toEqual([]);
        else expect(out.length).toBeGreaterThan(0);
      }
      // exhaustive walk: every maximal path ends on bossId
      const ends = new Set<number>();
      const walk = (id: number): void => {
        const out = outgoing(map, id);
        if (out.length === 0) {
          ends.add(id);
          return;
        }
        for (const to of out) walk(to);
      };
      walk(map.entryId);
      expect([...ends]).toEqual([map.bossId]);
    }
  });

  it("never crosses two routes", () => {
    for (const { map } of ALL) {
      for (const a of map.nodes) {
        for (const b of map.nodes) {
          if (a.depth !== b.depth || a.row >= b.row) continue;
          for (const x of outgoing(map, a.id)) {
            for (const y of outgoing(map, b.id)) {
              expect(map.nodes[x].row).toBeLessThanOrEqual(map.nodes[y].row);
            }
          }
        }
      }
    }
  });

  it("spanColumns covers every target with a non-crossing, gap-free span", () => {
    for (let a = 1; a <= MAX_ROWS; a++) {
      for (let b = 1; b <= MAX_ROWS; b++) {
        if (b > MAX_OUT_EDGES * a) continue; // shape repair forbids this pair
        for (let t = 0; t < 40; t++) {
          const spans = spanColumns(mulberry32(hash("span", a, b, t)), a, b);
          expect(spans).toHaveLength(a);
          const covered = new Set<number>();
          let prevHi = -1;
          for (const run of spans) {
            expect(run.length).toBeGreaterThan(0);
            expect(run.length).toBeLessThanOrEqual(MAX_OUT_EDGES);
            expect(run[0]).toBeGreaterThanOrEqual(prevHi); // no crossings
            for (const r of run) covered.add(r);
            prevHi = run[run.length - 1];
          }
          expect(covered.size).toBe(b); // every target reachable
          expect(prevHi).toBe(b - 1); // and the span lands on the last row
        }
      }
    }
  });

  it("columnSizes never asks a column to cover more than 3× itself", () => {
    for (const cfg of FLOORS) {
      for (let t = 0; t < 200; t++) {
        const sizes = columnSizes(
          mulberry32(hash("sizes", cfg.name, t)),
          cfg.map,
        );
        expect(sizes[0]).toBe(1);
        expect(sizes[sizes.length - 1]).toBe(1);
        expect(sizes.length).toBeGreaterThanOrEqual(MIN_COLUMNS);
        expect(sizes.length).toBeLessThanOrEqual(MAX_COLUMNS);
        for (let c = 1; c < sizes.length; c++) {
          expect(sizes[c]).toBeLessThanOrEqual(MAX_OUT_EDGES * sizes[c - 1]);
        }
      }
    }
  });
});

/* ---------------------------------------------------------------------- */
/* the authored budget                                                     */
/* ---------------------------------------------------------------------- */

describe("authored node budget (content/floors.ts)", () => {
  it("keeps the 6 floors, their names, pools, budgets and bosses", () => {
    expect(FLOORS.map((f) => f.name)).toEqual([
      "The Cellar",
      "The Drains",
      "The Appliance Graveyard",
      "The Undergarden",
      "The Cold Pantry",
      "The Hollow Throne",
    ]);
    // Retuned around the two-cat opening (balance-and-meta.md §2/§3):
    // every floor sheds roughly one body, and ENEMY_CURVE supplies the
    // pressure that pack size used to.
    expect(FLOORS.map((f) => [f.budgetLo, f.budgetHi])).toEqual([
      [2, 4],
      [4, 5],
      [5, 7],
      [6, 7],
      [6, 8],
      [7, 9],
    ]);
    expect(FLOORS[2].boss).toEqual({
      bossId: "vacuumKing",
      encounter: ["vacuumKing"],
    });
    expect(FLOORS[5].boss).toEqual({
      bossId: "dogfather",
      encounter: ["dogfather", "porcelainHound"],
    });
    expect(FLOORS.filter((f) => f.boss)).toHaveLength(2);
  });

  it("every floor budget is inside the generator's shape limits", () => {
    for (const cfg of FLOORS) {
      const b = cfg.map;
      expect(b.columnsLo).toBeGreaterThanOrEqual(MIN_COLUMNS);
      expect(b.columnsHi).toBeLessThanOrEqual(MAX_COLUMNS);
      expect(b.columnsLo).toBeLessThanOrEqual(b.columnsHi);
      expect(b.rowsLo).toBeGreaterThanOrEqual(MIN_ROWS);
      expect(b.rowsHi).toBeLessThanOrEqual(MAX_ROWS);
      expect(b.rowsLo).toBeLessThanOrEqual(b.rowsHi);
      expect(b.guaranteed).toEqual(["shop", "rest"]);
      expect(Object.values(b.weights).every((w) => w > 0)).toBe(true);
    }
  });

  it("guarantees a shop AND a rest on every floor", () => {
    for (const { seed, floorNum, map } of ALL) {
      const types = map.nodes.map((n) => n.type);
      expect(types, `${seed} floor ${floorNum}`).toContain("shop");
      expect(types, `${seed} floor ${floorNum}`).toContain("rest");
    }
  });

  it("never places two rests next to each other", () => {
    for (const { map } of ALL) {
      for (const e of map.edges) {
        const pair = [map.nodes[e.from].type, map.nodes[e.to].type];
        expect(pair).not.toEqual(["rest", "rest"]);
      }
    }
  });

  it("places elites only from floor 2 on", () => {
    for (const { floorNum, map } of ALL) {
      const elites = map.nodes.filter((n) => n.type === "elite");
      if (floorNum < ELITE_MIN_FLOOR) expect(elites).toEqual([]);
    }
    // and they do show up later (floors 2-6 authored an elite weight)
    const later = ALL.filter((x) => x.floorNum >= ELITE_MIN_FLOOR);
    expect(later.some((x) => x.map.nodes.some((n) => n.type === "elite"))).toBe(
      true,
    );
  });

  it("only uses types the floor's weight table authorises", () => {
    for (const { floorNum, map } of ALL) {
      const cfg = FLOORS[floorNum - 1];
      const allowed = new Set<NodeType>(
        Object.keys(cfg.map.weights) as NodeType[],
      );
      for (const t of cfg.map.guaranteed) allowed.add(t);
      if (cfg.boss) allowed.add("boss");
      for (const n of map.nodes) expect(allowed.has(n.type)).toBe(true);
    }
  });

  it("terminates on the boss on boss floors, on a fight otherwise", () => {
    for (const { floorNum, map } of ALL) {
      const terminal = map.nodes[map.bossId];
      expect(terminal.type).toBe(FLOORS[floorNum - 1].boss ? "boss" : "fight");
      // exactly one boss medallion, and only on a boss floor
      expect(map.nodes.filter((n) => n.type === "boss").length).toBe(
        FLOORS[floorNum - 1].boss ? 1 : 0,
      );
    }
  });

  it("never opens the floor on a shop, a rest, an elite or the boss", () => {
    for (const { map } of ALL) {
      expect(["fight", "event", "treasure"]).toContain(
        map.nodes[map.entryId].type,
      );
    }
  });

  it("keeps the floor a walk, not a slog: 5-20 encounters", () => {
    for (const { seed, floorNum, map } of ALL) {
      expect(
        map.nodes.length,
        `${seed} floor ${floorNum}`,
      ).toBeGreaterThanOrEqual(5);
      expect(map.nodes.length, `${seed} floor ${floorNum}`).toBeLessThanOrEqual(
        20,
      );
    }
  });
});

/* ---------------------------------------------------------------------- */
/* node payloads                                                           */
/* ---------------------------------------------------------------------- */

describe("node encounters", () => {
  it("gives every fight/elite/boss node a legal 2-5 wide pack", () => {
    for (const { seed, floorNum, map } of ALL) {
      const cfg = FLOORS[floorNum - 1];
      for (const node of map.nodes) {
        const pack = encounterFor(node, cfg);
        const fight =
          node.type === "fight" ||
          node.type === "elite" ||
          (node.type === "boss" && cfg.boss !== undefined);
        if (!fight) {
          expect(pack, `${seed} f${floorNum} node ${node.id}`).toBeNull();
          continue;
        }
        expect(pack).not.toBeNull();
        expect(pack!.length).toBeGreaterThanOrEqual(1);
        expect(pack!.length).toBeLessThanOrEqual(MAX_PACK);
        for (const id of pack!) expect(ENEMIES[id]).toBeDefined();
      }
    }
  });

  it("draws packs from the floor's own species pool", () => {
    for (const { floorNum, map } of ALL) {
      const cfg = FLOORS[floorNum - 1];
      for (const node of map.nodes) {
        if (node.type !== "fight" && node.type !== "elite") continue;
        for (const id of encounterFor(node, cfg)!) {
          expect(cfg.pool).toContain(id);
        }
      }
    }
  });

  it("uses the authored boss encounter verbatim on boss floors", () => {
    for (const { floorNum, map } of ALL) {
      const cfg = FLOORS[floorNum - 1];
      if (!cfg.boss) continue;
      expect(encounterFor(map.nodes[map.bossId], cfg)).toEqual(
        cfg.boss.encounter,
      );
    }
  });

  it("is deterministic from the node seed alone, never from visit order", () => {
    const cfg = FLOORS[3];
    const map = mapFor(SEED, 4);
    for (const node of map.nodes) {
      expect(encounterFor(node, cfg)).toEqual(encounterFor(node, cfg));
      expect(encounterIndexOf(node)).toBe(node.id);
    }
  });

  it("spends more threat on an elite than on a plain fight", () => {
    const cfg = FLOORS[5];
    const threat = (ids: string[]): number =>
      ids.reduce((n, id) => n + ENEMIES[id].threat, 0);
    let plain = 0;
    let elite = 0;
    for (let i = 0; i < 200; i++) {
      plain += threat(
        rollPack(
          mulberry32(hash("pack", i)),
          cfg.pool,
          cfg.budgetLo,
          cfg.budgetHi,
        ),
      );
      elite += threat(
        rollPack(
          mulberry32(hash("pack", i)),
          cfg.pool,
          cfg.budgetLo + ELITE_BUDGET_BONUS,
          cfg.budgetHi + ELITE_BUDGET_BONUS,
        ),
      );
    }
    expect(elite).toBeGreaterThan(plain);
  });

  it("never rolls a solo pack when the pool allows a second body", () => {
    for (const cfg of FLOORS) {
      for (let i = 0; i < 100; i++) {
        const pack = rollPack(
          mulberry32(hash("solo", cfg.name, i)),
          cfg.pool,
          cfg.budgetLo,
          cfg.budgetHi,
        );
        expect(pack.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

/* ---------------------------------------------------------------------- */
/* traversal                                                               */
/* ---------------------------------------------------------------------- */

describe("traversal", () => {
  const run0 = (): RunState => generateCurrentFloorMap(newRun(SEED));

  it("starts the party on the entry node, already visited", () => {
    const run = run0();
    expect(run.floorMap).not.toBeNull();
    expect(run.currentNodeId).toBe(run.floorMap!.entryId);
    expect(run.visitedNodeIds).toEqual([run.floorMap!.entryId]);
  });

  it("optionsFrom lists the outgoing edges in row order", () => {
    const map = mapFor(SEED, 1);
    for (const n of map.nodes) {
      const opts = optionsFrom(map, n.id);
      expect(opts.map((o) => o.id)).toEqual(outgoing(map, n.id));
      expect(opts.map((o) => o.row)).toEqual(
        opts
          .map((o) => o.row)
          .slice()
          .sort((a, b) => a - b),
      );
      for (const o of opts) expect(o.depth).toBe(n.depth + 1);
    }
  });

  it("advance walks one edge and records the visit", () => {
    let run = run0();
    const map = run.floorMap!;
    let steps = 0;
    while (run.currentNodeId !== map.bossId) {
      const opts = optionsForRun(run);
      expect(opts.length).toBeGreaterThan(0);
      const before = run.currentNodeId!;
      run = advance(run, opts[0].node.id);
      expect(isAdjacent(map, before, run.currentNodeId!)).toBe(true);
      expect(run.visitedNodeIds[run.visitedNodeIds.length - 1]).toBe(
        run.currentNodeId,
      );
      if (steps++ > 20) throw new Error("walk did not terminate");
    }
    expect(atTerminal(run)).toBe(true);
    expect(run.visitedNodeIds).toHaveLength(map.columns);
    expect(optionsForRun(run)).toEqual([]);
  });

  it("rejects a move to a non-adjacent node", () => {
    const run = run0();
    const map = run.floorMap!;
    const legal = new Set(outgoing(map, run.currentNodeId!));
    const illegal = map.nodes.find(
      (n) => !legal.has(n.id) && n.id !== run.currentNodeId,
    )!;
    expect(canAdvance(run, illegal.id)).toEqual({
      ok: false,
      reason: "not one of the outgoing routes",
    });
    expect(() => advance(run, illegal.id)).toThrow(/illegal map move/);
    // the boss is never reachable in one hop from the entry on a 4+ column map
    expect(() => advance(run, map.bossId)).toThrow();
  });

  it("rejects standing still, unknown nodes, and a mapless run", () => {
    const run = run0();
    expect(() => advance(run, run.currentNodeId!)).toThrow(/already standing/);
    expect(() => advance(run, 9999)).toThrow(/no node 9999/);
    const blank = newRun(SEED);
    expect(canAdvance(blank, 0)).toEqual({
      ok: false,
      reason: "no floor map generated",
    });
    expect(optionsForRun(blank)).toEqual([]);
  });

  it("closes the branches not taken (the regret is the point)", () => {
    let run = run0();
    const map = run.floorMap!;
    const opts = optionsForRun(run);
    if (opts.length > 1) {
      run = advance(run, opts[0].node.id);
      const closed = closedNodes(run);
      expect(closed).toContain(opts[1].node.id);
      expect(closed).not.toContain(map.bossId);
      for (const id of closed) expect(canAdvance(run, id).ok).toBe(false);
    }
  });

  it("descend regenerates the map and resets traversal to the new entry", () => {
    const run = descend(run0());
    expect(run.floorNum).toBe(2);
    expect(run.floorMap!.floor).toBe(2);
    expect(run.floorMap).toEqual(mapFor(SEED, 2));
    expect(run.currentNodeId).toBe(run.floorMap!.entryId);
    expect(run.visitedNodeIds).toEqual([run.floorMap!.entryId]);
  });
});

/* ---------------------------------------------------------------------- */
/* save & migration                                                        */
/* ---------------------------------------------------------------------- */

describe("save", () => {
  /** A run part-way across floor 3's map. */
  function midFloorRun(): RunState {
    let run = generateCurrentFloorMap({
      ...newRun(SEED),
      floorNum: 3,
      floorMap: null,
      currentNodeId: null,
      visitedNodeIds: [],
    });
    run = advance(run, optionsForRun(run)[0].node.id);
    run = advance(run, optionsForRun(run)[0].node.id);
    return run;
  }

  it("SAVE_VERSION is 3 and serializeRun drops the regenerable map", () => {
    expect(SAVE_VERSION).toBe(3);
    const sf = serializeRun(midFloorRun());
    expect(sf.version).toBe(3);
    expect("floorMap" in sf.run).toBe(false);
    expect(sf.floorDelta).toBeUndefined();
  });

  it("round-trips a mid-floor run to a deep-equal RunState", () => {
    const run = midFloorRun();
    const wire = JSON.parse(JSON.stringify(serializeRun(run)));
    expect(deserializeRun(wire)).toEqual(run);
    const storage = memoryStorage();
    saveRun(run, storage);
    expect(loadRun(storage)).toEqual(run);
  });

  it("refuses to serialize a run with no map generated", () => {
    expect(() => serializeRun(newRun(SEED))).toThrow(/no run map/);
  });

  it("a v2 tile save loads into a fresh map at the same floor", () => {
    const storage = memoryStorage();
    const live = midFloorRun();
    // a genuine pre-run-map blob: version 2, a `run.floor` FloorState and a
    // FloorDelta beside it, and none of the run-map fields
    const legacy = JSON.parse(JSON.stringify(serializeRun(live))) as Record<
      string,
      unknown
    >;
    const legacyRun = legacy.run as Record<string, unknown>;
    delete legacyRun.currentNodeId;
    delete legacyRun.visitedNodeIds;
    legacyRun.floor = { floor: 3, w: 31, h: 21, party: { x: 3, y: 3 } };
    legacy.version = 2;
    legacy.floorDelta = { partyPos: { x: 3, y: 3 }, explored: "AAAA" };

    const migrated = migrateSave(legacy as never)!;
    expect(migrated.version).toBe(3);
    expect("floor" in migrated.run).toBe(false);
    expect(migrated.run.currentNodeId).toBeNull();
    expect(migrated.run.visitedNodeIds).toEqual([]);

    storage.set(SAVE_KEY, JSON.stringify(legacy));
    const loaded = loadRun(storage)!;
    expect(loaded).not.toBeNull();
    // same floor, same party, same wallet — a freshly generated map, at entry
    expect(loaded.floorNum).toBe(3);
    expect(loaded.floorMap).toEqual(mapFor(SEED, 3));
    expect(loaded.currentNodeId).toBe(loaded.floorMap!.entryId);
    expect(loaded.visitedNodeIds).toEqual([loaded.floorMap!.entryId]);
    expect(loaded.cats).toEqual(live.cats);
    expect(loaded.inventory).toEqual(live.inventory);
    expect(loaded.xp).toBe(live.xp);
    expect(storage.get(SAVE_KEY)).not.toBeNull(); // migrated, not discarded
  });

  it("a v1 save migrates all the way forward too", () => {
    const legacy = JSON.parse(
      JSON.stringify(serializeRun(midFloorRun())),
    ) as Record<string, unknown>;
    legacy.version = 1;
    const migrated = migrateSave(legacy as never)!;
    expect(migrated.version).toBe(3);
    const storage = memoryStorage();
    storage.set(SAVE_KEY, JSON.stringify(legacy));
    expect(loadRun(storage)!.floorNum).toBe(3);
  });

  it("an unknown version is still discarded", () => {
    const storage = memoryStorage();
    const sf = serializeRun(midFloorRun());
    expect(migrateSave({ ...sf, version: 99 } as never)).toBeNull();
    storage.set(SAVE_KEY, JSON.stringify({ ...sf, version: 99 }));
    expect(loadRun(storage)).toBeNull();
    expect(storage.get(SAVE_KEY)).toBeNull();
  });

  it("a save pointing at a node the map no longer has restarts at entry", () => {
    const run = midFloorRun();
    const sf = serializeRun(run);
    const bent = { ...sf, run: { ...sf.run, currentNodeId: 12345 } };
    const loaded = deserializeRun(bent);
    expect(loaded.currentNodeId).toBe(loaded.floorMap!.entryId);
    expect(loaded.visitedNodeIds).toEqual([loaded.floorMap!.entryId]);
  });
});
