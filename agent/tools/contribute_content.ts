/**
 * `contribute_content` — publish something the DM authored MID-RUN into the
 * shared content pool (docs/design/run-map-and-dm.md §4b "auto-generated
 * content, persisted"; gm-system.md "Persistence: the content pool is the
 * system of record").
 *
 * The one-shot generators (`agent/skills/item.ts`, `agent/skills/event.ts`)
 * answer a schema because the CALLER is the game asking for one, and the game
 * keeps what it asked for. This tool is the other half: when the DM invents
 * something in the
 * middle of a beat — an item it just handed over, an event card it just
 * sketched, a line of flavour for an enemy — that content is worth keeping,
 * and §4b requires it to be kept for *later runs and other players*, not just
 * for this session.
 *
 * Three guarantees, in this order:
 *
 *  1. **Validated with the SHIPPED validators.** Events go through
 *     `lintEvent` (= `core/events/validate` + the per-floor `EVENT_CAPS`);
 *     items go through `lintItem`. Both live in `src/services/contentLint.ts`,
 *     the same module the browser re-lints generated content with — nothing
 *     bespoke is invented here.
 *  2. **Budget-linted.** Anything carrying mechanical effects is priced by the
 *     same per-floor lint an `apply_effect` request is (`lintImprovisedEffects`),
 *     so the pool can never accumulate content that is stronger than the game
 *     allows a DM to author.
 *  3. **Stamped.** Every row carries `styleVersion` (the visual-v2 style
 *     contract it was authored against) and `provenance` (`dm:<reason>`), so a
 *     later style bump can find and retire it.
 *
 * A refusal is RETURNED, never thrown: `{ published: false, problems: [...] }`,
 * and the DM narrates what actually happened. A pool that is unreachable is
 * also a refusal — the run continues; publishing is never on the hot path.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { lintEvent, lintItem } from "../../src/services/contentLint.js";
import { getPool } from "../lib/pool.js";
import { ART_STYLE } from "../../src/content/artStyle.js";
import type { GameEvent, Rarity } from "../../src/core/types.js";
import type { GeneratedEquip } from "../../src/services/gmTypes.js";
import { floorSchema } from "../lib/effects.js";

/**
 * The shipped `Rarity` union (loot.md), spelled out for the model. Typed
 * against `Rarity` itself, so a fifth rarity is a compile error here rather
 * than a silently unpublishable contribution.
 */
const RARITIES: [Rarity, ...Rarity[]] = [
  "stray",
  "sleek",
  "pedigree",
  "mewthical",
];

export default defineTool({
  description:
    "Publish content you authored during play into the SHARED pool, so later " +
    "runs and other players get it too. Use it when a beat produced " +
    "something reusable: an item you handed over, an event card the moment " +
    "suggested, a line of flavour for an enemy species. It is validated with " +
    "the game's own validators and budget-linted before it is stored; " +
    "{ published: false } means it did not pass and the world simply does not " +
    "keep it — narrate the beat anyway. This never changes THIS run: " +
    "`grant_item` / `apply_effect` are what touch the party.",
  inputSchema: z.object({
    floor: floorSchema,
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe("what in this run produced it, in one line"),
    kind: z
      .enum(["item", "event", "flavour"])
      .describe("what you are contributing"),
    /** Free-form JSON body. Shape is checked per `kind` below. */
    payload: z
      .string()
      .min(2)
      .max(6000)
      .describe(
        "the content itself as a JSON string: an EquipDef+iconPrompt for " +
          "'item', a GameEvent for 'event', or " +
          '{"subject":"<enemy or species id>","text":"<1-2 sentences>"} for ' +
          "'flavour'",
      ),
    rarity: z
      .enum(RARITIES)
      .optional()
      .describe("required for 'item' — the rarity the item is priced at"),
  }),
  async execute({ floor, reason, kind, payload, rarity }) {
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return {
        kind: "contribution" as const,
        published: false,
        problems: ["payload is not valid JSON"],
      };
    }

    // ---- validate with the SHIPPED validators --------------------------
    const problems: string[] = [];
    let poolKind: "items" | "events" | "enemies";
    let ref: string;
    switch (kind) {
      case "item": {
        if (!rarity) {
          return {
            kind: "contribution" as const,
            published: false,
            problems: ["'item' contributions must declare a rarity"],
          };
        }
        const equip = body as GeneratedEquip;
        problems.push(...lintItem(equip, rarity));
        poolKind = "items";
        ref = typeof equip?.id === "string" ? equip.id : "?";
        break;
      }
      case "event": {
        const event = body as GameEvent;
        problems.push(...lintEvent(event));
        // §4b keeps DM-authored events inside the floor band they were born
        // in: an event written for the laundromat has no business surfacing
        // in the sunbeam.
        if (
          !Array.isArray(event?.floors) ||
          event.floors[0] > floor ||
          floor > event.floors[1]
        ) {
          problems.push(`event's floors do not cover floor ${floor}`);
        }
        poolKind = "events";
        ref = typeof event?.id === "string" ? event.id : "?";
        break;
      }
      case "flavour": {
        const f = body as { subject?: unknown; text?: unknown };
        if (typeof f?.subject !== "string" || f.subject.length === 0) {
          problems.push("flavour needs a 'subject'");
        }
        if (
          typeof f?.text !== "string" ||
          f.text.trim().length === 0 ||
          f.text.length > 400
        ) {
          problems.push("flavour 'text' must be 1..400 chars");
        }
        poolKind = "enemies";
        ref = typeof f?.subject === "string" ? f.subject : "?";
        break;
      }
    }
    if (problems.length > 0) {
      return { kind: "contribution" as const, published: false, problems };
    }

    // ---- stamp and store ------------------------------------------------
    const row = JSON.stringify({
      ...(kind === "item" ? { rarity, equip: body } : {}),
      ...(kind === "event" ? (body as object) : {}),
      ...(kind === "flavour" ? { flavour: body } : {}),
      styleVersion: ART_STYLE.version,
      provenance: `dm:${reason}`.slice(0, 240),
      floor,
    });
    try {
      await getPool().add(poolKind, row);
    } catch {
      // the pool is best-effort: a run must never fail because a shared store
      // was unreachable (gm-system.md "no hard dependency")
      return {
        kind: "contribution" as const,
        published: false,
        problems: ["the shared pool is unreachable right now"],
      };
    }
    return {
      kind: "contribution" as const,
      published: true,
      problems: [] as string[],
      pool: poolKind,
      ref,
      styleVersion: ART_STYLE.version,
      provenance: `dm:${reason}`.slice(0, 240),
    };
  },
});
