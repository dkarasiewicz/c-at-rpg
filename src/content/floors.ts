/**
 * FLOORS — the canonical 6-floor run table from GDD §6 (which replaces
 * dungeon.md §1's 9-floor table; same columns and semantics).
 *
 * The tile-maze columns (`w`/`h`/`roomAttempts`/`roamers`/`chests`/`events`)
 * are GONE with the maze itself; each floor now carries the AUTHORED run-map
 * budget instead (docs/design/run-map-and-dm.md §2: "density is authored, not
 * emergent"). Names, enemy pools, threat budgets and bosses are unchanged.
 *
 * Budget shape (`FloorMapBudget`, core/types.ts §2.7):
 *   columnsLo/Hi  how many columns the floor's graph runs, 4..7 (the entry
 *                 column and the boss/stairs column are both included, so a
 *                 5-column floor has 3 columns of real choices between them)
 *   rowsLo/Hi     nodes per intermediate column, 1..4
 *   weights       relative draw weights per node type; a type left out is
 *                 never drawn (that is how floor 1 has no elites)
 *   guaranteed    types forced onto the floor if the draws did not produce
 *                 them — every floor gets at least one shop and one rest
 *
 * Pacing intent: floors 1-2 are short and gentle (no elites on 1), the
 * mid-run floors 4-5 are the widest and densest, and both boss floors (3, 6)
 * are shorter approaches — the floor is the walk-up, the boss is the budget.
 *
 * XP_TO_LEVEL / LEVEL_CAP per classes.md §8.
 */
import type { EnemyId, FloorConfig } from "../core/types.js";

const T1: EnemyId[] = ["ratThug", "sewerBat", "dustBunny", "crowShaman"];
const T2: EnemyId[] = ["roombaScout", "sprinklerImp", "yarnGolem"];
const T3: EnemyId[] = ["porcelainHound", "laserGhost", "trashPanda"];

export const FLOORS: FloorConfig[] = [
  {
    name: "The Cellar",
    pool: [...T1],
    budgetLo: 3,
    budgetHi: 4,
    map: {
      columnsLo: 4,
      columnsHi: 5,
      rowsLo: 2,
      rowsHi: 3,
      weights: { fight: 50, event: 22, treasure: 14, shop: 7, rest: 7 },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Drains",
    pool: [...T1],
    budgetLo: 4,
    budgetHi: 5,
    map: {
      columnsLo: 5,
      columnsHi: 6,
      rowsLo: 2,
      rowsHi: 3,
      weights: {
        fight: 44,
        elite: 8,
        event: 20,
        treasure: 13,
        shop: 7,
        rest: 8,
      },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Appliance Graveyard",
    pool: [...T1, ...T2],
    budgetLo: 5,
    budgetHi: 6,
    boss: { bossId: "vacuumKing", encounter: ["vacuumKing"] },
    map: {
      columnsLo: 4,
      columnsHi: 5,
      rowsLo: 2,
      rowsHi: 3,
      weights: {
        fight: 40,
        elite: 10,
        event: 18,
        treasure: 14,
        shop: 8,
        rest: 10,
      },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Undergarden",
    pool: [...T2],
    budgetLo: 6,
    budgetHi: 8,
    map: {
      columnsLo: 6,
      columnsHi: 7,
      rowsLo: 2,
      rowsHi: 4,
      weights: {
        fight: 40,
        elite: 12,
        event: 18,
        treasure: 13,
        shop: 8,
        rest: 9,
      },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Cold Pantry",
    pool: [...T2, ...T3],
    budgetLo: 8,
    budgetHi: 10,
    map: {
      columnsLo: 6,
      columnsHi: 7,
      rowsLo: 2,
      rowsHi: 4,
      weights: {
        fight: 38,
        elite: 14,
        event: 17,
        treasure: 13,
        shop: 8,
        rest: 10,
      },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Hollow Throne",
    pool: [...T3],
    budgetLo: 10,
    budgetHi: 12,
    boss: { bossId: "dogfather", encounter: ["dogfather", "porcelainHound"] },
    map: {
      columnsLo: 5,
      columnsHi: 6,
      rowsLo: 2,
      rowsHi: 3,
      weights: {
        fight: 36,
        elite: 16,
        event: 16,
        treasure: 12,
        shop: 9,
        rest: 11,
      },
      guaranteed: ["shop", "rest"],
    },
  },
];

export const XP_TO_LEVEL = [0, 30, 70, 130, 210, 310, 430, 570]; // index = level-1
export const LEVEL_CAP = 8;
