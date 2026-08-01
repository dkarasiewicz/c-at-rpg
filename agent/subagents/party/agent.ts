/**
 * The party forge — the one-shot party generator, as a subagent with NOTHING
 * TO CALL BUT THE ANSWER.
 *
 * WHY THIS EXISTS. Party generation used to be a structured turn on the root
 * DM: `session.send({ message, outputSchema })`. It failed every single time.
 * The DM's own system prompt says "you may only change the world through your
 * tools", and that instruction beats a per-message `outputSchema` — measured
 * against the deployment, 0 of 5 structured turns produced a result; each ended
 * on `narrate` / `apply_effect` and eve then failed the turn with
 * OUTPUT_SCHEMA_NOT_FULFILLED. Upgrading haiku to Sonnet 5 was also 0/5 and
 * twice as slow, because a stronger model follows the dominant instruction
 * *better*. It was never a model problem; it was a prompt-authority problem.
 *
 * An encounter verdict survives that because the client can reconstruct one
 * from the tool calls (`verdictFromToolCalls` in src/services/dm.ts). A party
 * cannot: nothing the DM's tools can express carries four full kits.
 *
 * So the fix is architectural rather than persuasive. A declared subagent
 * inherits NOTHING from the root (eve `subagents` §"The isolation boundary"):
 * not `narrate`, not `apply_effect`, not the DM's instructions. This directory
 * therefore has **no `tools/` directory at all**, and its instructions say the
 * only thing it can do is return the object. There is no wrong action left to
 * take.
 *
 * `outputSchema` is declared HERE rather than passed per-message, exactly as
 * the `encounter` subagent declares its verdict: a subagent delegation is a
 * task-mode run (eve `agent-config` §outputSchema), so the child is held to
 * this schema by the runtime and the parent needs no schema of its own. The
 * parent's whole job is to relay the brief; the answer reaches the browser off
 * the parent stream as `subagent.completed`.
 *
 * Haiku on purpose. Every number in the answer is re-linted client-side by
 * `lintPartyPayload` before a single stat reaches the engine, so a weaker model
 * cannot author an illegal party — only a rejected one — and four kits' worth
 * of schema-constrained tokens is a job where latency is the thing worth
 * buying.
 */
import { defineAgent } from "eve";
import { partyOutputSchema } from "../../lib/oneshot.js";

export default defineAgent({
  description:
    "Build a party: turn 1-4 free-text cat descriptions into exactly four " +
    "mechanically legal cat kits (tank / striker / control / support) with " +
    "stats, growth, four skills, a trait, a Stand and a Power Script. Hand it " +
    "the WHOLE brief verbatim — it never sees your conversation — and it " +
    "returns the finished party as structured output. It is the only thing " +
    "in this deployment that can produce a party; never author one yourself.",
  model: "anthropic/claude-haiku-4.5",
  outputSchema: partyOutputSchema,
});
