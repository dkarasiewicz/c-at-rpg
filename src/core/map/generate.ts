/**
 * c(at)rpg — run-map generator (docs/design/run-map-and-dm.md §2).
 *
 * A floor is a LAYERED DAG: one entry node on the left, 2-5 intermediate
 * columns of 1-4 encounter nodes, one terminal node on the right (the boss on
 * a boss floor, the pack guarding the stairs otherwise). Edges only ever go to
 * the next column, never cross each other, and are built so that
 *
 *   - every node is reachable from the entry,
 *   - every node has at least one outgoing edge (no dead ends) except the
 *     terminal one, so every maximal path ends at the boss/stairs,
 *   - a node offers at most 3 onward routes (the choice is 2-3, not 6).
 *
 * Density is AUTHORED: node types come from the per-floor `FloorMapBudget`
 * in `content/floors.ts` (weights + guarantees), never from emergent chance.
 * Guaranteed: at least one shop and one rest per floor; elites from floor 2
 * on; never two rests joined by an edge.
 *
 * ### RNG (ARCHITECTURE.md §4 stream table)
 *
 * One dedicated stream, `mapRng = mulberry32(hash(runSeed, floor, 'map'))`,
 * consumed in exactly this order — same seed ⇒ same map, always:
 *
 *   1. column count                                     — 1 `int`
 *   2. per intermediate column, its node count          — 1 `int` each
 *   3. per column pair, per left node: the target span  — 1 `float` each
 *      (+ 1 `float` for the "routes converge here?" choice, burned even
 *      when only one branch is legal)
 *   4. the entry node's type                            — 1 `float`
 *   5. per intermediate node, its type                  — 1 `float` each
 *      (constraint fixups re-use the drawn value, they never redraw)
 *   6. per MISSING guaranteed type, the slot it takes   — 1 `int` each
 *
 * Node payload seeds are DERIVED (`hash(runSeed, floor, 'node', id)`), not
 * drawn, so what a node contains never depends on visit order.
 */
import type {
  FloorConfig,
  FloorMap,
  FloorMapBudget,
  MapEdge,
  MapNode,
  NodeType,
  Rng,
} from "../types.js";
import { hash, mulberry32 } from "../rng.js";
import { clamp, pickWeightedFloat } from "../util.js";
import {
  ELITE_MIN_FLOOR,
  ENTRY_TYPES,
  MAX_COLUMNS,
  MAX_OUT_EDGES,
  MAX_ROWS,
  MIN_COLUMNS,
  MIN_ROWS,
  REPLACEABLE_TYPES,
  SAFE_TYPES,
} from "./types.js";

/** The stream tag for `hash(runSeed, floor, …)` — see the table in §4. */
export const MAP_STREAM = "map";

/** The floor's map stream. Created at the boundary, passed down. */
export function mapRng(runSeed: string, floorNum: number): Rng {
  return mulberry32(hash(runSeed, floorNum, MAP_STREAM));
}

/** A node's payload seed — derived, never drawn (see the header). */
export function nodeSeed(
  runSeed: string,
  floorNum: number,
  nodeId: number,
): number {
  return hash(runSeed, floorNum, "node", nodeId);
}

/** Relative weight of an out-degree of 1 / 2 / 3 when spanning a column. */
const SPAN_WEIGHTS = [1, 6, 4];

/** Chance that two neighbouring routes converge on a shared node. */
const CONVERGE_CHANCE = 0.8;

/* ------------------------------------------------------------------ */
/* 1-2. shape: columns and their node counts                           */
/* ------------------------------------------------------------------ */

/**
 * Column sizes, left → right. First and last columns always hold exactly one
 * node (the entry and the boss/stairs). A column is capped at
 * `MAX_OUT_EDGES ×` its predecessor so the predecessor can actually reach
 * every node in it without exceeding 3 routes.
 */
export function columnSizes(rng: Rng, budget: FloorMapBudget): number[] {
  const lo = clamp(budget.columnsLo, MIN_COLUMNS, MAX_COLUMNS);
  const hi = clamp(budget.columnsHi, lo, MAX_COLUMNS);
  const columns = rng.int(lo, hi);

  const rowLo = clamp(budget.rowsLo, MIN_ROWS, MAX_ROWS);
  const rowHi = clamp(budget.rowsHi, rowLo, MAX_ROWS);

  const sizes: number[] = [1];
  for (let c = 1; c < columns - 1; c++) sizes.push(rng.int(rowLo, rowHi));
  sizes.push(1);

  for (let c = 1; c < sizes.length; c++) {
    sizes[c] = Math.min(sizes[c], MAX_OUT_EDGES * sizes[c - 1]);
  }
  return sizes;
}

/* ------------------------------------------------------------------ */
/* 3. edges: a non-crossing, gap-free span per column pair              */
/* ------------------------------------------------------------------ */

/**
 * Link a column of `a` nodes to the next column of `b` nodes and return, per
 * left node, the contiguous run of right-node rows it reaches.
 *
 * Non-crossing ⇔ the runs are monotone and overlap in at most their shared
 * endpoint (`hi[i] <= lo[i+1]`); gap-free coverage of `0..b-1` is what makes
 * every right-hand node reachable. Each run is 1..3 wide, so no node ever
 * offers more than 3 routes.
 */
export function spanColumns(rng: Rng, a: number, b: number): number[][] {
  if (b > MAX_OUT_EDGES * a) {
    throw new Error(`spanColumns: ${a} nodes cannot cover ${b} without gaps`);
  }
  const spans: number[][] = [];
  let lo = 0;
  for (let i = 0; i < a; i++) {
    const rest = a - 1 - i; // runs still to place after this one
    const minHi = Math.max(lo, b - 1 - MAX_OUT_EDGES * rest);
    const maxHi = Math.min(lo + MAX_OUT_EDGES - 1, b - 1);
    if (minHi > maxHi) {
      throw new Error(`spanColumns: infeasible span at ${i} (${a}→${b})`);
    }
    const candidates: number[] = [];
    for (let h = minHi; h <= maxHi; h++) candidates.push(h);
    // one draw, always — even when only one span is legal
    const hi = pickWeightedFloat(
      rng,
      candidates,
      (h) => SPAN_WEIGHTS[h - lo] ?? 1,
    );

    const run: number[] = [];
    for (let t = lo; t <= hi; t++) run.push(t);
    spans.push(run);

    // one draw, always — the "routes converge here?" coin
    const converge = rng.float() < CONVERGE_CHANCE;
    if (i < a - 1) {
      // sharing the endpoint must still leave room to reach the last row
      const canShare =
        hi + (MAX_OUT_EDGES - 1) + MAX_OUT_EDGES * (rest - 1) >= b - 1;
      if (hi >= b - 1) lo = hi;
      else if (!canShare) lo = hi + 1;
      else lo = converge ? hi : hi + 1;
    }
  }
  return spans;
}

/* ------------------------------------------------------------------ */
/* 4-6. types: the authored budget                                     */
/* ------------------------------------------------------------------ */

function weightedTypes(
  budget: FloorMapBudget,
  allow: (t: NodeType) => boolean,
): NodeType[] {
  const out: NodeType[] = [];
  for (const key of Object.keys(budget.weights) as NodeType[]) {
    if ((budget.weights[key] ?? 0) > 0 && allow(key)) out.push(key);
  }
  return out;
}

/**
 * Two SAFE nodes joined by an edge are never allowed (run-map-and-dm.md §2's
 * rest rule, widened to the camp — see `SAFE_TYPES`).
 */
function safeBlocked(
  id: number,
  types: (NodeType | null)[],
  neighbours: number[][],
): boolean {
  return neighbours[id].some((n) => {
    const t = types[n];
    return t !== null && SAFE_TYPES.includes(t);
  });
}

const isSafe = (t: NodeType): boolean => SAFE_TYPES.includes(t);

/* ------------------------------------------------------------------ */
/* the generator                                                       */
/* ------------------------------------------------------------------ */

/**
 * Generate floor `floorNum`'s run map. Deterministic: the same
 * `(runSeed, floorNum, cfg)` always yields a deep-equal `FloorMap`.
 */
export function generateFloorMap(
  runSeed: string,
  floorNum: number,
  cfg: FloorConfig,
): FloorMap {
  const rng = mapRng(runSeed, floorNum);
  const budget = cfg.map;

  // ---- shape ----
  const sizes = columnSizes(rng, budget);
  const columns = sizes.length;
  const firstId: number[] = [];
  let next = 0;
  for (const size of sizes) {
    firstId.push(next);
    next += size;
  }
  const total = next;

  // ---- edges ----
  const edges: MapEdge[] = [];
  const neighbours: number[][] = Array.from({ length: total }, () => []);
  for (let c = 0; c < columns - 1; c++) {
    const spans = spanColumns(rng, sizes[c], sizes[c + 1]);
    for (let i = 0; i < spans.length; i++) {
      const from = firstId[c] + i;
      for (const row of spans[i]) {
        const to = firstId[c + 1] + row;
        edges.push({ from, to });
        neighbours[from].push(to);
        neighbours[to].push(from);
      }
    }
  }

  // ---- types ----
  const entryId = firstId[0];
  const bossId = firstId[columns - 1];
  const types: (NodeType | null)[] = new Array<NodeType | null>(total).fill(
    null,
  );

  // 4. entry: never a shop, a rest, an elite or the boss
  const entryPool = weightedTypes(budget, (t) => ENTRY_TYPES.includes(t));
  types[entryId] =
    entryPool.length > 0
      ? pickWeightedFloat(rng, entryPool, (t) => budget.weights[t] ?? 0)
      : "fight";

  // terminal: the boss on a boss floor, the pack guarding the stairs
  // otherwise. No draw — it is authored by the floor table.
  types[bossId] = cfg.boss ? "boss" : "fight";

  // 5. intermediates, in id (column-major) order
  const intermediates: number[] = [];
  for (let id = 0; id < total; id++) {
    if (id !== entryId && id !== bossId) intermediates.push(id);
  }
  const pool = weightedTypes(
    budget,
    (t) => t !== "boss" && (t !== "elite" || floorNum >= ELITE_MIN_FLOOR),
  );
  for (const id of intermediates) {
    let t: NodeType =
      pool.length > 0
        ? pickWeightedFloat(rng, pool, (x) => budget.weights[x] ?? 0)
        : "fight";
    // constraint fixups — no redraws, they degrade to a plain fight
    if (t === "elite" && floorNum < ELITE_MIN_FLOOR) t = "fight";
    if (isSafe(t) && safeBlocked(id, types, neighbours)) t = "fight";
    types[id] = t;
  }

  // 6. guarantees: at least one of each authored type on the floor
  for (const want of budget.guaranteed) {
    if (types.includes(want)) continue;
    const ok = (id: number): boolean =>
      !isSafe(want) || !safeBlocked(id, types, neighbours);
    let cands = intermediates.filter(
      (id) => REPLACEABLE_TYPES.includes(types[id] as NodeType) && ok(id),
    );
    if (cands.length === 0) {
      cands = intermediates.filter(
        (id) => !budget.guaranteed.includes(types[id] as NodeType) && ok(id),
      );
    }
    // last resort: any intermediate slot the constraint still allows. If even
    // that is empty the type must be a SAFE one AND every slot already
    // touches one — i.e. the guarantee is already met and skipping is right.
    if (cands.length === 0) cands = intermediates.filter(ok);
    if (cands.length === 0) continue;
    types[cands[rng.int(0, cands.length - 1)]] = want;
  }

  // ---- nodes ----
  const nodes: MapNode[] = [];
  for (let c = 0; c < columns; c++) {
    for (let row = 0; row < sizes[c]; row++) {
      const id = firstId[c] + row;
      nodes.push({
        id,
        type: types[id] ?? "fight",
        depth: c,
        row,
        rowCount: sizes[c],
        seed: nodeSeed(runSeed, floorNum, id),
      });
    }
  }

  const map: FloorMap = {
    floor: floorNum,
    columns,
    nodes,
    edges: edges.slice().sort((p, q) => p.from - q.from || p.to - q.to),
    entryId,
    bossId,
  };

  const problems = validateFloorMap(map);
  if (problems.length > 0) {
    throw new Error(
      `generateFloorMap(${runSeed}, ${floorNum}): ${problems.join("; ")}`,
    );
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every invariant the generator promises, as a list of human-readable
 * problems (empty = a good map). Run in the generator itself and in tests.
 */
export function validateFloorMap(map: FloorMap): string[] {
  const bad: string[] = [];
  const n = map.nodes.length;
  if (n === 0) return ["empty map"];

  for (let i = 0; i < n; i++) {
    if (map.nodes[i].id !== i) bad.push(`node ${i} has id ${map.nodes[i].id}`);
  }
  if (map.columns < MIN_COLUMNS || map.columns > MAX_COLUMNS) {
    bad.push(
      `column count ${map.columns} outside ${MIN_COLUMNS}..${MAX_COLUMNS}`,
    );
  }

  const sizes = new Array<number>(map.columns).fill(0);
  for (const node of map.nodes) {
    if (node.depth < 0 || node.depth >= map.columns) {
      bad.push(`node ${node.id} in column ${node.depth}`);
      continue;
    }
    sizes[node.depth]++;
  }
  for (let c = 0; c < map.columns; c++) {
    if (sizes[c] < MIN_ROWS || sizes[c] > MAX_ROWS) {
      bad.push(`column ${c} holds ${sizes[c]} nodes`);
    }
  }
  for (const node of map.nodes) {
    if (node.rowCount !== sizes[node.depth]) {
      bad.push(
        `node ${node.id} rowCount ${node.rowCount} ≠ ${sizes[node.depth]}`,
      );
    }
  }
  if (sizes[0] !== 1) bad.push("entry column is not a single node");
  if (sizes[map.columns - 1] !== 1) bad.push("terminal column is not single");
  if (map.nodes[map.entryId]?.depth !== 0) bad.push("entryId not in column 0");
  if (map.nodes[map.bossId]?.depth !== map.columns - 1) {
    bad.push("bossId not in the terminal column");
  }

  const out: number[][] = Array.from({ length: n }, () => []);
  const inn: number[][] = Array.from({ length: n }, () => []);
  for (const e of map.edges) {
    const from = map.nodes[e.from];
    const to = map.nodes[e.to];
    if (!from || !to) {
      bad.push(`edge ${e.from}→${e.to} references a missing node`);
      continue;
    }
    if (to.depth !== from.depth + 1) {
      bad.push(`edge ${e.from}→${e.to} skips or reverses a column`);
    }
    out[e.from].push(e.to);
    inn[e.to].push(e.from);
  }

  for (const node of map.nodes) {
    const degree = out[node.id].length;
    if (node.id === map.bossId) {
      if (degree > 0) bad.push("the terminal node has outgoing edges");
    } else if (degree === 0) {
      bad.push(`node ${node.id} is a dead end`);
    } else if (degree > MAX_OUT_EDGES) {
      bad.push(`node ${node.id} offers ${degree} routes`);
    }
    if (node.id !== map.entryId && inn[node.id].length === 0) {
      bad.push(`node ${node.id} is an orphan (no way in)`);
    }
  }

  // reachability from the entry
  const seen = new Set<number>([map.entryId]);
  const queue = [map.entryId];
  for (let head = 0; head < queue.length; head++) {
    for (const to of out[queue[head]]) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  if (seen.size !== n) {
    for (const node of map.nodes) {
      if (!seen.has(node.id))
        bad.push(`node ${node.id} unreachable from entry`);
    }
  }

  // no crossing edges: within a column pair, spans must be monotone and may
  // overlap only at a shared endpoint
  const rowOf = (id: number): number => map.nodes[id].row;
  for (const a of map.nodes) {
    for (const b of map.nodes) {
      if (a.depth !== b.depth || a.row >= b.row) continue;
      for (const x of out[a.id]) {
        for (const y of out[b.id]) {
          if (rowOf(x) > rowOf(y)) {
            bad.push(`edges ${a.id}→${x} and ${b.id}→${y} cross`);
          }
        }
      }
    }
  }

  // authored content rules
  for (const e of map.edges) {
    const from = map.nodes[e.from]?.type;
    const to = map.nodes[e.to]?.type;
    if (from && to && SAFE_TYPES.includes(from) && SAFE_TYPES.includes(to)) {
      bad.push(`safe nodes ${e.from} (${from}) and ${e.to} (${to}) adjoin`);
    }
  }
  if (
    map.floor < ELITE_MIN_FLOOR &&
    map.nodes.some((x) => x.type === "elite")
  ) {
    bad.push(`elite on floor ${map.floor}`);
  }

  return bad;
}
