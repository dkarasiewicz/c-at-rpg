/**
 * c(at)rpg — run-map engine barrel (docs/design/run-map-and-dm.md §2).
 * The whole public surface of `core/map`: types, generator, traversal.
 */
export * from "./types.js";
export {
  ELITE_BUDGET_BONUS,
  encounterFor,
  encounterIndexOf,
  MAX_PACK,
  rollPack,
} from "./encounter.js";
export {
  columnSizes,
  generateFloorMap,
  MAP_STREAM,
  mapRng,
  nodeSeed,
  spanColumns,
  validateFloorMap,
} from "./generate.js";
export {
  advance,
  atTerminal,
  canAdvance,
  closedNodes,
  incoming,
  isAdjacent,
  isVisited,
  optionsForRun,
  optionsFrom,
  outgoing,
} from "./traverse.js";
