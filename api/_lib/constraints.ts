/**
 * Hard mechanical constraint lints for GM-generated content (pure functions,
 * unit-tested in tests/gm.spec.ts).
 *
 * Numbers are anchored to the shipped content:
 *  - role stat totals / bounds: the four canonical strays in
 *    docs/design/classes.md (Bruno 62 / Pixel 64 / Mora 46 / Baguette 46,
 *    excluding enMax which is always 10);
 *  - skill budget: 4 skills per cat incl. one cost-0 basic (classes.md §14
 *    content budget), costs 0..6, Σ non-basic costs <= 16 (Baguette's kit is
 *    the ceiling), power caps from the §4 reference table;
 *  - event effect caps: per-floor numeric ceilings layered on top of
 *    core/events/validate (which enforces the structural invariants);
 *  - items: loot.md shapes, hooks only from the EXISTING MewHookId menu.
 *
 * Everything returns human-readable error strings; empty array = valid.
 */
import type { GameEvent, Rarity, Skill, StatusId } from "../../src/core/types";
import { resolveScalar } from "../../src/core/events/resolve";
import { validateEvents } from "../../src/core/events/validate";
import { EQUIP_DEFS } from "../../src/content/equipment";
import { EVENTS } from "../../src/content/events";
import type {
  GeneratedCatKit,
  GeneratedEquip,
  GmRole,
  GmSteerNudges,
} from "../../src/services/gmTypes";

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

const CLASS_IDS = ["bruiser", "trickster", "hexer", "medic"] as const;

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

const SKILLS_PER_KIT = 4;
const MAX_SKILL_COST = 6;
const MAX_TOTAL_SKILL_COST = 16;
const MAX_POWER_SINGLE_DAMAGE = 150;
const MAX_POWER_HEAL = 120;
const MAX_POWER_ROW = 60;
const GROWTH_ROWS = 7;
const MAX_GROWTH_ROW_TOTAL = 6;

const CAMEL_ID = /^[a-z][a-zA-Z0-9]{1,30}$/;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function lintSkill(skill: Skill, at: string, errors: string[]): void {
  if (!CAMEL_ID.test(skill.id)) errors.push(`${at}: skill id not camelCase`);
  if (!isInt(skill.cost) || skill.cost < 0 || skill.cost > MAX_SKILL_COST) {
    errors.push(`${at}: cost must be an integer 0..${MAX_SKILL_COST}`);
  }
  if (!isInt(skill.power) || skill.power < 0) {
    errors.push(`${at}: power must be an integer >= 0`);
  }
  if (skill.kind === "heal" && skill.power > MAX_POWER_HEAL) {
    errors.push(`${at}: heal power above ${MAX_POWER_HEAL}`);
  }
  if (skill.kind === "damage" && skill.power > MAX_POWER_SINGLE_DAMAGE) {
    errors.push(`${at}: damage power above ${MAX_POWER_SINGLE_DAMAGE}`);
  }
  if (skill.target.pattern === "row" && skill.power > MAX_POWER_ROW) {
    errors.push(`${at}: row-pattern power above ${MAX_POWER_ROW}`);
  }
  if (
    skill.usableFrom.length === 0 ||
    !skill.usableFrom.every((r) => isInt(r) && r >= 1 && r <= 4)
  ) {
    errors.push(`${at}: usableFrom must be a non-empty subset of 1..4`);
  }
  const maxRank = skill.target.side === "enemy" ? 5 : 4;
  if (
    skill.target.ranks.length === 0 ||
    !skill.target.ranks.every((r) => isInt(r) && r >= 1 && r <= maxRank)
  ) {
    errors.push(
      `${at}: target ranks must be a non-empty subset of 1..${maxRank}`,
    );
  }
  if (
    skill.moveTarget !== undefined &&
    (!isInt(skill.moveTarget) || Math.abs(skill.moveTarget) > 3)
  ) {
    errors.push(`${at}: moveTarget outside -3..3`);
  }
  if (
    skill.moveSelf !== undefined &&
    (!isInt(skill.moveSelf) || Math.abs(skill.moveSelf) > 2)
  ) {
    errors.push(`${at}: moveSelf outside -2..2`);
  }
  if (
    skill.energyGain !== undefined &&
    (!isInt(skill.energyGain) || skill.energyGain < 0 || skill.energyGain > 2)
  ) {
    errors.push(`${at}: energyGain outside 0..2`);
  }
  if (
    skill.revivePct !== undefined &&
    (skill.revivePct <= 0 || skill.revivePct > 0.5)
  ) {
    errors.push(`${at}: revivePct outside (0, 0.5]`);
  }
  for (const app of skill.applies ?? []) {
    if (!STATUS_IDS.includes(app.status)) {
      errors.push(`${at}: unknown status '${String(app.status)}'`);
    }
    if (typeof app.chance !== "number" || app.chance <= 0 || app.chance > 1) {
      errors.push(`${at}: status chance outside (0, 1]`);
    }
  }
  for (const s of skill.cleanses ?? []) {
    if (!STATUS_IDS.includes(s)) {
      errors.push(`${at}: unknown cleanse status '${String(s)}'`);
    }
  }
}

/** Lint one generated kit against the classes.md budgets. */
export function lintKit(kit: GeneratedCatKit, index: number): string[] {
  const errors: string[] = [];
  const at = `kit ${index} (${kit.catName || "?"})`;

  if (!GM_ROLES.includes(kit.role)) {
    errors.push(`${at}: unknown role '${String(kit.role)}'`);
    return errors;
  }

  // ── stat budget ────────────────────────────────────────────────────────
  const base = kit.base;
  if (base.enMax !== 10) errors.push(`${at}: enMax must be exactly 10`);
  let total = 0;
  for (const key of GROWTH_KEYS) {
    const v = base[key];
    if (!isInt(v)) {
      errors.push(`${at}: base.${key} must be an integer`);
      continue;
    }
    const [lo, hi] = STAT_BOUNDS[key];
    if (v < lo || v > hi) {
      errors.push(`${at}: base.${key}=${v} outside ${lo}..${hi}`);
    }
    total += v;
  }
  if (total !== ROLE_STAT_TOTALS[kit.role]) {
    errors.push(
      `${at}: stat total ${total} != ${ROLE_STAT_TOTALS[kit.role]} required for role '${kit.role}'`,
    );
  }

  // ── growth rows ────────────────────────────────────────────────────────
  if (kit.growth.length !== GROWTH_ROWS) {
    errors.push(`${at}: growth must have exactly ${GROWTH_ROWS} rows`);
  }
  kit.growth.forEach((row, ri) => {
    let rowTotal = 0;
    for (const [key, v] of Object.entries(row)) {
      if (!(GROWTH_KEYS as readonly string[]).includes(key)) {
        errors.push(`${at}: growth row ${ri} has illegal key '${key}'`);
        continue;
      }
      if (!isInt(v) || v < 0) {
        errors.push(`${at}: growth row ${ri}.${key} must be an integer >= 0`);
        continue;
      }
      rowTotal += v;
    }
    if (rowTotal < 1 || rowTotal > MAX_GROWTH_ROW_TOTAL) {
      errors.push(
        `${at}: growth row ${ri} total ${rowTotal} outside 1..${MAX_GROWTH_ROW_TOTAL}`,
      );
    }
  });

  // ── skill budget ───────────────────────────────────────────────────────
  if (kit.skills.length !== SKILLS_PER_KIT) {
    errors.push(`${at}: must have exactly ${SKILLS_PER_KIT} skills`);
  }
  const ids = new Set<string>();
  let basics = 0;
  let costSum = 0;
  kit.skills.forEach((skill, si) => {
    const sat = `${at} skill ${si} ('${skill.id}')`;
    if (ids.has(skill.id)) errors.push(`${sat}: duplicate skill id`);
    ids.add(skill.id);
    lintSkill(skill, sat, errors);
    if (skill.cost === 0) {
      basics++;
      if (skill.energyGain !== 1) {
        errors.push(`${sat}: the cost-0 basic must have energyGain 1`);
      }
      if (skill.power > 100) {
        errors.push(`${sat}: the cost-0 basic power above 100`);
      }
    } else {
      costSum += skill.cost;
    }
  });
  if (basics !== 1) {
    errors.push(`${at}: must have exactly one cost-0 basic (has ${basics})`);
  }
  if (costSum > MAX_TOTAL_SKILL_COST) {
    errors.push(
      `${at}: non-basic skill costs sum to ${costSum} > ${MAX_TOTAL_SKILL_COST}`,
    );
  }

  // ── stand / flavor presence ────────────────────────────────────────────
  if (!kit.stand.name.trim()) errors.push(`${at}: empty stand name`);
  if (!kit.stand.visualPrompt.trim()) {
    errors.push(`${at}: empty stand visualPrompt`);
  }
  return errors;
}

/** Party-level lint: 4 kits, all four roles covered, plus per-kit budgets. */
export function lintParty(kits: GeneratedCatKit[]): string[] {
  const errors: string[] = [];
  if (kits.length !== 4) {
    errors.push(`party must have exactly 4 kits (has ${kits.length})`);
  }
  const roles = new Set(kits.map((k) => k.role));
  for (const role of GM_ROLES) {
    if (!roles.has(role)) errors.push(`party is missing the '${role}' role`);
  }
  const names = new Set(kits.map((k) => k.catName.trim().toLowerCase()));
  if (names.size !== kits.length) errors.push("cat names must be unique");
  kits.forEach((kit, i) => errors.push(...lintKit(kit, i)));
  return errors;
}

/* ------------------------------------------------------------------------ */
/* Event effect caps (per floor)                                             */
/* ------------------------------------------------------------------------ */

export const EVENT_CAPS = {
  damageMax: (floor: number): number => 5 + 3 * floor,
  healMax: (floor: number): number => 10 + 5 * floor,
  shiniesMax: (floor: number): number => 30 + 10 * floor,
  buffMax: 3,
  energyMax: 6,
  restoreLifeMax: 2,
  itemCountMax: 3,
} as const;

const GM_EVENT_ID = /^gm[A-Z][a-zA-Z0-9]{1,40}$/;

/**
 * Numeric caps layered on top of core/events/validate. `lintEvent` below
 * runs both; this facet alone is what tests exercise for the cap table.
 */
export function lintEventCaps(event: GameEvent): string[] {
  const errors: string[] = [];
  const at = `event '${event.id}'`;

  if (!GM_EVENT_ID.test(event.id)) {
    errors.push(`${at}: id must match ${String(GM_EVENT_ID)} (gm prefix)`);
  }
  if (EVENTS.some((e) => e.id === event.id)) {
    errors.push(`${at}: id collides with a shipped static event`);
  }
  if (
    !Array.isArray(event.floors) ||
    event.floors.length !== 2 ||
    event.floors[0] < 1 ||
    event.floors[1] > 6 ||
    event.floors[0] > event.floors[1]
  ) {
    errors.push(`${at}: floors must be [lo, hi] within 1..6`);
    return errors;
  }
  const [lo, hi] = event.floors;

  const checkEffects = (
    effects: readonly GameEvent["options"][number]["outcomes"][number]["effects"][number][],
    where: string,
  ): void => {
    for (const eff of effects) {
      for (let f = lo; f <= hi; f++) {
        if (eff.kind === "damage") {
          const v = resolveScalar(eff.amount, f);
          if (v > EVENT_CAPS.damageMax(f)) {
            errors.push(
              `${where}: damage ${v} above cap ${EVENT_CAPS.damageMax(f)} on floor ${f}`,
            );
            break;
          }
        }
        if (eff.kind === "heal") {
          const v = resolveScalar(eff.amount, f);
          if (v > EVENT_CAPS.healMax(f)) {
            errors.push(
              `${where}: heal ${v} above cap ${EVENT_CAPS.healMax(f)} on floor ${f}`,
            );
            break;
          }
        }
        if (eff.kind === "shinies") {
          const v = Math.abs(resolveScalar(eff.amount, f));
          if (v > EVENT_CAPS.shiniesMax(f)) {
            errors.push(
              `${where}: shinies ${v} above cap ${EVENT_CAPS.shiniesMax(f)} on floor ${f}`,
            );
            break;
          }
        }
      }
      if (eff.kind === "buff" && Math.abs(eff.amount) > EVENT_CAPS.buffMax) {
        errors.push(`${where}: buff amount above ${EVENT_CAPS.buffMax}`);
      }
      if (
        eff.kind === "energyNextBattle" &&
        (eff.amount < 1 || eff.amount > EVENT_CAPS.energyMax)
      ) {
        errors.push(
          `${where}: energyNextBattle outside 1..${EVENT_CAPS.energyMax}`,
        );
      }
      if (
        eff.kind === "restoreLife" &&
        eff.amount > EVENT_CAPS.restoreLifeMax
      ) {
        errors.push(`${where}: restoreLife above ${EVENT_CAPS.restoreLifeMax}`);
      }
      if (
        (eff.kind === "giveItem" || eff.kind === "takeItem") &&
        (eff.count ?? 1) > EVENT_CAPS.itemCountMax
      ) {
        errors.push(`${where}: item count above ${EVENT_CAPS.itemCountMax}`);
      }
      if (eff.kind === "fight") {
        if (eff.encounter.length < 1 || eff.encounter.length > 5) {
          errors.push(`${where}: fight encounter must have 1..5 enemies`);
        }
        if (eff.onWinEffects) {
          checkEffects(eff.onWinEffects, `${where}.onWinEffects`);
        }
      }
    }
  };

  event.options.forEach((opt, oi) => {
    opt.outcomes.forEach((outcome, ci) => {
      checkEffects(outcome.effects, `${at} option ${oi} outcome ${ci}`);
    });
  });
  return errors;
}

/**
 * Full event lint: the SAME structural validator the static content passes
 * (core/events/validate — walk-away rule, id cross-refs, weights, …) plus
 * the numeric caps above.
 */
export function lintEvent(event: GameEvent): string[] {
  return [...validateEvents([event]), ...lintEventCaps(event)];
}

/* ------------------------------------------------------------------------ */
/* Items                                                                     */
/* ------------------------------------------------------------------------ */

export function lintItem(equip: GeneratedEquip, rarity: Rarity): string[] {
  const errors: string[] = [];
  const at = `item '${equip.id}'`;

  if (!CAMEL_ID.test(equip.id)) errors.push(`${at}: id not camelCase`);
  if (equip.id in EQUIP_DEFS) {
    errors.push(`${at}: id collides with a shipped equip def`);
  }
  if (!equip.name.trim() || equip.name.length > 40) {
    errors.push(`${at}: name must be 1..40 chars`);
  }
  if (equip.icon.length < 1 || equip.icon.length > 4) {
    errors.push(`${at}: icon must be a 1..4 char glyph`);
  }
  if (equip.slot !== "weapon" && equip.slot !== "trinket") {
    errors.push(`${at}: slot must be weapon|trinket`);
  }
  if (equip.classId !== undefined) {
    if (equip.slot !== "weapon") {
      errors.push(`${at}: classId is weapons-only`);
    }
    if (!(CLASS_IDS as readonly string[]).includes(equip.classId)) {
      errors.push(`${at}: unknown classId '${String(equip.classId)}'`);
    }
  }
  if (!(STAT_KEYS as readonly string[]).includes(equip.primary)) {
    errors.push(`${at}: unknown primary stat`);
  }
  if (
    !Array.isArray(equip.secondaryPool) ||
    equip.secondaryPool.length !== 2 ||
    !equip.secondaryPool.every((k) =>
      (STAT_KEYS as readonly string[]).includes(k),
    ) ||
    equip.secondaryPool[0] === equip.secondaryPool[1]
  ) {
    errors.push(`${at}: secondaryPool must be 2 distinct stat keys`);
  }
  if (rarity === "mewthical") {
    if (
      equip.uniqueId === undefined ||
      !(MEW_HOOKS as readonly string[]).includes(equip.uniqueId)
    ) {
      errors.push(
        `${at}: mewthical items need a uniqueId from the existing hook menu`,
      );
    }
    if (!equip.uniqueName?.trim()) {
      errors.push(`${at}: mewthical items need a uniqueName`);
    }
  } else {
    if (equip.uniqueId !== undefined || equip.uniqueName !== undefined) {
      errors.push(`${at}: only mewthical items may carry a hook`);
    }
  }
  if (!equip.iconPrompt.trim() || equip.iconPrompt.length > 500) {
    errors.push(`${at}: iconPrompt must be 1..500 chars`);
  }
  return errors;
}

/* ------------------------------------------------------------------------ */
/* Steering                                                                  */
/* ------------------------------------------------------------------------ */

export function lintSteer(nudges: GmSteerNudges): string[] {
  const errors: string[] = [];
  if (![-1, 0, 1].includes(nudges.encounterBudgetDelta)) {
    errors.push("encounterBudgetDelta must be -1, 0, or 1");
  }
  if (!["consumables", "equipment", "none"].includes(nudges.shopBias)) {
    errors.push("unknown shopBias");
  }
  if (!nudges.nextEventTheme.trim() || nudges.nextEventTheme.length > 60) {
    errors.push("nextEventTheme must be 1..60 chars");
  }
  if (!nudges.floorIntro.trim() || nudges.floorIntro.length > 200) {
    errors.push("floorIntro must be 1..200 chars");
  }
  return errors;
}
