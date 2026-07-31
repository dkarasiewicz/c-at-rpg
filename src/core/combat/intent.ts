/**
 * c(at)rpg combat — DECLARED INTENTS (docs/design/enemy-intel.md §2).
 *
 * Slay the Spire's one big idea, ported to the rank engine: every enemy
 * telegraphs what it will do NEXT, so a player who dies never feels cheated.
 * That is an engine change, not a UI veneer — the AI's choice moves from the
 * enemy's own slot to the round start, and the resolver is bound to it.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 * 1. TRUTHFUL. The declared skill is the skill the AI executes. It bends in
 *    exactly two documented ways, both of them the player's own doing, and
 *    both announced with an `intentBroken` event: the declared target died or
 *    left the skill's ranks (the same skill RETARGETS by the §10 preference,
 *    no roll), or the skill went offline (the AI RE-PICKS at that slot, which
 *    is exactly where the pre-intent engine picked).
 * 2. DETERMINISTIC. Selection draws from the same seeded stream, only
 *    earlier: one `chooseEnemyAction` per living enemy, in QUEUE ORDER,
 *    immediately after the initiative rolls and the round-1 power consults
 *    (combat.md §3.2 row 1b). The scorer only spends entropy on a genuine
 *    tie, so most rounds declare every intent for zero draws.
 * 3. AUTHORED UNCERTAINTY. A double-turn boss declares only its FIRST slot;
 *    the second is `'unknown'` and is chosen live when it comes up. The
 *    second slot's state cannot be known at round start, and inventing a
 *    number for it would be a lie.
 *
 * Visibility (rule §2 "learning is the reward") is NOT enforced here: the
 * engine always knows the truth. `core/meta/bestiary.ts` decides what the UI
 * may show, so an unmet enemy renders `???` without the engine ever lying to
 * itself.
 */
import type {
  BattleAction,
  BattleEvent,
  BattleState,
  Combatant,
  DeclaredIntent,
  Rng,
  Skill,
} from "../types.js";
import { SKILLS } from "../../content/skills.js";
import { chooseEnemyAction } from "./ai.js";
import { bossDataOf } from "./boss.js";
import { byId, isAlive, living, previewDamage, validTargets } from "./state.js";
import { roundHalfUp } from "../util.js";

/**
 * Publish one intent per living enemy, in queue order, replacing whatever the
 * previous round declared. Mutates `state` (called by `startRound` on the
 * already-cloned state) and returns the events to append.
 */
export function declareIntents(state: BattleState, rng: Rng): BattleEvent[] {
  const events: BattleEvent[] = [];
  const intents: Record<string, DeclaredIntent> = {};
  if (state.outcome !== "ongoing") {
    state.intents = intents;
    return events;
  }
  const seen = new Set<string>();
  for (const entry of state.queue) {
    if (seen.has(entry.combatantId)) continue; // 2nd slot of a double turn
    seen.add(entry.combatantId);
    const c = byId(state, entry.combatantId);
    if (c.side !== "enemy" || !isAlive(c)) continue;
    const action = chooseEnemyAction(c, state, rng);
    const intent = intentFromAction(state, c, action);
    intents[c.id] = intent;
    events.push({ t: "intent", id: c.id, intent });
  }
  state.intents = intents;
  return events;
}

/** The intent an enemy is currently committed to, or null. */
export function intentFor(
  state: BattleState,
  combatantId: string,
): DeclaredIntent | null {
  const i = state.intents?.[combatantId];
  return i && i.round === state.round ? i : null;
}

/** Drop a consumed declaration (the slot resolved, or was lost to Frazzled). */
export function consumeIntent(state: BattleState, combatantId: string): void {
  if (state.intents && combatantId in state.intents) {
    delete state.intents[combatantId];
  }
}

/**
 * Describe a chosen action as an intent. The `kind` ladder is deliberate:
 * FORCED MOVEMENT outranks damage, because Off-Paw is the signature mechanic
 * and a shove that also hurts must read as a shove (enemy-intel.md §2).
 */
export function intentFromAction(
  state: BattleState,
  self: Combatant,
  action: BattleAction,
): DeclaredIntent {
  const base = { id: self.id, value: 0, round: state.round };
  if (action.type !== "skill") return { ...base, kind: "advance" };
  const skill = SKILLS[action.skillId];
  if (!skill) return { ...base, kind: "advance" };

  const bdata = bossDataOf(self);
  const isWindup =
    !!bdata?.windup &&
    skill.id === bdata.windup.skillId &&
    self.charging?.skillId !== skill.id;
  const targets = intentTargets(state, self, skill, action.targetId);
  const value = intentValue(state, self, skill, targets);
  const ranks =
    skill.target.pattern === "row" ? [...skill.target.ranks] : undefined;
  const common = {
    ...base,
    skillId: skill.id,
    targetId: action.targetId,
    value,
    ...(ranks ? { ranks } : {}),
  };

  if (isWindup) return { ...common, kind: "windup", value: 0 };
  if (bdata?.summon && skill.id === bdata.summon.skillId) {
    return { ...common, kind: "summon", value: 0 };
  }
  if (skill.moveTarget) return { ...common, kind: "shove" };
  if (skill.kind === "damage" && skill.power > 0) {
    return { ...common, kind: "strike" };
  }
  if (skill.kind === "heal") return { ...common, kind: "heal" };
  const status = skill.applies?.[0]?.status;
  if (status) return { ...common, kind: "status", status };
  return { ...common, kind: "buff", value: 0 };
}

/** The combatants an intent's declared skill would land on right now. */
function intentTargets(
  state: BattleState,
  self: Combatant,
  skill: Skill,
  targetId: string | undefined,
): Combatant[] {
  if (skill.target.pattern === "row") return validTargets(state, self, skill);
  if (skill.target.side === "self") return [self];
  if (!targetId) return [];
  const t = state.combatants.find((c) => c.id === targetId);
  return t ? [t] : [];
}

/**
 * The number the telegraph shows: expected damage on the primary target
 * (variance 1.0, no crit — the same `previewDamage` the UI's own preview
 * uses, intel multipliers included) or the heal amount. 0 when meaningless.
 */
function intentValue(
  state: BattleState,
  self: Combatant,
  skill: Skill,
  targets: Combatant[],
): number {
  const primary = targets[0];
  if (!primary) return 0;
  if (skill.kind === "damage" && skill.power > 0) {
    return previewDamage(state, skill.id, self.id, primary.id);
  }
  if (skill.kind === "heal") {
    return Math.max(0, roundHalfUp((skill.power / 100) * self.stats.atk));
  }
  return 0;
}

/**
 * Every living enemy's current declaration, front rank first — what the
 * initiative ribbon and the over-head icons render. Enemies with no
 * declaration (a double-turn boss's second slot) are reported as `'unknown'`
 * rather than omitted, so the UI always has a row to draw.
 */
export function declaredIntents(state: BattleState): DeclaredIntent[] {
  return living(state, "enemy").map(
    (e) =>
      intentFor(state, e.id) ?? {
        id: e.id,
        kind: "unknown",
        value: 0,
        round: state.round,
      },
  );
}
