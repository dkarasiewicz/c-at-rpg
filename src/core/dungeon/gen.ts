/**
 * c(at)rpg — floor generation (ARCHITECTURE.md §1: core/dungeon/gen.ts).
 *
 * Nystrom-style "rooms in a maze" per dungeon.md §5, consumed strictly in
 * `genRng` roll order (rejected placements still burn their rolls):
 *   §5.1 room scatter (4 rolls per attempt) + boss-lair stamp
 *   §5.2 growing-tree maze flood (windy, newest-first)
 *   §5.3 connectors + Fisher-Yates shuffle + union-find spanning merge
 *        (+ EXTRA_DOOR_CHANCE loop doors; boss lair keeps ONE west door)
 *   §5.4 partial dead-end trimming (TRIM_PASSES live-grid sweeps)
 *   §5.6 validation & deterministic retry ('gen1'/'pop1', … stream suffixes)
 */
import { Tile } from "../types";
import type { FloorConfig, FloorState, Rng, Room } from "../types";
import { hash, mulberry32 } from "../rng";
import { shuffle } from "../util";
import { bfsFlood, idx } from "./floor";
import { populateFloor } from "./populate";

/* Fixed generator constants — dungeon.md §4 (not config knobs in v1). */
const ROOM_WS = [5, 7, 9] as const;
const ROOM_HS = [5, 7] as const;
const WINDINESS = 0.5;
const EXTRA_DOOR_CHANCE = 0.05;
const TRIM_PASSES = 3;
const MAX_RETRIES = 10;

/** Boss-lair geometry (dungeon.md §5.1/§8): 11×7, stamped before attempts. */
export const LAIR_W = 11;
export const LAIR_H = 7;
export const lairX = (w: number): number => w - 12;
export const lairY = (h: number): number => ((h - LAIR_H) >> 1) | 1;

/** Intermediate §5 output handed to populate (§6). */
export interface Layout {
  w: number;
  h: number;
  tiles: Uint8Array;
  rooms: Room[];
  /** Room-interior mask (1 = inside some room rect), used by trim & nooks. */
  inRoom: Uint8Array;
  /** Lair room id on boss floors, else null. */
  lairRoomId: number | null;
}

/**
 * §5.1–§5.4: carve the tile grid. Consumes `genRng` strictly in step order.
 */
export function buildLayout(cfg: FloorConfig, rng: Rng): Layout {
  const { w: W, h: H } = cfg;
  const tiles = new Uint8Array(W * H); // all Wall (= 0)
  const region = new Int32Array(W * H).fill(-1);
  const inRoom = new Uint8Array(W * H);
  const rooms: Room[] = [];
  const roomRegions = new Set<number>();
  let nextRegion = 0;

  const carveRoom = (x: number, y: number, w: number, h: number): number => {
    const id = rooms.length;
    const reg = nextRegion++;
    roomRegions.add(reg);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = idx(W, xx, yy);
        tiles[i] = Tile.Floor;
        region[i] = reg;
        inRoom[i] = 1;
      }
    }
    rooms.push({ id, x, y, w, h });
    return id;
  };

  /* --- §5.1 rooms (boss lair stamped first, region id 0) ---------------- */
  let lairRoomId: number | null = null;
  if (cfg.boss) lairRoomId = carveRoom(lairX(W), lairY(H), LAIR_W, LAIR_H);

  for (let a = 0; a < cfg.roomAttempts; a++) {
    // Exactly 4 rolls per attempt, consumed even on rejection.
    const w = ROOM_WS[rng.int(0, 2)];
    const h = ROOM_HS[rng.int(0, 1)];
    const x = 1 + 2 * rng.int(0, (W - w - 2) >> 1);
    const y = 1 + 2 * rng.int(0, (H - h - 2) >> 1);
    let ok = true;
    for (const r of rooms) {
      // Touch-or-overlap rejection on the inclusive rects [x, x+w]×[y, y+h].
      if (x <= r.x + r.w && r.x <= x + w && y <= r.y + r.h && r.y <= y + h) {
        ok = false;
        break;
      }
    }
    if (ok) carveRoom(x, y, w, h);
  }

  /* --- §5.2 maze flood (growing tree, windy, newest-first) -------------- */
  const DX = [0, 1, 0, -1]; // N, E, S, W
  const DY = [-1, 0, 1, 0];
  for (let sy = 1; sy < H; sy += 2) {
    for (let sx = 1; sx < W; sx += 2) {
      if (tiles[idx(W, sx, sy)] !== Tile.Wall) continue;
      const reg = nextRegion++;
      tiles[idx(W, sx, sy)] = Tile.Floor;
      region[idx(W, sx, sy)] = reg;
      const stack: [number, number][] = [[sx, sy]];
      let lastDir: number | null = null;
      while (stack.length > 0) {
        const [cx, cy] = stack[stack.length - 1];
        const cand: number[] = [];
        for (let d = 0; d < 4; d++) {
          const nx = cx + 2 * DX[d];
          const ny = cy + 2 * DY[d];
          if (nx < 1 || nx > W - 2 || ny < 1 || ny > H - 2) continue;
          if (tiles[idx(W, nx, ny)] === Tile.Wall) cand.push(d);
        }
        if (cand.length === 0) {
          stack.pop();
          lastDir = null;
          continue;
        }
        let dir: number;
        if (
          lastDir !== null &&
          cand.includes(lastDir) &&
          rng.float() < WINDINESS
        ) {
          dir = lastDir; // keep winding — 1 roll
        } else {
          dir = cand[rng.int(0, cand.length - 1)]; // 1 roll
        }
        const mx = cx + DX[dir];
        const my = cy + DY[dir];
        const fx = cx + 2 * DX[dir];
        const fy = cy + 2 * DY[dir];
        tiles[idx(W, mx, my)] = Tile.Floor;
        region[idx(W, mx, my)] = reg;
        tiles[idx(W, fx, fy)] = Tile.Floor;
        region[idx(W, fx, fy)] = reg;
        stack.push([fx, fy]);
        lastDir = dir;
      }
    }
  }

  /* --- §5.3 connectors + randomized spanning merge ---------------------- */
  interface Conn {
    x: number;
    y: number;
    a: number;
    b: number;
  }
  const conns: Conn[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (tiles[idx(W, x, y)] !== Tile.Wall) continue;
      const west = region[idx(W, x - 1, y)];
      const east = region[idx(W, x + 1, y)];
      const north = region[idx(W, x, y - 1)];
      const south = region[idx(W, x, y + 1)];
      if (west >= 0 && east >= 0 && west !== east) {
        conns.push({ x, y, a: west, b: east });
      } else if (north >= 0 && south >= 0 && north !== south) {
        conns.push({ x, y, a: north, b: south });
      }
    }
  }
  let order = shuffle(conns, rng); // int(0, i) per swap
  if (cfg.boss) {
    // Single west door: drop every lair-touching connector except the one at
    // (lairX-1, lairCenterY).
    const doorX = lairX(W) - 1;
    const doorY = lairY(H) + (LAIR_H >> 1);
    order = order.filter(
      (c) => !(c.a === 0 || c.b === 0) || (c.x === doorX && c.y === doorY),
    );
  }
  const parent = new Int32Array(nextRegion);
  for (let i = 0; i < nextRegion; i++) parent[i] = i;
  const find = (r: number): number => {
    let root = r;
    while (parent[root] !== root) root = parent[root];
    while (parent[r] !== root) {
      const next = parent[r];
      parent[r] = root;
      r = next;
    }
    return root;
  };
  for (const c of order) {
    const openAs = (): void => {
      tiles[idx(W, c.x, c.y)] =
        roomRegions.has(c.a) || roomRegions.has(c.b) ? Tile.Door : Tile.Floor;
    };
    const ra = find(c.a);
    const rb = find(c.b);
    if (ra !== rb) {
      parent[ra] = rb;
      openAs();
    } else {
      // Loop doors: 1 float() roll per already-merged connector.
      const roll = rng.float();
      if (roll < EXTRA_DOOR_CHANCE) {
        let doorAdjacent = false;
        for (let d = 0; d < 4; d++) {
          if (tiles[idx(W, c.x + DX[d], c.y + DY[d])] === Tile.Door) {
            doorAdjacent = true;
            break;
          }
        }
        if (!doorAdjacent) openAs();
      }
    }
  }

  /* --- §5.4 partial dead-end trimming (live grid, row-major) ------------ */
  for (let pass = 0; pass < TRIM_PASSES; pass++) {
    let changed = false;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = idx(W, x, y);
        if (tiles[i] === Tile.Wall || inRoom[i] === 1) continue;
        let walls = 0;
        for (let d = 0; d < 4; d++) {
          if (tiles[idx(W, x + DX[d], y + DY[d])] === Tile.Wall) walls++;
        }
        if (walls >= 3) {
          tiles[i] = Tile.Wall;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return { w: W, h: H, tiles, rooms, inRoom, lairRoomId };
}

/** §5.6 validation over a populated floor. */
function isValid(f: FloorState, cfg: FloorConfig): boolean {
  const minRooms = 4; // boss floors: lair + 3 — same count
  if (f.rooms.length < minRooms) return false;
  let up = -1;
  let down = -1;
  for (let i = 0; i < f.tiles.length; i++) {
    if (f.tiles[i] === Tile.StairsUp) up = i;
    else if (f.tiles[i] === Tile.StairsDown) down = i;
  }
  if (up < 0 || down < 0) return false;
  const dist = bfsFlood(f.tiles, f.w, f.h, up % f.w, (up - (up % f.w)) / f.w);
  return dist[down] >= (cfg.w + cfg.h) / 2; // unreachable = -1 fails too
}

/**
 * Generate + populate + validate one floor, with the §5.6 deterministic
 * retry ladder: streams `'gen'`/`'pop'`, then `'gen1'`/`'pop1'`, … capped at
 * 10 retries (then the last candidate is accepted).
 */
export function generateFloor(
  runSeed: string,
  floorNum: number,
  cfg: FloorConfig,
): FloorState {
  let last: FloorState | null = null;
  for (let r = 0; r <= MAX_RETRIES; r++) {
    const suffix = r === 0 ? "" : String(r);
    const genRng = mulberry32(hash(runSeed, floorNum, `gen${suffix}`));
    const popRng = mulberry32(hash(runSeed, floorNum, `pop${suffix}`));
    const layout = buildLayout(cfg, genRng);
    last = populateFloor(layout, cfg, runSeed, floorNum, popRng);
    if (isValid(last, cfg)) return last;
  }
  return last as FloorState;
}
