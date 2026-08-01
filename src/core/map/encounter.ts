/**
 * c(at)rpg — what a run-map node CONTAINS (docs/design/run-map-and-dm.md §2).
 *
 * The graph says where the choices are; this says what walking into one costs.
 * Pack composition is the algorithm the tile dungeon used (dungeon.md §7.3,
 * kept verbatim so combat's damage math never drifts) — only the stream
 * changed: it now runs off the node's OWN payload seed
 * (`mulberry32(node.seed)`), a fresh stream per node, so what a node holds
 * never depends on the order the party visits nodes in.
 *
 * Difficulty still scales through exactly three authored knobs, all in
 * `content/floors.ts`: the species `pool`, the per-pack threat budget
 * (`budgetLo`/`budgetHi`), and — new — the node-type mix.
 */
import type { EnemyDef, EnemyId, FloorConfig, MapNode, Rng } from "../types.js";
import { mulberry32 } from "../rng.js";
import {
  pickDreamed,
  type DreamedChoice,
  type DreamedOrigin,
} from "../loot/dreamed.js";
import { ENEMIES } from "../../content/enemies.js";

/** Combat's enemy rank cap (combat.md §1). */
export const MAX_PACK = 5;

/** An elite node is a normal pack with this much more threat to spend. */
export const ELITE_BUDGET_BONUS = 3;

/**
 * Roll one front-to-back encounter array (dungeon.md §7.3, verbatim):
 * 1 budget roll, then 1 roll per affordable pick, minimum two bodies, sorted
 * front-row species first in pick order.
 */
export function rollPack(
  rng: Rng,
  pool: readonly EnemyId[],
  budgetLo: number,
  budgetHi: number,
): EnemyId[] {
  let budget = rng.int(budgetLo, budgetHi);
  const picks: EnemyId[] = [];
  while (budget > 0 && picks.length < MAX_PACK) {
    const afford = pool.filter((id) => ENEMIES[id].threat <= budget);
    if (afford.length === 0) break;
    const pick = afford[rng.int(0, afford.length - 1)];
    picks.push(pick);
    budget -= ENEMIES[pick].threat;
  }
  if (picks.length < 2) {
    const cheapest = pool
      .slice()
      .sort((a, b) => ENEMIES[a].threat - ENEMIES[b].threat)[0];
    if (cheapest) picks.push(cheapest);
  }
  return [
    ...picks.filter((id) => ENEMIES[id].row === "front"),
    ...picks.filter((id) => ENEMIES[id].row !== "front"),
  ];
}

/**
 * The encounter a node hands to `createBattle`, or `null` when the node is
 * not a fight at all (event / shop / rest / treasure — those run on their own
 * authored content). Deterministic from the node's payload seed.
 */
export function encounterFor(
  node: MapNode,
  cfg: FloorConfig,
  /**
   * THE DREAMING: enemies other people's runs put in the shared pool, already
   * validated and registered by `services/pool.ts` and already narrowed to
   * this floor's band. Omitted or empty ⇒ this function is byte-identical to
   * the authored one, down to the rng stream position.
   *
   * A BOSS NODE NEVER DREAMS. The boss is the floor's authored destination and
   * the whole difficulty curve is tuned against it.
   */
  dreamed?: DreamedChoice<EnemyDef>,
  /** Observer: which species joined from the pool, and which row it was. */
  onDreamed?: (id: EnemyId, origin: DreamedOrigin) => void,
): EnemyId[] | null {
  if (node.type === "boss") {
    return cfg.boss ? cfg.boss.encounter.slice() : null;
  }
  if (node.type !== "fight" && node.type !== "elite") return null;
  const bonus = node.type === "elite" ? ELITE_BUDGET_BONUS : 0;
  const rng = mulberry32(node.seed);
  const pack = rollPack(
    rng,
    cfg.pool,
    cfg.budgetLo + bonus,
    cfg.budgetHi + bonus,
  );
  // A dream JOINS the pack rather than replacing it wholesale: one body in
  // five is a stranger, so the floor still reads as its own floor. It takes a
  // free slot when the pack is under the rank cap and otherwise displaces the
  // LAST pick — never the first, because the front rank is what the party's
  // opening turn is aimed at.
  const dream = pickDreamed(rng, dreamed);
  if (dream) {
    const id = dream.value.id;
    if (pack.length < MAX_PACK) pack.push(id);
    else pack[pack.length - 1] = id;
    onDreamed?.(id, dream.origin);
    // Re-apply the §7.3 formation rule so a dreamed front-row body does not
    // end up standing behind the pack it joined.
    return [
      ...pack.filter((p) => ENEMIES[p]?.row === "front"),
      ...pack.filter((p) => ENEMIES[p]?.row !== "front"),
    ];
  }
  return pack;
}

/**
 * The battle RNG stream key for a node fight. ARCHITECTURE.md §4 keys the
 * battle stream `hash(runSeed, floor, encounterIndex)`; on a run map the
 * encounter index IS the node id (event fights keep the `1000 + id`
 * convention the event scene already uses).
 */
export function encounterIndexOf(node: MapNode): number {
  return node.id;
}
