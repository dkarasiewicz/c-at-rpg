/**
 * The encounter adjudicator — one fight's DM (docs/design/run-map-and-dm.md §4).
 *
 * Fresh context per delegation, a narrower toolset (one lint, nothing that can
 * mutate the world), and a STRUCTURED verdict via `outputSchema` that the
 * engine executes directly. The parent packs the whole battle snapshot into
 * `message`, because a declared subagent never sees the parent's history and
 * never shares its `defineState`.
 *
 * Haiku on purpose: the verdict is re-validated by the engine's own budget lint
 * on the way out AND again client-side at application time, so a weaker model
 * cannot author an illegal outcome — only a rejected one. Latency in the middle
 * of a turn is the thing worth buying. Swap to `anthropic/claude-sonnet-5` here
 * if adjudication quality ever proves to be the bottleneck.
 */
import { defineAgent } from "eve";
import { verdictSchema } from "./lib/verdict.js";

export default defineAgent({
  description:
    "Adjudicate one improvised player action inside a battle. Give it the " +
    "full battle snapshot (ranks, HP, statuses, energy, available powers and " +
    "skills), the floor, and the player's typed line; it returns a structured " +
    "verdict { allowed, narration, effects, energyCost, target } the combat " +
    "engine can execute as an ordinary action. Delegate every in-combat " +
    "free-text action to it — never author combat effects yourself.",
  model: "anthropic/claude-haiku-4.5",
  outputSchema: verdictSchema,
});
