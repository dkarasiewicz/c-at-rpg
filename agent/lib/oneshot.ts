/**
 * One-shot output schemas — the capabilities the `api/gm/*` endpoints used to
 * serve, as schemas a caller passes to a single agent turn.
 *
 * docs/design/run-map-and-dm.md §4: "One-shot still works.
 * `session.send({ message, outputSchema })` returns schema-valid typed data, so
 * party generation, item generation and resonance compilation stay exactly as
 * structured as they are today — no loss."
 *
 * These are the schemas a caller passes as `outputSchema`. They are zod mirrors
 * of the SHIPPED contracts in `src/core/types.ts` and `src/services/gmTypes.ts`
 * (the same types `src/services/oneshot.ts` re-validates on receipt),
 * each with a compile-time parity assertion at the bottom of its section: if a
 * core contract changes shape and this file does not, it stops compiling.
 *
 * Nothing here validates BUDGETS. The numeric budgets (role stat totals, skill
 * costs, event effect caps, item hook menu) stay where they already are —
 * `src/services/caps.ts` and `src/core/combat/powers.ts` — and are stated to
 * the model by the matching skill under `agent/skills/`. Schemas constrain
 * shape; lints constrain power.
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

const STAT_KEYS = ["hp", "atk", "def", "spd", "crt", "enMax"] as const;
const RARITIES = ["stray", "sleek", "pedigree", "mewthical"] as const;
const EQUIP_SLOTS = ["weapon", "trinket", "collar"] as const;
const CLASS_IDS = ["bruiser", "trickster", "hexer", "medic"] as const;
const MEW_HOOKS = [
  "poiseChip2",
  "critOffBalance",
  "appliesAlwaysHit",
  "healsGrantMending",
  "moverOffBalance",
  "ninthBell",
  "catPileDouble",
  "startEnergy6",
] as const;
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

const statusApplicationSchema = z.object({
  status: z.enum(STATUS_IDS),
  chance: z.number().min(0).max(1),
  value: z.int().optional(),
  to: z.enum(["target", "self", "allEnemies"]).optional(),
});
export const STATUS_APPLICATION_PARITY: Same<
  z.infer<typeof statusApplicationSchema>,
  StatusApplication
> = true;

export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  cost: z.int(),
  cooldown: z.int().optional(),
  usableFrom: z.array(z.int()),
  target: z.object({
    side: z.enum(["enemy", "ally", "self"]),
    ranks: z.array(z.int()),
    pattern: z.enum(["single", "row"]),
  }),
  power: z.int(),
  kind: z.enum(["damage", "heal", "utility"]),
  moveTarget: z.int().optional(),
  moveSelf: z.int().optional(),
  applies: z.array(statusApplicationSchema).optional(),
  cleanses: z.array(z.enum(STATUS_IDS)).optional(),
  revivePct: z.number().optional(),
  oncePerBattle: z.boolean().optional(),
  energyGain: z.int().optional(),
  aiWeight: z.number().optional(),
});
export const SKILL_PARITY: Same<z.infer<typeof skillSchema>, Skill> = true;

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
  base: statsSchema,
  growth: z.array(z.partialRecord(z.enum(STAT_KEYS), z.int())).length(7),
  skills: z.array(skillSchema).length(4),
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
export const CAT_KIT_PARITY: Satisfies<
  z.infer<typeof catKitSchema>,
  GeneratedCatKit
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
