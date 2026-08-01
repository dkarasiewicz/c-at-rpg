/**
 * The resonance compiler — the second one-shot with nothing to call but the
 * answer (stand-powers.md Layer 3, was POST /api/gm/resonance).
 *
 * Same architecture and same reason as `agent/subagents/party/`: a structured
 * turn on the root DM loses to the root's own "you may only change the world
 * through your tools", so the structured work moves to an agent that has no
 * such instruction. `outputSchema` is declared here so a delegation runs in
 * task mode and the runtime holds the child to the shape.
 *
 * It has exactly TWO tools, both about memory and neither about the world
 * (the same shape as `agent/subagents/encounter/`, whose one tool only lints):
 * `recall_resonance` reads the shared verdict table before it thinks, and
 * `record_resonance` writes the verdict after it decides — including a null
 * one, because "these two do not resonate" is the answer nobody should pay to
 * reach twice. That table is `catrpg.interactions`
 * (docs/design/roster-and-persistence.md §5), and it is what finally makes
 * stand-powers.md Layer 3's "memoized forever" true across players rather than
 * across one browser tab.
 *
 * `readResonanceVerdict` re-lints the compiled rule against the engine's own
 * budget tables before it can affect a battle, so a wrong "yes" — stored or
 * fresh — is rejected rather than played.
 */
import { defineAgent } from "eve";
import { resonanceOutputSchema } from "../../lib/oneshot.js";

export default defineAgent({
  description:
    "Judge whether two Stand powers RESONATE. Hand it the whole brief " +
    "verbatim — the pair key and both Power Scripts — and it returns either " +
    "one compiled extra rule in the Power Script DSL or a definitive no, as " +
    "structured output. It never sees your conversation, and it is the only " +
    "thing here that can compile a resonance.",
  model: "anthropic/claude-haiku-4.5",
  outputSchema: resonanceOutputSchema,
});
