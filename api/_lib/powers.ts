/**
 * Server-side Power Script validation for /api/gm/party and /api/gm/resonance
 * (stand-powers.md §Balance: "the lint runs server-side at compile time AND
 * client-side at battle setup").
 *
 * The budget pricing is NOT duplicated here: `powerBudget` and
 * `validatePowerScript` are the canonical pure functions from
 * src/core/combat/powers.ts (pure logic — the api package already imports
 * core validators the same way, e.g. core/events/validate). This module adds
 * the service-side wrapping: error-string lints for the generate→retry
 * pipeline, budget stamping (models never compute budgets), the canonical
 * resonance pair key, stock fallback powers, and the structured-outputs
 * JSON schemas for the DSL.
 */
import {
  BUDGET_CAPS,
  EFFECT_CAPS,
  POWER_FRAMEWORK_VERSION,
  powerBudget,
  validatePowerScript,
} from "../../src/core/combat/powers";
import { CAT_POWERS } from "../../src/content/powers";
import type {
  GmRole,
  InteractionRule,
  PowerScript,
  PowerTrigger,
} from "../../src/services/gmTypes";
import { STATUS_IDS } from "./constraints";

export {
  BUDGET_CAPS,
  EFFECT_CAPS,
  POWER_FRAMEWORK_VERSION,
  powerBudget,
  validatePowerScript,
};

const POWER_ID = /^power:[a-z][a-zA-Z0-9]{1,40}$/;

export const POWER_TRIGGERS: readonly PowerTrigger[] = [
  "onBattleStart",
  "onTurnStart",
  "onTurnEnd",
  "onDealHit",
  "onTakeHit",
  "onCrit",
  "onAllyKO",
  "onStatusApplied",
  "onForcedMove",
  "activated",
];

const TARGET_SELS = ["self", "other", "allies", "enemies"] as const;

/** sortedPair(A.id, B.id) + framework version (stand-powers.md Layer 3). */
export function resonancePairKey(
  aId: string,
  bId: string,
  version: number = POWER_FRAMEWORK_VERSION,
): string {
  return `${[aId, bId].sort().join("+")}@v${version}`;
}

/* ------------------------------------------------------------------------ */
/* Lint wrappers (error-string form for generateValidated)                   */
/* ------------------------------------------------------------------------ */

/** Structural sanity for MODEL-authored scripts before the core lint runs. */
function lintShape(
  script: Omit<PowerScript, "budget"> & { budget?: number },
  at: string,
): string[] {
  if (typeof script !== "object" || script === null) {
    return [`${at}: power must be an object`];
  }
  const errors: string[] = [];
  if (!POWER_ID.test(script.id ?? "")) {
    errors.push(`${at}: id must match ${String(POWER_ID)}`);
  }
  if (
    typeof script.name !== "string" ||
    !script.name.trim() ||
    script.name.length > 60
  ) {
    errors.push(`${at}: name must be 1..60 chars`);
  }
  if (
    typeof script.flavor !== "string" ||
    !script.flavor.trim() ||
    script.flavor.length > 200
  ) {
    errors.push(`${at}: flavor must be 1..200 chars`);
  }
  if (!POWER_TRIGGERS.includes(script.trigger)) {
    errors.push(`${at}: unknown trigger '${String(script.trigger)}'`);
  }
  if (!Array.isArray(script.conditions) || !Array.isArray(script.effects)) {
    errors.push(`${at}: conditions and effects must be arrays`);
  } else {
    script.conditions.forEach((c, i) => {
      if (typeof c !== "object" || c === null) {
        errors.push(`${at}: condition ${i} must be an object`);
        return;
      }
      if (
        (c.kind === "hpBelowPct" || c.kind === "chance") &&
        (!Number.isInteger(c.pct) || c.pct < 1 || c.pct > 100)
      ) {
        errors.push(`${at}: condition ${i} pct must be an integer 1..100`);
      }
      if (c.kind === "targetHasStatus" && !STATUS_IDS.includes(c.status)) {
        errors.push(`${at}: condition ${i} unknown status`);
      }
      if (
        c.kind === "selfRank" &&
        (!Array.isArray(c.ranks) ||
          c.ranks.length === 0 ||
          !c.ranks.every((r) => Number.isInteger(r) && r >= 1 && r <= 5))
      ) {
        errors.push(`${at}: condition ${i} ranks must be a subset of 1..5`);
      }
      if (c.kind === "roundAtLeast" && (!Number.isInteger(c.n) || c.n < 1)) {
        errors.push(`${at}: condition ${i} n must be an integer >= 1`);
      }
    });
    const EFFECT_KINDS = [
      "damage",
      "heal",
      "status",
      "move",
      "energy",
      "cleanse",
    ];
    const PREDICATE_KINDS = [
      "hpBelowPct",
      "targetHasStatus",
      "selfRank",
      "roundAtLeast",
      "chance",
    ];
    script.conditions.forEach((c, i) => {
      if (c && !PREDICATE_KINDS.includes(c.kind)) {
        errors.push(`${at}: condition ${i} unknown kind '${String(c.kind)}'`);
      }
    });
    script.effects.forEach((e, i) => {
      if (typeof e !== "object" || e === null) {
        errors.push(`${at}: effect ${i} must be an object`);
        return;
      }
      if (!EFFECT_KINDS.includes(e.kind)) {
        errors.push(`${at}: effect ${i} unknown kind '${String(e.kind)}'`);
      }
      if (!(TARGET_SELS as readonly string[]).includes(e.target)) {
        errors.push(`${at}: effect ${i} unknown target '${String(e.target)}'`);
      }
      if (
        (e.kind === "status" || e.kind === "cleanse") &&
        !STATUS_IDS.includes(e.status)
      ) {
        errors.push(`${at}: effect ${i} unknown status`);
      }
      if (
        (e.kind === "damage" || e.kind === "heal") &&
        !Number.isInteger(e.pct)
      ) {
        errors.push(`${at}: effect ${i} pct must be an integer`);
      }
      if (e.kind === "move" && !Number.isInteger(e.delta)) {
        errors.push(`${at}: effect ${i} delta must be an integer`);
      }
      if (e.kind === "energy" && !Number.isInteger(e.amount)) {
        errors.push(`${at}: effect ${i} amount must be an integer`);
      }
    });
  }
  if (script.charges !== undefined) {
    for (const key of ["perBattle", "perRound"] as const) {
      const v = script.charges[key];
      if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 3)) {
        errors.push(`${at}: charges.${key} outside 1..3`);
      }
    }
  }
  return errors;
}

/** Recompute + stamp the budget (models never compute their own). */
export function normalizePower(
  script: Omit<PowerScript, "budget"> & { budget?: number },
): PowerScript {
  const stamped = { ...script, budget: 0 } as PowerScript;
  stamped.budget = powerBudget(stamped);
  return stamped;
}

/**
 * Full service-side lint against a budget cap: shape checks + the SAME core
 * `validatePowerScript` the client runs at battle setup. Empty array = valid.
 * The input's declared budget is ignored (recomputed via normalizePower).
 */
export function lintPowerScript(
  script: Omit<PowerScript, "budget"> & { budget?: number },
  cap: number,
  at = `power '${String((script as { id?: unknown } | null)?.id)}'`,
): string[] {
  const shapeErrors = lintShape(script, at);
  if (shapeErrors.length > 0) return shapeErrors;
  const { problems } = validatePowerScript(normalizePower(script), cap);
  return problems.map((p) => `${at}: ${p}`);
}

/**
 * Interaction-rule lint at the resonance cap (BUDGET_CAPS.resonance). The
 * rule body prices exactly like a power with no charges.
 */
export function lintInteractionRule(
  rule: Pick<InteractionRule, "trigger" | "conditions" | "effects">,
  at = "resonance rule",
): string[] {
  if (typeof rule !== "object" || rule === null) {
    return [`${at}: rule must be an object`];
  }
  return lintPowerScript(
    {
      id: "power:resonanceCandidate",
      version: POWER_FRAMEWORK_VERSION,
      name: "RESONANCE",
      flavor: "resonance rule",
      trigger: rule.trigger,
      conditions: rule.conditions,
      effects: rule.effects,
    },
    BUDGET_CAPS.resonance,
    at,
  );
}

/* ------------------------------------------------------------------------ */
/* Stock fallback powers                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Fallback power per GM role when a generated power fails the lint twice —
 * the shipped stock powers (src/content/powers.ts), mapped role → class
 * exactly as gm-system.md maps the four canonical strays.
 */
export const STOCK_POWERS: Record<GmRole, PowerScript> = {
  tank: CAT_POWERS.bruiser as PowerScript,
  striker: CAT_POWERS.trickster as PowerScript,
  control: CAT_POWERS.hexer as PowerScript,
  support: CAT_POWERS.medic as PowerScript,
};

/* ------------------------------------------------------------------------ */
/* JSON schemas (structured outputs)                                         */
/* ------------------------------------------------------------------------ */

const STATUS_ENUM = [...STATUS_IDS];
const TARGET_ENUM = [...TARGET_SELS];
const TRIGGER_ENUM = [...POWER_TRIGGERS];

export const POWER_PREDICATE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "pct"],
      properties: {
        kind: { const: "hpBelowPct" },
        pct: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "status"],
      properties: {
        kind: { const: "targetHasStatus" },
        status: { enum: STATUS_ENUM },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "ranks"],
      properties: {
        kind: { const: "selfRank" },
        ranks: { type: "array", items: { type: "integer" } },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "n"],
      properties: {
        kind: { const: "roundAtLeast" },
        n: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "pct"],
      properties: {
        kind: { const: "chance" },
        pct: { type: "integer" },
      },
    },
  ],
};

export const POWER_EFFECT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "pct"],
      properties: {
        kind: { const: "damage" },
        target: { enum: TARGET_ENUM },
        pct: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "pct"],
      properties: {
        kind: { const: "heal" },
        target: { enum: TARGET_ENUM },
        pct: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "status"],
      properties: {
        kind: { const: "status" },
        target: { enum: TARGET_ENUM },
        status: { enum: STATUS_ENUM },
        value: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "delta"],
      properties: {
        kind: { const: "move" },
        target: { enum: TARGET_ENUM },
        delta: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "amount"],
      properties: {
        kind: { const: "energy" },
        target: { enum: TARGET_ENUM },
        amount: { type: "integer" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "status"],
      properties: {
        kind: { const: "cleanse" },
        target: { enum: TARGET_ENUM },
        status: { enum: STATUS_ENUM },
      },
    },
  ],
};

/** PowerScript minus `budget` — the server recomputes and stamps it. */
export const POWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "version",
    "name",
    "flavor",
    "trigger",
    "conditions",
    "effects",
  ],
  properties: {
    id: { type: "string" },
    version: { const: POWER_FRAMEWORK_VERSION },
    name: { type: "string" },
    flavor: { type: "string" },
    trigger: { enum: TRIGGER_ENUM },
    conditions: { type: "array", items: POWER_PREDICATE_SCHEMA },
    effects: { type: "array", items: POWER_EFFECT_SCHEMA },
    charges: {
      type: "object",
      additionalProperties: false,
      properties: {
        perBattle: { type: "integer" },
        perRound: { type: "integer" },
      },
    },
  },
};

/** Rule body only — pairKey/version/flavor/announce/budget are stamped. */
export const INTERACTION_RULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["trigger", "conditions", "effects"],
  properties: {
    trigger: { enum: TRIGGER_ENUM },
    conditions: { type: "array", items: POWER_PREDICATE_SCHEMA },
    effects: { type: "array", items: POWER_EFFECT_SCHEMA },
  },
};
