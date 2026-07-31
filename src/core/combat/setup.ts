/**
 * c(at)rpg combat — battle construction (WP-03, ARCHITECTURE §2.3 API).
 *
 * `createBattle(setup)` folds the run layer's effective stats into fresh
 * Combatants: cats in marching order (front→back = rank 1..4), enemies from
 * the encounter array (rank 1..5), boss init from `ENEMIES[id].boss`, and
 * the Mewthical start hook (`startEnergy6` — Ball of Pure Yarn starts the
 * wearer at 6 Energy instead of 4; `energyNextBattle` bonuses stack on top,
 * capped at the cat's enMax).
 */
import type { BattleSetup, BattleState, Combatant } from "../types.js";
import type { PoweredBattleState } from "./powerTypes.js";
import { initPowersState } from "./powers.js";
import { ENEMIES } from "../../content/enemies.js";
import { curvedEnemyStats } from "../../content/floors.js";
import { clamp } from "../util.js";

export function createBattle(setup: BattleSetup): BattleState {
  const combatants: Combatant[] = [];

  setup.cats.forEach((cat, i) => {
    const startBase = cat.hooks.includes("startEnergy6") ? 6 : 4;
    combatants.push({
      id: `cat:${cat.classId}`,
      name: cat.name,
      side: "cat",
      classId: cat.classId,
      rank: i + 1,
      stats: { ...cat.stats },
      hp: cat.hp,
      energy: clamp(startBase + cat.startEnergyBonus, 0, cat.stats.enMax),
      skills: [...cat.skills],
      cooldowns: {},
      statuses: [],
      traits: [...cat.traits],
      hooks: [...cat.hooks],
      usedOncePerBattle: [],
      lives: cat.lives,
      ko: false,
    });
  });

  // Enemy stat blocks are authored once and scaled by the floor curve
  // (content/floors.ts ENEMY_CURVE; balance-and-meta.md §3). Bosses are
  // hand-tuned against the §11 flag set and are deliberately NOT curved.
  const floorNum = setup.floor ?? 1;

  setup.enemies.forEach((enemyId, i) => {
    const def = ENEMIES[enemyId];
    if (!def) throw new Error(`combat: unknown enemy '${enemyId}'`);
    const stats = def.boss
      ? { ...def.stats }
      : curvedEnemyStats(def.stats, floorNum);
    const c: Combatant = {
      id: `e${i}:${enemyId}`,
      name: def.name,
      side: "enemy",
      speciesId: enemyId,
      rank: i + 1,
      stats,
      hp: stats.hp,
      energy: 0,
      skills: def.boss ? [...def.boss.phases[0].skills] : [...def.skills],
      cooldowns: Object.fromEntries(def.skills.map((id) => [id, 0])),
      statuses: [],
      traits: [...def.traits],
      hooks: [],
      usedOncePerBattle: [],
      ko: false,
    };
    if (def.boss) {
      c.poise = def.boss.poise;
      c.poiseMax = def.boss.poise;
      c.phase = 0;
      c.charging = null;
    }
    combatants.push(c);
  });

  const state: BattleState = {
    combatants,
    round: 0,
    queue: [],
    queueIndex: 0,
    catPileLatch: false,
    catPilePrompt: false,
    cucumberUsed: false,
    canFlee: setup.canFlee,
    encounterIndex: setup.encounterIndex,
    outcome: "ongoing",
  };
  // Stand Powers (opt-in, stand-powers.md): a PoweredBattleSetup may attach
  // validated PowerScripts by combatant id. Without them the returned state
  // carries NO powers key — byte-identical to the pre-powers engine.
  const powers = initPowersState(
    setup,
    combatants.map((c) => c.id),
  );
  if (powers) (state as PoweredBattleState).powers = powers;
  return state;
}
