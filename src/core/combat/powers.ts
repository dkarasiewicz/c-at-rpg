/**
 * Stand Powers — Layer 1 interpreter + budget lint (docs/design/stand-powers.md).
 *
 * Pure functions consulted by the existing pipeline at fixed points. A
 * battle whose setup attaches no powers takes every early-return below and
 * behaves BYTE-IDENTICALLY to the pre-powers engine (zero extra RNG draws,
 * zero extra events).
 *
 * ## Insertion points (the complete list)
 *
 *  1. setup.ts createBattle       → initPowersState(): validate (budget lint,
 *     defense in depth) + attach `powers` to the returned state.
 *  2. resolve.ts resolveAction    → reclonePowers() right after cloneState.
 *     turns.ts startRound         → same.
 *  3. turns.ts startRound         → after initiative is rolled and the queue
 *     frozen: resetRoundCharges(); on round 1, consult onBattleStart in
 *     queue (slot) order, then one death sweep if anything fired.
 *  4. resolve.ts turn-start phase → after energy regen / cooldown tick (a
 *     frazzled actor loses the slot and consults nothing): actor onTurnStart.
 *  5. resolve.ts resolveSkill §3-step-1, per damaged target, after the
 *     damage event + existing hook rolls: attacker onDealHit → attacker
 *     onCrit (crit only) → victim onTakeHit.
 *  6. resolve.ts resolveSkill after step 4 (right after the String Theory
 *     trait): actor onForcedMove, once per skill use that force-moved ≥1
 *     clamped rank or chipped Poise ('other' = first such target).
 *  7. resolve.ts resolveSkill step 3, per landed application: recipient
 *     onStatusApplied ('other' = the applying actor).
 *  8. resolve.ts end of action, before the final death sweep: actor
 *     onTurnEnd.
 *  9. resolve.ts after every death sweep: consultAllyKOs() — each `ko`
 *     event consults the fallen one's LIVING allies in rank order; the
 *     caller re-sweeps and re-consults until quiet (bounded: each combatant
 *     KOs at most once per revive).
 *
 * ## RNG roll-order addendum (extends combat.md §3's contract)
 *
 * Powers draw from the SAME battle stream. Only the `chance` predicate ever
 * draws (exactly one float per consult that reaches it). Consults happen at
 * the points above, strictly AFTER every existing roll of the surrounding
 * step (variance → crit → hook/status chances → THEN power consults, in the
 * listed order). A power that is absent, out of charges, dead-owned, or
 * fails an earlier predicate draws NOTHING. Effects never draw (power
 * damage has no variance and cannot crit). Same seed + same attached
 * scripts ⇒ identical battle, event for event.
 *
 * ## No power chains
 *
 * Effects executed here never re-consult triggers: power damage raises no
 * onDealHit/onTakeHit/onCrit, power statuses no onStatusApplied, power
 * moves no onForcedMove. The single deliberate exception: a KO caused by a
 * power still consults onAllyKO (finite — no loops possible).
 */
import type {
  BattleEvent,
  BattleState,
  Combatant,
  Rng,
  StatusId,
} from "../types";
import type {
  EffectSpec,
  PowerChargeCounters,
  PoweredBattleSetup,
  PoweredBattleState,
  PowerPredicate,
  PowerScript,
  PowersState,
  PowerTargetSel,
  PowerTrigger,
} from "./powerTypes";
import { ENEMIES } from "../../content/enemies";
import { roundHalfUp } from "../util";
import {
  byId,
  hasStatus,
  hypotheticalDistance,
  isAlive,
  living,
  opposite,
  repositionWithin,
} from "./state";
import { applyStatus, cleanseOne } from "./status";
import { checkPhase, chipPoise, isBoss } from "./boss";

/* ------------------------------------------------------------------------ */
/* Budget lint — powerBudget() + caps (stand-powers.md §Balance)             */
/* ------------------------------------------------------------------------ */

export const POWER_FRAMEWORK_VERSION = 1;

/** Trigger frequency class: how often the trigger realistically fires. */
export const TRIGGER_FREQ: Record<PowerTrigger, number> = {
  onBattleStart: 1,
  onTurnStart: 3,
  onTurnEnd: 3,
  onDealHit: 3,
  onTakeHit: 3,
  onCrit: 1.5,
  onAllyKO: 1,
  onStatusApplied: 2,
  onForcedMove: 2,
  activated: 2,
};

/** Base price of inflicting each status (magnitude `value` adds on top). */
export const STATUS_COST: Record<StatusId, number> = {
  scratched: 5,
  frazzled: 8,
  offBalance: 5,
  guarded: 4,
  provoked: 3,
  mending: 4,
};

/** Multi-target effects cost double. */
const TARGET_MULT: Record<PowerTargetSel, number> = {
  self: 1,
  other: 1,
  allies: 2,
  enemies: 2,
};

/** Condition strictness discounts (chance scales linearly). */
const CONDITION_MULT: Record<
  Exclude<PowerPredicate["kind"], "chance">,
  number
> = {
  hpBelowPct: 0.7,
  targetHasStatus: 0.8,
  selfRank: 0.9,
  roundAtLeast: 0.9,
};

/** Hard numeric caps per effect (no single effect above these). */
export const EFFECT_CAPS = {
  /** ≈ ≤40% of a floor-appropriate HP pool at any atk in the game */
  damagePct: 150,
  healPct: 150,
  moveDelta: 3,
  energyAbs: 4,
  statusValue: 3,
} as const;

/** Budget caps: cat powers ≤ cat; enemy powers ≤ their tier's cap. */
export const BUDGET_CAPS = {
  cat: 12,
  enemyByTier: { 1: 6, 2: 9, 3: 12 } as Record<1 | 2 | 3, number>,
  resonance: 8,
} as const;

export function effectCost(e: EffectSpec): number {
  const mult = TARGET_MULT[e.target];
  switch (e.kind) {
    case "damage":
      return (e.pct / 10) * mult;
    case "heal":
      return (e.pct / 10) * mult;
    case "status":
      return (STATUS_COST[e.status] + (e.value ?? 0)) * mult;
    case "move":
      return 3 * Math.abs(e.delta) * mult;
    case "energy":
      return 2 * Math.abs(e.amount) * mult;
    case "cleanse":
      return 3 * mult;
  }
}

function chargeMult(charges: PowerScript["charges"]): number {
  let m = 1;
  const pb = charges?.perBattle;
  if (pb !== undefined) m *= pb <= 1 ? 0.4 : pb === 2 ? 0.6 : 0.8;
  const pr = charges?.perRound;
  if (pr !== undefined) m *= pr <= 1 ? 0.7 : pr === 2 ? 0.85 : 1;
  return m;
}

/**
 * Price a script: trigger frequency × Σ effect costs × Π condition
 * discounts × charge discount. Deterministic, hand-computable (unit-tested
 * against hand-computed fixtures).
 */
export function powerBudget(script: PowerScript): number {
  let cost = 0;
  for (const e of script.effects) cost += effectCost(e);
  let condMult = 1;
  for (const c of script.conditions) {
    condMult *=
      c.kind === "chance"
        ? Math.min(1, Math.max(0, c.pct / 100))
        : CONDITION_MULT[c.kind];
  }
  return (
    TRIGGER_FREQ[script.trigger] * cost * condMult * chargeMult(script.charges)
  );
}

/**
 * Full lint: structural sanity, per-effect numeric caps, framework version,
 * declared-vs-computed budget, and the budget cap. Runs server-side at
 * compile time AND client-side at battle setup (a failing script is dropped
 * — replaced by no-op).
 */
export function validatePowerScript(
  script: PowerScript,
  cap: number,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (script.version !== POWER_FRAMEWORK_VERSION) {
    problems.push(`version ${script.version} != ${POWER_FRAMEWORK_VERSION}`);
  }
  if (!script.id || !script.name) problems.push("missing id/name");
  if (script.effects.length < 1 || script.effects.length > 3) {
    problems.push("effects must have 1..3 entries");
  }
  if (script.conditions.length > 3) problems.push("too many conditions");
  for (const e of script.effects) {
    if (e.kind === "damage" && (e.pct <= 0 || e.pct > EFFECT_CAPS.damagePct)) {
      problems.push(
        `damage pct ${e.pct} outside (0, ${EFFECT_CAPS.damagePct}]`,
      );
    }
    if (e.kind === "heal" && (e.pct <= 0 || e.pct > EFFECT_CAPS.healPct)) {
      problems.push(`heal pct ${e.pct} outside (0, ${EFFECT_CAPS.healPct}]`);
    }
    if (
      e.kind === "move" &&
      (e.delta === 0 || Math.abs(e.delta) > EFFECT_CAPS.moveDelta)
    ) {
      problems.push(`move delta ${e.delta} outside ±${EFFECT_CAPS.moveDelta}`);
    }
    if (
      e.kind === "energy" &&
      (e.amount === 0 || Math.abs(e.amount) > EFFECT_CAPS.energyAbs)
    ) {
      problems.push(
        `energy amount ${e.amount} outside ±${EFFECT_CAPS.energyAbs}`,
      );
    }
    if (e.kind === "status" && (e.value ?? 0) > EFFECT_CAPS.statusValue) {
      problems.push(`status value ${e.value} > ${EFFECT_CAPS.statusValue}`);
    }
  }
  const budget = powerBudget(script);
  if (Math.abs(budget - script.budget) > 1e-9) {
    problems.push(`declared budget ${script.budget} != computed ${budget}`);
  }
  if (budget > cap) problems.push(`budget ${budget} exceeds cap ${cap}`);
  return { ok: problems.length === 0, problems };
}

/** Budget cap for the combatant a script would attach to. */
export function capForCombatantId(id: string): number {
  if (id.startsWith("cat:")) return BUDGET_CAPS.cat;
  const speciesId = id.slice(id.indexOf(":") + 1);
  const tier = ENEMIES[speciesId]?.tier ?? 3;
  return BUDGET_CAPS.enemyByTier[tier];
}

/* ------------------------------------------------------------------------ */
/* Powers state lifecycle                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Build the PowersState for createBattle. Unknown combatant ids are
 * ignored; scripts failing the lint are dropped (no-op) — defense in depth.
 * Returns null when nothing valid is attached (the state then carries NO
 * powers key at all → byte-identical legacy behavior).
 */
export function initPowersState(
  setup: PoweredBattleSetup,
  combatantIds: string[],
): PowersState | null {
  const attach = setup.powers;
  if (!attach) return null;
  const scripts: Record<string, PowerScript> = {};
  const charges: Record<string, PowerChargeCounters> = {};
  for (const id of combatantIds) {
    const script = attach[id];
    if (!script) continue;
    if (!validatePowerScript(script, capForCombatantId(id)).ok) continue;
    scripts[id] = script;
    charges[id] = { battle: 0, round: 0 };
  }
  return Object.keys(scripts).length > 0 ? { scripts, charges } : null;
}

const powersOf = (state: BattleState): PowersState | undefined =>
  (state as PoweredBattleState).powers;

/**
 * Deep-clone the mutable charge counters onto a freshly cloned state
 * (cloneState's shallow spread would otherwise share them with the source —
 * resolver purity). Scripts are frozen and shared by design.
 */
export function reclonePowers(clone: BattleState, source: BattleState): void {
  const p = powersOf(source);
  if (!p) return;
  (clone as PoweredBattleState).powers = {
    scripts: p.scripts,
    charges: Object.fromEntries(
      Object.entries(p.charges).map(([k, v]) => [k, { ...v }]),
    ),
  };
}

/** startRound: perRound charge counters reset with the new round. */
export function resetRoundCharges(state: BattleState): void {
  const p = powersOf(state);
  if (!p) return;
  for (const c of Object.values(p.charges)) c.round = 0;
}

/* ------------------------------------------------------------------------ */
/* The interpreter                                                           */
/* ------------------------------------------------------------------------ */

export interface TriggerCtx {
  ownerId: string;
  /** the trigger counterpart, when one exists (see PowerTargetSel) */
  otherId?: string;
}

function predicatesHold(
  state: BattleState,
  script: PowerScript,
  owner: Combatant,
  other: Combatant | undefined,
  rng: Rng,
): boolean {
  for (const c of script.conditions) {
    switch (c.kind) {
      case "hpBelowPct":
        if (!((owner.hp / owner.stats.hp) * 100 < c.pct)) return false;
        break;
      case "targetHasStatus":
        if (!hasStatus(other ?? owner, c.status)) return false;
        break;
      case "selfRank":
        if (!c.ranks.includes(owner.rank)) return false;
        break;
      case "roundAtLeast":
        if (!(state.round >= c.n)) return false;
        break;
      case "chance":
        // the ONLY power RNG draw — one float, on the battle stream
        if (!(rng.float() < c.pct / 100)) return false;
        break;
    }
  }
  return true;
}

function resolveEffectTargets(
  state: BattleState,
  sel: PowerTargetSel,
  owner: Combatant,
  other: Combatant | undefined,
): Combatant[] {
  switch (sel) {
    case "self":
      return [owner];
    case "other":
      return other ? [other] : [];
    case "allies":
      return living(state, owner.side);
    case "enemies":
      return living(state, opposite(owner.side));
  }
}

/**
 * Execute one effect. Emits only EXISTING BattleEvent kinds; draws no RNG;
 * never re-consults powers (no chains).
 */
function executeEffect(
  state: BattleState,
  e: EffectSpec,
  owner: Combatant,
  other: Combatant | undefined,
  sourceId: string,
  events: BattleEvent[],
): void {
  const targets = resolveEffectTargets(state, e.target, owner, other);
  for (const t of targets) {
    if (!isAlive(t)) continue;
    switch (e.kind) {
      case "damage": {
        // §3 pipeline at variance 1.0, no crit (deterministic)
        const offBal = hasStatus(t, "offBalance");
        const guard = hasStatus(t, "guarded");
        const dmg = roundHalfUp(
          (e.pct / 100) *
            owner.stats.atk *
            (offBal ? 1.5 : 1.0) *
            (guard ? 0.5 : 1.0),
        );
        const final = Math.max(1, dmg - t.stats.def);
        t.hp = Math.max(0, t.hp - final);
        events.push({
          t: "damage",
          id: t.id,
          amount: final,
          crit: false,
          offBal,
          source: sourceId,
        });
        if (isBoss(t)) checkPhase(t, events);
        break;
      }
      case "heal": {
        const amount = roundHalfUp((e.pct / 100) * owner.stats.atk);
        const healed = Math.min(amount, t.stats.hp - t.hp);
        if (healed > 0) {
          t.hp += healed;
          events.push({
            t: "heal",
            id: t.id,
            amount: healed,
            source: sourceId,
          });
        }
        break;
      }
      case "status": {
        if (applyStatus(t, e.status, e.value ?? 0)) {
          events.push({
            t: "statusApplied",
            id: t.id,
            status: e.status,
            value: e.value ?? 0,
          });
          if (e.status === "frazzled" && t.charging) {
            t.charging = null;
            events.push({ t: "chargeCancelled", id: t.id });
          }
        }
        break;
      }
      case "move": {
        if (t.traits.includes("heavy")) {
          // §11.1: the body never moves; a real attempt staggers a boss
          if (isBoss(t) && hypotheticalDistance(t, e.delta) >= 1) {
            chipPoise(t, 1, events);
          }
          break;
        }
        const res = repositionWithin(state, t, e.delta);
        for (const ch of res.changes) {
          events.push({
            t: "moved",
            id: ch.c.id,
            from: ch.from,
            to: ch.to,
            forced: ch.c.id === t.id,
          });
        }
        if (res.distance >= 1 && applyStatus(t, "offBalance")) {
          events.push({
            t: "statusApplied",
            id: t.id,
            status: "offBalance",
            value: 0,
          });
        }
        break;
      }
      case "energy": {
        if (t.side !== "cat") break;
        const before = t.energy;
        t.energy = Math.min(t.stats.enMax, Math.max(0, t.energy + e.amount));
        const delta = t.energy - before;
        if (delta !== 0) events.push({ t: "energy", id: t.id, delta });
        break;
      }
      case "cleanse": {
        if (cleanseOne(t, e.status)) {
          events.push({ t: "cleansed", id: t.id, status: e.status });
        }
        break;
      }
    }
  }
}

/**
 * Consult one combatant's power at a trigger point. No-ops (drawing zero
 * RNG) when: no powers attached, no script on the owner, wrong trigger,
 * owner not alive, or charges exhausted. Otherwise predicates run in order
 * (`chance` draws one float); on success the proc is charged, announced via
 * the existing `log` event as 「STAND NAME」, and effects execute in order.
 */
export function consultPower(
  state: BattleState,
  trigger: PowerTrigger,
  ctx: TriggerCtx,
  events: BattleEvent[],
  rng: Rng,
): boolean {
  const p = powersOf(state);
  if (!p) return false;
  const script = p.scripts[ctx.ownerId];
  if (!script || script.trigger !== trigger) return false;
  const owner = byId(state, ctx.ownerId);
  if (!isAlive(owner)) return false;
  const counters = p.charges[ctx.ownerId];
  if (script.charges?.perBattle !== undefined) {
    if (counters.battle >= script.charges.perBattle) return false;
  }
  if (script.charges?.perRound !== undefined) {
    if (counters.round >= script.charges.perRound) return false;
  }
  const other = ctx.otherId ? byId(state, ctx.otherId) : undefined;
  if (!predicatesHold(state, script, owner, other, rng)) return false;
  counters.battle += 1;
  counters.round += 1;
  events.push({
    t: "log",
    text: `「${script.name.toUpperCase()}」 ${script.flavor}`,
  });
  for (const e of script.effects) {
    executeEffect(state, e, owner, other, script.id, events);
  }
  return true;
}

/**
 * Round-1 onBattleStart consults, in slot (frozen queue) order, each
 * combatant at most once (a doubleTurn boss holds two slots).
 */
export function consultBattleStart(
  state: BattleState,
  events: BattleEvent[],
  rng: Rng,
): boolean {
  if (!powersOf(state)) return false;
  let fired = false;
  const seen = new Set<string>();
  for (const entry of state.queue) {
    if (seen.has(entry.combatantId)) continue;
    seen.add(entry.combatantId);
    if (
      consultPower(
        state,
        "onBattleStart",
        { ownerId: entry.combatantId },
        events,
        rng,
      )
    ) {
      fired = true;
    }
  }
  return fired;
}

/**
 * After a death sweep: every `ko` event in events[fromIdx..] consults the
 * fallen one's living allies (rank order) for onAllyKO ('other' = the
 * fallen). Skipped once the battle is decided. Returns true when any power
 * fired — the caller must then re-sweep (and re-consult on new KOs).
 */
export function consultAllyKOs(
  state: BattleState,
  events: BattleEvent[],
  fromIdx: number,
  rng: Rng,
): boolean {
  if (!powersOf(state)) return false;
  if (state.outcome !== "ongoing") return false;
  let fired = false;
  // snapshot: powers fired below may push more events; only sweep-found KOs count
  const kos = events
    .slice(fromIdx)
    .filter((e): e is Extract<BattleEvent, { t: "ko" }> => e.t === "ko");
  for (const ko of kos) {
    const fallen = byId(state, ko.id);
    for (const ally of living(state, fallen.side)) {
      if (
        consultPower(
          state,
          "onAllyKO",
          { ownerId: ally.id, otherId: fallen.id },
          events,
          rng,
        )
      ) {
        fired = true;
      }
    }
  }
  return fired;
}
