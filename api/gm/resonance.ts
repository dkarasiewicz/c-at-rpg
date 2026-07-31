/**
 * POST /api/gm/resonance — memoized Stand-vs-Stand interaction compilation
 * (docs/design/stand-powers.md Layer 3).
 *
 * Request: { pairKey, powers: [PowerScript, PowerScript], sessionId? }.
 *  - pool hit  → the stored InteractionRule|null row, no model call;
 *  - pool miss → compile via structured outputs (GM_MODEL, default
 *    anthropic/claude-haiku-4.5), validate with the core power budget lint at the
 *    resonance cap, store { pairKey, version, json|null, flavor, announce,
 *    first_discovered_by } in the keyed `interactions` table.
 *
 * `null` (no resonance) is a VALID, memoized outcome — the model is
 * instructed that only ~1 in 3 pairs resonate. Discoveries are global:
 * every player enriches the codex; the first compile records the session.
 */
import type {
  GmResonanceRequest,
  GmResonanceResponse,
  InteractionRule,
  PowerScript,
  StoredInteraction,
} from "../../src/services/gmTypes.js";
import { getAnthropicGen, gmModel } from "../_lib/anthropic.js";
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
import { getPool, type PoolStore } from "../_lib/pool.js";
import {
  BUDGET_CAPS,
  EFFECT_CAPS,
  INTERACTION_RULE_SCHEMA,
  lintInteractionRule,
  lintPowerScript,
  normalizePower,
  POWER_FRAMEWORK_VERSION,
  resonancePairKey,
} from "../_lib/powers.js";

/* ------------------------------------------------------------------------ */
/* JSON schema                                                               */
/* ------------------------------------------------------------------------ */

export const RESONANCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["hasResonance", "rule", "flavor", "announce"],
  properties: {
    hasResonance: { type: "boolean" },
    /** null when the pair does not resonate (the common case). */
    rule: { anyOf: [INTERACTION_RULE_SCHEMA, { type: "null" }] },
    flavor: { type: "string" },
    announce: { type: "string" },
  },
};

/* ------------------------------------------------------------------------ */
/* Prompts                                                                   */
/* ------------------------------------------------------------------------ */

export const RESONANCE_SYSTEM = `You are the Game Master of c(at)rpg (stray
cats with Stands, JoJo homage). Two Stand powers meet in battle for the first
time ANYWHERE in the world. Decide whether they RESONATE — produce one extra
deterministic rule in the same Power Script DSL — or not.

POLICY: resonances are notable, NOT universal. Target roughly 1 in 3 pairs,
judged on thematic fit between the two powers. When the pairing is not
genuinely evocative, return hasResonance=false with rule=null (this is the
common, correct answer and is memoized forever).

WHEN A RESONANCE EXISTS (hard rules, server-side lint rejects violations):
- rule reuses ONLY the existing DSL: one trigger, at most 3 conditions, 1-3
  effects from the closed menu (damage/heal/status/move/energy/cleanse).
  No new mechanics, ever.
- caps: damage/heal pct <= ${EFFECT_CAPS.damagePct} (percent of the owner's atk), move delta
  within ±${EFFECT_CAPS.moveDelta}, energy within ±${EFFECT_CAPS.energyAbs}, status value <= ${EFFECT_CAPS.statusValue}; the computed budget
  (trigger frequency x effect costs x condition discounts) must stay under
  the resonance cap ${BUDGET_CAPS.resonance} — a garnish, not a meal, so prefer conditions
  (chance/hpBelowPct) and small effects.
- flavor: one dramatic line (<= 200 chars) describing HOW the powers
  interact.
- announce: the discovery banner, starting with
  "STAND RESONANCE DISCOVERED:" (<= 200 chars).

WHEN THERE IS NO RESONANCE: hasResonance=false, rule=null, flavor one dry
line on why the powers ignore each other, announce an empty string.

CONTENT POLICY: family-friendly comedy; no sexual content, hate, or gore.`;

function buildResonancePrompt(req: GmResonanceRequest): string {
  return [
    `Pair key: ${req.pairKey}`,
    `Power A: ${JSON.stringify(req.powers[0])}`,
    `Power B: ${JSON.stringify(req.powers[1])}`,
    "Judge the pair and answer as JSON.",
  ].join("\n");
}

/* ------------------------------------------------------------------------ */
/* Lint                                                                      */
/* ------------------------------------------------------------------------ */

/** Rule body as the model authors it (envelope fields stamped later). */
export interface ResonanceVerdict {
  rule: Pick<InteractionRule, "trigger" | "conditions" | "effects"> | null;
  flavor: string;
  announce: string;
}

export function lintResonancePayload(
  parsed: unknown,
): LintResult<ResonanceVerdict> {
  const root = parsed as {
    hasResonance?: unknown;
    rule?: unknown;
    flavor?: unknown;
    announce?: unknown;
  };
  if (!root || typeof root !== "object") {
    return { errors: ["root must be an object"] };
  }
  if (typeof root.flavor !== "string" || root.flavor.length > 200) {
    return { errors: ["flavor must be a string of <= 200 chars"] };
  }
  if (typeof root.announce !== "string" || root.announce.length > 200) {
    return { errors: ["announce must be a string of <= 200 chars"] };
  }
  if (root.hasResonance !== true || root.rule === null) {
    // no resonance — a valid, memoizable verdict
    return {
      value: { rule: null, flavor: root.flavor, announce: "" },
      errors: [],
    };
  }
  const rule = root.rule as ResonanceVerdict["rule"] & object;
  const errors = lintInteractionRule(rule);
  if (!root.flavor.trim()) errors.push("resonance flavor must be non-empty");
  if (!root.announce.trim().startsWith("STAND RESONANCE DISCOVERED:")) {
    errors.push('announce must start with "STAND RESONANCE DISCOVERED:"');
  }
  return errors.length > 0
    ? { errors }
    : {
        value: { rule, flavor: root.flavor, announce: root.announce },
        errors: [],
      };
}

/* ------------------------------------------------------------------------ */
/* Handler                                                                   */
/* ------------------------------------------------------------------------ */

export interface ResonanceDeps {
  gen: StructuredGenClient;
  pool: PoolStore;
}

function parseRequest(body: unknown): GmResonanceRequest | string {
  const b = body as Partial<GmResonanceRequest> | null;
  if (!b || typeof b.pairKey !== "string" || b.pairKey.length > 160) {
    return "pairKey is required";
  }
  if (!Array.isArray(b.powers) || b.powers.length !== 2) {
    return "powers must be a pair of PowerScripts";
  }
  const powers = b.powers as [PowerScript, PowerScript];
  for (const p of powers) {
    // defense in depth: both scripts must re-pass the budget lint at the
    // loosest legitimate cap (a tampered script is rejected — mirror of the
    // client-side drop-to-no-op rule).
    const cap = Math.max(BUDGET_CAPS.cat, BUDGET_CAPS.enemyByTier[3]);
    if (lintPowerScript(p, cap).length > 0) {
      return "powers failed the Power Script lint";
    }
  }
  const expected = resonancePairKey(
    powers[0].id,
    powers[1].id,
    POWER_FRAMEWORK_VERSION,
  );
  if (b.pairKey !== expected) {
    return `pairKey must be '${expected}' for these powers`;
  }
  return {
    pairKey: b.pairKey,
    powers,
    sessionId:
      typeof b.sessionId === "string" ? b.sessionId.slice(0, 60) : undefined,
  };
}

function toResponse(
  row: StoredInteraction,
  source: GmResonanceResponse["source"],
): GmResonanceResponse {
  return {
    pairKey: row.pairKey,
    rule: row.json,
    flavor: row.flavor,
    announce: row.announce,
    firstDiscoveredBy: row.first_discovered_by,
    source,
  };
}

export function createResonanceHandler(deps: ResonanceDeps) {
  return async (req: Request): Promise<Response> => {
    const bad = requirePost(req) ?? rateLimit(req);
    if (bad) return bad;

    const input = parseRequest(await readJson(req));
    if (typeof input === "string") return errorJson(input, 400);

    // ── memo hit: stored rule (or stored null) short-circuits the model ──
    const stored = await deps.pool
      .getEntry("interactions", input.pairKey)
      .catch(() => null);
    if (stored) {
      try {
        const row = JSON.parse(stored) as StoredInteraction;
        // stale-framework rows fall through to recompilation
        if (row.version === POWER_FRAMEWORK_VERSION) {
          return json(toResponse(row, "pool"));
        }
      } catch {
        // corrupt row — fall through to fresh compilation
      }
    }

    // ── miss: compile once, memoize (null included) ──────────────────────
    try {
      const verdict = await generateValidated<ResonanceVerdict>(deps.gen, {
        model: gmModel(),
        system: RESONANCE_SYSTEM,
        user: buildResonancePrompt(input),
        schema: RESONANCE_SCHEMA,
        lint: lintResonancePayload,
      });
      // stamp the envelope: full core InteractionRule with a server-computed
      // budget (models never do their own arithmetic)
      const rule: InteractionRule | null = verdict.rule
        ? {
            pairKey: input.pairKey,
            version: POWER_FRAMEWORK_VERSION,
            trigger: verdict.rule.trigger,
            conditions: verdict.rule.conditions,
            effects: verdict.rule.effects,
            flavor: verdict.flavor,
            announce: verdict.announce,
            budget: normalizePower({
              id: "power:resonanceCandidate",
              version: POWER_FRAMEWORK_VERSION,
              name: "RESONANCE",
              flavor: verdict.flavor,
              trigger: verdict.rule.trigger,
              conditions: verdict.rule.conditions,
              effects: verdict.rule.effects,
            }).budget,
          }
        : null;
      const row: StoredInteraction = {
        pairKey: input.pairKey,
        version: POWER_FRAMEWORK_VERSION,
        json: rule,
        flavor: verdict.flavor,
        announce: verdict.announce,
        first_discovered_by: input.sessionId,
      };
      // awaited (not fire-and-forget) so the memo is durable before the
      // discovery is announced; store failures are soft.
      await deps.pool
        .setEntry("interactions", input.pairKey, JSON.stringify(row))
        .catch(() => undefined);
      return json(toResponse(row, "generated"));
    } catch (err) {
      if (err instanceof GmGenerationError) {
        return errorJson(`compilation failed lint: ${err.lintErrors[0]}`, 502);
      }
      return errorJson("gm resonance compilation failed", 502);
    }
  };
}

export default vercelHandler(async (req) => {
  const deps: ResonanceDeps = { gen: getAnthropicGen(req), pool: getPool() };
  return createResonanceHandler(deps)(req);
});
