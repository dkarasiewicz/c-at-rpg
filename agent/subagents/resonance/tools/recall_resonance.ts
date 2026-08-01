/**
 * `recall_resonance` — has anyone, anywhere, ever judged this pair?
 *
 * stand-powers.md Layer 3 says a verdict is "memoized forever". Until now it
 * was memoized for the life of one browser tab, because the agent had no
 * shared store (docs/DM-DEPLOY.md "What the agent does not cover"). It has one
 * now: `catrpg.interactions`, keyed by the ordered pair key.
 *
 * The row is the answer INCLUDING A NULL RULE. "These two do not resonate" is
 * a real verdict — the common one, by design — and it is stored precisely so
 * the model never pays to reach it twice. `judged: false` is the only state
 * that means "think about it".
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getPool } from "../../../lib/pool.js";

export default defineTool({
  description:
    "CALL THIS FIRST, before judging anything. If it returns judged: true, " +
    "that pair has already been decided somewhere in the world — return " +
    "EXACTLY the verdict it hands you (hasResonance, rule, flavor, announce) " +
    "and do not re-judge it. A stored rule of null is a real, final answer: " +
    "they do not resonate. judged: false means nobody has ever judged this " +
    "pair and the decision is yours.",
  inputSchema: z.object({
    pairKey: z
      .string()
      .min(3)
      .max(200)
      .describe("the pair key exactly as it appears in the brief"),
  }),
  async execute({ pairKey }) {
    let raw: string | null = null;
    try {
      raw = await getPool().getEntry("interactions", pairKey);
    } catch {
      raw = null; // unreachable pool ⇒ just judge it; nothing breaks
    }
    if (raw === null) {
      return { kind: "resonance-memo" as const, judged: false, pairKey };
    }
    let row: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        row = parsed as Record<string, unknown>;
      }
    } catch {
      return { kind: "resonance-memo" as const, judged: false, pairKey };
    }
    const rule = row.rule ?? null;
    return {
      kind: "resonance-memo" as const,
      judged: true,
      pairKey,
      hasResonance: rule !== null,
      rule,
      flavor: typeof row.flavor === "string" ? row.flavor : "",
      announce: typeof row.announce === "string" ? row.announce : "",
    };
  },
});
