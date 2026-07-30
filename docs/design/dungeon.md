# c(at)rpg Dungeon Generation & Exploration — FINAL DESIGN
## "Whisker Maze" (rooms-in-a-maze, step-based exploration)

Procedural, tile-based, maze-like floors for the 4-cat party. This document is the single
source of truth for floor generation, exploration, fog of war, roaming encounters, and
per-floor difficulty. It is fully consistent with `docs/design/combat.md` ("Nine Lives:
Pounce & Poise"): encounters are generated here in exactly the shape combat consumes
(`{ enemies, rows, isBoss, canFlee }` + a battle seed), enemy stat blocks scale from the
floor-1-normalized bases in combat §9, and all randomness flows through seeded mulberry32
streams with a specified roll order.

Design pillars:

1. **Maze-like, not soup-like** — rooms embedded in genuinely winding corridors (the pitch
   says maze; BSP corridor trees read as office floor plans). Dead ends are partially kept
   on purpose: they hold chests.
2. **Everything decided at generation time** — layout, chest contents, roamer packs and
   their battle seeds are all fixed the moment the floor generates. Exploration consumes
   **zero RNG at runtime**; same seed = same run, regardless of play order.
3. **Visible danger** — roaming enemies you can see, dodge, or ambush. No random battles.
4. **Step-based world** — the world only moves when the party moves. Rendering is 60fps
   (tweens, pulsing fog, blinking minimap dot), simulation is one discrete step per tile
   moved. Trivially deterministic, trivially fast.

---

## 1. Run Structure & Floor Progression

A v1 run is **6 floors**, descending only (flavor: the way up collapses behind the party —
so only the current floor is ever in memory; no persistence of old floors). **Every 3rd
floor is a boss floor** (floors 3 and 6), matching combat.md's two shipped bosses. Clearing
floor 6's boss wins the run.

| Floor | Grid (W×H) | roomAttempts | Roamers | Threat/encounter | Chests | Events | Enemy tier | Boss |
|---|---|---|---|---|---|---|---|---|
| 1 | 25×17 | 60 | 5 | 3 | 2 | 1 | 1 | — |
| 2 | 29×19 | 60 | 6 | 4 | 2 | 1 | 1 | — |
| 3 | 31×21 | 60 | 4 | 4 | 3 | 1 | 2 | **Rat King** |
| 4 | 35×23 | 70 | 7 | 5 | 3 | 2 | 2 | — |
| 5 | 39×25 | 70 | 8 | 6 | 3 | 2 | 3 | — |
| 6 | 41×27 | 70 | 5 | 6 | 4 | 2 | 3 | **The Basement Hound** |

Derivations (so the table extends mechanically if floors are added later):
`chests = 2 + floor(floorNum / 3)`, `events = floorNum <= 3 ? 1 : 2`, grid grows by
+4/+2 (alternating) per floor, **W and H are always odd** (required by the algorithm).
Boss floors get fewer roamers (the boss is the budget).

Between floors: party HP persists (combat.md §11 — attrition is real, no free heal on
descent), statuses/Vigor are battle-scoped and already gone, KO'd cats were already revived
at 30% after their battle. The bestiary and the 9-Lives pool persist for the whole run.

---

## 2. Seeded RNG Plumbing (exact)

Same `mulberry32` as combat, plus one 32-bit mixer for deriving child seeds:

```ts
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mix(a: number, b: number): number {   // deterministic seed derivation
  let h = (a ^ Math.imul(b, 0x9E3779B9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}
const ri = (rng: () => number, n: number) => Math.floor(rng() * n); // uniform int [0,n)
```

Seed tree (one `runSeed`, shown on the HUD, re-enterable for shared runs):

```
runSeed
└─ floorSeed        = mix(runSeed, floorNum)        // retry r: mix(runSeed, floorNum*31 + r), §5.7
   ├─ layoutRng     = mulberry32(mix(floorSeed, 1)) // rooms, maze, connectors, pruning
   ├─ popRng        = mulberry32(mix(floorSeed, 2)) // stairs, chests, loot, events, roamers
   ├─ battleSeed(e) = mix(floorSeed, 1000 + e.id)   // per roamer/boss entity → combat's stream
   ├─ lootSeed(e)   = mix(battleSeed(e), 7)         // post-battle victory loot screen
   └─ eventSeed(e)  = mix(floorSeed, 3000 + e.id)   // handed to the narrative-event system
```

**Roll-order contract:** `layoutRng` is consumed strictly in generation step order
(§5.1 → §5.4), `popRng` strictly in population order (§6.1 → §6.6), each specified below.
Exploration consumes **no** RNG: patrol waypoints are pre-rolled, chase pathing is
deterministic BFS with neighbor order **N, S, W, E** and FIFO queue. Combat draws from its
own `mulberry32(battleSeed)` stream per combat.md §3.

---

## 3. Tile & Data Model

Only three tile types — everything else is an entity standing on a tile:

```ts
export const enum Tile { Wall = 0, Floor = 1, Door = 2 }
// Door is passable, never locked, auto-"opens" (visual only). Rendered as a door frame
// when 4-adjacent to a room tile, otherwise as tinted floor (a corridor arch).
// Walls block movement and line of sight. Doors do NOT block LOS.

interface Room { id: number; x: number; y: number; w: number; h: number }

interface FloorState {
  num: number; seed: number; w: number; h: number;
  tiles: Uint8Array;            // w*h, Tile, index = y*w + x
  rooms: Room[];
  entities: Entity[];           // see below; id = array index at generation time
  explored: Uint8Array;         // w*h, 0|1, accumulates
  visible: Set<number>;         // tile indices, recomputed after every step
  stepCount: number;            // party steps taken on this floor
}

type Entity =
  | { kind: 'stairs-up';   id: number; x: number; y: number }               // arrival marker
  | { kind: 'stairs-down'; id: number; x: number; y: number; locked: boolean }
  | { kind: 'chest'; id: number; x: number; y: number; opened: boolean; loot: ItemId[] }
  | { kind: 'event'; id: number; x: number; y: number; eventSeed: number }  // consumed on use
  | Roamer;

interface Roamer {
  kind: 'roamer' | 'boss';
  id: number; x: number; y: number;
  homeRoom: number;
  waypoints: [number, number][];      // 3 pre-rolled tiles in home room
  wpIndex: number;                    // current patrol target
  state: 'patrol' | 'chase' | 'return' | 'stunned';
  stunnedFor: number;                 // party-steps remaining (post-flee grace)
  lostSightFor: number;               // consecutive steps without LOS while chasing
  encounter: EncounterDef;            // fixed at generation
  glyph: string;                      // 1 char drawn on the blob (species of the pack leader)
}

interface EncounterDef {              // exactly combat.md §1's shape, plus the seed
  enemies: EnemyId[];
  rows: ('front' | 'back')[];         // parallel to enemies
  isBoss: boolean;
  canFlee: boolean;                   // false only for bosses
  battleSeed: number;
}
```

All floor content (tier lists, loot tables, boss definitions, `FloorConfig` rows from the
§1 table) are plain TS data objects in `data/floors.ts`.

---

## 4. Recommended Algorithm: Rooms + Maze Flood + Connectors + Partial Pruning

**Chosen: the "rooms in a maze" generator** (Nystrom-style): scatter non-overlapping rooms,
flood every remaining gap with a windy maze, connect all regions with door tiles, then
erode most — not all — dead ends. Rejected alternatives: **BSP rooms+corridors** (corridors
form a tree, floors feel like hallways, not a maze — contradicts the pitch) and **cellular
caves** (no rooms/doors, poor fit for door-framed boss rooms and room-based lighting).
This algorithm gives rooms *and* genuine labyrinth between them, has no failure modes that
need backtracking, and is ~150 LoC.

Requires odd W, H. Rooms and maze cells live on odd coordinates; walls between them on
even ones. Guarantees full connectivity by construction (§5.4 merges every region).

---

## 5. Generation, Step by Step (exact, in `layoutRng` roll order)

### 5.1 Rooms (rejection sampling)

Repeat `roomAttempts` times (from the §1 table):

1. Roll `w = 5 + 2*ri(3)` (5, 7 or 9), `h = 3 + 2*ri(3)` (3, 5 or 7). *(2 rolls)*
2. Roll an odd position: `x = 1 + 2*ri((W-1-w-1)/2 + 1)`, same for `y` with H, h. *(2 rolls)*
3. If the rect `[x, x+w) × [y, y+h)` intersects any placed room rect → **reject** (the
   4 rolls are still consumed — that is the contract). Odd alignment guarantees at least
   one wall between non-intersecting rooms.
4. Else carve all tiles to `Floor`, record the `Room`, assign it a fresh **region id**.

Typical yield: 5–8 rooms on floor 1, 9–14 on floor 6.

### 5.2 Maze flood (growing tree, windy)

For each odd cell `(x, y)` in row-major order that is still `Wall`: start a new maze
**region** and run growing-tree from it:

```
cells = [start]; carve start; lastDir = null
while cells not empty:
  cell = cells.last                                     // newest-first = long winding halls
  unmade = directions [N,S,W,E] where cell+2*dir is in bounds and Wall
  if unmade not empty:
    if lastDir ∈ unmade:  roll r; dir = (r < 0.40) ? lastDir : unmade[ri(len)]  // 1–2 rolls
    else:                 dir = unmade[ri(len)]                                 // 1 roll
    carve cell+dir and cell+2*dir into this region; push cell+2*dir; lastDir = dir
  else: pop cells; lastDir = null
```

`0.40` = the **straightness** constant (60% chance to turn when turning is possible).
Lower it for snakier mazes; do not make it a config knob in v1.

### 5.3 Connectors

Scan all interior wall tiles; a **connector** is a wall whose 4-neighbors span ≥ 2 distinct
regions. Then merge regions (simple root-relabel union):

```
while more than one region root remains:
  pick a random connector from the remaining list          // 1 roll
  set its tile to Door; merge the regions it spans
  drop connectors that no longer span 2 roots; each dropped one:
    roll r; if r < 0.08 and no 4-adjacent Door: set it to Door too   // extra loop doors
```

The 8% extra-door chance is what creates **loops** — without it the floor is a tree and
chase AI can corner you unfairly.

### 5.4 Partial dead-end pruning (nooks)

Scan passable tiles in row-major order. For each tile that currently has exactly **one**
passable 4-neighbor (a dead end) and is not inside a room:

- If it is a `Floor` tile: roll r; if `r < 0.25` → **preserve** it as a **nook** (chest
  candidate, §6.3) and stop. *(1 roll)*
- Otherwise (roll ≥ 0.25, or the tile is a `Door`): erode the whole chain — set the tile
  to `Wall`, step to its single passable neighbor, repeat while the current tile is a
  non-room, non-nook dead end. *(no further rolls)*

Finally, any `Door` left with fewer than 2 passable neighbors becomes `Wall`.
Result: ~75% of the maze's dead weight is gone, but a few tantalizing cul-de-sacs remain,
and corridors between rooms stay windy.

### 5.5 What is NOT done

No corridor widening, no wall decoration pass, no water/trap tiles in v1. Three tile types
is the whole terrain vocabulary.

### 5.6 Distance field

BFS from the entrance stairs tile (placed in §6.1) over passable tiles, neighbor order
N, S, W, E. This `dist` field drives exit choice, chest ordering, and roamer eligibility.
It is discarded after population (exploration recomputes its own paths).

### 5.7 Validation & deterministic retry

After population, assert: `rooms.length >= 4`, stairs-down reachable, and
`dist(stairsDown) >= (W + H) / 2` (no trivially short floors). On failure regenerate the
entire floor with `floorSeed = mix(runSeed, floorNum * 31 + retry)`, retry = 1, 2, …
(retry 0 is the normal case). In practice retries are <1% of floors; the loop is capped at
10, after which the last candidate is accepted (never observed, but no infinite loop).

---

## 6. Population Rules (exact, in `popRng` roll order)

### 6.1 Entrance

`entranceRoom = rooms[ri(rooms.length)]` *(1 roll)*. Place `stairs-up` at the room's center
tile `(x + floor(w/2), y + floor(h/2))`. The party spawns on it. It is scenery — there is
no going back up.

### 6.2 Exit / boss room *(no rolls)*

`exitRoom` = the room (≠ entrance) whose center has the **greatest BFS distance** from the
entrance. `stairs-down` goes on the tile inside that room with maximal distance.
On a **boss floor**, the boss entity stands at the exit room's center (shifted 1 tile west
if that would collide with the stairs), and `stairs-down.locked = true` until the boss
dies. The whole exit room is the boss arena trigger (§10.6).

### 6.3 Chests

`chestCount` from §1. Fill order:

1. **Nooks first**, sorted by BFS distance descending (deepest cul-de-sac gets a chest
   first) — exploring dead ends must pay. *(no rolls)*
2. If nooks run out: loop (≤500 attempts): roll a room, roll a tile in it (`x = r.x +
   ri(r.w)`, `y = r.y + ri(r.h)`; 3 rolls per attempt); accept if the room isn't the
   entrance room, the tile is unoccupied, and `dist >= 10`. The exit/boss room is **not**
   excluded — chests generated inside a boss room are the boss's hoard, guarded on purpose.

Chest **loot is pre-rolled now** (2 draws from the floor's chest loot table, §9.4, using
`popRng`, 1 roll per draw) and stored on the entity, so savescumming a chest is impossible
and determinism holds.

### 6.4 Events

`eventCount` placements: loop (≤500 attempts): roll room + tile (3 rolls/attempt); accept
if the room is neither entrance nor exit room and the tile is unoccupied. The entity stores
`eventSeed` for the narrative-event system (separate design doc); this doc only owns
placement and triggering.

### 6.5 Roamers

Eligible rooms: not the entrance room, not the boss room (boss floors), and room-center
`dist >= 8` (no spawn camping the stairs). Fisher–Yates shuffle the eligible list
*(len−1 rolls)*, then for roamer i = 0..count−1, home room = `eligible[i % len]`:

- **Position:** roll tiles in the home room until unoccupied (2 rolls/attempt, ≤50).
- **Pack composition:** `budget = threatBudget` (§1 table). While `budget > 0` and pack
  size < 4: pick uniformly among tier entries with `threat <= budget` *(1 roll)*, append,
  subtract. (Guarantees 1–4 enemies; combat.md supports 1–5.)
- **Rows:** each species has a `rowPref` (`front`/`back`, §9.2). Front-pref enemies fill
  front until 3, overflow back; back-pref fill back until 3, overflow front.
- **Waypoints:** 3 tiles rolled in the home room (2 rolls each; occupancy irrelevant —
  they are patrol *targets*, pathing routes around obstacles).
- **Encounter:** `{ enemies, rows, isBoss: false, canFlee: true, battleSeed: mix(floorSeed,
  1000 + id) }`. The roamer's `glyph` = first letter of the pack's first species.

### 6.6 Boss encounter *(no rolls)*

`{ enemies: [bossId], rows: ['front'], isBoss: true, canFlee: false, battleSeed:
mix(floorSeed, 1000 + bossEntityId) }`. Boss picks per §1; definitions in §9.5.

---

## 7. Exploration Model

### 7.1 The party token

The 4 cats move as **one token**: a 40px cluster of four tiny procedural cat blobs (the
party's class colors) inside one 48px tile. 4-directional grid movement, no diagonals.

### 7.2 The step loop (the whole simulation)

Rendering runs at 60fps; the **world advances only when the party spends a step**:

```
onStep(dir):
  1. Resolve the party's move:
     - target tile Wall            → no step consumed (bump animation only)
     - target has closed chest     → OPEN it (step consumed, party does not move)
     - target has visible roamer   → BATTLE (step consumed, party does not move)
     - else                        → party moves onto the tile (110 ms tween)
  2. Recompute visibility (§7.4); explored |= visible.
  3. Roamers act in entity-id order (§8): stunned ticks down; chasers move every step;
     patrol/return movers move only when (stepCount + entity.id) % 2 == 0  (half speed,
     desynced so packs don't march in lockstep).
  4. Contact check: any roamer with Manhattan distance <= 1 to the party (same or adjacent
     tile) triggers BATTLE — lowest entity id wins if several.
  5. Tile triggers under the party: event fires its modal (consuming the entity);
     stairs-down shows the descend prompt; boss-room entry starts the boss (§10.6).
  6. stepCount++
```

Battles, event modals, and loot popups **pause the step loop** entirely (the ticker still
runs for ambient animation). After a battle: victory removes the roamer entity and shows
the post-battle loot roll (seeded by `lootSeed`, §9.4); **flee** returns the party to the
tile it occupied, and the roamer becomes `stunned` for 5 party-steps (no movement, no
contact trigger) — the pity window to actually get away.

### 7.3 Controls

- **Arrows / WASD:** one step per press; holding auto-repeats each time the 110 ms move
  tween finishes (~9 steps/s).
- **Mouse click** on any *explored*, passable tile: BFS path over explored tiles, drawn as
  paw-print dots, then auto-walked step by step. Auto-walk **cancels** when any roamer
  enters the visible set, when the next step would enter a tile adjacent to a visible
  roamer, or on any keypress.
- **E / Space / Enter:** confirm prompts (descend, loot popup, event choices).
- **M:** toggle large minimap overlay (centered, 2× scale). **Esc:** pause menu.

### 7.4 Fog of war / visibility (exact)

Three knowledge states per tile: **unseen** (never visible — rendered black), **explored**
(seen before — 35% brightness), **visible** (right now — full brightness).

`visible` after every step = union of:

1. **Torchlight:** every tile within Chebyshev radius 2 of the party that has line of
   sight — Bresenham line from party tile center to target tile center; blocked by `Wall`
   tiles (a wall itself is visible if the line reaches it; it just doesn't propagate).
   Doors never block LOS.
2. **Room light:** if the party stands inside room R, additionally the full rect
   `[R.x-1, R.x+R.w] × [R.y-1, R.y+R.h]` — interior plus its 1-tile wall rim, including
   all its door tiles. Entering a room reveals the whole room at once.

Static entities (stairs, chests with open/closed state, events) are drawn dimmed on
explored tiles — the map remembers them. **Roamers are drawn only while their tile is in
`visible`** — losing sight of a patrol is real information loss.

### 7.5 Camera & rendering

Viewport shows 15×11 tiles at 48px (720×528 play area); camera lerps toward the party at
`0.15/frame`, clamped to floor bounds. Tile layer: one static `Graphics` drawn once per
floor; fog: one overlay `Graphics` rebuilt only for tiles whose knowledge state changed
this step (typically <40 tiles); entities: individual small Graphics objects, culled by
visibility state. Everything is flat-colored shapes + `Text` glyphs — no assets.

### 7.6 Minimap

Top-right corner, **4 px per tile** (max floor 41×27 → 164×108 px), drawn into a
`RenderTexture` rebuilt only when `explored` changes; the party dot is a separate sprite.

| Element | Rendering |
|---|---|
| Unseen tile | transparent |
| Explored wall / floor / door | `#2a2a33` / `#55555f` / `#7a7a66` |
| Party | 4×4 white dot, pulsing (sin alpha) |
| Stairs down (once explored) | green square |
| Chest (explored) | yellow square (unopened) / gray (opened) |
| Event (explored) | violet square |
| Roamer / boss (only while visible) | red / large red square |

### 7.7 Interactions (complete table)

| Object | Trigger | Result |
|---|---|---|
| **Stairs-up** | none | Scenery. Inspect text: "The way back has collapsed." |
| **Stairs-down** | step onto it | Prompt "Descend to floor N+1? [Enter]". If `locked` (boss alive): "Something huge is still breathing here." |
| **Chest** | bump (move into its tile) | Consumes the step; loot popup lists the pre-rolled contents; items go to party inventory (stat treats are eaten immediately by a chosen cat, §9.4). Chest becomes `opened`, stays visible, is walkable from then on. |
| **Event sparkle** | step onto its tile | Fires the narrative event modal with `eventSeed`; entity consumed regardless of outcome. |
| **Door** | walk through | Purely visual open animation. Never locked, never blocks. |
| **Roamer** | adjacency after any step, or bumping into it | Battle with its fixed `EncounterDef`. Bump = ambush **by you**: your whole party gets +1 Vigor at battle start (on top of the base 3). Being contacted on the roamer's own move = it ambushed **you**: no bonus. |
| **Boss** | first step onto any tile of the boss room | Camera pans to the boss, one growl line, then the boss battle (no flee). Victory unlocks the stairs and drops the boss hoard reward (§9.4). |

The ambush bonus is the only mechanical coupling between grid position and combat, and it
makes stalking patrols on the map mirror Stalk inside combat.

---

## 8. Roamer AI (grid-side, deterministic, ~60 lines)

State machine, evaluated on the roamer's action in step-loop phase 3:

```
patrol:  if canSee(party) → state = chase, lostSightFor = 0
         else on my move tick: BFS 1 step toward waypoints[wpIndex]
              (arrived → wpIndex = (wpIndex + 1) % 3)
chase:   if canSee(party) → lostSightFor = 0  else lostSightFor++
         if lostSightFor >= 6 or BFS path to party > 15 → state = return
         else: BFS 1 step toward the party's tile (moves EVERY step — faster than patrol)
return:  BFS 1 step toward waypoints[0] on my move tick; arrived → patrol
         if canSee(party) → chase again
stunned: stunnedFor--; at 0 → return. No movement, no contact trigger.

canSee(party) = Chebyshev distance <= 6 AND Bresenham LOS (walls block, doors don't)
```

Movement legality: roamers walk `Floor`/`Door` tiles, never onto stairs, chests, events,
other roamers, or the party's tile (contact happens via adjacency, phase 4). Blocked step
= stand still this tick. BFS ties broken by neighbor order N, S, W, E — no RNG anywhere.

Readable behavior falls out: patrols orbit their home room at half speed, spot you at
range 6, run you down at full speed, give up after 6 steps without sight or a 15-tile
path, and walk home. You can bait a chaser away from a chest, break LOS around a maze
corner, or sneak past a room whose patrol faces away — with zero facing/alert-meter code.

---

## 9. Difficulty Scaling & Content Tables

### 9.1 Enemy stat scaling (exact)

All enemy stat blocks in data are **floor-1-normalized** (the combat.md §9 reference
enemies are the tier-1 blocks verbatim). At encounter creation, scale by the floor number:

```
HP(f)  = floor(baseHP  * (1 + 0.20 * (f - 1)))
ATK(f) = floor(baseATK * (1 + 0.12 * (f - 1)))
DEF(f) = baseDEF + floor((f - 1) / 2)
SPD(f) = baseSPD + floor((f - 1) / 3)
LCK, weakTag, resistTag, temper, skills: unchanged
```

Sewer Rat (base 24/9/3/11/0) across the run: floor 1 → 24/9/3/11, floor 3 → 33/11/4/11,
floor 6 → 48/14/5/12. With the combat divisor formula this keeps time-to-kill roughly flat
*if* the party keeps eating stat treats (§9.4) — the intended pressure to open chests.

### 9.2 Enemy roster by tier (threat cost, rowPref)

Tier 1 stats are combat.md §9; tiers 2–3 are complete here (same 4-decision identity:
weak/resist/temper/rowPref, plus one signature skill in the combat skill data model).

**Tier 1 — The Sewers (floors 1–2)**

| Enemy | Threat | Row | weak / resist | Temper | Signature skill |
|---|---|---|---|---|---|
| Sewer Rat | 1 | front | pounce / yowl | bully | Gnaw (bite, melee, 100) |
| Dust Bunny | 1 | front | claw / bite | feral | Choking Puff (bite, melee, 60, 30% Gunk) |
| Rat Piper | 2 | back | yowl / claw | coward | Sour Note (yowl, reach, 80, 70% Gunk) |
| Alley Toad | 2 | back | trick / pounce | hunter | Tongue Slap (bite, reach, 90, pull, cd 1) |

**Tier 2 — The Cellar (floors 3–4)** — bases (HP/ATK/DEF/SPD/LCK):

| Enemy | Base | Threat | Row | weak / resist | Temper | Signature skill |
|---|---|---|---|---|---|---|
| Moth Swarm | 18/8/1/12/0 | 1 | front | yowl / claw | feral | Dusty Flap (bite, melee, 70, 30% Gunk) |
| Cellar Spider | 26/12/4/10/5 | 2 | back | claw / trick | coward | Web Spit (trick, reach, 70, pull, cd 1) |
| Cucumber Creep | 30/11/5/7/0 | 2 | front | pounce / bite | bully | Lurking Menace (yowl, reach, 80, cd 1) |
| Grumpy Raccoon | 44/13/7/8/5 | 3 | front | trick / pounce | hunter | Trash Lid (claw, melee, 110, push, cd 1) |

**Tier 3 — The Deep Basement (floors 5–6)**

| Enemy | Base | Threat | Row | weak / resist | Temper | Signature skill |
|---|---|---|---|---|---|---|
| Sprinkler Imp | 28/12/4/13/5 | 2 | back | trick / yowl | feral | Cold Spray (trick, reach, 80, 50% Gunk) |
| Mirror Cat | 32/13/5/11/10 | 2 | front | bite / pounce | coward | False Pounce (pounce, melee, 100, self-back) |
| Vacuum Wraith | 38/14/6/9/0 | 3 | back | yowl / bite | hunter | Terrible Hum (yowl, reach, enemy-row, 70, cd 2) |
| Stray Hound Pup | 50/15/8/10/0 | 4 | front | pounce / claw | bully | Snap (bite, melee, 120, cd 1) |

12 regular enemies total — exactly combat.md's content budget.

### 9.3 Encounter budget in play

Threat/encounter (§1 table) × roamer count gives the floor's total pressure; because packs
are drawn until the budget is spent, floor 1 packs are 2–3 weenies while floor 6 packs are
"Hound Pup + support" or four-wide swarms — combat.md's 2–4 enemy sweet spot throughout.
Players can always *see* which packs to dodge; clearing everything is optional but pays in
loot rolls and bestiary fills.

### 9.4 Loot (exact tables, weights sum 100)

Items map to combat statuses per combat.md §6. **Stat Treat**: on pickup, choose a cat and
a flavor — permanent `+1 ATK`, `+1 DEF`, `+1 SPD`, `+1 LCK`, or `+4 max HP` (also heals 4).
This is the entire meta-progression inside a run, countering §9.1's enemy scaling.

| Table | Contents (weight) |
|---|---|
| **Chest, common** (floors 1–4; 2 draws/chest) | Tuna Snack 30 (heal 40% of a cat's max HP), Stat Treat 30, Sardine Tin 15 (heal 100%), Catnip Sprig 15 (Zoomies 2 turns, in-battle item), Cucumber 10 (guaranteed Startle, once/battle) |
| **Chest, deep** (floors 5–6; 2 draws/chest) | Stat Treat 40, Sardine Tin 20, Tuna Snack 15, Cucumber 15, Catnip Sprig 10 |
| **Post-battle victory** (1 draw, `lootSeed`) | Nothing 30, Tuna Snack 40, Catnip Sprig 15, Cucumber 15 |
| **Boss hoard** (fixed, no rolls) | 2 Stat Treats + 1 Sardine Tin + unlocks stairs |

Inventory is a shared party pouch, cap 8 items (excess: pick what to drop). Items are
usable from the pause menu (heals) or in battle via the Item action (combat.md §6).

### 9.5 Bosses (complete definitions, combat.md §10 rules)

| | **Rat King** (floor 3) | **The Basement Hound** (floor 6) |
|---|---|---|
| Stats | HP 260, ATK 14, DEF 6, SPD 9, LCK 5 | HP 480, ATK 18, DEF 9, SPD 8, LCK 5 |
| weak / resist (phase 1) | yowl / bite | trick / claw |
| Phase 2 (≤50% HP) | weak → pounce ("The crown slips!") | weak → yowl ("Its ears flatten!") |
| Temper | hunter | bully |
| Charge (every 3rd round) | Verminous Chorus — yowl payload, power 110, all cats | Howl of the Deep Dark — power 130, all cats |
| Summon (cd 3, ≤2 alive) | 2× Sewer Rat | 2× Moth Swarm |
| Other skills | Gnaw Royale (bite, melee, 120), Piper's Call (yowl, reach, 80, 50% Gunk, cd 1) | Snap (bite, melee, 130), Slobber (trick, reach, 90, 70% Gunk, cd 1) |

Both follow all §10 boss rules: push/pull converts to Ruffled, Poise Break at 3 weakness
hits/round, Broken counts as Startled for Cat Pile, charge cancelled by any yowl hit,
no fleeing. Summoned minions are scaled to the current floor like any enemy.

---

## 10. Boss Floors (differences only)

1. Fewer roamers (§1 table) — the floor is an approach, not a gauntlet.
2. The **exit room is the arena**: boss at center, stairs-down locked inside it, any
   chests that landed there (§6.3) are its visibly guarded hoard.
3. The boss entity does not patrol or chase (`waypoints` empty, state locked to `patrol`,
   move ticks skipped) — it is a landmark you walk into, drawn 2 tiles wide with a red
   glow visible the moment the room lights up.
4. Trigger: the party's first step onto any tile of the boss room starts the battle. There
   is no sneaking past; there IS walking away — the trigger only fires on room entry, so
   you can leave to clear roamers or pop an event first (but you cannot descend).
5. Victory: boss hoard popup (§9.4), stairs unlock, roamers still alive stay alive.

---

## 11. Worked Example — `runSeed 20260709`, floor 1 (real generator output)

Every number below is actual output of the reference implementation of §5–§6 (a ~200-line
prototype), reproducible from the seed. `floorSeed = mix(20260709, 1) = 1915275630`.

```
Legend: # wall   . floor   + door   < stairs-up (spawn)   > stairs-down
        C chest   ? event sparkle   1-5 roamer packs (glyph simplified to index)

#########################
#######.........+.#######
#######.........#+#######
#######2.......?#.....4.#
##########+#+####.......#
#######.+.....+C#.......#
#######.#.....######+##+#
##......#3....#>........#
##+############......1..#
#.......#.....#.........#
#.......#####+#########+#
#...<...#.....+.#.......#
#.......#.....#.#.#####.#
#.......+.5...#...#.....#
#+##########+######.#####
#......................C#
#########################
```

Six rooms survived the 60 attempts:

| Room | Rect (x,y,w,h) | Role |
|---|---|---|
| 0 | (9,11) 5×3 | roamer 5's den |
| 1 | (15,7) 9×3 | **EXIT** — farthest room, BFS dist 39 from spawn; `>` at its deepest tile (15,7) |
| 2 | (7,1) 9×3 | event room (`?` at (15,3)) + roamer 2 |
| 3 | (1,9) 7×5 | **ENTRANCE** — `<` at center (4,11) |
| 4 | (17,3) 7×3 | roamer 4 |
| 5 | (9,5) 5×3 | roamer 3 |

Three nooks were preserved by the 25% rolls: (15,5), (9,9), (23,15). The two deepest get
the floor's 2 chests: `C`(23,15) at dist 23 — the long bottom corridor's dead end — and
`C`(15,5) at dist 21, one tile from a door. The nook at (9,9) stays empty (chest budget
spent): a red herring cul-de-sac, working as intended.

Roamer packs (threat budget 3 each, tier 1):

| # | Tile | Home | Pack (rows) | Battle seed |
|---|---|---|---|---|
| 1 | (21,8) | room 1 | Rat Piper + Sewer Rat (B, F) | `mix(floorSeed, 1000+id)` |
| 2 | (7,3) | room 2 | Dust Bunny + Alley Toad (F, B) | " |
| 3 | (9,7) | room 5 | Dust Bunny + Alley Toad (F, B) | " |
| 4 | (22,3) | room 4 | Dust Bunny ×2 + Sewer Rat (F, F, F) | " |
| 5 | (10,13) | room 0 | Rat Piper + Sewer Rat (B, F) | " |

How this floor plays: the party spawns at `<` with the whole entrance room lit. Three ways
out — the door at (2,8) north, the door at (8,13) east toward roamer 5's den, or the door
at (1,14) to the long south corridor. The south corridor is the quiet route to chest
(23,15) and up the right side toward the exit — but roamer 1 patrols the exit room itself,
so the Piper pack must be fought (or baited out through the (20,6) door and dodged) to
descend. The event sparkle sits behind roamer 2's patrol in the top room; the chest at
(15,5) is one greedy step from roamer 3's line of sight through the (14,5) door. Roamer 4
guards nothing — a pack you can simply never meet, or ambush (bump = +1 Vigor start) for a
loot roll and bestiary entries.

For contrast, the same seed's **floor 3** (31×21, boss floor) generates the Rat King in
exit room (25,7) 5×5 at center (27,9), stairs-down locked at (25,11) inside the arena, and
— via §6.3's no-exclusion rule — 2 of its 3 chests inside the boss room as a guarded hoard,
with the third at (19,8) mid-floor. Verified output; not reproduced in full here.

---

## 12. Determinism Contract & Edge Cases

- Same `runSeed` → byte-identical floors, packs, loot, and battle seeds, **independent of
  player behavior** (all rolls happen at generation; exploration and grid AI are RNG-free).
- Rejected room attempts still consume their 4 rolls; chest/event placement attempts
  consume 3 rolls each, accepted or not (§6.3–6.4). This is what makes the streams stable.
- A fled-from roamer keeps its `EncounterDef` and `battleSeed`; re-engaging replays the
  same enemies but a **fresh battle stream is NOT reseeded** — combat.md seeds per
  encounter id, so the rematch draws the same stream from the start. Enemy HP resets on
  flee (the pack licks its wounds); party HP does not.
- Multiple simultaneous contacts (phase 4): lowest entity id fights; the others remain and
  will trigger immediately after the battle unless dead/stunned/moved — chain fights next
  to two packs are possible and intended punishment.
- A roamer can never occupy or path through another entity's tile, so packs cannot stack;
  in degenerate corridors a chaser simply waits, which reads as "blocking the way".
- Auto-walk is a pure input macro: it replays synthetic key steps through the normal step
  loop, so it cannot desync anything.
- Floors are generated on descent and discarded on the next descent; a save = `runSeed`,
  floor number, party state, inventory, bestiary, lives, plus current-floor deltas
  (explored bitmap, opened/consumed/dead entity ids, party position, roamer positions
  and states).

---

## 13. Implementation Budget (~1,220 LoC, PixiJS Graphics/Text only)

| Module | Est. LoC | Notes |
|---|---|---|
| `dungeon/gen.ts` — §5 steps 1–5, validation | 260 | pure, returns tiles+rooms+nooks |
| `dungeon/populate.ts` — §6, encounter building, loot pre-roll | 140 | pure |
| `dungeon/types.ts` + `data/floors.ts` — shapes, tier/loot/boss tables | 90 | plain data |
| `explore/step.ts` — step loop, contact/trigger resolution | 110 | pure-ish core |
| `explore/party.ts` — input, tween, click-path (BFS), auto-walk | 140 | |
| `explore/visibility.ts` — Bresenham LOS, torch+room reveal | 90 | |
| `explore/roamers.ts` — §8 state machine, grid BFS | 120 | no RNG |
| `explore/render.ts` — tile layer, fog overlay, entities, camera | 190 | Graphics + Text |
| `explore/minimap.ts` — RenderTexture minimap | 80 | |
| `explore/interact.ts` — chest/stairs/event/battle handoff, loot popup | 100 | |

The generator prototype used to produce §11 doubles as the unit-test fixture: assert the
exact floor-1 tile grid and entity list for `runSeed 20260709`.

---

## Appendix: Decisions & Rationale (quick reference)

- **Rooms-in-a-maze over BSP:** the pitch says maze; BSP gives corridor *trees*. This
  algorithm gives rooms, loops (8% extra doors), windy halls (0.40 straightness), and
  chest-bearing dead ends (25% nook survival) with zero failure-prone steps.
- **Visible roamers over random encounters:** chosen per task direction; also feeds the
  ambush Vigor bonus and makes threat legible on the minimap.
- **Step-based world over real-time:** determinism for free, no pathfinding smoothing, and
  fairness — the world never moves while you think.
- **Room-flash + radius-2 torch fog:** classic roguelike readability; whole-room reveal
  makes rooms feel like discoveries, tight corridor light keeps the maze tense; needs only
  Bresenham.
- **All RNG at generation time:** one contract shared with combat (`battleSeed` per
  entity), no savescum surface, replayable/shareable seeds on the HUD.
- **6-floor run, bosses at 3 and 6:** matches combat.md's shipped content ("~12 enemies,
  2 bosses") exactly; the §1 table's formulas extend it later without redesign.
- **Stat Treats as the only in-run progression:** counters the §9.1 enemy scaling curve
  without an XP/level system (combat.md has none), and turns every chest — and therefore
  every preserved dead end — into a build decision.
