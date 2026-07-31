/**
 * THE cap tables. One home, no mirrors.
 *
 * Every per-floor ceiling the game, the browser lint and the eve DM obey is
 * declared exactly once, here. Until the `api/gm/*` endpoints were retired
 * these numbers existed three times — `api/_lib/constraints.ts` (server lint),
 * `agent/lib/effects.ts` (the ramp the DM is told about) and
 * `src/services/tabletop.ts` (`EVENT_CAPS_MIRROR`, the browser's re-lint) —
 * pinned together by parity tests whose only job was to notice the day they
 * drifted. Now the agent and the browser import the same constants and the
 * parity tests are gone with the duplication they policed.
 *
 * Layer note: this module is deliberately DEPENDENCY-LIGHT. It imports the
 * engine's absolute caps from `core/combat/powers.ts` and nothing else, so the
 * browser, the agent package and `scripts/` can all pull it in without
 * dragging content or validators along.
 */
import { BUDGET_CAPS, EFFECT_CAPS } from "../core/combat/powers.js";
import type { StatusId } from "../core/types.js";
import type { GmRole } from "./gmTypes.js";

/* ------------------------------------------------------------------------ */
/* Shared vocabularies                                                       */
/* ------------------------------------------------------------------------ */

export const GM_ROLES: readonly GmRole[] = [
  "tank",
  "striker",
  "control",
  "support",
];

export const STAT_KEYS = ["hp", "atk", "def", "spd", "crt", "enMax"] as const;
export const GROWTH_KEYS = ["hp", "atk", "def", "spd", "crt"] as const;

export const STATUS_IDS: readonly StatusId[] = [
  "scratched",
  "frazzled",
  "offBalance",
  "guarded",
  "provoked",
  "mending",
];

/** The EXISTING Mewthical hook menu (core/types.ts MewHookId) — never grows. */
export const MEW_HOOKS = [
  "poiseChip2",
  "critOffBalance",
  "appliesAlwaysHit",
  "healsGrantMending",
  "moverOffBalance",
  "ninthBell",
  "catPileDouble",
  "startEnergy6",
] as const;

export const CLASS_IDS = ["bruiser", "trickster", "hexer", "medic"] as const;

/* ------------------------------------------------------------------------ */
/* Party budgets (classes.md)                                                */
/* ------------------------------------------------------------------------ */

/** L1 stat total (hp+atk+def+spd+crt, enMax excluded) required per role. */
export const ROLE_STAT_TOTALS: Record<GmRole, number> = {
  tank: 62, // Bruno   40+10+3+4+5
  striker: 64, // Pixel   28+12+1+8+15
  control: 46, // Mora    24+11+0+6+5
  support: 46, // Baguette 26+9+1+5+5
};

/** Per-stat L1 bounds spanned by the four canonical strays. */
export const STAT_BOUNDS: Record<
  (typeof GROWTH_KEYS)[number],
  [number, number]
> = {
  hp: [24, 40],
  atk: [9, 12],
  def: [0, 3],
  spd: [4, 8],
  crt: [5, 15],
};

export const SKILLS_PER_KIT = 4;
export const MAX_SKILL_COST = 6;
export const MAX_TOTAL_SKILL_COST = 16;
export const MAX_POWER_SINGLE_DAMAGE = 150;
export const MAX_POWER_HEAL = 120;
export const MAX_POWER_ROW = 60;
export const GROWTH_ROWS = 7;
export const MAX_GROWTH_ROW_TOTAL = 6;

/* ------------------------------------------------------------------------ */
/* Event effect caps (per floor)                                             */
/* ------------------------------------------------------------------------ */

/**
 * The numeric ceilings an out-of-combat consequence obeys, whether it came
 * from an authored event option, a one-shot generated event or a line the
 * player typed at the DM. `contentLint.ts` enforces them on authored content;
 * `tabletop.ts#validateEncounterVerdict` re-enforces them in the browser on
 * anything the DM sends back.
 */
export const EVENT_CAPS = {
  damageMax: (floor: number): number => 5 + 3 * floor,
  healMax: (floor: number): number => 10 + 5 * floor,
  shiniesMax: (floor: number): number => 30 + 10 * floor,
  buffMax: 3,
  energyMax: 6,
  restoreLifeMax: 2,
  itemCountMax: 3,
} as const;

/* ------------------------------------------------------------------------ */
/* The per-floor improvisation ramp (in combat)                              */
/* ------------------------------------------------------------------------ */

export const MIN_FLOOR = 1;
export const MAX_FLOOR = 6;

/**
 * How much of a full Stand power one improvised action is worth on this
 * floor: 3/8 on floor 1, exactly one on floor 6, never more.
 */
export function floorRamp(floor: number): number {
  const f = Math.min(MAX_FLOOR, Math.max(MIN_FLOOR, Math.floor(floor)));
  return (2 + f) / 8;
}

/** Budget ceiling for one improvised action on this floor. */
export function improvBudgetCap(floor: number): number {
  return BUDGET_CAPS.cat * floorRamp(floor);
}

/** Per-floor ceiling on a single damage effect. */
export function floorDamageCap(floor: number): number {
  return Math.round(EFFECT_CAPS.damagePct * floorRamp(floor));
}

/** Per-floor ceiling on a single heal effect. */
export function floorHealCap(floor: number): number {
  return Math.round(EFFECT_CAPS.healPct * floorRamp(floor));
}
