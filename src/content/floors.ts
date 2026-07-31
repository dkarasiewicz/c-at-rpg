/**
 * FLOORS — the canonical 6-floor run table from GDD §6 (which replaces
 * dungeon.md §1's 9-floor table; same columns and semantics). Chest counts
 * exclude the boss-lair hoard chest.
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
    w: 31,
    h: 21,
    roomAttempts: 40,
    roamers: 4,
    chests: 2,
    events: 1,
    pool: [...T1],
    budgetLo: 3,
    budgetHi: 4,
  },
  {
    name: "The Drains",
    w: 31,
    h: 21,
    roomAttempts: 40,
    roamers: 5,
    chests: 2,
    events: 1,
    pool: [...T1],
    budgetLo: 4,
    budgetHi: 5,
  },
  {
    name: "The Appliance Graveyard",
    w: 27,
    h: 19,
    roomAttempts: 30,
    roamers: 3,
    chests: 3,
    events: 1,
    pool: [...T1, ...T2],
    budgetLo: 5,
    budgetHi: 6,
    boss: { bossId: "vacuumKing", encounter: ["vacuumKing"] },
  },
  {
    name: "The Undergarden",
    w: 35,
    h: 23,
    roomAttempts: 55,
    roamers: 6,
    chests: 3,
    events: 2,
    pool: [...T2],
    budgetLo: 6,
    budgetHi: 8,
  },
  {
    name: "The Cold Pantry",
    w: 35,
    h: 23,
    roomAttempts: 55,
    roamers: 7,
    chests: 3,
    events: 2,
    pool: [...T2, ...T3],
    budgetLo: 8,
    budgetHi: 10,
  },
  {
    name: "The Hollow Throne",
    w: 29,
    h: 19,
    roomAttempts: 35,
    roamers: 5,
    chests: 4,
    events: 2,
    pool: [...T3],
    budgetLo: 10,
    budgetHi: 12,
    boss: { bossId: "dogfather", encounter: ["dogfather", "porcelainHound"] },
  },
];

export const XP_TO_LEVEL = [0, 30, 70, 130, 210, 310, 430, 570]; // index = level-1
export const LEVEL_CAP = 8;
