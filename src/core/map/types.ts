/**
 * c(at)rpg — run-map types (docs/design/run-map-and-dm.md §2).
 *
 * The wire shapes (`NodeType`, `MapNode`, `MapEdge`, `FloorMap`,
 * `FloorMapBudget`, `FloorConfig`) live in `core/types.ts` because
 * `src/content` is only allowed to import that file (ARCHITECTURE.md §0).
 * This module re-exports them so map code has one import, and adds the
 * engine-only constants and helper shapes on top.
 */
export type {
  FloorConfig,
  FloorMap,
  FloorMapBudget,
  MapEdge,
  MapNode,
  NodeType,
} from "../types.js";

import type { FloorMap, MapNode, NodeType } from "../types.js";

/** Every node type, in medallion/display order. Asset id = `node:<type>`. */
export const NODE_TYPES: readonly NodeType[] = [
  "fight",
  "elite",
  "event",
  "shop",
  "rest",
  "camp",
  "treasure",
  "boss",
];

/**
 * Nodes the party is SAFE on — a warm spot or a camp fire. Two of them joined
 * by an edge is never allowed (the rest rule in run-map-and-dm.md §2, widened
 * when the camp arrived): back-to-back safety turns a floor's attrition off,
 * and the choice between "mend everyone a little" and "spend the fire on one
 * of them" only means something if you cannot have both in a row.
 */
export const SAFE_TYPES: readonly NodeType[] = ["rest", "camp"];

/* ------------------------------------------------------------------ */
/* generator shape constants (run-map-and-dm.md §2)                    */
/* ------------------------------------------------------------------ */

/** Columns per floor, entry + terminal column included. */
export const MIN_COLUMNS = 4;
export const MAX_COLUMNS = 7;

/** Nodes per intermediate column. */
export const MIN_ROWS = 1;
export const MAX_ROWS = 4;

/** A node never offers more than this many onward routes (the choice is 2-3). */
export const MAX_OUT_EDGES = 3;

/**
 * Types the entry node may take: the floor never opens on a shop, a rest,
 * an elite or the boss — the first medallion is always something to walk into.
 */
export const ENTRY_TYPES: readonly NodeType[] = ["fight", "event", "treasure"];

/**
 * Types a guarantee pass is allowed to overwrite. Never an elite, never the
 * boss, never another guaranteed node.
 */
export const REPLACEABLE_TYPES: readonly NodeType[] = [
  "fight",
  "event",
  "treasure",
];

/** Elites do not appear before this floor (run-map-and-dm.md §2). */
export const ELITE_MIN_FLOOR = 2;

/* ------------------------------------------------------------------ */
/* traversal                                                           */
/* ------------------------------------------------------------------ */

/** One legal onward route from the party's current node. */
export interface MapOption {
  node: MapNode;
  /** already stood on (only possible on a corrupt/hand-built map) */
  visited: boolean;
}

/** Thrown by `advance` when a move is not along an outgoing edge. */
export class IllegalMoveError extends Error {
  constructor(
    readonly fromId: number | null,
    readonly toId: number,
    reason: string,
  ) {
    super(`illegal map move ${fromId ?? "∅"} → ${toId}: ${reason}`);
    this.name = "IllegalMoveError";
  }
}

/** `map.nodes[id]`, with a real error instead of `undefined`. */
export function nodeAt(map: FloorMap, id: number): MapNode {
  const n = map.nodes[id];
  if (!n || n.id !== id) throw new Error(`no map node ${id}`);
  return n;
}
