/**
 * `record_resonance` — make the verdict permanent.
 *
 * Compiling a resonance is the one thing in this game that costs a model call
 * for an answer that can never change: the pair key carries the framework
 * version, so a given pair at a given version has exactly one correct verdict
 * forever. Writing it to `catrpg.interactions` means the FIRST meeting
 * anywhere in the world pays for it and every later meeting, for every player,
 * is a SELECT.
 *
 * **A null rule is written, deliberately.** Roughly two pairs in three do not
 * resonate; that "no" is the expensive answer to recompute and the cheap one
 * to store, so `hasResonance: false` writes a row with `rule: null` rather
 * than no row at all. `recall_resonance` distinguishes "no row" (never judged)
 * from "row with a null rule" (judged; the answer is no).
 *
 * The rule is stored as the model authored it — BODY ONLY, reusing the
 * subagent's own `resonanceOutputSchema` so the stored shape and the returned
 * shape cannot drift apart. `pairKey`, `version` and `budget` are stamped by
 * the caller (`readResonanceVerdict` in `src/services/oneshot.ts`), and the
 * engine re-lints the compiled rule against its own budget tables before it
 * can affect a battle. A wrong "yes" in this table is rejected at read time,
 * not played.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getPool } from "../../../lib/pool.js";
import { resonanceOutputSchema } from "../../../lib/oneshot.js";
import { POWER_FRAMEWORK_VERSION } from "../../../../src/services/powerLint.js";

export default defineTool({
  description:
    "Record your verdict so the world never has to judge this pair again. " +
    "Call it AFTER you decide and BEFORE you answer, for BOTH outcomes — a " +
    "'no' is worth storing exactly as much as a 'yes', because it is the " +
    "answer nobody should ever pay to reach twice.",
  inputSchema: z
    .object({
      pairKey: z
        .string()
        .min(3)
        .max(200)
        .describe("the pair key exactly as it appears in the brief"),
    })
    .extend(resonanceOutputSchema.shape),
  async execute({ pairKey, hasResonance, rule, flavor, announce }) {
    const stored = hasResonance ? (rule ?? null) : null;
    try {
      await getPool().setEntry(
        "interactions",
        pairKey,
        JSON.stringify({
          rule: stored,
          flavor,
          announce: hasResonance ? announce : "",
          frameworkVer: POWER_FRAMEWORK_VERSION,
        }),
      );
    } catch {
      // Best-effort: an unreachable pool must never turn a good verdict into
      // a failed turn. The battle still gets the answer; only the memo is lost.
      return { kind: "resonance-memo" as const, recorded: false, pairKey };
    }
    return {
      kind: "resonance-memo" as const,
      recorded: true,
      pairKey,
      storedNullVerdict: stored === null,
    };
  },
});
