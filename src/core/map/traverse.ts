/**
 * c(at)rpg — run-map traversal (docs/design/run-map-and-dm.md §2).
 *
 * "Edges are the decision": from the current node the party picks among the
 * 2-3 outgoing edges, and the branches it did not take are closed forever.
 * Every move goes through `advance`, which REJECTS anything that is not a
 * single step along an outgoing edge — the UI can never teleport the party.
 *
 * Zero RNG: traversal consumes no draws at all (same rule the tile step loop
 * had, ARCHITECTURE.md §4).
 */
import type { FloorMap, MapNode, RunState } from "../types.js";
import { IllegalMoveError, nodeAt, type MapOption } from "./types.js";

/** Node ids reachable in one step from `nodeId`, in row order. */
export function outgoing(map: FloorMap, nodeId: number): number[] {
  nodeAt(map, nodeId); // existence check
  return map.edges
    .filter((e) => e.from === nodeId)
    .map((e) => e.to)
    .sort((a, b) => map.nodes[a].row - map.nodes[b].row);
}

/** Node ids that lead INTO `nodeId`, in row order. */
export function incoming(map: FloorMap, nodeId: number): number[] {
  nodeAt(map, nodeId);
  return map.edges
    .filter((e) => e.to === nodeId)
    .map((e) => e.from)
    .sort((a, b) => map.nodes[a].row - map.nodes[b].row);
}

/** The routes on offer from `nodeId` — what the run-map scene draws as live. */
export function optionsFrom(map: FloorMap, nodeId: number): MapNode[] {
  return outgoing(map, nodeId).map((id) => map.nodes[id]);
}

/** As `optionsFrom`, tagged with whether the party has already been there. */
export function optionsForRun(run: RunState, nodeId?: number): MapOption[] {
  const map = run.floorMap;
  if (!map) return [];
  const from = nodeId ?? run.currentNodeId;
  if (from === null) return [];
  return optionsFrom(map, from).map((node) => ({
    node,
    visited: run.visitedNodeIds.includes(node.id),
  }));
}

/** True iff `toId` sits one step along an outgoing edge of `fromId`. */
export function isAdjacent(
  map: FloorMap,
  fromId: number,
  toId: number,
): boolean {
  return map.edges.some((e) => e.from === fromId && e.to === toId);
}

/** True iff the party has stood on `nodeId` this floor. */
export function isVisited(run: RunState, nodeId: number): boolean {
  return run.visitedNodeIds.includes(nodeId);
}

/**
 * The guard behind `advance`, as a value instead of an exception — the UI
 * uses it to grey out a medallion, `advance` uses it to refuse the move.
 */
export function canAdvance(
  run: RunState,
  nodeId: number,
): { ok: true } | { ok: false; reason: string } {
  const map = run.floorMap;
  if (!map) return { ok: false, reason: "no floor map generated" };
  const node = map.nodes[nodeId];
  if (!node || node.id !== nodeId) {
    return { ok: false, reason: `no node ${nodeId} on floor ${map.floor}` };
  }
  if (run.currentNodeId === null) {
    return nodeId === map.entryId
      ? { ok: true }
      : { ok: false, reason: "the party has not entered the floor yet" };
  }
  if (nodeId === run.currentNodeId) {
    return { ok: false, reason: "already standing there" };
  }
  if (!isAdjacent(map, run.currentNodeId, nodeId)) {
    return { ok: false, reason: "not one of the outgoing routes" };
  }
  if (isVisited(run, nodeId)) {
    return { ok: false, reason: "already visited" };
  }
  return { ok: true };
}

/**
 * Take one route. Returns a NEW RunState with `currentNodeId` moved and the
 * node appended to `visitedNodeIds`; throws `IllegalMoveError` on any move
 * that is not a legal single step (the non-adjacency guard).
 */
export function advance(run: RunState, nodeId: number): RunState {
  const verdict = canAdvance(run, nodeId);
  if (!verdict.ok) {
    throw new IllegalMoveError(run.currentNodeId, nodeId, verdict.reason);
  }
  return {
    ...run,
    currentNodeId: nodeId,
    visitedNodeIds: [...run.visitedNodeIds, nodeId],
  };
}

/** True once the party stands on the boss / stairs-guard node. */
export function atTerminal(run: RunState): boolean {
  return run.floorMap !== null && run.currentNodeId === run.floorMap.bossId;
}

/** Nodes the party can no longer ever reach (the regret, made visible). */
export function closedNodes(run: RunState): number[] {
  const map = run.floorMap;
  if (!map || run.currentNodeId === null) return [];
  const reachable = new Set<number>([run.currentNodeId]);
  const queue = [run.currentNodeId];
  for (let head = 0; head < queue.length; head++) {
    for (const to of outgoing(map, queue[head])) {
      if (reachable.has(to)) continue;
      reachable.add(to);
      queue.push(to);
    }
  }
  return map.nodes
    .filter((n) => !reachable.has(n.id) && !run.visitedNodeIds.includes(n.id))
    .map((n) => n.id);
}
