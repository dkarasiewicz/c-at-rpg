# c(at)rpg Narrative Events & Dialog — FINAL DESIGN
## "Curiosity & Consequences"

**Status: FINAL.** Aligned with `combat.md` ("Claws & Ranks: Nine Lives Edition"):
classes **Bruiser / Trickster / Hexer / Medic**, stats `hp/atk/def/spd/crt/enMax`,
per-cat Energy, the Nine Lives rule, and the consumables Tuna Snack / Catnip /
Feather Wand. Currency is **Shinies ✦** (loot.md). Event tiles, their placement,
and their `eventSeed` come from dungeon.md §6.4; this doc owns everything that
happens after the party steps on one.

> Note: any older references in companion docs to "Vigor", "Stalk", "LCK",
> "Zoomies" or the class names Pouncer/Oracle/Purrmedic belong to the superseded
> combat spec and are overridden by combat.md and this doc.

Design pillars:

1. **Events are the run's "third economy."** Combat spends HP and Lives; chests
   pay Shinies and items. Events convert *knowledge* (of cats, of the party's
   classes, of the event pool) into value — the gated option is almost always
   the best one, and seeing why teaches the game.
2. **Never run-ending on their own.** Event damage cannot KO a cat (HP clamps
   at 1) and events never remove Lives. Only an event-spawned *fight* can KO,
   and fights obey the full combat rules including revival. The worst event
   outcome stings; it never decides the run by itself.
3. **Deterministic.** One `mulberry32(eventSeed)` stream per event tile, rolls
   in documented order. Same seed → same event, same outcome rolls.
4. **Data all the way down.** An event is a plain TS object; the resolver is a
   ~120-line pure function; the UI is one modal.

---

## 1. Data Schema (exact)

```ts
// ---------- shared ----------
type ClassId = 'bruiser' | 'trickster' | 'hexer' | 'medic';
type ItemId  = 'tunaSnack' | 'catnip' | 'featherWand';   // extends with loot.md ids
type StatId  = 'atk' | 'def' | 'spd' | 'crt';

/** Floor-scaled number: value(floor) = base + perFloor * floorNum */
type Scalar = number | { base: number; perFloor: number };

/** Who an effect lands on. */
type TargetSel =
  | 'party'        // every living cat
  | 'random'       // one living cat, seeded pick
  | 'lowestHp'     // living cat with lowest current HP (tie: lowest rank)
  | 'lowestLives'  // living cat with fewest Lives below 9 (tie: lowest rank)
  | 'gateCat';     // the cat that satisfied the option's class/stat requirement
                   // (class req: that class's cat; stat req: the best-stat cat).
                   // Validator error if the option has no class/stat requirement.

// ---------- requirements (max ONE per option; unmet = grayed out, visible) ----------
type Requirement =
  | { kind: 'class';   class: ClassId }                 // that class alive (lives > 0, not gone)
  | { kind: 'stat';    stat: StatId; min: number }      // best living cat's EFFECTIVE stat
                                                        // (base + equipment + temp mods) >= min
  | { kind: 'item';    item: ItemId; count?: number }   // consumed when the option is picked
  | { kind: 'shinies'; cost: Scalar };                  // paid when the option is picked

// ---------- effects ----------
type Effect =
  | { kind: 'heal';    target: TargetSel; amount: Scalar }   // capped at maxHP
  | { kind: 'damage';  target: TargetSel; amount: Scalar }   // ignores def; HP clamps at 1 (never KOs)
  | { kind: 'buff';    target: TargetSel; stat: StatId | 'hpMax';
      amount: number;                                        // negative = debuff
      duration: 'floor' | 'run' }
  | { kind: 'shinies'; amount: Scalar }                      // +/-; wallet clamps at 0
  | { kind: 'giveItem'; item: ItemId; count?: number }
  | { kind: 'takeItem'; item: ItemId; count?: number }       // no-op if absent
  | { kind: 'restoreLife'; target: 'lowestLives'; amount: number }  // cap 9 per cat
  | { kind: 'energyNextBattle'; target: TargetSel; amount: number } // added to the 4 starting
                                                                    // energy of the NEXT battle only, cap 10
  | { kind: 'fight'; encounter: string[];                    // front-to-back enemy ids (combat.md §1)
      loot: 'none' | 'normal' | 'bonus';                     // 'bonus' = chest-table roll instead of fight table
      onWinEffects?: Effect[] }                              // applied on the victory screen
  | { kind: 'nothing' };                                     // explicit "flavor only"

// ---------- outcomes & options ----------
interface Outcome {
  weight: number;      // > 0; a lone outcome = deterministic option
  text: string;        // result flavor, 1-3 sentences
  effects: Effect[];   // applied in array order; 'fight' must be the LAST effect
}

interface EventOption {
  label: string;             // button text, <= 60 chars
  requires?: Requirement;    // omit = always available
  outcomes: Outcome[];       // 1-4 entries
}

interface GameEvent {
  id: string;                // unique
  title: string;
  prompt: string;            // 2-4 sentences shown in the modal
  weight: number;            // selection weight within the floor's candidate pool
  floors: [number, number];  // inclusive floor range (run is floors 1-6, dungeon.md §1)
  once?: boolean;            // at most once per run
  options: EventOption[];    // 2-4 entries
}
```

### Authoring invariants (enforced by a dev-time validator, ~30 lines)

1. 2–4 options; 1–4 outcomes per option; all weights > 0.
2. **Every event has at least one option with no `requires` whose outcomes
   contain no `damage` and no `fight`** — the walk-away rule. (It may be pure
   `nothing`.)
3. `fight` is the last effect of its outcome; at most one `fight` per outcome.
4. `gateCat` targets appear only on options with a `class` or `stat` requirement.
5. All `encounter` ids exist in `data/enemies.ts`; all `ItemId`s in `data/items.ts`.
6. `Scalar` values must resolve to >= 0 for floors 1–6 (damage/heal/costs).
7. `restoreLife` options are additionally disabled (grayed) at runtime if no
   living cat is below 9 Lives.

### Temp stat mods (the `buff` effect)

Stored on the cat as `{ stat, amount, duration, sourceEventId }` and folded into
**effective stats** wherever combat or a stat gate reads them (same hook as
equipment mods, loot.md §2). `duration: 'floor'` mods are removed on descending
the stairs; `'run'` mods persist to the end of the run. Mods stack additively;
effective `spd` floors at 1, `def`/`crt` at 0. `hpMax` buffs raise current HP by
the same amount when applied; when a `hpMax` mod expires, maxHP drops and
current HP clamps to the new max.

---

## 2. Selection & Resolution Flow (exact)

### 2.1 Which event fires

The dungeon layer hands over `eventSeed` (`mix(floorSeed, 3000 + e.id)`,
dungeon.md §2) when the party steps on an unconsumed event tile. Then:

```
eventRng = mulberry32(eventSeed)
pool = EVENTS.filter(e =>
         floorNum >= e.floors[0] && floorNum <= e.floors[1]
      && !(e.once && run.firedEventIds.includes(e.id))
      && !floor.firedEventIds.includes(e.id))        // no repeats on one floor
pick = weighted pick over pool by e.weight            // eventRng draw #1
```

If the pool is somehow empty (impossible with the shipped 10-event pool and the
floor ranges below, but guarded anyway): the tile silently converts into
`15 + 8·floor` Shinies ("you find a shiny where something stranger should have
been") and is consumed.

### 2.2 RNG draw order (determinism contract)

Per event tile, from `eventRng`, in this exact order:

1. **Selection roll** (the weighted pick above) — always 1 draw.
2. Player picks an option — no draw.
3. **Outcome roll** — 1 `float()` draw walked against cumulative weights.
   *Skipped* when the option has exactly one outcome.
4. **Effect-internal draws**, in effect array order: `target: 'random'` costs 1
   `int(0, living-1)` draw **per effect** (two `random` effects in one outcome
   may hit different cats — intended; "the yarn got somebody" comedy). Nothing
   else in the effect set draws.
5. An event `fight` uses the **combat layer's own battle stream**
   (`mulberry32(hash(runSeed, floor, encounterIndex))`, combat.md §3), never
   `eventRng`. `onWinEffects` needing a random target draw from `eventRng`,
   continuing its sequence.

### 2.3 Resolution algorithm

```
resolveOption(state, event, optionIndex, eventRng) -> { newState, results[], fightRequest? }
```

1. **Pay the requirement**: `item` reqs consume the item; `shinies` reqs deduct
   the resolved cost. (`class`/`stat` reqs cost nothing — they are pure gates.)
2. **Roll the outcome** (§2.2 step 3).
3. **Apply effects in order.** Each effect emits a result line (§3 UI):
   - `heal`/`damage` resolve per target cat; damage ignores `def` and clamps the
     cat at 1 HP; heal caps at maxHP. Emitted deltas are the *actual* applied
     numbers ("Bruno +9 HP" when only 9 of 12 healing landed).
   - `buff` attaches the temp mod (§1).
   - `giveItem`/`takeItem`/`shinies`/`restoreLife`/`energyNextBattle` mutate
     inventory / wallet / Life pips / pending-battle mods directly.
   - `fight` does not resolve here: it is returned upward as `fightRequest`.
4. Mark the event fired (`run.firedEventIds`, `floor.firedEventIds`) and the
   tile consumed. **This happens even if the outcome was pure `nothing` and
   even if the upcoming fight is fled** — curiosity spends the tile.

### 2.4 Event fights

- The modal closes, the battle scene launches with the outcome's `encounter`
  array. All combat rules apply verbatim (initiative, Off-Paw, KO / Nine
  Lives, revival). Event encounters are never bosses, so **Scatter! is legal**.
- **Victory:** loot per the `loot` flag — `'none'`: nothing; `'normal'`: the
  regular fight-victory Shinies + drop roll (loot.md §5a); `'bonus'`: fight
  Shinies + one **chest-table** roll (loot.md §5b). Then `onWinEffects` apply
  and their result lines render on the victory screen.
- **Flee:** the enemies remain as a stationary roamer-style encounter entity on
  the event tile (blocking it, dungeon.md §7.2); the event stays consumed and
  `onWinEffects` are forfeited — beating the leftover encounter later yields
  only `'normal'` loot.
- **Defeat:** run over, as always.

### 2.5 What persists where

| Thing | Scope |
|---|---|
| `firedEventIds` | run (for `once`) + floor (no same-floor repeats) |
| `buff` mods | `'floor'` until descent / `'run'` until run end |
| `energyNextBattle` | consumed by the next battle's setup (adds to the 4 starting energy, cap 10), then cleared — even if that battle is fled |
| HP / Shinies / items / Lives changes | permanent (normal run state) |

---

## 3. UI Flow (one modal, ~220 LoC of PixiJS)

States: `PROMPT → RESULT → (close | FIGHT)`.

**PROMPT state.** Step loop pauses (dungeon.md §7.2). Full-screen dim
(`Graphics` rect, `0x000000` alpha 0.6), centered panel 560 px wide
(rounded-rect fill `0x2a2438`, 2 px lighter border), height auto. Contents top
to bottom, 16 px padding:

- Title: `Text` 24 px bold, accent color.
- Prompt: 16 px, `wordWrap: 520`.
- One button per option (full width, 48 px tall, 8 px gap). A button shows the
  label plus a right-aligned cost/req tag when present: `−70 ✦`, `uses 1 Tuna
  Snack`, `needs Trickster`, `needs SPD 8`.
  - **Unmet requirement:** button at alpha 0.45, not clickable, tag in red.
    Grayed options stay *visible* — showing what a Trickster or 70 ✦ would have
    bought is the teaching loop.
- Hotkeys `1`–`4` press the corresponding button; mouse click also works.
  `Esc` does nothing — walking away is an explicit option, not a keybind.

**RESULT state.** The option list is replaced by:

- Outcome `text` (16 px italic).
- One delta line per emitted result, 15 px, color-coded (green heals/gains, red
  damage/losses, violet buffs): `Pixel +12 HP`, `Party: SPD +1 (this floor)`,
  `+35 ✦`, `Mora regains 1 Life`, `Received: Tuna Snack ×2`.
- A single `Continue` button (`E` / `Space` / `Enter` or click). If the outcome
  ends in `fight`, the button reads `Fight!` and launches the battle; delta
  lines for pre-fight effects (e.g. the nap heal in "A Perfect Box") are shown
  first so the player understands what carried in.

No typewriter effects, no portraits, no scrolling in v1: prompts are capped at
4 sentences by authoring rule, so everything fits one panel at 960×540 and up.

---

## 4. The 10 Shipped Events (complete data)

Enemy ids referenced below and owed to `data/enemies.ts`: `rat`, `ratThug`,
`crowShaman` (combat.md), plus two event-only entries: **`roombaScout`**
(tier-2: HP 34, ATK 9, DEF 3, SPD 4, `heavy` trait — its shove-immunity gives
players a Poise-free preview of fighting something unmovable before the real
bosses) and **`elderStray`** (tier-3 lone elite: HP 55, ATK 12, DEF 3, SPD 7,
no traits — he can be shoved, but he shoves back: his `Grizzled Cuff` is a
`moveTarget: +1` skill).

```ts
export const EVENTS: GameEvent[] = [

// ── 1 ───────────────────────────────────────────────────────────────────────
{
  id: 'yarnBall',
  title: 'The Mysterious Yarn Ball',
  weight: 10, floors: [1, 6],
  prompt:
    'In the middle of the corridor sits a ball of yarn, wound too perfectly, ' +
    'lit by no torch you can find. It smells faintly of magic and wet wool. ' +
    'It rolls half a paw-width toward you. On its own.',
  options: [
    {
      label: 'Bat it around. It exists to be batted.',
      outcomes: [
        { weight: 6,
          text: 'It unspools into glorious chaos. The party spends five minutes as one joyous, tangled organism, and emerges limber.',
          effects: [ { kind: 'buff', target: 'party', stat: 'spd', amount: 1, duration: 'floor' } ] },
        { weight: 4,
          text: 'The yarn bats back. By the time the knots surrender, one of you has been thoroughly mummified.',
          effects: [
            { kind: 'damage', target: 'random', amount: { base: 4, perFloor: 1 } },
            { kind: 'buff',   target: 'random', stat: 'spd', amount: -1, duration: 'floor' } ] },
      ],
    },
    {
      label: 'Unravel it with surgical precision.',
      requires: { kind: 'class', class: 'trickster' },
      outcomes: [
        { weight: 1,
          text: 'The Trickster teases out the one true thread. The ball sighs, unwinds, and surrenders the shinies someone had wound it around.',
          effects: [ { kind: 'shinies', amount: { base: 20, perFloor: 5 } } ] },
      ],
    },
    {
      label: 'A cat of your discipline walks on.',
      outcomes: [ { weight: 1,
        text: 'You walk on. The yarn ball rolls sadly back into the dark. Nobody speaks of it.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 2 ───────────────────────────────────────────────────────────────────────
{
  id: 'suspiciousHuman',
  title: 'A Suspicious Human',
  weight: 8, floors: [1, 4],
  prompt:
    'A human in a trench coat crouches in the gloom, holding out a crinkly bag. ' +
    '"Heeere kitty kitty," it says, smiling slightly too wide. ' +
    'The treats smell real. The human does not.',
  options: [
    {
      label: 'Accept the treats. Treats are treats.',
      outcomes: [
        { weight: 55,
          text: 'They ARE real. Salmon flavor. The human nods slowly, satisfied, and backs away into the darkness without breaking eye contact.',
          effects: [ { kind: 'heal', target: 'party', amount: { base: 8, perFloor: 1 } } ] },
        { weight: 35,
          text: 'The treats expired during a previous civilization. Everyone eats them anyway. Everyone regrets it.',
          effects: [ { kind: 'damage', target: 'party', amount: { base: 3, perFloor: 1 } } ] },
        { weight: 10,
          text: 'The human panics, drops the entire bag, and flees up a staircase that was not there before.',
          effects: [ { kind: 'giveItem', item: 'tunaSnack', count: 2 } ] },
      ],
    },
    {
      label: 'Hiss. Swipe. Take the whole bag.',
      requires: { kind: 'class', class: 'bruiser' },
      outcomes: [
        { weight: 1,
          text: 'The Bruiser rises to full height. The human reconsiders every decision that led to this basement, drops the bag AND its lunch money, and leaves.',
          effects: [
            { kind: 'giveItem', item: 'tunaSnack', count: 2 },
            { kind: 'shinies', amount: 10 } ] },
      ],
    },
    {
      label: 'Decline. You saw the van outside.',
      outcomes: [ { weight: 1,
        text: 'You keep walking. Behind you, the human whispers "...worth a try" and folds back into the shadows.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 3 ───────────────────────────────────────────────────────────────────────
{
  id: 'cursedPost',
  title: 'The Cursed Scratching Post',
  weight: 8, floors: [2, 6],
  prompt:
    'A scratching post of black sisal stands in a circle of scorched tiles. ' +
    'Runes spiral up its length, and the shredded offerings of a hundred ' +
    'previous cats litter its base. It is, admittedly, EXACTLY the right height.',
  options: [
    {
      label: 'Scratch it. Obviously.',
      outcomes: [
        { weight: 45,
          text: 'The post PURRS. Warm strength floods up through claw and paw. The runes glow approvingly.',
          effects: [ { kind: 'buff', target: 'random', stat: 'atk', amount: 2, duration: 'floor' } ] },
        { weight: 25,
          text: 'The post accepts the offering utterly. The scratcher\'s claws come away edged with something old and sharp. This feels permanent.',
          effects: [ { kind: 'buff', target: 'random', stat: 'atk', amount: 1, duration: 'run' } ] },
        { weight: 30,
          text: 'The post scratches BACK. The runes flash, the tiles hiss, and the offender is flung across the room minus some dignity and fur.',
          effects: [
            { kind: 'damage', target: 'random', amount: { base: 6, perFloor: 1 } },
            { kind: 'buff',   target: 'random', stat: 'def', amount: -1, duration: 'floor' } ] },
      ],
    },
    {
      label: 'Read the runes first.',
      requires: { kind: 'class', class: 'hexer' },
      outcomes: [
        { weight: 1,
          text: 'The Hexer traces the spiral and finds the one safe groove — the maker\'s signature — and sharpens her claws in it at leisure.',
          effects: [ { kind: 'buff', target: 'gateCat', stat: 'atk', amount: 1, duration: 'run' } ] },
      ],
    },
    {
      label: 'Some posts are not for scratching.',
      outcomes: [ { weight: 1,
        text: 'You file it under "no". The post creaks, disappointed, as you pass.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 4 ───────────────────────────────────────────────────────────────────────
{
  id: 'shrineOfNine',
  title: 'Shrine of the Nine',
  weight: 6, floors: [3, 6], once: true,
  prompt:
    'A moonlit alcove that should not have moonlight. Nine candles burn around ' +
    'a worn stone statue of the First Cat, depicted — as in all the old ' +
    'carvings — mid-yawn. The air tastes like the moment before a purr.',
  options: [
    {
      label: 'Make an offering of shinies.',
      requires: { kind: 'shinies', cost: { base: 60, perFloor: 10 } },
      outcomes: [
        { weight: 1,
          text: 'The shinies sink into the stone. One candle flares white, and somewhere inside your friend, a spent life quietly rekindles.',
          effects: [ { kind: 'restoreLife', target: 'lowestLives', amount: 1 } ] },
      ],
    },
    {
      label: 'Curl up and pray.',
      outcomes: [
        { weight: 1,
          text: 'You knead the cold stone and think warm thoughts. The First Cat\'s yawn seems, briefly, like a smile. Aches fade.',
          effects: [ { kind: 'heal', target: 'party', amount: 6 } ] },
      ],
    },
    {
      label: 'Knock a candle off the shrine.',
      outcomes: [
        { weight: 5,
          text: 'It clatters magnificently. The First Cat — patron saint of knocking-things-off-surfaces — approves, and shinies rain briefly from nowhere.',
          effects: [ { kind: 'shinies', amount: 25 } ] },
        { weight: 5,
          text: 'The flame goes out. All the other flames turn to look at you. The lesson is brief, hot, and extremely fair.',
          effects: [ { kind: 'damage', target: 'party', amount: 5 } ] },
      ],
    },
  ],
},

// ── 5 ───────────────────────────────────────────────────────────────────────
{
  id: 'perfectBox',
  title: 'A Perfect Box',
  weight: 10, floors: [1, 6],
  prompt:
    'A cardboard box sits in the torchlight. It is clean. It is dry. It is ' +
    'precisely the size of four cats. Ancient law is unambiguous on this ' +
    'point: if it fits, you sits.',
  options: [
    {
      label: 'Get in the box. All of you. Immediately.',
      outcomes: [
        { weight: 7,
          text: 'You fit. You sits. Twenty perfect minutes of communal loafing later, the dungeon feels beatable again.',
          effects: [ { kind: 'heal', target: 'party', amount: { base: 10, perFloor: 1 } } ] },
        { weight: 3,
          text: 'You fit, you sits, you nap — and wake to rats prying at the flaps, furious that you found their clubhouse.',
          effects: [
            { kind: 'heal',  target: 'party', amount: { base: 10, perFloor: 1 } },
            { kind: 'fight', encounter: ['rat', 'rat', 'rat'], loot: 'normal' } ] },
      ],
    },
    {
      label: 'Circle it warily before committing.',
      requires: { kind: 'stat', stat: 'spd', min: 8 },
      outcomes: [
        { weight: 1,
          text: 'Your fastest scout laps the box, spots three rat tails under a flap, and delivers one thunderous pre-emptive pounce. The rats resign. The box — and their stash — are yours.',
          effects: [
            { kind: 'shinies', amount: { base: 10, perFloor: 3 } },
            { kind: 'heal',    target: 'party', amount: { base: 10, perFloor: 1 } } ] },
      ],
    },
    {
      label: 'It is a trap. It is always a trap.',
      outcomes: [ { weight: 1,
        text: 'You walk past the box. The box says nothing, which is somehow worse.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 6 ───────────────────────────────────────────────────────────────────────
{
  id: 'milkBowl',
  title: 'The Bowl of Milk',
  weight: 8, floors: [1, 5],
  prompt:
    'A saucer of milk, fresh and impossibly cold, sits on a stone pedestal. ' +
    'Every instinct says drink. One very small, frequently ignored instinct ' +
    'notes that adult cats are, in fact, lactose intolerant.',
  options: [
    {
      label: 'Lap it up. Instinct outranks biology.',
      outcomes: [
        { weight: 4,
          text: 'Worth it. WORTH IT. Whiskers dripping, hearts full, and — for once — no consequences arrive.',
          effects: [
            { kind: 'heal', target: 'party', amount: { base: 6, perFloor: 1 } },
            { kind: 'energyNextBattle', target: 'party', amount: 1 } ] },
        { weight: 6,
          text: '"Worth it," you all insist, ten minutes later, lying on your sides in a chorus of tiny gurgles. Biology outranks instinct.',
          effects: [ { kind: 'damage', target: 'party', amount: { base: 4, perFloor: 1 } } ] },
      ],
    },
    {
      label: 'Have the Medic run a sniff test.',
      requires: { kind: 'class', class: 'medic' },
      outcomes: [
        { weight: 1,
          text: 'One professional sniff: "Oat milk. Barista blend. Safe." The party drinks like royalty.',
          effects: [
            { kind: 'heal', target: 'party', amount: { base: 6, perFloor: 1 } },
            { kind: 'energyNextBattle', target: 'party', amount: 1 } ] },
      ],
    },
    {
      label: 'Tip the bowl over and leave.',
      outcomes: [
        { weight: 1,
          text: 'CLATTER. Deeply satisfying. Petty, but satisfying. Under the saucer: a few shinies some earlier, equally petty cat left behind.',
          effects: [ { kind: 'shinies', amount: 5 } ] },
      ],
    },
  ],
},

// ── 7 ───────────────────────────────────────────────────────────────────────
{
  id: 'redDot',
  title: 'The Red Dot',
  weight: 7, floors: [2, 6],
  prompt:
    'It appears on the far wall. It dances. It has no source, no mass, no ' +
    'mercy. Generations of cats have chased it; none have caught it. ' +
    'It slides three inches to the left, daring you.',
  options: [
    {
      label: 'CHASE.',
      outcomes: [
        { weight: 50,
          text: 'The chase is everything. Walls are run upon. Physics files a complaint. You do not catch it — but stars, are you FAST now.',
          effects: [
            { kind: 'damage', target: 'party', amount: { base: 4, perFloor: 1 } },
            { kind: 'buff',   target: 'party', stat: 'spd', amount: 1, duration: 'floor' } ] },
        { weight: 35,
          text: 'You corner it — impossible — and it winks out, revealing the wall-crack it was luring you toward. Inside: a previous chaser\'s hoard.',
          effects: [ { kind: 'shinies', amount: { base: 15, perFloor: 5 } } ] },
        { weight: 15,
          text: 'One of you CATCHES IT. Holds it, wriggling, under a paw. The universe holds its breath. Before escaping, the dot yields its secret: how to be exactly where the prey will be.',
          effects: [ { kind: 'buff', target: 'random', stat: 'crt', amount: 5, duration: 'run' } ] },
      ],
    },
    {
      label: 'Predict its path instead of chasing it.',
      requires: { kind: 'stat', stat: 'crt', min: 12 },
      outcomes: [
        { weight: 1,
          text: 'The sharpest eyes in the party go still, track the pattern, and slam a paw down on the dot\'s NEXT position. It never even flickered away. Legendary.',
          effects: [
            { kind: 'buff', target: 'gateCat', stat: 'crt', amount: 5, duration: 'run' },
            { kind: 'shinies', amount: 10 } ] },
      ],
    },
    {
      label: 'You are above this.',
      outcomes: [ { weight: 1,
        text: 'You are not above this. No cat is above this. But you pretend, magnificently, and the dot dims with something like disappointment.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 8 ───────────────────────────────────────────────────────────────────────
{
  id: 'dormantRoomba',
  title: 'The Dormant Roomba',
  weight: 7, floors: [3, 6],
  prompt:
    'The Ancient Enemy sleeps in its charging dock, one light blinking slow ' +
    'and red. Its dust bin rattles when the draft moves it — rattles like a ' +
    'great many shinies. Every tail in the party is already puffed.',
  options: [
    {
      label: 'Pounce it. End the bloodline.',
      outcomes: [
        { weight: 1,
          text: 'It wakes mid-pounce, shrieks a boot chime of pure malice, and comes about to face you. The floor is ITS territory. Correct this.',
          effects: [ { kind: 'fight', encounter: ['roombaScout'], loot: 'bonus',
                       onWinEffects: [ { kind: 'shinies', amount: { base: 25, perFloor: 5 } } ] } ] },
      ],
    },
    {
      label: 'Extract its battery without waking it.',
      requires: { kind: 'class', class: 'trickster' },
      outcomes: [
        { weight: 1,
          text: 'Sixty silent seconds of surgical paw-work. The light blinks once more and dies forever. The Trickster empties the dust bin into the party purse and bows.',
          effects: [
            { kind: 'shinies', amount: { base: 25, perFloor: 5 } },
            { kind: 'giveItem', item: 'catnip', count: 1 } ] },
      ],
    },
    {
      label: 'Do not wake the Ancient Enemy.',
      outcomes: [ { weight: 1,
        text: 'You give it the widest berth the corridor allows, walking sideways, fur up, eyes locked on it the entire time. It blinks once. You survive.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 9 ───────────────────────────────────────────────────────────────────────
{
  id: 'catnipPatch',
  title: 'The Wild Catnip Patch',
  weight: 9, floors: [1, 6],
  prompt:
    'Impossibly, a patch of catnip grows from a crack in the dungeon floor, ' +
    'silver-green and swaying in a breeze that is not there. The smell arrives ' +
    'a full second before your dignity leaves.',
  options: [
    {
      label: 'Roll in it. Immediately. All of you.',
      outcomes: [
        { weight: 7,
          text: 'Bliss. Cosmic, wriggling, upside-down bliss. The party emerges vibrating gently with power and covered in leaves.',
          effects: [
            { kind: 'heal', target: 'party', amount: 4 },
            { kind: 'energyNextBattle', target: 'party', amount: 2 } ] },
        { weight: 3,
          text: 'TOO much bliss. The party emerges vibrating, yes — but also giggling at load-bearing walls and walking diagonally.',
          effects: [
            { kind: 'energyNextBattle', target: 'party', amount: 2 },
            { kind: 'buff', target: 'party', stat: 'spd', amount: -1, duration: 'floor' } ] },
      ],
    },
    {
      label: 'Harvest it properly for later.',
      requires: { kind: 'class', class: 'hexer' },
      outcomes: [
        { weight: 1,
          text: 'The Hexer, breathing through her mouth with heroic restraint, cuts and wraps the potent tops the way the old rites demand.',
          effects: [ { kind: 'giveItem', item: 'catnip', count: 2 } ] },
      ],
    },
    {
      label: 'March past. You are professionals.',
      outcomes: [ { weight: 1,
        text: 'You march past in single file, pupils enormous, tails perfectly straight. Nobody rolls. Everybody wants to. It is the hardest battle of the run.',
        effects: [ { kind: 'nothing' } ] } ],
    },
  ],
},

// ── 10 ──────────────────────────────────────────────────────────────────────
{
  id: 'elderStray',
  title: 'The Elder Stray',
  weight: 7, floors: [2, 6], once: true,
  prompt:
    'On a warm grate sits the oldest cat you have ever seen — one-eared, ' +
    'scar-striped, sphinx-still. He was fighting this dungeon before your ' +
    'grandmothers were kittens. He does not get up. He does not need to.',
  options: [
    {
      label: 'Share your food with him.',
      requires: { kind: 'item', item: 'tunaSnack' },
      outcomes: [
        { weight: 1,
          text: 'He eats slowly, with ceremony, then touches his scarred forehead to each of yours. "Walk soft. Land softer." The blessing settles over you like a warm towel.',
          effects: [ { kind: 'buff', target: 'party', stat: 'def', amount: 1, duration: 'floor' } ] },
      ],
    },
    {
      label: 'Ask him for a lesson.',
      requires: { kind: 'stat', stat: 'atk', min: 12 },
      outcomes: [
        { weight: 1,
          text: 'He looks your strongest fighter up and down, sighs, and moves like weather. Three seconds and one humiliating tumble later, the lesson is IN the muscle now. So are some bruises.',
          effects: [
            { kind: 'damage', target: 'gateCat', amount: 5 },
            { kind: 'buff',   target: 'gateCat', stat: 'atk', amount: 1, duration: 'run' } ] },
      ],
    },
    {
      label: 'Settle in and listen to his stories.',
      outcomes: [
        { weight: 1,
          text: 'His purr is a war drum heard from a safe distance. He speaks of the Rat King\'s grandsire, of the Great De-Clawing, of a red dot he almost caught in \'09. Your wounds knit as you listen.',
          effects: [ { kind: 'heal', target: 'party', amount: 4 } ] },
      ],
    },
    {
      label: 'Take his spot. It looks warm.',
      outcomes: [
        { weight: 1,
          text: 'The grate is warm. The mistake is instant. The Elder rises like smoke with a grudge, and you learn firsthand why the dungeon never managed to kill him.',
          effects: [ { kind: 'fight', encounter: ['elderStray'], loot: 'bonus',
                       onWinEffects: [ { kind: 'shinies', amount: { base: 30, perFloor: 5 } } ] } ] },
      ],
    },
  ],
},
];
```

Floor-range coverage check: floor 1 pool = {yarnBall, suspiciousHuman,
perfectBox, milkBowl, catnipPatch} (5 events, ≥ the 1 needed); floors 4–6 pools
have 7–8 candidates each against 2 tiles. No floor can exhaust its pool even
with both `once` events already spent.

---

## 5. Balance Guidance

### 5.1 The Shiny-value (sv) yardstick

Every effect converts to approximate Shinies so options can be compared. These
are authoring guidelines, not runtime code:

| Effect | Value (sv) |
|---|---|
| 1 HP healed (party actually hurt) | 1 |
| 1 HP event damage | −1 |
| Tuna Snack | 15 |
| Catnip | 12 |
| Feather Wand | 40 |
| +1 atk / def, `'run'` | 35 / 30 |
| +1 atk / def, `'floor'` | 12 / 10 |
| +1 spd, `'floor'` (per cat) | 8 |
| +5 crt, `'run'` / `'floor'` (per cat) | 25 / 10 |
| +1 energy next battle (per cat) | 2.5 |
| 1 Life restored | 120 |
| Event fight, `loot: 'normal'` | ≈ 0 net (chip HP ≈ loot) |
| Event fight, `loot: 'bonus'` | ≈ +(20 + 6·floor) net before `onWinEffects` |

Multiply per-cat values by 4 for `target: 'party'`. Heals are worth less when
the party is healthy — assume **60% utilization** when budgeting (a party heal
of 8×4 = 32 HP budgets as ≈ 19 sv).

### 5.2 Authoring rules (the shape of every event)

Every event offers three roles (options may double up in 4-option events):

1. **The walk-away** — no requirement, EV 0 to +6 sv, zero variance. Always
   present (validator rule 2). Picking it is never wrong, only boring.
2. **The gamble** — no requirement, EV **+5 to +18 sv**, real downside. Worst
   outcome bounded at **−(25 + 5·floor) sv** and never lethal on its own
   (damage clamps at 1 HP; fights are the only true risk and obey combat
   rules, Lives included).
3. **The gated premium** — class / stat / item / shinies requirement,
   deterministic or near-deterministic, EV **+20 to +40 sv**. The payoff for
   party composition and hoarded resources; it should beat the gamble's EV
   *visibly*, because seeing the locked option is how the game teaches value.

At most **one** deliberately negative-EV ungated option in the pool, and it
must be telegraphed in the prompt: the Bowl of Milk's "Lap it up" (EV ≈ −3 sv
at floor 1) is the shipped one — the prompt literally states cats are lactose
intolerant. Readers are rewarded; instinct-chasers get a cheap, funny lesson;
and the Medic gate converts the same event into a guaranteed +26 sv.

Gate coverage in the shipped pool: Bruiser ×1 (suspiciousHuman), Trickster ×2
(yarnBall, dormantRoomba), Hexer ×2 (cursedPost, catnipPatch), Medic ×1
(milkBowl), stat gates spd/crt/atk (perfectBox, redDot, elderStray), item ×1
(elderStray), shinies ×1 (shrineOfNine). Every class earns at least one premium
from the pool; future content should keep classes within ±1 gate of each other.
Stat-gate thresholds sit just above base ranges (spd 8, crt 12, atk 12 vs cat
bases of spd 3–9, crt 5–15, atk 9–14) so equipment and event buffs meaningfully
unlock them mid-run.

### 5.3 EV table for the shipped pool (sv, at floor 1 / floor 4)

| Event · option | EV f1 | EV f4 | Worst case (f4) | Notes |
|---|---|---|---|---|
| yarnBall · bat | +9 | +7 | −16 (dmg 8, spd −1) | classic starter gamble |
| yarnBall · unravel (T) | +25 | +40 | — | deterministic |
| suspiciousHuman · accept | +11 | +12 | −28 (party dmg 7) | heals utilization-discounted |
| suspiciousHuman · swipe (B) | +40 | +40 | — | deterministic |
| cursedPost · scratch | +12 | +11 | −20 (dmg 10, def −1) | 25% run-buff jackpot |
| cursedPost · runes (H) | +35 | +35 | — | deterministic |
| shrineOfNine · offer | +50 net | +20 net | — | 120 sv Life minus 70 / 100 ✦ |
| shrineOfNine · pray | +14 | +14 | — | free heal, discounted |
| shrineOfNine · candle | +2.5 | +2.5 | −20 | pure flavor gamble |
| perfectBox · get in | +18 | +18 | ~0 (heal, then fight @ normal loot) | heal lands before the ambush |
| perfectBox · circle (spd 8) | +45 | +55 | — | deterministic |
| milkBowl · lap | −3 | −7 | −32 (party dmg 8) | THE telegraphed trap |
| milkBowl · sniff (M) | +26 | +33 | — | deterministic |
| milkBowl · tip | +5 | +5 | — | walk-away with a wink |
| redDot · chase | +15 | +17 | +6 (dmg 8/cat vs party spd +1) | generous on purpose; nobody resists |
| redDot · predict (crt 12) | +35 | +35 | — | deterministic |
| dormantRoomba · pounce | +32 | +51 | lose/flee the fight | `heavy` preview enemy |
| dormantRoomba · battery (T) | +42 | +57 | — | deterministic |
| catnipPatch · roll | +25 | +24 | −12 net (energy still granted) | comfort event |
| catnipPatch · harvest (H) | +24 | +24 | — | deterministic |
| elderStray · share (item) | +25 net | +25 net | — | 40 sv buff minus 15 sv snack |
| elderStray · lesson (atk 12) | +30 | +30 | — | deterministic, hurts a little |
| elderStray · stories | +10 | +10 | — | safe floor |
| elderStray · his spot | +28 | +43 | lose/flee the fight | hardest event fight |

### 5.4 Macro economy check

Per dungeon.md, floors 1–3 place 1 event and floors 4–6 place 2 (9 per run).
If players took gated premiums whenever available and gambles otherwise, the
pool would average ≈ +25 sv per event; since any given party hits a class gate
roughly half the time and stat/item gates less often, the realized average is
**≈ +16 sv per event ≈ +145 sv per run** — about two extra chests of value
spread across six floors, weighted toward parties that read prompts and keep
all four classes alive. That keeps events clearly worth stepping on without
eclipsing fights + chests (≈ 350–450 ✦ per run, loot.md §1) as primary income.

Risk budget: a maximally greedy, maximally unlucky run absorbs ≈ 9 events ×
~7 HP party-wide ≈ 60 HP of event damage across six floors — real attrition
(about five Tuna Snacks' worth) but never a run-killer by itself, per pillar 2.
The two `once` events cap the run's ceiling: at most one Life restored and one
Elder buff per run.

---

## 6. Scope & Module Budget (~770 LoC, on top of the combat/dungeon engines)

| Module | ~LoC | Contents |
|---|---|---|
| `events/types.ts` | 60 | Schema from §1 (types only) |
| `events/select.ts` | 40 | Pool filter + weighted pick (§2.1), fired-id bookkeeping, empty-pool fallback |
| `events/resolve.ts` | 120 | `resolveOption` pure function: requirement payment, outcome roll, effect application in order, result-line emission, `fightRequest` handoff |
| `events/validate.ts` | 30 | Dev-time invariant checks (§1) |
| `events/ui.ts` | 220 | The modal: PROMPT/RESULT states, option buttons + req tags, hotkeys 1–4, delta lines, dim layer |
| `data/events.ts` | 300 | The 10 events above (pure data) + `roombaScout` / `elderStray` enemy defs in `data/enemies.ts` |

Integration points (all already specified elsewhere): the dungeon step loop
pauses and consumes tiles (dungeon.md §7.2); battle setup reads
`pendingBattleMods.energyNextBattle` and folds temp mods into effective stats
(the same hook equipment already uses); the victory screen renders
`onWinEffects` delta lines. Nothing inside the combat engine changes.
