/**
 * c(at)rpg — dungeon floor helpers (ARCHITECTURE.md §1: core/dungeon/floor.ts).
 *
 * Tile index helpers, the shared BFS flood (FIFO, neighbor order N, E, S, W —
 * dungeon.md §2/§5.5), Bresenham line of sight, and the visibility recompute
 * (whisker-light Chebyshev-3 + room light) per dungeon.md §10.
 *
 * Pure core: zero pixi, zero RNG — every function is deterministic.
 */
import { Tile } from "../types.js";
import type { FloorState, Room } from "../types.js";

/** Flat tile index: `y * w + x` (the FloorState contract). */
export const idx = (w: number, x: number, y: number): number => y * w + x;

/** True while (x, y) lies inside the w×h grid. */
export const inBounds = (w: number, h: number, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < w && y < h;

/**
 * The canonical 4-neighbor order **N, E, S, W** (dungeon.md §2, §5.5, §12).
 * Every BFS and every deterministic tie-break walks neighbors in this order.
 */
export const DIRS4: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Party-passable: everything except Wall (dungeon.md §3). */
export const isPassable = (t: number): boolean => t !== Tile.Wall;

/** Roamer-passable: Floor/Door only — never stairs (dungeon.md §12). */
export const isRoamerPassable = (t: number): boolean =>
  t === Tile.Floor || t === Tile.Door;

/**
 * BFS flood-fill distance field from (sx, sy): FIFO queue, neighbor order
 * N, E, S, W. Impassable / unreachable tiles get -1. The source tile always
 * gets 0 (even if its own tile type fails `passable` — e.g. a flood from the
 * party standing on stairs).
 */
export function bfsFlood(
  tiles: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  passable: (t: number) => boolean = isPassable,
): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const queue: number[] = [idx(w, sx, sy)];
  dist[queue[0]] = 0;
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(w, h, nx, ny)) continue;
      const ni = idx(w, nx, ny);
      if (dist[ni] !== -1 || !passable(tiles[ni])) continue;
      dist[ni] = dist[cur] + 1;
      queue.push(ni);
    }
  }
  return dist;
}

/**
 * Bresenham line of sight from tile (x0, y0) to tile (x1, y1) — dungeon.md
 * §10.1. `Wall` tiles STRICTLY BETWEEN the endpoints block; the target itself
 * may be a wall (it is visible, the light just does not propagate past it).
 * Doors never block LOS.
 */
export function los(
  tiles: Uint8Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    if (x === x1 && y === y1) return true; // endpoint: never tested as blocker
    if (tiles[idx(w, x, y)] === Tile.Wall) return false;
  }
}

/** Chebyshev radius of the party's whisker-light (dungeon.md §10.1). */
export const WHISKER_RADIUS = 3;

/** Does the party standing at (x, y) light room `r` (inside, or on one of its
 *  door tiles — a Door on the room's 1-tile wall rim)? dungeon.md §10.2. */
function lightsRoom(f: FloorState, r: Room): boolean {
  const { x, y } = f.party;
  if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  if (f.tiles[idx(f.w, x, y)] !== Tile.Door) return false;
  return x >= r.x - 1 && x <= r.x + r.w && y >= r.y - 1 && y <= r.y + r.h;
}

/**
 * Compute the visible set (dungeon.md §10): union of
 *  1. whisker-light — every tile within Chebyshev radius 3 of the party with
 *     Bresenham LOS from the party tile, and
 *  2. room light — the full rect `[R.x-1, R.x+R.w] × [R.y-1, R.y+R.h]`
 *     (interior + 1-tile wall rim incl. doors) of every room the party stands
 *     in or on a door of.
 */
export function computeVisible(f: FloorState): Set<number> {
  const vis = new Set<number>();
  const { x: px, y: py } = f.party;
  for (let dy = -WHISKER_RADIUS; dy <= WHISKER_RADIUS; dy++) {
    for (let dx = -WHISKER_RADIUS; dx <= WHISKER_RADIUS; dx++) {
      const tx = px + dx;
      const ty = py + dy;
      if (!inBounds(f.w, f.h, tx, ty)) continue;
      if (los(f.tiles, f.w, px, py, tx, ty)) vis.add(idx(f.w, tx, ty));
    }
  }
  for (const r of f.rooms) {
    if (!lightsRoom(f, r)) continue;
    for (let y = Math.max(0, r.y - 1); y <= Math.min(f.h - 1, r.y + r.h); y++) {
      for (
        let x = Math.max(0, r.x - 1);
        x <= Math.min(f.w - 1, r.x + r.w);
        x++
      ) {
        vis.add(idx(f.w, x, y));
      }
    }
  }
  return vis;
}

/** Recompute `visible` after a step and accumulate it into `explored`. */
export function recomputeVisibility(f: FloorState): void {
  f.visible = computeVisible(f);
  for (const i of f.visible) f.explored[i] = 1;
}
