/**
 * c(at)rpg — roamer AI (ARCHITECTURE.md §1: core/dungeon/roamers.ts).
 *
 * dungeon.md §12: patrol / chase / return / stunned state machine, evaluated
 * in step-loop phase 3 in entity-id order. **Zero RNG** — deterministic BFS
 * with neighbor order N, E, S, W; one shared flood from the party's tile per
 * step serves every chaser. Bosses are landmarks and never act (§8.3).
 *
 * Movement legality: Floor/Door only — never stairs, chests, unused events,
 * other living roamers, or the party's tile. Blocked step = stand still.
 */
import type { FloorState, Roamer } from "../types.js";
import {
  DIRS4,
  bfsFlood,
  idx,
  inBounds,
  isRoamerPassable,
  los,
} from "./floor.js";

/** Chase acquisition range (Chebyshev, plus LOS) — dungeon.md §12. */
export const SIGHT_RANGE = 6;
/** Consecutive no-LOS chase steps before giving up. */
export const GIVE_UP_STEPS = 6;
/** BFS distance to the party beyond which a chaser gives up. */
export const GIVE_UP_DIST = 15;

/** canSee(party) = Chebyshev ≤ 6 AND Bresenham LOS (walls block, doors do not). */
export function canSeeParty(f: FloorState, r: Roamer): boolean {
  const dx = Math.abs(r.x - f.party.x);
  const dy = Math.abs(r.y - f.party.y);
  if (Math.max(dx, dy) > SIGHT_RANGE) return false;
  return los(f.tiles, f.w, r.x, r.y, f.party.x, f.party.y);
}

/** Half-speed desync: patrol/return movers act only on this tick (§9.3). */
export const halfSpeedTick = (f: FloorState, r: Roamer): boolean =>
  (f.stepCount + r.id) % 2 === 0;

/** Is (x, y) blocked for roamer movement (entities / party / terrain)? */
function blocked(f: FloorState, x: number, y: number): boolean {
  if (!inBounds(f.w, f.h, x, y)) return true;
  if (!isRoamerPassable(f.tiles[idx(f.w, x, y)])) return true;
  if (f.party.x === x && f.party.y === y) return true;
  for (const e of f.entities) {
    if (e.x !== x || e.y !== y) continue;
    if (e.kind === "chest") return true;
    if (e.kind === "event" && !e.used) return true;
    if ((e.kind === "roamer" || e.kind === "boss") && !e.dead) return true;
  }
  return false;
}

/**
 * Move `r` one BFS step down the given distance field (a flood computed FROM
 * the target, so a shortest path step is the first N,E,S,W neighbor with
 * `dist === here - 1`). If that intended tile is blocked, stand still.
 */
function stepAlong(f: FloorState, r: Roamer, dist: Int32Array): void {
  const here = dist[idx(f.w, r.x, r.y)];
  if (here <= 0) return; // at target, or unreachable from it
  for (const [dx, dy] of DIRS4) {
    const nx = r.x + dx;
    const ny = r.y + dy;
    if (!inBounds(f.w, f.h, nx, ny)) continue;
    if (dist[idx(f.w, nx, ny)] !== here - 1) continue;
    if (!blocked(f, nx, ny)) {
      r.x = nx;
      r.y = ny;
    }
    return; // blocked intended step = stand still ("blocking the corridor")
  }
}

/** Flood from an arbitrary target tile over roamer-passable terrain. */
const floodFrom = (f: FloorState, x: number, y: number): Int32Array =>
  bfsFlood(f.tiles, f.w, f.h, x, y, isRoamerPassable);

/**
 * Step-loop phase 3: advance every living roamer in entity-id order.
 * The party flood is computed at most once per call and shared (§12).
 */
export function advanceRoamers(f: FloorState): void {
  let partyFlood: Int32Array | null = null;
  const getPartyFlood = (): Int32Array =>
    (partyFlood ??= floodFrom(f, f.party.x, f.party.y));

  for (const e of f.entities) {
    if (e.kind !== "roamer" || e.dead) continue; // bosses never patrol/chase
    switch (e.state) {
      case "stunned": {
        e.stunnedFor--;
        if (e.stunnedFor <= 0) {
          e.stunnedFor = 0;
          e.state = "return";
        }
        break; // no movement, no contact while stunned
      }
      case "patrol": {
        if (canSeeParty(f, e)) {
          e.state = "chase";
          e.lostSightFor = 0;
          break; // '!' — starts chasing next step
        }
        if (halfSpeedTick(f, e) && e.waypoints.length > 0) {
          const [wx, wy] = e.waypoints[e.wpIndex];
          stepAlong(f, e, floodFrom(f, wx, wy));
          if (e.x === wx && e.y === wy) {
            e.wpIndex = (e.wpIndex + 1) % e.waypoints.length;
          }
        }
        break;
      }
      case "chase": {
        if (canSeeParty(f, e)) e.lostSightFor = 0;
        else e.lostSightFor++;
        const d = getPartyFlood()[idx(f.w, e.x, e.y)];
        if (e.lostSightFor >= GIVE_UP_STEPS || d < 0 || d > GIVE_UP_DIST) {
          e.state = "return"; // '?' — gives up
          break;
        }
        stepAlong(f, e, getPartyFlood()); // full speed: every step
        break;
      }
      case "return": {
        if (canSeeParty(f, e)) {
          e.state = "chase";
          e.lostSightFor = 0;
          break;
        }
        if (halfSpeedTick(f, e) && e.waypoints.length > 0) {
          const [wx, wy] = e.waypoints[0];
          stepAlong(f, e, floodFrom(f, wx, wy));
          if (e.x === wx && e.y === wy) {
            e.state = "patrol";
            e.wpIndex = 0;
          }
        }
        break;
      }
    }
  }
}
