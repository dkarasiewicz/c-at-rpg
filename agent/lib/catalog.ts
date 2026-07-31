/**
 * The closed menus the DM picks from: the shipped item ids and the per-floor
 * currency cap.
 *
 * "From the existing item/hook menu" (docs/design/run-map-and-dm.md §4): the DM
 * hands out things the game already knows how to render, equip and consume. It
 * cannot invent an item — authoring a NEW `EquipDef` is a separate, schema'd
 * capability (the one-shot item generator), not something a narration beat may
 * do in passing.
 */
import { CONSUMABLES } from "../../src/content/consumables.js";
import { EQUIP_DEFS } from "../../src/content/equipment.js";
import type { ItemId } from "../../src/core/types.js";
// MIGRATION NOTE: `EVENT_CAPS` is the per-floor numeric cap table
// (docs/design/run-map-and-dm.md §3 "per-floor numeric caps, exactly as
// /api/gm/eventResolve already does"). It lives in the api package today. When
// `api/gm/*` is retired, move EVENT_CAPS into `src/core` (or here) and update
// this one import — do NOT copy the numbers.
import { EVENT_CAPS } from "../../api/_lib/constraints.js";

export { EVENT_CAPS };

/** Every consumable and equipment id that exists in the game. */
export const ITEM_IDS = [
  ...Object.keys(CONSUMABLES),
  ...Object.keys(EQUIP_DEFS),
] as [ItemId, ...ItemId[]];

const ITEM_SET = new Set<string>(ITEM_IDS);

export function isKnownItem(id: string): boolean {
  return ITEM_SET.has(id);
}

/** Human label for a known id, for the tool's echo back to the model. */
export function itemLabel(id: ItemId): string {
  return CONSUMABLES[id]?.name ?? EQUIP_DEFS[id]?.name ?? id;
}

/** `|shinies|` ceiling on this floor — the same table event options obey. */
export function shiniesCap(floor: number): number {
  return EVENT_CAPS.shiniesMax(floor);
}

/** Item stack ceiling per grant — the same one event options obey. */
export const ITEM_COUNT_MAX = EVENT_CAPS.itemCountMax;
