/**
 * c(at)rpg combat — boss machinery (combat.md §11).
 *
 * Bosses are data + five flags, not a second engine: heavy + Poise, double
 * turn (handled in turns.ts initiative), 50% phase switch, telegraphed
 * windup (charge state lives on the Combatant, resolve.ts drives it), and
 * summons. All boss data comes from `ENEMIES[speciesId].boss`.
 */
import type {
  BattleEvent,
  BattleState,
  BossData,
  Combatant,
} from "../types.js";
import { ENEMIES } from "../../content/enemies.js";
import { living } from "./state.js";
import { applyStatus, removeStatus } from "./status.js";

export function bossDataOf(c: Combatant): BossData | undefined {
  return c.speciesId ? ENEMIES[c.speciesId]?.boss : undefined;
}

/** A combatant with a Poise counter (set up from BossData at battle start). */
export const isBoss = (c: Combatant): boolean => c.poiseMax !== undefined;

/**
 * Chip `amount` Poise off a boss (combat.md §11.1). At 0: Poise break —
 * the boss becomes Off-Balance until the round-end phase, any charging
 * windup is cancelled, and Poise resets to max.
 */
export function chipPoise(
  boss: Combatant,
  amount: number,
  events: BattleEvent[],
): void {
  if (boss.poise === undefined || boss.poiseMax === undefined) return;
  boss.poise = Math.max(0, boss.poise - amount);
  events.push({ t: "poiseChip", id: boss.id, left: boss.poise });
  if (boss.poise === 0) {
    events.push({ t: "poiseBreak", id: boss.id });
    // §11.1 is untouched by the Braced rule: a Poise break ALWAYS opens the
    // window. It is the one bypass — the boss's own Braced (earned when a
    // previous break's Off-Balance expired) is stripped first.
    removeStatus(boss, "braced");
    if (applyStatus(boss, "offBalance")) {
      events.push({
        t: "statusApplied",
        id: boss.id,
        status: "offBalance",
        value: 0,
      });
    }
    if (boss.charging) {
      boss.charging = null;
      events.push({ t: "chargeCancelled", id: boss.id });
    }
    boss.poise = boss.poiseMax;
  }
}

/**
 * Phase switch check (combat.md §11.3): the moment HP crosses a phase's
 * hpPct threshold the skill list swaps and cooldowns clear. Never goes
 * backward.
 */
export function checkPhase(boss: Combatant, events: BattleEvent[]): void {
  const data = bossDataOf(boss);
  if (!data || boss.hp <= 0) return;
  const pct = boss.hp / boss.stats.hp;
  let phase = 0;
  for (let i = 0; i < data.phases.length; i++) {
    if (pct <= data.phases[i].hpPct) phase = i;
  }
  if (phase > (boss.phase ?? 0)) {
    boss.phase = phase;
    boss.skills = [...data.phases[phase].skills];
    boss.cooldowns = {};
    events.push({ t: "phaseChange", id: boss.id, phase });
    events.push({ t: "log", text: `${boss.name} shifts into a new phase!` });
  }
}

/** Living summons currently on the field. */
export function summonsAlive(state: BattleState): number {
  return state.combatants.filter(
    (c) => c.id.startsWith("summon") && !c.ko && c.hp > 0,
  ).length;
}

/** Whether the boss's summon skill can fire (cap + an empty rank ≤ 5). */
export function canSummon(state: BattleState, boss: Combatant): boolean {
  const data = bossDataOf(boss);
  if (!data?.summon) return false;
  return (
    summonsAlive(state) < data.summon.cap && living(state, "enemy").length < 5
  );
}

/**
 * Spawn the boss's minion into the lowest empty enemy rank (combat.md §11.5).
 * The summon is not in the current frozen queue, so it acts starting next
 * round automatically.
 */
export function doSummon(
  state: BattleState,
  boss: Combatant,
  events: BattleEvent[],
): void {
  const data = bossDataOf(boss);
  if (!data?.summon || !canSummon(state, boss)) return;
  const minionId = data.summon.minion;
  const def = ENEMIES[minionId];
  if (!def) throw new Error(`combat: unknown summon minion '${minionId}'`);
  const seq = state.combatants.filter((c) => c.id.startsWith("summon")).length;
  const rank = living(state, "enemy").length + 1;
  const minion: Combatant = {
    id: `summon${seq}:${minionId}`,
    name: def.name,
    side: "enemy",
    speciesId: minionId,
    rank,
    stats: { ...def.stats },
    hp: def.stats.hp,
    energy: 0,
    skills: [...def.skills],
    cooldowns: Object.fromEntries(def.skills.map((id) => [id, 0])),
    statuses: [],
    traits: [...def.traits],
    hooks: [],
    usedOncePerBattle: [],
    ko: false,
  };
  state.combatants.push(minion);
  events.push({ t: "summon", id: minion.id, minion: minionId, rank });
}
