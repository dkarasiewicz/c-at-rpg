/**
 * c(at)rpg content — loot tables (loot.md §§1, 5-7).
 *
 * All weighted rolls are d100 against cumulative weights, drawn from the
 * documented streams in roll order §5e by core/loot/roll.ts. This file is
 * pure data: weights, bundle shapes, and the starting kit.
 *
 * Data only: imports core/types.ts and nothing else.
 */
import type { EquipSlot, ItemId, Rarity } from "../core/types.js";

/**
 * The single consumable table every source references — loot.md §7.
 * Weights sum to exactly 100; array order is the table's roll order and the
 * inventory sort's "table order".
 */
export const CONSUMABLE_WEIGHTS: { id: ItemId; weight: number }[] = [
  { id: "tunaSnack", weight: 20 },
  { id: "sardineTin", weight: 6 },
  { id: "warmMilk", weight: 10 },
  { id: "catnip", weight: 13 },
  { id: "theCucumber", weight: 8 },
  { id: "squeakyToy", weight: 12 },
  { id: "bagOfFleas", weight: 11 },
  { id: "cardboardBox", weight: 12 },
  { id: "canOpenerRecording", weight: 6 },
  { id: "featherWand", weight: 2 },
];

/** Rarity weights by floor band (fights, chests, event GEAR) — loot.md §5. */
export const RARITY_WEIGHTS: Record<
  "f12" | "f34" | "f56",
  Record<Rarity, number>
> = {
  f12: { stray: 55, sleek: 35, pedigree: 9, mewthical: 1 },
  f34: { stray: 30, sleek: 40, pedigree: 25, mewthical: 5 },
  f56: { stray: 15, sleek: 35, pedigree: 40, mewthical: 10 },
};

/**
 * Equipment SLOT roll — loot.md §5 step ⑤, extended for the collar slot
 * (progression.md §4). The weapon band keeps its original 1..40 range so the
 * documented `weapon 40 / trinket 60` split becomes `40 / 40 / 20`: one in
 * five wild equipment drops is now a collar, and no existing recorded stream
 * changes hands at the weapon/trinket boundary.
 */
export const EQUIP_SLOT_WEIGHTS: { slot: EquipSlot; weight: number }[] = [
  { slot: "weapon", weight: 40 },
  { slot: "trinket", weight: 40 },
  { slot: "collar", weight: 20 },
];

/**
 * The Peddler's *gear* slot keeps the original two-slot ladder — the shop
 * stocks a collar in its own dedicated slot every landing (loot.md §6 +
 * progression.md §4), so rolling collars twice there would flood the stall.
 */
export const SHOP_GEAR_SLOT_WEIGHTS: { slot: EquipSlot; weight: number }[] = [
  { slot: "weapon", weight: 40 },
  { slot: "trinket", weight: 60 },
];

/** Chest draw table — 2 independent draws per chest, each on this (§5b). */
export const CHEST_DRAWS: {
  kind: "consumable" | "equipment" | "shinyPile";
  weight: number;
}[] = [
  { kind: "consumable", weight: 60 },
  { kind: "equipment", weight: 30 },
  { kind: "shinyPile", weight: 10 },
];

/* ---- Extra draw constants consumed by core/loot (loot.md §§1, 5a, 5c, 6) - */

/** Regular fight victory drop chances — §5a (rolled in this order). */
export const FIGHT_DROPS = { consumableChance: 0.25, equipmentChance: 0.1 };

/** Boss guaranteed equipment rarity split — §5c (L = floor + 1). */
export const BOSS_RARITY: Record<Rarity, number> = {
  stray: 0,
  sleek: 0,
  pedigree: 70,
  mewthical: 30,
};

/** Boss consumable rolls — §5c. */
export const BOSS_CONSUMABLE_ROLLS = 2;

/** Peddler gear-slot rarity split — §6 (L = n + 1). */
export const SHOP_GEAR_RARITY: Record<Rarity, number> = {
  stray: 0,
  sleek: 50,
  pedigree: 40,
  mewthical: 10,
};

/** Shiny income (n = floor number) — §1. Fight adds rngInt(0, variance). */
export const SHINY_INCOME = {
  fight: { base: 8, perFloor: 4, variance: 4 },
  chest: { base: 15, perFloor: 8 },
  shinyPile: { base: 15, perFloor: 8 },
  boss: { base: 60, perFloor: 25 },
};

/* ---- Event loot bundles — loot.md §5d ---------------------------------- */

export type LootBundle =
  | { kind: "consumableRolls"; rolls: number }
  | { kind: "shinies"; base: number; perFloor: number }
  | {
      kind: "gear";
      /** 'floor' → L = floor; 'floorPlus1' → L = floor + 1 */
      level: "floor" | "floorPlus1";
      /** 'band' → RARITY_WEIGHTS by floor band; else a fixed split */
      rarity: "band" | Record<Rarity, number>;
    }
  | { kind: "tithe"; base: number; perFloor: number }
  | { kind: "moult"; fallbackDamage: number };

export const BUNDLES: Record<
  "SNACK_STASH" | "SHINY_HOARD" | "GEAR" | "GEAR_FANCY" | "TITHE" | "MOULT",
  LootBundle
> = {
  /** 2 consumable rolls (§7). */
  SNACK_STASH: { kind: "consumableRolls", rolls: 2 },
  /** `30 + 10n` ✦. */
  SHINY_HOARD: { kind: "shinies", base: 30, perFloor: 10 },
  /** 1 equipment, rarity by floor band, L = floor. */
  GEAR: { kind: "gear", level: "floor", rarity: "band" },
  /** 1 equipment, L = floor + 1, rarity pedigree 70 / mewthical 30. */
  GEAR_FANCY: {
    kind: "gear",
    level: "floorPlus1",
    rarity: { stray: 0, sleek: 0, pedigree: 70, mewthical: 30 },
  },
  /** Punishment: lose `min(current, 20 + 5n)` ✦. */
  TITHE: { kind: "tithe", base: 20, perFloor: 5 },
  /**
   * Punishment: a seeded-random EQUIPPED item is unequipped and downgraded
   * one rarity tier (values recomputed per §3; sleek→stray drops its
   * secondary; stray → destroyed). No equipped items → a seeded-random cat
   * loses 12 HP (min 1 left) instead.
   */
  MOULT: { kind: "moult", fallbackDamage: 12 },
};

/** Starting kit — loot.md §7 (+ each cat wears its Stray L1 class weapon). */
export const STARTING_KIT: {
  shinies: number;
  consumables: { defId: ItemId; count: number }[];
} = {
  shinies: 20,
  consumables: [
    { defId: "tunaSnack", count: 2 },
    { defId: "cardboardBox", count: 1 },
  ],
};
