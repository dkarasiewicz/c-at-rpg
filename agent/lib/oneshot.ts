/**
 * One-shot output schemas — the capabilities the `api/gm/*` endpoints used to
 * serve, as the shapes their answers must satisfy.
 *
 * WHO HOLDS THESE. `partyOutputSchema` and `resonanceOutputSchema` are declared
 * on the subagents that answer them (`agent/subagents/party/agent.ts`,
 * `agent/subagents/resonance/agent.ts`), so a delegation runs in task mode and
 * the runtime enforces the schema on the child. They are NOT passed per-message
 * by the browser any more: a schema handed to the root DM lost to the root DM's
 * own instructions every single time it was measured (see
 * `src/services/oneshot.ts`). The remaining schemas here are still per-call
 * shapes for `agent/skills/{item,event}.ts`.
 *
 * They are zod mirrors of the SHIPPED contracts in `src/core/types.ts` and
 * `src/services/gmTypes.ts` (the same types `src/services/oneshot.ts`
 * re-validates on receipt), each with a compile-time parity assertion at the
 * bottom of its section: if a core contract changes shape and this file does
 * not, it stops compiling.
 *
 * WHAT A SCHEMA IS ALLOWED TO SAY. It used to say only "shape", and everything
 * numeric was left to the prose brief plus the client lint. That was a mistake
 * with a measured cost: `growth` rows were typed over all six `STAT_KEYS`, so
 * the model was formally permitted to put `enMax` in a growth row — which
 * `contentLint` has never accepted — and a live party came back with the
 * illegal key in all 28 rows. The schema was the only authority the runtime
 * actually enforces, and it was pointing the wrong way.
 *
 * So every bound that is EXPRESSIBLE in a schema is now expressed here, from
 * the shipped tables in `src/services/caps.ts`: the growth key menu, the
 * per-stat bounds, `enMax`, skill costs and powers, the authorable statuses.
 * The runtime holds the answering subagent to them, which is strictly earlier
 * and cheaper than a regeneration round.
 *
 * What a schema still cannot say stays where it already was: relationships
 * between fields (a role's stat SUM, the total skill cost, a growth row's
 * total) and BUDGETS (`powerBudget`). Those remain the client lint's job in
 * `src/services/oneshot.ts`, and the retry loop's. Schemas constrain what is
 * sayable; lints constrain what is fair.
 */
import { z } from "zod";
import type {
  EquipDef,
  GameEvent,
  Rarity,
  Skill,
  Stats,
  StatusApplication,
} from "../../src/core/types.js";
import type {
  GeneratedCatKit,
  GeneratedEquip,
  GmRole,
  InteractionRule,
  PowerScript,
} from "../../src/services/gmTypes.js";
import { POWER_FRAMEWORK_VERSION } from "../../src/core/combat/powers.js";
import {
  CLASS_IDS,
  GROWTH_KEYS,
  GROWTH_ROWS,
  MAX_GROWTH_ROW_TOTAL,
  MAX_POWER_HEAL,
  MAX_POWER_ROW,
  MAX_POWER_SINGLE_DAMAGE,
  MAX_SKILL_COST,
  MEW_HOOKS,
  SKILLS_PER_KIT,
  STAT_BOUNDS,
  STAT_KEYS,
} from "../../src/services/caps.js";
import { STATUS_IDS, TARGET_SELS, effectSpecSchema } from "./effects.js";

/** `never` unless A and B are the same type — the strict parity guard. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * `never` unless every schema value is a valid `B`. The one-directional guard,
 * used where the schema is deliberately NARROWER than the contract (a literal
 * framework version where the contract says `number`, a subset of the fields).
 * Narrower is the safe direction: the engine accepts everything the model can
 * produce, not the other way round.
 */
type Satisfies<A, B> = [A] extends [B] ? true : never;

/* ------------------------------------------------------------------------ */
/* Shared leaves                                                             */
/* ------------------------------------------------------------------------ */

const RARITIES = ["stray", "sleek", "pedigree", "mewthical"] as const;
const EQUIP_SLOTS = ["weapon", "trinket", "collar"] as const;
const ROLES = ["tank", "striker", "control", "support"] as const;

export const statsSchema = z.object({
  hp: z.int(),
  atk: z.int(),
  def: z.int(),
  spd: z.int(),
  crt: z.int(),
  enMax: z.int(),
});
export const STATS_PARITY: Same<z.infer<typeof statsSchema>, Stats> = true;

/**
 * The four stats a generated kit AUTHORS — bounded, and deliberately without
 * `hp` or `enMax`.
 *
 * WHY hp IS MISSING. `contentLint` requires hp+atk+def+spd+crt to equal the
 * role's `ROLE_STAT_TOTALS` entry EXACTLY, and no schema can express a sum, so
 * that was the one bound left for prose to enforce. It did not hold: across
 * live generations, "stat total 63 != 64" was the single most common lint
 * failure, and each one cost a ~90s regeneration for an off-by-one.
 *
 * It is also arithmetic that matters, which the DM is told in the first line of
 * its hard bounds never to do. So it does not: the model picks the four stats
 * that express the cat's character, and `completeBaseStats` in
 * `src/services/oneshot.ts` derives `hp` from the role's total. The sum is then
 * correct by construction rather than by luck, and there is nothing left to
 * regenerate.
 *
 * `enMax` is dropped for the same reason in miniature — it is always
 * `START_EN_MAX`, so asking for it only creates a way to get it wrong.
 */
const authoredStatsSchema = z.object({
  atk: z.int().min(STAT_BOUNDS.atk[0]).max(STAT_BOUNDS.atk[1]),
  def: z.int().min(STAT_BOUNDS.def[0]).max(STAT_BOUNDS.def[1]),
  spd: z.int().min(STAT_BOUNDS.spd[0]).max(STAT_BOUNDS.spd[1]),
  crt: z.int().min(STAT_BOUNDS.crt[0]).max(STAT_BOUNDS.crt[1]),
});
export const AUTHORED_STATS_ARE_PARTIAL_STATS: Satisfies<
  z.infer<typeof authoredStatsSchema>,
  Omit<Stats, "hp" | "enMax">
> = true;

const statusApplicationSchema = z.object({
  status: z.enum(STATUS_IDS),
  // (0, 1]: a zero-chance application is not a thing, and `contentLint` says so.
  chance: z.number().gt(0).max(1),
  value: z.int().optional(),
  to: z.enum(["target", "self", "allEnemies"]).optional(),
});
export const STATUS_APPLICATION_PARITY: Same<
  z.infer<typeof statusApplicationSchema>,
  StatusApplication
> = true;

/**
 * Ranks are 1..5 front-to-back for enemies and 1..4 for a four-cat party;
 * `usableFrom` is where the ACTOR may stand, so it is always the party's four.
 * All three are `contentLint` bounds, stated here so they cannot be broken.
 */
const RANKS = { party: 4, enemy: 5 } as const;

export const skillSchema = z.object({
  // `contentLint#CAMEL_ID`. Stated here because it is trivially expressible and
  // was not: one live party came back with `crush_swipe`, `pip_nudge` and
  // fourteen more snake_case ids — sixteen lint errors and a whole regeneration
  // round for a naming convention the model was never shown in a form it could
  // be held to.
  id: z.string().regex(/^[a-z][a-zA-Z0-9]{1,30}$/),
  name: z.string(),
  desc: z.string(),
  cost: z.int().min(0).max(MAX_SKILL_COST),
  cooldown: z.int().optional(),
  usableFrom: z.array(z.int().min(1).max(RANKS.party)).min(1),
  target: z.object({
    side: z.enum(["enemy", "ally", "self"]),
    ranks: z.array(z.int().min(1).max(RANKS.enemy)).min(1),
    pattern: z.enum(["single", "row"]),
  }),
  // The widest of the three ceilings (single-target damage). The two narrower
  // ones depend on sibling fields, so they are branched in `partySkillSchema`
  // below rather than stated here.
  power: z.int().min(0).max(MAX_POWER_SINGLE_DAMAGE),
  kind: z.enum(["damage", "heal", "utility"]),
  moveTarget: z.int().min(-3).max(3).optional(),
  moveSelf: z.int().min(-2).max(2).optional(),
  applies: z.array(statusApplicationSchema).optional(),
  cleanses: z.array(z.enum(STATUS_IDS)).optional(),
  revivePct: z.number().gt(0).max(0.5).optional(),
  oncePerBattle: z.boolean().optional(),
  energyGain: z.int().optional(),
  aiWeight: z.number().optional(),
});
export const SKILL_PARITY: Same<z.infer<typeof skillSchema>, Skill> = true;

/**
 * A GENERATED skill: `skillSchema` with the two power ceilings that depend on
 * sibling fields branched out, so they are enforceable rather than merely
 * mentioned.
 *
 * `contentLint` prices a skill three ways — `MAX_POWER_ROW` for any `row`
 * pattern, `MAX_POWER_HEAL` for a heal, `MAX_POWER_SINGLE_DAMAGE` for
 * single-target damage — and only the widest of those fits in a flat `max`.
 * A union does fit: it projects to a JSON Schema `anyOf`, which the runtime
 * enforces on the answering subagent. Measured live, "row-pattern power above
 * 60" was the LAST remaining first-pass lint failure once the growth keys and
 * stat bounds were fixed, on a rule the model could only ever have read in
 * prose.
 *
 * `skillSchema` itself stays the flat, strict mirror of `Skill`, because that
 * is what `SKILL_PARITY` is for: a union cannot be `Same<>`-compared with the
 * engine's type, and losing that guard to gain a bound would be a bad trade.
 * Hence a second schema instead of a replacement.
 */
const partySkillSchema = z.union([
  skillSchema.extend({
    target: skillSchema.shape.target.extend({ pattern: z.literal("row") }),
    power: z.int().min(0).max(MAX_POWER_ROW),
  }),
  skillSchema.extend({
    target: skillSchema.shape.target.extend({ pattern: z.literal("single") }),
    kind: z.literal("heal"),
    power: z.int().min(0).max(MAX_POWER_HEAL),
  }),
  skillSchema.extend({
    target: skillSchema.shape.target.extend({ pattern: z.literal("single") }),
    kind: z.enum(["damage", "utility"]),
  }),
]);
export const PARTY_SKILL_PARITY: Satisfies<
  z.infer<typeof partySkillSchema>,
  Skill
> = true;

/* ------------------------------------------------------------------------ */
/* Power Script (stand-powers.md — the DSL core/combat owns)                 */
/* ------------------------------------------------------------------------ */

const powerPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hpBelowPct"), pct: z.int().min(1).max(100) }),
  z.object({
    kind: z.literal("targetHasStatus"),
    status: z.enum(STATUS_IDS),
  }),
  z.object({
    kind: z.literal("selfRank"),
    ranks: z.array(z.int().min(1).max(5)).min(1),
  }),
  z.object({ kind: z.literal("roundAtLeast"), n: z.int().min(1) }),
  z.object({ kind: z.literal("chance"), pct: z.int().min(1).max(100) }),
]);

/**
 * `PowerScript` minus `budget`: the service recomputes and stamps it with
 * `powerBudget()` — models never compute their own budgets (the rule
 * `src/services/powerLint.ts#normalizePower` enforces on receipt).
 */
export const powerScriptSchema = z.object({
  id: z.string().regex(/^power:[a-z][a-zA-Z0-9]{1,40}$/),
  version: z.literal(POWER_FRAMEWORK_VERSION),
  name: z.string().min(1).max(60),
  flavor: z.string().min(1).max(200),
  trigger: z.enum([
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
  ]),
  conditions: z.array(powerPredicateSchema).max(3),
  effects: z.array(effectSpecSchema).min(1).max(3),
  charges: z
    .object({
      perBattle: z.int().min(1).max(3).optional(),
      perRound: z.int().min(1).max(3).optional(),
    })
    .optional(),
});
export const POWER_SCRIPT_PARITY: Satisfies<
  z.infer<typeof powerScriptSchema>,
  Omit<PowerScript, "budget">
> = true;

/* ------------------------------------------------------------------------ */
/* /api/gm/party                                                             */
/* ------------------------------------------------------------------------ */

const catKitSchema = z.object({
  role: z.enum(ROLES),
  catName: z.string().min(1).max(40),
  className: z.string().min(1).max(40),
  epithet: z.string().min(1).max(80),
  base: authoredStatsSchema,
  // GROWTH_KEYS, not STAT_KEYS. `enMax` does not grow, and a growth row that
  // mentions it is rejected outright by `contentLint` — this schema used to
  // permit it, and every live party spent all 28 of its growth rows saying so.
  growth: z
    .array(
      z.partialRecord(
        z.enum(GROWTH_KEYS),
        z.int().min(0).max(MAX_GROWTH_ROW_TOTAL),
      ),
    )
    .length(GROWTH_ROWS),
  skills: z.array(partySkillSchema).length(SKILLS_PER_KIT),
  trait: z.object({ name: z.string(), desc: z.string() }),
  stand: z.object({ name: z.string(), visualPrompt: z.string() }),
  power: powerScriptSchema.extend({ budget: z.number() }),
  flavor: z.object({
    bio: z.string(),
    barks: z.object({
      crit: z.string(),
      ko: z.string(),
      catPile: z.string(),
    }),
  }),
});

export const partyOutputSchema = z.object({
  kits: z.array(catKitSchema).length(4),
});

export const ROLE_PARITY: Same<z.infer<typeof catKitSchema>["role"], GmRole> =
  true;

/**
 * An authored kit is a `GeneratedCatKit` MINUS the two stats the client
 * derives: `completeBaseStats` in `src/services/oneshot.ts` fills `hp` from
 * `ROLE_STAT_TOTALS` and `enMax` from the shipped start value, and only then is
 * the payload a `GeneratedCatKit`. Everything else still has to match the
 * shipped contract exactly, which is what this assertion is for.
 */
export const CAT_KIT_PARITY: Satisfies<
  z.infer<typeof catKitSchema>,
  Omit<GeneratedCatKit, "base"> & { base: Omit<Stats, "hp" | "enMax"> }
> = true;

/* ------------------------------------------------------------------------ */
/* /api/gm/item                                                              */
/* ------------------------------------------------------------------------ */

const equipDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  slot: z.enum(EQUIP_SLOTS),
  classId: z.enum(CLASS_IDS).optional(),
  primary: z.enum(STAT_KEYS),
  secondaryPool: z.tuple([z.enum(STAT_KEYS), z.enum(STAT_KEYS)]),
  uniqueId: z.enum(MEW_HOOKS).optional(),
  uniqueName: z.string().optional(),
});
export const EQUIP_DEF_PARITY: Same<
  z.infer<typeof equipDefSchema>,
  EquipDef
> = true;

const generatedEquipSchema = equipDefSchema.extend({
  iconPrompt: z.string().min(1).max(400),
});
export const GENERATED_EQUIP_PARITY: Same<
  z.infer<typeof generatedEquipSchema>,
  GeneratedEquip
> = true;

export const itemOutputSchema = z.object({ equip: generatedEquipSchema });

export const rarityOutputSchema = z.enum(RARITIES);
export const RARITY_PARITY: Same<
  z.infer<typeof rarityOutputSchema>,
  Rarity
> = true;

/* ------------------------------------------------------------------------ */
/* /api/gm/event                                                             */
/* ------------------------------------------------------------------------ */

const targetSelSchema = z.enum([
  "party",
  "random",
  "lowestHp",
  "lowestLives",
  "gateCat",
]);

const scalarSchema = z.union([
  z.number(),
  z.object({ base: z.number(), perFloor: z.number() }),
]);

const simpleEffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("heal"),
    target: targetSelSchema,
    amount: scalarSchema,
  }),
  z.object({
    kind: z.literal("damage"),
    target: targetSelSchema,
    amount: scalarSchema,
  }),
  z.object({
    kind: z.literal("buff"),
    target: targetSelSchema,
    stat: z.enum(["atk", "def", "spd", "crt", "hpMax"]),
    amount: z.int(),
    duration: z.enum(["floor", "run"]),
  }),
  z.object({ kind: z.literal("shinies"), amount: scalarSchema }),
  z.object({
    kind: z.literal("giveItem"),
    item: z.string(),
    count: z.int().optional(),
  }),
  z.object({
    kind: z.literal("takeItem"),
    item: z.string(),
    count: z.int().optional(),
  }),
  z.object({
    kind: z.literal("restoreLife"),
    target: z.literal("lowestLives"),
    amount: z.int(),
  }),
  z.object({
    kind: z.literal("energyNextBattle"),
    target: targetSelSchema,
    amount: z.int(),
  }),
  z.object({ kind: z.literal("nothing") }),
]);

const fightEffectSchema = z.object({
  kind: z.literal("fight"),
  encounter: z.array(z.string()).min(1).max(5),
  loot: z.enum(["none", "normal", "bonus"]),
  onWinEffects: z.array(simpleEffectSchema).optional(),
});

const eventEffectSchema = z.union([simpleEffectSchema, fightEffectSchema]);

const gameEventSchema = z.object({
  id: z.string().regex(/^gm[A-Z][a-zA-Z0-9]{1,40}$/),
  title: z.string().min(1).max(60),
  prompt: z.string().min(1).max(600),
  weight: z.int().min(1),
  floors: z.tuple([z.int().min(1).max(6), z.int().min(1).max(6)]),
  once: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        outcomes: z
          .array(
            z.object({
              weight: z.int().min(1),
              text: z.string().min(1).max(400),
              effects: z.array(eventEffectSchema).max(3),
            }),
          )
          .min(1)
          .max(4),
      }),
    )
    .min(2)
    .max(4),
});

export const eventOutputSchema = z.object({ event: gameEventSchema });

/**
 * Structural parity only: `GameEvent.options[].requires` (the `Requirement`
 * union) is deliberately NOT offered to the model here — a free-text-authored
 * event with a class/stat gate is what `gateCat` targeting exists for, and
 * `api/gm/event` already lints that pairing. The schema is therefore a subset
 * of `GameEvent`, which is exactly the direction that is safe.
 */
export const GAME_EVENT_IS_SUBSET: z.infer<typeof gameEventSchema> extends Omit<
  GameEvent,
  "options"
> &
  Record<string, unknown>
  ? true
  : never = true;

/* ------------------------------------------------------------------------ */
/* /api/gm/resonance (stand-powers.md Layer 3)                               */
/* ------------------------------------------------------------------------ */

/**
 * Rule BODY only, exactly as `api/gm/resonance` accepts it: `pairKey`,
 * `version`, `budget`, `flavor` and `announce` are stamped by the caller
 * (`resonancePairKey()` + `powerBudget()`), never authored inside the rule.
 */
const resonanceRuleSchema = z.object({
  trigger: powerScriptSchema.shape.trigger,
  conditions: z.array(powerPredicateSchema).max(3),
  effects: z.array(effectSpecSchema).min(1).max(3),
});

export const RESONANCE_RULE_PARITY: Same<
  z.infer<typeof resonanceRuleSchema>,
  Pick<InteractionRule, "trigger" | "conditions" | "effects">
> = true;

/** Mirrors `ResonanceVerdict` in api/gm/resonance.ts. */
export const resonanceOutputSchema = z.object({
  hasResonance: z.boolean(),
  rule: resonanceRuleSchema.nullable(),
  flavor: z.string().min(1).max(200),
  announce: z.string().max(200),
});

/* ------------------------------------------------------------------------ */
/* Run-beat output (the tabletop layer's own one-shot)                       */
/* ------------------------------------------------------------------------ */

/**
 * What a client asks for after a free-text beat when it wants the whole answer
 * in one payload instead of reading the tool-call stream: the narration plus
 * everything the DM authorised this turn.
 */
export const beatOutputSchema = z.object({
  narration: z.string().min(1).max(600),
  refused: z.boolean(),
  effects: z.array(effectSpecSchema).max(3),
  items: z.array(z.object({ item: z.string(), count: z.int().min(1) })).max(3),
  shinies: z.int(),
  remembered: z.array(z.string().max(240)).max(4),
});

/** Re-exported so a caller can build its own bounded schemas. */
export { effectSpecSchema, STATUS_IDS, TARGET_SELS };
