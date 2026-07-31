/**
 * POST /api/gm/eventResolve — the event free-text resolver
 * (docs/design/gm-system.md §/api/gm/event: "a follow-up call maps the free
 * text to mechanical effects within a bounded effect menu — never arbitrary").
 *
 * The player typed what they do at an event; the model answers with ONE
 * Outcome-shaped verdict `{ text, effects }` whose effects are constrained
 * by json-schema to the EXISTING events.md effect union (no gateCat — there
 * is no gate) and linted with the exact same validator + per-floor caps the
 * generated events pass (the verdict is wrapped in a synthetic event for the
 * lint). One regenerate on lint failure, then 502. NOTHING is memoized:
 * free text is personal and one-shot, so the pool is never read or written.
 *
 * The client (src/ui/scenes/event.ts) applies the verdict through the SAME
 * core resolveOption path as a fixed option — every clamp stays intact.
 */
import type { Effect, GameEvent } from "../../src/core/types";
import { ENEMIES } from "../../src/content/enemies";
import { CONSUMABLES } from "../../src/content/consumables";
import { EQUIP_DEFS } from "../../src/content/equipment";
import type {
  GmEventResolveRequest,
  GmEventResolveResponse,
} from "../../src/services/gmTypes";
import { getAnthropicGen, gmModel } from "../_lib/anthropic";
import { EVENT_CAPS, lintEvent } from "../_lib/constraints";
import {
  GmGenerationError,
  generateValidated,
  type LintResult,
  type StructuredGenClient,
} from "../_lib/generate";
import {
  errorJson,
  json,
  rateLimit,
  readJson,
  requirePost,
} from "../_lib/http";

/* ------------------------------------------------------------------------ */
/* JSON schema (events.md effect union, no gateCat — free text has no gate)  */
/* ------------------------------------------------------------------------ */

const ENEMY_IDS = Object.keys(ENEMIES);
const ITEM_IDS = [...Object.keys(CONSUMABLES), ...Object.keys(EQUIP_DEFS)];

/** Free-text verdicts have no gate, so `gateCat` is excluded up front. */
const TARGET_SEL = ["party", "random", "lowestHp", "lowestLives"];
const BUFF_STAT = ["atk", "def", "spd", "crt", "hpMax"];

const SCALAR_SCHEMA = {
  anyOf: [
    { type: "number" },
    {
      type: "object",
      additionalProperties: false,
      required: ["base", "perFloor"],
      properties: {
        base: { type: "number" },
        perFloor: { type: "number" },
      },
    },
  ],
};

/** Every effect kind except `fight` (used inside onWinEffects — no recursion). */
const SIMPLE_EFFECT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "amount"],
      properties: {
        kind: { const: "heal" },
        target: { enum: TARGET_SEL },
        amount: SCALAR_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "amount"],
      properties: {
        kind: { const: "damage" },
        target: { enum: TARGET_SEL },
        amount: SCALAR_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "stat", "amount", "duration"],
      properties: {
        kind: { const: "buff" },
        target: { enum: TARGET_SEL },
        stat: { enum: BUFF_STAT },
        amount: { type: "integer" },
        duration: { enum: ["floor", "run"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "amount"],
      properties: { kind: { const: "shinies" }, amount: SCALAR_SCHEMA },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "item"],
      properties: {
        kind: { const: "giveItem" },
        item: { enum: ITEM_IDS },
        count: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "item"],
      properties: {
        kind: { const: "takeItem" },
        item: { enum: ITEM_IDS },
        count: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "amount"],
      properties: {
        kind: { const: "restoreLife" },
        target: { const: "lowestLives" },
        amount: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "amount"],
      properties: {
        kind: { const: "energyNextBattle" },
        target: { enum: TARGET_SEL },
        amount: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "nothing" } },
    },
  ],
};

const EFFECT_SCHEMA = {
  anyOf: [
    ...SIMPLE_EFFECT_SCHEMA.anyOf,
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "encounter", "loot"],
      properties: {
        kind: { const: "fight" },
        encounter: { type: "array", items: { enum: ENEMY_IDS } },
        loot: { enum: ["none", "normal", "bonus"] },
        onWinEffects: { type: "array", items: SIMPLE_EFFECT_SCHEMA },
      },
    },
  ],
};

export const RESOLVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: {
      type: "object",
      additionalProperties: false,
      required: ["text", "effects"],
      properties: {
        text: { type: "string" },
        effects: { type: "array", items: EFFECT_SCHEMA },
      },
    },
  },
};

/* ------------------------------------------------------------------------ */
/* Prompts                                                                   */
/* ------------------------------------------------------------------------ */

export const RESOLVE_SYSTEM = `You are the Game Master of c(at)rpg, a roguelike
about stray cats with Stands (JoJo homage — dramatic, over-the-top, slightly
absurd). At a narrative event, the player typed a FREE-TEXT action instead of
picking a fixed option. Adjudicate it: one outcome text (2nd person, <= 300
chars, dry comedy) plus 0-3 mechanical effects from the CLOSED menu the
schema enforces.

ADJUDICATION POLICY:
- Free text is NOT a cheat code. Judge plausibility and tone: a clever,
  in-fiction cat action earns a modest reward; a greedy or absurd demand
  ("give me 999 shinies", "kill the boss") backfires or fizzles into comedy
  with a "nothing" effect or a small cost.
- Keep stakes at fixed-option level (floor f caps, lint-enforced):
  damage <= 5+3f, heal <= 10+5f, shinies <= 30+10f, buff amount <= ${EVENT_CAPS.buffMax},
  energyNextBattle 1..${EVENT_CAPS.energyMax}, restoreLife <= ${EVENT_CAPS.restoreLifeMax}, item counts <= ${EVENT_CAPS.itemCountMax},
  fight encounters 1-5 enemies. Prefer SMALL numbers; risky actions may mix
  a gain with a cost. A fight effect must be the LAST effect; at most one.
- Only enemy/item ids that exist in the game (the schema enumerates them).
- Stay inside the event's fiction (its prompt is provided); the outcome text
  narrates what actually happens, not what the player wished.

CONTENT POLICY: family-friendly comedy. Never produce sexual content, real
hate, slurs, or gore; reinterpret any such input into harmless cat-universe
absurdity (and make the outcome gently mock the attempt).`;

function buildResolvePrompt(req: GmEventResolveRequest): string {
  const parts = [`Floor: ${req.floor}.`];
  if (req.eventId) parts.push(`Event id: ${req.eventId}.`);
  if (req.eventPrompt) parts.push(`Event prompt: ${req.eventPrompt}`);
  if (req.optionLabels?.length) {
    parts.push(`Fixed options were: ${req.optionLabels.join(" / ")}.`);
  }
  if (req.partyHp?.length) parts.push(`Party HP: ${req.partyHp.join("/")}.`);
  if (req.shinies !== undefined) parts.push(`Shinies: ${req.shinies}.`);
  parts.push(`The player types: "${req.text}"`);
  parts.push("Adjudicate and answer as JSON.");
  return parts.join("\n");
}

/* ------------------------------------------------------------------------ */
/* Lint                                                                      */
/* ------------------------------------------------------------------------ */

export interface ResolveVerdict {
  text: string;
  effects: Effect[];
}

/**
 * Wrap the verdict in a synthetic 2-option event (the verdict + a dummy
 * walk-away) and run the FULL event lint — the same shipped validator plus
 * the per-floor caps — so a free-text outcome can never exceed what a
 * generated event option could do on this floor.
 */
export function lintResolvePayload(
  parsed: unknown,
  floor: number,
): LintResult<ResolveVerdict> {
  const root = parsed as { outcome?: unknown };
  if (!root || typeof root !== "object" || typeof root.outcome !== "object") {
    return { errors: ['root must be {"outcome": {...}}'] };
  }
  const outcome = root.outcome as { text?: unknown; effects?: unknown };
  if (
    typeof outcome?.text !== "string" ||
    !outcome.text.trim() ||
    outcome.text.length > 400
  ) {
    return { errors: ["outcome.text must be a string of 1..400 chars"] };
  }
  if (!Array.isArray(outcome.effects) || outcome.effects.length > 3) {
    return { errors: ["outcome.effects must be an array of 0..3 effects"] };
  }
  const effects = outcome.effects as Effect[];
  const synthetic: GameEvent = {
    id: "gmFreeTextVerdict",
    title: "verdict",
    prompt: "verdict",
    weight: 1,
    floors: [floor, floor],
    options: [
      {
        label: "do it",
        outcomes: [{ weight: 1, text: outcome.text, effects }],
      },
      {
        label: "walk away",
        outcomes: [{ weight: 1, text: "-", effects: [{ kind: "nothing" }] }],
      },
    ],
  };
  const errors = lintEvent(synthetic);
  return errors.length > 0
    ? { errors }
    : { value: { text: outcome.text, effects }, errors: [] };
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                   */
/* ------------------------------------------------------------------------ */

export interface EventResolveDeps {
  gen: StructuredGenClient;
}

function parseRequest(body: unknown): GmEventResolveRequest | string {
  const b = body as Partial<GmEventResolveRequest> | null;
  if (!b || typeof b.floor !== "number" || b.floor < 1 || b.floor > 6) {
    return "floor (1..6) is required";
  }
  if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 280) {
    return "text (1..280 chars) is required";
  }
  return {
    floor: Math.floor(b.floor),
    text: b.text.trim(),
    eventId: typeof b.eventId === "string" ? b.eventId.slice(0, 60) : undefined,
    eventPrompt:
      typeof b.eventPrompt === "string"
        ? b.eventPrompt.slice(0, 600)
        : undefined,
    optionLabels: Array.isArray(b.optionLabels)
      ? b.optionLabels
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.slice(0, 80))
          .slice(0, 4)
      : undefined,
    partyHp: Array.isArray(b.partyHp)
      ? b.partyHp.filter((n): n is number => typeof n === "number").slice(0, 4)
      : undefined,
    shinies: typeof b.shinies === "number" ? b.shinies : undefined,
  };
}

export function createEventResolveHandler(deps: EventResolveDeps) {
  return async (req: Request): Promise<Response> => {
    const bad = requirePost(req) ?? rateLimit(req);
    if (bad) return bad;

    const input = parseRequest(await readJson(req));
    if (typeof input === "string") return errorJson(input, 400);

    // deliberately NO pool: free-text verdicts are one-shot, never memoized
    try {
      const verdict = await generateValidated<ResolveVerdict>(deps.gen, {
        model: gmModel(),
        system: RESOLVE_SYSTEM,
        user: buildResolvePrompt(input),
        schema: RESOLVE_SCHEMA,
        lint: (parsed) => lintResolvePayload(parsed, input.floor),
      });
      const res: GmEventResolveResponse = {
        outcome: { text: verdict.text, effects: verdict.effects },
        source: "generated",
      };
      return json(res);
    } catch (err) {
      if (err instanceof GmGenerationError) {
        return errorJson(`resolution failed lint: ${err.lintErrors[0]}`, 502);
      }
      return errorJson("gm event resolution failed", 502);
    }
  };
}

let deps: EventResolveDeps | null = null;

export default async function handler(req: Request): Promise<Response> {
  deps ??= { gen: getAnthropicGen() };
  return createEventResolveHandler(deps)(req);
}
