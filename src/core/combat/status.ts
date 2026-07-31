/**
 * c(at)rpg combat — the six status effects (combat.md §6).
 *
 * | Status     | Tick                         | Duration                     | Stacking |
 * |------------|------------------------------|------------------------------|----------|
 * | scratched  | victim's turn start, pre-regen | 3 rounds                   | values add, cap 3 applications, reapply resets duration |
 * | frazzled   | consumes the victim's slot   | 1 turn                       | no reapply while present |
 * | offBalance | passive ×1.5 taken           | until round-end / Cat Pile   | no stack |
 * | guarded    | passive ×0.5 taken           | until owner's next turn start| no stack |
 * | provoked   | targeting constraint         | until round-end              | newest provoker wins |
 * | mending    | heal at owner's turn start   | 2 rounds                     | duration refreshes, higher value wins |
 *
 * Scratched/mending are kept as one StatusInstance per APPLICATION (so
 * cleanses can remove exactly one); provoked stores the provoker's index in
 * `state.combatants` in its `value` field (the contract has no field for it).
 */
import type {
  BattleEvent,
  BattleState,
  Combatant,
  StatusId,
  StatusInstance,
} from "../types.js";
import { statusesOf, hasStatus } from "./state.js";

/**
 * Apply a status per the §6 stacking rules. Returns true when a new
 * application actually landed (callers emit `statusApplied` only then).
 * `value` carries magnitude (scratched/mending) or the provoker's combatant
 * index (provoked).
 */
export function applyStatus(
  target: Combatant,
  status: StatusId,
  value = 0,
): boolean {
  switch (status) {
    case "scratched": {
      const apps = statusesOf(target, "scratched");
      // reapplying resets duration to 3 (even at the application cap)
      for (const a of apps) a.duration = 3;
      if (apps.length >= 3) return false; // cap 3 applications (cap value 9)
      target.statuses.push({ id: "scratched", value, duration: 3 });
      return true;
    }
    case "frazzled":
      if (hasStatus(target, "frazzled")) return false; // no stunlock
      target.statuses.push({ id: "frazzled", value: 0, duration: 1 });
      return true;
    case "offBalance":
      if (hasStatus(target, "offBalance")) return false; // reapply = no-op
      target.statuses.push({ id: "offBalance", value: 0, duration: 1 });
      return true;
    case "guarded":
      if (hasStatus(target, "guarded")) return false; // no stacking
      target.statuses.push({ id: "guarded", value: 0, duration: 1 });
      return true;
    case "provoked": {
      const existing = statusesOf(target, "provoked")[0];
      if (existing) {
        existing.value = value; // newest provoker wins
        existing.duration = 1;
        return true;
      }
      target.statuses.push({ id: "provoked", value, duration: 1 });
      return true;
    }
    case "mending": {
      const existing = statusesOf(target, "mending")[0];
      if (existing) {
        existing.duration = 2; // duration refreshes
        existing.value = Math.max(existing.value, value); // higher value wins
        return true;
      }
      target.statuses.push({ id: "mending", value, duration: 2 });
      return true;
    }
  }
}

/** Remove every instance of `status`; true if any were removed. */
export function removeStatus(target: Combatant, status: StatusId): boolean {
  const before = target.statuses.length;
  target.statuses = target.statuses.filter((s) => s.id !== status);
  return target.statuses.length !== before;
}

/** Remove ONE application of `status` (oldest first); true if one existed. */
export function cleanseOne(target: Combatant, status: StatusId): boolean {
  const i = target.statuses.findIndex((s) => s.id === status);
  if (i < 0) return false;
  target.statuses.splice(i, 1);
  return true;
}

/** KO clears all statuses (combat.md §6). */
export function clearStatuses(target: Combatant): void {
  target.statuses = [];
}

/**
 * Owner's turn-start status phase, in order (combat.md §6):
 *  1. Guarded expires ("until the start of the owner's next turn").
 *  2. Scratched ticks: Σ values damage, ignores DEF and Guarded, min 1.
 *  3. Mending ticks: heal `value`, capped at max HP.
 * The caller handles death if scratched drops the owner to 0.
 */
export function turnStartStatusPhase(
  c: Combatant,
  events: BattleEvent[],
): void {
  if (removeStatus(c, "guarded")) {
    events.push({ t: "statusExpired", id: c.id, status: "guarded" });
  }
  const scratches = statusesOf(c, "scratched");
  if (scratches.length > 0) {
    const amount = Math.max(
      1,
      scratches.reduce((sum, s) => sum + s.value, 0),
    );
    c.hp = Math.max(0, c.hp - amount);
    events.push({
      t: "damage",
      id: c.id,
      amount,
      crit: false,
      offBal: false,
      source: "scratched",
    });
  }
  const mending = statusesOf(c, "mending")[0];
  if (mending && c.hp > 0) {
    const healed = Math.min(mending.value, c.stats.hp - c.hp);
    if (healed > 0) {
      c.hp += healed;
      events.push({ t: "heal", id: c.id, amount: healed, source: "mending" });
    }
  }
}

/**
 * Round-end phase steps 1-3 (combat.md §7):
 *  1. Decrement round-counted durations (scratched, mending), drop expired.
 *  2. Remove all Off-Balance and Provoked.
 *  3. Reset the once-per-round Cat Pile latch.
 * (Step 4, the victory/defeat check, is the caller's job.)
 */
export function roundEndPhase(state: BattleState, events: BattleEvent[]): void {
  for (const c of state.combatants) {
    if (c.statuses.length === 0) continue;
    const expired = new Set<StatusId>();
    const kept: StatusInstance[] = [];
    for (const s of c.statuses) {
      if (s.id === "scratched" || s.id === "mending") {
        s.duration -= 1;
        if (s.duration <= 0) {
          expired.add(s.id);
          continue;
        }
      } else if (s.id === "offBalance" || s.id === "provoked") {
        expired.add(s.id);
        continue;
      }
      kept.push(s);
    }
    c.statuses = kept;
    for (const id of expired) {
      events.push({ t: "statusExpired", id: c.id, status: id });
    }
  }
  state.catPileLatch = false;
}
