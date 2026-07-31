/**
 * c(at)rpg combat — state queries and rank operations (WP-03).
 *
 * Rank model (combat.md §1): cats occupy ranks 1-4, enemies 1-5, one per rank,
 * no gaps — living combatants on a side always hold contiguous ranks 1..n.
 * KO'd/dead combatants stay in `state.combatants` (their `rank` goes stale and
 * is ignored). All functions here are pure queries or explicit mutators used
 * by the resolver on an already-cloned state.
 */
import type {
  BattleState,
  Combatant,
  Skill,
  SkillId,
  StatusInstance,
  StatusId,
} from "../types.js";
import { SKILLS } from "../../content/skills.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { roundHalfUp, clamp } from "../util.js";

/* ------------------------------------------------------------------ */
/* basic queries                                                       */
/* ------------------------------------------------------------------ */

export const isAlive = (c: Combatant): boolean => !c.ko && c.hp > 0;

export function byId(state: BattleState, id: string): Combatant {
  const c = state.combatants.find((x) => x.id === id);
  if (!c) throw new Error(`combat: unknown combatant '${id}'`);
  return c;
}

/** Living combatants of one side, sorted front (rank 1) to back. */
export function living(state: BattleState, side: "cat" | "enemy"): Combatant[] {
  return state.combatants
    .filter((c) => c.side === side && isAlive(c))
    .sort((a, b) => a.rank - b.rank);
}

export const opposite = (side: "cat" | "enemy"): "cat" | "enemy" =>
  side === "cat" ? "enemy" : "cat";

/** Highest rank a side's formation can ever reach (bound-space, not occupancy). */
export const maxRankOf = (side: "cat" | "enemy"): number =>
  side === "cat" ? 4 : 5;

export function statusesOf(c: Combatant, id: StatusId): StatusInstance[] {
  return c.statuses.filter((s) => s.id === id);
}

export const hasStatus = (c: Combatant, id: StatusId): boolean =>
  c.statuses.some((s) => s.id === id);

/**
 * Trait tier convention: the §2 contract has no level/tier field, so tier 2
 * (classes.md L7 upgrade) is expressed by listing the TraitId twice in
 * `traits`. One occurrence = tier 1.
 */
export function traitTier(c: Combatant, id: string): number {
  return c.traits.filter((t) => t === id).length;
}

/* ------------------------------------------------------------------ */
/* skill lookup (content skills + consumable battle payloads)          */
/* ------------------------------------------------------------------ */

export function lookupSkill(id: SkillId): Skill {
  const s = SKILLS[id];
  if (s) return s;
  for (const key of Object.keys(CONSUMABLES)) {
    const def = CONSUMABLES[key];
    if (def.battleSkill.id === id) return def.battleSkill;
  }
  throw new Error(`combat: unknown skill '${id}'`);
}

/* ------------------------------------------------------------------ */
/* deep clone (resolver purity: state in → new state out)              */
/* ------------------------------------------------------------------ */

export function cloneState(state: BattleState): BattleState {
  return {
    ...state,
    combatants: state.combatants.map((c) => ({
      ...c,
      stats: { ...c.stats },
      skills: [...c.skills],
      cooldowns: { ...c.cooldowns },
      statuses: c.statuses.map((s) => ({ ...s })),
      traits: [...c.traits],
      hooks: [...c.hooks],
      usedOncePerBattle: [...c.usedOncePerBattle],
      charging: c.charging
        ? { skillId: c.charging.skillId, ranks: [...c.charging.ranks] }
        : (c.charging ?? null),
    })),
    queue: state.queue.map((e) => ({ ...e })),
  };
}

/* ------------------------------------------------------------------ */
/* queue scan                                                          */
/* ------------------------------------------------------------------ */

/** Index of the next unacted queue entry whose combatant is alive; -1 if none. */
export function nextEntryIndex(state: BattleState): number {
  for (let i = 0; i < state.queue.length; i++) {
    const e = state.queue[i];
    if (e.acted) continue;
    if (isAlive(byId(state, e.combatantId))) return i;
  }
  return -1;
}

/** Next combatant to act this round, or null when the round is exhausted. */
export function nextActor(state: BattleState): Combatant | null {
  const i = nextEntryIndex(state);
  return i < 0 ? null : byId(state, state.queue[i].combatantId);
}

/* ------------------------------------------------------------------ */
/* targeting                                                           */
/* ------------------------------------------------------------------ */

/**
 * Valid targets for `user` using `skill` (combat.md §4): living occupants of
 * the resolved side within `target.ranks` — except revive skills
 * (`revivePct`), which target KO'd allies instead (rank irrelevant).
 */
export function validTargets(
  state: BattleState,
  user: Combatant,
  skill: Skill,
): Combatant[] {
  if (skill.revivePct !== undefined) {
    return state.combatants.filter((c) => c.side === user.side && c.ko);
  }
  if (skill.target.side === "self") return isAlive(user) ? [user] : [];
  const side = skill.target.side === "ally" ? user.side : opposite(user.side);
  return living(state, side).filter((c) => skill.target.ranks.includes(c.rank));
}

/* ------------------------------------------------------------------ */
/* movement (rank ops)                                                 */
/* ------------------------------------------------------------------ */

export interface MoveChange {
  c: Combatant;
  from: number;
  to: number;
}

export interface MoveResult {
  distance: number;
  changes: MoveChange[];
}

/**
 * The clamped distance a move of `delta` ranks would cover for `target`
 * within its side's OCCUPIED ranks (combat.md §8 clamping), without mutating.
 */
export function wouldMoveDistance(
  state: BattleState,
  target: Combatant,
  delta: number,
): number {
  const order = living(state, target.side);
  const idx = order.findIndex((c) => c.id === target.id);
  if (idx < 0) return 0;
  const newIdx = clamp(idx + delta, 0, order.length - 1);
  return Math.abs(newIdx - idx);
}

/**
 * The clamped distance in BOUND space (rank 1..sideMax, ignoring occupancy).
 * Used only for the boss Poise-chip test (combat.md §11.1): a push on a lone
 * heavy boss still counts as a staggering attempt even though occupancy
 * would clamp it to 0, while a pull on a rank-1 target never does.
 */
export function hypotheticalDistance(target: Combatant, delta: number): number {
  return Math.abs(
    clamp(target.rank + delta, 1, maxRankOf(target.side)) - target.rank,
  );
}

/**
 * Move `target` by `delta` ranks (+ = backward / higher rank), others shift
 * to fill (combat.md §8). Returns the clamped distance and every rank change
 * (target + bystanders). Caller emits `moved` events.
 */
export function repositionWithin(
  state: BattleState,
  target: Combatant,
  delta: number,
): MoveResult {
  const order = living(state, target.side);
  const idx = order.findIndex((c) => c.id === target.id);
  if (idx < 0) return { distance: 0, changes: [] };
  const newIdx = clamp(idx + delta, 0, order.length - 1);
  if (newIdx === idx) return { distance: 0, changes: [] };
  order.splice(idx, 1);
  order.splice(newIdx, 0, target);
  const changes: MoveChange[] = [];
  order.forEach((c, i) => {
    const to = i + 1;
    if (c.rank !== to) {
      changes.push({ c, from: c.rank, to });
      c.rank = to;
    }
  });
  return { distance: Math.abs(newIdx - idx), changes };
}

/**
 * Re-pack a side's living ranks to 1..n after a death/KO (corpse slide —
 * "the only free movement", combat.md §1). Returns the rank changes.
 */
export function compressRanks(
  state: BattleState,
  side: "cat" | "enemy",
): MoveChange[] {
  const changes: MoveChange[] = [];
  living(state, side).forEach((c, i) => {
    const to = i + 1;
    if (c.rank !== to) {
      changes.push({ c, from: c.rank, to });
      c.rank = to;
    }
  });
  return changes;
}

/** Swap two living same-side combatants' ranks (voluntary Move action). */
export function swapRanks(a: Combatant, b: Combatant): void {
  const r = a.rank;
  a.rank = b.rank;
  b.rank = r;
}

/* ------------------------------------------------------------------ */
/* previews                                                            */
/* ------------------------------------------------------------------ */

/**
 * UI damage preview: the §3 pipeline at variance 1.0 with no crit, against
 * the target's CURRENT statuses. Also the AI's `expectedDamage`.
 */
export function previewDamage(
  state: BattleState,
  skillId: SkillId,
  userId: string,
  targetId: string,
): number {
  const user = byId(state, userId);
  const target = byId(state, targetId);
  const skill = lookupSkill(skillId);
  const base = (skill.power / 100) * user.stats.atk;
  const offBal = hasStatus(target, "offBalance") ? 1.5 : 1.0;
  const guard = hasStatus(target, "guarded") ? 0.5 : 1.0;
  const dmg = roundHalfUp(base * 1.0 * offBal * guard);
  return Math.max(1, dmg - target.stats.def);
}

/* ------------------------------------------------------------------ */
/* legal actions (UI enabling descriptors)                             */
/* ------------------------------------------------------------------ */

export interface SkillOption {
  skillId: SkillId;
  ok: boolean;
  reason?: string;
  targetIds: string[];
}

export interface LegalActions {
  actorId: string | null;
  catPile: boolean;
  skills: SkillOption[];
  canMoveForward: boolean;
  canMoveBack: boolean;
  canGuard: boolean;
  canFlee: boolean;
}

export function legalActions(state: BattleState): LegalActions {
  const out: LegalActions = {
    actorId: null,
    catPile: state.catPilePrompt,
    skills: [],
    canMoveForward: false,
    canMoveBack: false,
    canGuard: false,
    canFlee: false,
  };
  if (state.catPilePrompt || state.outcome !== "ongoing") return out;
  const actor = nextActor(state);
  if (!actor) return out;
  out.actorId = actor.id;
  if (actor.side !== "cat") return out;
  // Affordability is judged against post-regen energy: the +2 turn-start
  // regen lands inside resolveAction, before the cost is validated.
  const effEnergy = hasStatus(actor, "frazzled")
    ? actor.energy
    : Math.min(actor.stats.enMax, actor.energy + 2);
  for (const id of actor.skills) {
    const sk = SKILLS[id];
    if (!sk) continue;
    const targets = validTargets(state, actor, sk);
    let ok = true;
    let reason: string | undefined;
    if (sk.oncePerBattle && actor.usedOncePerBattle.includes(id)) {
      ok = false;
      reason = "already used this battle";
    } else if (effEnergy < sk.cost) {
      ok = false;
      reason = "not enough energy";
    } else if (!sk.usableFrom.includes(actor.rank)) {
      ok = false;
      reason = "wrong rank";
    } else if (targets.length === 0) {
      ok = false;
      reason = "no valid target";
    }
    out.skills.push({
      skillId: id,
      ok,
      reason,
      targetIds: targets.map((t) => t.id),
    });
  }
  const cats = living(state, "cat");
  out.canMoveForward = cats.some((c) => c.rank === actor.rank - 1);
  out.canMoveBack = cats.some((c) => c.rank === actor.rank + 1);
  out.canGuard = true;
  out.canFlee = state.canFlee;
  return out;
}

/**
 * Item-action legality helper for the UI (engine does not own the inventory).
 */
export function itemLegality(
  state: BattleState,
  itemId: string,
): { ok: boolean; reason?: string; targetIds: string[] } {
  const def = CONSUMABLES[itemId];
  if (!def) return { ok: false, reason: "unknown item", targetIds: [] };
  const actor = nextActor(state);
  if (!actor || actor.side !== "cat")
    return { ok: false, reason: "no cat acting", targetIds: [] };
  if (def.oncePerBattle && state.cucumberUsed)
    return { ok: false, reason: "already used this battle", targetIds: [] };
  if (def.nonBoss && !state.canFlee)
    return { ok: false, reason: "not in a boss battle", targetIds: [] };
  const targets = validTargets(state, actor, def.battleSkill);
  if (def.battleSkill.target.side !== "self" && targets.length === 0)
    return { ok: false, reason: "no valid target", targetIds: [] };
  return { ok: true, targetIds: targets.map((t) => t.id) };
}
