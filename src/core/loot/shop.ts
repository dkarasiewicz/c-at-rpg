/**
 * c(at)rpg — The Peddler at the Landing (loot.md §6).
 *
 * Stock is rolled ONCE from the shop stream `mulberry32(hash(runSeed,
 * 'shop', n))` when the landing opens (`n` = the floor just cleared), in §6
 * order:
 *   1. Tuna Snack (always, no roll)
 *   2. Sardine Tin 50 / Warm Milk 50 (one roll)
 *   3. Two rolls on the §7 consumable table (duplicates allowed)
 *   4. 1 equipment piece, L = n+1, rarity sleek 50 / pedigree 40 / mewthical 10
 *   5. Warm Lap (service, once per landing)
 *
 * Prices (loot.md §6): consumable buy = def.price; equipValue(L, r) =
 * round((15 + 9L) · pmult), pmult 1/1.6/2.5/4; Warm Lap 30+15n; sell
 * (anything, landings only) = floor(buy/4), min 1.
 */
import type { EquipInstance, Inventory, ItemId, Rarity, Rng } from "../types";
import { pickWeighted, roundHalfUp } from "../util";
import { CONSUMABLES } from "../../content/consumables";
import { SHOP_GEAR_RARITY } from "../../content/lootTables";
import { rollConsumable, rollOneEquip, type LootCtx } from "./roll";
import {
  addConsumables,
  addEquip,
  addShinies,
  isEquip,
  removeSlot,
} from "./inventory";

/** Price multiplier per rarity (loot.md §6). */
export const PRICE_MULT: Record<Rarity, number> = {
  stray: 1,
  sleek: 1.6,
  pedigree: 2.5,
  mewthical: 4,
};

/** `equipValue(L, r) = round((15 + 9L) · pmult)` — buy price of gear. */
export function equipValue(itemLevel: number, rarity: Rarity): number {
  return roundHalfUp((15 + 9 * itemLevel) * PRICE_MULT[rarity]);
}

/** Buy value of anything sellable (per unit for consumables). */
export function buyValue(item: EquipInstance | ItemId): number {
  return typeof item === "string"
    ? CONSUMABLES[item].price
    : equipValue(item.itemLevel, item.rarity);
}

/** `sell = floor(buy / 4), min 1` (landings only). */
export function sellValue(item: EquipInstance | ItemId): number {
  return Math.max(1, Math.floor(buyValue(item) / 4));
}

/** Warm Lap price after clearing floor `n`: `30 + 15n` (45..105). */
export function warmLapCost(n: number): number {
  return 30 + 15 * n;
}

/** Warm Lap heal per living cat: `round(0.40 × maxHp)`. */
export function warmLapHeal(maxHp: number): number {
  return roundHalfUp(0.4 * maxHp);
}

export type ShopSlot =
  | { kind: "consumable"; defId: ItemId; price: number; sold: boolean }
  | { kind: "equip"; item: EquipInstance; price: number; sold: boolean };

export interface ShopStock {
  slots: ShopSlot[]; // 4 consumables + 1 equipment, §6 order
  warmLapCost: number;
  warmLapUsed: boolean;
}

const SARDINE_OR_MILK: { id: ItemId; weight: number }[] = [
  { id: "sardineTin", weight: 50 },
  { id: "warmMilk", weight: 50 },
];

function consumableSlot(defId: ItemId): ShopSlot {
  return {
    kind: "consumable",
    defId,
    price: CONSUMABLES[defId].price,
    sold: false,
  };
}

/**
 * Roll the landing stock from the shop stream. `ctx.floor` is the floor just
 * cleared (`n`); the gear piece is L = n+1 at sleek 50 / pedigree 40 /
 * mewthical 10 (Mewthical unique-or-downgrade rule applies — a stocked
 * unique counts as dropped this run; caller records `hook` ids).
 */
export function rollShopStock(rng: Rng, ctx: LootCtx): ShopStock {
  const n = ctx.floor;
  const slots: ShopSlot[] = [consumableSlot("tunaSnack")];
  slots.push(
    consumableSlot(pickWeighted(rng, SARDINE_OR_MILK, (c) => c.weight).id),
  );
  slots.push(consumableSlot(rollConsumable(rng)));
  slots.push(consumableSlot(rollConsumable(rng)));
  const item = rollOneEquip(rng, n + 1, SHOP_GEAR_RARITY, ctx);
  slots.push({
    kind: "equip",
    item,
    price: equipValue(item.itemLevel, item.rarity),
    sold: false,
  });
  return { slots, warmLapCost: warmLapCost(n), warmLapUsed: false };
}

/**
 * Buy a stock slot: needs an unsold slot and enough shinies. Consumables add
 * one unit to the party stacks; gear goes to the first empty slot (a full
 * inventory blocks the purchase — `ok: false`, nothing charged).
 */
export function buyStockItem(
  stock: ShopStock,
  slotIndex: number,
  inv: Inventory,
): { stock: ShopStock; inv: Inventory; ok: boolean } {
  const slot = stock.slots[slotIndex];
  if (!slot || slot.sold || inv.shinies < slot.price) {
    return { stock, inv, ok: false };
  }
  let next: Inventory;
  if (slot.kind === "consumable") {
    const r = addConsumables(inv, slot.defId, 1);
    if (r.leftover > 0) return { stock, inv, ok: false };
    next = r.inv;
  } else {
    const r = addEquip(inv, slot.item);
    if (!r.added) return { stock, inv, ok: false };
    next = r.inv;
  }
  next = addShinies(next, -slot.price);
  const slots = stock.slots.slice();
  slots[slotIndex] = { ...slot, sold: true };
  return { stock: { ...stock, slots }, inv: next, ok: true };
}

/**
 * Pay for the Warm Lap (once per landing). Healing itself is applied by the
 * run layer via `warmLapHeal(maxHp)` per living cat.
 */
export function buyWarmLap(
  stock: ShopStock,
  inv: Inventory,
): { stock: ShopStock; inv: Inventory; ok: boolean } {
  if (stock.warmLapUsed || inv.shinies < stock.warmLapCost) {
    return { stock, inv, ok: false };
  }
  return {
    stock: { ...stock, warmLapUsed: true },
    inv: addShinies(inv, -stock.warmLapCost),
    ok: true,
  };
}

/**
 * Sell from the party inventory at the landing: gear sells the whole slot,
 * consumables sell `count` units (default 1). Gained shinies clamp at 999.
 */
export function sellFromInventory(
  inv: Inventory,
  slotIndex: number,
  count = 1,
): { inv: Inventory; gained: number } {
  const slot = inv.slots[slotIndex];
  if (slot === null) return { inv, gained: 0 };
  if (isEquip(slot)) {
    const { inv: next } = removeSlot(inv, slotIndex);
    const gained = sellValue(slot);
    return { inv: addShinies(next, gained), gained };
  }
  const take = Math.min(count, slot.count);
  const slots = inv.slots.slice();
  slots[slotIndex] =
    slot.count - take > 0
      ? { defId: slot.defId, count: slot.count - take }
      : null;
  const gained = sellValue(slot.defId) * take;
  return { inv: addShinies({ ...inv, slots }, gained), gained };
}
