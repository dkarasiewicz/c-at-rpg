# c(at)rpg — Game Design Document

**Status: CANONICAL.** This is the single source of truth. Where this document and a
detail doc (`docs/design/*.md`) disagree, **GDD.md wins**. Where the GDD is silent,
precedence among the detail docs is: `combat.md` first, then the doc that owns the
system (`classes.md`, `dungeon.md`, `loot.md`, `events.md`, `gameloop.md`,
`ui-art.md`). Every known cross-doc contradiction is ruled on below in the
"Decisions & contradictions resolved" notes — implementers do not re-litigate them.

---

## 1. Pitch

A party of 4 named stray cats (Bruiser / Trickster / Hexer / Medic) descends through
procedurally generated maze-like dungeon floors in a desktop browser. They explore
tile-based levels with fog of war and visible roaming enemy packs, collect Shinies,
gear, and snacks, fight turn-based JRPG battles built on a forced-movement combo
system ("Off-Paw"), and occasionally hit short narrative events with dialog choices.
One run = one sitting (35–45 min), roguelike restart on defeat.

- **Tech:** PixiJS v8 + TypeScript, single player, keyboard + mouse, 60 fps.
- **Art:** 100% procedural (Graphics + Text) — "Midnight Picture-Book": chunky flat
  shapes, fat outlines, dark plum stage, gold reserved for "act here now".
- **Determinism:** one seeded RNG scheme everywhere; same seed = same run.
- **Data-driven:** classes, skills, enemies, items, events, floors are plain TS data.

Design pillars (the whole game in four lines):

1. **Forced movement is the combo engine** — shoving enemies is control AND a damage
   amplifier for teammates; every class, enemy, and item hooks into it.
2. **Attrition is the meta-game** — HP persists across a floor; Nine Lives pips only
   tick down; single fights are low-stakes slapstick, the run accumulates dread.
3. **Everything visible, everything deterministic** — visible turn order, visible
   roamers, no misses, no invisible random encounters, seeded everything.
4. **Small but complete** — ~5–6k LoC total, zero assets, zero backend.

---

## 2. Golden Numbers (canonical quick reference)

| Thing | Value |
|---|---|
| Run length | **6 floors**, bosses on floors **3 and 6** |
| Party | Fixed 4 cats: Bruno (Bruiser), Pixel (Trickster), Mora (Hexer), Baguette (Medic) |
| Combat formation | Cats ranks 1–4 vs enemies ranks 1–5, single file, no gaps |
| Energy (cats) | 0–10, battle starts at 4, +2 regen at own turn start |
| Lives | 9 paw pips per cat; 0 Lives = gone for the run |
| Party level | 1–8, one shared XP pool, XP table `[0,30,70,130,210,310,430,570]` |
| Stats | `hp atk def spd crt enMax` — six, nothing else |
| Statuses | Scratched, Frazzled, Off-Balance, Guarded, Provoked, Mending — six, nothing else |
| Currency | Shinies ✦, party-wide, cap 999, reset each run |
| Equipment | 2 slots per cat (class weapon + universal trinket), rarities stray/sleek/pedigree/mewthical |
| Inventory | 16 shared slots, consumables stack to 5 |
| Seeding | `runSeed` is a **string**; `fnv1a` hash + `mulberry32` streams (dungeon.md §2) |
| Battle RNG | `mulberry32(hash(runSeed, floor, encounterIndex))`, boss = index 0 |
| Design resolution | 1280×720 virtual px, uniform scale + letterbox; tiles 48 px |
| Fog | Chebyshev radius 3 whisker-light with Bresenham LOS + full-room light |
| Descent heal | Free catnap `floor(0.25 × maxHP)` per living cat at each landing |
| Flee | `clamp(0.4 + 0.05·(avgCatSpd−avgEnemySpd), 0.25, 0.9)`; fled pack stunned 5 steps |
| Item ids | camelCase (`tunaSnack`, `catnip`, `featherWand`, `cucumber`, …) |

---

## 3. Core Loop

```
        ┌────────────────────────────── run loop ──────────────────────────────┐
        │                                                                      │
 TITLE ─┴─► FLOORGEN ─► EXPLORE ──(touch roamer / lair)──► BATTLE ─victory─► LOOT + XP
 (seed)      (seeded     │  ▲                                 │                  │
              maze +     │  └────────────── flee ─────────────┤                  │
              entities)  │                                 defeat                │
                         ├─(step on ? tile)─► EVENT ─► back───┼──────────────────┘
                         ├─(bump chest)────► LOOT popup ─► back
                         └─(stairs, floors 1–5)─► LANDING (catnap heal + Peddler
                                                  + marching order) ─► FLOORGEN n+1
                         floor 6 boss dead ─► RESULTS(victory) ─► TITLE / again
                         all cats KO'd or 0 Lives ─► RESULTS(defeat) ─► TITLE / again
```

Minute-to-minute: **explore** (route around or bait visible patrols, grab chests in
dead-end nooks) → **fight** (shove enemies Off-Balance, sequence teammates on the
visible timeline, cash Cat Piles, spend HP you keep) → **spend** (Shinies at the
Peddler, gear swaps, snacks) → **descend** (partial heal, deeper tier, repeat).
Per-run arc: level 1→8, gear stray→mewthical, Lives 36→whatever's left, boss at 3,
final boss at 6, score screen.

---

## 4. Combat — "Claws & Ranks: Nine Lives Edition"

**Canonical doc: `combat.md` (adopted verbatim — it already resolved its own
three-way design contest in its §15 ledger).** Side-view single-axis formation fight:
cats ranks 1–4, enemies ranks 1–5, dead combatants slide everyone behind them
forward. Round-based initiative (`spd + rngInt(0,2)`, queue frozen per round, shown
as a timeline ribbon). No accuracy rolls; damage = `max(1, round(power/100·atk ×
variance × crit1.5 × offBal1.5 × guard0.5) − def)`. Cats run on Energy (start 4,
+2/turn, skills cost 2–6, Claw Swipe banks +1); enemies run on per-skill cooldowns.
Six statuses, exact tick/stack rules per combat.md §6. Per turn a cat picks one of:
Skill, Claw Swipe, Move (swap), Guard (+2 energy), Item, Scatter! (flee).

The signature twist, **Off-Paw**: any combatant force-moved ≥1 clamped rank becomes
**Off-Balance** (+50% damage taken) until round end — and damage resolves *before*
movement, so shoves are gifts to teammates, never to yourself. When every living
enemy is Off-Balance, the **Cat Pile** prompt fires (once/round): all cats dogpile
for `floor(0.30 × Σ atk)` typeless damage each, consuming the marks — or decline and
keep the +50% windows ("pile or pick"). Bosses are data + five flags: `heavy` (never
moves, but forced-move attempts chip visible **Poise**; at 0 → Off-Balance window,
windup cancel, Cat Pile access), double turn, 50% phase switch, telegraphed 2-slot
nuke, summons. Death is the **Nine Lives** rule: KO'd cats stand up at 1 HP after a
won battle and lose 1 of 9 Lives; in-battle revival (Medic's Nine Lives Nudge,
Feather Wand) avoids the loss; 0 Lives = gone for the run. Engine is **headless and
pure**: `resolveAction(state, action, rng) → { newState, events[] }`; the renderer
only animates the event log. Enemy AI is the ~100-line score-and-pick of combat.md
§10. The worked example in combat.md §13 is a mandatory unit test.

**Decisions & contradictions resolved**

- combat.md's internal §15 ledger stands in full (per-cat Energy not shared Moxie;
  Off-Balance as the *only* exploit system — no elements, no One More, no misses;
  flat-DEF damage; Frazzled rules; Nine Lives pips over Bruised).
- classes.md's four **additive** Skill fields (`applies[].to`, `cleanses`,
  `revivePct`, `oncePerBattle`) and four trait hooks are canon — they formalize
  combat.md prose, no engine forks.
- loot.md's engine-wide rule is adopted: **a status chance of exactly 1.0 draws no
  RNG roll** (keeps item use battle-stream-neutral).
- Event-granted `energyNextBattle` mods and temp stat buffs fold into battle setup /
  effective stats via the same hook equipment uses (events.md §2.5) — no other
  dungeon-side combat modifiers exist (no ambush/surprise rounds; dungeon.md's cut
  stands).

---

## 5. Classes & Progression — "The Four Strays"

**Canonical doc: `classes.md`.** Fixed cast, classes = characters 1:1. Each cat:
Claw Swipe + 2 class skills at L1, a capstone at L4, a passive trait with a tier-2
upgrade at L7. Bruno shoves (Body Slam, Dumpster Dunk; trait: once/battle refuses
forced movement), Pixel cashes in (Pounce, Trip Wire, rank-5-reaching Box Ambush;
trait: +10/20 crit vs Off-Balance), Mora pulls (Yank of Yarn, Hairball Hex, Phantom
Cucumber stun; trait: +1/2 Energy per forced-move landed), Baguette funds and revives
(Soothing Purr, Nine Lives Nudge, Purrquake; trait: her Guard gives every other cat
+1/2 Energy). All stats, growth rows, and skill data per classes.md — its L1 party is
byte-identical to combat.md §13's worked example.

Leveling: one party-wide XP pool, level 1–8, zero RNG. Enemy `xp` summed on victory;
level-ups apply on the victory screen (growth row; current HP rises only by the
max-HP delta — attrition preserved). Default marching order R1 Bruno, R2 Pixel,
R3 Mora, R4 Baguette; marching order **is** initial battle ranks.

**Decisions & contradictions resolved**

- **Run length pacing:** classes.md tuned XP against "a 5-floor run" and floor-5
  mooks; the run is **6 floors** (§7 ruling). Pacing targets are restated as: L4
  (capstones) by end of floor 2–3, L7 (trait tier 2) on floor 4–5, L8 before the
  final boss. Boss XP: **40 (floor 3), 60 (floor 6)**; mook XP per the §7 enemy
  roster. If the roster's XP overshoots the 570 cap early, rescale enemy `xp` in the
  tuning pass — the XP table itself does not move.
- gameloop.md's 4 **meta-unlock alternate skills** conflicted with combat.md
  ("meta-unlocks out of scope") and would collide with the capstone slot: **CUT**
  (see §11). Meta-unlocks stay cut; the in-run skill kit was later widened by
  progression.md (below) from 12 class skills to 24 — earned by levelling, not
  by meta-progression.

### 5b. Progression depth — **canonical doc: `design/progression.md`**

Four additive systems layered on top of the above (v1.1). Every new
`CatRunState` field is **optional**; absent ⇒ the behaviour described in §5.

- **Whisker Points.** Each level-up L2..L8 also grants each cat 1 point, spent
  from a fixed menu (`hp +3 · atk +1 · def +1 · spd +1 · crt +3 · enMax +1`),
  capped at 4 points per stat per cat. An `hp` point raises current HP too.
- **Milestone unlocks.** 3 skills known at L1, +1 at **L2 / L4 / L6 / L8** →
  **7 known at cap** (24 class skills + Claw Swipe). The 12 new skills give
  each cat a tool its starter kit lacks — Bruno pulls and shields, Pixel marks
  and sweeps, Mora mass-pulls and mass-frazzles, Baguette cleanses, pre-buffs
  and revives twice.
- **Loadout.** A cat fights with **4** skills: Claw Swipe plus 3 chosen from
  what it knows. Re-planned at the Landing, not in battle.
- **Collars.** A universal **third equipment slot**, defensive/utility only
  (never `atk`/`crt`): 8 defs, 3 Mewthical uniques on the existing hook menu.
  20 % of wild equipment drops, plus one guaranteed Peddler slot per landing.
- **Saves** are version 2; v1 saves migrate forward with no loss.

---

## 6. Dungeon Generation & Exploration — "Whisker Maze"

**Canonical doc: `dungeon.md` for all mechanics** (generation algorithm, RNG
plumbing, fog, roamer AI, step loop) — **except its 9-floor run table, replaced
below.** Floors are odd-sized grids generated by rooms-in-a-maze (scatter odd-aligned
rooms → flood gaps with a windy perfect maze → spanning-tree doors + 5% loop doors →
3 dead-end trim passes; surviving nooks get chests). Everything is decided at
generation time from `genRng`/`popRng`; exploration consumes **zero** runtime RNG.
The party is one token, 4-directional step movement (WASD/arrows, click-to-path);
one discrete simulation step per move. Roamer packs patrol pre-rolled waypoints at
half speed, chase at full speed on LOS (Chebyshev ≤ 6), give up after 6 lost-sight
steps; contact (Manhattan ≤ 1) starts battle. Fled packs stun 5 party-steps. Fog:
unseen / explored (dim, remembers static entities) / visible; roamers render only
while visible. Boss floors: guaranteed 11×7 lair, one west door, boss as landmark,
stairs locked until it dies, guaranteed `boss_hoard` chest.

**Canonical 6-floor table** (replaces dungeon.md §1; same columns and semantics —
chest counts exclude the boss-lair hoard chest):

| Floor | Name | Grid | roomAttempts | Roamers | Chests | Events | Pool | Threat budget | Boss |
|---|---|---|---|---|---|---|---|---|---|
| 1 | The Cellar | 31×21 | 40 | 4 | 2 | 1 | T1 | 3–4 | — |
| 2 | The Drains | 31×21 | 40 | 5 | 2 | 1 | T1 | 4–5 | — |
| 3 | The Appliance Graveyard | 27×19 | 30 | 3 | 3 | 1 | T1 ∪ T2 | 5–6 | **Vacuum King** |
| 4 | The Undergarden | 35×23 | 55 | 6 | 3 | 2 | T2 | 6–8 | — |
| 5 | The Cold Pantry | 35×23 | 55 | 7 | 3 | 2 | T2 ∪ T3 | 8–10 | — |
| 6 | The Hollow Throne | 29×19 | 35 | 5 | 4 | 2 | T3 | 10–12 | **The Dogfather** |

**Canonical enemy roster: dungeon.md §7.1's 10 species + sockWraith summon**
(ratThug, sewerBat, dustBunny, crowShaman, roombaScout, sprinklerImp, yarnGolem
[`heavy` elite], porcelainHound, laserGhost, trashPanda), stat blocks verbatim, plus
events.md's event-only `elderStray`. Pack building per dungeon.md §7.3 (threat
budget, ≤5, ≥2, front-rows-first). Difficulty scales only via pools, budgets, and
pack counts — never stat multipliers.

**Canonical bosses (2 shipped, 1 optional):**

| Boss | Floor | hp | Poise | Flags | Encounter |
|---|---|---|---|---|---|
| `vacuumKing` | 3 | 140 | 3 | heavy, doubleTurn, phase @50% "MAX SUCTION" (pulls all cats 1 rank/turn) | `['vacuumKing']` |
| `dogfather` | 6 | 200 | 4 | heavy, doubleTurn, phase @50%, telegraphed row nuke | `['dogfather','porcelainHound']` |
| `ratPrince` *(SHOULD)* | 3 alt | 120 | 3 | heavy, summons rank-5 rats (sockWraith-style minion) | `['ratPrince']` — seeded pick vs Vacuum King for run variety |

**Decisions & contradictions resolved**

- **Run length: 6 floors, bosses at 3 and 6.** dungeon.md said 9 floors/3 bosses;
  loot.md, gameloop.md, and events.md all assume 6; classes.md assumed 5. Ruling:
  **6** — it keeps the one-sitting pillar, and the entire economy (loot.md §9),
  event floor ranges, and rarity bands are already tuned for it. Vacuum King stays
  on floor 3 per combat.md §11. The Laundromancer is cut; the final boss keeps
  dungeon.md's best name (**The Dogfather**) with gameloop.md's floor-6-appropriate
  numbers (200 HP, Poise 4) and one porcelainHound escort.
- **Enemy roster:** dungeon.md's roster wins over gameloop.md's alternative 10
  (Cellar Toad / Moth Prophet / etc. never got stat blocks). events.md's
  `roombaScout` stat block (34 HP, `heavy`) conflicts with dungeon.md's (24 HP, not
  heavy): **dungeon.md's block is canonical**; the "heavy preview" teaching job
  belongs to `yarnGolem`. events.md's `rat` id does not exist → **use `ratThug`**
  in the Perfect Box encounter. `elderStray` ships as specified in events.md.
- **Encounters are roamers, not static entities** (dungeon.md wins over
  gameloop.md's placed-encounter model) — visible, baitable patrols are the pitch.
- **Seeding: dungeon.md's scheme wins** (string `runSeed`, fnv1a + mulberry32,
  per-entity derived seeds `chestSeed`/`victorySeed`/`eventSeed`, gen/pop stream
  discipline, deterministic retry). gameloop.md's numeric `hash32` tree is
  superseded. Rationale: per-entity seeds make outcomes independent of play order;
  gameloop/loot's single sequential "floor loot stream" would not be.
- **Loot/event pre-roll timing:** contents are *derived-seed-fixed at generation,
  drawn lazily on open/trigger* (dungeon.md's model). This satisfies loot.md's and
  gameloop.md's "pre-rolled, savescum-proof" intent with smaller saves.
- **Fog radius 3 + room light + LOS** (dungeon.md) wins over gameloop.md's
  LOS-less radius 4. BFS neighbor order is always **N, E, S, W** (dungeon.md);
  gameloop.md's N,S,W,E is superseded.
- **Flee return point** = pre-contact tile + 5-step stun (dungeon.md's refinement
  of combat.md's "room entrance"). Marching-order panel (Tab) is blocked while a
  chaser is within 3 tiles (dungeon.md); otherwise editable free, also from pause.
- Deliberate cuts list of dungeon.md §16 stands (no keys, traps, secret walls,
  diagonals, revisits, respawns, ambush modifiers).

---

## 7. Loot & Economy — "Shinies & Snacks"

**Canonical doc: `loot.md` (adopted nearly verbatim).** One party currency,
**Shinies ✦** (cap 999, reset per run); faucets = fights `8+4n+rngInt(0,4)`, chests
`15+8n`, bosses `60+25n`, events, selling; sinks = Peddler stock, Warm Lap healing,
event costs. **Equipment: 2 slots per cat** — a class-locked weapon (4 archetypes)
and a universal trinket (6 archetypes); flat additive stats over the six-stat model;
rarity ladder stray/sleek/pedigree/**mewthical** with formulaic (not rolled) values
scaled by item level L = drop floor. The 8 Mewthical uniques are hand-authored
one-conditional hooks into existing combat code paths (Poise chip ×2, crit→
Off-Balance, chances→1.0, heals grant Mending, shove-back, once-per-run Life save,
Cat Pile double-count, start at 6 Energy). **10 consumables** (weights sum to 100),
all `chance: 1.0`, all resolved as cost-0 Skills by the normal combat pipeline —
combat.md's four locked numbers (Tuna 12, Catnip +2, Feather Wand 25%, Cucumber
guaranteed Frazzle once/battle) unchanged. Drop tables per loot.md §5; 16-slot
shared inventory, stacks of 5. Starting kit: 20 ✦, 2 Tuna Snacks, 1 Cardboard Box,
Stray L1 class weapons equipped.

**The Landing** (between floors, after floors 1–5, a pure screen — never a map
tile): ① free **catnap heal `floor(0.25 × maxHP)`** to each living cat, ② **the
Peddler** (stock per loot.md §6: Tuna always, Sardine-or-Milk, 2 consumable rolls,
1 gear piece at L=n+1, sell at ¼ value) including **Warm Lap** (paid 40% party heal,
`30+15n` ✦, once per landing), ③ marching-order editor, ④ Descend.

**Decisions & contradictions resolved**

- **Equipment exists.** gameloop.md's Appendix ruling "no equipment in v1" is
  **overturned** by loot.md (the later, dedicated doc): gear is the loot half of
  the power curve the fixed enemy stat blocks assume (~+60% offense by floor 6),
  and "collect loot" is in the pitch. gameloop.md's `SavedCat`/save shapes are
  extended with equipment + inventory accordingly (§9 ruling).
- **Landing = camp + Peddler merged.** Three docs disagreed on between-floor
  recovery: dungeon.md 25% free catnap, gameloop.md 30% + a picked boon,
  loot.md's paid Warm Lap "only out-of-combat heal". Ruling: **25% free catnap
  (dungeon.md's number) + loot.md's Peddler with Warm Lap as the *paid* top-up.**
  gameloop.md's camp boons (Deep Nap / Night Patrol / Pack Snacks) are **CUT** —
  they duplicate the Peddler's spend decision, and free 50% heals would gut the
  Warm Lap sink.
- **Consumables: loot.md's 10-item table wins** over gameloop.md's 4-item closed
  set (which it strictly contains). Exploration belt use: **Tuna Snack and Sardine
  Tin only** (loot.md's `explore` field wins over gameloop.md's Tuna-only — same
  intent, Sardine included).
- Chest counts per floor come from the §6 table (loot.md's `2+floor(n/3)` curve),
  keeping loot.md §9's economy math roughly valid; fights/floor ≈ roamer count
  (4–7) rather than loot.md's assumed flat 6 — acceptable drift, tuning-pass item.
- Currency display is **✦ Shinies** everywhere; ui-art.md's `"+Ng"` / gold-coin
  labels are superseded (keep the layouts, swap the glyph/word).
- loot.md's Realignment Ledger (§12) stands: old item/stat names anywhere
  (Stat Treat, Sardine Oil, Zoomies, Vigor, LCK…) are dead.

---

## 8. Narrative Events — "Curiosity & Consequences"

**Canonical doc: `events.md` (adopted verbatim, including all 10 shipped events and
the full schema).** Stepping on a consumed-on-touch event tile opens a modal:
2–4 options, at most one requirement each (class alive / effective stat ≥ N / item /
Shinies), unmet options visible but grayed (the teaching loop). Outcomes are
weighted rolls from the tile's own `mulberry32(eventSeed)` stream in a fixed draw
order. Effects are a closed set (heal, damage-that-never-KOs [clamps at 1 HP], temp
stat buffs floor/run-scoped, shinies, give/take item, restoreLife [the shrine — the
*only* Life gain in the game], energyNextBattle, fight, nothing). Every event has a
safe walk-away option; events never touch Lives directly. Event fights use the
normal battle stream and full combat rules; fleeing one leaves the pack squatting on
the tile. Balance is governed by the Shiny-value yardstick and role shape
(walk-away / gamble / gated premium) of events.md §5.

**Decisions & contradictions resolved**

- **events.md's schema wins wholesale** over gameloop.md §9's smaller `GameEvent`/
  `EventEffect` sketch (which lacked requirements, gates, buffs, and the shrine
  rules). gameloop.md's `ambush` with `canFlee: false` is superseded: **event
  fights are never bosses, so Scatter! is legal** (events.md §2.4).
- Event outcome rolls happen **at trigger time from `eventSeed`** (events.md +
  dungeon.md), not pre-rolled at floorgen (gameloop.md) — identical determinism,
  simpler saves. `eventSeed = hash(runSeed, floor, 'event', eventIndex)`
  (dungeon.md §2 wins over events.md's stale `mix(floorSeed, 3000+id)` citation).
- Encounter id fixes per §6 ruling: `rat` → `ratThug`; `roombaScout` uses the
  dungeon.md stat block; `elderStray` as authored.
- Events per run: **9** (1,1,1,2,2,2 by floor — §6 table), matching events.md's
  macro-economy check.
- Loot bundles: events reference only loot.md §5d's six named bundles.
- UI: ui-art.md's §9 panel layout wins for geometry; events.md's interaction rules
  win (hotkeys 1–4, walk-away is an ordinary listed option, **Esc does nothing**,
  no separate "Leave" row — the 4th option row uses ui-art's leave-row rect when
  an event has 4 options).

---

## 9. Game Loop, Scenes & Persistence — "The Descent of the Clowder"

**Canonical doc: `gameloop.md` for the state machine, pause, results/score, and
save-file mechanics** — with the overrides already ruled above (6-floor table §6,
roamers not placed encounters, Landing replaces CAMP's boons, dungeon.md seeding,
events.md schema, equipment in saves). One flat FSM: `BOOT → TITLE → RUN_INIT →
FLOORGEN → EXPLORE ⇄ {BATTLE, EVENT, LOOT(overlay), LANDING} → RESULTS`, overlays
never stack more than one deep, `Esc` = pause anywhere sensible, Abandon Run =
scored defeat. Scenes communicate only through `RunState`. Battle constructs its
state from marching order and writes back only per-cat `hp`/`lives`, score
counters, and loot. Screens: boot, title (seed entry, Continue, records), floorgen
interstitial, explore, battle, event modal, loot overlay, landing, results, pause.

**Persistence.** Autosave to `localStorage` (one JSON blob) after floorgen, battle
resolution, event outcome, chest loot, and landing descend — never mid-battle
(reload restores the pre-battle snapshot; retry costs only honesty). Save =
`runSeed` string, floor number, party (hp, lives), marching order, **inventory +
equipment + Shinies**, XP/level, score counters, and current-floor deltas (explored
bitmap, party pos, per-entity state, roamer positions/states, stepCount); tiles
regenerate from the seed. Save deleted on RESULTS. A tiny `MetaFile` keeps lifetime
records (best score, fastest win, runs/victories) — records only, no unlocks.
Results screen shows gameloop.md §7's score table (floors, kills, bosses ×300,
shinies ×5, **Cat Piles ×20**, remaining Lives ×25, victory bonus 1000; time
displayed, never scored).

**Decisions & contradictions resolved**

- **Meta-progression unlocks (4 alternate skills) are CUT.** combat.md declares
  meta-unlocks out of scope, and the alternates collide with classes.md's capstone
  slot. `MetaFile` survives as pure records; the Records panel lists stats only.
- **CAMP scene → LANDING scene** (§7 ruling): free 25% catnap + Peddler +
  marching-order edit + Descend. No boons.
- gameloop.md's per-floor entity budget table, enemy tier list, boss roster,
  `hash32` seeding, 4-item list, and event schema are all superseded (rulings in
  §§5–8). Its FSM, autosave rules, pause menu, score table, and "one run one
  sitting" pacing stand.
- Mid-boss variety (Rat Prince as a seeded alternate floor-3 boss) is kept as a
  **SHOULD**, not MUST — one extra data object, zero engine cost.

---

## 10. UI & Art — "Midnight Picture-Book"

**Canonical doc: `ui-art.md` (adopted verbatim for everything visual).** 1280×720
design resolution, uniform-scaled and letterboxed; fixed layer stack (bg / world /
fx / hud / floaters / modal / flash); visual RNG is `Math.random()` and never
touches gameplay streams — the renderer only consumes the combat engine's event
queue. Single palette const (`PAL`), three text styles (DISPLAY / UI / MONO), gold
strictly reserved for "act here now". One `drawCat` recipe renders all four cats
(96×96 Graphics: tail-body-belly-paws-head-ears-eyes-nose-whiskers + per-class
silhouette markers); four enemy families (vermin / bird / beast / construct) with
size grades and data-driven props; six status chips with glyphs; Lives as paw-pip
rows. Screens per ui-art §§7–11: exploration (checkerboard tiles, fog states,
minimap, 4 cat cards), combat (initiative ribbon, rank slots, 6-slot skill bar with
the range-strip visualization, targeting flow with damage/shove previews, Cat Pile
banner, floating numbers, log line), event modal, victory/results, title. The whole
animation budget is one 40-line tween helper (lunges, hit flash, screen shake,
Off-Balance wobble+stars, Cat Pile dust cloud, Poise shatter, KO poof + corpse
slide); ambient idle bobs and blinks are free.

**Decisions & contradictions resolved**

- ui-art.md's layouts supersede dungeon.md's exploration viewport numbers (15×11 @
  720×528 → **1280×632 world area**, camera behavior otherwise per dungeon.md) and
  its minimap placement details; 48 px tiles and 4 px/tile minimap agree everywhere.
- Currency labels: "g" → **✦** (§7 ruling). The class palette table in classes.md
  §10 is superseded by ui-art.md §2's `PAL` class entries (same cats, richer spec);
  classes.md's barks/bios/epithets stand.
- Item belt shows all owned consumables; only Tuna/Sardine are pressable outside
  battle (§7 ruling), others render disabled with a "battle only" tooltip.
- Event modal geometry from ui-art, interaction from events.md (§8 ruling).
- Audio does not appear in any design doc: **no audio in v1** (recorded as a cut,
  not an accident).

---

## 11. Scope — prioritized

### MUST (the core playable loop — nothing here is optional)

1. **Shared foundation:** fnv1a/mulberry32 RNG module, tween helper, palette/layout
   consts, FSM + scene registry, `RunState`.
2. **Combat engine** (headless, pure, event-emitting): stats, damage pipeline,
   initiative, energy/cooldowns, six statuses, Off-Paw + Cat Pile, Poise + all five
   boss flags, Nine Lives/KO/flee/victory, enemy AI, class traits, item-as-skill
   resolution. combat.md §13 as a passing unit test.
3. **Combat UI:** ribbon, rank slots, skill bar + range strips, targeting previews,
   floaters, log line, Cat Pile prompt, boss telegraphs.
4. **Classes & leveling:** 4 cats, 13 skills, 4 traits (both tiers), XP/level 1–8,
   victory-screen level-ups.
5. **Dungeon:** rooms-in-a-maze generator + validation, 6-floor table, population
   (stairs/chests/events/roamers/packs/waypoints), fog + LOS, step loop, roamer AI,
   boss lairs, exploration rendering + minimap + party HUD.
6. **Enemies:** 10-species roster + sockWraith + elderStray; 2 bosses (Vacuum King,
   Dogfather).
7. **Loot core:** Shinies, drop tables, 10 consumables, equipment (10 defs, 4
   rarities — Mewthical drops allowed but may downgrade to Pedigree until hooks
   land), 16-slot inventory, equip/unequip UI, chest/victory loot popups.
8. **Landing:** catnap heal, Peddler stock + prices + Warm Lap + sell, marching
   order, descend.
9. **Events:** schema, validator, resolver, modal UI, all 10 shipped events.
10. **Shell:** boot, title (+ seed entry), floorgen interstitial, results screen
    with score table, pause menu, defeat/victory flow.

### SHOULD (in priority order — cut from the bottom under pressure)

1. **Autosave / Continue** (localStorage save + MetaFile records) — first thing
   after MUST; a 40-minute browser run without it is hostile.
2. **The 8 Mewthical unique hooks** (~25 LoC in the resolver; until then Mewthical
   rolls downgrade to Pedigree).
3. **Rat Prince** alternate floor-3 boss (seeded pick for run variety).
4. **Records panel** on title + "NEW BEST!" flair on results.
5. **Log scrollback panel**, skill/status tooltips beyond the minimum.
6. **How to Play** panel (3 pages, static).
7. **Juice completeness** (Poise-shatter particles, ghost HP segments, toasts) —
   core readability animations (lunge, flash, floaters, corpse slide, Off-Balance
   tilt) are MUST-adjacent; the rest is here.
8. Click-to-path auto-walk (keyboard steps alone are acceptable for v1.0).

### CUT (decided — do not implement, do not re-open)

- 9-floor runs / third boss floor / The Laundromancer as shipped content.
- Meta-progression unlocks (4 alt skills) and any between-run currency.
- Camp boons (Deep Nap / Night Patrol / Pack Snacks).
- Elemental affinities, weakness probing, One More / extra actions, accuracy &
  misses, Blind, Stalk, shared Moxie pool, Bruised debuff, bestiary (all per
  combat.md §15 / gameloop.md).
- Dungeon: locked doors/keys, traps, secret walls, diagonal movement, invisible
  random encounters, floor revisits, hunger/torch clocks, roamer respawns,
  shop-as-a-tile, ambush/surprise modifiers, multi-tile bodies.
- Loot: armor slot, crafting/sockets/durability, random affix generation,
  permanent stat food, damage consumables, buyback/haggling, Life-restoring items.
- Mid-battle saves, time-based scoring, typewriter text, portraits in events.
- Audio (music and SFX) in v1.

### Budget sanity

Engine ~1500 (combat) + ~1150 (dungeon) + ~470 (loot) + ~770 (events) + ~500
(FSM/run/save/landing) + ~1900 (rendering, includes combat's 550 UI line) ≈
**5,500–6,000 LoC + data** — at the top of "a few thousand lines", with the SHOULD
list as the pressure valve.
