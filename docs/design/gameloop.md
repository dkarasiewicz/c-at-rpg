# c(at)rpg Game Loop & Meta Structure — FINAL DESIGN
## "The Descent of the Clowder" (Claws & Ranks edition)

Companion to `combat.md` ("Claws & Ranks: Nine Lives Edition" — the single source of
truth for battle). This document is the single source of truth for everything OUTSIDE a
battle: the scene state machine, run structure, floor budgets, rest/heal rules, defeat
and scoring, pause, saving, and meta-progression. Every number is exact. Target: ~850
additional LoC on top of the ~1500 LoC combat engine.

Design pillars:

1. **One run = one sitting** — 35–45 minutes, 6 floors, bosses on 3 and 6, done.
2. **Attrition is the meta-game** — HP and each cat's 9 Life pips are the only things
   the dungeon erodes; camps refill exactly enough to make floor pacing a resource
   decision. Energy is battle-scoped (always starts at 4, per combat.md §5) and never
   touches the loop layer.
3. **Everything is a state** — one flat state machine, one active scene, overlays never
   stack more than one deep. No scene talks to another except through `RunState`.
4. **Same seed, same run** — floor layouts, encounters, loot, and events all derive from
   the run seed, satisfying combat.md §3's battle-stream contract. A shared seed is a
   shared dungeon.

---

## 1. Top-Level State Machine

> **SUPERSEDED IN PART — `run-map-and-dm.md` §2 (the run map).** The `EXPLORE`
> state below is now `RUN_MAP`: the floor is a route graph, not a tile maze, so
> "touch an encounter entity / step on an event tile / open a chest / step on the
> stairs" all become "walk into a node of that type". `CAMP` is the LANDING
> scene, which a mid-floor **shop node** also borrows (returning to `RUN_MAP`
> instead of descending). REST and TREASURE nodes resolve inside `RUN_MAP`
> itself — an in-scene catnap panel and the `LOOT` overlay — so neither is a
> state. Everything else on this page (overlay rules, autosave points, scoring,
> pause, save) stands unchanged; the shipped table lives in
> `src/ui/sceneManager.ts`.

One global `GameStateMachine` owns a single active scene plus at most one overlay.
States and their complete transition table:

```
BOOT ──────────────► TITLE
TITLE ─(New Run)───► RUN_INIT ──► FLOORGEN ──► EXPLORE
TITLE ─(Continue)──► RUN_LOAD ───────────────► EXPLORE
EXPLORE ─(touch encounter entity)──► BATTLE
EXPLORE ─(step on event tile)──────► EVENT
EXPLORE ─(open chest)──────────────► LOOT (overlay)
EXPLORE ─(step on stairs, unlocked)► CAMP
BATTLE ─(victory)──► LOOT (overlay) ──► EXPLORE   // Nine Lives bookkeeping already done by combat
BATTLE ─(flee ok)──► EXPLORE                      // no loot; encounter entity remains (combat.md §12)
BATTLE ─(defeat: all living cats KO'd)──► RESULTS(defeat)
EVENT ─(option resolved)──► EXPLORE               // or ──► BATTLE if the outcome is an ambush
CAMP ─(Descend)──► FLOORGEN ──► EXPLORE           // after floors 1–5
Floor 6 has no CAMP: killing the final boss ──► RESULTS(victory)
RESULTS ─(Again / New Seed)──► RUN_INIT           // same or fresh seed
RESULTS ─(Title)──► TITLE
ANY (except BOOT/RESULTS) ─(Esc)──► PAUSE (overlay) ─(Esc/Resume)──► back
PAUSE ─(Abandon Run)──► RESULTS(defeat, cause:'abandoned')
```

Rules:

- `RUN_INIT`/`RUN_LOAD`/`FLOORGEN` are real (instant, <16 ms) states so their logic has
  one home. `FLOORGEN` derives the floor seed, builds the maze, places entities with
  pre-rolled payloads, autosaves, then hands off. It renders one frame of
  "Descending… Floor N — <floor name>" text (also masks any GC hitch).
- Overlays (`LOOT`, `PAUSE`) render on top of the frozen underlying scene: the scene's
  ticker update is skipped and `stage.interactiveChildren = false` beneath the overlay.
  `PAUSE` cannot open over `LOOT`; Esc closes loot first.
- `BATTLE`, `EVENT`, `CAMP`, `RESULTS` are full scene swaps (previous scene destroyed).
  `EXPLORE` is rebuilt from `RunState.floor` on re-entry — no scene is ever kept alive
  in the background except under an overlay.
- `BATTLE` constructs its `BattleState` from `RunState` (party in marching order →
  cat ranks 1–4, per combat.md §1) and on exit writes back only: per-cat `hp` and
  `lives`, score counters, and the victory loot bundle. Everything else in battle is
  battle-scoped (energy, statuses, cooldowns — combat.md §5, §6, §12).

### Scene/Screen list (exactly what the UI team builds)

| Id | Kind | Contents |
|---|---|---|
| `boot` | scene | Black screen, procedural paw-print logo, "click to start" (satisfies browser pointer/audio-unlock requirements). No asset loading — everything is procedural. |
| `title` | scene | Logo, menu: **New Run** / **Continue** (shown only if a valid save exists) / **Records**. Seed input field (blank = random). The Records panel shows lifetime stats and the meta-unlock skill toggles (§8). |
| `floorgen` | scene | One frame of transition text + floor name. |
| `explore` | scene | Tile map, party marker (stack of 4 tiny cat blobs), entities, fog of war, HUD: 4 cat portraits with HP bars + Life paw-pips (combat.md §12's pips, always visible), item belt, floor label, seed, minimap toggle (M). |
| `battle` | scene | Exactly combat.md §14's `battle/ui.ts`: rank slots, initiative timeline, skill bar, Poise counter, Cat Pile prompt, etc. |
| `loot` | overlay | Panel listing gained shinies/items, "Take All" (Enter/click). Used for chests and post-battle victory loot alike. |
| `event` | scene | Scenario text on a procedural parchment panel, 2–3 option buttons (keys 1–3), then the outcome line, then "Continue". |
| `camp` | scene | Campfire drawing, per-cat heal numbers floating up, ONE boon pick (§4), marching-order editor for the next floor, **Descend** button. |
| `results` | scene | Victory or defeat banner + full score breakdown (§7). |
| `pause` | overlay | §6: Resume / Party / Inventory / Help / Abandon Run. |

**Ten screens total**; `loot` and `pause` are cheap panels, not scenes. (The old
bestiary screen is cut: the new combat system has no weak/resist affinities to
discover — combat.md §15 — so a bestiary would be a kill-count list nobody opens.)

---

## 2. Run Structure — 6 Floors, Bosses at 3 and 6

| Floor | Name (flavor) | Type | Combats | Events | Chests | Enemy pool |
|---|---|---|---|---|---|---|
| 1 | The Cellar | normal | 3 | 1 | 2 | Tier 1 |
| 2 | The Drains | normal | 4 | 1 | 2 | Tier 1 + Tier 2 |
| 3 | The Appliance Graveyard | **BOSS** | 2 | 1 | 2 | Tier 2; boss: mid-boss pool (see below) |
| 4 | The Undergarden | normal | 4 | 2 | 3 | Tier 2 + Tier 3 |
| 5 | The Cold Pantry | normal | 5 | 2 | 3 | Tier 3 |
| 6 | The Hollow Throne | **FINAL BOSS** | 2 | 1 | 1 | Tier 3; boss: **The Hound Below** |

- **Win condition:** kill the floor-6 boss → `RESULTS(victory)`. There is no floor 7.
- **Boss budget = 3 datasets**, matching combat.md §14's content budget ("3 bosses"):
  the floor-3 slot draws one of TWO mid-bosses by seeded roll — **The Vacuum King**
  (combat.md §11's worked example: heavy, Poise 3, 140 HP, double turn, MAX SUCTION
  phase 2) or **The Rat Prince** (heavy, Poise 3, 120 HP, summons rank-5 rats) — and
  floor 6 is always **The Hound Below** (heavy, Poise 4, 200 HP, double turn, phase
  switch at 50%, telegraphed row nuke). Two possible mid-bosses give runs variety for
  the price of one extra data object.
- **Boss floors:** the stairs-down tile (floor 3) / throne tile (floor 6) sits behind a
  visibly locked door; the door opens the instant the boss dies. The boss is a visible,
  unavoidable entity blocking the door corridor. The 2 normal combats on boss floors
  are avoidable side-room guards. **No fleeing from boss battles** (combat.md §11).
- Combat count is **encounter entities placed**, all visible on the map — no random
  battles. This is required by combat.md §12's flee rule ("party returns to the room
  entrance, the encounter entity remains"). Roughly half the encounters block
  corridors (fight or route around), half guard chests (optional).
- **Encounter composition** is data, in exactly the shape combat consumes (a
  front-to-back array, combat.md §1): `EncounterTable = { floor: number, entries:
  { enemies: EnemyId[]; weight: number }[] }`, 4–6 entries per floor, picked by seeded
  weighted roll at floorgen. Sizes: floors 1–2 → 2–3 enemies, floors 4–5 → 3–4
  enemies, bosses → boss alone or boss + 1 minion (per boss data; summons handle the
  rest). Rank-5 slots only ever appear via boss summons.
- **Enemy scaling:** none by formula — enemies are fixed stat blocks per tier:
  Tier 1 = 4 species (Rat Thug, Dust Bunny, Cellar Toad, Crow Shaman), Tier 2 = 3
  (Sewer Brute, Moth Prophet, Wind-Up Mouse), Tier 3 = 3 (Freezer Wraith, Pantry
  Ogre, Hollow Kitten) — 10 species total, matching combat.md §14's "~10 enemies".
  Tier-2/3 species include shovers (`moveTarget` skills) so the enemy side plays the
  Off-Paw game back at the player (combat.md §8).
- **Expected pacing:** ~14 placed normal fights (≈10 actually fought) + 2 bosses at
  ~2 min each, plus exploration/events/camps ≈ **35–45 min per full run**.

### Seeding (determinism contract — satisfies combat.md §3)

```
runSeed    : number   // user-entered or (Date.now() >>> 0); shown on HUD, title, results
hash32(a,b): one xorshift-multiply mix round (same helper combat.md's hash uses)
floorSeed          = hash32(runSeed, floorNo)
battleSeed(enc)    = hash32(floorSeed, encounterIndex)     // == combat.md's
                     // mulberry32(hash(runSeed, floor, encounterIndex)) contract
floorRng           = mulberry32(hash32(floorSeed, 1))      // layout, placement, loot,
                                                            // event picks, boss pick
```

The floor stream is consumed in one fixed order at generation: layout → entity
placement → encounter picks → chest payload rolls → event picks/outcome pre-rolls →
(floor 3 only) mid-boss pick. **Chest and event results are pre-rolled at floorgen and
stored on the entity**, so runtime interaction order can never desync determinism and
saves stay trivially small. Exploration itself consumes zero RNG.

---

## 3. Exploration Rules (minimal, exact)

- Tile grid, 4-direction step movement, arrows/WASD; hold to repeat at 8 tiles/s. The
  party is ONE marker. Mouse click on an explored tile path-walks to it (BFS, fixed
  neighbor order N,S,W,E; stops when adjacent to any entity).
- Tiles: `floor`, `wall`, `door(locked?)`, `stairs`, plus entities standing on tiles:
  `encounter`, `chest`, `event`, `bossDoor`. Walking into an entity triggers it.
- **Fog of war:** tiles within Chebyshev radius 4 become explored (dim when out of
  radius, lit when in). Entities render only on explored tiles. Minimap (M) shows
  explored tiles + entity dots.
- Exploration never costs HP/resources and never heals — all attrition and recovery
  happen in battles, events, items, and camps. From the belt during exploration the
  player may use **Tuna Snack only** (heal 12 HP to one chosen cat, same number as its
  in-battle use, combat.md §9). Catnip, Cucumber, and Feather Wand are battle-only
  (they map to energy/Frazzled/revive, which don't exist outside battle).
- Maze generation specifics (algorithm, grid sizes, room/corridor style) are owned by
  `dungeon.md`; this document only fixes the per-floor entity budgets above.

---

## 4. What Persists, and the Camp (rest rules)

**Within a run** (fields of `RunState`, §9): per-cat HP and Lives (0–9 pips each,
combat.md §12), marching order, inventory, shinies, floor number, per-floor entity
states, score counters, seeds, play time. Per combat.md: energy and statuses never
leave a battle (energy re-enters every fight at 4); HP persists between fights; after
a **won** battle each still-KO'd cat stands up at 1 HP and loses 1 Life; a cat at 0
Lives is **gone for the rest of the run** (its party slot disappears, marching order
compresses).

**Camp (between floors, automatic + one choice).** Stepping on unlocked stairs enters
`CAMP`:

1. Every living cat heals `floor(0.30 * maxHP)` automatically (fire crackle,
   floating +N). Cap at maxHP.
2. Player picks exactly ONE camp boon (buttons, keys 1–3):
   - **Deep Nap** — every living cat heals an additional `floor(0.20 * maxHP)`.
   - **Night Patrol** — the next floor generates with its full map pre-explored (dim;
     entities visible on the minimap). Fog still gates the lit radius.
   - **Pack Snacks** — gain 2 Tuna Snacks.
3. Player may reorder the marching order for the next floor (click-swap or 1–4 keys).
   This IS the battle formation: combat.md §1 seats cats in ranks 1–4 straight from
   marching order. (Marching order is also editable any time from the pause menu's
   Party tab — changing it costs nothing outside battle.)
4. **Descend** → `FLOORGEN(floorNo + 1)`.

**No Life regeneration at camp, ever.** Life pips only come back through one rare
shrine event (`life +1`, §9 — the hook combat.md §12 reserves for the dungeon layer).
Total passive healing across a run is 5 camps × 30–50% maxHP: substantial but never
full. Entering a boss floor topped-off means you spent your boons on Deep Naps and
walked in blind with no spare snacks — floor pacing is the resource game.

**Between runs:** only `MetaFile` (§8) persists. Everything else resets.

---

## 5. Defeat Rules

Exactly combat.md §12, restated for the loop layer:

- **A run ends immediately when every remaining cat is KO'd in one battle.** "Remaining"
  = not yet gone; the run legally continues with 3, 2, or even 1 cat after deaths
  (ranks compress, per combat.md §12).
- A cat's **death** (0 Lives after a won battle's KO conversion) does not end the run
  by itself — but if the roster hits 0 living cats, the run ends.
- In-battle revival (Nine Lives Nudge, Feather Wand) prevents the post-battle Life
  loss — the loop layer never sees the KO.
- Fleeing ("Scatter!", combat.md §12) is always available outside boss fights; the
  encounter entity remains and can be routed around if the maze allows.
- **Abandon Run** (pause menu, confirmation required) = defeat with
  `cause:'abandoned'`; score is computed normally and the autosave is deleted.
- On defeat the battle scene plays a 1.5 s "the clowder scatters…" beat, then
  → `RESULTS(defeat)`.

---

## 6. Pause Menu (Esc)

Vertical panel, keyboard + mouse:

1. **Resume** (Esc/Enter)
2. **Party** — up to 4 cat cards: class, stats (combat.md §3's six), current/max HP,
   Life pips, skill list with energy costs and full tooltips; marching-order editor
   (disabled while a battle scene is beneath the overlay).
3. **Inventory** — item list with descriptions and counts (use is contextual — belt in
   explore, Item action in battle — not from here).
4. **Help** — one static page: controls + the Off-Paw → Off-Balance → Cat Pile loop
   explained in 6 lines.
5. **Abandon Run** — confirm → `RESULTS(defeat)`.

Footer: run seed (click to copy), floor, play time. Pausing fully freezes the
underlying scene. During battle, pause opens only during the input phase (never
mid-animation — the resolver is synchronous anyway, combat.md §14).

---

## 7. Results Screen & Score

Shown on both victory and defeat. Contents, top to bottom:

1. Banner: **"THE CLOWDER PREVAILS"** / **"NINE LIVES WEREN'T ENOUGH"** (defeat), plus
   a cause line: `slain by <enemy> on floor N` / `abandoned on floor N`.
2. The cat blobs: survivors sitting, dead cats (0 Lives) as little ghosts, each with
   its remaining Life pips.
3. Score table, tallied line by line with a count-up:

```
floors fully cleared         × 100     // every encounter entity on the floor dead
floors reached               × 50      // deepest floor entered
enemies defeated             × 10
bosses defeated              × 300
shinies collected            × 5       // score-only currency from chests/loot/events
Cat Piles triggered          × 20      // celebrates the signature system
lives remaining (sum, all cats) × 25   // victory only; max 36 → up to 900
VICTORY BONUS                  1000    // victory only
TOTAL
```

4. Records line from `MetaFile`: `best score`, `fastest victory`, `victories`,
   `runs played` — with "NEW BEST!" flair when beaten.
5. Meta-unlock notification if a milestone was just hit (§8).
6. Buttons: **Again (same seed)** / **New Seed** / **Title**.

No time bonus or penalty — play time is displayed but never scored (no incentive to
rush a tactics game).

---

## 8. Meta-Progression — KEEP, but tiny (decision)

**Decision: keep**, sized at ~60 LoC + 4 data objects. Rationale: the roguelike loop
needs *something* to notice between runs, and alternate skills are pure data in
combat.md §4's existing `Skill` interface — zero new engine code. Anything bigger
(currencies, stat upgrades, extra classes, starting items) is cut: it would demand
balance passes the budget doesn't have.

Exactly **4 unlocks** — one alternate skill per class. Each replaces the class's
**third skill slot** (the slot NOT in combat.md §4's reference set, defined in
`classes.md`), toggled per-class on the Title → Records panel; the choice persists in
`MetaFile.loadout`. Full data, in combat.md's `Skill` shape:

| Unlock id | Milestone | Class | Alternate skill |
|---|---|---|---|
| `bruiser-alt` | Defeat a floor-3 boss (any run) | Bruiser | **Bulwark Purr** — cost 2, usableFrom [1,2], target self, power 0, applies Guarded (chance 1.0) + Mending (value 3, chance 1.0). |
| `trickster-alt` | Trigger 5 Cat Piles (lifetime) | Trickster | **Ankle Bite** — cost 3, usableFrom [1,2], target enemy [1,2] single, power 90, applies Scratched (value 2, chance 0.8), moveSelf +1 (hit and hop back). |
| `hexer-alt` | Defeat 40 enemies (lifetime) | Hexer | **Static Fur** — cost 5, usableFrom [3,4], target enemy [1,2] single, power 50, applies Frazzled (chance 0.7; respects combat.md §6's no-reapply rule). |
| `medic-alt` | Win a run | Medic | **Group Groom** — cost 5, usableFrom [3,4], target ally ranks [1,2,3,4] **row**, power 60 (heal each). |

Milestone counters live in `MetaFile.counters` and are numbers the score screen
already tracks — no extra bookkeeping paths.

---

## 9. Save System — KEEP: localStorage autosave (decision)

**Decision: keep.** A 40-minute run in a browser tab without a save is hostile; the
whole game state is already plain data, so this is ~80 LoC. Rules:

- **Autosave points** (never mid-battle, never mid-event): after `FLOORGEN`, after
  every battle resolution (victory loot taken / successful flee), after every event
  outcome, after chest loot taken, on `CAMP` descend. Writes are synchronous
  `localStorage.setItem` of one JSON blob (<20 KB) — imperceptible.
- **Mid-battle quit/close:** the save predates the battle, so Continue restores the
  party adjacent to the encounter entity with pre-battle HP/Lives. Retrying a fight
  costs nothing but honesty — accepted for scope (mid-battle event-log saves are
  explicitly out of budget).
- **Continue** appears on the title screen iff `catrpg.save.v1` exists and its
  `version` matches; mismatched versions are silently deleted (no migrations in v1).
- The save is deleted on `RESULTS` entry (both outcomes) and on Abandon.
- `MetaFile` (`catrpg.meta.v1`) is written on every `RESULTS` entry and whenever a
  loadout toggle changes.

### Exact data shapes

```ts
// localStorage 'catrpg.save.v1'
interface SaveFile {
  version: 1;
  runSeed: number;
  floorNo: number;                    // 1..6
  playTimeMs: number;
  party: SavedCat[];                  // fixed length 4, fixed class order
                                      // [bruiser, trickster, hexer, medic]
  marchingOrder: number[];            // party indices front→back; living cats only
  inventory: { itemId: ItemId; qty: number }[];
  shinies: number;
  score: ScoreCounters;
  floor: FloorSnapshot;               // current floor only; old floors are gone
}

interface SavedCat {
  classId: ClassId;                   // 'bruiser' | 'trickster' | 'hexer' | 'medic'
  hp: number;                         // 0 never occurs at save time (post-battle standup)
  lives: number;                      // 0..9; 0 = gone for the run (combat.md §12)
}
// maxHP/stats/skills derive from class data + MetaFile.loadout — never serialized.

interface ScoreCounters {
  floorsCleared: number; enemiesDefeated: number; bossesDefeated: number;
  catPiles: number; shiniesCollected: number;   // shiniesCollected = lifetime-this-run
}                                               // (score uses this; `shinies` is spendable
                                                //  if loot.md adds a shop, else equal)

interface FloorSnapshot {
  floorSeed: number;
  partyPos: { x: number; y: number };
  explored: string;                   // base64 bitset, width*height bits
  entities: SavedEntity[];            // tiles regenerate from floorSeed; entities carry state
}

interface SavedEntity {
  id: number;                         // placement-order index (stable per seed)
  kind: 'encounter' | 'chest' | 'event' | 'stairs' | 'bossDoor';
  x: number; y: number;
  state: 'intact' | 'consumed';       // killed / opened / resolved / unlocked
  payload?: LootBundle                // chests (pre-rolled at floorgen)
          | EventId                   // events (outcome pre-rolls stored with it)
          | { enemies: EnemyId[]; isBoss: boolean; canFlee: boolean };  // encounters,
                                      // enemies = front-to-back array per combat.md §1
}

interface LootBundle { shinies: number; items: { itemId: ItemId; qty: number }[]; }

// localStorage 'catrpg.meta.v1'
interface MetaFile {
  version: 1;
  unlocks: UnlockId[];                          // e.g. ['bruiser-alt']
  loadout: Record<ClassId, 'base' | 'alt'>;
  counters: { catPiles: number; enemiesDefeated: number; bossesDefeated: number;
              victories: number; runs: number };
  records: { bestScore: number; fastestVictoryMs: number | null };
}
```

`RunState` (the in-memory object every scene reads/writes) is `SaveFile` minus
`version`, plus derived caches (full cat objects with stats/skills, live tile map).
Serialize = strip caches; deserialize = rebuild tiles from `floorSeed`, overlay entity
states. Battles construct `BattleState` from `RunState` and write back only per-cat
`hp`/`lives`, `score`, and loot.

### Items (v1 list — closed set, from combat.md §4/§9)

| ItemId | Effect | Usable |
|---|---|---|
| `tuna-snack` | Heal 12 HP, one cat | battle + exploration belt |
| `catnip` | +2 energy to an ally | battle only |
| `feather-wand` | Revive a KO'd ally at 25% maxHP (skips the Life loss) | battle only |
| `cucumber` | Guaranteed Frazzled on one enemy, once per battle (respects no-reapply and boss double-turn rules) | battle only |

Four items, all mapping to existing combat rules; item effects reuse the `Skill` shape
with `cost: 0` (combat.md §9). No equipment in v1 — loot is consumables + shinies
(decision logged in the appendix; `loot.md` must conform).

### Events (data shape, so the loop is complete)

```ts
interface GameEvent {
  id: EventId; title: string; body: string;     // ≤ 300 chars body
  options: {
    label: string;
    outcomes: { weight: number; text: string; effect: EventEffect }[];  // seeded,
  }[];                                          // pre-rolled at floorgen, 2–3 options
}
type EventEffect =
  | { kind: 'heal';    pct: number; who: 'all' | 'random' }  // ±pct of maxHP; negative = harm; never KOs (min 1 HP)
  | { kind: 'item';    itemId: ItemId; qty: number }
  | { kind: 'shinies'; amount: number }                      // may be negative (min 0)
  | { kind: 'life';    delta: 1 | -1; who: 'lowest' | 'random' }
      // +1: cat with fewest Lives (tie → front-most), cap 9. THE only Life gain in
      // the game (the shrine hook combat.md §12 reserves) — exactly one shrine event
      // in the pool. -1: random living cat, clamped at 1 — events never kill a cat.
  | { kind: 'ambush';  enemies: EnemyId[] };                 // → BATTLE, canFlee: false
```

Ship 10 events; each floor draws from the shared pool without repeats within a run
(pool order shuffled once per run from `hash32(runSeed, 999)`).

---

## 10. Implementation Budget (~850 LoC on top of combat)

| Module | Est. LoC | Notes |
|---|---|---|
| `game/fsm.ts` — state machine, scene registry, overlay handling | 90 | transition table from §1 |
| `game/run.ts` — RunState, hash32/seed tree, score counters, camp logic | 110 | pure, unit-testable |
| `game/save.ts` — (de)serialize, localStorage, MetaFile | 80 | |
| `dungeon/floorgen.ts` — maze gen, placement, pre-rolled payloads | 180 | consumes §2 tables; details in dungeon.md |
| `scenes/explore.ts` — tiles, movement, fog, minimap, entity triggers, HUD | 220 | biggest UI piece |
| `scenes/title.ts` + `boot.ts` + `results.ts` + `camp.ts` | 140 | mostly Text + panels |
| `scenes/event.ts` + `loot.ts` + `pause.ts` | 90 | panels |
| `data/floors.ts`, `data/events.ts`, `data/items.ts`, `data/meta.ts` | (data) | tables from §2, §8, §9 |

Grand total with combat.md's ~1500 engine LoC: **~2350 LoC + data** — inside the "few
thousand lines" constraint with headroom for polish.

---

## Appendix A: Decisions & Rationale (quick reference)

1. **6 floors, bosses at 3 and 6, mid-boss drawn from a pool of 2** — spends
   combat.md §14's 3-boss data budget on run variety instead of a third boss floor;
   keeps the run at one sitting; floor 3 gives the difficulty curve a spine and the
   meta its first milestone. Vacuum King stays on floor 3 per combat.md §11.
2. **Entity encounters, not random battles** — required by combat.md §12's flee rule;
   also makes routing a real exploration decision and lets loot guard itself.
3. **Camp = 30% auto-heal + one boon, no Life regen** — recovery keeps attrition
   survivable but Lives only ever tick down (one rare shrine event excepted),
   preserving combat.md's "accumulating dread at one integer per cat".
4. **Marching order = battle ranks, editable free outside battle** — combat.md §1
   seats ranks from marching order and calls party order "a defensive decision"; a
   separate pre-battle formation picker would duplicate UI for no added decision.
5. **Bestiary cut** — the affinity/probing game it served was cut in combat.md §15;
   a kill-count screen isn't worth a scene. Score's Cat Pile line replaces its
   "discovery" scoring niche.
6. **Meta-progression kept at 4 alt skills** — pure data in combat.md's Skill
   interface; milestones read counters the score screen already tracks. Anything
   larger cut.
7. **Autosave kept, pre-battle snapshot semantics** — 40-minute runs demand it;
   mid-battle saves rejected as out of budget, retry-on-reload accepted.
8. **Pre-rolled chest/event/encounter payloads at floorgen** — determinism independent
   of interaction order; SavedEntity stays one enum + payload.
9. **No equipment in v1** — loot = 4 consumables + shinies. Keeps SavedCat to two
   numbers and skips an equip UI; combat.md's item hooks (Catnip/Feather Wand/
   Cucumber) already give loot mechanical texture.
10. **No time scoring** — tactics game; time displayed, never scored.

## Appendix B: Companion-doc realignment notes (action items, not this doc's scope)

The current `dungeon.md`, `classes.md`, `events.md`, `loot.md`, and `ui-art.md` were
written against the superseded combat draft. When realigning them to `combat.md` +
this document, the breaking deltas are:

- **Lives are per-cat pips (0–9 each), not a shared pool 9-cap** — HUD, events, saves.
- **Energy replaces Vigor/MP/Moxie**; battle-scoped only, nothing to show in explore.
- **No affinities/weak/resist tags** → bestiary, scan verbs, and tag-reveal event
  effects must go.
- **Classes are Bruiser / Trickster / Hexer / Medic** with combat.md §4's skill shape
  (`usableFrom`, target ranks/pattern, `moveTarget`/`moveSelf`, energy costs).
- **Formation is single-file ranks 1–4 from marching order**, not front/back rows.
- **Statuses are Scratched / Frazzled / Off-Balance / Guarded / Provoked / Mending**
  (Startled/Zoomies/Shock etc. are gone); items map to the new list (§9 item table).
- **Bosses:** floor-3 pool {Vacuum King, Rat Prince}, floor-6 The Hound Below; boss
  data uses combat.md §11's `{ poise, doubleTurn, phases, windupSkills, summonSkillId }`.
- **Encounter payloads** are front-to-back `EnemyId[]` arrays (no `rows`), and battle
  seeds must follow §2's `hash32(hash32(runSeed, floorNo), encounterIndex)`.
