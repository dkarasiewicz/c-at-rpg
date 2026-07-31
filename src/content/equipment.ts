/**
 * c(at)rpg content — equipment definitions (loot.md §§2-4).
 *
 * 18 fixed EquipDefs: 4 class weapons + 6 universal trinkets + 8 universal
 * collars (the third slot — docs/design/progression.md §4). A Mewthical
 * drop of a def IS that def's unique (fixed name + one hook); Cardboard
 * Cuirass and Spiked Collar have no unique (Mewthical rolls of those defs
 * downgrade to Pedigree — loot.md §5). Stat values are formulas, not rolls
 * (loot.md §3) — resolved by core/loot/roll.ts at drop time.
 *
 * Data only: imports core/types.ts and nothing else.
 */
import type { EquipDef, ItemId, Rarity } from "../core/types.js";

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

  /* ---- Collars (universal, third slot) — progression.md §4 -------------- */
  /*
   * Eight defensive/utility pieces. NO `atk` and NO `crt` anywhere in the
   * slot: offense is what the weapon and the trinket are for, so a collar
   * choice is always a survivability/tempo choice. Values use the same §3
   * formulas as trinkets (the reduced non-weapon bases).
   *
   * Three carry Mewthical uniques. They draw from the SAME eight-hook menu as
   * the trinkets (no new engine hooks — progression.md §4), which means the
   * unique-or-downgrade rule (loot.md §5) makes them mutually exclusive with
   * their trinket counterpart: exactly one Ninth-Bell-flavoured item, one
   * static-shock item and one battery item can exist per run.
   */
  wovenCollar: {
    id: "wovenCollar",
    name: "Woven Collar",
    icon: "⊂",
    slot: "collar",
    primary: "def",
    secondaryPool: ["hp", "spd"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
  quiltedGorget: {
    id: "quiltedGorget",
    name: "Quilted Gorget",
    icon: "⊓",
    slot: "collar",
    primary: "hp",
    secondaryPool: ["def", "spd"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
  flealessBand: {
    id: "flealessBand",
    name: "Flealess Band",
    icon: "≈",
    slot: "collar",
    primary: "def",
    secondaryPool: ["hp", "enMax"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
  noNameTag: {
    id: "noNameTag",
    name: "The No-Name Tag",
    icon: "⌷",
    slot: "collar",
    primary: "spd",
    secondaryPool: ["def", "hp"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
  leadLinedCollar: {
    id: "leadLinedCollar",
    name: "Lead-Lined Collar",
    icon: "▤",
    slot: "collar",
    primary: "def",
    secondaryPool: ["enMax", "spd"],
    // no unique — Mewthical rolls downgrade to Pedigree
  },
  bubbleWrapRuff: {
    id: "bubbleWrapRuff",
    name: "Bubble-Wrap Ruff",
    icon: "◌",
    slot: "collar",
    primary: "hp",
    secondaryPool: ["def", "enMax"],
    uniqueId: "moverOffBalance",
    uniqueName: "«PACKING MATERIAL»",
  },
  batteryCollar: {
    id: "batteryCollar",
    name: "Battery Collar",
    icon: "⌁",
    slot: "collar",
    primary: "enMax",
    secondaryPool: ["def", "hp"],
    uniqueId: "startEnergy6",
    uniqueName: "«IDLE THROTTLE»",
  },
  wardCollar: {
    id: "wardCollar",
    name: "Ward Collar",
    icon: "☖",
    slot: "collar",
    primary: "hp",
    secondaryPool: ["spd", "enMax"],
    uniqueId: "ninthBell",
    uniqueName: "«THE NINTH WARD»",
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
