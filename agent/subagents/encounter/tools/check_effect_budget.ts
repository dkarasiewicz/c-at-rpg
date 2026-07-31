/**
 * `check_effect_budget` — the adjudicator's only tool.
 *
 * It mutates nothing. It runs the ENGINE'S lint (`powerBudget()` +
 * `validatePowerScript()` from `src/core/combat/powers.ts`) against this
 * floor's cap and hands the problems back in plain language, so the subagent
 * can correct itself before returning a verdict instead of emitting one the
 * engine will silently drop.
 *
 * Defence in depth is unchanged: the verdict is linted again on the way into
 * the engine and again client-side at application time
 * (docs/design/run-map-and-dm.md §3).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  effectSpecSchema,
  floorDamageCap,
  floorHealCap,
  floorSchema,
  improvBudgetCap,
  lintImprovisedEffects,
} from "../../../lib/effects.js";
import { MAX_ENERGY_COST } from "../lib/verdict.js";

export default defineTool({
  description:
    "Price and validate candidate effects against this floor's cap with the " +
    "combat engine's own budget lint, BEFORE you return a verdict. Returns " +
    "{ ok, problems, budget, cap }. If ok is false, shrink the effects (lower " +
    "percentages, single target instead of allies/enemies, fewer effects) and " +
    "check again. Do not return a verdict whose effects have not passed.",
  inputSchema: z.object({
    floor: floorSchema,
    effects: z
      .array(effectSpecSchema)
      .min(1)
      .max(3)
      .describe("the effects you intend to put in the verdict"),
    energyCost: z
      .int()
      .min(0)
      .max(MAX_ENERGY_COST)
      .describe("the energy cost you intend to charge, 0..6"),
  }),
  execute({ floor, effects, energyCost }) {
    const lint = lintImprovisedEffects(effects, floor);
    return {
      ok: lint.ok,
      problems: lint.problems,
      budget: Math.round(lint.budget * 100) / 100,
      cap: Math.round(lint.cap * 100) / 100,
      energyCost,
      limits: {
        budgetCap: Math.round(improvBudgetCap(floor) * 100) / 100,
        damagePctCap: floorDamageCap(floor),
        healPctCap: floorHealCap(floor),
        energyCostMax: MAX_ENERGY_COST,
      },
    };
  },
});
