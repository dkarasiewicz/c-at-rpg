/**
 * The tabletop layer — pure half (docs/design/run-map-and-dm.md §3).
 *
 * "At every encounter — a fight included — the player can type an action
 * instead of only pressing buttons." This module owns everything about that
 * loop that does NOT touch the network or pixi:
 *
 *   1. the two verdict contracts (in combat / out of combat);
 *   2. the CLIENT-SIDE half of the defence in depth — every number the DM
 *      sends back is re-linted here with the SHIPPED validators before the
 *      engine is allowed near it, and anything that fails degrades to pure
 *      narration with no mechanical effect;
 *   3. the run transcript: `{ prompt, verdict, effects }` per adjudication,
 *      carried on the run so it survives a reload and a run stays replayable.
 *
 * Nothing here reimplements a rule. In combat the price is
 * `lintImprovisation()` from `core/combat/powers.ts` — literally the function
 * `resolveAction`'s improvise case runs a second time. Out of combat the
 * structure is `validateEvents()` from `core/events/validate.ts` — literally
 * the validator the shipped content passes. The per-floor numbers are
 * `services/caps.ts` — literally the table the agent is briefed from. There
 * are no mirrors left to keep in step (there were two, and two parity tests
 * to police them; both went with `api/gm/*`).
 *
 * Layer note: this is the ui-side services package — no pixi, no network, no
 * `Math.random`, so it is unit-testable headless.
 */
import type {
  BattleState,
  Effect,
  GameEvent,
  RunState,
  Scalar,
} from "../core/types.js";
import type { EffectSpec } from "../core/combat/powerTypes.js";
import { lintImprovisation } from "../core/combat/powers.js";
import type { ImproviseAction } from "../core/combat/resolve.js";
import { validateEvents } from "../core/events/validate.js";
import { resolveScalar } from "../core/events/resolve.js";
import {
  EVENT_CAPS,
  MAX_FLOOR,
  MIN_FLOOR,
  floorDamageCap,
  floorHealCap,
  floorRamp,
  improvBudgetCap,
} from "./caps.js";

/* ------------------------------------------------------------------------ */
/* §1 Contracts                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The per-floor tables live in `./caps.ts` — the ONE home the agent reads
 * them from too. Re-exported here so the scenes and tests that have always
 * imported them from the tabletop layer still can.
 */
export {
  EVENT_CAPS,
  MAX_FLOOR,
  MIN_FLOOR,
  floorDamageCap,
  floorHealCap,
  floorRamp,
  improvBudgetCap,
};

/** Longest narration the UI will render (the agent schema caps it too). */
export const MAX_NARRATION = 400;

/** Longest line the player can type. */
export const MAX_PROMPT = 200;

/**
 * Energy ceiling for one improvised action: the shipped maximum skill cost
 * (classes.md §14). Improvisation costs a turn, so it must never undercut the
 * skills it competes with. Mirrors `MAX_ENERGY_COST` in the encounter
 * subagent's verdict schema.
 */
export const MAX_ENERGY_COST = 6;

/**
 * What the encounter subagent returns for an in-combat line — the shape
 * declared by `agent/subagents/encounter/lib/verdict.ts`, re-declared here
 * because the browser must never depend on agent code.
 */
export interface CombatVerdict {
  /** false = it does not happen. The DM saying no is a legitimate outcome. */
  allowed: boolean;
  /** 1-2 sentences in the DM voice; on a refusal, the in-character no. */
  narration: string;
  /** 0..3 `EffectSpec`s from the engine's closed union, in order. */
  effects: EffectSpec[];
  /** Energy the actor spends, 0..6, priced like a skill. */
  energyCost: number;
  /** Combatant id the `other` selector resolves to, or null. */
  target: string | null;
}

/**
 * What the DM returns for a line typed OUTSIDE combat. Deliberately the
 * events vocabulary (`Effect`, not `EffectSpec`): out of combat the bounded
 * consequences the design lists are "damage, heal, status, shinies, an item,
 * a remembered flag" — shinies and items only exist in the event union, and
 * `resolveOption` is the shipped path that applies them with every clamp
 * intact.
 */
export interface EncounterVerdict {
  allowed: boolean;
  narration: string;
  effects: Effect[];
}

/** One recorded adjudication (run-map-and-dm.md §3 "Determinism & replay"). */
export interface TabletopEntry {
  /** 1-based, monotonic within a run. */
  seq: number;
  /** Where it happened. */
  where: "combat" | "encounter";
  floor: number;
  /** The run-map node the party stood on, when there was one. */
  nodeId: number | null;
  /** Exactly what the player typed. */
  prompt: string;
  /** The DM's line, verbatim. */
  narration: string;
  /** false = the DM refused; rendered as the DM saying no, never an error. */
  allowed: boolean;
  /** The effects as authorised. Empty on a refusal or a pure flourish. */
  effects: EffectSpec[] | Effect[];
  /** Did the client lint let the effects through to the engine? */
  applied: boolean;
  /** Why not, when `applied` is false and `allowed` is true. */
  problems: string[];
  /** Combat only. */
  energyCost?: number;
  /** Combat only. */
  target?: string | null;
  /**
   * RNG draws this adjudication consumed. Always 0: an improvisation is a
   * conditionless power, and power effects never roll (powers.ts "RNG
   * roll-order addendum"). Recorded anyway because §3 names it as part of
   * the replay contract — a future effect that DOES roll must fill it in.
   */
  rngDraws: number;
}

/** The run's DM transcript, oldest first. */
export interface TabletopLog {
  entries: TabletopEntry[];
}

/**
 * The durable eve session handle for a run (DM-DEPLOY.md "HTTP surface":
 * one eve session == one run). Persisted with the run so a reload rejoins
 * the SAME session with the same memory.
 */
export interface DmSessionHandle {
  sessionId: string;
  /** The resume handle; rotates on every turn boundary. */
  continuationToken?: string;
  /** Events already consumed off the session stream. */
  streamIndex: number;
}

/**
 * `RunState` plus the two tabletop fields.
 *
 * They are NOT declared in `core/types.ts`: the save round-trips them for
 * free (`serializeRun` spreads the run and drops only `floorMap`,
 * `deserializeRun` spreads it back), so the transcript survives a reload
 * without a schema bump, and a v3 save written before this feature simply
 * loads with both fields `undefined`. Everything that reads them treats
 * absence as "no DM yet".
 */
export type TabletopRun = RunState & {
  dm?: DmSessionHandle;
  tabletop?: TabletopLog;
};

/* ------------------------------------------------------------------------ */
/* §2 Structural guards (hand-rolled, no deps)                               */
/* ------------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);

const clampFloor = (floor: number): number =>
  Math.min(MAX_FLOOR, Math.max(MIN_FLOOR, Math.floor(floor)));

/** Trim + hard-cap the narration; a blank one is not a verdict. */
function narrationOf(v: Record<string, unknown>): string | null {
  const raw = v.narration;
  if (typeof raw !== "string") return null;
  const text = raw.trim().slice(0, MAX_NARRATION);
  return text.length > 0 ? text : null;
}

/** The engine's closed `EffectSpec` union, checked member by member. */
function isEffectSpec(v: unknown): v is EffectSpec {
  if (!isRecord(v)) return false;
  if (v.target !== "self" && v.target !== "other") {
    if (v.target !== "allies" && v.target !== "enemies") return false;
  }
  switch (v.kind) {
    case "damage":
    case "heal":
      return isInt(v.pct);
    case "status":
      return (
        typeof v.status === "string" &&
        (v.value === undefined || isInt(v.value))
      );
    case "move":
      return isInt(v.delta);
    case "energy":
      return isInt(v.amount);
    case "cleanse":
      return typeof v.status === "string";
    default:
      return false;
  }
}

/**
 * The CLOSED set of `Effect.kind`s an out-of-combat verdict may contain —
 * the `core/types.ts` union, spelled out.
 *
 * `validateEvents` checks the *shape* of the effects it recognises but has no
 * opinion on a `kind` it has never heard of, so a payload like
 * `{ kind: "grantOmnipotence", … }` used to sail through the structural pass
 * and land in `resolveOption` as an unhandled branch. Defence in depth means
 * an unknown kind is REJECTED, not ignored: a verdict is only applied when
 * every effect in it is one the engine actually implements.
 */
export const ENCOUNTER_EFFECT_KINDS: readonly Effect["kind"][] = [
  "heal",
  "damage",
  "buff",
  "shinies",
  "giveItem",
  "takeItem",
  "restoreLife",
  "energyNextBattle",
  "fight",
  "nothing",
];

const KNOWN_EFFECT_KINDS: ReadonlySet<string> = new Set(ENCOUNTER_EFFECT_KINDS);

/** Is `v` an object whose `kind` is a member of the shipped Effect union? */
function isKnownEffectKind(v: unknown): v is Effect {
  return (
    isRecord(v) && typeof v.kind === "string" && KNOWN_EFFECT_KINDS.has(v.kind)
  );
}

/* ------------------------------------------------------------------------ */
/* §3 Verdict validation — defence in depth                                  */
/* ------------------------------------------------------------------------ */

export interface VerdictCheck<T> {
  /**
   * The verdict as it will be USED. Never null once the response was
   * structurally a verdict at all: a verdict that fails the lint comes back
   * with `effects: []` — degraded to pure narration, exactly as
   * run-map-and-dm.md §3 requires.
   */
  verdict: T | null;
  /** Did the effects survive the lint? */
  applied: boolean;
  /** Why not. Recorded in the transcript, never shown as an error. */
  problems: string[];
}

/**
 * Re-lint an in-combat verdict CLIENT-SIDE before the engine sees it.
 *
 *  - structure: the closed `EffectSpec` union, 0..3 entries, a narration,
 *    an integer energy cost within the shipped skill-cost range;
 *  - price: `lintImprovisation()` — `powerBudget()` + `validatePowerScript()`
 *    against the floor-ramped `BUDGET_CAPS.cat`;
 *  - reach: the per-floor damage/heal ceilings layered on top of the absolute
 *    `EFFECT_CAPS` the core lint already enforced.
 *
 * A refusal (`allowed: false`) is a VALID verdict with no effects — it is an
 * answer, not a failure.
 */
export function validateCombatVerdict(
  raw: unknown,
  floor: number,
): VerdictCheck<CombatVerdict> {
  if (!isRecord(raw)) return { verdict: null, applied: false, problems: [] };
  const narration = narrationOf(raw);
  if (narration === null || typeof raw.allowed !== "boolean") {
    return { verdict: null, applied: false, problems: [] };
  }
  const target =
    typeof raw.target === "string" && raw.target.length > 0 ? raw.target : null;
  // energy is clamped, not rejected: a cost outside the range is a sloppy
  // number, not a cheat — the effects are what has to be exactly legal.
  const energyCost = Math.min(
    MAX_ENERGY_COST,
    Math.max(0, isInt(raw.energyCost) ? raw.energyCost : 0),
  );
  const refused = raw.allowed === false;
  const narrated: CombatVerdict = {
    allowed: !refused,
    narration,
    effects: [],
    energyCost: refused ? 0 : energyCost,
    target: refused ? null : target,
  };
  if (refused) return { verdict: narrated, applied: false, problems: [] };

  const problems: string[] = [];
  const rawEffects = Array.isArray(raw.effects) ? raw.effects : [];
  if (rawEffects.length === 0) {
    // a purely cosmetic action: allowed, nothing to apply, nothing wrong
    return { verdict: { ...narrated, energyCost }, applied: false, problems };
  }
  if (rawEffects.length > 3) problems.push("more than 3 effects");
  if (!rawEffects.every(isEffectSpec))
    problems.push("effect outside the union");
  if (problems.length > 0)
    return { verdict: narrated, applied: false, problems };

  const effects = rawEffects as EffectSpec[];
  const f = clampFloor(floor);
  problems.push(...lintImprovisation(effects, improvBudgetCap(f)).problems);
  const dmgCap = floorDamageCap(f);
  const healCap = floorHealCap(f);
  for (const e of effects) {
    if (e.kind === "damage" && e.pct > dmgCap) {
      problems.push(`damage pct ${e.pct} above floor-${f} cap ${dmgCap}`);
    }
    if (e.kind === "heal" && e.pct > healCap) {
      problems.push(`heal pct ${e.pct} above floor-${f} cap ${healCap}`);
    }
  }
  if (problems.length > 0)
    return { verdict: narrated, applied: false, problems };
  return {
    verdict: { ...narrated, effects, energyCost },
    applied: true,
    problems: [],
  };
}

/** The engine action for an already-validated combat verdict. */
export function improviseActionFor(
  verdict: CombatVerdict,
  floor: number,
): ImproviseAction {
  const action: ImproviseAction = {
    type: "improvise",
    effects: verdict.effects,
    energyCost: verdict.energyCost,
    narration: verdict.narration,
    budgetCap: improvBudgetCap(clampFloor(floor)),
  };
  if (verdict.target !== null) action.targetId = verdict.target;
  return action;
}

/**
 * Can the actor pay for this improvisation right now? The engine throws on an
 * unaffordable action (driver bugs should explode), so the caller checks
 * first and degrades to pure narration instead of losing the turn to a throw.
 */
export function canAffordImprovisation(
  state: BattleState,
  actorId: string,
  verdict: CombatVerdict,
): boolean {
  const actor = state.combatants.find((c) => c.id === actorId);
  return actor !== undefined && actor.energy >= Math.max(0, verdict.energyCost);
}

/** Is `id` a live combatant of this battle? (A verdict may name a corpse.) */
export function isLiveTarget(state: BattleState, id: string | null): boolean {
  if (id === null) return false;
  const c = state.combatants.find((x) => x.id === id);
  return c !== undefined && !c.ko && c.hp > 0;
}

const numericScalar = (s: Scalar, floor: number): number =>
  Math.abs(resolveScalar(s, floor));

/**
 * Re-lint an out-of-combat verdict CLIENT-SIDE. Structure goes through the
 * SAME `validateEvents` the shipped content passes (by wrapping the verdict
 * in a synthetic two-option event), then the per-floor `EVENT_CAPS` table
 * from `./caps.ts` runs on top.
 */
export function validateEncounterVerdict(
  raw: unknown,
  floor: number,
): VerdictCheck<EncounterVerdict> {
  if (!isRecord(raw)) return { verdict: null, applied: false, problems: [] };
  const narration = narrationOf(raw);
  if (narration === null)
    return { verdict: null, applied: false, problems: [] };
  const refused = raw.allowed === false;
  const narrated: EncounterVerdict = {
    allowed: !refused,
    narration,
    effects: [],
  };
  if (refused) return { verdict: narrated, applied: false, problems: [] };

  const rawEffects = Array.isArray(raw.effects) ? raw.effects : [];
  if (rawEffects.length === 0) {
    return { verdict: narrated, applied: false, problems: [] };
  }
  const problems: string[] = [];
  if (rawEffects.length > 3) problems.push("more than 3 effects");
  if (!rawEffects.every(isRecord)) problems.push("effect is not an object");
  // an unknown `kind` is a rejection, not a shrug: `validateEvents` only
  // inspects the members it knows, so this is the gate that keeps a made-up
  // effect out of `resolveOption` entirely.
  else if (!rawEffects.every(isKnownEffectKind)) {
    problems.push("effect kind outside the engine's union");
  }
  if (problems.length > 0)
    return { verdict: narrated, applied: false, problems };

  const effects = rawEffects as Effect[];
  const f = clampFloor(floor);
  const synthetic: GameEvent = {
    id: "gmTabletopVerdict",
    title: "verdict",
    prompt: "verdict",
    weight: 1,
    floors: [f, f],
    options: [
      { label: "do it", outcomes: [{ weight: 1, text: narration, effects }] },
      {
        label: "walk away",
        outcomes: [{ weight: 1, text: "-", effects: [{ kind: "nothing" }] }],
      },
    ],
  };
  try {
    problems.push(...validateEvents([synthetic]));
  } catch {
    problems.push("verdict is not a structurally valid event outcome");
  }
  for (const e of effects) {
    switch (e.kind) {
      case "damage":
        if (numericScalar(e.amount, f) > EVENT_CAPS.damageMax(f)) {
          problems.push(`damage above floor-${f} cap`);
        }
        break;
      case "heal":
        if (numericScalar(e.amount, f) > EVENT_CAPS.healMax(f)) {
          problems.push(`heal above floor-${f} cap`);
        }
        break;
      case "shinies":
        if (numericScalar(e.amount, f) > EVENT_CAPS.shiniesMax(f)) {
          problems.push(`shinies above floor-${f} cap`);
        }
        break;
      case "buff":
        if (Math.abs(e.amount) > EVENT_CAPS.buffMax) {
          problems.push("buff above cap");
        }
        break;
      case "energyNextBattle":
        if (Math.abs(e.amount) > EVENT_CAPS.energyMax) {
          problems.push("energy above cap");
        }
        break;
      case "restoreLife":
        if (e.amount > EVENT_CAPS.restoreLifeMax) {
          problems.push("restoreLife above cap");
        }
        break;
      case "giveItem":
      case "takeItem":
        if ((e.count ?? 1) > EVENT_CAPS.itemCountMax) {
          problems.push("item count above cap");
        }
        break;
      case "fight":
        // The DM does not get to start fights from a typed line: that is the
        // run map's job, and an improvised ambush would bypass the node
        // budget entirely (run-map-and-dm.md §2 "density is authored").
        problems.push("fight is not an improvisable effect");
        break;
      case "nothing":
        break;
      default: {
        // compile-time exhaustiveness: adding an Effect kind to core/types.ts
        // without deciding its tabletop cap breaks the build here.
        const unreachable: never = e;
        problems.push(
          `effect kind outside the engine's union: ${String(
            (unreachable as { kind?: unknown }).kind,
          )}`,
        );
        break;
      }
    }
  }
  if (problems.length > 0)
    return { verdict: narrated, applied: false, problems };
  return { verdict: { ...narrated, effects }, applied: true, problems: [] };
}

/* ------------------------------------------------------------------------ */
/* §4 The transcript                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Entries kept per run. A run is a few dozen adjudications at most; the cap
 * is a guard against a pathological session bloating localStorage, and it
 * drops the OLDEST beats (the recent ones are the ones a callback needs).
 */
export const MAX_TRANSCRIPT_ENTRIES = 200;

export function emptyTabletopLog(): TabletopLog {
  return { entries: [] };
}

/** The run's transcript, or an empty one. Never returns undefined. */
export function tabletopLogOf(run: TabletopRun | null): TabletopLog {
  return run?.tabletop ?? emptyTabletopLog();
}

/** What the caller knows; `seq` and `rngDraws` are stamped here. */
export type TabletopDraft = Omit<TabletopEntry, "seq" | "rngDraws">;

/** Append an adjudication. Pure: returns a NEW log, oldest trimmed first. */
export function recordAdjudication(
  log: TabletopLog,
  draft: TabletopDraft,
): TabletopLog {
  const last = log.entries[log.entries.length - 1];
  const entry: TabletopEntry = {
    ...draft,
    seq: (last?.seq ?? 0) + 1,
    // an improvisation is conditionless, and power effects never roll
    rngDraws: 0,
  };
  const entries = [...log.entries, entry];
  return {
    entries:
      entries.length > MAX_TRANSCRIPT_ENTRIES
        ? entries.slice(entries.length - MAX_TRANSCRIPT_ENTRIES)
        : entries,
  };
}

/**
 * Append an adjudication to a run. Pure: returns a NEW run, so the caller
 * assigns it back to `ctx.run` and calls `ctx.save()` — the transcript then
 * rides the ordinary autosave and survives a reload.
 */
export function withAdjudication(
  run: TabletopRun,
  draft: TabletopDraft,
): TabletopRun {
  return { ...run, tabletop: recordAdjudication(tabletopLogOf(run), draft) };
}

/** Attach / refresh the durable DM session handle on a run. Pure. */
export function withDmSession(
  run: TabletopRun,
  dm: DmSessionHandle,
): TabletopRun {
  return { ...run, dm };
}
