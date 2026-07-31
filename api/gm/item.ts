/**
 * POST /api/gm/item — floor + rarity roll + party composition → one themed
 * EquipDef in loot.md shapes, hook chosen ONLY from the existing MewHookId
 * menu (no new mechanics), plus an icon prompt for a Masonry job.
 *
 * Pool-first per gm-system.md. Consumable generation is deliberately out of
 * scope for this scaffold (a consumable carries a full battle Skill payload;
 * see docs/GM-DEPLOY.md "Scaffold gaps").
 */
import { ART_STYLE } from "../../src/content/artStyle.js";
import type { Rarity } from "../../src/core/types.js";
import type {
  GeneratedEquip,
  GmItemRequest,
  GmItemResponse,
} from "../../src/services/gmTypes.js";
import { getAnthropicGen, gmModel } from "../_lib/anthropic.js";
import { composeArtPrompt } from "../_lib/artPrompt.js";
import { lintItem, MEW_HOOKS, STAT_KEYS } from "../_lib/constraints.js";
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
import { getPool, shouldUsePool, type PoolStore } from "../_lib/pool.js";

/* ------------------------------------------------------------------------ */
/* JSON schema                                                               */
/* ------------------------------------------------------------------------ */

export const ITEM_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["equip"],
  properties: {
    equip: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "icon",
        "slot",
        "primary",
        "secondaryPool",
        "iconPrompt",
      ],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        icon: { type: "string" },
        slot: { enum: ["weapon", "trinket"] },
        classId: { enum: ["bruiser", "trickster", "hexer", "medic"] },
        primary: { enum: [...STAT_KEYS] },
        secondaryPool: { type: "array", items: { enum: [...STAT_KEYS] } },
        uniqueId: { enum: [...MEW_HOOKS] },
        uniqueName: { type: "string" },
        iconPrompt: { type: "string" },
      },
    },
  },
};

/* ------------------------------------------------------------------------ */
/* Prompts                                                                   */
/* ------------------------------------------------------------------------ */

export const ITEM_SYSTEM = `You are the Game Master of c(at)rpg (stray cats
with Stands, JoJo homage). You author ONE equipment definition in the exact
loot.md EquipDef shape.

HARD RULES (server-side lint rejects violations):
- id: fresh camelCase, must not collide with shipped items.
- slot weapon or trinket; classId only on weapons (bruiser/trickster/hexer/
  medic).
- primary is one stat key; secondaryPool is exactly 2 DISTINCT stat keys.
- MEWTHICAL rarity ONLY: pick uniqueId from the EXISTING hook menu
  (${MEW_HOOKS.join(", ")}) and give it a dramatic uniqueName.
  Any other rarity: NO uniqueId, NO uniqueName. Never invent new mechanics.
- icon: one glyph (a single unicode character). iconPrompt is SUBJECT ONLY:
  describe the object itself (shape, materials, colors, one telling detail) —
  the house art style (cel shading, palette, background, framing) is
  appended automatically by the server. NEVER mention art style, camera,
  backgrounds, or rendering technique in iconPrompt.

CONTENT POLICY: family-friendly comedy; no sexual content, hate, or gore.`;

function buildItemPrompt(req: GmItemRequest): string {
  const parts = [
    `Floor: ${req.floor}. Rarity rolled: ${req.rarity}.`,
    req.partyClasses?.length
      ? `Party: ${req.partyClasses.join(", ")}.`
      : "Party: the four default strays.",
    "Invent one themed item as JSON.",
  ];
  return parts.join("\n");
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                   */
/* ------------------------------------------------------------------------ */

const RARITIES: readonly Rarity[] = ["stray", "sleek", "pedigree", "mewthical"];

export function lintItemPayload(
  rarity: Rarity,
): (parsed: unknown) => LintResult<GeneratedEquip> {
  return (parsed) => {
    const root = parsed as { equip?: unknown };
    if (!root || typeof root.equip !== "object" || root.equip === null) {
      return { errors: ['root must be {"equip": {...}}'] };
    }
    const equip = root.equip as GeneratedEquip;
    const errors = lintItem(equip, rarity);
    return errors.length > 0 ? { errors } : { value: equip, errors: [] };
  };
}

export interface ItemDeps {
  gen: StructuredGenClient;
  pool: PoolStore;
}

export function createItemHandler(deps: ItemDeps) {
  return async (req: Request): Promise<Response> => {
    const bad = requirePost(req) ?? rateLimit(req);
    if (bad) return bad;

    const body = (await readJson(req)) as Partial<GmItemRequest> | null;
    if (
      !body ||
      typeof body.floor !== "number" ||
      body.floor < 1 ||
      body.floor > 6 ||
      !RARITIES.includes(body.rarity as Rarity)
    ) {
      return errorJson("floor (1..6) and rarity are required", 400);
    }
    const input: GmItemRequest = {
      floor: Math.floor(body.floor),
      rarity: body.rarity as Rarity,
      partyClasses: Array.isArray(body.partyClasses)
        ? body.partyClasses
            .filter((s): s is string => typeof s === "string")
            .slice(0, 4)
        : undefined,
    };

    // ── pool-first (entries are stored with their rolled rarity) ───────
    if (await shouldUsePool(deps.pool, "items")) {
      const raw = await deps.pool.sample("items").catch(() => null);
      if (raw) {
        try {
          const entry = JSON.parse(raw) as {
            rarity?: Rarity;
            equip?: GeneratedEquip;
          };
          if (
            entry.rarity === input.rarity &&
            entry.equip &&
            lintItem(entry.equip, input.rarity).length === 0
          ) {
            // pooled rows store the style-free subject; compose against the
            // CURRENT style contract so old rows never leak stale wording
            const res: GmItemResponse = {
              equip: {
                ...entry.equip,
                iconPrompt: composeArtPrompt("icon", entry.equip.iconPrompt),
              },
              source: "pool",
            };
            return json(res);
          }
        } catch {
          // fall through to fresh generation
        }
      }
    }

    // ── fresh generation ───────────────────────────────────────────────
    try {
      const equip = await generateValidated<GeneratedEquip>(deps.gen, {
        model: gmModel(),
        system: ITEM_SYSTEM,
        user: buildItemPrompt(input),
        schema: ITEM_SCHEMA,
        lint: lintItemPayload(input.rarity),
      });
      // pool keeps the style-free subject + the styleVersion it was made at
      void deps.pool
        .add(
          "items",
          JSON.stringify({
            rarity: input.rarity,
            equip,
            styleVersion: ART_STYLE.version,
          }),
        )
        .catch(() => undefined);
      // returned iconPrompt = subject + category framing + basePrompt
      const res: GmItemResponse = {
        equip: {
          ...equip,
          iconPrompt: composeArtPrompt("icon", equip.iconPrompt),
        },
        source: "generated",
      };
      return json(res);
    } catch (err) {
      if (err instanceof GmGenerationError) {
        return errorJson(`generation failed lint: ${err.lintErrors[0]}`, 502);
      }
      return errorJson("gm item generation failed", 502);
    }
  };
}

let deps: ItemDeps | null = null;

export default vercelHandler(async (req) => {
  deps ??= { gen: getAnthropicGen(), pool: getPool() };
  return createItemHandler(deps)(req);
});
