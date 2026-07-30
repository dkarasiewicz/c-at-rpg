/**
 * c(at)rpg content — equipment definitions (loot.md §§2-4).
 *
 * 10 fixed EquipDefs: 4 class weapons + 6 universal trinkets. A Mewthical
 * drop of a def IS that def's unique (fixed name + one hook); Cardboard
 * Cuirass and Spiked Collar have no unique (Mewthical rolls of those defs
 * downgrade to Pedigree — loot.md §5). Stat values are formulas, not rolls
 * (loot.md §3) — resolved by core/loot/roll.ts at drop time.
 *
 * Data only: imports core/types.ts and nothing else.
 */
import type { EquipDef, ItemId, Rarity } from "../core/types";

export const EQUIP_DEFS: Record<ItemId, EquipDef> = {
  /* ---- Weapons (primary always atk; class-locked) — loot.md §2 ---------- */
  mittsOfMenace: {
    id: "mittsOfMenace",
    name: "Mitts of Menace",
    icon: "▣",
    slot: "weapon",
    classId: "bruiser",
    primary: "atk",
    secondaryPool: ["hp", "def"],
    uniqueId: "poiseChip2",
    uniqueName: "Dumpster Lid Mitts",
  },
  ribbonRapier: {
    id: "ribbonRapier",
    name: "Ribbon Rapier",
    icon: "⌇",
    slot: "weapon",
    classId: "trickster",
    primary: "atk",
    secondaryPool: ["spd", "crt"],
    uniqueId: "critOffBalance",
    uniqueName: "The Red Dot",
  },
  tangleTalisman: {
    id: "tangleTalisman",
    name: "Tangle Talisman",
    icon: "✶",
    slot: "weapon",
    classId: "hexer",
    primary: "atk",
    secondaryPool: ["crt", "enMax"],
    uniqueId: "appliesAlwaysHit",
    uniqueName: "Grandmother's Cursed Yarn",
  },
  chimeBell: {
    id: "chimeBell",
    name: "Chime Bell",
    icon: "ᛒ",
    slot: "weapon",
    classId: "medic",
    primary: "atk",
    secondaryPool: ["hp", "enMax"],
    uniqueId: "healsGrantMending",
    uniqueName: "Bell of Purrfect Pitch",
  },

  /* ---- Trinkets (universal) — loot.md §2 -------------------------------- */
  fluffyCollar: {
    id: "fluffyCollar",
    name: "Fluffy Collar",
    icon: "◯",
    slot: "trinket",
    primary: "hp",
    secondaryPool: ["def", "spd"],
    uniqueId: "moverOffBalance",
    uniqueName: "Static-Charged Fluff",
  },
  cardboardCuirass: {
    id: "cardboardCuirass",
    name: "Cardboard Cuirass",
    icon: "⩌",
    slot: "trinket",
    primary: "def",
    secondaryPool: ["hp", "spd"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
  tinBell: {
    id: "tinBell",
    name: "Tin Bell",
    icon: "°",
    slot: "trinket",
    primary: "spd",
    secondaryPool: ["crt", "enMax"],
    uniqueId: "ninthBell",
    uniqueName: "The Ninth Bell",
  },
  driedLuckyBeetle: {
    id: "driedLuckyBeetle",
    name: "Dried Lucky Beetle",
    icon: "⋔",
    slot: "trinket",
    primary: "crt",
    secondaryPool: ["spd", "atk"],
    uniqueId: "catPileDouble",
    uniqueName: "Alpha Beetle",
  },
  yarnBangle: {
    id: "yarnBangle",
    name: "Yarn Bangle",
    icon: "❋",
    slot: "trinket",
    primary: "enMax",
    secondaryPool: ["hp", "crt"],
    uniqueId: "startEnergy6",
    uniqueName: "Ball of Pure Yarn",
  },
  spikedCollar: {
    id: "spikedCollar",
    name: "Spiked Collar",
    icon: "ʌ",
    slot: "trinket",
    primary: "atk", // trinket-atk base: ceil((1+L)/2) — loot.md §3
    secondaryPool: ["def", "crt"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
};

/**
 * Rarity meta table — loot.md §3.
 * `mult` scales §3 base values; `secondaryLines`: 0 = none, 1 = one rolled
 * from the pool of 2, 2 = the whole pool. Display name = prefix + def name
 * (Mewthical uses the def's `uniqueName` instead).
 */
export const RARITY_TABLE: Record<
  Rarity,
  { color: number; mult: number; secondaryLines: 0 | 1 | 2; prefix: string }
> = {
  stray: { color: 0x9aa0a6, mult: 1.0, secondaryLines: 0, prefix: "" },
  sleek: { color: 0x4caf50, mult: 1.25, secondaryLines: 1, prefix: "Sleek " },
  pedigree: {
    color: 0x42a5f5,
    mult: 1.5,
    secondaryLines: 2,
    prefix: "Pedigree ",
  },
  mewthical: { color: 0xf2b01e, mult: 1.75, secondaryLines: 2, prefix: "" },
};
