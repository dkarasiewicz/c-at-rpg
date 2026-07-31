/**
 * POST /api/gm/steer — the "director". Called at floor transitions with the
 * run summary; returns small nudges from a BOUNDED set (gm-system.md):
 * encounter budget ±1, shop stock bias, next-event theme, one-line floor
 * intro. The caller records the nudges into the run seed record so a replay
 * with the same seed + same GM transcript reproduces.
 *
 * No pool (nudges are run-specific and tiny). GM_MODEL (haiku) only.
 */
import type {
  GmSteerNudges,
  GmSteerRequest,
  GmSteerResponse,
} from "../../src/services/gmTypes.js";
import { getAnthropicGen, gmModel } from "../_lib/anthropic.js";
import { lintSteer } from "../_lib/constraints.js";
import {
  GmGenerationError,
  generateValidated,
  type LintResult,
  type StructuredGenClient,
} from "../_lib/generate.js";
import {
  errorJson,
  json,
  rateLimit,
  readJson,
  requirePost,
  vercelHandler,
} from "../_lib/http.js";

/* ------------------------------------------------------------------------ */
/* JSON schema                                                               */
/* ------------------------------------------------------------------------ */

export const STEER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["nudges"],
  properties: {
    nudges: {
      type: "object",
      additionalProperties: false,
      required: [
        "encounterBudgetDelta",
        "shopBias",
        "nextEventTheme",
        "floorIntro",
      ],
      properties: {
        encounterBudgetDelta: { enum: [-1, 0, 1] },
        shopBias: { enum: ["consumables", "equipment", "none"] },
        nextEventTheme: { type: "string" },
        floorIntro: { type: "string" },
      },
    },
  },
};

/* ------------------------------------------------------------------------ */
/* Prompts                                                                   */
/* ------------------------------------------------------------------------ */

export const STEER_SYSTEM = `You are the run director of c(at)rpg (stray cats
with Stands, JoJo homage). At each floor transition you return SMALL nudges
from a bounded menu — you never invent mechanics or numbers outside it:
- encounterBudgetDelta: -1 (party is struggling), 0, or +1 (party is
  cruising).
- shopBias: "consumables" (low HP/lives), "equipment" (rich and healthy),
  or "none".
- nextEventTheme: <= 60 chars, a flavor tag for the next narrative event.
- floorIntro: <= 200 chars, ONE dramatic over-the-top line announcing the
  floor ("THE DUMPSTER KING descends!" energy).

CONTENT POLICY: family-friendly comedy; no sexual content, hate, or gore.`;

function buildSteerPrompt(req: GmSteerRequest): string {
  const s = req.summary;
  return [
    `Entering floor ${req.floor}.`,
    `Mean party HP: ${Math.round(s.hpPct * 100)}%. Lives lost so far: ${s.livesLost}.`,
    `Shinies: ${s.shinies}. Enemies defeated: ${s.enemiesDefeated}. Cat piles: ${s.catPiles}.`,
    "Return the nudges as JSON.",
  ].join("\n");
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                   */
/* ------------------------------------------------------------------------ */

export function lintSteerPayload(parsed: unknown): LintResult<GmSteerNudges> {
  const root = parsed as { nudges?: unknown };
  if (!root || typeof root.nudges !== "object" || root.nudges === null) {
    return { errors: ['root must be {"nudges": {...}}'] };
  }
  const nudges = root.nudges as GmSteerNudges;
  const errors = lintSteer(nudges);
  return errors.length > 0 ? { errors } : { value: nudges, errors: [] };
}

export interface SteerDeps {
  gen: StructuredGenClient;
}

function parseRequest(body: unknown): GmSteerRequest | null {
  const b = body as Partial<GmSteerRequest> | null;
  if (!b || typeof b.floor !== "number" || b.floor < 1 || b.floor > 6) {
    return null;
  }
  const s = b.summary;
  if (
    !s ||
    typeof s.hpPct !== "number" ||
    typeof s.livesLost !== "number" ||
    typeof s.shinies !== "number" ||
    typeof s.enemiesDefeated !== "number" ||
    typeof s.catPiles !== "number"
  ) {
    return null;
  }
  return {
    floor: Math.floor(b.floor),
    summary: {
      hpPct: Math.max(0, Math.min(1, s.hpPct)),
      livesLost: s.livesLost,
      shinies: s.shinies,
      enemiesDefeated: s.enemiesDefeated,
      catPiles: s.catPiles,
    },
  };
}

export function createSteerHandler(deps: SteerDeps) {
  return async (req: Request): Promise<Response> => {
    const bad = requirePost(req) ?? rateLimit(req);
    if (bad) return bad;

    const input = parseRequest(await readJson(req));
    if (!input) return errorJson("floor (1..6) and summary are required", 400);

    try {
      const nudges = await generateValidated<GmSteerNudges>(deps.gen, {
        model: gmModel(),
        system: STEER_SYSTEM,
        user: buildSteerPrompt(input),
        schema: STEER_SCHEMA,
        lint: lintSteerPayload,
        maxTokens: 500,
      });
      const res: GmSteerResponse = { nudges };
      return json(res);
    } catch (err) {
      if (err instanceof GmGenerationError) {
        return errorJson(`generation failed lint: ${err.lintErrors[0]}`, 502);
      }
      return errorJson("gm steer generation failed", 502);
    }
  };
}

let deps: SteerDeps | null = null;

export default vercelHandler(async (req) => {
  deps ??= { gen: getAnthropicGen() };
  return createSteerHandler(deps)(req);
});
