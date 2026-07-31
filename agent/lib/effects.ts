/**
 * The DM's mechanical vocabulary — a zod mirror of the ENGINE'S `EffectSpec`
 * union, validated with the ENGINE'S own lints.
 *
 * docs/design/run-map-and-dm.md §3 "Bounds (non-negotiable)": the GM authors
 * content, never outcomes, and everything it emits is constrained by machinery
 * that already exists and is already tested. So this module owns exactly two
 * things:
 *
 *  1. the zod schema the model sees (a 1:1 mirror of `EffectSpec` in
 *     `src/core/combat/powerTypes.ts` — the parity assertion below is a
 *     compile error the day the union grows a seventh kind);
 *  2. the zod `floorSchema` every tool takes its floor through. The per-floor
 *     ramp itself is re-exported from `src/services/caps.ts`, never restated.
 *
 * The PRICING is not reimplemented here: `powerBudget()` and
 * `validatePowerScript()` are imported from `src/core/combat/powers.ts`, the
 * same pure functions the battle engine runs at setup and the browser runs
 * again on every verdict. An improvised action is priced exactly like a Stand
 * power, because to the interpreter that is precisely what it is.
 */
import { z } from "zod";
import type { StatusId } from "../../src/core/types.js";
import type {
  EffectSpec,
  PowerScript,
  PowerTargetSel,
} from "../../src/core/combat/powerTypes.js";
import {
  EFFECT_CAPS,
  POWER_FRAMEWORK_VERSION,
  STATUS_COST,
  powerBudget,
  validatePowerScript,
} from "../../src/core/combat/powers.js";
import {
  MAX_FLOOR,
  MIN_FLOOR,
  floorDamageCap,
  floorHealCap,
  floorRamp,
  improvBudgetCap,
} from "../../src/services/caps.js";

/* ------------------------------------------------------------------------ */
/* Closed vocabularies, derived from core wherever core exposes them         */
/* ------------------------------------------------------------------------ */

/**
 * The six shipped statuses, read off the engine's own price table (which is
 * typed `Record<StatusId, number>`, so this list cannot drift).
 */
export const STATUS_IDS = Object.keys(STATUS_COST) as [StatusId, ...StatusId[]];

/** `PowerTargetSel` is a type-only union; this is its runtime spelling. */
export const TARGET_SELS: [PowerTargetSel, ...PowerTargetSel[]] = [
  "self",
  "other",
  "allies",
  "enemies",
];

/* ------------------------------------------------------------------------ */
/* The zod mirror of EffectSpec                                              */
/* ------------------------------------------------------------------------ */

const targetSel = z
  .enum(TARGET_SELS)
  .describe(
    "who it lands on: self, other (the trigger counterpart), allies, enemies",
  );

/**
 * `EffectSpec`, as the model sees it. Numeric bounds are the SHIPPED
 * `EFFECT_CAPS` — the absolute ceiling at any floor; `lintImprovisedEffects()`
 * then applies the tighter per-floor ramp.
 */
export const effectSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("damage"),
    target: targetSel,
    pct: z
      .int()
      .min(1)
      .max(EFFECT_CAPS.damagePct)
      .describe("percent of the actor's atk, before def"),
  }),
  z.object({
    kind: z.literal("heal"),
    target: targetSel,
    pct: z
      .int()
      .min(1)
      .max(EFFECT_CAPS.healPct)
      .describe("percent of the actor's atk, capped at max HP"),
  }),
  z.object({
    kind: z.literal("status"),
    target: targetSel,
    status: z.enum(STATUS_IDS),
    value: z
      .int()
      .min(0)
      .max(EFFECT_CAPS.statusValue)
      .optional()
      .describe("magnitude, where the status takes one"),
  }),
  z.object({
    kind: z.literal("move"),
    target: targetSel,
    delta: z
      .int()
      .min(-EFFECT_CAPS.moveDelta)
      .max(EFFECT_CAPS.moveDelta)
      .refine((d) => d !== 0, "delta must be non-zero")
      .describe("forced movement in ranks; negative pulls, positive shoves"),
  }),
  z.object({
    kind: z.literal("energy"),
    target: targetSel,
    amount: z
      .int()
      .min(-EFFECT_CAPS.energyAbs)
      .max(EFFECT_CAPS.energyAbs)
      .refine((a) => a !== 0, "amount must be non-zero")
      .describe("cat energy gain or drain; a no-op on enemies"),
  }),
  z.object({
    kind: z.literal("cleanse"),
    target: targetSel,
    status: z.enum(STATUS_IDS).describe("removes ONE application"),
  }),
]);

/** 1..3 effects, exactly like a `PowerScript` (powers.ts budget lint). */
export const effectListSchema = z
  .array(effectSpecSchema)
  .min(1)
  .max(3)
  .describe("1-3 effects from the engine's closed menu, executed in order");

/**
 * Compile-time proof that the schema above is the SAME union as the engine's.
 * If `EffectSpec` gains, loses, or renames a member and this file is not
 * updated, this assignment stops compiling.
 */
type SchemaEffect = z.infer<typeof effectSpecSchema>;
type MirrorsEffectSpec = [SchemaEffect] extends [EffectSpec]
  ? [EffectSpec] extends [SchemaEffect]
    ? true
    : never
  : never;
export const EFFECT_SPEC_PARITY: MirrorsEffectSpec = true;

/* ------------------------------------------------------------------------ */
/* Per-floor caps                                                            */
/* ------------------------------------------------------------------------ */

/**
 * The floor ramp and the per-floor ceilings are NOT declared here. They live
 * in `src/services/caps.ts`, the single home the browser's re-lint
 * (`services/tabletop.ts`) reads them from as well — so the numbers the DM is
 * briefed with are, by construction, the numbers the client will accept. They
 * were duplicated here and in the client until `api/gm/*` was retired, pinned
 * by parity tests; the tests went with the duplication.
 */
export {
  MAX_FLOOR,
  MIN_FLOOR,
  floorDamageCap,
  floorHealCap,
  floorRamp,
  improvBudgetCap,
};

export const floorSchema = z
  .int()
  .min(MIN_FLOOR)
  .max(MAX_FLOOR)
  .describe("the floor the party is on, 1..6");

/* ------------------------------------------------------------------------ */
/* The lint                                                                  */
/* ------------------------------------------------------------------------ */

export interface EffectLint {
  ok: boolean;
  /** Human-readable reasons, empty when ok. Handed straight to the model. */
  problems: string[];
  /** `powerBudget()` of the effects, priced as an activated power. */
  budget: number;
  /** The floor's budget ceiling. */
  cap: number;
}

/**
 * Price and validate an improvised action with the ENGINE'S lint.
 *
 * The effects are wrapped in a synthetic, conditionless `activated`
 * `PowerScript` (the same trick `validateEncounterVerdict` uses out of combat,
 * wrapping a verdict in a synthetic `GameEvent`) and run through
 * `validatePowerScript`, so an
 * improvised action can never exceed what a shipped Stand power could do — and
 * on floors 1-5, not even that.
 */
export function lintImprovisedEffects(
  effects: EffectSpec[],
  floor: number,
): EffectLint {
  const cap = improvBudgetCap(floor);
  const script: PowerScript = {
    id: "power:gmImprovisation",
    version: POWER_FRAMEWORK_VERSION,
    name: "GM",
    flavor: "an improvised action",
    budget: 0,
    trigger: "activated",
    conditions: [],
    effects,
  };
  script.budget = powerBudget(script);

  const { problems } = validatePowerScript(script, cap);

  // The floor ramp, layered on top of the absolute EFFECT_CAPS the core lint
  // already enforced (exactly how the out-of-combat path layers EVENT_CAPS on
  // top of core/events/validate).
  const dmgCap = floorDamageCap(floor);
  const healCap = floorHealCap(floor);
  for (const e of effects) {
    if (e.kind === "damage" && e.pct > dmgCap) {
      problems.push(`damage pct ${e.pct} above floor-${floor} cap ${dmgCap}`);
    }
    if (e.kind === "heal" && e.pct > healCap) {
      problems.push(`heal pct ${e.pct} above floor-${floor} cap ${healCap}`);
    }
  }

  return { ok: problems.length === 0, problems, budget: script.budget, cap };
}
