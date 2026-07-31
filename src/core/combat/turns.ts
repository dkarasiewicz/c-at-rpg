/**
 * c(at)rpg combat — rounds, initiative, outcomes, Nine Lives (WP-03).
 *
 * `startRound` first runs the PREVIOUS round's round-end phase (combat.md §7)
 * when one exists, then rolls initiative in the documented draw order (cats
 * rank 1→4, then enemies rank 1→5; a `doubleTurn` boss draws two independent
 * entries) and freezes the queue for the round.
 */
import type {
  BattleEvent,
  BattleResult,
  BattleState,
  QueueEntry,
  Rng,
} from "../types.js";
import { ENEMIES } from "../../content/enemies.js";
import { clamp } from "../util.js";
import {
  byId,
  cloneState,
  compressRanks,
  living,
  nextActor,
  hasStatus,
} from "./state.js";
import { clearStatuses, roundEndPhase } from "./status.js";
import { bossDataOf } from "./boss.js";
import {
  consultBattleStart,
  reclonePowers,
  resetRoundCharges,
} from "./powers.js";

export { nextActor };

/**
 * Round-end phase (if a round is in progress) + new round initiative.
 * If the round-end victory/defeat check ends the battle, no new round is
 * rolled.
 */
export function startRound(
  state: BattleState,
  rng: Rng,
): { state: BattleState; events: BattleEvent[] } {
  const s = cloneState(state);
  reclonePowers(s, state); // powers hook 2: un-share the charge counters
  const events: BattleEvent[] = [];
  if (s.outcome !== "ongoing") return { state: s, events };

  if (s.round >= 1) {
    roundEndPhase(s, events);
    processDeathsAndOutcome(s, events);
    if (s.outcome !== "ongoing") return { state: s, events };
  }

  s.round += 1;
  const order = [...living(s, "cat"), ...living(s, "enemy")];
  const entries: QueueEntry[] = [];
  for (const c of order) {
    const rolls = bossDataOf(c)?.doubleTurn ? 2 : 1;
    for (let k = 0; k < rolls; k++) {
      entries.push({
        combatantId: c.id,
        initiative: c.stats.spd + rng.int(0, 2),
        acted: false,
      });
    }
  }
  // Sort descending by initiative; ties: cats before enemies → lower current
  // rank → lower entity id (combat.md §2). Array#sort is stable, so a
  // double-turn boss's two equal entries keep their draw order.
  entries.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    const ca = byId(s, a.combatantId);
    const cb = byId(s, b.combatantId);
    if (ca.side !== cb.side) return ca.side === "cat" ? -1 : 1;
    if (ca.rank !== cb.rank) return ca.rank - cb.rank;
    return ca.id < cb.id ? -1 : ca.id > cb.id ? 1 : 0;
  });
  s.queue = entries;
  s.queueIndex = 0;
  events.push({
    t: "roundStart",
    round: s.round,
    queue: entries.map((e) => ({ ...e })),
  });
  // Powers hook 3 (stand-powers.md): perRound charges reset with the new
  // round; on round 1, onBattleStart powers consult in slot (queue) order —
  // strictly AFTER the initiative rolls above, per the RNG addendum. A
  // battle with no powers attached takes the no-op path and draws nothing.
  resetRoundCharges(s);
  if (s.round === 1 && consultBattleStart(s, events, rng)) {
    processDeathsAndOutcome(s, events);
  }
  return { state: s, events };
}

/** True when the next actor's turn will be auto-skipped (Frazzled). */
export function isAutoSkip(state: BattleState): boolean {
  const actor = nextActor(state);
  return actor !== null && hasStatus(actor, "frazzled");
}

/**
 * Death sweep + victory/defeat check (pipeline step 6 / round-end step 4).
 * Dead combatants are marked `ko`, statuses cleared, ranks compressed
 * (corpse slide). On victory, still-KO'd cats stand up (Nine Lives, §12).
 */
export function processDeathsAndOutcome(
  state: BattleState,
  events: BattleEvent[],
): void {
  let changed = false;
  for (const c of state.combatants) {
    if (!c.ko && c.hp <= 0) {
      c.hp = 0;
      c.ko = true;
      clearStatuses(c);
      if (c.charging) c.charging = null;
      events.push({ t: "ko", id: c.id });
      changed = true;
    }
  }
  if (changed) {
    for (const side of ["cat", "enemy"] as const) {
      for (const ch of compressRanks(state, side)) {
        events.push({
          t: "moved",
          id: ch.c.id,
          from: ch.from,
          to: ch.to,
          forced: false,
        });
      }
    }
  }
  if (state.outcome !== "ongoing") return;
  const cats = living(state, "cat");
  const enemies = living(state, "enemy");
  if (enemies.length === 0) {
    state.outcome = "victory";
    events.push({ t: "victory" });
    standUpNineLives(state, events);
  } else if (cats.length === 0) {
    state.outcome = "defeat";
    events.push({ t: "defeat" });
  }
}

/**
 * Post-battle standup (combat.md §12): each still-KO'd cat stands up at 1 HP
 * and loses 1 Life — unless it wears the Ninth Bell (once per run: the loss
 * is prevented and the bell cracks; recorded via the `'ninthBell'` sentinel
 * in `usedOncePerBattle` so `battleResult` can report `ninthBellSpent`).
 */
function standUpNineLives(state: BattleState, events: BattleEvent[]): void {
  for (const c of state.combatants) {
    if (c.side !== "cat" || !c.ko) continue;
    c.hp = 1;
    if (
      c.hooks.includes("ninthBell") &&
      !c.usedOncePerBattle.includes("ninthBell")
    ) {
      c.usedOncePerBattle.push("ninthBell");
      events.push({ t: "lifeSaved", id: c.id });
    } else {
      c.lives = Math.max(0, (c.lives ?? 0) - 1);
      events.push({ t: "lifeLost", id: c.id, livesLeft: c.lives });
    }
  }
}

/** Flee chance (combat.md §12): clamp(0.4 + 0.05·(avgCatSpd − avgEnemySpd), 0.25, 0.9). */
export function fleeChance(state: BattleState): number {
  const avg = (arr: { stats: { spd: number } }[]): number =>
    arr.reduce((sum, c) => sum + c.stats.spd, 0) / Math.max(1, arr.length);
  const cats = living(state, "cat");
  const enemies = living(state, "enemy");
  return clamp(0.4 + 0.05 * (avg(cats) - avg(enemies)), 0.25, 0.9);
}

/**
 * Final results for the run layer. `events` is the accumulated full battle
 * log (the frozen BattleState shape has no log field, so the driver passes
 * the log it collected).
 */
export function battleResult(
  state: BattleState,
  events: BattleEvent[],
): BattleResult {
  if (state.outcome === "ongoing") {
    throw new Error("combat: battleResult() before the battle ended");
  }
  const cats = state.combatants
    .filter((c) => c.side === "cat")
    .map((c) => ({ classId: c.classId!, hp: c.hp, lives: c.lives ?? 0 }));
  const deadEnemies = state.combatants.filter(
    (c) => c.side === "enemy" && c.ko,
  );
  const xpGained =
    state.outcome === "victory"
      ? deadEnemies.reduce(
          (sum, c) => sum + (ENEMIES[c.speciesId ?? ""]?.xp ?? 0),
          0,
        )
      : 0;
  return {
    outcome: state.outcome,
    cats,
    xpGained,
    catPiles: events.filter((e) => e.t === "catPile").length,
    enemiesDefeated: deadEnemies.length,
    bossDefeated:
      state.outcome === "victory" &&
      deadEnemies.some((c) => !!ENEMIES[c.speciesId ?? ""]?.boss),
    ninthBellSpent: state.combatants.some((c) =>
      c.usedOncePerBattle.includes("ninthBell"),
    ),
    events,
  };
}
