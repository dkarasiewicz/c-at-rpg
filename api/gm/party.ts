/**
 * POST /api/gm/party — free-text cat descriptions → 4 legal CatClass-shaped
 * kits + Stand names/visual prompts (gm-system.md).
 *
 * Uses GM_PARTY_MODEL (default claude-sonnet-5): the one-per-run creative
 * ask. Structured outputs guarantee the JSON shape; api/_lib/constraints
 * enforces the classes.md budgets server-side with one regenerate-on-invalid
 * retry. Valid parties are written to the shared "stands" pool.
 *
 * Masonry sprite jobs are NOT enqueued yet (scaffold) — the client keeps the
 * procedural fallback sprites; see docs/GM-DEPLOY.md.
 */
import type {
  GeneratedCatKit,
  GmPartyResponse,
} from "../../src/services/gmTypes";
import { getAnthropicGen, gmPartyModel } from "../_lib/anthropic";
import { lintParty, ROLE_STAT_TOTALS } from "../_lib/constraints";
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
import { getPool, type PoolStore } from "../_lib/pool";

/* ------------------------------------------------------------------------ */
/* JSON schema (hand-written to match GeneratedCatKit)                       */
/* ------------------------------------------------------------------------ */

const STATS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hp", "atk", "def", "spd", "crt", "enMax"],
  properties: {
    hp: { type: "integer" },
    atk: { type: "integer" },
    def: { type: "integer" },
    spd: { type: "integer" },
    crt: { type: "integer" },
    enMax: { type: "integer" },
  },
};

const GROWTH_ROW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    hp: { type: "integer" },
    atk: { type: "integer" },
    def: { type: "integer" },
    spd: { type: "integer" },
    crt: { type: "integer" },
  },
};

const STATUS_ENUM = [
  "scratched",
  "frazzled",
  "offBalance",
  "guarded",
  "provoked",
  "mending",
];

const SKILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "desc",
    "cost",
    "usableFrom",
    "target",
    "power",
    "kind",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    desc: { type: "string" },
    cost: { type: "integer" },
    usableFrom: { type: "array", items: { type: "integer" } },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["side", "ranks", "pattern"],
      properties: {
        side: { enum: ["enemy", "ally", "self"] },
        ranks: { type: "array", items: { type: "integer" } },
        pattern: { enum: ["single", "row"] },
      },
    },
    power: { type: "integer" },
    kind: { enum: ["damage", "heal", "utility"] },
    moveTarget: { type: "integer" },
    moveSelf: { type: "integer" },
    applies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["status", "chance"],
        properties: {
          status: { enum: STATUS_ENUM },
          chance: { type: "number" },
          value: { type: "integer" },
          to: { enum: ["target", "self", "allEnemies"] },
        },
      },
    },
    cleanses: { type: "array", items: { enum: STATUS_ENUM } },
    revivePct: { type: "number" },
    oncePerBattle: { type: "boolean" },
    energyGain: { type: "integer" },
  },
};

const KIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "role",
    "catName",
    "className",
    "epithet",
    "base",
    "growth",
    "skills",
    "trait",
    "stand",
    "flavor",
  ],
  properties: {
    role: { enum: ["tank", "striker", "control", "support"] },
    catName: { type: "string" },
    className: { type: "string" },
    epithet: { type: "string" },
    base: STATS_SCHEMA,
    growth: { type: "array", items: GROWTH_ROW_SCHEMA },
    skills: { type: "array", items: SKILL_SCHEMA },
    trait: {
      type: "object",
      additionalProperties: false,
      required: ["name", "desc"],
      properties: { name: { type: "string" }, desc: { type: "string" } },
    },
    stand: {
      type: "object",
      additionalProperties: false,
      required: ["name", "visualPrompt"],
      properties: {
        name: { type: "string" },
        visualPrompt: { type: "string" },
      },
    },
    flavor: {
      type: "object",
      additionalProperties: false,
      required: ["bio", "barks"],
      properties: {
        bio: { type: "string" },
        barks: {
          type: "object",
          additionalProperties: false,
          required: ["crit", "ko", "catPile"],
          properties: {
            crit: { type: "string" },
            ko: { type: "string" },
            catPile: { type: "string" },
          },
        },
      },
    },
  },
};

export const PARTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kits"],
  properties: { kits: { type: "array", items: KIT_SCHEMA } },
};

/* ------------------------------------------------------------------------ */
/* Prompts                                                                   */
/* ------------------------------------------------------------------------ */

export const PARTY_SYSTEM = `You are the Game Master of c(at)rpg, a roguelike
about stray cats with Stands (spectral patrons, JoJo homage). You turn player
cat descriptions into MECHANICALLY LEGAL party kits.

HARD BUDGETS (violations are rejected by a server-side lint):
- Exactly 4 kits, roles exactly one each of tank / striker / control / support.
- L1 base stats: enMax is always 10. The sum hp+atk+def+spd+crt must be
  EXACTLY: tank ${ROLE_STAT_TOTALS.tank}, striker ${ROLE_STAT_TOTALS.striker}, control ${ROLE_STAT_TOTALS.control}, support ${ROLE_STAT_TOTALS.support}.
  Per-stat bounds: hp 24..40, atk 9..12, def 0..3, spd 4..8, crt 5..15.
- growth: exactly 7 rows (levels 2..8); keys only hp/atk/def/spd/crt; each
  row's values sum to 1..6.
- skills: exactly 4 per kit, all ids camelCase and unique. Exactly one
  cost-0 basic attack with energyGain 1 and power <= 100. Other costs 1..6,
  summing to <= 16. Damage power <= 150, heal power <= 120, any row-pattern
  power <= 60. moveTarget within -3..3, moveSelf within -2..2, status
  chance in (0, 1]. usableFrom within 1..4; enemy target ranks within 1..5,
  ally/self ranks within 1..4.
- Stand: dramatic ALL-CAPS name; visualPrompt describes the cat solid in
  front with a translucent purple/gold Stand looming behind, anime
  cel-shading, bold ink outlines, flat #1a1626 background.

CONTENT POLICY: family-friendly comedy. If a description is sexual, hateful,
gory, or targets real people, reinterpret it into a harmless cat-universe
concept instead of refusing; never echo inappropriate text back.`;

function buildPartyPrompt(descriptions: string[]): string {
  const lines = descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
  return `Player-described cats (invent the rest of the party yourself so all
four roles are covered; keep player intent for the described ones):

${lines}

Return the full 4-kit party as JSON.`;
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                   */
/* ------------------------------------------------------------------------ */

export interface PartyDeps {
  gen: StructuredGenClient;
  pool: PoolStore;
}

export function lintPartyPayload(
  parsed: unknown,
): LintResult<GeneratedCatKit[]> {
  const root = parsed as { kits?: unknown };
  if (!root || !Array.isArray(root.kits)) {
    return { errors: ['root must be {"kits": [...]}'] };
  }
  const kits = root.kits as GeneratedCatKit[];
  const errors = lintParty(kits);
  return errors.length > 0 ? { errors } : { value: kits, errors: [] };
}

export function createPartyHandler(deps: PartyDeps) {
  return async (req: Request): Promise<Response> => {
    const bad = requirePost(req) ?? rateLimit(req);
    if (bad) return bad;

    const body = (await readJson(req)) as { descriptions?: unknown } | null;
    const descriptions = body?.descriptions;
    if (
      !Array.isArray(descriptions) ||
      descriptions.length < 1 ||
      descriptions.length > 4 ||
      !descriptions.every(
        (d) => typeof d === "string" && d.trim().length > 0 && d.length <= 500,
      )
    ) {
      return errorJson("descriptions must be 1-4 strings of <= 500 chars", 400);
    }

    try {
      const kits = await generateValidated<GeneratedCatKit[]>(deps.gen, {
        model: gmPartyModel(),
        system: PARTY_SYSTEM,
        user: buildPartyPrompt(descriptions as string[]),
        schema: PARTY_SCHEMA,
        lint: lintPartyPayload,
      });
      // Persist to the shared pool (fire-and-forget; pool failures are soft).
      void deps.pool.add("stands", JSON.stringify(kits)).catch(() => undefined);
      const res: GmPartyResponse = { kits, source: "generated" };
      return json(res);
    } catch (err) {
      if (err instanceof GmGenerationError) {
        return errorJson(`generation failed lint: ${err.lintErrors[0]}`, 502);
      }
      return errorJson("gm party generation failed", 502);
    }
  };
}

let deps: PartyDeps | null = null;

export default async function handler(req: Request): Promise<Response> {
  deps ??= { gen: getAnthropicGen(), pool: getPool() };
  return createPartyHandler(deps)(req);
}
