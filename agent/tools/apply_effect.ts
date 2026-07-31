/**
 * `apply_effect` — the only way the DM can touch the numbers, and it is a
 * request, not a command (docs/design/run-map-and-dm.md §3 "Bounds").
 *
 * The model proposes 1-3 `EffectSpec`s from the engine's closed union. This
 * tool prices them with the ENGINE'S `powerBudget()` and validates them with
 * the ENGINE'S `validatePowerScript()` against a per-floor budget cap, exactly
 * as `initPowersState()` does at battle setup. Nothing is executed here: the
 * tool AUTHORISES, records the authorisation in the run ledger, and the client
 * applies it through the same paths a shipped power takes — where the caps run
 * a second time (defence in depth; a tampered response degrades to pure
 * narration).
 *
 * A refusal is returned, not thrown: `{ applied: false, problems: [...] }` so
 * the DM can narrate the smaller thing that actually happened.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  effectListSchema,
  floorDamageCap,
  floorHealCap,
  floorSchema,
  improvBudgetCap,
  lintImprovisedEffects,
} from "../lib/effects.js";
import { appendEffect } from "../lib/memory.js";

export default defineTool({
  description:
    "Request a bounded mechanical consequence for something the party did " +
    "OUTSIDE combat. Effects come from the engine's closed menu (damage, " +
    "heal, status, move, energy, cleanse) and are budget-linted against a " +
    "per-floor cap by the same validator the battle engine runs. You are NOT " +
    "computing an outcome — you are asking for one; the engine executes it. " +
    "Prefer the smallest effect that tells the story. If the result is " +
    "{ applied: false }, the world said no: narrate a smaller consequence or " +
    "none at all. Do not retry the same effect. During a battle, delegate to " +
    "the `encounter` subagent instead.",
  inputSchema: z.object({
    floor: floorSchema,
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe("what the party did to earn this, in one line"),
    effects: effectListSchema,
  }),
  execute({ floor, reason, effects }) {
    const lint = lintImprovisedEffects(effects, floor);
    if (!lint.ok) {
      return {
        kind: "effect" as const,
        applied: false,
        problems: lint.problems,
        budget: lint.budget,
        cap: lint.cap,
        limits: {
          budgetCap: improvBudgetCap(floor),
          damagePctCap: floorDamageCap(floor),
          healPctCap: floorHealCap(floor),
        },
      };
    }
    const record = appendEffect({
      floor,
      reason,
      effects,
      budget: lint.budget,
    });
    return {
      kind: "effect" as const,
      applied: true,
      problems: [] as string[],
      seq: record.seq,
      budget: lint.budget,
      cap: lint.cap,
      effects,
    };
  },
});
