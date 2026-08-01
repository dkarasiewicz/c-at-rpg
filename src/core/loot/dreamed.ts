/**
 * THE DREAMING, engine side — pool-first SELECTION (pure).
 *
 * `services/pool.ts` is the arrival gate: it fetches rows, re-lints every one
 * of them with the shipped validators and hands the survivors here as
 * `DreamedChoice`. Nothing in this file talks to the network, reads env, or
 * trusts a payload — by the time a `Dreamed<T>` exists it has already been
 * validated, so the engines can treat it exactly like authored content.
 *
 * ## The probability (docs/design/roster-and-persistence.md §5)
 *
 *   p = min(0.7, size / 200)
 *
 * where `size` is how many rows of that kind the pool holds for this floor —
 * the real total from the query, not the page of candidates the client
 * happens to be holding. An empty world therefore changes nothing, a world
 * with 66 dreams in it shows one about a third of the time, and a world with
 * 140+ is mostly other people's content. "The more you play, the more content
 * there is" is this line.
 *
 * ## The draw contract, which is load-bearing
 *
 * `pickDreamed` consumes **zero** rng draws when there is nothing to pick
 * (no candidates, or p = 0). That is not an optimisation, it is what keeps
 * the OFFLINE game byte-identical: `rollChest`, `selectEvent` and
 * `encounterFor` are seeded, deterministic, and covered by tests that assert
 * exact outputs. With no pool the streams must run exactly as they always
 * have — same draws, same order, same results. When a dream IS available the
 * gate costs one `float()` and a hit costs one more `int()`, both from the
 * caller's own stream, so a dreamed run is still perfectly replayable.
 */
import type { EnemyDef, EquipDef, GameEvent, Rng } from "../types.js";

/* ------------------------------------------------------------------------ */
/* Provenance                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Where a dreamed thing came from. Carried all the way to the screen: the
 * player is told when the world handed them something rather than the box
 * (`ui/scenes/*` render `dreamedTag`), and a smoke can quote `rowId` as
 * evidence that a specific `catrpg.content` row reached a player.
 */
export interface DreamedOrigin {
  /** The `catrpg.content.id` of the row — `<kind>:<ref>`, e.g. an item's id. */
  rowId: string;
  /** `dm:<reason>` / `generation-zero` / null when the row did not say. */
  provenance: string | null;
  /** True when a DM dreamed this during somebody's run (`dm:` provenance). */
  byStray: boolean;
}

/** A validated dreamed thing plus the row it came from. */
export interface Dreamed<T> {
  origin: DreamedOrigin;
  value: T;
}

export type DreamedEquip = Dreamed<EquipDef>;
export type DreamedEvent = Dreamed<GameEvent>;
export type DreamedEnemy = Dreamed<EnemyDef>;

/**
 * What a floor's backdrop row carries. Cosmetic by construction — a backdrop
 * dresses the floor (its name, and its picture when the row has art); it can
 * never change a map budget or a pack, so a poisoned one is a bad name and
 * nothing else.
 */
export interface DreamedBackdrop {
  id: string;
  name: string;
  floor: number;
  /** Public `catrpg-art` URL when the dream kept its picture. */
  artUrl: string | null;
}

/** The label shown beside dreamed content. One string, every scene. */
export function dreamedTag(origin: DreamedOrigin): string {
  return origin.byStray ? "dreamed by another stray" : "from the dreaming";
}

/* ------------------------------------------------------------------------ */
/* The roll                                                                  */
/* ------------------------------------------------------------------------ */

/** p never exceeds this: authored content always keeps most of the run. */
export const DREAM_P_MAX = 0.7;
/** Pool size that would reach p = 1 if it were not capped. */
export const DREAM_P_SCALE = 200;

/** `p = min(0.7, size/200)`, clamped to 0 for a missing/empty/absurd size. */
export function dreamedChance(poolSize: number): number {
  if (!Number.isFinite(poolSize) || poolSize <= 0) return 0;
  return Math.min(DREAM_P_MAX, poolSize / DREAM_P_SCALE);
}

/**
 * The candidates for one pool-first decision: rows already validated and
 * already narrowed to this floor, plus the TOTAL pool size that sets p.
 *
 * `candidates` is a page (the client holds a few dozen at most); `poolSize`
 * is the whole shared world, which is why p rises as other people play even
 * though the page does not grow.
 */
export interface DreamedChoice<T> {
  candidates: readonly Dreamed<T>[];
  poolSize: number;
}

/**
 * Roll the pool-first gate and, on a hit, pick one candidate uniformly.
 *
 * Draws, in order: `float()` for the gate, then `int()` for the pick. BOTH
 * are skipped entirely when there is nothing to pick — see the draw contract
 * in the module header.
 */
export function pickDreamed<T>(
  rng: Rng,
  choice: DreamedChoice<T> | undefined,
): Dreamed<T> | null {
  const candidates = choice?.candidates ?? [];
  if (candidates.length === 0) return null; // no draw
  const p = dreamedChance(choice?.poolSize ?? 0);
  if (p <= 0) return null; // no draw
  if (rng.float() >= p) return null; // gate draw only
  return candidates[rng.int(0, candidates.length - 1)];
}

/** Narrow a choice in place-preserving fashion; empty ⇒ no draw downstream. */
export function filterDreamed<T>(
  choice: DreamedChoice<T> | undefined,
  keep: (value: T) => boolean,
): DreamedChoice<T> | undefined {
  if (!choice || choice.candidates.length === 0) return undefined;
  const candidates = choice.candidates.filter((d) => keep(d.value));
  if (candidates.length === 0) return undefined;
  return { candidates, poolSize: choice.poolSize };
}
