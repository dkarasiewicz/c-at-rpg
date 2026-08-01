/**
 * c(at)rpg — event selection (events.md §2.1, ARCHITECTURE.md WP-06).
 *
 * Pure: the caller creates `eventRng = mulberry32(eventSeed)` at the boundary
 * (eventSeed = hash(runSeed, floor, 'event', eventIndex), GDD §8 ruling) and
 * passes it down. Selection consumes EXACTLY one draw (events.md §2.2 draw #1);
 * the empty-pool fallback consumes zero draws.
 */
import type { GameEvent, Rng } from "../types.js";
import { pickWeighted } from "../util.js";
import {
  pickDreamed,
  filterDreamed,
  type DreamedChoice,
  type DreamedOrigin,
} from "../loot/dreamed.js";

/** Result of stepping on an event tile: an event to show, or the guard fallback. */
export type EventSelection =
  | {
      kind: "event";
      event: GameEvent;
      /** Present when the card came out of the shared pool, not the box. */
      dreamed?: DreamedOrigin;
    }
  | { kind: "fallback"; shinies: number; text: string };

/**
 * Pool filter per events.md §2.1: floor range inclusive, `once` events gone
 * for the run once fired, no repeats of any event on a single floor.
 */
export function eligibleEvents(
  events: readonly GameEvent[],
  floorNum: number,
  firedEventIds: readonly string[],
  floorFiredEventIds: readonly string[],
): GameEvent[] {
  return events.filter(
    (e) =>
      floorNum >= e.floors[0] &&
      floorNum <= e.floors[1] &&
      !(e.once && firedEventIds.includes(e.id)) &&
      !floorFiredEventIds.includes(e.id),
  );
}

/**
 * Which event fires on this tile. Weighted pick over the candidate pool by
 * `e.weight` — one d100-style cumulative draw (core/util.pickWeighted).
 *
 * If the pool is somehow empty (impossible with the shipped 10-event pool,
 * but guarded anyway): the tile silently converts into `15 + 8·floor`
 * Shinies and is consumed — no rng draw. The caller applies the shinies and
 * consumes the tile.
 */
export function selectEvent(
  events: readonly GameEvent[],
  floorNum: number,
  firedEventIds: readonly string[],
  floorFiredEventIds: readonly string[],
  rng: Rng,
  /**
   * THE DREAMING: event cards from the shared pool, each already re-linted by
   * `services/pool.ts` with the SAME `core/events/validate` invariants the
   * shipped cards pass. They are held to the §2.1 pool filter here too — a
   * dreamed card obeys its own floor band, `once`, and the no-repeat rule
   * exactly like an authored one.
   *
   * Omitted or empty ⇒ zero extra draws and the authored selection verbatim.
   */
  dreamed?: DreamedChoice<GameEvent>,
): EventSelection {
  // Pool-first, BEFORE the authored weighted pick: a hit skips that draw
  // entirely rather than burning it (events.md §2.2 draw #1 is whichever
  // pick actually happens).
  const dream = pickDreamed(
    rng,
    filterDreamed(
      dreamed,
      (e) =>
        floorNum >= e.floors[0] &&
        floorNum <= e.floors[1] &&
        !(e.once && firedEventIds.includes(e.id)) &&
        !floorFiredEventIds.includes(e.id),
    ),
  );
  if (dream) {
    return { kind: "event", event: dream.value, dreamed: dream.origin };
  }
  const pool = eligibleEvents(
    events,
    floorNum,
    firedEventIds,
    floorFiredEventIds,
  );
  if (pool.length === 0) {
    return {
      kind: "fallback",
      shinies: 15 + 8 * floorNum,
      text: "You find a shiny where something stranger should have been.",
    };
  }
  const event = pickWeighted(rng, pool, (e) => e.weight); // eventRng draw #1
  return { kind: "event", event };
}
