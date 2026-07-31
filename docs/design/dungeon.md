# c(at)rpg Dungeon Generation & Exploration — FINAL DESIGN
## "Whisker Maze" (rooms-in-a-maze, step-based exploration)

> ## ⚠️ SUPERSEDED — historical reference only
>
> **Replaced by [`run-map-and-dm.md`](run-map-and-dm.md) §2 (the run map).**
> The tile maze generated mostly-empty corridors, WASD travel added no
> decision, and the minimap was mostly blank. Each floor is now a small
> directed node graph — entry on the left, boss or stairs on the right, every
> step a choice between 2-3 routes, every node an encounter.
>
> **Gone from the codebase:** `src/core/dungeon/*` (gen, populate, floor,
> step, roamers), `tests/dungeon.spec.ts`, the `genRng`/`popRng` streams, and
> `FloorConfig`'s `w`/`h`/`roomAttempts`/`roamers`/`chests`/`events` columns.
> `FloorState`/`Tile`/`Room`/`Roamer`/`Entity`/`StepTrigger`/`FloorDelta` are
> gone from `core/types.ts` §2.7, which now holds the run-map contract
> (`NodeType`, `MapNode`, `MapEdge`, `FloorMap`, `FloorMapBudget`).
>
> **Still live, and still canonical, from this document:**
> - §2's RNG design (fnv1a + mulberry32, per-entity derived seeds) — the run
>   map just adds its own `mapRng` stream to the table;
> - §7.2's three difficulty knobs (species pool, threat budget, encounter
>   count) — `pool`/`budgetLo`/`budgetHi` are unchanged in `content/floors.ts`;
> - **§7.3's pack composition algorithm, verbatim**, now in
>   `src/core/map/encounter.ts` running off each node's payload seed;
> - the boss data and the floor table's names/pools/budgets/bosses (GDD §6).
>
> Everything below about grids, rooms, corridors, fog of war, LOS, roamer
> patrols, the step loop and the minimap describes a system that no longer
> exists. Read it for the pack/loot/difficulty rules only.

**Status: SUPERSEDED (was: FINAL — aligned to `docs/design/combat.md` "Claws &
Ranks: Nine Lives Edition").** This document was the source of truth for floor generation,
exploration, fog of war, roaming encounters, and per-floor difficulty. It produces
encounters in exactly the shape combat consumes (a front-to-back `string[]` of 1–5
enemy ids plus an `encounterIndex`), derives the battle RNG stream exactly as combat
§3 specifies (`mulberry32(hash(runSeed, floor, encounterIndex))`), and supplies the
marching order that combat §1 turns into cat ranks. The worked example in §13 is
**real output** of a reference implementation of §5–§6, reproducible from the seed.

Design pillars:

1. **Maze-like, not soup-like.** Rooms embedded in genuinely winding corridors
   (BSP corridor trees read like office floor plans). A few dead ends survive on
   purpose: they hold chests.
2. **Everything decided at generation time.** Layout, entity placement, pack
   compositions, and patrol waypoints are fixed the moment the floor generates.
   Exploration consumes **zero RNG at runtime** — same seed, same floor, regardless
   of play order. Loot and events use per-entity derived seeds, opened lazily.
3. **Visible danger.** Roaming enemy packs you can see, dodge, bait, or fight.
   No invisible random encounters, ever.
4. **Step-based world.** Rendering runs at 60 fps (tweens, pulsing fog, blinking
   minimap dot), but the simulation advances one discrete step per party move.
   Trivially deterministic, trivially fast.

---

## 1. Run Structure & Floor Progression

A run is **9 floors**, descending only (the way up collapses behind the party, so
only the current floor is ever in memory). **Every 3rd floor is a boss floor**
(3, 6, 9). Clearing floor 9's boss wins the run ("the party finds The Sunbeam").
This matches combat.md §14's content budget: ~10 regular enemies, 3 bosses, with
the Vacuum King on floor 3 exactly as combat §11 states.

| Floor | Grid W×H | roomAttempts | Roamers | Chests | Events | Species pool | Threat budget | Boss |
|---|---|---|---|---|---|---|---|---|
| 1 | 31×21 | 40 | 4 | 3 | 2 | T1 | 3–4 | — |
| 2 | 31×21 | 40 | 5 | 3 | 2 | T1 | 4–5 | — |
| 3 | 27×19 | 30 | 3 | 2 | 1 | T1 | 4–6 | **Vacuum King** |
| 4 | 35×23 | 55 | 5 | 4 | 2 | T1 ∪ T2 | 5–7 | — |
| 5 | 35×23 | 55 | 6 | 4 | 2 | T1 ∪ T2 | 6–8 | — |
| 6 | 29×19 | 35 | 4 | 3 | 1 | T2 | 7–9 | **The Laundromancer** |
| 7 | 39×25 | 70 | 6 | 5 | 2 | T2 ∪ T3 | 8–10 | — |
| 8 | 39×25 | 70 | 7 | 5 | 2 | T2 ∪ T3 | 9–11 | — |
| 9 | 31×21 | 40 | 5 | 3 | 1 | T3 | 10–12 | **The Dogfather** |

W and H are **always odd** (the algorithm requires it). Boss floors are smaller
with fewer roamers — the floor is an approach, the boss is the budget. This table
is a plain data array (`data/floors.ts`, shape in §4); adding floors later is a
data edit, not a redesign.

**Between floors:** party HP persists (combat §12 — attrition is real), but taking
the stairs is a catnap: each living cat heals `floor(0.25 * maxHp)` on descent.
Energy and all battle statuses are battle-scoped and already gone. Lives (Nine
Lives pips), inventory, and XP persist for the whole run and are **never** restored
by descending (a rare shrine *event* may restore one Life — events.md owns that,
per combat §12).

---

## 2. Seeded RNG Plumbing (exact)

One `runSeed` string (shown on the HUD, re-enterable to share runs). All streams
are `mulberry32` seeded via FNV-1a over `'|'`-joined parts — this file defines the
`hash` that combat §3 references:

```ts
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export const hash = (...parts: (string | number)[]) => fnv1a(parts.join('|'));

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    float() {                       // [0, 1)
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(lo: number, hi: number) {   // inclusive both ends
      return lo + Math.floor(this.float() * (hi - lo + 1));
    },
  };
}
```

Stream tree (r = validation retry counter, §5.6; normally 0 and omitted):

```
genRng      = mulberry32(hash(runSeed, floor, 'gen'))    // rooms, maze, connectors  ('gen1', 'gen2'… on retry)
popRng      = mulberry32(hash(runSeed, floor, 'pop'))    // chests, events, roamers, packs, waypoints
battleRng   = mulberry32(hash(runSeed, floor, encounterIndex))        // combat §3, verbatim
chestSeed   = hash(runSeed, floor, 'loot', chestIndex)                // drawn when opened (loot.md tables)
victorySeed = hash(runSeed, floor, 'loot', 100 + encounterIndex)      // post-battle loot screen
eventSeed   = hash(runSeed, floor, 'event', eventIndex)               // handed to events.md
```

**Roll-order contract:** `genRng` is consumed strictly in §5 step order, `popRng`
strictly in §6 order — rejected placement attempts still consume their rolls; that
is what keeps the streams stable. Exploration consumes **no** RNG: patrols follow
pre-rolled waypoints, chase pathing is deterministic BFS with neighbor order
**N, E, S, W** and FIFO queue. `encounterIndex` is **0 for the boss**, **1..N for
roamers** in placement order — so the first fight against any pack draws exactly
the stream combat §3 specifies. Re-engaging a fled-from pack reuses the same
stream from the start (deterministic, but it diverges as soon as the player acts
differently; enemy HP resets on flee, party HP does not).

---

## 3. Tile & Data Model

Only three tile types plus two stair markers — everything else is an entity
standing on a tile:

```ts
export const enum Tile { Wall = 0, Floor = 1, Door = 2, StairsUp = 3, StairsDown = 4 }
// Door: passable, never locked, purely a visual arch/frame. Does NOT block LOS.
// Wall: blocks movement and line of sight.
// StairsUp: scenery (spawn tile). StairsDown: descend prompt on step-on (§9.5).
```

```ts
interface Room { id: number; x: number; y: number; w: number; h: number }

interface FloorState {
  floor: number;                // 1..9
  w: number; h: number;
  tiles: Uint8Array;            // w*h, Tile, index = y*w + x
  rooms: Room[];
  entranceRoomId: number; exitRoomId: number;   // exitRoomId = lair on boss floors
  entities: Entity[];           // id = array index at creation
  stairsLocked: boolean;        // true on boss floors until the boss dies
  explored: Uint8Array;         // w*h, 0|1, accumulates
  visible: Set<number>;         // tile indices, recomputed after every step
  party: { x: number; y: number };
  stepCount: number;
}

type Entity =
  | { kind: 'chest';  id: number; x: number; y: number; opened: boolean;
      lootTableId: string; chestSeed: number }            // tables live in loot.md
  | { kind: 'event';  id: number; x: number; y: number; used: boolean;
      eventSeed: number }                                 // scenarios live in events.md
  | Roamer;

interface Roamer {
  kind: 'roamer' | 'boss';
  id: number; x: number; y: number;
  encounterIndex: number;             // 0 = boss, 1..N roamers (§2)
  enemies: string[];                  // front-to-back, 1..5 ids — combat §1's shape
  homeRoom: number;
  waypoints: [number, number][];      // 3 pre-rolled patrol targets in home room
  wpIndex: number;
  state: 'patrol' | 'chase' | 'return' | 'stunned';
  stunnedFor: number;                 // party-steps remaining (post-flee grace)
  lostSightFor: number;               // consecutive steps without LOS while chasing
  glyph: string;                      // 1 char on the blob: first letter of enemies[0]
}

interface FloorConfig {               // one row of the §1 table, data/floors.ts
  w: number; h: number; roomAttempts: number;
  roamers: number; chests: number; events: number;
  pool: SpeciesId[]; budgetLo: number; budgetHi: number;
  boss?: { bossId: string; encounter: string[] };   // encounter incl. escort minions
}
```

---

## 4. Recommended Algorithm: Rooms + Maze Flood + Connectors + Partial Trimming

**Chosen: the "rooms in a maze" generator** (Nystrom-style): scatter
non-overlapping odd-aligned rooms, flood every remaining gap with a windy perfect
maze, connect all regions with doors via a randomized spanning pass (plus a few
extra doors for loops), then trim most — not all — dead ends.

Rejected alternatives: **BSP rooms+corridors** (corridor trees, hallway feel, not
a maze — contradicts the pitch) and **cellular caves** (no rooms or doors; poor
fit for room lighting, boss lairs, and door-framed readability). Rooms-in-a-maze
gives rooms *and* genuine labyrinth, guarantees full connectivity by construction,
never needs backtracking, and is ~200 LoC.

Parity rule: rooms and maze cells live on **odd coordinates**; walls between them
on even ones. That is why W, H, room sizes, and room positions are all odd.

Fixed constants (not config knobs in v1):

| Constant | Value | Meaning |
|---|---|---|
| `ROOM_WS` / `ROOM_HS` | {5, 7, 9} / {5, 7} | room width/height candidates (tiles) |
| `WINDINESS` | 0.5 | chance the maze keeps its direction when it can |
| `EXTRA_DOOR_CHANCE` | 0.05 | loop doors beyond the spanning tree |
| `TRIM_PASSES` | 3 | dead-end erosion passes → stubs longer than 3 survive |

---

## 5. Generation, Step by Step (exact, in `genRng` roll order)

### 5.1 Rooms (rejection sampling) — `roomAttempts` iterations

Per attempt, exactly 4 rolls, consumed even on rejection:

1. `w = ROOM_WS[int(0,2)]`, `h = ROOM_HS[int(0,1)]`.
2. `x = 1 + 2*int(0, (W-w-2)>>1)`, `y = 1 + 2*int(0, (H-h-2)>>1)` (odd position).
3. If the rect `[x, x+w] × [y, y+h]` **touches or overlaps** any placed room rect
   (compare with `x <= r.x+r.w && r.x <= x+w && y <= r.y+r.h && r.y <= y+h`) →
   reject. Otherwise carve all tiles to `Floor`, record the `Room`, and assign a
   fresh **region id** to every carved tile.

On **boss floors only**, before the attempts, stamp the guaranteed **lair**: an
11×7 room at `x = W-12`, `y = ((H-7)>>1) | 1` (both provably odd), region id 0.
Random rooms reject against it like any other room. Typical yield: 6–8 rooms on
31×21, 10–14 on 39×25.

### 5.2 Maze flood (growing tree, windy)

For each odd cell `(x, y)` in row-major order still `Wall`: start a new **region**
and run growing-tree from it:

```
stack = [start]; carve start; lastDir = null
while stack not empty:
  cell = stack.top                       // newest-first → long winding halls
  cand = dirs [N,E,S,W] where cell+2*dir is in bounds and Wall
  if cand empty: pop; lastDir = null; continue
  if lastDir ∈ cand and float() < WINDINESS: dir = lastDir     // 1 roll
  else: dir = cand[int(0, len-1)]                               // 1 roll
  carve cell+dir and cell+2*dir into this region; push cell+2*dir; lastDir = dir
```

### 5.3 Connectors + randomized spanning merge

A **connector** is an interior wall tile whose W/E or N/S neighbors are carved
and belong to two different regions. Collect all connectors (row-major scan),
Fisher-Yates shuffle the list with `genRng` (`int(0, i)` per swap), then walk it
once with union-find over region ids:

- Regions not yet merged → **open** the connector (merge the regions). Tile
  becomes `Door` if either side belongs to a room region, else `Floor`
  (corridor-to-corridor junction).
- Regions already merged → with probability `EXTRA_DOOR_CHANCE` (1 `float()`
  roll), and only if no 4-neighbor is already a `Door`, open it anyway. These
  extra openings create **loops** — without them the floor is a tree and chases
  can corner you unfairly.

On **boss floors**, before the walk, delete every connector touching the lair
region except the one at `(lairX-1, lairCenterY)` — the lair gets exactly one
door, on its west wall.

### 5.4 Partial dead-end trimming

Exactly `TRIM_PASSES` passes (early-exit if a pass changes nothing). Each pass
sweeps the interior row-major over the **live** grid (mutations are visible
within the same pass — this is intentional and part of the spec): every passable
tile that is **not inside a room** and has **≥ 3 wall 4-neighbors** becomes
`Wall`. `Door` tiles are trimmed by the same rule.

Removing a degree-1 tile can never disconnect a connected graph, so connectivity
survives trimming unconditionally. Result: most maze fuzz is gone, corridors
between rooms stay windy, and dead-end stubs longer than 3 tiles survive as
cul-de-sac **nooks** — prime chest real estate (§6.3).

### 5.5 Distance field

BFS from the entrance stair tile (§6.1) over passable tiles, neighbor order
N, E, S, W, FIFO queue. This `dist` field drives exit choice, chest ordering, and
roamer eligibility, and is discarded after population.

### 5.6 Validation & deterministic retry

After population, assert: `rooms.length >= 4` (boss floors: lair + 3), the exit
stair is reachable, and `dist(exitStair) >= (W + H) / 2` (no trivially short
floors). On failure regenerate the whole floor with stream ids `'gen1'`/`'pop1'`,
then `'gen2'`/`'pop2'`, … (retry counter appended; plain `'gen'`/`'pop'` is
retry 0). Cap at 10 retries then accept the last candidate (never observed; the
cap only guarantees termination).

---

## 6. Population (exact, in `popRng` roll order)

### 6.1 Entrance *(no rolls)*

`entranceRoom` = the room whose center `(r.x + (r.w>>1), r.y + (r.h>>1))`
minimizes `cx + cy` (ties: lower room id). Its center tile becomes `StairsUp`;
the party spawns on it. Compute the §5.5 distance field from here.

### 6.2 Exit *(no rolls)*

Normal floors: `exitRoom` = the room whose center has the greatest BFS distance
from the entrance stair (ties: lower id); its center tile becomes `StairsDown`.
Boss floors: the lair is the exit room — `StairsDown` at `(lairX+9, lairCenterY)`
(the far east end), the **boss entity** at the lair center, and
`stairsLocked = true` until the boss dies. Boss `encounterIndex = 0`.

### 6.3 Chests — `chestCount` from §1

1. Collect all **nooks**: corridor `Floor` tiles with exactly 3 wall neighbors
   (post-trim, not in any room), sorted by `dist` descending (ties: row-major
   scan order). Place chests on nooks first, deepest first *(no rolls)* — dead
   ends must pay.
2. If nooks run out, loop (≤ 500 attempts, 3 rolls each — room `int(1, len-1)`
   over the center-sorted room list which excludes the entrance room at index 0,
   then `x = r.x + int(0, r.w-1)`, `y = r.y + int(0, r.h-1)`): accept if the
   tile is unoccupied and not 4-adjacent to a `Door`. The exit room is *not*
   excluded — a chest by the stairs is a guarded treat.

Each chest stores `lootTableId` (`'chest_t1'` | `'chest_t2'` | `'chest_t3'` by
floor tier — tables and weights live in loot.md) and its `chestSeed` (§2).
Contents are drawn from `mulberry32(chestSeed)` at open time: deterministic,
savescum-proof, and zero `popRng` draws.

### 6.4 Events — `eventCount` from §1

Candidate rooms: all except entrance and exit rooms, at most one event per room.
Loop (≤ 200 attempts, 3 rolls each: room, x, y as above over the candidate
list): accept if the tile is unoccupied. Entity stores `eventSeed`; events.md
owns everything past the trigger.

### 6.5 Roamers — `roamerCount` from §1

Candidate rooms: all except the entrance room (exit room included — a pack
guarding the stairs is good drama; on boss floors the lair is excluded instead of
the exit). Max **2 roamers per room**. Loop until placed (≤ 500 attempts):

- Roll a room *(1 roll)*. If it already has 2 roamers → next attempt.
- Roll a tile in it *(2 rolls)*. Accept if unoccupied and `dist >= 10` (no
  spawn-camping the entrance).
- On accept, immediately roll the pack *(§7.3: 1 budget roll + 1 roll per pick)*.
  `encounterIndex` = 1, 2, … in placement order.

### 6.6 Waypoints *(after all roamers are placed)*

For each roamer in placement order: roll 3 waypoint tiles in its home room
*(2 rolls each; occupancy irrelevant — they are patrol targets, pathing routes
around obstacles)*. Bosses get no waypoints (they are landmarks, §8).

---

## 7. Difficulty Scaling & Encounter Building

### 7.1 Species roster (10 regular + 1 summon-only + 3 bosses)

Reference stat blocks for `data/enemies.ts` — all within combat §3's enemy ranges
(`hp` 10–60, `atk` 5–12, `def` 0–5, `spd` 3–8, `crt` 0–10). Rat Thug and Crow
Shaman are combat §13's worked-example blocks verbatim. `row` decides formation
order (§7.3); `xp` is summed and granted on victory (leveling rules: classes.md).

| Species | Tier | Threat | Row | hp | atk | def | spd | crt | xp | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `ratThug` | T1 | 1 | front | 18 | 7 | 1 | 5 | 5 | 10 | Shiv, `usableFrom [1,2]` |
| `sewerBat` | T1 | 1 | front | 10 | 6 | 0 | 8 | 10 | 10 | fast, fragile |
| `dustBunny` | T1 | 1 | front | 14 | 5 | 2 | 3 | 0 | 10 | slow chaff |
| `crowShaman` | T1 | 2 | back | 14 | 8 | 0 | 7 | 5 | 20 | hex `usableFrom [2,3,4]` — shove it to rank 1 to silence it |
| `roombaScout` | T2 | 2 | front | 24 | 8 | 2 | 6 | 5 | 20 | rams: `moveTarget +1` skill (shoves cats) |
| `sprinklerImp` | T2 | 2 | back | 20 | 9 | 1 | 7 | 5 | 20 | row-hitting spray, cooldown 2 |
| `yarnGolem` | T2 | 3 | front | 40 | 9 | 4 | 3 | 0 | 35 | **`heavy` elite** — immune to forced movement (no Poise; walls off Cat Pile setups) |
| `porcelainHound` | T3 | 3 | front | 34 | 11 | 3 | 6 | 5 | 35 | hits hard, shoves (`moveTarget +1`) |
| `laserGhost` | T3 | 3 | back | 22 | 12 | 0 | 9 | 10 | 35 | high spd + crt glass cannon |
| `trashPanda` | T3 | 4 | front | 48 | 12 | 2 | 6 | 10 | 50 | mini-boss statline, steals nothing (v1) |
| `sockWraith` | — | — | back | 12 | 6 | 0 | 6 | 0 | 5 | Laundromancer summon only, never in pools |

Bosses (full kits are combat-layer data per combat §11; the dungeon layer owns
placement and the encounter array):

| Boss | Floor | hp | Poise | Flags | Encounter array (front-to-back) |
|---|---|---|---|---|---|
| `vacuumKing` | 3 | 140 | 3 | heavy, doubleTurn, phase @50% ("MAX SUCTION") | `['vacuumKing']` |
| `laundromancer` | 6 | 200 | 3 | heavy, summons `sockWraith` (cap 2), windup nuke | `['laundromancer']` |
| `dogfather` | 9 | 280 | 4 | heavy, doubleTurn, phase @50%, windup nuke | `['dogfather', 'porcelainHound', 'porcelainHound']` |

### 7.2 Scaling model

No per-floor stat multipliers. Difficulty scales through exactly three knobs, all
in the §1 table: **species pools** (T1 → T3), **threat budget per pack** (3–4 up
to 10–12), and **pack count**. Enemy stat blocks stay fixed and within combat's
ranges, so combat's damage math never drifts; the party's counter-curve is XP
levels (classes.md) and chest loot (loot.md) — which is what makes chests and
optional packs worth the HP attrition.

### 7.3 Pack composition (exact algorithm, `popRng`)

```
budget = int(budgetLo, budgetHi)                       // 1 roll, §1 table
picks = []
while budget > 0 and picks.length < 5:                 // 5 = combat's enemy rank cap
  afford = pool.filter(s => s.threat <= budget)
  if afford empty: break
  s = afford[int(0, len-1)]                            // 1 roll
  picks.push(s); budget -= s.threat
if picks.length < 2: picks.push(cheapest species in pool)   // no solo packs
enemies = picks.filter(row=='front') ++ picks.filter(row=='back')   // stable, pick order
```

The result is the front-to-back array combat §1 consumes directly. Floor 1 packs
are 2–4 weenies; floor 8 packs are "trashPanda + support" or five-wide swarms.
The glyph drawn on the roamer blob is `enemies[0][0]` and its blob is tinted by
the tier of its most expensive member — threat is legible at a glance.

---

## 8. Boss Floors (differences only)

1. Smaller grid, fewer roamers (§1) — approach, not gauntlet.
2. The **lair** (guaranteed 11×7 room, single west door, §5.1/§5.3) is the exit
   room: boss blob at center (drawn 2 tiles wide with a red glow), `StairsDown`
   at the east end, `stairsLocked = true`.
3. The boss entity never patrols or chases — it is a landmark. It is revealed
   (with a growl line) the moment the lair lights up.
4. **Trigger:** the party's first step onto any lair tile starts the boss battle
   (camera pan, one taunt line, then combat with `canFlee = false` per combat
   §11.6). No sneaking past; walking away *before* entering is fine — clear
   roamers, pop an event, then come back. You cannot descend while the boss lives
   (stairs prompt: "Something huge is still humming in there.").
5. Victory: stairs unlock, and the lair's guaranteed hoard chest (placed at
   `(lairX+2, lairY+1)` during §6.3, before the nook pass, using `lootTableId
   'boss_hoard'`) is now safe to open. Surviving roamers stay alive.
6. Floor 9's stairs are replaced by **The Sunbeam** — stepping on it rolls
   credits: run won.

---

## 9. Exploration Model

### 9.1 The party token

The four cats move as **one token**: a cluster of four tiny procedural cat blobs
(class colors, ears, whiskers — PixiJS Graphics) inside one 48 px tile. Movement
is 4-directional, no diagonals.

### 9.2 Marching order

`Tab` opens the party panel: reorder cats freely (drag, or select + arrows).
Marching order **is** combat's initial rank order (combat §1): slot 1 = rank 1
(front). Reordering costs nothing and pauses the world — but you cannot open the
panel while a chaser is within 3 tiles ("no re-shuffling mid-pounce").

### 9.3 The step loop (the whole simulation)

```
onStep(dir):
  1. Resolve the party's move:
     - target Wall                          → bump animation, NO step consumed
     - target has an unopened chest         → OPEN it (step consumed, party stays put)
     - target tile otherwise                → party moves there (110 ms tween)
  2. Recompute visibility (§10); explored |= visible.
  3. Roamers act in entity-id order (§12): stunned ticks down; chasers move every
     step; patrol/return movers move only when (stepCount + id) % 2 == 0
     (half speed, desynced so packs don't march in lockstep).
  4. Contact check: any roamer with Manhattan distance <= 1 to the party (same or
     4-adjacent tile) triggers BATTLE — lowest entity id if several.
  5. Tile triggers under the party: event fires its modal (entity consumed);
     StairsDown shows the descend prompt (locked message on boss floors);
     boss-lair entry starts the boss battle (§8.4).
  6. stepCount++
```

Battles, event modals, and loot popups pause the step loop entirely (the PixiJS
ticker keeps running for ambient animation). **After a battle:** victory removes
the roamer, shows XP (sum of pack `xp`) and the victory loot draw
(`mulberry32(victorySeed)`, tables in loot.md); **flee** (combat §12 Scatter!)
puts the party back on the tile it occupied when contact triggered, and the
roamer becomes `stunned` for **5 party-steps** (no movement, no contact trigger)
— the pity window to actually get away.

### 9.4 Controls

- **Arrows / WASD:** one step per press; holding auto-repeats each time the
  110 ms tween finishes (~9 steps/s).
- **Mouse click** on any *explored* passable tile: BFS path over explored tiles,
  drawn as paw-print dots, auto-walked step by step. Auto-walk cancels when any
  roamer enters the visible set, when the next step would put the party adjacent
  to a visible roamer, or on any keypress.
- **E / Space / Enter:** confirm prompts (descend, loot, event choices).
- **Tab:** party panel (§9.2). **M:** large map overlay. **Esc:** pause menu.

### 9.5 Interactions (complete table)

| Object | Trigger | Result |
|---|---|---|
| **StairsUp** | none | Scenery. Inspect text: "The way back has collapsed." |
| **StairsDown** | step onto it | Prompt "Descend to floor N+1? [Enter]" → §1 catnap heal, generate next floor. Locked while a boss lives. |
| **Chest** | bump (move into its tile) | Consumes the step; loot popup with the `mulberry32(chestSeed)` draws from its `lootTableId` (loot.md: Tuna Snack, Catnip, Feather Wand, gear per combat §9's item hooks). Becomes `opened` — stays visible, walkable from then on. |
| **Event sparkle** | step onto its tile | Fires the events.md modal with `eventSeed`; entity consumed regardless of outcome. |
| **Door** | walk through | Visual open animation only. Never locked, never blocks LOS. |
| **Roamer** | Manhattan ≤ 1 after any step (yours or its) | Battle with its fixed `enemies` array; `battleRng` per §2. No ambush modifiers — combat always starts per combat.md (energy 4, no surprise rounds). |
| **Boss** | first step onto any lair tile | Boss battle, no flee (§8.4). |

---

## 10. Fog of War / Visibility (exact)

Three knowledge states per tile: **unseen** (rendered black), **explored**
(remembered — 35% brightness), **visible** (now — full brightness).

`visible` is recomputed after every step as the union of:

1. **Whisker-light:** every tile within **Chebyshev radius 3** of the party with
   line of sight. LOS = Bresenham line from party tile center to target tile
   center; blocked by `Wall` tiles strictly between (the wall itself is visible
   if the line reaches it — it just doesn't propagate). Doors never block LOS.
2. **Room light:** if the party stands inside room R (or on one of its door
   tiles), the full rect `[R.x-1, R.x+R.w] × [R.y-1, R.y+R.h]` — interior plus
   the 1-tile wall rim including all doors. Entering a room reveals it whole.

Static entities (stairs, chests with open/closed state, event sparkles) are drawn
dimmed on explored tiles — the map remembers them. **Roamers are drawn only while
their tile is currently visible** — losing sight of a patrol is real information
loss, and the minimap forgets them too.

Cost: radius-3 disc is ≤ 49 tiles × ≤ 4-step Bresenham, plus one room rect —
microseconds per step.

---

## 11. Camera, Rendering, Minimap

- **Viewport:** 15×11 tiles at 48 px (720×528 play area); camera lerps to the
  party at 0.15/frame, clamped to floor bounds.
- **Tile layer:** one static `Graphics` drawn once per floor. **Fog:** one
  overlay `Graphics` rebuilt only for tiles whose knowledge state changed this
  step (typically < 40). **Entities:** small Graphics blobs, culled by knowledge
  state. Flat colors + `Text` glyphs only — no assets, trivially 60 fps.
- **Minimap:** top-right, **4 px per tile** (max floor 39×25 → 156×100 px),
  drawn into a `RenderTexture` rebuilt only when `explored` changes; the party
  dot is a separate pulsing sprite. `M` toggles a centered 2× overlay.

| Minimap element | Rendering |
|---|---|
| Unseen | transparent |
| Explored wall / floor / door | `#2a2a33` / `#55555f` / `#7a7a66` |
| Party | 4×4 white dot, pulsing alpha |
| Stairs down (explored) | green square |
| Chest (explored) | gold square (unopened) / gray (opened) |
| Event (explored) | violet square |
| Roamer / boss (visible only) | red square / large red square |

---

## 12. Roamer AI (grid-side, deterministic, ~60 lines)

State machine, evaluated in step-loop phase 3. **No RNG anywhere** — BFS with
neighbor order N, E, S, W; one shared BFS flood from the party's tile per step
serves every chaser.

```
canSee(party) = Chebyshev distance <= 6 AND Bresenham LOS (walls block, doors don't)

patrol:  if canSee → state = chase, lostSightFor = 0
         else on my half-speed tick: BFS 1 step toward waypoints[wpIndex];
         arrived → wpIndex = (wpIndex + 1) % 3
chase:   if canSee → lostSightFor = 0  else lostSightFor++
         if lostSightFor >= 6 or BFS distance to party > 15 → state = return
         else: BFS 1 step toward the party (EVERY step — full speed)
return:  on my half-speed tick: BFS 1 step toward waypoints[0]; arrived → patrol
         if canSee → chase again
stunned: stunnedFor--; at 0 → return. No movement, no contact trigger.
```

Movement legality: roamers walk `Floor`/`Door` only — never onto stairs, chests,
events, other roamers, or the party's tile (contact is the adjacency check in
phase 4). Blocked step = stand still, which reads as "blocking the corridor".
A `!` pops over a roamer entering chase; a `?` when it gives up.

Emergent play, zero extra code: patrols orbit their home room at half speed and
are outrunnable in the open (equal top speed, but they give up); you can bait a
chaser off a chest, break LOS around a maze corner, thread a loop (the §5.3
extra doors exist for this), or use the frozen half-speed rhythm to slip a room
on the off-beat.

---

## 13. Worked Example — `runSeed "MEOW-1987"`, floor 1 (real generator output)

Actual output of the reference implementation of §5–§6 (kept as the unit-test
fixture: assert this exact grid and entity list for this seed). Streams:
`genRng = mulberry32(hash('MEOW-1987', 1, 'gen'))`, `popRng = …'pop'`.
Config row: 31×21, 40 room attempts, 4 roamers, 3 chests, 2 events, pool T1,
threat budget 3–4.

```
Legend: # wall   . floor   + door   < stairs-up (spawn)   > stairs-down
        $ chest   ? event sparkle   1-4 roamer packs

###############################
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
###############################
```

Seven rooms survived the 40 attempts (listed center-sorted per §6.1):

| Room rect (x,y w×h) | Role |
|---|---|
| (3,1) 5×5 | **ENTRANCE** — `<` at center (5,3) |
| (5,7) 5×7 | roamer 4's den; event `?` at (9,10) |
| (13,5) 5×5 | treasure room — fallback chests at (17,6) and (15,7) |
| (3,15) 7×5 | quiet southwest room (bait ground) |
| (19,3) 9×7 | big northeast hall — roamer 2 |
| (11,13) 5×7 | event `?` at (11,14); roamer 3 |
| (21,13) 5×7 | **EXIT** — `>` at center (23,16), BFS dist **37** ≥ (31+21)/2 ✓; roamer 1 lives here |

Exactly one nook survived the 3 trim passes — the corridor stub at **(1,16)**,
south-west — and it got the first chest (`$`, dead-end rule §6.3.1). The other
two chests fell back to random room tiles, both landing in room (13,5): a
visible two-chest treasure room one door away from roamer 2's hall.

Roamer packs (threat budget rolls from `popRng`; `encounterIndex` in placement
order; battle stream = `mulberry32(hash('MEOW-1987', 1, encounterIndex))`):

| # | Tile | dist | encounterIndex | Pack (front-to-back) |
|---|---|---|---|---|
| 1 | (23,17) | 36 | 1 | dustBunny, dustBunny, crowShaman |
| 2 | (25,6) | 33 | 2 | dustBunny, sewerBat, ratThug |
| 3 | (13,18) | 23 | 3 | sewerBat, crowShaman |
| 4 | (5,9) | 10 | 4 | sewerBat, ratThug, crowShaman |

How this floor plays: the party spawns at `<` with the whole entrance room lit.
The south door leads through a windy corridor past roamer 4's den — pack 4
patrols at half speed with a crowShaman in the back rank, a perfect first Yank
of Yarn target — toward the surviving-nook chest at (1,16). The east route runs
a long corridor to the two-chest room at (13,5), with roamer 2 orbiting the big
hall behind it: greed within line-of-sight of danger. Both events sit inside
patrol rooms (a fight or a bait to reach each sparkle). The exit room is
**guarded** — pack 1 (double dustBunny wall + shaman) patrols within four tiles
of the stairs, so descending means fighting it, baiting it out through the west
door and looping around via (19,17), or squeezing past on its half-speed
off-beat. Pack 3 guards nothing and can simply never be met — or be hunted for
XP and a victory loot roll. Total floor threat: 4 packs ≈ 11 threat, 3 chests,
2 events, and one long diagonal of attrition between `<` and `>`.

---

## 14. Determinism Contract & Edge Cases

- Same `runSeed` → identical floors, packs, waypoints, loot, events, and battle
  streams, independent of player behavior. Rejected placement attempts consume
  their rolls (§5.1, §6.3–6.5) — that is what keeps streams stable.
- Exploration and roamer AI consume zero RNG (§12); chest/victory/event content
  hangs off per-entity derived seeds (§2), so *when* you open things cannot
  perturb anything else.
- Multiple simultaneous contacts: lowest entity id fights; the others remain and
  trigger immediately after the battle unless dead or stunned — chained fights
  next to two packs are possible and are intended punishment.
- Flee: party restored to its pre-contact tile, pack keeps its `enemies` and
  `encounterIndex`, enemy HP resets, pack stunned 5 steps. (Combat §12's "returns
  to the room entrance" is implemented as the pre-contact tile — corridors have
  no room entrance; ledger note in §16.)
- Roamers cannot stack or path through entities; a blocked chaser waits.
- Auto-walk is an input macro replaying synthetic steps through the normal loop —
  it cannot desync anything.
- A save is: `runSeed`, floor number, party state (HP, Lives, XP, inventory,
  marching order), plus current-floor deltas (explored bitmap, party position,
  per-entity: opened/used/dead, roamer position + state fields, `stepCount`).
  Floors are generated on descent and discarded on the next one.
- Party wipe or last cat at 0 Lives → run over (combat §12); the dungeon layer
  just shows the run-summary screen.

---

## 15. Implementation Budget (~1,150 LoC + data, PixiJS Graphics/Text only)

| Module | ~LoC | Contents |
|---|---|---|
| `dungeon/rng.ts` | 40 | fnv1a, hash, mulberry32 (shared with combat) |
| `dungeon/gen.ts` | 210 | §5: rooms, maze, connectors, trimming, lair, validation |
| `dungeon/populate.ts` | 150 | §6: stairs, chests, events, roamers, packs, waypoints |
| `dungeon/floorstate.ts` | 90 | tiles, BFS flood, Bresenham LOS, fog sets |
| `explore/step.ts` | 120 | §9.3 loop, contact + trigger resolution, flee/victory re-entry |
| `explore/party.ts` | 130 | input, tween, click-path BFS, auto-walk, marching-order panel |
| `explore/roamers.ts` | 80 | §12 state machine (shared BFS flood) |
| `explore/render.ts` | 200 | tile layer, fog overlay, entity blobs, camera |
| `explore/minimap.ts` | 80 | RenderTexture minimap + overlay |
| `explore/interact.ts` | 100 | chest/stairs/event/battle handoff, popups |
| `data/floors.ts`, `data/enemies.ts` | (content) | §1 table, §7.1 roster, boss placement data |

The §13 prototype doubles as the generator's unit test.

---

## 16. Consistency Ledger (dungeon ↔ combat.md) & Deliberate Cuts

| Contract | Status |
|---|---|
| Encounter shape: front-to-back `string[]`, 1–5 enemies | §7.3 caps picks at 5, minimum 2 (floor-1 budgets can yield 2–4). Verbatim combat §1. |
| Battle stream `mulberry32(hash(runSeed, floor, encounterIndex))` | §2, verbatim; this doc supplies the concrete `hash` (fnv1a over `'|'`-join). Rematch after flee reuses the stream (diverges with different play). |
| Marching order → cat ranks (combat §1) | §9.2 party panel; slot 1 = rank 1. |
| Flee returns party "to the room entrance" (combat §12) | Refined to the **pre-contact tile** + 5-step stun (§9.3, §14) — corridors have no "room entrance"; behavior and intent (escape window, entity remains) preserved. |
| HP persists across a floor, no post-battle auto-heal (combat §12) | Preserved. **New dungeon-layer rule:** descent catnap heals 25% maxHp (§1) — the only non-item, non-Medic heal; tunable. |
| Nine Lives (combat §12) | Lives never touched by the dungeon layer; shrine-restores-a-Life is an events.md hook. |
| Boss rules: heavy/Poise/no-flee, Vacuum King on floor 3 (combat §11) | §8: lair arena, `canFlee=false`, bosses at 3/6/9; Vacuum King 140 HP/Poise 3 matches combat. |
| `heavy` elite trait (combat §1) | `yarnGolem` (§7.1) — a mid-run lesson that Cat Pile setups can be walled off. |
| Item hooks (Tuna Snack, Catnip, Feather Wand — combat §9) | Chest/victory loot tables (loot.md) draw from these ids; dungeon only stores `lootTableId` + seed. |
| Victory "seeded loot + XP screen (dungeon layer's job)" (combat §12) | §9.3: XP = sum of pack `xp`, loot from `victorySeed`. Leveling curve: classes.md. |

Deliberate cuts (v1): locked doors and keys, traps, secret walls, diagonal
movement, invisible random encounters, revisiting cleared floors, hunger/torch
clocks, ambush or surprise-round modifiers (combat fixes battle-start energy at
4 — no dungeon-side combat modifiers of any kind), shops (a merchant belongs in
events.md if anywhere), roamer respawns, and multi-tile roamer bodies (bosses
are drawn 2 tiles wide but occupy one).
