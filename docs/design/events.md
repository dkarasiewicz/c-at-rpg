# c(at)rpg Narrative Event System — FINAL DESIGN
## "Curious Things" (dialog events)

Short narrative vignettes on dungeon tiles: the party finds a Curious Thing, reads 1–3
sentences, and picks one of 2–4 options. Options can be gated (class, stat, item cost,
gold cost); outcomes are deterministic or seeded-weighted; effects touch HP, gold, items,
Lives, pre-battle blessings/curses, temporary stat mods, information (map/bestiary), or
spawn a fight. Everything is plain data, fully deterministic from the dungeon seed, and
consistent with `combat.md` (statuses, stats, items, Nine Lives).

Design pillars:

1. **Always a safe out** — every event has a zero-cost, zero-risk Leave option. Events are
   opt-in gambles, never gotchas.
2. **Net-positive, high-variance** — events are the run's income spikes; regular fights are
   the drain. A free gamble has positive EV but real downside.
3. **Gates reward builds** — stat/class/item-gated options remove variance at roughly the
   same EV as the gamble. Cross-event synergy exists (one event's buff unlocks another's gate).
4. **Deterministic** — one seeded stream per event instance, rolls in a specified order;
   replaying a seed replays every outcome.

---

## 1. Economy Assumptions (shared tuning constants)

Combat.md defines items only as hooks; events need concrete values, declared here (the
future loot/shop doc must adopt these or events get retuned):

| Constant | Value |
|---|---|
| Party starting gold | 15 |
| Average gold from a normal fight | `8 + 3 × floor` (loot doc to implement) |
| **tuna** (consumable) | heals one cat 12 HP; usable in battle (Item action) or from the exploration inventory. Shop price 25g. |
| **catnip** (consumable) | applies Zoomies (duration 2) to one cat in battle. Shop price 20g. |
| **cucumber** (consumable) | guaranteed Startle on one non-boss, non-Wary enemy; max one use per battle. Shop price 20g. |
| Events per floor | exactly **2** event tiles, placed on the two dead-end tiles farthest from the floor entrance (deterministic tie-break: lower tile index) |
| Reference party max-HP pool (floor 1) | 140 (46+32+28+34, §2 of combat.md) |

There is **no trinket inventory system**: permanent pickups are expressed as run-scoped
stat mods (§3, `statMod`), so no new item machinery is needed.

---

## 2. Data Schema (complete)

```ts
// ---------- identifiers ----------
type ClassId = 'bruiser' | 'pouncer' | 'oracle' | 'purrmedic';
type StatId  = 'ATK' | 'DEF' | 'SPD' | 'LCK';           // HP gated via 'lowest-hp' effects, not gates
type ItemId  = 'tuna' | 'catnip' | 'cucumber';
type BlessingId =
  | 'zoomies-start'   // start battle with Zoomies (duration 2)
  | 'stalking-start'  // start battle with Stalking
  | 'vigor-surge'     // start battle at Vigor 6 instead of 3
  | 'gunked-start'    // CURSE: start battle Gunked (duration 2)
  | 'ruffled-start';  // CURSE: start battle Ruffled (duration 2)

// ---------- who an effect hits ----------
type Who =
  | 'party'          // all 4 cats
  | 'random'         // one seeded roll: floor(rng()*4) into roster order 0..3
  | 'lowest-hp'      // lowest current HP; tie -> lowest roster index
  | `best:${StatId}` // highest effective stat; tie -> lowest roster index
  | `class:${ClassId}`;

// ---------- effects ----------
type EffectSpec =
  | { kind: 'heal';    who: Who; percent: number }   // floor(maxHP*percent/100) per cat, cap maxHP
  | { kind: 'damage';  who: Who; percent: number }   // floor(maxHP*percent/100), NEVER below 1 HP:
                                                     // events cannot KO and never spend Lives
  | { kind: 'blessing';who: Who; blessing: BlessingId; battles: number } // applied at battle
                                                     // start, decremented per battle entered
  | { kind: 'statMod'; who: Who; stat: StatId; delta: number;
      scope: 'floor' | 'run' }                       // additive; 'floor' clears on taking stairs
  | { kind: 'gold';    base: number; perFloor?: number } // amount = base + (perFloor??0)*floor;
                                                     // negative allowed; party gold clamps at 0
  | { kind: 'item';    item: ItemId; count: number } // negative removes (clamped at 0)
  | { kind: 'life';    delta: number }               // Nine Lives pool, clamped 0..9; an event
                                                     // can never end a run (0 just means the
                                                     // next KO in battle does)
  | { kind: 'reveal';  what: 'floor-map' | 'floor-bestiary' } // full map, or all weak/resist
                                                     // tags of enemy species spawned on this floor
  | { kind: 'fight';   encounter: string; ambush?: boolean;   // ambush: cats start at Vigor 0
      spoils: EffectSpec[] }                         // spoils REPLACE the fight's normal loot;
                                                     // applied only on victory (not flee/defeat).
                                                     // spoils may not contain 'fight'.
  | { kind: 'nothing' };                             // explicit no-op (still prints outcome text)

// ---------- requirements (gates; ALL must hold; evaluated when the panel opens) ----------
type Requirement =
  | { kind: 'class'; class: ClassId }        // that class is in the party (always true in v1's
                                             // fixed 4-class roster; kept for roster expansion —
                                             // in v1 these read as "the Oracle does X" flavor)
  | { kind: 'stat';  stat: StatId; min: number } // party's best EFFECTIVE stat (incl. statMods)
  | { kind: 'item';  item: ItemId; count: number } // consumed when the option is picked
  | { kind: 'gold';  amount: number };             // paid when the option is picked

// ---------- options & outcomes ----------
interface Outcome {
  weight: number;        // integer >= 1
  luckWeight?: number;   // optional: effWeight = weight + luckWeight * bestPartyLCK
                         // (use sparingly — LCK should nudge, not decide)
  text: string;          // 1–2 sentence result vignette
  effects: EffectSpec[]; // applied in listed order
}

interface EventOption {
  id: string;
  label: string;              // button text, <= 60 chars; costs auto-appended ("— 30g")
  requires?: Requirement[];   // unmet -> button shown grayed with the failed requirement
  outcomes: Outcome[];        // length 1 = deterministic (consumes NO roll)
}

// ---------- the event ----------
interface EventDef {
  id: string;
  title: string;
  icon: string;               // one char, drawn as PixiJS Text on the map tile marker
  prompt: string;             // 1–3 sentences, <= 280 chars
  trigger: {
    floors: [number, number]; // inclusive floor band
    weight: number;           // weighted draw within the eligible pool
    once?: boolean;           // max once per RUN (default: max once per FLOOR)
  };
  options: EventOption[];     // 2–4; MUST include one option with no requires and a
                              // single outcome whose effects are [{kind:'nothing'}] (the Leave)
}
```

### Runtime state (lives in the run save, ~10 fields)

```ts
interface EventRunState {
  firedOnce: string[];              // EventDefs with trigger.once already fired
  pendingBlessings: { catIndex: number; blessing: BlessingId; battles: number }[];
  statMods: { catIndex: number; stat: StatId; delta: number; scope: 'floor'|'run' }[];
}
```

Combat integration is two tiny hooks: at battle start, for each pending blessing apply the
mapped status/vigor (zoomies-start → Zoomies(2); stalking-start → Stalking; vigor-surge →
starting Vigor 6; gunked-start → Gunked(2); ruffled-start → Ruffled(2)), then decrement
`battles` and drop at 0. Effective stats read `base + sum(statMods)` — the same read path
combat.md already uses for status multipliers (mods are additive pre-multiplier).

---

## 3. Determinism Contract

Two dedicated `mulberry32` streams, disjoint from the battle streams:

- **Placement/selection stream** per floor: `mulberry32(hash(dungeonSeed, 7001 + floor))`.
  Used once at floor generation: filter the pool to `floor in trigger.floors` and
  `!(once && firedOnce)`, then draw 2 events by weight **without replacement** (same event
  never twice on one floor). Rolls: one per draw.
- **Resolution stream** per event instance: `mulberry32(hash(dungeonSeed, 7101 + floor*64 + tileIndex))`.
  Consumption order when an option is picked:
  1. **Outcome roll** — one roll, only if `outcomes.length > 1`: compute
     `effWeight_i = weight_i + (luckWeight_i ?? 0) * bestPartyLCK`, then
     `r = rng() * sum(effWeight)`, walk cumulative.
  2. **Per effect in listed order** — one roll only for `who:'random'`
     (`idx = floor(rng()*4)`). Nothing else consumes rolls.

Event fights use the normal battle stream (`dungeonSeed + encounter id`, per combat.md §3);
the event system never shares a stream with combat.

---

## 4. Resolution Flow (exact)

```
onPartyEntersEventTile(tile):
 1. Freeze exploration input; open the event panel (PROMPT state).
 2. For each option: evaluate requires against current party state.
    Unmet -> disabled + reason chip ("needs ATK 15", "needs 30g", "needs 1 tuna").
 3. Player picks an enabled option (click, or keys 1–4; Esc picks the Leave option).
 4. Pay costs NOW: subtract Requirement gold / remove Requirement items.
 5. Pick the outcome (§3 roll order). Panel switches to RESULT state.
 6. Apply effects in listed order, emitting one EventLine per effect
    (mirrors combat's BattleEvent list — the panel renders the lines, logic never draws):
      heal "+9 HP Tofu" (green) · damage "-4 HP Pip" (red) · gold "+25g" (yellow)
      item "+1 tuna" · life "+1 Life" (paw print flash) · blessing/statMod (blue)
      reveal (map ping / bestiary flip) · nothing ("...")
 7. If one effect was 'fight':
      close panel -> launch battle (ambush => all cats start at Vigor 0, not 3).
      Victory  -> apply spoils effects (same EventLine recap on the victory screen).
      Flee     -> no spoils. Defeat -> normal Nine Lives / run-over rules.
      In all cases the event is consumed.
 8. Player confirms (Space/Enter/click). Panel closes, tile becomes a consumed
    flavor tile (grayed icon), mark trigger.once if set, resume exploration.
```

Edge rules: effects are independent — a later effect still applies if an earlier one
no-ops (e.g. gold already 0). `fight` should be an outcome's **last** effect (pre-fight
effects like damage apply before battle starts; validator warns otherwise). Only one
`fight` per outcome.

---

## 5. UI Flow (PixiJS, ~180 LoC)

Single overlay container on top of the exploration scene:

- Dim layer: full-screen `Graphics` rect, black, alpha 0.6.
- Panel: 640×420 `roundRect` (fill 0x2a2438, stroke 0x8f86b8), centered.
- Title: `Text` 24px bold + the event icon char at 32px to its left.
- Prompt: `Text` 16px, wordWrap 560, italic.
- Options: up to 4 buttons (560×56 roundRect). Each shows `[n]` hotkey, label, and a
  right-aligned cost/requirement chip. Disabled = alpha 0.45 + lock reason in the chip.
  Hover/keyboard-focus = stroke highlight. Mouse click or number key activates.
- RESULT state: options are replaced by the outcome `text` (16px) and the EventLine list
  (14px, one per line, colored per §4), then a pulsing "Space ▸" continue hint.
- Map marker: event tiles draw the event's icon char in a yellow diamond; consumed tiles
  gray it out. (Which event sits on a tile is decided at floor gen, so the icon is stable
  and even teases the content — intentional: seeing "🧶" ahead is a promise.)

No scrolling, no text pagination: prompts ≤ 280 chars and outcome texts ≤ 200 chars are
validated at data load.

---

## 6. THE TEN EVENTS (complete data)

Shared shorthand in comments: EV figures use the conventions in §7.

```ts
export const EVENTS: EventDef[] = [

// ─── 1. THE MYSTERIOUS YARN BALL ─────────────────────────────────────────────
{
  id: 'yarn-ball', title: 'The Mysterious Yarn Ball', icon: '🧶',
  prompt: 'A ball of crimson yarn sits in the exact center of the corridor, ' +
          'pulsing gently, like it has a heartbeat. Every instinct you own says BAT IT.',
  trigger: { floors: [1, 3], weight: 10 },
  options: [
    { id: 'bat', label: 'Bat it. Obviously.',
      outcomes: [
        { weight: 60, text: 'It unravels into a glittering nest of dropped coins ' +
            'and — somehow — a sealed tin of tuna.',
          effects: [ { kind:'gold', base: 25 }, { kind:'item', item:'tuna', count: 1 } ] },
        { weight: 40, text: 'The yarn unravels, stands up, and SCREAMS. It was never yarn.',
          effects: [ { kind:'fight', encounter:'evt-yarn-wisps', ambush: true,
            spoils: [ { kind:'gold', base: 30 }, { kind:'item', item:'catnip', count: 1 } ] } ] },
      ] },
    { id: 'pounce', label: 'One surgical pounce, no nonsense',
      requires: [ { kind:'class', class:'pouncer' } ],
      outcomes: [
        { weight: 1, text: 'The Pouncer strikes the exact loose thread. The thing ' +
            'unspools harmlessly around a small hoard.',
          effects: [ { kind:'gold', base: 20 }, { kind:'item', item:'catnip', count: 1 } ] },
      ] },
    { id: 'leave', label: 'Walk away (agony)',
      outcomes: [ { weight: 1, text: 'You will think about this yarn for the rest of your nine lives.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 2. A SUSPICIOUS HUMAN OFFERS TREATS ─────────────────────────────────────
{
  id: 'suspicious-human', title: 'A Suspicious Human', icon: '🧥',
  prompt: 'A human in a trench coat crouches in the gloom, holding out a single treat. ' +
          '"Here kitty kitty," it says, in the voice of someone reading the words off a card.',
  trigger: { floors: [1, 4], weight: 10 },
  options: [
    { id: 'accept', label: 'Accept the treat',
      outcomes: [
        { weight: 50, text: 'Salmon flavor. Real salmon flavor. The human nods once ' +
            'and dissolves into shadow, leaving a warm feeling.',
          effects: [ { kind:'heal', who:'party', percent: 30 } ] },
        { weight: 35, text: 'The treat is three years expired. Everyone regrets everything.',
          effects: [ { kind:'damage', who:'party', percent: 12 },
                     { kind:'blessing', who:'random', blessing:'gunked-start', battles: 1 } ] },
        { weight: 15, text: 'The coat falls open. Nets. Cages. IT IS THE CATCATCHER.',
          effects: [ { kind:'fight', encounter:'evt-catcatcher',
            spoils: [ { kind:'gold', base: 40 }, { kind:'item', item:'tuna', count: 1 } ] } ] },
      ] },
    { id: 'hiss', label: 'Hiss with overwhelming force',
      requires: [ { kind:'stat', stat:'ATK', min: 14 } ],
      outcomes: [
        { weight: 1, text: 'The hiss hits like weather. The human drops the whole ' +
            'treat bag — factory sealed, definitely safe — and flees.',
          effects: [ { kind:'item', item:'tuna', count: 1 } ] },
      ] },
    { id: 'sniff', label: 'Sniff it very carefully first',
      requires: [ { kind:'stat', stat:'LCK', min: 12 } ],
      outcomes: [
        { weight: 85, text: 'Smells clean. Tastes better. The human seems genuinely pleased.',
          effects: [ { kind:'heal', who:'party', percent: 20 } ] },
        { weight: 15, text: 'Under the salmon: a whiff of van upholstery and old nets. You back away slowly.',
          effects: [ { kind:'nothing' } ] },
      ] },
    { id: 'leave', label: 'No thoughts, just leave',
      outcomes: [ { weight: 1, text: '"...kitty?" the human says, to no one.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 3. THE CURSED SCRATCHING POST ───────────────────────────────────────────
{
  id: 'cursed-post', title: 'The Cursed Scratching Post', icon: '🗿',
  prompt: 'An obsidian scratching post, taller than a human, hums in a forgotten shrine ' +
          'room. Deep gouges spiral up its length. It whispers: s c r a t c h.',
  trigger: { floors: [2, 5], weight: 6, once: true },
  options: [
    { id: 'scratch', label: 'Scratch it. It told you to.',
      outcomes: [
        { weight: 55, text: 'Power floods up through your claws. Your paws feel like thunder.',
          effects: [ { kind:'statMod', who:'party', stat:'ATK', delta: 2, scope:'floor' },
                     { kind:'heal', who:'party', percent: 10 } ] },
        { weight: 30, text: 'The post drinks from YOU. Your fur stands wrong for hours.',
          effects: [ { kind:'damage', who:'party', percent: 10 },
                     { kind:'blessing', who:'party', blessing:'ruffled-start', battles: 1 } ] },
        { weight: 15, text: 'The gouges were a warning. The post pulls its roots out of the floor.',
          effects: [ { kind:'fight', encounter:'evt-cursed-post',
            spoils: [ { kind:'gold', base: 45 }, { kind:'item', item:'catnip', count: 1 } ] } ] },
      ] },
    { id: 'sanctify', label: 'Purrmedic: sanctify it with a tuna offering',
      requires: [ { kind:'class', class:'purrmedic' }, { kind:'item', item:'tuna', count: 1 } ],
      outcomes: [
        { weight: 1, text: 'The Purrmedic kneads the offering into the base and purrs the ' +
            'old purr. The post cracks — and a stolen life flutters home.',
          effects: [ { kind:'life', delta: 1 } ] },
      ] },
    { id: 'leave', label: 'Do not scratch the evil post',
      outcomes: [ { weight: 1, text: 'The whisper follows you to the stairs. s c r a t c h.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 4. THE BOWL OF MILK ON A LEDGE ──────────────────────────────────────────
{
  id: 'milk-ledge', title: 'A Bowl of Milk, Improbably High', icon: '🥛',
  prompt: 'On a crumbling ledge sits a full bowl of milk, still cold, condensation beading. ' +
          'Nobody puts milk on a ledge in a dungeon. And yet.',
  trigger: { floors: [1, 2], weight: 8 },
  options: [
    { id: 'drink', label: 'Everyone drinks. Consequences are a tomorrow problem.',
      outcomes: [
        { weight: 70, text: 'Cold, sweet, impossible. Tails curl in unison.',
          effects: [ { kind:'heal', who:'party', percent: 25 } ] },
        { weight: 30, text: 'Reminder: adult cats are lactose intolerant. The dungeon knew.',
          effects: [ { kind:'blessing', who:'party', blessing:'gunked-start', battles: 1 } ] },
      ] },
    { id: 'skim', label: 'Send the swiftest to skim just the cream',
      requires: [ { kind:'stat', stat:'SPD', min: 12 } ],
      outcomes: [
        { weight: 1, text: 'A blur, a lick, a landing. The cream — only the cream — is shared out.',
          effects: [ { kind:'heal', who:'party', percent: 15 } ] },
      ] },
    { id: 'leave', label: 'Suspicious bowl. Leave it.',
      outcomes: [ { weight: 1, text: 'Behind you, faintly: the sound of a bowl refilling.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 5. SHRINE OF THE FIRST CAT ──────────────────────────────────────────────
{
  id: 'first-cat-shrine', title: 'Shrine of the First Cat', icon: '⛩',
  prompt: 'A dusty stone cat sits loaf-shaped on an altar, eyes closed for ten thousand ' +
          'years. The offering dish is empty. The silence is enormous and judgmental.',
  trigger: { floors: [3, 6], weight: 6, once: true },
  options: [
    { id: 'offer-gold', label: 'Offer 30 gold',
      requires: [ { kind:'gold', amount: 30 } ],
      outcomes: [
        { weight: 1, text: 'The stone eyes open a slit. Warmth pours into your legs like ' +
            'sunlight through a window.',
          effects: [ { kind:'blessing', who:'party', blessing:'vigor-surge', battles: 2 },
                     { kind:'heal', who:'party', percent: 15 } ] },
      ] },
    { id: 'offer-cucumber', label: 'Present... the cucumber',
      requires: [ { kind:'item', item:'cucumber', count: 1 } ],
      outcomes: [
        { weight: 1, text: 'The First Cat SCREAMS and levitates. Ancient coins spray from ' +
            'the altar. You are all deeply rattled by what you have done.',
          effects: [ { kind:'gold', base: 60 },
                     { kind:'blessing', who:'party', blessing:'ruffled-start', battles: 1 } ] },
      ] },
    { id: 'purr', label: 'Just purr politely',
      outcomes: [
        { weight: 40, text: 'The statue purrs back, one geological rumble. Your aches fade a little.',
          effects: [ { kind:'heal', who:'party', percent: 10 } ] },
        { weight: 60, text: 'The statue remains stone. It was always stone. Probably.',
          effects: [ { kind:'nothing' } ] },
      ] },
    { id: 'leave', label: 'Leave before it judges you harder',
      outcomes: [ { weight: 1, text: 'You bow anyway. It costs nothing to be polite to gods.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 6. THE MEWLING CRATE ────────────────────────────────────────────────────
{
  id: 'crate-kitten', title: 'The Mewling Crate', icon: '📦',
  prompt: 'A nailed-shut wooden crate rocks gently in a side room. From inside: the ' +
          'unmistakable, heart-destroying mewl of a kitten.',
  trigger: { floors: [2, 5], weight: 8 },
  options: [
    { id: 'pry', label: 'Pry the slats apart with raw strength',
      requires: [ { kind:'stat', stat:'ATK', min: 14 } ],
      outcomes: [
        { weight: 1, text: 'The slats give. A dusty kitten shoots out, headbutts every ' +
            'ankle in gratitude, and leads you to its hidden stash before vanishing upstairs.',
          effects: [ { kind:'gold', base: 15 }, { kind:'item', item:'tuna', count: 1 } ] },
      ] },
    { id: 'squeeze', label: 'Squeeze a paw through the gap',
      outcomes: [
        { weight: 55, text: 'Tiny teeth gratefully gnaw your rescuing paw. The kitten wriggles ' +
            'free and drops a shiny it was hoarding.',
          effects: [ { kind:'gold', base: 20 }, { kind:'item', item:'catnip', count: 1 } ] },
        { weight: 45, text: 'The crate SLAMS shut around your paw. The mewling stops. ' +
            'The crate grins. Crates should not grin.',
          effects: [ { kind:'fight', encounter:'evt-crate-mimic',
            spoils: [ { kind:'gold', base: 45 }, { kind:'item', item:'tuna', count: 1 } ] } ] },
      ] },
    { id: 'leave', label: 'Harden your heart. Leave.',
      outcomes: [ { weight: 1, text: 'The mewling follows you down two corridors. You are a bad cat.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 7. THE CATNIP GROVE ─────────────────────────────────────────────────────
{
  id: 'catnip-grove', title: 'The Catnip Grove', icon: '🌿',
  prompt: 'Through a crack in the masonry: a hidden grotto absolutely overgrown with ' +
          'wild catnip. The air itself is 30% giggle.',
  trigger: { floors: [1, 6], weight: 8 },
  options: [
    { id: 'roll', label: 'Roll in it. All of you. Immediately.',
      outcomes: [
        { weight: 70, text: 'Ten minutes of pure legal mayhem. You emerge vibrating with purpose.',
          effects: [ { kind:'blessing', who:'party', blessing:'zoomies-start', battles: 1 },
                     { kind:'heal', who:'party', percent: 15 } ] },
        { weight: 30, text: 'One of you overdoes it catastrophically and just lies there, sticky with dew.',
          effects: [ { kind:'heal', who:'party', percent: 15 },
                     { kind:'blessing', who:'random', blessing:'gunked-start', battles: 1 } ] },
      ] },
    { id: 'harvest', label: 'Harvest carefully, like a professional',
      requires: [ { kind:'stat', stat:'LCK', min: 10 } ],
      outcomes: [
        { weight: 1, text: 'Prime buds, cleanly nipped, plus a coin some previous ' +
            'reveler lost in the roots.',
          effects: [ { kind:'item', item:'catnip', count: 1 }, { kind:'gold', base: 10 } ] },
      ] },
    { id: 'leave', label: 'You can quit any time you want',
      outcomes: [ { weight: 1, text: 'You leave. Everyone is very proud and very sad.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 8. A VERY IMPORTANT BOX ─────────────────────────────────────────────────
{
  id: 'important-box', title: 'A Very Important Box', icon: '🟫',
  prompt: 'An empty cardboard box sits in a shaft of impossible sunlight. It is exactly ' +
          'party-sized. It has always been here. It has been waiting.',
  trigger: { floors: [1, 6], weight: 10 },
  options: [
    { id: 'sit', label: 'If it fits, it sits',
      outcomes: [
        { weight: 1, text: 'All four of you fit. Of course you fit. For one perfect moment ' +
            'the dungeon is just a sunbeam and a box.',
          effects: [ { kind:'heal', who:'party', percent: 15 },
                     { kind:'statMod', who:'party', stat:'LCK', delta: 1, scope:'floor' } ] },
      ] },
    { id: 'shred', label: 'Shred it to confetti',
      outcomes: [
        { weight: 50, text: 'Deep in the cardboard: a taped-up packet of coins and a tin. ' +
            'Some previous cat trusted this box with its savings.',
          effects: [ { kind:'gold', base: 30 }, { kind:'item', item:'tuna', count: 1 } ] },
        { weight: 50, text: 'It was just cardboard. It is now confetti. The sunbeam ' +
            'switches off like an insulted god.',
          effects: [ { kind:'nothing' } ] },
      ] },
    { id: 'leave', label: 'Too dignified for boxes (lie)',
      outcomes: [ { weight: 1, text: 'Nobody believes you. The box least of all.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 9. THE GUTTER MERCHANT ──────────────────────────────────────────────────
{
  id: 'gutter-merchant', title: 'The Gutter Merchant', icon: '🐀',
  prompt: 'A rat in a tiny, immaculate coat has set up a stall of dubious wares. ' +
          '"No refunds," it says, before anyone has spoken. "Also, hello."',
  trigger: { floors: [2, 6], weight: 8 },
  options: [
    { id: 'charm', label: 'Buy the "Genuine Lucky Ratfoot Charm" — 40g',
      requires: [ { kind:'gold', amount: 40 } ],
      outcomes: [
        { weight: 1, text: '"Not MY foot," the rat clarifies, wrapping it. It hums with ' +
            'real luck. Best not to ask whose.',
          effects: [ { kind:'statMod', who:'party', stat:'LCK', delta: 2, scope:'run' } ] },
      ] },
    { id: 'tin', label: 'Buy the unlabeled mystery tin — 15g',
      requires: [ { kind:'gold', amount: 15 } ],
      outcomes: [
        { weight: 50, text: 'TWO tins of tuna, nested. The rat winks.',
          effects: [ { kind:'item', item:'tuna', count: 2 } ] },
        { weight: 30, text: 'It contains a single, pristine cucumber. The rat refuses eye contact.',
          effects: [ { kind:'item', item:'cucumber', count: 1 } ] },
        { weight: 20, text: 'It contains a smaller, emptier tin. "Collector\'s item," says the rat.',
          effects: [ { kind:'nothing' } ] },
      ] },
    { id: 'rob', label: 'Rob the tiny merchant (you monster)',
      requires: [ { kind:'stat', stat:'ATK', min: 15 } ],
      outcomes: [
        { weight: 60, text: 'You loom. The rat sighs, hands over the cashbox, and makes ' +
            'a note in a ledger titled GRUDGES.',
          effects: [ { kind:'gold', base: 45 }, { kind:'item', item:'tuna', count: 1 } ] },
        { weight: 40, text: 'The rat produces a tiny whistle. The whistle produces the boys.',
          effects: [ { kind:'fight', encounter:'evt-rat-goons',
            spoils: [ { kind:'gold', base: 30 } ] } ] },
      ] },
    { id: 'leave', label: 'Window-shop and leave',
      outcomes: [ { weight: 1, text: '"Tell your friends," says the rat. "Not the big one. He looks bitey."',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},

// ─── 10. THE NINTH LIFE WELL ─────────────────────────────────────────────────
{
  id: 'ninth-life-well', title: 'The Ninth Life Well', icon: '🕳',
  prompt: 'A round black well, its water perfectly still, smelling of thunderstorms and ' +
          'kittenhood. Reflected in it: nine moons. One of them might be yours.',
  trigger: { floors: [4, 7], weight: 5, once: true },
  options: [
    { id: 'toss', label: 'Toss in 50 gold',
      requires: [ { kind:'gold', amount: 50 } ],
      outcomes: [
        { weight: 1, text: 'The coins never splash. A warm weight settles back into the ' +
            'party, like a sleeping kitten returned.',
          effects: [ { kind:'life', delta: 1 } ] },
      ] },
    { id: 'drink', label: 'Drink deep and hope',
      outcomes: [
        { weight: 40, luckWeight: 1,
          text: 'The water tastes like being young and lucky. One of the nine moons brightens.',
          effects: [ { kind:'life', delta: 1 } ] },
        { weight: 35, text: 'Cold water. Just cold water. The moons do not care.',
          effects: [ { kind:'nothing' } ] },
        { weight: 25, text: 'The well drinks BACK. You scatter, dripping and diminished.',
          effects: [ { kind:'damage', who:'party', percent: 20 } ] },
      ] },
    { id: 'divine', label: 'Oracle: read the water',
      requires: [ { kind:'class', class:'oracle' } ],
      outcomes: [
        { weight: 1, text: 'The Oracle stares until the reflections blink first. Every ' +
            'creature on this floor is suddenly... legible.',
          effects: [ { kind:'reveal', what:'floor-bestiary' },
                     { kind:'heal', who:'class:oracle', percent: 25 } ] },
      ] },
    { id: 'leave', label: 'Some wells are questions. Don\'t answer.',
      outcomes: [ { weight: 1, text: 'Nine moons watch you go. One of them winks.',
        effects: [ { kind:'nothing' } ] } ] },
  ],
},
];
```

### Event-only encounters & enemies (extends combat.md §9 data)

All reuse the combat enemy schema verbatim. `canFlee` per combat.md §11; spoils replace loot.

| Encounter id | Composition (rows) | canFlee | Notes |
|---|---|---|---|
| `evt-yarn-wisps` | 2× Yarn Wisp (front) | yes | ambush (cats start Vigor 0) |
| `evt-catcatcher` | 1× The Catcatcher (front) | yes | |
| `evt-crate-mimic` | 1× Crate Mimic (front) | **no** | it has your paw |
| `evt-cursed-post` | 1× Cursed Post (front) | yes | |
| `evt-rat-goons` | 2× Sewer Rat (front), 1× Rat Piper (back) | yes | reuses combat.md §9 enemies |

| Enemy | HP | ATK | DEF | SPD | LCK | weak / resist | temper | skills |
|---|---|---|---|---|---|---|---|---|
| Yarn Wisp | 14 | 8 | 0 | 12 | 0 | claw / pounce | feral | Tangle (trick, reach, power 60, effect: pull) |
| The Catcatcher | 40 | 12 | 6 | 7 | 5 | yowl / bite | hunter | Net Toss (trick, reach, power 70, 60% Gunked 2, cd 1); Grab (bite, melee, power 100) |
| Crate Mimic | 30 | 11 | 5 | 4 | 0 | pounce / trick | bully | Snap Shut (bite, melee, power 110, cd 1); Splinter Spray (claw, reach, enemy-row, power 50) |
| Cursed Post | 44 | 13 | 8 | 3 | 0 | claw / trick | feral | Splinter Lash (claw, reach, power 80, 50% Bleeding 3); Dark Bark (yowl, reach, enemy-row, power 60, cd 1) |

(Yarn Wisp weak to claw = free Swipe scanning; Cursed Post weak to claw is the joke — the
correct answer was always to scratch it.)

---

## 7. Balance Guidance

### 7.1 Gold-equivalence conventions (for EV audits)

All effects convert to "EVg" (gold-equivalent) so options can be compared on one axis:

| Thing | EVg |
|---|---|
| 1 gold | 1 |
| 1 HP healed or lost (party pool ≈ 140 on floor 1) | 1 → party heal/damage X% ≈ ±1.4·X |
| tuna / catnip / cucumber | 25 / 20 / 20 (shop price) |
| 1 Life | 60 |
| Party-wide 1-battle blessing (zoomies-start, vigor-surge) | +16 (4 per cat) |
| Party-wide 1-battle curse / single-cat curse | −16 / −4 |
| +1 to a stat, whole party, floor scope / run scope | +12 / +25 |
| floor-bestiary or floor-map reveal | +15 |
| Fight branch | spoils EVg − expected party HP loss (per-encounter estimate below) − 10 if canFlee:false |

Expected HP loss estimates: yarn wisps 10 · catcatcher 25 · crate mimic 25 · cursed post
30 · rat goons 30.

### 7.2 The rules (apply to all future events)

1. **Leave is sacred:** one requirement-free option with `[{kind:'nothing'}]`, EV exactly 0.
2. **Free gambles pay:** requirement-free risky options land at **EV +15…+30**, with a
   worst branch no worse than **−35 EVg** on floors 1–3 (−55 on 4+), and best branch at
   least **2× the EV**. Events are the income spikes of a run (~2 events/floor ≈ +50 EVg/floor,
   about two fights' worth of loot).
3. **Gates trade variance, not EV:** stat/class-gated deterministic options sit within
   **±15% of the same event's gamble EV**. Gate thresholds are tuned against the reference
   party: ATK 14 (Bruno base — met), SPD 12 (Pip 13 — met), LCK 10/12 (Pip 12 — met at 12
   exactly), **ATK 15 (NOT met at base)** — the merchant robbery needs the Cursed Post's
   +2 ATK floor buff or level-ups: deliberate cross-event synergy.
4. **Paying removes variance at a premium:** gold/item-cost options net **EV +5…+25**
   deterministic. Exception: Lives. Anything granting a Life nets ≤ +35 and lives only in
   `once:true` events behind a double gate or a ≥50g price (Lives are the run's true
   currency; cheap Lives would trivialize the Nine Lives tension).
5. **Fight branches:** probability ≤ 45% on any single option; spoils ≥ 40 EVg (they
   replace loot, so they must beat a normal fight's `8+3·floor` gold plus the HP paid);
   `ambush` only on pushover encounters (yarn wisps). Never a fight on a *paid* option.
6. **Curses are one battle, exactly** (`battles: 1`). They set up a worse next fight, never
   a death spiral. Events never KO (damage floors at 1 HP) and never spend Lives.
7. **One showcase LCK-weighted roll per pool** (`luckWeight`, well event): LCK should nudge
   odds (~+1%/point), never dominate — LCK already buys crits and status resists in combat.
8. **Maintain the audit table** (below) next to the data; a new event ships with its row.

### 7.3 EV audit of the ten events (floor-band midpoint, reference party)

| Event | Option | EV (EVg) | Spread (worst → best) |
|---|---|---|---|
| Yarn Ball | Bat it | **+46** = .6(50) + .4(30+20−10) | fight → +50 |
| | Pouncer pounce | +40 det | — |
| Suspicious Human | Accept | **+23** = .5(49*) + .35(−21) + .15(65−25) | −21 → +49 (*heal 35%≈49 when hurt; ≈+42 at 30%) |
| | Hiss (ATK 14) | +25 det | — |
| | Sniff (LCK 12) | +23.8 = .85(28) | 0 → +28 (gate buys the floor) |
| Cursed Post | Scratch | **+17** = .55(38) + .3(−30) + .15(65−30) | −30 → +38 |
| | Sanctify (class+tuna) | +35 net (60 − 25 tuna) | rule-4 Life exception |
| Milk Ledge | Drink | **+20** = .7(35) + .3(−16) | −16 → +35 |
| | Skim (SPD 12) | +21 det | — |
| Shrine | 30g offering | +23 net (32 + 21 − 30) det | — |
| | Cucumber | +24 net (60 − 20 − 16) det | — |
| | Purr | +5.6 = .4(14) | 0 → +14 (free, riskless, tiny — fine) |
| Crate Kitten | Pry (ATK 14) | +40 det | — |
| | Squeeze | **+38** = .55(40) + .45(45+25−25−10) | fight → +40 |
| Catnip Grove | Roll | **+29** = .7(37) + .3(17) | +17 → +37 |
| | Harvest (LCK 10) | +30 det | — |
| Important Box | Sit | +33 det (21 + 12) | the guaranteed-nice event; every pool needs one |
| | Shred | +27.5 = .5(55) | 0 → +55 |
| Gutter Merchant | Charm 40g | +10 net (50 − 40) det | build purchase |
| | Tin 15g | +16 net = .5(50)+.3(20) − 15 | −15 → +35 |
| | Rob (ATK 15) | **+42** = .6(70) + .4(30−30) | 0 → +70 (hard gate + fight risk = premium, rule 3 exception noted) |
| Ninth Life Well | Toss 50g | +10 net det | Lives priced at rule 4 ceiling |
| | Drink | **+22** at LCK 12 (p=.464/.313/.223) · +19 at LCK 5 | −28 → +60 |
| | Oracle read | +22 det (15 + 7) | — |

Sanity check of the shape: within every event, the free gamble and the gated/paid options
sit within a few EVg of each other (rules 3–4), the gamble owns the widest spread, and
Leave is 0. Run-level: ~2 events/floor × ~+25 average ≈ one extra shop item per floor —
meaningful, not economy-breaking.

---

## 8. Implementation Budget (~560 LoC, additive to combat's 1500)

| Module | Est. LoC | Notes |
|---|---|---|
| `events/types.ts` — schema above + load-time validator (Leave exists, prompt lengths, one fight/outcome, spoils contain no fight) | 80 | |
| `events/engine.ts` — requirement eval, cost payment, outcome roll, effect application → `EventLine[]`, run-state (blessings, statMods, firedOnce), the two battle-start/effective-stat hooks | 140 | pure functions, mirrors `resolveAction` style |
| `events/ui.ts` — panel, option buttons, requirement chips, result lines, keyboard 1–4/Esc/Space | 180 | Graphics + Text only |
| `data/events.ts` — the 10 events | 130 | §6 verbatim |
| `data/enemies-events.ts` — 4 enemies + 5 encounters | 30 | combat schema |

Testing: the engine is a pure reducer, so each event's outcome table is a unit test — seed
the resolution stream, pick each option, assert the exact `EventLine[]`. The §7.3 table
doubles as the expected-value regression fixture.
