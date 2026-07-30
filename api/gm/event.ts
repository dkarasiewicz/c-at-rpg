/**
 * POST /api/gm/event — run context → one NarrativeEvent in the EXACT
 * events.md schema (core GameEvent type).
 *
 * Pool-first per gm-system.md: roll p = min(0.7, poolSize/200); on a hit,
 * serve a re-validated pooled event, otherwise generate fresh with
 * GM_MODEL (default claude-haiku-4-5), lint with the SAME validator the
 * static content passes (core/events/validate) plus per-floor effect caps,
 * retry once, then persist to the pool.
 *
 * Note on the schema: structured outputs forbid recursive schemas, so
 * `fight.onWinEffects` accepts only non-fight effects (one level deep) —
 * which core validate independently requires anyway (fight must be last,
 * at most one per outcome).
 */
import type { GameEvent } from "../../src/core/types";
import { ENEMIES } from "../../src/content/enemies";
import { CONSUMABLES } from "../../src/content/consumables";
import { EQUIP_DEFS } from "../../src/content/equipment";
import type {
  GmEventRequest,
  GmEventResponse,
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
import { getPool, shouldUsePool, type PoolStore } from "../_lib/pool";

/* ------------------------------------------------------------------------ */
/* JSON schema (hand-written to match core GameEvent)                        */
/* ------------------------------------------------------------------------ */

const ENEMY_IDS = Object.keys(ENEMIES);
const ITEM_IDS = [...Object.keys(CONSUMABLES), ...Object.keys(EQUIP_DEFS)];

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

const TARGET_SEL = ["party", "random", "lowestHp", "lowestLives", "gateCat"];
const BUFF_STAT = ["atk", "def", "spd", "crt", "hpMax"];

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

const REQUIREMENT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "class"],
      properties: {
        kind: { const: "class" },
        class: { enum: ["bruiser", "trickster", "hexer", "medic"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "stat", "min"],
      properties: {
        kind: { const: "stat" },
        stat: { enum: ["atk", "def", "spd", "crt"] },
        min: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "item"],
      properties: {
        kind: { const: "item" },
        item: { enum: ITEM_IDS },
        count: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "cost"],
      properties: { kind: { const: "shinies" }, cost: SCALAR_SCHEMA },
    },
  ],
};

export const EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["event"],
  properties: {
    event: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "prompt", "weight", "floors", "options"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" },
        weight: { type: "integer" },
        floors: { type: "array", items: { type: "integer" } },
        once: { type: "boolean" },
        options: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "outcomes"],
            properties: {
              label: { type: "string" },
              requires: REQUIREMENT_SCHEMA,
              outcomes: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["weight", "text", "effects"],
                  properties: {
                    weight: { type: "integer" },
                    text: { type: "string" },
                    effects: { type: "array", items: EFFECT_SCHEMA },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/* ------------------------------------------------------------------------ */
/* Prompts                                                                   */
/* ------------------------------------------------------------------------ */

export const EVENT_SYSTEM = `You are the Game Master of c(at)rpg, a roguelike
about stray cats with Stands (JoJo homage — dramatic, over-the-top, slightly
absurd). You author ONE narrative event in the exact events.md schema.

HARD RULES (violations are rejected by the same validator the shipped
content passes, plus numeric caps):
- id: camelCase starting with "gm", e.g. "gmLaundromatOmen". 2-4 options,
  1-4 outcomes each, all weights >= 1.
- WALK-AWAY RULE: at least one requirement-free option whose outcomes have
  no damage and no fight effects.
- A fight effect must be the LAST effect of its outcome; at most one per
  outcome; onWinEffects may not contain another fight.
- gateCat targets only on options with a class or stat requirement.
- Per-floor caps (floor f): damage <= 5+3f, heal <= 10+5f, shinies
  <= 30+10f, buff amount <= ${EVENT_CAPS.buffMax}, energyNextBattle 1..${EVENT_CAPS.energyMax},
  restoreLife <= ${EVENT_CAPS.restoreLifeMax}, item counts <= ${EVENT_CAPS.itemCountMax}, encounters 1-5 enemies.
- Only enemy/item ids that exist in the game (the schema enumerates them).

CONTENT POLICY: family-friendly comedy. Never produce sexual content, real
hate, slurs, or gore; reinterpret any such theme tag into harmless
cat-universe absurdity.`;

function buildEventPrompt(req: GmEventRequest): string {
  const parts = [`Floor: ${req.floor} (set "floors" to cover it).`];
  if (req.partyHp) parts.push(`Party HP: ${req.partyHp.join("/")}.`);
  if (req.partyLives) parts.push(`Lives: ${req.partyLives.join("/")}.`);
  if (req.shinies !== undefined) parts.push(`Shinies: ${req.shinies}.`);
  if (req.recentEventIds?.length) {
    parts.push(`Do NOT reuse these ids: ${req.recentEventIds.join(", ")}.`);
  }
  if (req.themeTags?.length) {
    parts.push(`Theme tags: ${req.themeTags.join(", ")}.`);
  }
  parts.push("Write one fresh event as JSON.");
  return parts.join("\n");
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                   */
/* ------------------------------------------------------------------------ */

export function lintEventPayload(parsed: unknown): LintResult<GameEvent> {
  const root = parsed as { event?: unknown };
  if (!root || typeof root.event !== "object" || root.event === null) {
    return { errors: ['root must be {"event": {...}}'] };
  }
  const event = root.event as GameEvent;
  const errors = lintEvent(event);
  return errors.length > 0 ? { errors } : { value: event, errors: [] };
}

export interface EventDeps {
  gen: StructuredGenClient;
  pool: PoolStore;
}

function parseRequest(body: unknown): GmEventRequest | null {
  const b = body as Partial<GmEventRequest> | null;
  if (!b || typeof b.floor !== "number" || b.floor < 1 || b.floor > 6) {
    return null;
  }
  return {
    floor: Math.floor(b.floor),
    partyHp: Array.isArray(b.partyHp) ? b.partyHp.slice(0, 4) : undefined,
    partyLives: Array.isArray(b.partyLives)
      ? b.partyLives.slice(0, 4)
      : undefined,
    shinies: typeof b.shinies === "number" ? b.shinies : undefined,
    recentEventIds: Array.isArray(b.recentEventIds)
      ? b.recentEventIds.filter((s) => typeof s === "string").slice(0, 30)
      : undefined,
    themeTags: Array.isArray(b.themeTags)
      ? b.themeTags
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.slice(0, 60))
          .slice(0, 5)
      : undefined,
  };
}

export function createEventHandler(deps: EventDeps) {
  return async (req: Request): Promise<Response> => {
    const bad = requirePost(req) ?? rateLimit(req);
    if (bad) return bad;

    const input = parseRequest(await readJson(req));
    if (!input) return errorJson("floor (1..6) is required", 400);

    // ── pool-first ─────────────────────────────────────────────────────
    if (await shouldUsePool(deps.pool, "events")) {
      const raw = await deps.pool.sample("events").catch(() => null);
      if (raw) {
        const pooled = lintEventPayload({ event: JSON.parse(raw) });
        const ev = pooled.value;
        if (
          ev &&
          ev.floors[0] <= input.floor &&
          input.floor <= ev.floors[1] &&
          !input.recentEventIds?.includes(ev.id)
        ) {
          const res: GmEventResponse = { event: ev, source: "pool" };
          return json(res);
        }
      }
    }

    // ── fresh generation ───────────────────────────────────────────────
    try {
      const event = await generateValidated<GameEvent>(deps.gen, {
        model: gmModel(),
        system: EVENT_SYSTEM,
        user: buildEventPrompt(input),
        schema: EVENT_SCHEMA,
        lint: lintEventPayload,
      });
      void deps.pool
        .add("events", JSON.stringify(event))
        .catch(() => undefined);
      const res: GmEventResponse = { event, source: "generated" };
      return json(res);
    } catch (err) {
      if (err instanceof GmGenerationError) {
        return errorJson(`generation failed lint: ${err.lintErrors[0]}`, 502);
      }
      return errorJson("gm event generation failed", 502);
    }
  };
}

let deps: EventDeps | null = null;

export default async function handler(req: Request): Promise<Response> {
  deps ??= { gen: getAnthropicGen(), pool: getPool() };
  return createEventHandler(deps)(req);
}
