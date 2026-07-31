/**
 * `offer_encounter` — bias what the next map node contains.
 *
 * The run map is a deterministic graph generated from the run seed on its own
 * RNG stream (docs/design/run-map-and-dm.md §2), so the DM does NOT get to
 * place nodes. It gets to express a preference: "the next thing should be a
 * shop, and it should smell like the laundromat". The generator may honour it
 * or ignore it; determinism belongs to the seed, not to the model.
 *
 * The bias is a single slot — a new one replaces the old.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { floorSchema } from "../lib/effects.js";
import { NODE_TYPES, setBias } from "../lib/memory.js";

export default defineTool({
  description:
    "Nudge what the NEXT node on the run map should be, and what it should " +
    "smell like. This is advisory: the map is generated from the run seed and " +
    "may ignore you. Use it to follow through on a thread — the party asked " +
    "where to buy rope, so bias toward a shop; they swore revenge on the rat " +
    "king, so bias toward an elite. Never promise the player a specific node " +
    "in narration; you do not control the map.",
  inputSchema: z.object({
    floor: floorSchema,
    nodeType: z
      .enum(NODE_TYPES)
      .describe("the kind of node you would like to come next"),
    theme: z
      .string()
      .min(1)
      .max(60)
      .describe("a flavour tag for the generator, e.g. 'laundromat, ominous'"),
    note: z
      .string()
      .max(200)
      .default("")
      .describe("optional: the thread this pays off"),
  }),
  execute({ floor, nodeType, theme, note }) {
    const bias = setBias({ floor, nodeType, theme, note });
    return {
      kind: "encounterBias" as const,
      accepted: true,
      advisory: true,
      seq: bias.seq,
      nodeType,
      theme,
    };
  },
});
