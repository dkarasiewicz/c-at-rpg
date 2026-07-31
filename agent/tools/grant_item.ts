/**
 * `grant_item` — hand over something that already exists.
 *
 * The menu is the shipped catalogue (`src/content/consumables.ts` +
 * `src/content/equipment.ts`), so a narration beat can never mint a new
 * mechanic by describing one. Authoring a brand-new `EquipDef` is a separate,
 * schema-validated one-shot capability, not something the DM does mid-sentence.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ITEM_COUNT_MAX,
  ITEM_IDS,
  isKnownItem,
  itemLabel,
} from "../lib/catalog.js";
import { floorSchema } from "../lib/effects.js";
import { appendItem } from "../lib/memory.js";

export default defineTool({
  description:
    "Give the party an item that ALREADY EXISTS in the game. You cannot " +
    "invent items: pick an id from the enumerated menu. Small stacks only. " +
    "An item is a bigger reward than an effect — reserve it for a genuinely " +
    "clever, specific, in-fiction action.",
  inputSchema: z.object({
    floor: floorSchema,
    item: z.enum(ITEM_IDS).describe("a shipped consumable or equipment id"),
    count: z
      .int()
      .min(1)
      .max(ITEM_COUNT_MAX)
      .default(1)
      .describe(`how many, 1..${ITEM_COUNT_MAX}`),
    reason: z.string().min(1).max(200).describe("why they earned it"),
  }),
  execute({ floor, item, count, reason }) {
    if (!isKnownItem(item)) {
      return {
        kind: "item" as const,
        granted: false,
        problems: [`unknown item '${item}'`],
      };
    }
    const record = appendItem({ floor, item, count, reason });
    return {
      kind: "item" as const,
      granted: true,
      problems: [] as string[],
      seq: record.seq,
      item,
      name: itemLabel(item),
      count,
    };
  },
});
