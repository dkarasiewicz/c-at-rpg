/**
 * FLOORS — the canonical 6-floor run table from GDD §6 (which replaces
 * dungeon.md §1's 9-floor table; same columns and semantics).
 *
 * The tile-maze columns (`w`/`h`/`roomAttempts`/`roamers`/`chests`/`events`)
 * are GONE with the maze itself; each floor now carries the AUTHORED run-map
 * budget instead (docs/design/run-map-and-dm.md §2: "density is authored, not
 * emergent"). Names, enemy pools and bosses are unchanged.
 *
 * THREAT BUDGETS were retuned around the two-cat opening
 * (balance-and-meta.md §2). Shipped values, old value in brackets:
 * 2-4 (3-4), 4-5 (4-5), 5-7 (5-6), 6-7 (6-8), 6-8 (8-10), 7-9 (10-12).
 * Floors 1-2 are tense because there are only two cats, not because the
 * packs are huge; the later floors shed BODIES rather than budget — a
 * tier-3 enemy costs 3-4 threat against a tier-1's 1-2, so floor 6's 7-9
 * buys ~2 monsters where floor 3's 5-7 buys ~4. `ENEMY_CURVE` (below)
 * supplies the pressure that pack size used to.
 *
 * Budget shape (`FloorMapBudget`, core/types.ts §2.7):
 *   columnsLo/Hi  how many columns the floor's graph runs, 4..7 (the entry
 *                 column and the boss/stairs column are both included, so a
 *                 5-column floor has 3 columns of real choices between them)
 *   rowsLo/Hi     nodes per intermediate column, 1..4
 *   weights       relative draw weights per node type; a type left out is
 *                 never drawn (that is how floor 1 has no elites)
 *   guaranteed    types forced onto the floor if the draws did not produce
 *                 them — every floor gets a shop and one guaranteed SAFE
 *                 node: a rest on floors 1-3, a camp on floors 4-6
 *
 * Pacing intent: floors 1-2 are short and gentle (no elites on 1), the
 * mid-run floors 4-5 are the widest and densest, and both boss floors (3, 6)
 * are shorter approaches — the floor is the walk-up, the boss is the budget.
 *
 * THE CAMP (roster-and-persistence.md §4) enters from floor 3, and it is
 * paid for ENTIRELY out of `rest`. That is deliberate and it is measured: a
 * camp is a warm spot that asks a question instead of handing out a nap, so
 * it replaces warm spots, never fights. Floors 4-6 then swap their guaranteed
 * REST for a guaranteed CAMP rather than adding one on top — the deep floors
 * give you a fire, not a free heal.
 *
 * Why so carefully: the scripted-run harness (tests/support/scriptedRun.ts,
 * 200 seeds, floors 1-6) clears 53.5% of runs without the camp. Adding a
 * camp as an EXTRA guaranteed node takes that to 61-64%, because a guarantee
 * displaces a fight and the party simply fights less. Taking the weight out
 * of `rest` and swapping the guarantee instead lands at 54.5% — inside the
 * noise, which is what "texture, not a difficulty spike" has to mean.
 *
 * Floors 1-2 have no camp at all: the party is two cats who have not done
 * anything worth talking about yet, and floor 1 is four columns long — a fire
 * there would be the first thing the game ever showed.
 *
 * XP_TO_LEVEL / LEVEL_CAP per classes.md §8.
 */
import type { EnemyId, FloorConfig, Stats } from "../core/types.js";

const T1: EnemyId[] = ["ratThug", "sewerBat", "dustBunny", "crowShaman"];
const T2: EnemyId[] = ["roombaScout", "sprinklerImp", "yarnGolem"];
const T3: EnemyId[] = ["porcelainHound", "laserGhost", "trashPanda"];

/* ------------------------------------------------------------------------ */
/* Enemy stat growth curve (balance-and-meta.md §3)                          */
/* ------------------------------------------------------------------------ */

/**
 * One row of the per-floor enemy scaling curve. HP and ATK scale
 * MULTIPLICATIVELY (they are the two numbers the whole fight length hangs
 * on); DEF/SPD/CRT are flat ADDS, because a multiplier on a 0-2 stat is
 * noise. Applied by `core/combat/setup.ts` to `ENEMIES[id].stats` at battle
 * construction, rounded half up, clamped at ≥1 HP / ≥1 SPD / ≥0 elsewhere.
 */
export interface FloorCurveRow {
  hpMult: number;
  atkMult: number;
  defAdd: number;
  spdAdd: number;
  crtAdd: number;
}

/**
 * THE difficulty dial. Enemy stat blocks in `content/enemies.ts` are authored
 * once, at their tier's introduction strength (= floor 1 identity row); this
 * table is what makes a Rat Thug on floor 3 worth fighting and a Porcelain
 * Hound on floor 6 genuinely frightening. Retuning the whole run means
 * editing these six rows and nothing else — which is the point
 * (balance-and-meta.md §3: "an explicit curve rather than hand-typed
 * numbers").
 *
 * Bosses are EXCLUDED (setup.ts skips any `EnemyDef.boss`): their stat blocks
 * are authored per fight against the §11 flag set, and curving them would
 * silently rescale Poise-break pacing and the 50% phase threshold.
 *
 * Shape of the curve: floors 1-2 sit at or just above identity because the
 * party is only two cats there (§2); the ramp steepens from floor 3, where
 * the third cat and the first boss arrive together; floor 6 is the only row
 * that adds crit on top, so the Hollow Throne's trash can actually spike.
 *
 * RETUNED for enemy intel (balance-and-meta.md §3.3). Declared intents cost
 * the enemy AI real decision quality — it commits at round start and cannot
 * react to a kill or a shove inside the round — and weaknesses handed the
 * party a damage bonus with no symmetric enemy gain. Together those two
 * features moved clear rate up by 2-14pp per floor. The rows below buy that
 * back so the shipped difficulty matches the §1.1 curve the balance pass
 * validated; DEF stays capped at +1 for the reason §3.1 records.
 */
export const ENEMY_CURVE: readonly FloorCurveRow[] = [
  { hpMult: 1.0, atkMult: 1.0, defAdd: 0, spdAdd: 0, crtAdd: 0 }, // 1
  { hpMult: 1.08, atkMult: 1.08, defAdd: 0, spdAdd: 0, crtAdd: 0 }, // 2
  { hpMult: 1.23, atkMult: 1.27, defAdd: 0, spdAdd: 0, crtAdd: 3 }, // 3
  { hpMult: 1.27, atkMult: 1.28, defAdd: 1, spdAdd: 0, crtAdd: 3 }, // 4
  { hpMult: 1.29, atkMult: 1.3, defAdd: 1, spdAdd: 1, crtAdd: 5 }, // 5
  { hpMult: 1.32, atkMult: 1.3, defAdd: 1, spdAdd: 1, crtAdd: 5 }, // 6
];

/** The curve row for a 1-based floor number; out-of-range clamps to the ends. */
export function floorCurve(floorNum: number): FloorCurveRow {
  const i = Math.min(ENEMY_CURVE.length - 1, Math.max(0, floorNum - 1));
  return ENEMY_CURVE[i];
}

/** Apply `floorCurve(floorNum)` to a raw enemy stat block (pure). */
export function curvedEnemyStats(base: Stats, floorNum: number): Stats {
  const c = floorCurve(floorNum);
  const r = (v: number): number => Math.floor(v + 0.5); // round half up
  return {
    hp: Math.max(1, r(base.hp * c.hpMult)),
    atk: Math.max(0, r(base.atk * c.atkMult)),
    def: Math.max(0, base.def + c.defAdd),
    spd: Math.max(1, base.spd + c.spdAdd),
    crt: Math.max(0, base.crt + c.crtAdd),
    enMax: base.enMax,
  };
}

export const FLOORS: FloorConfig[] = [
  {
    name: "The Cellar",
    pool: [...T1],
    budgetLo: 2,
    budgetHi: 4,
    map: {
      columnsLo: 4,
      columnsHi: 5,
      rowsLo: 2,
      rowsHi: 3,
      weights: { fight: 50, event: 22, treasure: 14, shop: 7, rest: 7 },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Drains",
    pool: [...T1],
    budgetLo: 4,
    budgetHi: 5,
    map: {
      columnsLo: 5,
      columnsHi: 6,
      rowsLo: 2,
      rowsHi: 3,
      weights: {
        fight: 44,
        elite: 8,
        event: 20,
        treasure: 13,
        shop: 7,
        rest: 8,
      },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Appliance Graveyard",
    pool: [...T1, ...T2],
    budgetLo: 5,
    budgetHi: 7,
    boss: { bossId: "vacuumKing", encounter: ["vacuumKing"] },
    map: {
      columnsLo: 4,
      columnsHi: 5,
      rowsLo: 2,
      rowsHi: 3,
      weights: {
        fight: 40,
        elite: 10,
        event: 18,
        treasure: 14,
        shop: 8,
        rest: 4,
        camp: 6,
      },
      guaranteed: ["shop", "rest"],
    },
  },
  {
    name: "The Undergarden",
    pool: [...T2],
    budgetLo: 6,
    budgetHi: 7,
    map: {
      columnsLo: 6,
      columnsHi: 7,
      rowsLo: 2,
      rowsHi: 4,
      weights: {
        fight: 40,
        elite: 12,
        event: 18,
        treasure: 13,
        shop: 8,
        rest: 2,
        camp: 7,
      },
      guaranteed: ["shop", "camp"],
    },
  },
  {
    name: "The Cold Pantry",
    pool: [...T2, ...T3],
    budgetLo: 6,
    budgetHi: 8,
    map: {
      columnsLo: 6,
      columnsHi: 7,
      rowsLo: 2,
      rowsHi: 4,
      weights: {
        fight: 38,
        elite: 14,
        event: 17,
        treasure: 13,
        shop: 8,
        rest: 3,
        camp: 7,
      },
      guaranteed: ["shop", "camp"],
    },
  },
  {
    name: "The Hollow Throne",
    pool: [...T3],
    budgetLo: 7,
    budgetHi: 9,
    boss: { bossId: "dogfather", encounter: ["dogfather", "porcelainHound"] },
    map: {
      columnsLo: 5,
      columnsHi: 6,
      rowsLo: 2,
      rowsHi: 3,
      weights: {
        fight: 36,
        elite: 16,
        event: 16,
        treasure: 12,
        shop: 9,
        rest: 3,
        camp: 8,
      },
      guaranteed: ["shop", "camp"],
    },
  },
];

export const XP_TO_LEVEL = [0, 30, 70, 130, 210, 310, 430, 570]; // index = level-1
export const LEVEL_CAP = 8;
