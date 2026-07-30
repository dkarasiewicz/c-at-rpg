# c(at)rpg Game Loop & Meta Structure — FINAL DESIGN
## "The Descent of the Clowder"

Companion to `combat.md` (single source of truth for battle). This document is the single
source of truth for everything OUTSIDE a battle: the scene state machine, run structure,
floor budgets, rest/heal rules, defeat and scoring, pause, saving, and meta-progression.
Every number is exact. Target: ~900 additional LoC on top of the combat engine.

Design pillars:

1. **One run = one sitting** — 30–45 minutes, 6 floors, 2 bosses, done.
2. **Attrition is the meta-game** — HP and the shared 9 Lives are the only things the
   dungeon erodes; camps refill exactly enough to make floor pacing a resource decision.
3. **Everything is a state** — one flat state machine, one active scene, overlays never
   stack more than one deep. No scene talks to another except through `RunState`.
4. **Same seed, same run** — floor layouts, encounters, loot, and events all derive from
   the run seed. A shared seed is a shared dungeon.

---

## 1. Top-Level State Machine

One global `GameStateMachine` owns a single active scene plus at most one overlay.
States and their complete transition table:

```
BOOT ──────────────► TITLE
TITLE ─(New Run)───► RUN_INIT ──► FLOORGEN ──► EXPLORE
TITLE ─(Continue)──► RUN_LOAD ───────────────► EXPLORE
EXPLORE ─(touch enemy entity)──► BATTLE
EXPLORE ─(step on event tile)──► EVENT
EXPLORE ─(open chest)──────────► LOOT (overlay)
EXPLORE ─(step on stairs, unlocked)──► CAMP
BATTLE ─(victory)──► LOOT (overlay) ──► EXPLORE
BATTLE ─(flee ok)──► EXPLORE            // no loot; encounter entity remains
BATTLE ─(defeat: 0 Lives or full wipe)──► RESULTS(defeat)
EVENT ─(option resolved)──► EXPLORE     // or ──► BATTLE if the outcome is an ambush
CAMP ─(Descend)──► FLOORGEN ──► EXPLORE          // floors 1–5
CAMP after floor 6 does not exist: killing the final boss ──► RESULTS(victory)
RESULTS ─(Continue)──► TITLE
ANY (except BOOT/RESULTS) ─(Esc)──► PAUSE (overlay) ─(Esc/Resume)──► back
PAUSE ─(Abandon Run)──► RESULTS(defeat, cause:'abandoned')
```

Rules:

- `FLOORGEN` is a real (instant, <16 ms) state so it has one home: it derives the floor
  seed, builds the maze, places entities, autosaves, then hands off. It renders one frame
  of "Descending… Floor N" text (also masks any GC hitch).
- Overlays (`LOOT`, `PAUSE`) render on top of the paused underlying scene; the underlying
  scene's ticker callbacks are suspended (`interactiveChildren=false`, update skipped).
  `PAUSE` cannot open over `LOOT`; close loot first (Esc closes loot too).
- `BATTLE`, `EVENT`, `CAMP`, `RESULTS` are full scene swaps (previous scene destroyed).
  `EXPLORE` is rebuilt from `RunState.floor` on re-entry — no scene is ever kept alive
  in the background except under an overlay.

### Scene/Screen list (exactly what the UI team builds)

| Id | Kind | Contents |
|---|---|---|
| `boot` | scene | Black screen, procedural paw-print logo, "click to start" (satisfies browser autoplay/pointer requirements). No asset loading needed — everything is procedural. |
| `title` | scene | Logo, menu: **New Run** / **Continue** (only if save exists) / **Records**. Seed field (blank = random). Meta-unlock skill toggles (§8) live behind **Records**. |
| `floorgen` | scene | One frame of transition text + floor name. |
| `explore` | scene | Tile map, party marker, entities, fog, HUD (Lives paws, 4 HP bars, item belt, floor label, minimap toggle M). |
| `battle` | scene | As specified in combat.md §13 (`battle/ui.ts`). |
| `loot` | overlay | Panel listing gained items/shinies, "Take All" button / Enter. |
| `event` | scene | Scenario text (procedural parchment panel), 2–3 option buttons (keys 1–3), then an outcome line, then "Continue". |
| `camp` | scene | Campfire drawing, per-cat heal numbers floating up, formation picker for next floor, **Descend** button. |
| `results` | scene | Victory or defeat banner + full score breakdown (§7). |
| `pause` | overlay | §6. |
| `bestiary` | overlay-within-pause and a tab in `camp` | Grid of discovered species, their revealed weak/resist tags (`?` if unknown), kill counts. |

Eleven screens total; `loot`, `pause`, `bestiary` are cheap panels, not scenes.

---

## 2. Run Structure — 6 Floors, 2 Bosses

| Floor | Name (flavor) | Type | Maze grid | Combats | Events | Chests | Enemy pool |
|---|---|---|---|---|---|---|---|
| 1 | The Cellar | normal | 16×12 | 4 | 1 | 2 | Tier 1 (rats, dust bunnies, toads) |
| 2 | The Drains | normal | 20×14 | 5 | 1 | 2 | Tier 1 + Tier 2 |
| 3 | Piper's Court | **BOSS** | 12×10 | 2 | 1 | 1 | Tier 2; boss: **The Rat King** |
| 4 | The Undergarden | normal | 20×14 | 5 | 2 | 3 | Tier 2 + Tier 3 |
| 5 | The Cold Pantry | normal | 22×16 | 6 | 2 | 3 | Tier 3 |
| 6 | The Hollow Throne | **FINAL BOSS** | 12×10 | 2 | 1 | 1 | Tier 3; boss: **The Hound of the Hollow** |

- **Win condition:** kill the floor-6 boss → `RESULTS(victory)`. There is no floor 7.
- **Boss floors:** the stairs-down tile (floors 3) / throne tile (floor 6) is behind a
  visibly locked door; the door opens the instant the boss dies. The boss is a visible,
  unavoidable entity blocking the door corridor. The 2 normal combats on boss floors are
  avoidable (side rooms with the chest/event).
- Combat count is **encounter entities placed**, all visible on the map (no random
  battles — combat.md's flee rule "returns to its dungeon tile, the encounter entity
  remains" requires entity encounters). Roughly half block corridors (must fight or route
  around), half guard chests (optional).
- Encounter composition per tier is data: `EncounterTable = { floor: number,
  entries: { enemies: EnemyId[], weight: number }[] }`. 4–6 entries per floor, picked by
  seeded weighted roll at floorgen. Sizes: floors 1–2 → 2–3 enemies, 4–5 → 3–4 enemies,
  boss fights → boss + 0–2 minions (per boss data).
- **Enemy scaling:** enemies are defined per tier in data (no formula scaling) — 12
  enemy stat blocks = 3 tiers × 4 species, matching combat.md's budget of ~12 enemies +
  2 bosses.
- **Expected pacing:** ~19 required-ish combats + 2 bosses ≈ 21 fights × ~90 s ≈ 32 min
  of combat + exploration/camps ≈ **40 min per full run**.

### Seeding (determinism contract)

```
runSeed   : number            // user-entered or Date.now() >>> 0, shown everywhere
floorSeed = hash32(runSeed, floorNo)          // hash32 = one xorshift-mix round
battle stream seed = hash32(floorSeed, encounterId)   // per combat.md §3
loot / event / placement rolls: one mulberry32 stream per floor, seeded floorSeed,
  consumed in floorgen placement order, then chest-open order, then event-option order
```

The floor stream's consumption order is fixed at generation for layout, and chest/event
results are **pre-rolled at floorgen** and stored on the entity (so open order at
runtime cannot desync determinism, and saves are trivial).

---

## 3. Exploration Rules (minimal, exact)

- Tile grid, 4-direction step movement, arrows/WASD; hold to repeat at 8 tiles/s. Party
  is ONE marker (a stack of 4 tiny cat blobs). Mouse click on a visible tile path-walks
  to it (BFS, stops when adjacent to any entity).
- Tiles: `floor`, `wall`, `door(locked?)`, `stairs`, `chest`, `event`, `encounter`,
  `start`. Entities occupy their tile; walking into them triggers their interaction.
- **Fog of war:** tiles seen within radius 4 (Chebyshev) become explored-dim; currently
  in radius = lit. Entities render only when explored. Minimap (M) shows explored tiles.
- Nothing in exploration costs HP or resources and nothing heals — all attrition and
  recovery happen in battles, events, items, and camps. Items usable from the belt
  during exploration: tuna (heal 30% maxHP, one cat) only; catnip/cucumber are
  battle-only (they map to statuses).

---

## 4. What Persists, and the Camp (rest rules)

**Within a run** (fields of `RunState`, §9): party HP, shared Lives pool, inventory,
shinies, bestiary, floor number, per-floor entity states (opened/killed), chosen
formation, score counters, seeds. Per combat.md: Vigor and statuses never leave a
battle; HP persists between fights; KO'd cats revive at 30% maxHP after a won battle.

**Camp (between floors, automatic + one choice).** Entering `CAMP` from the stairs:

1. Every cat heals `floor(0.30 * maxHP)` automatically (fire crackle, floating +N).
2. Player picks exactly ONE camp boon (buttons, keys 1–3):
   - **Deep Nap** — every cat heals an additional `floor(0.20 * maxHP)`.
   - **Night Patrol** — reveal the next floor's minimap (all tiles explored-dim,
     entities visible on minimap only).
   - **Pack Snacks** — gain 2 Tuna Tins.
3. Player may reorder the default formation for the next floor (drag or 1–4 + arrows).
   This sets the pre-battle default; combat.md's per-battle formation pick still shows.
4. **Descend** → `FLOORGEN(floor+1)`.

No Lives regeneration at camp, ever — the 9 Lives pool only decreases (combat.md §11's
attrition curve stays intact). Total passive healing across a run is 5 camps × 30–50% =
substantial but never full; entering a boss floor healthy costs you boons elsewhere.

**Between runs:** only `MetaFile` (§8) persists. Everything else resets.

---

## 5. Defeat Rules

Exactly combat.md §11, restated for the loop layer:

- Run ends immediately when (a) a cat would be KO'd while Lives = 0, or (b) all 4 cats
  are KO'd in one battle (even with Lives remaining). The battle scene plays a 1.5 s
  "the clowder scatters…" beat, then → `RESULTS(defeat)`.
- Fleeing a losing fight is always legal outside boss fights; the encounter entity
  remains and can be routed around if the maze allows.
- **Abandon Run** (pause menu) = defeat with `cause:'abandoned'`; score is computed
  normally, the autosave is deleted. Confirmation prompt required.

---

## 6. Pause Menu (Esc)

Vertical panel, keyboard + mouse:

1. **Resume** (Esc/Enter)
2. **Party** — 4 cat cards: stats, current/max HP, skill list with costs and full
   descriptions, class passive.
3. **Bestiary** — the run-wide bestiary overlay (species, revealed tags, kills).
4. **Inventory** — item list with descriptions (use is contextual, not from here).
5. **Help** — one static page: controls + the Startle/Cat Pile loop in 6 lines.
6. **Abandon Run** — confirm → `RESULTS(defeat)`.

Footer: run seed (click to copy), floor, play time. Pausing fully freezes the underlying
scene (ticker update skipped). During battle, pause is allowed between actions only
(input phase), never mid-animation — the resolver is synchronous anyway.

---

## 7. Results Screen & Score

Shown on both victory and defeat. Contents, top to bottom:

1. Banner: **"THE CLOWDER PREVAILS"** / **"A DIGNIFIED RETREAT"** (defeat) — plus cause
   line (`slain by <enemy> on floor N` / `abandoned on floor N`).
2. The 4 cat blobs (KO'd ones drawn as little ghosts).
3. Score table, tallied line by line with a tick sound-less count-up:

```
floors fully cleared        × 100      // all encounter entities on the floor dead
floors reached              × 50       // deepest floor entered, incl. boss floors
enemies defeated            × 10
bosses defeated             × 300
shinies collected           × 5        // score-only currency from chests/loot/events
bestiary tags revealed      × 15       // each weak/resist/neutral cell discovered
lives remaining             × 75       // victory only
VICTORY BONUS                 1000     // victory only
TOTAL
```

4. Records line: `best score`, `fastest victory`, `total victories`, `runs played`
   (from `MetaFile`), with "NEW BEST!" flair when beaten.
5. Meta-unlock notification if a milestone was just hit (§8).
6. Buttons: **Again (same seed)** / **New Seed** / **Title**.

No time bonus/penalty — play time is displayed but never scored (no incentive to rush a
tactics game).

---

## 8. Meta-Progression — KEEP, but tiny (decision)

**Decision: keep**, sized at ~60 LoC + 4 data objects. Rationale: the roguelike loop
("keep meta-unlocks, reroll the seed" — combat.md §11) needs *something* to notice
between runs, and alternate skills are pure data in the existing `Skill` shape. Anything
bigger (currencies, stat upgrades, new classes) is cut — it would demand balance passes
we don't have the budget for.

Exactly **4 unlocks**, one alternate skill per class. Each replaces one fixed kit slot,
toggled per-class on the Title → Records panel (choice persists in `MetaFile`):

| Unlock id | Milestone | Class | Alternate skill (data, uses combat.md's `Skill` interface) |
|---|---|---|---|
| `bruiser-alt` | Defeat the floor-3 boss (any run) | Bruiser | **Big Stretch** — trick, reach, self, cost 2, power 0, effects: Guarding(1) + Zoomies(1) on self. Replaces the taunt-yowl slot. |
| `pouncer-alt` | Reveal 12 bestiary tags total (lifetime) | Pouncer | **Ambush** — pounce, melee, enemy-one, cost 4, power 120, effects: pull. Replaces Shred. |
| `oracle-alt` | Trigger 5 Cat Piles (lifetime) | Oracle | **Cucumber Illusion** — trick, reach, enemy-one, cost 5, cooldown 3, power 0, guaranteed Startled (respects Wary/boss Poise rules). Replaces Hairball. |
| `purrmedic-alt` | Win a run | Purrmedic | **Nine Lives Purr** — trick, reach, ally-all, cost 5, power −60. Replaces the cleanse groom. |

Bestiary knowledge itself does **not** persist between runs (scanning is a core early-
fight activity per combat.md §7; persisting it would delete that gameplay). Lifetime
counters for milestones live in `MetaFile.counters`.

---

## 9. Save System — KEEP: localStorage autosave (decision)

**Decision: keep.** A 40-minute run in a browser tab without a save is hostile; the
whole game state is already plain data, so this is ~80 LoC. Rules:

- **Autosave points** (never mid-battle, never mid-event): after `FLOORGEN`, after every
  battle resolution (victory loot taken / flee), after every event outcome, after chest
  loot taken, on `CAMP` descend. Writes are synchronous `localStorage.setItem` of one
  JSON blob (< 20 KB) — imperceptible.
- **Mid-battle quit/close:** the save predates the battle, so Continue restores the
  party on the tile adjacent to the encounter entity with pre-battle HP/Lives — retrying
  a fight costs nothing but honesty, which is acceptable for scope (event-log battle
  replay is explicitly out of budget).
- **Continue** appears on title iff `catrpg.save.v1` exists and `version` matches;
  mismatched versions are silently deleted (no migrations in v1).
- Save is deleted on `RESULTS` entry (both outcomes) and on Abandon.
- `MetaFile` (`catrpg.meta.v1`) is written on every RESULTS entry and on unlock toggle.

### Exact data shapes

```ts
// localStorage 'catrpg.save.v1'
interface SaveFile {
  version: 1;
  runSeed: number;
  floorNo: number;                    // 1..6
  playTimeMs: number;
  lives: number;                      // 0..9 shared pool
  shinies: number;
  party: SavedCat[];                  // fixed length 4, class order fixed
  inventory: { itemId: ItemId; qty: number }[];
  formation: ('front'|'back')[];      // default rows, index-aligned with party
  bestiary: Record<EnemyId, { weak?: Tag|null; resist?: Tag|null;   // null = "tested, neutral"
                              kills: number }>;
  score: ScoreCounters;
  floor: FloorSnapshot;               // current floor only; others are gone/ungenerated
}

interface SavedCat { classId: ClassId; hp: number; }   // maxHP/stats come from class data

interface ScoreCounters {
  floorsCleared: number; enemiesDefeated: number; bossesDefeated: number;
  tagsRevealed: number; catPiles: number;
}

interface FloorSnapshot {
  floorSeed: number;
  partyPos: { x: number; y: number };
  explored: string;                   // base64 bitset, width*height bits
  entities: SavedEntity[];            // regenerate tiles from floorSeed; entities carry state
}

interface SavedEntity {
  id: number;                         // placement order index (stable per seed)
  kind: 'encounter'|'chest'|'event'|'stairs'|'door';
  x: number; y: number;
  state: 'intact'|'consumed';         // killed/opened/resolved/unlocked
  payload?: LootBundle | EventId | { enemies: EnemyId[]; rows: Row[] };  // pre-rolled at floorgen
}

interface LootBundle { shinies: number; items: { itemId: ItemId; qty: number }[]; }

// localStorage 'catrpg.meta.v1'
interface MetaFile {
  version: 1;
  unlocks: string[];                          // e.g. ['bruiser-alt']
  loadout: Record<ClassId, 'base'|'alt'>;     // title-screen toggle state
  counters: { catPiles: number; tagsRevealed: number; bossesDefeated: number;
              victories: number; runs: number };
  records: { bestScore: number; fastestVictoryMs: number | null };
}
```

`RunState` (the in-memory object every scene reads/writes) is `SaveFile` minus
`version`, plus derived caches (full `Cat` objects with stats, live tile map). Serialize
= strip caches; deserialize = rebuild floor tiles from `floorSeed` and overlay entity
states. Battles construct their `BattleState` from `RunState` and write back only
`hp[]`, `lives`, `bestiary`, `score`, loot.

### Events (data shape, so the loop is complete)

```ts
interface GameEvent {
  id: EventId; title: string; body: string;          // ≤ 300 chars body
  options: {
    label: string;
    outcomes: { weight: number; text: string; effect: EventEffect }[];  // seeded pick, pre-rolled
  }[];  // 2–3 options
}
type EventEffect =
  | { kind: 'heal';    pct: number; who: 'all'|'random' }     // ±pct of maxHP; negative = harm
  | { kind: 'item';    itemId: ItemId; qty: number }
  | { kind: 'shinies'; amount: number }                        // may be negative
  | { kind: 'life';    delta: 1 | -1 }                         // clamp 0..9; the ONLY life gain in the game, rare
  | { kind: 'reveal';  count: number }                         // random undiscovered bestiary tags
  | { kind: 'ambush';  enemies: EnemyId[] };                   // → BATTLE, canFlee: false
```

Ship 10 events; each floor draws from the shared pool without repeats within a run.
Items in v1: `tuna` (heal 30%), `catnip` (Zoomies 2), `cucumber` (guaranteed Startle,
once per battle), `fancy-feast` (heal 60%) — 4 items total, all mapping to existing
combat rules.

---

## 10. Implementation Budget (~900 LoC on top of combat)

| Module | Est. LoC | Notes |
|---|---|---|
| `game/fsm.ts` — state machine, scene registry, overlay handling | 90 | transition table from §1 |
| `game/run.ts` — RunState, seeds/hash32, score counters, camp logic | 120 | pure |
| `game/save.ts` — (de)serialize, localStorage, MetaFile | 80 | |
| `dungeon/floorgen.ts` — maze gen, placement, pre-rolled payloads | 180 | consumes §2 tables |
| `scenes/explore.ts` — tiles, movement, fog, minimap, entity triggers, HUD | 220 | biggest UI piece |
| `scenes/title.ts` + `boot.ts` + `results.ts` + `camp.ts` | 140 | mostly Text + panels |
| `scenes/event.ts` + `loot.ts` + `pause.ts` + `bestiary.ts` | 100 | panels |
| `data/floors.ts`, `data/events.ts`, `data/items.ts`, `data/meta.ts` | (data) | tables from §2, §8, §9 |

Grand total with combat.md's ~1500: ~2400 LoC + data — inside the "few thousand lines"
constraint with headroom for polish.

---

## Appendix: Decisions & Rationale (quick reference)

1. **6 floors, bosses at 3 and 6** — matches the 2-boss data budget in combat.md §13;
   mid-boss gives the difficulty curve a spine and the meta a natural first milestone.
2. **Entity encounters, not random battles** — required by combat.md's flee rule; also
   makes routing/avoidance a real exploration decision and lets loot guard itself.
3. **Camp = 30% auto-heal + one boon** — enough recovery that attrition is survivable,
   scarce enough that Lives still tick down over a run; the boon adds a decision without
   adding systems (all three effects reuse existing mechanics).
4. **No Lives regen at camp** — only a rare event `life +1` exists; preserves the
   "terrifying at 2 lives" curve.
5. **Meta-progression kept, 4 alt skills** — pure data in the existing Skill interface,
   milestones read counters the score screen already tracks; anything larger cut.
6. **Autosave kept, pre-battle snapshot semantics** — 40-minute runs demand it; battle
   replay saves rejected as out of budget, retry-on-reload accepted as the tradeoff.
7. **Pre-rolled chest/event/encounter payloads at floorgen** — keeps determinism
   independent of player interaction order and makes SavedEntity trivially small.
8. **No time scoring** — tactics game; time displayed, never scored.
