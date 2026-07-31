/**
 * `narrate` — flavour text only, no mechanics (docs/design/run-map-and-dm.md §4).
 *
 * This tool changes NOTHING. It exists so the DM has an explicit, auditable way
 * to say "the answer here is words", and so the client can render a beat as a
 * DM line rather than as chat. If a beat needs a consequence, that is a
 * separate `apply_effect` / `grant_item` / `adjust_shinies` call.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Speak as the DM: pure flavour, no mechanical consequence whatsoever. " +
    "Use for scene-setting, answering a player's action that earns no effect, " +
    "and for REFUSALS ('you cannot fly, you are a cat') — a refusal is a " +
    "legitimate, in-character outcome. Never claim here that the party gained " +
    "or lost anything; if something happens mechanically, call the tool that " +
    "makes it happen.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(600)
      .describe("1-3 sentences, second person, present tense, in the DM voice"),
    tone: z
      .enum(["ominous", "triumphant", "deadpan", "absurd", "refusal"])
      .describe("how the client should present the line; 'refusal' means no"),
  }),
  execute({ text, tone }) {
    return { kind: "narration" as const, text, tone };
  },
});
