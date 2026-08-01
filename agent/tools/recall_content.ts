/**
 * `recall_content` — the READ half of the Dreaming, and the reason the pool is
 * worth writing to at all.
 *
 * Before you author anything, ask the world whether it has already dreamed one
 * (docs/design/gm-system.md "Shared content pool"; roster-and-persistence.md
 * §5). A pool nobody reads is a log file.
 *
 * ## The policy, applied HERE and not by the model
 *
 * `p = min(0.7, poolSize / 200)` (`poolPickProbability`) — the probability of
 * reusing RISES AS THE POOL GROWS. Generation zero always generates; a world
 * with 200 dreamed items reuses 7 times in 10. The roll happens server-side
 * for two reasons: the model cannot see the pool size, and a decision the
 * model makes is a decision that drifts.
 *
 * `force: true` skips the roll and answers "the best thing you have", for the
 * cases where reuse is the point (a callback to something a previous party
 * met) rather than a cost saving.
 *
 * ## What comes back
 *
 * `{ found: true, payload, … }` — USE THIS, do not author a new one. The
 * payload was validated by the game's own lints on the way in, and it is
 * re-linted client-side on the way out, so it is safe to hand straight to the
 * player.
 *
 * `{ found: false }` — nothing suitable, or the pool is unreachable, or the
 * roll said "make something new". All three mean the same thing to you:
 * author it, then publish it with `contribute_content` so the NEXT run gets
 * it for free.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getPool, poolPickProbability, type PoolKind } from "../lib/pool.js";
import { ART_STYLE } from "../../src/content/artStyle.js";
import { floorSchema } from "../lib/effects.js";

const RECALL_KINDS: [PoolKind, ...PoolKind[]] = [
  "stands",
  "items",
  "events",
  "enemies",
  "encounters",
  "cats",
  "powers",
  "backgrounds",
];

export default defineTool({
  description:
    "BEFORE you author a Stand, item, event, enemy, encounter, cat, power or " +
    "backdrop, ask whether the world has already dreamed one for this floor. " +
    "{ found: true } means use the returned payload as-is — it is already " +
    "validated, it already has its picture, and reusing it is how the world " +
    "grows instead of repeating itself. { found: false } means author a new " +
    "one and publish it with `contribute_content`.",
  inputSchema: z.object({
    kind: z.enum(RECALL_KINDS).describe("what you are about to author"),
    floor: floorSchema.describe("the floor it has to be legal on"),
    force: z
      .boolean()
      .optional()
      .describe(
        "skip the probability roll and return the best match if one exists " +
          "— use when calling back to something a party has met before",
      ),
    anyStyle: z
      .boolean()
      .optional()
      .describe(
        "accept content authored against an older art style (default: only " +
          "the current style, so pictures stay consistent)",
      ),
  }),
  async execute({ kind, floor, force, anyStyle }) {
    const pool = getPool();
    const query = {
      floor,
      styleVersion: anyStyle ? undefined : ART_STYLE.version,
    };

    let size = 0;
    try {
      size = await pool.size(kind, query);
    } catch {
      size = 0;
    }
    if (size === 0) {
      return {
        kind: "recall" as const,
        found: false,
        poolSize: 0,
        reason: "the world has not dreamed one of these yet",
      };
    }

    const p = poolPickProbability(size);
    if (!force && Math.random() >= p) {
      return {
        kind: "recall" as const,
        found: false,
        poolSize: size,
        probability: p,
        reason: "the world would rather you dreamt a new one this time",
      };
    }

    const row = await pool.pick(kind, query).catch(() => null);
    if (!row) {
      return {
        kind: "recall" as const,
        found: false,
        poolSize: size,
        probability: p,
        reason: "the pool did not answer",
      };
    }
    return {
      kind: "recall" as const,
      found: true,
      poolSize: size,
      probability: p,
      id: row.id,
      payload: row.payload,
      artUrl: row.artUrl,
      styleVersion: row.styleVersion,
      floors: [row.floorMin, row.floorMax] as [number, number],
      provenance: row.provenance,
      dreamedBefore: true,
    };
  },
});
