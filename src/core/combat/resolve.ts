/**
 * c(at)rpg combat — the action resolver (WP-03, combat.md §§3-4, 8-9).
 *
 * `resolveAction(state, action, rng)` is the pure reducer at the heart of the
 * engine. One call resolves one queue slot (or one Cat Pile answer):
 *
 *   turn-start phase: Guarded expiry → DoT/Mending ticks → Frazzled skip →
 *                     energy regen (cats) / cooldown tick (enemies)
 *   action:           skill | move | guard | item | flee | advance | improvise
 *   skill pipeline:   1 damage/heal → 2 forced movement (Off-Balance /
 *                     Poise chip) → 3 applies + cleanses → 4 self movement →
 *                     5 Cat Pile check → 6 death/victory check
 *
 * RNG draw order per combat.md §3: per damaging action per target in rank
 * order — variance, then crit; then, in step 2 per force-moved target in rank
 * order, the Off-Paw application chance followed by the tier-resistance roll;
 * then per-effect status chances (a chance of exactly 1.0 draws NOTHING),
 * each Off-Balance application chasing its own tier-resistance roll; flee
 * draws one float. The AI draws only on genuine ties (ai.ts).
 *
 * The two Off-Paw gates are drawn ONLY when the application could actually
 * land (target alive, not already Off-Balance, not Braced) — a wasted shove
 * costs no entropy, which is what keeps replays identical.
 *
 * Trait hooks (classes.md) and all 8 Mewthical hooks (loot.md §4) fire at
 * their documented injection points; every hook is a single conditional in an
 * existing step.
 */
import type {
  BattleAction,
  BattleEvent,
  BattleState,
  Combatant,
  Rng,
  Skill,
  StatusId,
} from "../types.js";
import { SKILLS } from "../../content/skills.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { roundHalfUp } from "../util.js";
import {
  byId,
  canUseFrom,
  cloneState,
  hasStatus,
  hypotheticalDistance,
  isAlive,
  living,
  nextEntryIndex,
  OFF_BALANCE_MULT,
  offBalanceResistOf,
  opposite,
  repositionWithin,
  swapRanks,
  traitTier,
  validTargets,
} from "./state.js";
import {
  applyStatus,
  braceAfterOffBalance,
  BRACE_ON_CONSUME,
  removeStatus,
  turnStartStatusPhase,
} from "./status.js";
import {
  bossDataOf,
  canSummon,
  checkPhase,
  chipPoise,
  doSummon,
  isBoss,
} from "./boss.js";
import { fleeChance, processDeathsAndOutcome } from "./turns.js";
import type { EffectSpec } from "./powerTypes.js";
import {
  consultAllyKOs,
  consultImprovisation,
  consultPower,
  lintImprovisation,
  reclonePowers,
} from "./powers.js";

export interface ResolveResult {
  state: BattleState;
  events: BattleEvent[];
}

/**
 * The tabletop layer's in-combat action (docs/design/run-map-and-dm.md §3
 * "In combat"): an ALREADY-AUTHORISED improvisation, resolved as an ordinary
 * turn — turn-start phase, energy cost, effects, Cat Pile check, death sweep.
 *
 * It deliberately does NOT join `BattleAction` in core/types.ts: that union
 * predates `EffectSpec`, and importing `EffectSpec` there would put a cycle
 * between types.ts and powerTypes.ts. `resolveAction` widens its parameter
 * instead, so an improvisation travels the same code path as any other action
 * and a caller that never builds one sees byte-identical behaviour.
 *
 * Nothing here is a new mechanic: the effects run through the Stand-power
 * interpreter's own `executeEffect`, and `consultImprovisation` re-runs the
 * budget lint before executing a single one of them.
 */
export interface ImproviseAction {
  type: "improvise";
  /** 1..3 bounded `EffectSpec`s, priced as one `activated` power. */
  effects: EffectSpec[];
  /** Energy the actor spends, priced like a skill cost. */
  energyCost: number;
  /** Combatant the `other` selector resolves to (absent = nobody). */
  targetId?: string;
  /** The DM's line, logged through the existing `log` event. */
  narration: string;
  /** Floor-ramped budget ceiling; the lint clamps it to `BUDGET_CAPS.cat`. */
  budgetCap: number;
}

/**
 * Powers hook 9 (stand-powers.md addendum): a death sweep followed by
 * onAllyKO consults for every `ko` it produced; power effects can KO in
 * turn, so re-sweep and re-consult until quiet (bounded — each combatant
 * KOs at most once per revive). With no powers attached this is exactly
 * one processDeathsAndOutcome call.
 */
function sweepWithPowers(
  s: BattleState,
  events: BattleEvent[],
  rng: Rng,
): void {
  let from = events.length;
  processDeathsAndOutcome(s, events);
  while (consultAllyKOs(s, events, from, rng)) {
    from = events.length;
    processDeathsAndOutcome(s, events);
  }
}

/* ------------------------------------------------------------------ */
/* Off-Paw application gates (combat.md §8 / balance-and-meta.md §1)    */
/* ------------------------------------------------------------------ */

/**
 * Could an Off-Balance application land on `t` at all? False when the target
 * is dead, already Off-Balance, or Braced. Callers MUST check this before
 * drawing either gate roll — that is the determinism contract.
 */
function offBalanceLandable(t: Combatant): boolean {
  return isAlive(t) && !hasStatus(t, "offBalance") && !hasStatus(t, "braced");
}

/**
 * Tier-resistance gate: one `rng.float()` for a tier-2 (25%) or tier-3 (40%)
 * enemy, no draw at all for cats and tier-1 mooks. Returns true when the
 * application was shrugged off.
 */
function resistsOffBalance(
  t: Combatant,
  events: BattleEvent[],
  rng: Rng,
): boolean {
  const resist = offBalanceResistOf(t);
  if (resist <= 0) return false;
  if (rng.float() >= resist) return false;
  events.push({ t: "log", text: `${t.name} keeps its footing.` });
  return true;
}

/**
 * The full Off-Balance application path: landability check (no draws), the
 * per-skill application chance (skipped entirely at exactly 1.0), then tier
 * resistance, then the status itself. Returns true when Off-Balance landed.
 */
function tryOffBalance(
  t: Combatant,
  chance: number,
  events: BattleEvent[],
  rng: Rng,
): boolean {
  if (!offBalanceLandable(t)) return false;
  if (chance < 1.0 && rng.float() >= chance) return false;
  if (resistsOffBalance(t, events, rng)) return false;
  if (!applyStatus(t, "offBalance")) return false;
  events.push({ t: "statusApplied", id: t.id, status: "offBalance", value: 0 });
  return true;
}

export function resolveAction(
  state: BattleState,
  action: BattleAction | ImproviseAction,
  rng: Rng,
): ResolveResult {
  const s = cloneState(state);
  reclonePowers(s, state); // powers hook 2: un-share the charge counters
  const events: BattleEvent[] = [];

  // ---- pending Cat Pile prompt: only a catPile answer is legal ----
  if (s.catPilePrompt) {
    if (action.type !== "catPile") {
      throw new Error("combat: Cat Pile prompt awaits a catPile action");
    }
    s.catPilePrompt = false;
    if (action.accept) {
      executeCatPile(s, events);
      sweepWithPowers(s, events, rng);
    }
    return { state: s, events };
  }
  if (s.outcome !== "ongoing") {
    throw new Error("combat: battle is over");
  }

  const entryIdx = nextEntryIndex(s);
  if (entryIdx < 0) {
    throw new Error("combat: round exhausted — call startRound");
  }
  const entry = s.queue[entryIdx];
  s.queueIndex = entryIdx;
  const actor = byId(s, entry.combatantId);

  // ---- turn-start phase ----
  const frazzled = hasStatus(actor, "frazzled");
  const turnStart: { t: "turnStart"; id: string; energyAfterRegen?: number } = {
    t: "turnStart",
    id: actor.id,
  };
  events.push(turnStart);
  turnStartStatusPhase(actor, events); // guarded expiry + scratched + mending
  if (actor.hp <= 0) {
    entry.acted = true;
    sweepWithPowers(s, events, rng);
    return { state: s, events };
  }
  if (frazzled) {
    // Frazzled consumes the slot entirely: no regen, no cooldown tick,
    // no action; then it is removed. On a doubleTurn boss this eats only
    // this one queue entry (combat.md §6).
    removeStatus(actor, "frazzled");
    events.push({ t: "statusExpired", id: actor.id, status: "frazzled" });
    events.push({
      t: "log",
      text: `${actor.name} is frazzled and loses the turn!`,
    });
    entry.acted = true;
    return { state: s, events };
  }
  if (actor.side === "cat") {
    actor.energy = Math.min(actor.stats.enMax, actor.energy + 2);
    turnStart.energyAfterRegen = actor.energy;
  } else {
    for (const id of Object.keys(actor.cooldowns)) {
      actor.cooldowns[id] = Math.max(0, actor.cooldowns[id] - 1);
    }
  }
  // Powers hook 4: the actor's onTurnStart power, after regen/cooldown tick
  // (a frazzled actor already returned — the lost slot consults nothing).
  consultPower(s, "onTurnStart", { ownerId: actor.id }, events, rng);

  // ---- the action ----
  switch (action.type) {
    case "skill": {
      const skill = SKILLS[action.skillId];
      if (!skill) throw new Error(`combat: unknown skill '${action.skillId}'`);
      const bdata = actor.side === "enemy" ? bossDataOf(actor) : undefined;
      if (bdata?.windup && skill.id === bdata.windup.skillId) {
        if (actor.charging?.skillId === skill.id) {
          // release: the finished windup fires unconditionally
          actor.charging = null;
          actor.cooldowns[skill.id] = skill.cooldown ?? 0;
          resolveSkill(s, actor, skill, undefined, events, rng, {});
        } else {
          // first slot: telegraph, no damage yet
          actor.charging = {
            skillId: skill.id,
            ranks: [...skill.target.ranks],
          };
          actor.cooldowns[skill.id] = skill.cooldown ?? 0;
          events.push({
            t: "charging",
            id: actor.id,
            skillId: skill.id,
            ranks: [...skill.target.ranks],
            text: bdata.windup.telegraph,
          });
        }
        break;
      }
      if (bdata?.summon && skill.id === bdata.summon.skillId) {
        actor.cooldowns[skill.id] = skill.cooldown ?? 0;
        if (canSummon(s, actor)) doSummon(s, actor, events);
        break;
      }
      resolveSkill(s, actor, skill, action.targetId, events, rng, {});
      break;
    }

    case "move": {
      if (actor.side !== "cat") throw new Error("combat: move is a cat action");
      const targetRank = actor.rank + (action.dir === "forward" ? -1 : 1);
      const other = living(s, "cat").find((c) => c.rank === targetRank);
      if (!other) throw new Error("combat: no adjacent cat to swap with");
      const fromA = actor.rank;
      const fromB = other.rank;
      swapRanks(actor, other);
      events.push({
        t: "moved",
        id: actor.id,
        from: fromA,
        to: actor.rank,
        forced: false,
      });
      events.push({
        t: "moved",
        id: other.id,
        from: fromB,
        to: other.rank,
        forced: false,
      });
      break;
    }

    case "guard": {
      if (actor.side !== "cat")
        throw new Error("combat: guard is a cat action");
      events.push({ t: "guard", id: actor.id });
      if (applyStatus(actor, "guarded")) {
        events.push({
          t: "statusApplied",
          id: actor.id,
          status: "guarded",
          value: 0,
        });
      }
      gainEnergy(actor, 2, events);
      // Trait: Purr Engine — Baguette's Guard charges every OTHER living cat.
      const purrTier = traitTier(actor, "purrEngine");
      if (purrTier > 0) {
        events.push({ t: "traitTriggered", id: actor.id, trait: "purrEngine" });
        for (const c of living(s, "cat")) {
          if (c.id !== actor.id) gainEnergy(c, purrTier, events);
        }
      }
      break;
    }

    case "item": {
      const def = CONSUMABLES[action.itemId];
      if (!def) throw new Error(`combat: unknown item '${action.itemId}'`);
      if (def.oncePerBattle) {
        if (s.cucumberUsed)
          throw new Error("combat: The Cucumber was already used");
        s.cucumberUsed = true;
      }
      if (def.nonBoss && !s.canFlee) {
        throw new Error(`combat: ${def.name} cannot be used in a boss battle`);
      }
      if (def.id === "canOpenerRecording") {
        // Guaranteed Scatter!: no roll, all normal flee consequences.
        doFlee(s, events, 1.0, true);
        break;
      }
      resolveSkill(s, actor, def.battleSkill, action.targetId, events, rng, {
        isItem: true,
        flatHeal: def.explore?.heal,
      });
      break;
    }

    case "flee": {
      if (actor.side !== "cat") throw new Error("combat: flee is a cat action");
      if (!s.canFlee) throw new Error("combat: cannot flee this battle");
      const chance = fleeChance(s);
      doFlee(s, events, chance, rng.float() < chance);
      break;
    }

    case "advance": {
      // Enemy AI fallback: voluntary move 1 rank forward (no Off-Balance).
      const res = repositionWithin(s, actor, -1);
      for (const ch of res.changes) {
        events.push({
          t: "moved",
          id: ch.c.id,
          from: ch.from,
          to: ch.to,
          forced: false,
        });
      }
      break;
    }

    case "improvise": {
      if (actor.side !== "cat") {
        throw new Error("combat: improvise is a cat action");
      }
      // The DM's line lands first, whatever the mechanics turn out to be —
      // a refused or budget-dropped improvisation is still a told beat.
      events.push({ t: "log", text: action.narration });
      const cost = Math.max(0, Math.round(action.energyCost));
      if (actor.energy < cost) {
        throw new Error("combat: not enough energy to improvise");
      }
      // Spend only for an improvisation that will actually land: a list the
      // lint drops costs the turn (the cat tried) but not the energy.
      if (lintImprovisation(action.effects, action.budgetCap).ok && cost > 0) {
        actor.energy -= cost;
        events.push({ t: "energy", id: actor.id, delta: -cost });
      }
      consultImprovisation(
        s,
        actor.id,
        action.targetId,
        action.effects,
        action.budgetCap,
        events,
      );
      break;
    }

    case "catPile":
      throw new Error("combat: no Cat Pile prompt is pending");

    default: {
      const never: never = action;
      throw new Error(`combat: unknown action ${JSON.stringify(never)}`);
    }
  }

  // ---- pipeline step 5: Cat Pile check after any cat's action ----
  if (actor.side === "cat" && s.outcome === "ongoing") {
    maybePromptCatPile(s, events);
  }
  // Powers hook 8: the actor's onTurnEnd power (skipped if the actor fell
  // to a counter during its own action — consultPower checks liveness).
  consultPower(s, "onTurnEnd", { ownerId: actor.id }, events, rng);
  // ---- pipeline step 6: death / victory check ----
  sweepWithPowers(s, events, rng);
  entry.acted = true;
  return { state: s, events };
}

/* ------------------------------------------------------------------ */
/* skill pipeline                                                      */
/* ------------------------------------------------------------------ */

interface SkillOpts {
  isItem?: boolean;
  flatHeal?: number | "full";
}

function resolveSkill(
  s: BattleState,
  actor: Combatant,
  skill: Skill,
  targetId: string | undefined,
  events: BattleEvent[],
  rng: Rng,
  opts: SkillOpts,
): void {
  // legality (driver bugs should explode, not corrupt state). `usableFrom` is
  // projected onto the actor's actual formation size — see canUseFrom.
  if (!canUseFrom(s, actor, skill)) {
    throw new Error(`combat: ${skill.id} not usable from rank ${actor.rank}`);
  }
  if (skill.oncePerBattle && actor.usedOncePerBattle.includes(skill.id)) {
    throw new Error(`combat: ${skill.id} already used this battle`);
  }
  if (actor.side === "cat" && !opts.isItem) {
    if (actor.energy < skill.cost) {
      throw new Error(`combat: not enough energy for ${skill.id}`);
    }
    if (skill.cost > 0) {
      actor.energy -= skill.cost;
      events.push({ t: "energy", id: actor.id, delta: -skill.cost });
    }
  }
  if (actor.side === "enemy") {
    actor.cooldowns[skill.id] = skill.cooldown ?? 0;
  }
  if (skill.oncePerBattle) actor.usedOncePerBattle.push(skill.id);

  // ---- target selection (captured once, before anything moves) ----
  let targets: Combatant[];
  if (skill.target.pattern === "row") {
    targets = validTargets(s, actor, skill);
  } else if (skill.target.side === "self") {
    targets = [actor];
  } else {
    if (!targetId) throw new Error(`combat: ${skill.id} needs a target`);
    const t = byId(s, targetId);
    const valid = validTargets(s, actor, skill);
    if (!valid.some((v) => v.id === t.id)) {
      throw new Error(
        `combat: ${targetId} is not a valid target for ${skill.id}`,
      );
    }
    targets = [t];
  }

  // ---- revive skills (Nine Lives Nudge / Feather Wand) ----
  if (skill.revivePct !== undefined) {
    const t = targets[0];
    if (!t?.ko) throw new Error(`combat: ${skill.id} targets a KO'd ally`);
    t.ko = false;
    t.hp = Math.max(1, roundHalfUp(skill.revivePct * t.stats.hp));
    t.statuses = [];
    const others = living(s, t.side).filter((c) => c.id !== t.id);
    t.rank = others.length + 1; // placed at the back (rank 4 with 3 living)
    events.push({ t: "revive", id: t.id, hp: t.hp });
    return;
  }

  // ---- step 1: damage / heal, per target in rank order ----
  const isDamage = skill.kind === "damage" && skill.power > 0;
  const isHeal = skill.kind === "heal";
  let hookOffBalUsed = false; // critOffBalance: max once per skill use
  for (const t of targets) {
    if (!isAlive(t)) continue;
    if (isDamage) {
      const variance = 0.9 + 0.1 * rng.int(0, 2);
      // Trait: Opportunist — bonus crit chance vs Off-Balance targets.
      let critChance = actor.stats.crt;
      const oppTier = traitTier(actor, "opportunist");
      if (oppTier > 0 && hasStatus(t, "offBalance")) critChance += 10 * oppTier;
      const crit = rng.float() < critChance / 100;
      const offBal = hasStatus(t, "offBalance");
      const guard = hasStatus(t, "guarded");
      const dmg = roundHalfUp(
        (skill.power / 100) *
          actor.stats.atk *
          variance *
          (crit ? 1.5 : 1.0) *
          (offBal ? OFF_BALANCE_MULT : 1.0) *
          (guard ? 0.5 : 1.0),
      );
      const final = Math.max(1, dmg - t.stats.def);
      t.hp = Math.max(0, t.hp - final);
      events.push({
        t: "damage",
        id: t.id,
        amount: final,
        crit,
        offBal,
        source: skill.id,
      });
      // Hook: The Red Dot — crits also inflict Off-Balance (heavy boss:
      // chip 1 Poise instead); max once per skill use.
      if (crit && actor.hooks.includes("critOffBalance") && !hookOffBalUsed) {
        hookOffBalUsed = true;
        if (isBoss(t)) {
          chipPoise(t, 1, events);
        } else if (!t.traits.includes("heavy")) {
          tryOffBalance(t, 1.0, events, rng);
        }
      }
      if (isBoss(t)) checkPhase(t, events);
      // Powers hook 5 (stand-powers.md addendum): per damaged target, after
      // every existing roll of this step — attacker onDealHit → attacker
      // onCrit (crit only) → victim onTakeHit (skipped if the hit KO'd it).
      consultPower(
        s,
        "onDealHit",
        { ownerId: actor.id, otherId: t.id },
        events,
        rng,
      );
      if (crit) {
        consultPower(
          s,
          "onCrit",
          { ownerId: actor.id, otherId: t.id },
          events,
          rng,
        );
      }
      consultPower(
        s,
        "onTakeHit",
        { ownerId: t.id, otherId: actor.id },
        events,
        rng,
      );
    } else if (isHeal) {
      const flat =
        opts.flatHeal === "full"
          ? t.stats.hp - t.hp
          : opts.flatHeal !== undefined
            ? opts.flatHeal
            : undefined;
      const amount = flat ?? roundHalfUp((skill.power / 100) * actor.stats.atk);
      const healed = Math.min(amount, t.stats.hp - t.hp);
      if (healed > 0) t.hp += healed;
      events.push({
        t: "heal",
        id: t.id,
        amount: Math.max(0, healed),
        source: skill.id,
      });
      // Hook: Bell of Purrfect Pitch — heal-kind skills also grant
      // Mending value 2 (2 rounds, §6 stacking).
      if (actor.hooks.includes("healsGrantMending")) {
        if (applyStatus(t, "mending", 2)) {
          events.push({
            t: "statusApplied",
            id: t.id,
            status: "mending",
            value: 2,
          });
        }
      }
    }
  }

  // ---- step 2: forced movement (Off-Balance / Poise chips) ----
  let anyForcedResult = false; // String Theory: moved ≥1 OR chipped Poise
  let firstForcedId: string | null = null; // onForcedMove 'other' context
  if (skill.moveTarget) {
    const delta = skill.moveTarget;
    const chipAmount = actor.hooks.includes("poiseChip2") ? 2 : 1;
    let chippedThisUse = false; // at most one chip per skill use
    for (const t of targets) {
      if (!isAlive(t)) continue; // push moot on the freshly dead
      if (t.traits.includes("heavy")) {
        // The body never moves; vs a boss the ATTEMPT is a staggering blow
        // when the move would have covered ≥1 rank in bound space
        // (a pull on a rank-1 target never chips — §8's clamp spirit).
        if (
          isBoss(t) &&
          !chippedThisUse &&
          hypotheticalDistance(t, delta) >= 1
        ) {
          chipPoise(t, chipAmount, events);
          chippedThisUse = true;
          anyForcedResult = true;
          if (!firstForcedId) firstForcedId = t.id;
        }
        continue;
      }
      // Trait: Immovable Loaf — once per battle Bruno declines to be moved.
      const order = living(s, t.side);
      const idx = order.findIndex((c) => c.id === t.id);
      const clampedIdx = Math.min(Math.max(idx + delta, 0), order.length - 1);
      const wouldMove = Math.abs(clampedIdx - idx);
      if (
        wouldMove >= 1 &&
        t.traits.includes("immovableLoaf") &&
        !t.traitLatchUsed
      ) {
        t.traitLatchUsed = true;
        events.push({ t: "traitTriggered", id: t.id, trait: "immovableLoaf" });
        if (traitTier(t, "immovableLoaf") >= 2) {
          if (applyStatus(t, "guarded")) {
            events.push({
              t: "statusApplied",
              id: t.id,
              status: "guarded",
              value: 0,
            });
          }
        }
        continue;
      }
      const res = repositionWithin(s, t, delta);
      for (const ch of res.changes) {
        events.push({
          t: "moved",
          id: ch.c.id,
          from: ch.from,
          to: ch.to,
          forced: ch.c.id === t.id,
        });
      }
      if (res.distance >= 1) {
        anyForcedResult = true;
        if (!firstForcedId) firstForcedId = t.id;
        // Rule 1 — Off-Paw: moved ≥1 clamped rank against its will. Two gates
        // now stand between the shove and the debuff (see tryOffBalance):
        // the skill's own application chance, then tier resistance.
        tryOffBalance(t, skill.offBalanceChance ?? 1.0, events, rng);
        // Hook: Static-Charged Fluff — an enemy force-moving the wearer
        // becomes Off-Balance itself (heavy mover: chip 1 Poise).
        if (t.hooks.includes("moverOffBalance") && actor.side !== t.side) {
          if (isBoss(actor)) {
            chipPoise(actor, 1, events);
          } else if (!actor.traits.includes("heavy")) {
            tryOffBalance(actor, 1.0, events, rng);
          }
        }
      }
    }
  }

  // ---- step 3: applies (per target, per effect) + cleanses ----
  if (skill.applies) {
    const alwaysHit = actor.hooks.includes("appliesAlwaysHit"); // Cursed Yarn
    for (const app of skill.applies) {
      const to = app.to ?? "target";
      const recipients =
        to === "self"
          ? [actor]
          : to === "allEnemies"
            ? living(s, opposite(actor.side))
            : targets;
      for (const r of recipients) {
        if (!isAlive(r)) continue;
        const chance = alwaysHit ? 1.0 : app.chance;
        // A chance of EXACTLY 1.0 draws no roll (GDD §4 ruling).
        const hit = chance >= 1.0 ? true : rng.float() < chance;
        if (!hit) continue;
        // An Off-Balance carried by `applies` (Whisker Feint, Stand powers)
        // faces the same tier gate as the Off-Paw rule, drawn right after
        // this effect's own chance roll — but only when it could land.
        if (app.status === "offBalance") {
          if (!offBalanceLandable(r)) continue;
          if (resistsOffBalance(r, events, rng)) continue;
        }
        const value =
          app.status === "provoked"
            ? s.combatants.indexOf(actor)
            : (app.value ?? 0);
        if (applyStatus(r, app.status, value)) {
          events.push({
            t: "statusApplied",
            id: r.id,
            status: app.status,
            value: app.value ?? 0,
          });
          // Frazzling a charging boss cancels the telegraphed nuke.
          if (app.status === "frazzled" && r.charging) {
            r.charging = null;
            events.push({ t: "chargeCancelled", id: r.id });
          }
          // Powers hook 7: the recipient's onStatusApplied power, per
          // landed application (after this application's chance roll).
          consultPower(
            s,
            "onStatusApplied",
            { ownerId: r.id, otherId: actor.id },
            events,
            rng,
          );
        }
      }
    }
  }
  if (skill.cleanses) {
    for (const t of targets) {
      if (!isAlive(t)) continue;
      for (const st of skill.cleanses) {
        if (cleanseOneOf(t, st)) {
          events.push({ t: "cleansed", id: t.id, status: st });
          // Cleansing Off-Balance is a CONSUMPTION like a Cat Pile: the
          // target got its paws back under it and is Braced (§8).
          if (st === "offBalance") {
            braceAfterOffBalance(t, BRACE_ON_CONSUME, events);
          }
        }
      }
    }
  }

  // ---- step 4: self movement (voluntary — never Off-Balance) ----
  if (skill.moveSelf) {
    const res = repositionWithin(s, actor, skill.moveSelf);
    for (const ch of res.changes) {
      events.push({
        t: "moved",
        id: ch.c.id,
        from: ch.from,
        to: ch.to,
        forced: false,
      });
    }
  }

  // energyGain is added after the spend (combat.md §5); for item skills it is
  // target-directed (Catnip charges the chosen ally).
  if (skill.energyGain) {
    const recipient = opts.isItem ? targets[0] : actor;
    if (recipient && recipient.side === "cat" && isAlive(recipient)) {
      gainEnergy(recipient, skill.energyGain, events);
    }
  }

  // Trait: String Theory — end of step 4, before the Cat Pile check: a skill
  // that force-moved ≥1 clamped rank or chipped Poise refunds energy.
  const stringTier = traitTier(actor, "stringTheory");
  if (stringTier > 0 && anyForcedResult) {
    events.push({ t: "traitTriggered", id: actor.id, trait: "stringTheory" });
    gainEnergy(actor, stringTier, events);
  }
  // Powers hook 6: the actor's onForcedMove power — once per skill use that
  // force-moved ≥1 clamped rank or chipped Poise, after the trait refund
  // ('other' = the first force-moved/chipped target).
  if (anyForcedResult) {
    consultPower(
      s,
      "onForcedMove",
      { ownerId: actor.id, otherId: firstForcedId ?? undefined },
      events,
      rng,
    );
  }
}

function cleanseOneOf(t: Combatant, status: StatusId): boolean {
  const i = t.statuses.findIndex((s) => s.id === status);
  if (i < 0) return false;
  t.statuses.splice(i, 1);
  return true;
}

/* ------------------------------------------------------------------ */
/* Cat Pile (combat.md §8, Rule 2)                                     */
/* ------------------------------------------------------------------ */

/** floor(0.30 · Σ living cats' atk); Alpha Beetle counts its wearer twice. */
export function catPileDamageEach(state: BattleState): number {
  let sum = 0;
  for (const c of living(state, "cat")) {
    sum += c.stats.atk;
    if (c.hooks.includes("catPileDouble")) sum += c.stats.atk;
  }
  return Math.floor(0.3 * sum);
}

function maybePromptCatPile(s: BattleState, events: BattleEvent[]): void {
  if (s.catPileLatch) return; // once per round
  const cats = living(s, "cat");
  const enemies = living(s, "enemy");
  if (cats.length < 2 || enemies.length === 0) return;
  if (!enemies.every((e) => hasStatus(e, "offBalance"))) return;
  s.catPileLatch = true;
  s.catPilePrompt = true;
  events.push({ t: "catPilePrompt", damageEach: catPileDamageEach(s) });
}

function executeCatPile(s: BattleState, events: BattleEvent[]): void {
  const damageEach = catPileDamageEach(s);
  const targets = living(s, "enemy");
  events.push({
    t: "catPile",
    damageEach,
    targets: targets.map((t) => t.id),
  });
  for (const t of targets) {
    // typeless: ignores DEF, Guarded and the Off-Balance multiplier
    t.hp = Math.max(0, t.hp - damageEach);
    events.push({
      t: "damage",
      id: t.id,
      amount: damageEach,
      crit: false,
      offBal: false,
      source: "catPile",
    });
  }
  // survivors scramble back to their feet — and stay on them (Braced, §8)
  for (const t of targets) {
    if (t.hp > 0 && removeStatus(t, "offBalance")) {
      events.push({ t: "statusExpired", id: t.id, status: "offBalance" });
      braceAfterOffBalance(t, BRACE_ON_CONSUME, events);
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function gainEnergy(c: Combatant, amount: number, events: BattleEvent[]): void {
  const before = c.energy;
  c.energy = Math.min(c.stats.enMax, c.energy + amount);
  const delta = c.energy - before;
  if (delta !== 0) events.push({ t: "energy", id: c.id, delta });
}

function doFlee(
  s: BattleState,
  events: BattleEvent[],
  chance: number,
  ok: boolean,
): void {
  events.push({ t: "fleeAttempt", ok, chance });
  if (!ok) return; // the turn is wasted, no stacking penalty
  for (const c of s.combatants) c.statuses = [];
  s.outcome = "fled";
  events.push({ t: "fled" });
}
