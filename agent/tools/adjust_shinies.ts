/**
 * `adjust_shinies` — currency, capped per floor.
 *
 * The ceiling is `EVENT_CAPS.shiniesMax(floor)`, the exact table a fixed event
 * option obeys (docs/design/run-map-and-dm.md §3: "per-floor numeric caps,
 * exactly as /api/gm/eventResolve already does for free-text event options").
 * Free text is not a cheat code: "give me 999 shinies" comes back refused.
 *
 * Negative amounts are legal and are usually the funnier answer.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { shiniesCap } from "../lib/catalog.js";
import { floorSchema } from "../lib/effects.js";
import { appendShinies } from "../lib/memory.js";

export default defineTool({
  description:
    "Add or remove shinies (the currency). Capped per floor by the same table " +
    "narrative events obey; a request above the cap is refused, not clamped. " +
    "Negative amounts are allowed — a greedy or reckless action costing the " +
    "party money is a better beat than a flat refusal.",
  inputSchema: z.object({
    floor: floorSchema,
    amount: z
      .int()
      .refine((n) => n !== 0, "amount must be non-zero")
      .describe("positive to give, negative to take"),
    reason: z.string().min(1).max(200).describe("why, in one line"),
  }),
  execute({ floor, amount, reason }) {
    const cap = shiniesCap(floor);
    if (Math.abs(amount) > cap) {
      return {
        kind: "shinies" as const,
        applied: false,
        problems: [`|${amount}| above the floor-${floor} shinies cap ${cap}`],
        cap,
      };
    }
    const record = appendShinies({ floor, amount, reason });
    return {
      kind: "shinies" as const,
      applied: true,
      problems: [] as string[],
      seq: record.seq,
      amount,
      cap,
    };
  },
});
