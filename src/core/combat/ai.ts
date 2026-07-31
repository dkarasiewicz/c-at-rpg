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
 * Cooldown note: resolveAction ticks the actor's cooldowns down at its turn
 * start, AFTER the driver has already asked the AI for an action — so the AI
 * checks readiness against the post-tick value (`cooldown <= 1`).
 */
import type {
  BattleAction,
  BattleState,
  Combatant,
  Rng,
  Skill,
} from "../types.js";
import { SKILLS } from "../../content/skills.js";
import {
  hasStatus,
  isAlive,
  previewDamage,
  statusesOf,
  validTargets,
} from "./state.js";
import { bossDataOf, canSummon } from "./boss.js";

export function takeEnemyTurn(
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
      if (!sk.usableFrom.includes(self.rank)) return false;
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
        !hasStatus(t, "offBalance")
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
