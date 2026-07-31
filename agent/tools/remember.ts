/**
 * `remember` — write a fact into durable run state for a later callback.
 *
 * This is the whole reason the DM is a persistent agent rather than six
 * stateless endpoints (docs/design/run-map-and-dm.md §4): that the party bribed
 * the rat king on floor 2, that Baguette is out of lives, that they promised
 * the elder stray they would come back. The fact ledger rides the eve session,
 * so it survives cold starts, redeploys and an hour-long tab abandonment.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { floorSchema } from "../lib/effects.js";
import { appendFact, runMemory } from "../lib/memory.js";

export default defineTool({
  description:
    "Record one fact about this run so you can pay it off later: a promise " +
    "made, a name learned, a bargain struck, a grudge earned, a door left " +
    "open. Write it as a short third-person statement of fact, not as prose. " +
    "Call this whenever the party commits to something the world should " +
    "remember — later floors are much better when floor 5 answers floor 2.",
  inputSchema: z.object({
    floor: floorSchema,
    text: z
      .string()
      .min(1)
      .max(240)
      .describe("one statement of fact, e.g. 'the party bribed the rat king'"),
    tags: z
      .array(z.string().min(1).max(24))
      .max(4)
      .default([])
      .describe("optional handles for recall, e.g. ['ratKing', 'debt']"),
  }),
  execute({ floor, text, tags }) {
    const fact = appendFact({ floor, text, tags });
    const { facts } = runMemory.get();
    return {
      kind: "fact" as const,
      remembered: true,
      seq: fact.seq,
      text: fact.text,
      /** So the DM can see what it is already carrying without another call. */
      openThreads: facts.slice(-8).map((f) => `f${f.floor}: ${f.text}`),
    };
  },
});
