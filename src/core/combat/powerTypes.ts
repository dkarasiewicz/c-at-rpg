/**
 * Stand Powers — Layer 1 type contracts (docs/design/stand-powers.md).
 *
 * A Stand superpower is DATA: a small deterministic rule card compiled (by
 * hand for stock powers, by the GM service for player-authored ones) into
 * this DSL and executed by the pure interpreter in `powers.ts`. Powers can
 * only recombine mechanics the engine already has — every `EffectSpec` kind
 * below maps 1:1 onto an existing pipeline mechanic from core/types.ts's
 * frozen Skill/Status contracts (damage math §3, applyStatus §6 stacking,
 * forced movement §8 incl. heavy/Poise, energy gain, cleanseOne). No new
 * mechanics, no new BattleEvent kinds (announcements ride the existing
 * `{ t: 'log' }` event; effects emit the existing damage/heal/statusApplied/
 * moved/energy/cleansed events).
 *
 * This file is types-only (plus nothing at runtime) and — like core/types.ts
 * — imports only from core/types.ts. `BattleState`/`BattleSetup` stay frozen:
 * powers ride as OPTIONAL parallel fields on the Powered* subtypes below, so
 * a setup without powers is byte-identical to today's engine behavior.
 */
import type { BattleSetup, BattleState, StatusId } from "../types";

/* ------------------------------------------------------------------------ */
/* Triggers, predicates, effects                                             */
/* ------------------------------------------------------------------------ */

/**
 * When the engine consults a power (exact insertion points documented in
 * powers.ts and the stand-powers.md addendum). `activated` is typed for
 * forward-compat with the spec's extra-skill-slot form but is NOT yet wired
 * to a consult point (scope ladder — Layer 1 ships passive triggers only).
 */
export type PowerTrigger =
  | "onBattleStart"
  | "onTurnStart"
  | "onTurnEnd"
  | "onDealHit"
  | "onTakeHit"
  | "onCrit"
  | "onAllyKO"
  | "onStatusApplied"
  | "onForcedMove"
  | "activated";

/**
 * Tiny closed predicate set, engine-evaluable. All listed conditions must
 * hold, evaluated in array order; evaluation stops at the first failure.
 * ONLY `chance` draws RNG (one float on the battle stream, drawn AFTER all
 * existing rolls of the surrounding step — see the roll-order addendum).
 */
export type PowerPredicate =
  | { kind: "hpBelowPct"; pct: number } // owner's hp/maxHp*100 < pct
  | { kind: "targetHasStatus"; status: StatusId } // the trigger counterpart ('other'); the owner when no counterpart exists
  | { kind: "selfRank"; ranks: number[] } // owner's current rank ∈ ranks
  | { kind: "roundAtLeast"; n: number } // state.round >= n
  | { kind: "chance"; pct: number }; // rng.float() < pct/100

/**
 * Who an effect lands on, resolved from the trigger context:
 *  - self:    the power's owner
 *  - other:   the trigger counterpart (attacker for onTakeHit, victim for
 *             onDealHit/onCrit, first force-moved target for onForcedMove,
 *             status source for onStatusApplied; absent → effect skipped)
 *  - allies:  every living combatant on the owner's side (incl. the owner)
 *  - enemies: every living combatant on the opposing side
 * No selector ever draws RNG — target resolution is fully deterministic.
 */
export type PowerTargetSel = "self" | "other" | "allies" | "enemies";

/**
 * Bounded effect union — each kind reuses an EXISTING engine mechanic:
 *  - damage:  §3 damage pipeline at variance 1.0, NO crit roll (draws no
 *             RNG): max(1, round(pct/100·owner.atk·offBal·guard) − def).
 *             Chips no Poise; boss phase check runs as for any damage.
 *  - heal:    round(pct/100·owner.atk), capped at max HP (§3 healing).
 *  - status:  applyStatus §6 stacking rules verbatim; always lands (chance
 *             gating belongs in `conditions` — a power effect draws no roll,
 *             mirroring the "chance exactly 1.0 draws NOTHING" ruling).
 *  - move:    forced movement §8: clamped shove/pull, Off-Balance on ≥1 rank
 *             moved, heavy targets don't move (boss: Poise chip 1 on a ≥1
 *             bound-space attempt, §11.1).
 *  - energy:  cat energy gain/drain, clamped to [0, enMax] (enemies: no-op).
 *  - cleanse: remove ONE application of the status (existing cleanse rule).
 */
export type EffectSpec =
  | { kind: "damage"; target: PowerTargetSel; pct: number }
  | { kind: "heal"; target: PowerTargetSel; pct: number }
  | { kind: "status"; target: PowerTargetSel; status: StatusId; value?: number }
  | { kind: "move"; target: PowerTargetSel; delta: number }
  | { kind: "energy"; target: PowerTargetSel; amount: number }
  | { kind: "cleanse"; target: PowerTargetSel; status: StatusId };

/* ------------------------------------------------------------------------ */
/* The rule cards                                                            */
/* ------------------------------------------------------------------------ */

export interface PowerScript {
  /** 'power:dumpsterKing' */
  id: string;
  /** framework version it was compiled against (POWER_FRAMEWORK_VERSION) */
  version: number;
  /** the Stand's name, announced as 「NAME」 in the battle log */
  name: string;
  /** the announced flavor line */
  flavor: string;
  /** computed power-budget score; must equal powerBudget(script) (lint) */
  budget: number;
  trigger: PowerTrigger;
  /** all must hold, evaluated in order (see PowerPredicate) */
  conditions: PowerPredicate[];
  /** executed in order; 1..3 entries (budget lint enforces) */
  effects: EffectSpec[];
  /** absent = unlimited */
  charges?: { perBattle?: number; perRound?: number };
}

/**
 * Layer 3 memoized Stand-vs-Stand resonance — same DSL, plus the discovery
 * banner text. Typed here for the contract; attaching interaction rules to a
 * battle is NOT part of Layer 1 (the interpreter only consults per-combatant
 * scripts today).
 */
export interface InteractionRule {
  /** sortedPair(A.id, B.id) + frameworkVersion */
  pairKey: string;
  version: number;
  trigger: PowerTrigger;
  conditions: PowerPredicate[];
  effects: EffectSpec[];
  flavor: string;
  /** "STAND RESONANCE DISCOVERED: …" banner line */
  announce: string;
  budget: number;
}

/* ------------------------------------------------------------------------ */
/* Battle-state / setup threading (parallel optional fields)                 */
/* ------------------------------------------------------------------------ */

export interface PowerChargeCounters {
  /** procs so far this battle */
  battle: number;
  /** procs so far this round (reset by startRound) */
  round: number;
}

/**
 * The powers side-state carried on BattleState. `scripts` is frozen at
 * createBattle (never mutated — shared across clones); `charges` is
 * per-state mutable and deep-cloned by reclonePowers() alongside cloneState.
 */
export interface PowersState {
  /** attached scripts, keyed by combatant id ('cat:bruiser', 'e0:vacuumKing') */
  scripts: Record<string, PowerScript>;
  /** charge counters, keyed by combatant id (only ids present in scripts) */
  charges: Record<string, PowerChargeCounters>;
  /**
   * Layer 3 resonances, keyed by owner combatant id: each rule executes as
   * an EXTRA chargeless power of its owner, consulted after the owner's own
   * script. Frozen at createBattle and shared across clones (no mutable
   * state — resonance rules carry no charges).
   */
  resonances?: Record<string, PowerScript[]>;
}

/**
 * BattleState with the optional powers field. A battle created from a setup
 * without powers has NO `powers` key at all and behaves byte-identically to
 * the pre-powers engine (every consult hook no-ops and draws zero RNG).
 */
export interface PoweredBattleState extends BattleState {
  powers?: PowersState;
}

/** A compiled Stand resonance attached to one battle (stand-powers.md L3). */
export interface AttachedInteraction {
  /** the combatant the rule behaves as an extra power of (`self` = owner) */
  ownerId: string;
  rule: InteractionRule;
}

/**
 * BattleSetup with optional power attachments, keyed by the combatant id
 * createBattle will mint ('cat:<classId>' / 'e<index>:<enemyId>'). Scripts
 * failing the client-side budget lint are dropped (replaced by no-op) —
 * defense in depth per stand-powers.md §Balance.
 *
 * `interactions` carries already-compiled resonance rules (memoized by
 * /api/gm/resonance); each valid rule executes as an extra chargeless power
 * on its owner, linted at the resonance budget cap (invalid rules dropped).
 */
export interface PoweredBattleSetup extends BattleSetup {
  powers?: Record<string, PowerScript>;
  interactions?: AttachedInteraction[];
}
