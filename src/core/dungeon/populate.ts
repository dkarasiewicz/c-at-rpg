/**
 * c(at)rpg — floor population (ARCHITECTURE.md §1: core/dungeon/populate.ts).
 *
 * dungeon.md §6, consumed strictly in `popRng` roll order (rejected attempts
 * still burn their rolls):
 *   §6.1 entrance (no rolls)      §6.2 exit / boss lair (no rolls)
 *   §6.3 chests (nooks first, hoard chest on boss floors)
 *   §6.4 events                   §6.5 roamers + packs (§7.3 threat budget)
 *   §6.6 waypoints
 * Per-entity derived seeds (`chestSeed`/`eventSeed`) come from core/rng hash —
 * open/trigger order can never perturb any other stream.
 */
import { Tile } from "../types.js";
import type {
  EnemyDef,
  EnemyId,
  Entity,
  FloorConfig,
  FloorState,
  Rng,
  Roamer,
  Room,
} from "../types.js";
import { hash } from "../rng.js";
import { ENEMIES } from "../../content/enemies.js";
import { bfsFlood, idx, inBounds, recomputeVisibility } from "./floor.js";
import type { Layout } from "./gen.js";
import { LAIR_H } from "./gen.js";

type ChestTableId = "chest_t1" | "chest_t2" | "chest_t3" | "boss_hoard";

/** Chest tier by floor band (loot.md rarity bands f12/f34/f56). */
const chestTable = (floorNum: number): ChestTableId =>
  floorNum <= 2 ? "chest_t1" : floorNum <= 4 ? "chest_t2" : "chest_t3";

const roomCenter = (r: Room): [number, number] => [
  r.x + (r.w >> 1),
  r.y + (r.h >> 1),
];

/** §7.3 pack composition: 1 budget roll + 1 roll per pick; fronts then backs
 *  (stable pick order); minimum 2 (pad with the cheapest pool species). */
function rollPack(cfg: FloorConfig, rng: Rng): EnemyId[] {
  const pool: EnemyDef[] = cfg.pool.map((id) => ENEMIES[id]);
  let budget = rng.int(cfg.budgetLo, cfg.budgetHi);
  const picks: EnemyDef[] = [];
  while (budget > 0 && picks.length < 5) {
    const afford = pool.filter((s) => s.threat <= budget);
    if (afford.length === 0) break;
    const s = afford[rng.int(0, afford.length - 1)];
    picks.push(s);
    budget -= s.threat;
  }
  if (picks.length < 2) {
    let cheapest = pool[0];
    for (const s of pool) if (s.threat < cheapest.threat) cheapest = s;
    picks.push(cheapest);
  }
  return [
    ...picks.filter((s) => s.row === "front"),
    ...picks.filter((s) => s.row === "back"),
  ].map((s) => s.id);
}

/**
 * §6 population of a carved layout into a full FloorState.
 * Consumes `popRng` strictly in §6 order.
 */
export function populateFloor(
  layout: Layout,
  cfg: FloorConfig,
  runSeed: string,
  floorNum: number,
  rng: Rng,
): FloorState {
  const { w: W, h: H, tiles, rooms, inRoom } = layout;
  const entities: Entity[] = [];

  const occupied = (x: number, y: number): boolean => {
    const t = tiles[idx(W, x, y)];
    if (t === Tile.StairsUp || t === Tile.StairsDown) return true;
    return entities.some((e) => e.x === x && e.y === y);
  };

  /* --- §6.1 entrance (no rolls) ----------------------------------------- */
  const sorted = rooms.slice().sort((a, b) => {
    const [ax, ay] = roomCenter(a);
    const [bx, by] = roomCenter(b);
    return ax + ay - (bx + by) || a.id - b.id;
  });
  const entrance = sorted[0];
  const [ex, ey] = roomCenter(entrance);
  tiles[idx(W, ex, ey)] = Tile.StairsUp;
  const dist = bfsFlood(tiles, W, H, ex, ey);

  /* --- §6.2 exit / boss lair (no rolls) --------------------------------- */
  let exitRoom: Room;
  let stairsLocked = false;
  if (cfg.boss && layout.lairRoomId !== null) {
    exitRoom = rooms[layout.lairRoomId];
    const lcy = exitRoom.y + (LAIR_H >> 1);
    tiles[idx(W, exitRoom.x + 9, lcy)] = Tile.StairsDown;
    stairsLocked = true;
    const boss: Roamer = {
      kind: "boss",
      id: entities.length,
      x: exitRoom.x + (exitRoom.w >> 1),
      y: lcy,
      encounterIndex: 0,
      enemies: cfg.boss.encounter.slice(),
      homeRoom: exitRoom.id,
      waypoints: [], // bosses are landmarks — no patrol (§6.6/§8)
      wpIndex: 0,
      state: "patrol",
      stunnedFor: 0,
      lostSightFor: 0,
      dead: false,
    };
    entities.push(boss);
  } else {
    let best: Room = rooms[0];
    let bestDist = -2;
    for (const r of rooms) {
      const [cx, cy] = roomCenter(r);
      const d = dist[idx(W, cx, cy)];
      if (d > bestDist) {
        best = r;
        bestDist = d;
      }
    }
    exitRoom = best;
    const [cx, cy] = roomCenter(exitRoom);
    tiles[idx(W, cx, cy)] = Tile.StairsDown;
  }

  /* --- §6.3 chests ------------------------------------------------------ */
  let chestIndex = 0;
  const addChest = (x: number, y: number, table: ChestTableId): void => {
    entities.push({
      kind: "chest",
      id: entities.length,
      x,
      y,
      opened: false,
      lootTableId: table,
      chestSeed: hash(runSeed, floorNum, "loot", chestIndex++),
    });
  };
  // Boss floors: guaranteed hoard chest, before the nook pass (§8.5).
  if (cfg.boss && layout.lairRoomId !== null) {
    const lair = rooms[layout.lairRoomId];
    addChest(lair.x + 2, lair.y + 1, "boss_hoard");
  }
  const table = chestTable(floorNum);
  // Nooks: corridor Floor tiles with exactly 3 wall 4-neighbors, dist desc
  // (ties: row-major scan order). No rolls.
  const nooks: { x: number; y: number; d: number }[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = idx(W, x, y);
      if (tiles[i] !== Tile.Floor || inRoom[i] === 1) continue;
      let walls = 0;
      if (tiles[idx(W, x, y - 1)] === Tile.Wall) walls++;
      if (tiles[idx(W, x + 1, y)] === Tile.Wall) walls++;
      if (tiles[idx(W, x, y + 1)] === Tile.Wall) walls++;
      if (tiles[idx(W, x - 1, y)] === Tile.Wall) walls++;
      if (walls === 3) nooks.push({ x, y, d: dist[i] });
    }
  }
  nooks.sort((a, b) => b.d - a.d); // Array.sort is stable → row-major ties
  let placedChests = 0;
  for (const n of nooks) {
    if (placedChests >= cfg.chests) break;
    addChest(n.x, n.y, table);
    placedChests++;
  }
  // Fallback: room tiles — int(1, len-1) over the center-sorted room list
  // (entrance at index 0 excluded; exit NOT excluded). 3 rolls per attempt.
  for (
    let attempts = 0;
    placedChests < cfg.chests && attempts < 500;
    attempts++
  ) {
    const r = sorted[rng.int(1, sorted.length - 1)];
    const x = r.x + rng.int(0, r.w - 1);
    const y = r.y + rng.int(0, r.h - 1);
    if (occupied(x, y)) continue;
    let doorAdjacent = false;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      if (
        inBounds(W, H, x + dx, y + dy) &&
        tiles[idx(W, x + dx, y + dy)] === Tile.Door
      ) {
        doorAdjacent = true;
        break;
      }
    }
    if (doorAdjacent) continue;
    addChest(x, y, table);
    placedChests++;
  }

  /* --- §6.4 events ------------------------------------------------------ */
  const evCands = sorted.filter(
    (r) => r.id !== entrance.id && r.id !== exitRoom.id,
  );
  const roomsWithEvent = new Set<number>();
  let eventIndex = 0;
  for (
    let attempts = 0;
    eventIndex < cfg.events && attempts < 200 && evCands.length > 0;
    attempts++
  ) {
    const r = evCands[rng.int(0, evCands.length - 1)];
    const x = r.x + rng.int(0, r.w - 1);
    const y = r.y + rng.int(0, r.h - 1);
    if (roomsWithEvent.has(r.id) || occupied(x, y)) continue;
    entities.push({
      kind: "event",
      id: entities.length,
      x,
      y,
      used: false,
      eventSeed: hash(runSeed, floorNum, "event", eventIndex++),
    });
    roomsWithEvent.add(r.id);
  }

  /* --- §6.5 roamers + packs --------------------------------------------- */
  // Candidates: all rooms except the entrance; on boss floors the lair is
  // excluded instead of the exit (the lair IS the exit room). Max 2 per room.
  const roamCands = sorted.filter((r) =>
    cfg.boss
      ? r.id !== entrance.id && r.id !== layout.lairRoomId
      : r.id !== entrance.id,
  );
  const perRoom = new Map<number, number>();
  const roamers: Roamer[] = [];
  for (
    let attempts = 0;
    roamers.length < cfg.roamers && attempts < 500 && roamCands.length > 0;
    attempts++
  ) {
    const r = roamCands[rng.int(0, roamCands.length - 1)]; // 1 roll
    if ((perRoom.get(r.id) ?? 0) >= 2) continue; // room full → next attempt
    const x = r.x + rng.int(0, r.w - 1); // 2 rolls
    const y = r.y + rng.int(0, r.h - 1);
    if (occupied(x, y) || dist[idx(W, x, y)] < 10) continue;
    const enemies = rollPack(cfg, rng); // 1 budget roll + 1 per pick
    const roamer: Roamer = {
      kind: "roamer",
      id: entities.length,
      x,
      y,
      encounterIndex: roamers.length + 1,
      enemies,
      homeRoom: r.id,
      waypoints: [],
      wpIndex: 0,
      state: "patrol",
      stunnedFor: 0,
      lostSightFor: 0,
      dead: false,
    };
    entities.push(roamer);
    roamers.push(roamer);
    perRoom.set(r.id, (perRoom.get(r.id) ?? 0) + 1);
  }

  /* --- §6.6 waypoints (2 rolls each, occupancy irrelevant) -------------- */
  for (const rm of roamers) {
    const r = rooms[rm.homeRoom];
    for (let i = 0; i < 3; i++) {
      rm.waypoints.push([r.x + rng.int(0, r.w - 1), r.y + rng.int(0, r.h - 1)]);
    }
  }

  /* --- assemble --------------------------------------------------------- */
  const floor: FloorState = {
    floor: floorNum,
    w: W,
    h: H,
    tiles,
    rooms,
    entranceRoomId: entrance.id,
    exitRoomId: exitRoom.id,
    entities,
    stairsLocked,
    explored: new Uint8Array(W * H),
    visible: new Set(),
    party: { x: ex, y: ey },
    stepCount: 0,
  };
  recomputeVisibility(floor); // spawn room lit from step 0
  return floor;
}
