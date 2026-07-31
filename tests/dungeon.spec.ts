/**
 * WP-04 dungeon engine tests (ARCHITECTURE.md §5 WP-04).
 *
 * Gate: the dungeon.md §13 MEOW-1987 floor-1 fixture — grid, rooms, chests,
 * events, roamers, packs, and encounterIndex assignment reproduce EXACTLY.
 * Plus: boss-floor geometry, visibility (Chebyshev-3 + Bresenham + room
 * light), the step loop, the roamer FSM, and the zero-runtime-RNG contract.
 */
import { describe, expect, it, vi } from "vitest";
import { generateFloor } from "../src/core/dungeon/gen.js";
import {
  bfsFlood,
  computeVisible,
  idx,
  los,
  recomputeVisibility,
} from "../src/core/dungeon/floor.js";
import {
  applyFlee,
  applyVictory,
  contactCheck,
  step,
} from "../src/core/dungeon/step.js";
import { advanceRoamers } from "../src/core/dungeon/roamers.js";
import { hash } from "../src/core/rng.js";
import { FLOORS } from "../src/content/floors.js";
import type {
  Entity,
  FloorConfig,
  FloorState,
  Roamer,
  Room,
} from "../src/core/types.js";
import { Tile } from "../src/core/types.js";

/* ---------------------------------------------------------------- helpers */

/** The dungeon.md §1 floor-1 config row — the §13 fixture was generated with
 *  it (3 chests / 2 events, vs the canonical GDD §6 table's 2/1). */
const DUNGEON_MD_F1: FloorConfig = {
  name: "dungeon.md §1 floor 1",
  w: 31,
  h: 21,
  roomAttempts: 40,
  roamers: 4,
  chests: 3,
  events: 2,
  pool: ["ratThug", "sewerBat", "dustBunny", "crowShaman"],
  budgetLo: 3,
  budgetHi: 4,
};

function render(f: FloorState): string {
  const rows: string[] = [];
  for (let y = 0; y < f.h; y++) {
    let row = "";
    for (let x = 0; x < f.w; x++) {
      const t = f.tiles[idx(f.w, x, y)];
      row +=
        t === Tile.Wall
          ? "#"
          : t === Tile.Door
            ? "+"
            : t === Tile.StairsUp
              ? "<"
              : t === Tile.StairsDown
                ? ">"
                : ".";
    }
    rows.push(row);
  }
  for (const e of f.entities) {
    if ((e.kind === "roamer" || e.kind === "boss") && e.dead) continue;
    const g =
      e.kind === "chest"
        ? "$"
        : e.kind === "event"
          ? "?"
          : String(e.encounterIndex);
    rows[e.y] = rows[e.y].slice(0, e.x) + g + rows[e.y].slice(e.x + 1);
  }
  return rows.join("\n");
}

/** Build a crafted FloorState from ASCII rows ('<' = stairs-up + party). */
function makeFloor(
  rows: string[],
  opts: { rooms?: Room[]; entities?: Entity[]; floor?: number } = {},
): FloorState {
  const h = rows.length;
  const w = rows[0].length;
  const tiles = new Uint8Array(w * h);
  let party = { x: 1, y: 1 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      tiles[idx(w, x, y)] =
        c === "#"
          ? Tile.Wall
          : c === "+"
            ? Tile.Door
            : c === "<"
              ? Tile.StairsUp
              : c === ">"
                ? Tile.StairsDown
                : Tile.Floor;
      if (c === "<") party = { x, y };
    }
  }
  return {
    floor: opts.floor ?? 1,
    w,
    h,
    tiles,
    rooms: opts.rooms ?? [],
    entranceRoomId: 0,
    exitRoomId: 0,
    entities: opts.entities ?? [],
    stairsLocked: false,
    explored: new Uint8Array(w * h),
    visible: new Set(),
    party,
    stepCount: 0,
  };
}

function mkRoamer(
  id: number,
  x: number,
  y: number,
  over: Partial<Roamer> = {},
): Roamer {
  return {
    kind: "roamer",
    id,
    x,
    y,
    encounterIndex: id + 1,
    enemies: ["ratThug", "ratThug"],
    homeRoom: 0,
    waypoints: [
      [x, y],
      [x, y],
      [x, y],
    ],
    wpIndex: 0,
    state: "patrol",
    stunnedFor: 0,
    lostSightFor: 0,
    dead: false,
    ...over,
  };
}

const chests = (f: FloorState) => f.entities.filter((e) => e.kind === "chest");
const events = (f: FloorState) => f.entities.filter((e) => e.kind === "event");
const roamers = (f: FloorState): Roamer[] =>
  f.entities.filter((e): e is Roamer => e.kind === "roamer");

/* -------------------------------------------- §13 fixture (the WP-04 gate) */

const FIXTURE_GRID = `###############################
###.....###...................#
###.....###.##############+##.#
###..<..###.#######.........#.#
###.....###.#######.........#.#
###.....#...#.....#.........#.#
###+###+#+###....$#......2..#.#
###.#.....###..$..+.........#.#
###.#.....###.....#.........#.#
###.#4....###.....#.........#.#
###.#....?+.#########+#######.#
###.#.....#...................#
###.#.....###+###.#########.###
#...#.....#.....#.###.....+.###
#.###+#####?....#.###.....#.###
#.+.......#.....#.###.....+.###
#$#.......#.....#.###..>..#.###
###.......#.....#.#.+..1..#.###
###.......#..3..#.#.#.....+.###
###.......#.....#...#.....#####
###############################`;

describe("dungeon.md §13 fixture — runSeed MEOW-1987, floor 1", () => {
  const f = generateFloor("MEOW-1987", 1, DUNGEON_MD_F1);

  it("reproduces the §13 grid + entity overlay exactly", () => {
    expect(render(f)).toBe(FIXTURE_GRID);
  });

  it("has the seven §13 rooms with the documented entrance/exit", () => {
    const rects = f.rooms.map((r) => [r.x, r.y, r.w, r.h]);
    expect(rects).toContainEqual([3, 1, 5, 5]); // entrance
    expect(rects).toContainEqual([5, 7, 5, 7]);
    expect(rects).toContainEqual([13, 5, 5, 5]); // treasure room
    expect(rects).toContainEqual([3, 15, 7, 5]);
    expect(rects).toContainEqual([19, 3, 9, 7]);
    expect(rects).toContainEqual([11, 13, 5, 7]);
    expect(rects).toContainEqual([21, 13, 5, 7]); // exit
    expect(f.rooms).toHaveLength(7);

    const entrance = f.rooms[f.entranceRoomId];
    expect([entrance.x, entrance.y]).toEqual([3, 1]);
    expect(f.tiles[idx(f.w, 5, 3)]).toBe(Tile.StairsUp);
    const exit = f.rooms[f.exitRoomId];
    expect([exit.x, exit.y]).toEqual([21, 13]);
    expect(f.tiles[idx(f.w, 23, 16)]).toBe(Tile.StairsDown);
    // §13: exit BFS distance 37 >= (31+21)/2
    const dist = bfsFlood(f.tiles, f.w, f.h, 5, 3);
    expect(dist[idx(f.w, 23, 16)]).toBe(37);
  });

  it("places the chests per §6.3 (surviving nook first, then fallbacks)", () => {
    const cs = chests(f);
    expect(cs.map((c) => [c.x, c.y])).toEqual([
      [1, 16], // the one surviving nook, deepest-first
      [15, 7], // fallback, treasure room (13,5)
      [17, 6], // fallback, treasure room (13,5)
    ]);
    for (const [i, c] of cs.entries()) {
      expect(c.lootTableId).toBe("chest_t1");
      expect(c.opened).toBe(false);
      expect(c.chestSeed).toBe(hash("MEOW-1987", 1, "loot", i));
    }
  });

  it("places the events per §6.4 with derived eventSeeds", () => {
    const evs = events(f);
    expect(evs.map((e) => [e.x, e.y])).toEqual([
      [9, 10],
      [11, 14],
    ]);
    for (const [i, e] of evs.entries()) {
      expect(e.used).toBe(false);
      expect(e.eventSeed).toBe(hash("MEOW-1987", 1, "event", i));
    }
  });

  it("places the four roamer packs of the §13 table exactly", () => {
    const rs = roamers(f);
    expect(
      rs.map((r) => ({
        pos: [r.x, r.y],
        encounterIndex: r.encounterIndex,
        enemies: r.enemies,
      })),
    ).toEqual([
      {
        pos: [23, 17],
        encounterIndex: 1,
        enemies: ["dustBunny", "dustBunny", "crowShaman"],
      },
      {
        pos: [25, 6],
        encounterIndex: 2,
        enemies: ["dustBunny", "sewerBat", "ratThug"],
      },
      {
        pos: [13, 18],
        encounterIndex: 3,
        enemies: ["sewerBat", "crowShaman"],
      },
      {
        pos: [5, 9],
        encounterIndex: 4,
        enemies: ["sewerBat", "ratThug", "crowShaman"],
      },
    ]);
    // waypoints: 3 each, inside the home room; fresh patrol state
    for (const r of rs) {
      const home = f.rooms[r.homeRoom];
      expect(r.waypoints).toHaveLength(3);
      for (const [wx, wy] of r.waypoints) {
        expect(wx).toBeGreaterThanOrEqual(home.x);
        expect(wx).toBeLessThan(home.x + home.w);
        expect(wy).toBeGreaterThanOrEqual(home.y);
        expect(wy).toBeLessThan(home.y + home.h);
      }
      expect(r.state).toBe("patrol");
      expect(r.dead).toBe(false);
    }
  });

  it("spawns the party on the stairs with the entrance room lit", () => {
    expect(f.party).toEqual({ x: 5, y: 3 });
    // room light: full rect [x-1, x+w] × [y-1, y+h] of the entrance room
    for (const [x, y] of [
      [2, 0],
      [8, 0],
      [2, 6],
      [8, 6],
      [5, 3],
    ]) {
      expect(f.visible.has(idx(f.w, x, y))).toBe(true);
      expect(f.explored[idx(f.w, x, y)]).toBe(1);
    }
    expect(f.stepCount).toBe(0);
    expect(f.stairsLocked).toBe(false);
  });

  it("is deterministic: same seed → deep-equal floor", () => {
    const g = generateFloor("MEOW-1987", 1, DUNGEON_MD_F1);
    expect(render(g)).toBe(render(f));
    expect(JSON.parse(JSON.stringify(g.entities))).toEqual(
      JSON.parse(JSON.stringify(f.entities)),
    );
    expect(Array.from(g.tiles)).toEqual(Array.from(f.tiles));
  });
});

/* ------------------------------------------------- canonical GDD §6 floors */

describe("canonical GDD §6 floors", () => {
  it("floor 1 (The Cellar) honors the canonical counts and §6 rules", () => {
    const f = generateFloor("MEOW-1987", 1, FLOORS[0]);
    expect(chests(f)).toHaveLength(2);
    expect(events(f)).toHaveLength(1);
    const rs = roamers(f);
    expect(rs).toHaveLength(4);
    const dist = bfsFlood(f.tiles, f.w, f.h, f.party.x, f.party.y);
    for (const [i, r] of rs.entries()) {
      expect(r.encounterIndex).toBe(i + 1); // 1..N in placement order
      expect(r.enemies.length).toBeGreaterThanOrEqual(2);
      expect(r.enemies.length).toBeLessThanOrEqual(5);
      for (const id of r.enemies) expect(FLOORS[0].pool).toContain(id);
      expect(dist[idx(f.w, r.x, r.y)]).toBeGreaterThanOrEqual(10);
    }
  });

  it("every floor × several seeds: connected, valid, fully populated", () => {
    for (const seed of ["MEOW-1987", "PURR-42", "sunbeam"]) {
      for (let n = 1; n <= 6; n++) {
        const cfg = FLOORS[n - 1];
        const f = generateFloor(seed, n, cfg);
        expect(f.rooms.length).toBeGreaterThanOrEqual(4);
        // full connectivity: every passable tile reachable from the entrance
        const dist = bfsFlood(f.tiles, f.w, f.h, f.party.x, f.party.y);
        for (let i = 0; i < f.tiles.length; i++) {
          if (f.tiles[i] !== Tile.Wall) {
            expect(dist[i]).toBeGreaterThanOrEqual(0);
          }
        }
        // exit distance floor (§5.6)
        let down = -1;
        for (let i = 0; i < f.tiles.length; i++) {
          if (f.tiles[i] === Tile.StairsDown) down = i;
        }
        expect(dist[down]).toBeGreaterThanOrEqual((cfg.w + cfg.h) / 2);
        expect(roamers(f)).toHaveLength(cfg.roamers);
        expect(events(f)).toHaveLength(cfg.events);
        expect(chests(f)).toHaveLength(cfg.chests + (cfg.boss ? 1 : 0));
        // max 2 roamers per room; fronts before backs in every pack
        const perRoom = new Map<number, number>();
        for (const r of roamers(f)) {
          perRoom.set(r.homeRoom, (perRoom.get(r.homeRoom) ?? 0) + 1);
        }
        for (const count of perRoom.values()) {
          expect(count).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

/* ------------------------------------------------------------- boss floors */

describe("boss floors (§8)", () => {
  const cfg = FLOORS[2]; // The Appliance Graveyard, 27×19, vacuumKing
  const f = generateFloor("MEOW-1987", 3, cfg);
  const lair = f.rooms[0];

  it("stamps the 11×7 lair as room 0 = exit room, stairs locked", () => {
    expect([lair.x, lair.y, lair.w, lair.h]).toEqual([27 - 12, 7, 11, 7]);
    expect(f.exitRoomId).toBe(lair.id);
    expect(f.stairsLocked).toBe(true);
    expect(f.tiles[idx(f.w, lair.x + 9, lair.y + 3)]).toBe(Tile.StairsDown);
  });

  it("gives the lair exactly one door, on its west wall", () => {
    const openings: [number, number][] = [];
    for (let y = lair.y - 1; y <= lair.y + lair.h; y++) {
      for (let x = lair.x - 1; x <= lair.x + lair.w; x++) {
        const onRim =
          x === lair.x - 1 ||
          x === lair.x + lair.w ||
          y === lair.y - 1 ||
          y === lair.y + lair.h;
        if (onRim && f.tiles[idx(f.w, x, y)] !== Tile.Wall) {
          openings.push([x, y]);
        }
      }
    }
    expect(openings).toEqual([[lair.x - 1, lair.y + 3]]);
    expect(f.tiles[idx(f.w, lair.x - 1, lair.y + 3)]).toBe(Tile.Door);
  });

  it("places the boss at lair center (encounterIndex 0) and the hoard chest", () => {
    const boss = f.entities.find((e) => e.kind === "boss") as Roamer;
    expect(boss).toBeTruthy();
    expect([boss.x, boss.y]).toEqual([lair.x + 5, lair.y + 3]);
    expect(boss.encounterIndex).toBe(0);
    expect(boss.enemies).toEqual(["vacuumKing"]);
    expect(boss.waypoints).toEqual([]); // landmark, never patrols
    const hoard = chests(f).find((c) => c.lootTableId === "boss_hoard");
    expect(hoard).toBeTruthy();
    expect([hoard!.x, hoard!.y]).toEqual([lair.x + 2, lair.y + 1]);
    // roamers never spawn in the lair (excluded instead of the exit)
    for (const r of roamers(f)) expect(r.homeRoom).not.toBe(lair.id);
  });

  it("triggers the boss battle on lair entry; victory unlocks the stairs", () => {
    const g = generateFloor("MEOW-1987", 3, cfg);
    for (const r of roamers(g)) r.dead = true; // isolate the boss
    g.party = { x: lair.x - 2, y: lair.y + 3 }; // corridor west of the door
    expect(step(g, "E").t).toBe("moved"); // onto the door — not a lair tile
    const trig = step(g, "E"); // first lair tile
    expect(trig).toEqual({
      t: "battle",
      roamerId: 0,
      encounterIndex: 0,
      enemies: ["vacuumKing"],
      isBoss: true,
    });
    expect(g.stairsLocked).toBe(true);

    applyVictory(g, 0);
    expect(g.stairsLocked).toBe(false);
    expect((g.entities[0] as Roamer).dead).toBe(true);
    // boss is gone: walking the lair is safe, stairs prompt unlocked
    let last = step(g, "E");
    for (let i = 0; i < 8; i++) last = step(g, "E");
    expect(g.party).toEqual({ x: lair.x + 9, y: lair.y + 3 });
    expect(last).toEqual({ t: "stairs", locked: false });
    // the landmark never moved (it is dead in place, not despawned)
    expect([g.entities[0].x, g.entities[0].y]).toEqual([
      lair.x + 5,
      lair.y + 3,
    ]);
  });
});

/* -------------------------------------------------------------- visibility */

describe("visibility (§10)", () => {
  it("whisker-light is Chebyshev radius 3 with LOS", () => {
    const f = makeFloor([
      "#########",
      "#.......#",
      "#.......#",
      "#.......#",
      "#...°...#".replace("°", "."),
      "#.......#",
      "#.......#",
      "#.......#",
      "#########",
    ]);
    f.party = { x: 4, y: 4 };
    const vis = computeVisible(f);
    expect(vis.size).toBe(49); // full 7×7 disc, nothing blocked
    expect(vis.has(idx(f.w, 1, 1))).toBe(true);
    expect(vis.has(idx(f.w, 0, 4))).toBe(false); // Chebyshev 4
  });

  it("walls block LOS strictly between; the wall itself stays visible", () => {
    const f = makeFloor(["#####", "#.#.#", "#####"]);
    f.party = { x: 1, y: 1 };
    const vis = computeVisible(f);
    expect(vis.has(idx(f.w, 2, 1))).toBe(true); // the blocker is lit
    expect(vis.has(idx(f.w, 3, 1))).toBe(false); // behind it is not
  });

  it("doors never block LOS", () => {
    const f = makeFloor(["#####", "#.+.#", "#####"]);
    f.party = { x: 1, y: 1 };
    expect(los(f.tiles, f.w, 1, 1, 3, 1)).toBe(true);
    expect(computeVisible(f).has(idx(f.w, 3, 1))).toBe(true);
  });

  it("room light reveals the whole room + rim from inside or its door", () => {
    const rows = [
      "#############",
      "#...........#",
      "#.#########.#",
      "#.#.......#.#",
      "#.+.......#.#",
      "#.#.......#.#",
      "#.#########.#",
      "#...........#",
      "#############",
    ];
    const room: Room = { id: 0, x: 3, y: 3, w: 7, h: 3 };
    // inside the room: far rim corner (Chebyshev 7) is lit
    const inside = makeFloor(rows, { rooms: [room] });
    inside.party = { x: 3, y: 4 };
    expect(computeVisible(inside).has(idx(inside.w, 10, 6))).toBe(true);
    // standing on the room's door tile also lights it
    const onDoor = makeFloor(rows, { rooms: [room] });
    onDoor.party = { x: 2, y: 4 };
    expect(computeVisible(onDoor).has(idx(onDoor.w, 10, 6))).toBe(true);
    // one tile further out (corridor, not the door): no room light
    const outside = makeFloor(rows, { rooms: [room] });
    outside.party = { x: 1, y: 4 };
    expect(computeVisible(outside).has(idx(outside.w, 10, 6))).toBe(false);
  });

  it("explored accumulates; visible is recomputed", () => {
    const f = makeFloor(["#####", "#<..#", "#####"]);
    recomputeVisibility(f);
    expect(f.explored[idx(f.w, 3, 1)]).toBe(1);
    f.party = { x: 3, y: 1 };
    recomputeVisibility(f);
    expect(f.explored[idx(f.w, 1, 1)]).toBe(1); // still remembered
    expect(f.visible.has(idx(f.w, 1, 1))).toBe(true);
  });
});

/* ---------------------------------------------------------------- step loop */

describe("step loop (§9.3)", () => {
  it("moves, bumps (no step consumed), and reports stairs", () => {
    const f = makeFloor(["#####", "#<.>#", "#####"]);
    expect(step(f, "N")).toEqual({ t: "bump" });
    expect(f.stepCount).toBe(0); // bump consumes NO step
    expect(f.party).toEqual({ x: 1, y: 1 });
    expect(step(f, "E")).toEqual({ t: "moved" });
    expect(f.stepCount).toBe(1);
    expect(step(f, "E")).toEqual({ t: "stairs", locked: false });
    f.party = { x: 2, y: 1 };
    f.stairsLocked = true;
    expect(step(f, "E")).toEqual({ t: "stairs", locked: true });
  });

  it("chest bump opens it, consumes the step, party stays put", () => {
    const f = makeFloor(["#####", "#<..#", "#####"], {
      entities: [
        {
          kind: "chest",
          id: 0,
          x: 2,
          y: 1,
          opened: false,
          lootTableId: "chest_t1",
          chestSeed: 123,
        },
      ],
    });
    expect(step(f, "E")).toEqual({ t: "chest", chestId: 0 });
    expect(f.party).toEqual({ x: 1, y: 1 });
    expect(f.entities[0].kind === "chest" && f.entities[0].opened).toBe(true);
    expect(f.stepCount).toBe(1);
    // opened chests are walkable from then on
    expect(step(f, "E")).toEqual({ t: "moved" });
    expect(f.party).toEqual({ x: 2, y: 1 });
  });

  it("event tile fires once and is consumed even after the trigger", () => {
    const f = makeFloor(["#####", "#<..#", "#####"], {
      entities: [
        { kind: "event", id: 0, x: 2, y: 1, used: false, eventSeed: 777 },
      ],
    });
    expect(step(f, "E")).toEqual({ t: "event", eventId: 0, eventSeed: 777 });
    const ev = f.entities[0];
    expect(ev.kind === "event" && ev.used).toBe(true);
    expect(step(f, "W")).toEqual({ t: "moved" });
    expect(step(f, "E")).toEqual({ t: "moved" }); // used: never fires again
  });

  it("contact at Manhattan ≤ 1 picks the lowest entity id; fights chain", () => {
    const f = makeFloor(["#####", "#...#", "#.<.#", "#####"], {
      entities: [mkRoamer(0, 1, 1), mkRoamer(1, 3, 1)],
    });
    const trig = step(f, "N"); // party → (2,1): both roamers adjacent
    expect(trig).toEqual({
      t: "battle",
      roamerId: 0,
      encounterIndex: 1,
      enemies: ["ratThug", "ratThug"],
      isBoss: false,
    });
    applyVictory(f, 0);
    // §14: the second pack triggers immediately after the battle
    expect(contactCheck(f)).toMatchObject({ t: "battle", roamerId: 1 });
    applyVictory(f, 1);
    expect(contactCheck(f)).toBeNull();
  });

  it("flee: party keeps its pre-contact tile, pack stunned 5 party-steps", () => {
    const f = makeFloor(["########", "#<.....#", "########"], {
      entities: [mkRoamer(0, 6, 1)],
    });
    // walk in place until the chaser makes contact
    const dirs = ["E", "W", "E", "W", "E"] as const;
    let trig;
    for (const d of dirs) trig = step(f, d);
    expect(trig).toMatchObject({ t: "battle", roamerId: 0 });
    const contactTile = { ...f.party };
    applyFlee(f, 0);
    const r = f.entities[0] as Roamer;
    expect(r.state).toBe("stunned");
    expect(r.stunnedFor).toBe(5);
    expect(f.party).toEqual(contactTile); // pre-contact tile kept
    // stunned: no movement, no contact trigger — the pity window
    const stunnedPos = { x: r.x, y: r.y };
    for (let i = 0; i < 4; i++) {
      expect(step(f, i % 2 === 0 ? "W" : "E").t).toBe("moved");
    }
    expect(r.stunnedFor).toBe(1);
    expect({ x: r.x, y: r.y }).toEqual(stunnedPos);
    expect(step(f, "W").t).toBe("moved"); // 5th step: stun expires
    expect(r.state).toBe("return");
  });
});

/* --------------------------------------------------------------- roamer FSM */

describe("roamer FSM (§12)", () => {
  it("patrol moves at half speed, desynced by (stepCount + id) % 2", () => {
    const corridor = [
      "########################",
      "#<.....................#",
      "########################",
    ];
    // id 0 → moves when stepCount is even (phase 3 runs pre-increment)
    const f0 = makeFloor(corridor, {
      entities: [
        mkRoamer(0, 15, 1, {
          waypoints: [
            [20, 1],
            [20, 1],
            [20, 1],
          ],
        }),
      ],
    });
    const xs0: number[] = [];
    for (const d of ["E", "W", "E", "W"] as const) {
      step(f0, d);
      xs0.push(f0.entities[0].x);
    }
    expect(xs0).toEqual([16, 16, 17, 17]);
    // id 1 → opposite parity
    const f1 = makeFloor(corridor, {
      entities: [
        {
          kind: "chest",
          id: 0,
          x: 22,
          y: 1,
          opened: true,
          lootTableId: "chest_t1",
          chestSeed: 0,
        },
        mkRoamer(1, 15, 1, {
          waypoints: [
            [20, 1],
            [20, 1],
            [20, 1],
          ],
        }),
      ],
    });
    const xs1: number[] = [];
    for (const d of ["E", "W", "E", "W"] as const) {
      step(f1, d);
      xs1.push(f1.entities[1].x);
    }
    expect(xs1).toEqual([15, 16, 16, 17]);
  });

  it("patrol cycles waypoints on arrival", () => {
    const f = makeFloor(
      [
        "########################",
        "#<.....................#",
        "########################",
      ],
      {
        entities: [
          mkRoamer(0, 19, 1, {
            waypoints: [
              [20, 1],
              [15, 1],
              [17, 1],
            ],
          }),
        ],
      },
    );
    advanceRoamers(f); // stepCount 0: half-speed tick for id 0
    const r = f.entities[0] as Roamer;
    expect([r.x, r.y]).toEqual([20, 1]);
    expect(r.wpIndex).toBe(1); // arrived → next waypoint
  });

  it("spots the party (Chebyshev ≤ 6 + LOS) and chases at full speed", () => {
    const f = makeFloor(["########", "#<.....#", "########"], {
      entities: [mkRoamer(0, 6, 1)],
    });
    const r = f.entities[0] as Roamer;
    step(f, "E"); // party (2,1), dist 4 → spotted: '!' (no move yet)
    expect(r.state).toBe("chase");
    expect([r.x, r.y]).toEqual([6, 1]);
    step(f, "W"); // full speed: moves EVERY step now
    expect([r.x, r.y]).toEqual([5, 1]);
    step(f, "E");
    expect([r.x, r.y]).toEqual([4, 1]);
    step(f, "W");
    expect([r.x, r.y]).toEqual([3, 1]);
    // next party step: roamer's path ends at the party tile (blocked — never
    // steps onto it), Manhattan 1 → contact
    expect(step(f, "E")).toMatchObject({ t: "battle", roamerId: 0 });
  });

  it("gives up after 6 consecutive lost-sight steps (blocked chaser waits)", () => {
    const f = makeFloor(
      [
        "#########",
        "#<......#",
        "####.####",
        "####.####",
        "####.####",
        "#########",
      ],
      {
        entities: [
          {
            kind: "chest",
            id: 0,
            x: 4,
            y: 3,
            opened: false,
            lootTableId: "chest_t1",
            chestSeed: 0,
          },
          mkRoamer(1, 4, 4, { state: "chase" }),
        ],
      },
    );
    const r = f.entities[1] as Roamer;
    for (let i = 1; i <= 5; i++) {
      advanceRoamers(f);
      expect(r.state).toBe("chase");
      expect(r.lostSightFor).toBe(i);
      expect([r.x, r.y]).toEqual([4, 4]); // chest blocks: stands still
    }
    advanceRoamers(f);
    expect(r.state).toBe("return"); // '?' — gave up
  });

  it("gives up when the BFS distance to the party exceeds 15", () => {
    const f = makeFloor(
      [
        "########################",
        "#<....................r#".replace("r", "."),
        "########################",
      ],
      { entities: [mkRoamer(0, 22, 1, { state: "chase" })] },
    );
    advanceRoamers(f); // dist 21 > 15
    expect((f.entities[0] as Roamer).state).toBe("return");
  });

  it("gives up when the party is unreachable", () => {
    const f = makeFloor(["########", "#<.#...#", "########"], {
      entities: [mkRoamer(0, 5, 1, { state: "chase" })],
    });
    advanceRoamers(f);
    expect((f.entities[0] as Roamer).state).toBe("return");
  });

  it("return walks home at half speed, then resumes patrol", () => {
    const f = makeFloor(
      [
        "########################",
        "#<.....................#",
        "########################",
      ],
      {
        entities: [
          mkRoamer(0, 18, 1, {
            state: "return",
            waypoints: [
              [20, 1],
              [21, 1],
              [22, 1],
            ],
          }),
        ],
      },
    );
    const r = f.entities[0] as Roamer;
    advanceRoamers(f); // tick (stepCount 0, id 0): 18 → 19
    expect([r.x, r.y]).toEqual([19, 1]);
    expect(r.state).toBe("return");
    f.stepCount = 2; // next half-speed tick
    advanceRoamers(f); // 19 → 20 = waypoints[0] → patrol
    expect([r.x, r.y]).toEqual([20, 1]);
    expect(r.state).toBe("patrol");
    expect(r.wpIndex).toBe(0);
  });

  it("roamers never walk onto stairs, entities, or the party", () => {
    // chaser with the only path to the party crossing a stairs tile: it waits
    const f = makeFloor(["#####", "#<>.#", "#####"], {
      entities: [mkRoamer(0, 3, 1, { state: "chase" })],
    });
    advanceRoamers(f);
    expect([f.entities[0].x, f.entities[0].y]).toEqual([3, 1]); // blocked
  });
});

/* --------------------------------------------------- zero runtime RNG (§14) */

describe("determinism contract (§14)", () => {
  it("exploration and roamer AI consume zero RNG at runtime", () => {
    const f = generateFloor("MEOW-1987", 1, FLOORS[0]);
    const spy = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("gameplay code consumed Math.random at runtime");
    });
    try {
      const dirs = ["E", "S", "W", "N", "E", "E", "S", "S"] as const;
      for (let i = 0; i < 200; i++) {
        const trig = step(f, dirs[i % dirs.length]);
        if (trig.t === "battle") applyFlee(f, trig.roamerId); // keep walking
      }
    } finally {
      spy.mockRestore();
    }
    expect(f.stepCount).toBeGreaterThan(0);
  });

  it("step API takes no Rng — same walk twice is bit-identical", () => {
    const walk = (): string => {
      const f = generateFloor("PURR-42", 2, FLOORS[1]);
      const dirs = ["S", "E", "E", "N", "W", "S", "S", "E"] as const;
      const log: string[] = [];
      for (let i = 0; i < 120; i++) {
        const trig = step(f, dirs[i % dirs.length]);
        log.push(trig.t);
        if (trig.t === "battle") applyFlee(f, trig.roamerId);
      }
      return JSON.stringify({ log, party: f.party, entities: f.entities });
    };
    expect(walk()).toBe(walk());
  });
});
