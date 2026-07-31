/**
 * c(at)rpg — shared party inventory (loot.md §8), equip/unequip HP rules
 * (loot.md §2), grief loot, and the MOULT punishment (loot.md §5d).
 *
 * All functions are pure: state in → new state out (structural sharing ok,
 * no mutation of inputs). 16 slots; equipment 1/slot; consumables stack to
 * 5 per slot with automatic same-id merging. Shinies cap at 999 — overflow
 * is discarded ("The pile is tall enough.").
 */
import type {
  CatRunState,
  ConsumableStack,
  EquipInstance,
  EquipSlot,
  Inventory,
  InventorySlot,
  ItemId,
  LootGrant,
  Rng,
  StatKey,
} from "../types.js";
import { EQUIP_SLOTS } from "../types.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { makeEquipInstance } from "./roll.js";

/**
 * The cat's equipment slots, in display/iteration order (types.ts §2.6,
 * progression.md §4). Re-exported here because every slot-generic helper in
 * this file walks it — never hardcode `['weapon','trinket']` again.
 */
export { EQUIP_SLOTS };
export type { EquipSlot };

export const INVENTORY_SLOTS = 16;
export const STACK_MAX = 5;
export const SHINY_CAP = 999;

/** Type guard: is this occupied slot a consumable stack? */
export function isStack(slot: InventorySlot): slot is ConsumableStack {
  return slot !== null && "count" in slot;
}

/** Type guard: is this occupied slot an equipment instance? */
export function isEquip(slot: InventorySlot): slot is EquipInstance {
  return slot !== null && "uid" in slot;
}

/** Fresh empty inventory (16 empty slots, 0 ✦, uid counter at 1). */
export function emptyInventory(): Inventory {
  return {
    shinies: 0,
    slots: new Array<InventorySlot>(INVENTORY_SLOTS).fill(null),
    nextUid: 1,
  };
}

/** Add (or subtract) shinies, clamped to [0, 999]. */
export function addShinies(inv: Inventory, delta: number): Inventory {
  const shinies = Math.max(0, Math.min(SHINY_CAP, inv.shinies + delta));
  return { ...inv, shinies };
}

/** Put an equipment piece into the first empty slot; `added: false` = full. */
export function addEquip(
  inv: Inventory,
  item: EquipInstance,
): { inv: Inventory; added: boolean } {
  const i = inv.slots.indexOf(null);
  if (i === -1) return { inv, added: false };
  const slots = inv.slots.slice();
  slots[i] = item;
  return {
    inv: { ...inv, slots, nextUid: Math.max(inv.nextUid, item.uid + 1) },
    added: true,
  };
}

/**
 * Add consumables: top up existing same-id stacks to 5 first, then open new
 * stacks in empty slots. Returns the count that did not fit (`leftover`).
 */
export function addConsumables(
  inv: Inventory,
  defId: ItemId,
  count: number,
): { inv: Inventory; leftover: number } {
  const slots = inv.slots.slice();
  let left = count;
  for (let i = 0; i < slots.length && left > 0; i++) {
    const s = slots[i];
    if (isStack(s) && s.defId === defId && s.count < STACK_MAX) {
      const take = Math.min(STACK_MAX - s.count, left);
      slots[i] = { defId, count: s.count + take };
      left -= take;
    }
  }
  for (let i = 0; i < slots.length && left > 0; i++) {
    if (slots[i] === null) {
      const take = Math.min(STACK_MAX, left);
      slots[i] = { defId, count: take };
      left -= take;
    }
  }
  return { inv: { ...inv, slots }, leftover: left };
}

/**
 * Apply a LootGrant: shinies (clamped, negatives allowed — TITHE), then
 * equips, then consumables. Whatever does not fit is returned as `overflow`
 * for the full-inventory Take/Leave modal (loot.md §8).
 */
export function applyGrant(
  inv: Inventory,
  grant: LootGrant,
): {
  inv: Inventory;
  overflow: {
    equips: EquipInstance[];
    consumables: { defId: ItemId; count: number }[];
  };
} {
  let cur = addShinies(inv, grant.shinies);
  const overflow: {
    equips: EquipInstance[];
    consumables: { defId: ItemId; count: number }[];
  } = { equips: [], consumables: [] };
  for (const e of grant.equips) {
    const r = addEquip(cur, e);
    cur = r.inv;
    if (!r.added) {
      overflow.equips.push(e);
      // uid was still consumed by the roll — keep the counter past it
      cur = { ...cur, nextUid: Math.max(cur.nextUid, e.uid + 1) };
    }
  }
  for (const c of grant.consumables) {
    const r = addConsumables(cur, c.defId, c.count);
    cur = r.inv;
    if (r.leftover > 0)
      overflow.consumables.push({ defId: c.defId, count: r.leftover });
  }
  return { inv: cur, overflow };
}

/**
 * Consume `count` of a consumable (first matching stacks first). Returns how
 * many were actually removed (0 if the party has none).
 */
export function removeConsumable(
  inv: Inventory,
  defId: ItemId,
  count: number,
): { inv: Inventory; removed: number } {
  const slots = inv.slots.slice();
  let left = count;
  for (let i = 0; i < slots.length && left > 0; i++) {
    const s = slots[i];
    if (isStack(s) && s.defId === defId) {
      const take = Math.min(s.count, left);
      left -= take;
      slots[i] = s.count - take > 0 ? { defId, count: s.count - take } : null;
    }
  }
  return { inv: { ...inv, slots }, removed: count - left };
}

/** Empty one slot outright (drop / sell). Returns what was there. */
export function removeSlot(
  inv: Inventory,
  slotIndex: number,
): { inv: Inventory; removed: InventorySlot } {
  const removed = inv.slots[slotIndex];
  if (removed === null) return { inv, removed: null };
  const slots = inv.slots.slice();
  slots[slotIndex] = null;
  return { inv: { ...inv, slots }, removed };
}

/**
 * Full-inventory "Take" path: put `incoming` into `slotIndex`, returning the
 * replaced item (it drops to the tile — loot.md §8). "Leave it" is simply
 * not calling this.
 */
export function takeReplacing(
  inv: Inventory,
  slotIndex: number,
  incoming: EquipInstance | ConsumableStack,
): { inv: Inventory; dropped: InventorySlot } {
  const dropped = inv.slots[slotIndex];
  const slots = inv.slots.slice();
  slots[slotIndex] = incoming;
  const nextUid = isEquip(incoming)
    ? Math.max(inv.nextUid, incoming.uid + 1)
    : inv.nextUid;
  return { inv: { ...inv, slots, nextUid }, dropped };
}

/**
 * Inventory sort (loot.md §8): equipment first (slot: weapons before
 * trinkets, rarity desc, L desc), then consumables in §7 table order.
 * Pure sort, no gameplay effect.
 */
export function sortInventory(
  inv: Inventory,
  consumableOrder: readonly ItemId[],
): Inventory {
  const rarityRank = { stray: 0, sleek: 1, pedigree: 2, mewthical: 3 };
  const equips = inv.slots.filter(isEquip).sort((a, b) => {
    const slotA = EQUIP_SLOTS.indexOf(EQUIP_DEFS[a.defId].slot);
    const slotB = EQUIP_SLOTS.indexOf(EQUIP_DEFS[b.defId].slot);
    if (slotA !== slotB) return slotA - slotB;
    if (rarityRank[a.rarity] !== rarityRank[b.rarity])
      return rarityRank[b.rarity] - rarityRank[a.rarity];
    return b.itemLevel - a.itemLevel;
  });
  const stacks = inv.slots.filter(isStack).sort((a, b) => {
    return consumableOrder.indexOf(a.defId) - consumableOrder.indexOf(b.defId);
  });
  const slots: InventorySlot[] = [...equips, ...stacks];
  while (slots.length < INVENTORY_SLOTS) slots.push(null);
  return { ...inv, slots };
}

/* ------------------------------------------------------------------ */
/* equip / unequip (loot.md §2)                                        */
/* ------------------------------------------------------------------ */

/**
 * Can this cat wear the item? Weapons are class-locked; trinkets and collars
 * are universal (loot.md §2, progression.md §4).
 */
export function canEquip(cat: CatRunState, item: EquipInstance): boolean {
  const def = EQUIP_DEFS[item.defId];
  return def.slot !== "weapon" || def.classId === cat.classId;
}

/**
 * Equip onto the def's slot. Bonus `hp` raises current HP by the same
 * amount; a replaced item first comes off (its `hp` bonus removed, current
 * HP never below 1) and is returned to the caller for the shared inventory.
 * Exploration-only; the caller enforces timing.
 */
export function equipItem(
  cat: CatRunState,
  item: EquipInstance,
): { cat: CatRunState; replaced: EquipInstance | null } {
  if (!canEquip(cat, item)) {
    throw new Error(`equipItem: ${cat.classId} cannot equip ${item.defId}`);
  }
  const slot = EQUIP_DEFS[item.defId].slot;
  const un = unequipItem(cat, slot);
  const next: CatRunState = {
    ...un.cat,
    [slot]: item,
    hp: un.cat.hp + (item.stats.hp ?? 0),
  };
  return { cat: next, replaced: un.removed };
}

/**
 * Unequip a slot: current HP drops by the item's `hp` bonus, min 1. Slot-
 * generic — an absent (`undefined`) collar on a pre-progression cat behaves
 * exactly like an empty one.
 */
export function unequipItem(
  cat: CatRunState,
  slot: EquipSlot,
): { cat: CatRunState; removed: EquipInstance | null } {
  const removed = cat[slot] ?? null;
  if (!removed) return { cat, removed: null };
  return {
    cat: {
      ...cat,
      [slot]: null,
      hp: Math.max(1, cat.hp - (removed.stats.hp ?? 0)),
    },
    removed,
  };
}

/**
 * Grief loot (loot.md §2): a cat dead for good (0 Lives) drops its equipment
 * into the shared inventory. No HP bookkeeping — the cat is gone. Pieces
 * that don't fit are returned in `overflow` (dropped to the tile).
 */
export function applyGriefLoot(
  cat: CatRunState,
  inv: Inventory,
): {
  cat: CatRunState;
  inv: Inventory;
  dropped: EquipInstance[];
  overflow: EquipInstance[];
} {
  const dropped: EquipInstance[] = [];
  const overflow: EquipInstance[] = [];
  const stripped: CatRunState = { ...cat };
  let cur = inv;
  for (const slot of EQUIP_SLOTS) {
    const item = cat[slot];
    if (!item) continue;
    stripped[slot] = null;
    dropped.push(item);
    const r = addEquip(cur, item);
    cur = r.inv;
    if (!r.added) overflow.push(item);
  }
  return { cat: stripped, inv: cur, dropped, overflow };
}

/* ------------------------------------------------------------------ */
/* MOULT (loot.md §5d)                                                 */
/* ------------------------------------------------------------------ */

const RARITY_DOWN = {
  mewthical: "pedigree",
  pedigree: "sleek",
  sleek: "stray",
  stray: null,
} as const;

/**
 * Downgrade one rarity tier, values recomputed per §3. Mewthical → Pedigree
 * loses its hook; Pedigree → Sleek keeps ONE secondary (1 rng pick over the
 * pool); Sleek → Stray drops its secondary; Stray → destroyed (null).
 */
export function downgradeEquip(
  item: EquipInstance,
  rng: Rng,
): EquipInstance | null {
  const down = RARITY_DOWN[item.rarity];
  if (down === null) return null;
  let sleekSecondary: StatKey | undefined;
  if (down === "sleek") {
    const pool = EQUIP_DEFS[item.defId].secondaryPool;
    sleekSecondary = pool[rng.int(0, 1)];
  }
  return makeEquipInstance(
    item.uid,
    item.defId,
    item.itemLevel,
    down,
    sleekSecondary,
  );
}

export type MoultResult =
  | {
      kind: "downgrade";
      cats: CatRunState[];
      inv: Inventory;
      catIndex: number;
      slot: EquipSlot;
      before: EquipInstance;
      /** null = the item was Stray and is destroyed */
      after: EquipInstance | null;
      /** downgraded item that found no inventory slot (dropped to tile) */
      overflow: EquipInstance[];
    }
  | {
      kind: "damage";
      cats: CatRunState[];
      inv: Inventory;
      catIndex: number;
      damage: number;
    };

/**
 * MOULT punishment bundle (loot.md §5d): a seeded-random EQUIPPED item
 * (uniform over cats' equipped pieces, party order, weapon before trinket)
 * is unequipped (HP rule applies) and downgraded one tier; the survivor
 * lands in the shared inventory. With nothing equipped, a seeded-random
 * living cat loses 12 HP instead (never below 1).
 */
export function applyMoult(
  rng: Rng,
  cats: CatRunState[],
  inv: Inventory,
  fallbackDamage = 12,
): MoultResult {
  const equipped: { catIndex: number; slot: EquipSlot }[] = [];
  cats.forEach((cat, catIndex) => {
    if (cat.lives <= 0) return;
    for (const slot of EQUIP_SLOTS) {
      if (cat[slot]) equipped.push({ catIndex, slot });
    }
  });

  if (equipped.length === 0) {
    const living = cats
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.lives > 0);
    if (living.length === 0)
      return { kind: "damage", cats, inv, catIndex: -1, damage: 0 };
    const pick = living[rng.int(0, living.length - 1)];
    const hp = Math.max(1, pick.c.hp - fallbackDamage);
    const nextCats = cats.slice();
    nextCats[pick.i] = { ...pick.c, hp };
    return {
      kind: "damage",
      cats: nextCats,
      inv,
      catIndex: pick.i,
      damage: pick.c.hp - hp,
    };
  }

  const { catIndex, slot } = equipped[rng.int(0, equipped.length - 1)];
  const un = unequipItem(cats[catIndex], slot);
  const before = un.removed!;
  const after = downgradeEquip(before, rng);
  const nextCats = cats.slice();
  nextCats[catIndex] = un.cat;
  let nextInv = inv;
  const overflow: EquipInstance[] = [];
  if (after) {
    const r = addEquip(nextInv, after);
    nextInv = r.inv;
    if (!r.added) overflow.push(after);
  }
  return {
    kind: "downgrade",
    cats: nextCats,
    inv: nextInv,
    catIndex,
    slot,
    before,
    after,
    overflow,
  };
}
