/**
 * c(at)rpg combat — enemy AI (combat.md §10, score-and-pick).
 *
 * A boss script hook runs first: a finished windup releases unconditionally.
 * Then every ready skill × candidate target is scored; the single best entry
 * wins. Ties resolve deterministically by lower target rank first (this is
 * what the §13 worked example shows — no roll drawn), and only a REMAINING
 * tie (different skills, same score, same target rank) draws one
 * `rng.int(0, n-1)` so fights stay lively but replays stay identical.
 *
 * ── WHEN the scoring happens (enemy-intel.md §2) ───────────────────────────
 * `startRound` now runs `chooseEnemyAction` ONCE per living enemy, in queue
 * order, and publishes the result as a declared intent (combat.md §3.2 row
 * 1b). `takeEnemyTurn` therefore usually draws NOTHING: it reads the
 * declaration and revalidates it (`boundAction`). The only mid-round
 * selection left is a double-turn boss's SECOND slot, whose intent is
 * deliberately `'unknown'`.
 *
 * Cooldown note: resolveAction ticks the actor's cooldowns down at its turn
 * start, AFTER the driver has already asked the AI for an action — so the AI
 * checks readiness against the post-tick value (`cooldown <= 1`). Round-start
 * declaration sees the same pre-tick numbers (nothing ticks an enemy's
 * cooldowns between the round start and its own slot), so the two agree.
 */
import type {
  BattleAction,
  BattleState,
  Combatant,
  DeclaredIntent,
  Rng,
  Skill,
} from "../types.js";
import { SKILLS } from "../../content/skills.js";
import {
  canUseFrom,
  hasStatus,
  isAlive,
  previewDamage,
  statusesOf,
  validTargets,
} from "./state.js";
import { bossDataOf, canSummon } from "./boss.js";

/**
 * The action an enemy takes on its slot. With a declared intent (the normal
 * case) this is a pure revalidation and draws NOTHING; without one — a
 * double-turn boss's second slot, or a state built before intents existed —
 * it falls back to scoring live, exactly as it always did.
 */
export function takeEnemyTurn(
  self: Combatant,
  state: BattleState,
  rng: Rng,
): BattleAction {
  const intent = state.intents?.[self.id];
  if (intent && intent.round === state.round && intent.kind !== "unknown") {
    const bound = bindIntent(state, self, intent);
    if (bound) return bound.action;
    // The declaration is unhonourable (the skill went offline) — the AI picks
    // again, right here, exactly where it always used to pick.
  }
  return chooseEnemyAction(self, state, rng);
}

/** A declaration honoured as-is, or honoured with a deterministic retarget. */
export interface BoundIntent {
  action: BattleAction;
  /** null = executed verbatim */
  reason: "retargeted" | null;
}

/**
 * Honour a declared intent (enemy-intel.md §2). Draws NOTHING, ever — the
 * choice was already paid for at round start.
 *
 * Returns null when the declaration cannot be honoured at all: the skill went
 * offline (shoved out of `usableFrom`, cooldown, summon cap) or every
 * candidate target is gone. That is the ONE case where the AI selects again,
 * and it does so in `takeEnemyTurn` — the same point in the seeded stream the
 * pre-intent engine picked at, so a broken telegraph never costs a double
 * draw. `resolveAction` therefore re-binds for free and simply reports
 * `intentBroken`.
 */
export function bindIntent(
  state: BattleState,
  self: Combatant,
  intent: DeclaredIntent,
): BoundIntent | null {
  // a finished windup releases unconditionally (combat.md §11.4)
  if (self.charging) {
    return {
      action: { type: "skill", skillId: self.charging.skillId },
      reason: null,
    };
  }
  if (!intent.skillId) {
    return intent.kind === "advance"
      ? { action: { type: "advance" }, reason: null }
      : null;
  }
  const skill = SKILLS[intent.skillId];
  if (!skill) return null;
  if ((self.cooldowns[skill.id] ?? 0) > 1) return null;
  if (!canUseFrom(state, self, skill)) return null;
  const bdata = bossDataOf(self);
  if (bdata?.summon && skill.id === bdata.summon.skillId) {
    return canSummon(state, self)
      ? { action: { type: "skill", skillId: skill.id }, reason: null }
      : null;
  }
  if (!intent.targetId) {
    return { action: { type: "skill", skillId: skill.id }, reason: null };
  }
  const cands = candidateTargets(self, skill, state);
  if (cands.some((c) => c.id === intent.targetId)) {
    return {
      action: { type: "skill", skillId: skill.id, targetId: intent.targetId },
      reason: null,
    };
  }
  if (cands.length === 0) return null;
  // The declared target left. The SAME skill follows the line, picking by the
  // §10 preference the scorer would have used — most wounded, ties to the
  // lower rank — so killing the telegraphed victim redirects the blow rather
  // than defusing it. Pure comparison: no draw, no re-scoring.
  const retarget = cands.reduce((a, b) => {
    const ha = a.hp / a.stats.hp;
    const hb = b.hp / b.stats.hp;
    if (hb !== ha) return hb < ha ? b : a;
    return b.rank < a.rank ? b : a;
  });
  return {
    action: { type: "skill", skillId: skill.id, targetId: retarget.id },
    reason: "retargeted",
  };
}

/**
 * The §10 scorer — THE only place the enemy AI spends entropy, and it only
 * spends it on a genuine tie. Called once per enemy per round by
 * `declareIntents` (and live for a double-turn boss's second slot).
 */
export function chooseEnemyAction(
  self: Combatant,
  state: BattleState,
  rng: Rng,
): BattleAction {
  // Boss script hook: a finished windup executes unconditionally.
  if (self.charging) {
    return { type: "skill", skillId: self.charging.skillId };
  }

  const bdata = bossDataOf(self);
  const usable = self.skills
    .map((id) => SKILLS[id])
    .filter((sk): sk is Skill => {
      if (!sk) return false;
      if ((self.cooldowns[sk.id] ?? 0) > 1) return false; // post-tick readiness
      if (!canUseFrom(state, self, sk)) return false;
      if (bdata?.summon && sk.id === bdata.summon.skillId) {
        return canSummon(state, self);
      }
      return candidateTargets(self, sk, state).length > 0;
    });

  if (usable.length === 0) return { type: "advance" };

  const scored: { skill: Skill; target: Combatant; score: number }[] = [];
  for (const sk of usable) {
    for (const t of candidateTargets(self, sk, state)) {
      let score = sk.aiWeight ?? 10;
      if (sk.kind === "damage") {
        score += 30 * (1 - t.hp / t.stats.hp); // prefer wounded
        if (expectedDamage(state, self, sk, t) >= t.hp) score += 50; // kill shot
        if (hasStatus(t, "offBalance")) score += 15; // exploits combos too!
      }
      if (sk.kind === "heal") {
        score += t.hp / t.stats.hp < 0.5 ? 40 : -100;
      }
      if (sk.applies?.some((a) => hasStatus(t, a.status))) score -= 100; // don't reapply
      if (
        sk.moveTarget &&
        !t.traits.includes("heavy") &&
        !hasStatus(t, "offBalance") &&
        !hasStatus(t, "braced") // a braced cat cannot be destabilised again
      ) {
        score += 15; // enemies combo you back
      }
      scored.push({ skill: sk, target: t, score });
    }
  }
  if (scored.length === 0) return { type: "advance" };

  scored.sort((a, b) => b.score - a.score);
  let top = scored.filter((e) => e.score === scored[0].score);
  // deterministic tie-break: lower target rank first (combat.md §10 prose,
  // demonstrated in §13 — the Crow picks Bruno without a draw)
  const minRank = Math.min(...top.map((e) => e.target.rank));
  top = top.filter((e) => e.target.rank === minRank);
  const pick = top.length === 1 ? top[0] : top[rng.int(0, top.length - 1)];
  return { type: "skill", skillId: pick.skill.id, targetId: pick.target.id };
}

/**
 * Candidate targets, honoring Provoked: a single-target damage skill must
 * target the provoker if it stands in a valid rank; otherwise unrestricted.
 */
export function candidateTargets(
  self: Combatant,
  skill: Skill,
  state: BattleState,
): Combatant[] {
  const valid = validTargets(state, self, skill);
  if (skill.kind === "damage" && skill.target.pattern === "single") {
    const prov = statusesOf(self, "provoked")[0];
    if (prov) {
      const provoker = state.combatants[prov.value];
      if (
        provoker &&
        isAlive(provoker) &&
        valid.some((v) => v.id === provoker.id)
      ) {
        return [provoker];
      }
    }
  }
  return valid;
}

/** Expected damage for scoring: variance 1.0, no crit (= previewDamage). */
export function expectedDamage(
  state: BattleState,
  self: Combatant,
  skill: Skill,
  target: Combatant,
): number {
  if (skill.kind !== "damage" || skill.power <= 0) return 0;
  return previewDamage(state, skill.id, self.id, target.id);
}
