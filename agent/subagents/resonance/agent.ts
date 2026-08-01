/**
 * The resonance compiler — the second one-shot with nothing to call but the
 * answer (stand-powers.md Layer 3, was POST /api/gm/resonance).
 *
 * Same architecture and same reason as `agent/subagents/party/`: a structured
 * turn on the root DM loses to the root's own "you may only change the world
 * through your tools", so the structured work moves to an agent that has no
 * such instruction and no such tools. No `tools/` directory; `outputSchema`
 * declared here so a delegation runs in task mode and the runtime holds the
 * child to the shape.
 *
 * A verdict is memoized by the caller for the life of the browser session, and
 * `readResonanceVerdict` re-lints the compiled rule against the engine's own
 * budget tables before it can affect a battle, so "no" is cheap and a wrong
 * "yes" is rejected rather than played.
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
