/**
 * The encounter verdict — the ONE structured thing this subagent returns
 * (docs/design/run-map-and-dm.md §3 "In combat").
 *
 * `resolveAction` executes it like any other action: the effects are the
 * engine's own `EffectSpec` union, `energyCost` is spent from the actor's
 * energy exactly as a skill cost, and `target` names the combatant the `other`
 * selector resolves to. Nothing here is a new mechanic.
 *
 * A declared subagent inherits NOTHING from the root (eve `subagents` §"The
 * isolation boundary"), so this file re-imports the shared vocabulary from
 * `agent/lib/effects.ts` rather than relying on the parent's copy.
 */
import { z } from "zod";
import { effectSpecSchema } from "../../../lib/effects.js";

/**
 * Energy ceiling for one improvised action: the shipped maximum skill cost
 * (classes.md §14 — costs are 0..6, and `MAX_SKILL_COST` in
 * `api/_lib/constraints.ts` lints generated kits against it). Improvisation
 * costs a turn; it must never cost less than the skills it competes with.
 */
export const MAX_ENERGY_COST = 6;

export const verdictSchema = z.object({
  allowed: z
    .boolean()
    .describe(
      "false = the action does not happen (impossible, out of fiction, or a " +
        "cheat attempt). effects must be empty and energyCost 0.",
    ),
  narration: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "1-2 sentences in the DM voice describing what actually happens. On a " +
        "refusal this is the in-character no.",
    ),
  effects: z
    .array(effectSpecSchema)
    .max(3)
    .describe(
      "0-3 effects from the engine's closed menu, executed in order. Empty " +
        "on a refusal, and empty is also fine for a purely cosmetic action.",
    ),
  energyCost: z
    .int()
    .min(0)
    .max(MAX_ENERGY_COST)
    .describe(
      "energy the actor spends, 0..6, priced like a skill of similar impact. " +
        "0 only for a refusal or a genuinely free flourish.",
    ),
  target: z
    .string()
    .max(64)
    .nullable()
    .describe(
      "combatant id the `other` selector resolves to ('e0:vacuumKing', " +
        "'cat:bruiser'), or null when the action targets nobody.",
    ),
});

export type Verdict = z.infer<typeof verdictSchema>;
