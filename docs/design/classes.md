# c(at)rpg Classes — "The Four Strays"

**Status: FINAL. Companion to `docs/design/combat.md` ("Claws & Ranks: Nine Lives
Edition").** Every stat, formula reference, skill field, and status in this
document conforms to the combat spec. The level-1 party defined here is
*identical* to the worked-example party in combat.md §13, so that example
doubles as the level-1 balance baseline and unit test. Deltas (all additive)
are logged in §12. This version replaces an earlier classes.md written against
a superseded combat spec.

The party is a fixed cast of four named strays — classes and characters are
1:1, which lets flavor text, barks, and portraits be written once and hard.

| Class id | Cat | Role (brief requirement) | One-line fantasy |
|---|---|---|---|
| `bruiser` | **Bruno** | Tank / bruiser | The immovable dumpster-court doorman who throws enemies like trash bags |
| `trickster` | **Pixel** | Single-target damage | The shelf-clearing menace who deletes one enemy at a time |
| `hexer` | **Mora** | Control / utility | The void-cat puppeteer who drags enemies out of position |
| `medic` | **Baguette** | Support / heal | The bakery loaf whose purr knits wounds shut |

---

## 1. Design goals

1. **Every class hooks the Off-Paw combo engine differently** (combat.md §8):
   Bruno *shoves*, Mora *pulls*, Pixel *cashes in* Off-Balance windows, and
   Baguette *funds* the setup turns. No class sits outside the signature system.
2. **Starter kits are complete on turn one.** Each cat starts with Claw Swipe
   plus its two core class skills — the exact 8 reference skills from
   combat.md §4. Leveling adds stats, one capstone skill (L4), and one trait
   upgrade (L7). Total: 12 class skills, matching the §14 content budget.
3. **Zero new engine systems.** Traits reuse the existing `Combatant.traits`
   hook (precedent: `'heavy'`); capstones use only existing skill fields.
4. **Deterministic leveling.** No RNG anywhere in XP or level-ups.

---

## 2. Data model

```ts
interface CatClass {
  id: 'bruiser' | 'trickster' | 'hexer' | 'medic';
  className: string;             // UI: "Bruiser"
  catName: string;               // UI: "Bruno"
  epithet: string;               // UI: portrait subtitle
  base: Stats;                   // level-1 stats (combat.md §3 shape)
  growth: Partial<Stats>[];      // 7 rows, applied at L2..L8 in order
  skills: { skillId: SkillId; unlockLevel: number }[];
  trait: CatTrait;
  flavor: { bio: string; barks: { crit: string; ko: string; catPile: string } };
  palette: { body: number; ears: number; eyes: number };  // procedural blob colors
}

interface CatTrait {
  id: string;
  name: string;
  desc: string;                  // tooltip, tier-1 wording
  tier2Level: number;            // always 7 in v1
  tier2Desc: string;             // tooltip after upgrade
}
```

### Skill interface — additive clarifications (see delta ledger §12)

The combat doc's §4 `Skill` shape is kept unchanged; four optional fields
formalize behaviors combat.md already specifies in prose (Hiss's dual
application, Soothing Purr's cleanse, Nine Lives Nudge's revive):

```ts
interface StatusApplication {
  status: StatusId;
  chance: number;                     // 0..1
  value?: number;
  to?: 'target' | 'self' | 'allEnemies';   // NEW, default 'target'
}
interface Skill /* extends combat.md §4 */ {
  applies?: StatusApplication[];
  cleanses?: StatusId[];        // NEW: remove ONE application of each listed status per target
  revivePct?: number;           // NEW: skill targets KO'd allies instead of living;
                                //      revive at pct of maxHP, placed in rank 4
  oncePerBattle?: boolean;      // NEW: latched per battle per user
}
```

Trait hooks fire at exact points in the §4 resolution pipeline; each trait
below states its injection point. All trait triggers emit a `TraitTriggered`
event for the UI layer.

---

## 3. Shared basics

Every cat knows **Claw Swipe** from level 1 (verbatim from combat.md §4):

```ts
export const CLAW_SWIPE: Skill = {
  id: 'clawSwipe', name: 'Claw Swipe',
  desc: 'A quick rake. Banks +1 Energy.',
  cost: 0, usableFrom: [1, 2],
  target: { side: 'enemy', ranks: [1, 2], pattern: 'single' },
  power: 100, kind: 'damage', energyGain: 1,
};
```

All cats also share the universal actions (combat.md §9): Move (swap), Guard
(Guarded + 2 bonus Energy), Item, Scatter. Energy: 0–10, start 4, +2 regen at
own turn start. Lives: 9 pips each (combat.md §12).

---

## 4. Bruiser — **Bruno**, "The Doorstop of Dumpster Court"

**Identity.** A huge marmalade tom with one chewed ear, retired from a decade
guarding a bodega door. Slow-blinking, unhurried, genuinely kind — until
something threatens the party, at which point he picks it up and files it in
the trash. He does not chase; things come to him and regret it.

**Role.** Tank/bruiser. Holds rank 1, eats hits (highest HP + DEF), controls
aggro with Hiss, and converts his bulk into forced-movement offense: Body Slam
and Dumpster Dunk are both damage *and* combo fuel for everyone acting after
him this round. Against bosses he is the main Poise chipper.

### Stats (level 1 → 8)

| L | HP | ATK | DEF | SPD | CRT | enMax |
|---|---|---|---|---|---|---|
| 1 | 40 | 10 | 3 | 4 | 5 | 10 |
| 2 | 44 | 11 | 3 | 4 | 5 | 10 |
| 3 | 48 | 11 | 4 | 4 | 5 | 10 |
| 4 | 52 | 12 | 4 | 4 | 5 | 10 |
| 5 | 56 | 12 | 4 | 5 | 5 | 10 |
| 6 | 60 | 13 | 4 | 5 | 5 | 10 |
| 7 | 64 | 13 | 5 | 5 | 5 | 10 |
| 8 | 68 | 14 | 5 | 5 | 5 | 10 |

```ts
base:   { hp: 40, atk: 10, def: 3, spd: 4, crt: 5, enMax: 10 },
growth: [ {hp:4,atk:1}, {hp:4,def:1}, {hp:4,atk:1}, {hp:4,spd:1},
          {hp:4,atk:1}, {hp:4,def:1}, {hp:4,atk:1} ],
```

### Skills

| Skill | Unlock | Cost | From | Target | Power | Effects |
|---|---|---|---|---|---|---|
| Claw Swipe | 1 | 0 | [1,2] | enemy [1,2] single | 100 | `energyGain: 1` |
| Body Slam | 1 | 4 | [1,2] | enemy [1,2] single | 120 | `moveTarget: +2` (shove → Off-Balance / Poise chip) |
| Hiss | 1 | 2 | [1,2] | self | 0 | Guarded to self; Provoked (1.0) to all enemies |
| **Dumpster Dunk** | **4** | 6 | [1] | enemy [1,2] single | 150 | `moveTarget: +3` — hurl them to the back row |

```ts
export const BRUISER_SKILLS: Skill[] = [
  { id: 'bodySlam', name: 'Body Slam',
    desc: 'Hit first, hurl second. The landing is your teammates’ problem.',
    cost: 4, usableFrom: [1, 2],
    target: { side: 'enemy', ranks: [1, 2], pattern: 'single' },
    power: 120, kind: 'damage', moveTarget: 2 },
  { id: 'hiss', name: 'Hiss',
    desc: 'Arch, fluff, dare them. Everyone swings at Bruno; Bruno barely feels it.',
    cost: 2, usableFrom: [1, 2],
    target: { side: 'self', ranks: [1, 2, 3, 4], pattern: 'single' },
    power: 0, kind: 'utility',
    applies: [ { status: 'guarded',  chance: 1.0, to: 'self' },
               { status: 'provoked', chance: 1.0, to: 'allEnemies' } ] },
  { id: 'dumpsterDunk', name: 'Dumpster Dunk',
    desc: 'Pick it up. Slam-dunk it into the bins at the back. Two points.',
    cost: 6, usableFrom: [1],
    target: { side: 'enemy', ranks: [1, 2], pattern: 'single' },
    power: 150, kind: 'damage', moveTarget: 3 },
];
```

Dumpster Dunk notes: a +3 shove clamps at the last occupied enemy rank
(combat.md §8); any clamped distance ≥ 1 still inflicts Off-Balance, and
versus a `heavy` boss it chips exactly 1 Poise like any forced-move attempt
(§11) — deliberately *not* a bigger chip. Its real capstone value is rank
denial: the front-liner lands in rank 3–4, outside most enemy `usableFrom`.

### Trait — **Immovable Loaf**

- **Tier 1 (L1):** Once per battle, when Bruno would be forced-moved, he does
  not move and does not become Off-Balance (the attempt is consumed).
- **Tier 2 (L7):** When it triggers, Bruno also gains **Guarded** (until the
  start of his next turn).
- *Injection point:* replaces pipeline step 2 (forced movement) for the
  triggering skill; the once-per-battle latch resets between battles.
  Voluntary movement (Move/swap, `moveSelf`) never consumes it.
- *Tooltip:* "Once per battle, Bruno simply declines to be moved."

**Play pattern.** Turn 1 is usually Hiss (2 energy, holds the line) or Body
Slam if a shove combo is queued on the timeline. He is also the party's
answer to enemy Off-Paw play: enemies that shove cats waste their best trick
on him once per fight.

---

## 5. Trickster — **Pixel**, "Warranty Voider"

**Identity.** A small gray-and-white glitch of a cat, barely two years old,
radicalized by a laser pointer she never caught. Knocks things off shelves
*professionally*. Vibrating with energy, zero respect for personal space or
enemy formations, communicates in trills. Highest SPD in the party — she
usually acts first, which makes her either the setup (Trip Wire) or, when
shoves carry over on the timeline, the payoff.

**Role.** Single-target damage. Highest ATK/CRT/SPD, lowest bulk. Pounce is
the burst opener; Trip Wire is her team-play row-shove that arms Cat Pile;
Box Ambush (capstone) is the party's only way to reach ranks 4–5, deleting
the shamans and summoners the enemy formation protects.

### Stats (level 1 → 8)

| L | HP | ATK | DEF | SPD | CRT | enMax |
|---|---|---|---|---|---|---|
| 1 | 28 | 12 | 1 | 8 | 15 | 10 |
| 2 | 30 | 13 | 1 | 8 | 15 | 10 |
| 3 | 32 | 13 | 1 | 8 | 17 | 10 |
| 4 | 34 | 13 | 1 | 9 | 17 | 10 |
| 5 | 36 | 14 | 1 | 9 | 17 | 10 |
| 6 | 38 | 14 | 1 | 9 | 19 | 10 |
| 7 | 40 | 15 | 1 | 9 | 19 | 10 |
| 8 | 42 | 16 | 1 | 10 | 19 | 10 |

```ts
base:   { hp: 28, atk: 12, def: 1, spd: 8, crt: 15, enMax: 10 },
growth: [ {hp:2,atk:1}, {hp:2,crt:2}, {hp:2,spd:1}, {hp:2,atk:1},
          {hp:2,crt:2}, {hp:2,atk:1}, {hp:2,atk:1,spd:1} ],
```

### Skills

| Skill | Unlock | Cost | From | Target | Power | Effects |
|---|---|---|---|---|---|---|
| Claw Swipe | 1 | 0 | [1,2] | enemy [1,2] single | 100 | `energyGain: 1` |
| Pounce | 1 | 3 | [3,4] | enemy [1,2] single | 150 | `moveSelf: -2` (leap to the front line) |
| Trip Wire | 1 | 4 | [2,3] | enemy [1,2] row | 60 | `moveTarget: +1` each — the Cat Pile arming tool |
| **Box Ambush** | **4** | 6 | [1,2,3,4] | enemy [1,2,3,4,5] single | 150 | No movement. The party's only rank-5 reach. |

```ts
export const TRICKSTER_SKILLS: Skill[] = [
  { id: 'pounce', name: 'Pounce',
    desc: 'Wind up the butt-wiggle, delete a face, deal with the seating chart later.',
    cost: 3, usableFrom: [3, 4],
    target: { side: 'enemy', ranks: [1, 2], pattern: 'single' },
    power: 150, kind: 'damage', moveSelf: -2 },
  { id: 'tripWire', name: 'Trip Wire',
    desc: 'A stretched string of yarn. The whole front row eats pavement.',
    cost: 4, usableFrom: [2, 3],
    target: { side: 'enemy', ranks: [1, 2], pattern: 'row' },
    power: 60, kind: 'damage', moveTarget: 1 },
  { id: 'boxAmbush', name: 'Box Ambush',
    desc: 'She vanishes into a cardboard box. The box reappears ANYWHERE.',
    cost: 6, usableFrom: [1, 2, 3, 4],
    target: { side: 'enemy', ranks: [1, 2, 3, 4, 5], pattern: 'single' },
    power: 150, kind: 'damage' },
];
```

Box Ambush is the single deliberate exception to "almost no skill reaches
rank 5" (combat.md §1): a level-4 capstone at nuke cost, so back-rank
reinforcements and summoners stay *mostly* safe — but never entirely.

### Trait — **Opportunist**

- **Tier 1 (L1):** Pixel's skills gain **+10 CRT** (i.e., +10 percentage
  points of crit chance) against **Off-Balance** targets.
- **Tier 2 (L7):** +20 CRT instead.
- *Injection point:* step 3 of the damage formula (crit roll) — use
  `user.crt + bonus` for that roll only. At L8 tier 2: 19 + 20 = 39% crit vs
  Off-Balance targets.
- *Tooltip:* "Staggered prey. +10% crit chance against Off-Balance enemies."

**Play pattern.** From rank 2 she Claws or Trip Wires; from rank 3–4 she
Pounces. Because she is fastest, comboing *into* her requires either enemy
shoves left over from the previous round or a lucky initiative jitter —
which is why her Trip Wire (setting up *others*) matters as much as her
burst. After Pounce she is in rank 1 tanking on 1 DEF: Move-swap back with
Bruno, or trust Baguette. High risk is the class.

---

## 6. Hexer — **Mora**, "The Void That Stares Back"

**Identity.** A pitch-black cat with lantern-yellow eyes who was definitely a
witch's familiar at some point — the witch is not discussed. Sits facing
empty corners. Hums. Yarn moves when she looks at it. Speaks rarely, and in
complete, unsettling sentences. The other cats pretend this is normal.

**Role.** Control/utility. She wins fights *before* the damage happens:
Yank of Yarn drags back-line threats into claw range (Off-Balance + rank
denial in one action), Hairball Hex is the party's DoT, and Phantom Cucumber
is the stun — the answer to boss windups and elite turns. Second-highest ATK
so her utility always carries real damage riders.

### Stats (level 1 → 8)

| L | HP | ATK | DEF | SPD | CRT | enMax |
|---|---|---|---|---|---|---|
| 1 | 24 | 11 | 0 | 6 | 5 | 10 |
| 2 | 26 | 12 | 0 | 6 | 5 | 10 |
| 3 | 28 | 12 | 0 | 7 | 5 | 10 |
| 4 | 30 | 13 | 0 | 7 | 5 | 10 |
| 5 | 32 | 13 | 1 | 7 | 5 | 10 |
| 6 | 34 | 14 | 1 | 7 | 5 | 10 |
| 7 | 36 | 14 | 1 | 8 | 5 | 10 |
| 8 | 38 | 15 | 1 | 8 | 5 | 10 |

```ts
base:   { hp: 24, atk: 11, def: 0, spd: 6, crt: 5, enMax: 10 },
growth: [ {hp:2,atk:1}, {hp:2,spd:1}, {hp:2,atk:1}, {hp:2,def:1},
          {hp:2,atk:1}, {hp:2,spd:1}, {hp:2,atk:1} ],
```

### Skills

| Skill | Unlock | Cost | From | Target | Power | Effects |
|---|---|---|---|---|---|---|
| Claw Swipe | 1 | 0 | [1,2] | enemy [1,2] single | 100 | `energyGain: 1` |
| Yank of Yarn | 1 | 3 | [3,4] | enemy [2,3,4] single | 60 | `moveTarget: -2` — drag them up front, Off-Balanced |
| Hairball Hex | 1 | 3 | [2,3,4] | enemy [1,2,3] single | 40 | Scratched (value 3, chance 0.9) |
| **Phantom Cucumber** | **4** | 5 | [3,4] | enemy [1,2,3] single | 30 | Frazzled (chance 0.8) |

```ts
export const HEXER_SKILLS: Skill[] = [
  { id: 'yankOfYarn', name: 'Yank of Yarn',
    desc: 'A thread of fate around the ankle. Front and center, please.',
    cost: 3, usableFrom: [3, 4],
    target: { side: 'enemy', ranks: [2, 3, 4], pattern: 'single' },
    power: 60, kind: 'damage', moveTarget: -2 },
  { id: 'hairballHex', name: 'Hairball Hex',
    desc: 'A cursed hairball takes up residence. It itches. Everywhere. Forever.',
    cost: 3, usableFrom: [2, 3, 4],
    target: { side: 'enemy', ranks: [1, 2, 3], pattern: 'single' },
    power: 40, kind: 'damage',
    applies: [ { status: 'scratched', chance: 0.9, value: 3 } ] },
  { id: 'phantomCucumber', name: 'Phantom Cucumber',
    desc: 'She conjures the IDEA of a cucumber directly behind them.',
    cost: 5, usableFrom: [3, 4],
    target: { side: 'enemy', ranks: [1, 2, 3], pattern: 'single' },
    power: 30, kind: 'damage',
    applies: [ { status: 'frazzled', chance: 0.8 } ] },
];
```

Phantom Cucumber interactions (all per existing rules, combat.md §6/§11):
Frazzled cannot be reapplied while present (no stunlock); on a double-turn
boss it consumes only one queue slot; landing it on a **Charging** boss
cancels the telegraphed nuke. The 20% fail case is real — plan a Guard or
Move-swap fallback.

### Trait — **String Theory**

- **Tier 1 (L1):** Whenever a skill Mora uses forced-moves at least one enemy
  a clamped distance ≥ 1 **or** chips boss Poise, she gains **+1 Energy**
  (cap 10, at most once per skill use).
- **Tier 2 (L7):** +2 Energy instead.
- *Injection point:* end of pipeline step 4 (after self-movement, before the
  Cat Pile trigger check, step 5).
- *Tooltip:* "Pulling strings is its own reward."

**Play pattern.** With String Theory, Yank of Yarn's real cost is 2 (1 at
tier 2) — she can pull nearly every turn, feeding Off-Balance windows to
everyone after her on the timeline. Her turn position (SPD 6, between Pixel
and the slow pair) makes her the natural combo *starter* for Bruno and
Baguette's half of the round.

---

## 7. Medic — **Baguette**, "Fresh from the Oven"

**Identity.** A plump cream-colored loaf who lived her whole life in a
bakery window, absorbing warmth and radiating it back. Purrs at a frequency
that is medically significant. Unflappable — she has seen ovens hotter than
any dungeon. Carries the party's snacks. Do not touch the snacks.

**Role.** Support/heal. Single-target burst heal with cleanse (Soothing
Purr), the run-defining in-battle revive that saves Life pips (Nine Lives
Nudge, combat.md §12), a party-wide heal-over-time capstone (Purrquake), and
an economy trait that turns her idle Guard turns into team energy.

### Stats (level 1 → 8)

| L | HP | ATK | DEF | SPD | CRT | enMax |
|---|---|---|---|---|---|---|
| 1 | 26 | 9 | 1 | 5 | 5 | 10 |
| 2 | 29 | 9 | 1 | 5 | 5 | 10 |
| 3 | 32 | 10 | 1 | 5 | 5 | 10 |
| 4 | 35 | 10 | 2 | 5 | 5 | 10 |
| 5 | 38 | 11 | 2 | 5 | 5 | 10 |
| 6 | 41 | 11 | 2 | 6 | 5 | 10 |
| 7 | 44 | 12 | 2 | 6 | 5 | 10 |
| 8 | 47 | 12 | 3 | 6 | 5 | 10 |

```ts
base:   { hp: 26, atk: 9, def: 1, spd: 5, crt: 5, enMax: 10 },
growth: [ {hp:3}, {hp:3,atk:1}, {hp:3,def:1}, {hp:3,atk:1},
          {hp:3,spd:1}, {hp:3,atk:1}, {hp:3,def:1} ],
```

Heals scale off ATK (combat.md §3): Soothing Purr heals 11 at L1 → 14 at L8.

### Skills

| Skill | Unlock | Cost | From | Target | Power | Effects |
|---|---|---|---|---|---|---|
| Claw Swipe | 1 | 0 | [1,2] | enemy [1,2] single | 100 | `energyGain: 1` |
| Soothing Purr | 1 | 4 | [3,4] | ally [1,2,3,4] single | 120 (heal) | Also removes one Scratched application |
| Nine Lives Nudge | 1 | 6 | [3,4] | KO'd ally | 0 | Revive at 30% max HP into rank 4; once per battle; no Life pip lost |
| **Purrquake** | **4** | 6 | [3,4] | ally [1,2,3,4] **row** | 60 (heal each) | Mending (value 3, chance 1.0) to each |

```ts
export const MEDIC_SKILLS: Skill[] = [
  { id: 'soothingPurr', name: 'Soothing Purr',
    desc: 'A directed rumble at healing frequency. Also dislodges cursed hairballs.',
    cost: 4, usableFrom: [3, 4],
    target: { side: 'ally', ranks: [1, 2, 3, 4], pattern: 'single' },
    power: 120, kind: 'heal', cleanses: ['scratched'] },
  { id: 'nineLivesNudge', name: 'Nine Lives Nudge',
    desc: 'A firm boop on the forehead. "Not yet. Up."',
    cost: 6, usableFrom: [3, 4],
    target: { side: 'ally', ranks: [1, 2, 3, 4], pattern: 'single' },
    power: 0, kind: 'utility', revivePct: 0.30, oncePerBattle: true },
  { id: 'purrquake', name: 'Purrquake',
    desc: 'The floor hums. Everyone’s fur settles. Everything is briefly okay.',
    cost: 6, usableFrom: [3, 4],
    target: { side: 'ally', ranks: [1, 2, 3, 4], pattern: 'row' },
    power: 60, kind: 'heal',
    applies: [ { status: 'mending', chance: 1.0, value: 3 } ] },
];
```

Purrquake value math at L1: round(0.60 × 9) = 5 HP to each living cat now,
plus Mending 3 at the start of each cat's next two turns = up to 11 HP per
cat, 44 party-wide, for 6 energy — the anti-attrition button for a floor's
long haul, versus Soothing Purr's 11-point single-target triage.

### Trait — **Purr Engine**

- **Tier 1 (L1):** When Baguette takes the **Guard** action, every *other*
  living cat gains **+1 Energy** (cap 10). (Her own Guard already banks +2,
  combat.md §9.)
- **Tier 2 (L7):** +2 Energy to each other living cat instead.
- *Injection point:* resolution of the Guard action, after her own +2.
- *Tooltip:* "An idling engine still charges the battery."

**Play pattern.** Her decision loop is the cleanest teaching tool in the
game: heal now (Purr), invest (Guard = 5+ party energy at tier 1), or hold 6
energy as revive insurance so a KO never costs a Life pip. The §13 worked
example (Baguette Guards while banking "Nine Lives Nudge money") is exactly
her intended texture.

---

## 8. XP curve and leveling rules

**Party level.** One XP pool, one level for the whole party (1–8). No per-cat
XP: it avoids catch-up rules, and a cat lost to 0 Lives (combat.md §12) never
drags a replacement economy with it. Range L1–L8 over a 5-floor run.

**XP table (cumulative):**

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Total XP required | 0 | 30 | 70 | 130 | 210 | 310 | 430 | 570 |
| (to next) | 30 | 40 | 60 | 80 | 100 | 120 | 140 | — |

```ts
export const XP_TO_LEVEL = [0, 30, 70, 130, 210, 310, 430, 570]; // index = level-1
export const LEVEL_CAP = 8;
```

**XP sources.** Each enemy's data object carries `xp`. Guideline values for
the dungeon/enemy docs: floor-1 mook 4–6, floor-3 mook 10–14, floor-5 mook
16–20, elites 2× their mook, bosses 40 / 50 / 60 by depth. Narrative events
may grant flat XP (dungeon layer's call). Fled or lost battles award nothing.
Expected pacing: L4 (capstones) during floor 2–3, L7 (trait tier 2) on floor
4–5, L8 before the final boss. Surplus XP past 570 is ignored.

**On level-up** (applied on the victory screen, immediately; multiple levels
can trigger from one battle, applied in order; zero RNG):

1. Apply the class's `growth` row for the new level. Max HP increases;
   **current HP increases by the same amount** (level-ups relieve attrition
   but never fully heal — HP persistence stays meaningful, combat.md §12).
   KO'd cats have already stood up at 1 HP post-battle and benefit normally.
2. **L4:** unlock the class capstone skill (Dumpster Dunk / Box Ambush /
   Phantom Cucumber / Purrquake). Toast + skill-bar slot pops in.
3. **L7:** trait upgrades to tier 2. Portrait trait icon gains a gold ring.
4. Energy, Lives, statuses, cooldowns: untouched. `enMax` stays 10 (items
   may raise it, combat.md §3).

---

## 9. Party synergies (intended combos, with numbers)

All numbers at level 1, variance 1.0, no crit, before DEF, unless noted.
Timeline visibility (combat.md §2) is what makes these plannable.

**S1. Yank & Slam** (the tutorial combo; appears in combat.md §13).
Mora (SPD 6) Yanks a rank-3 caster: 7 damage, pulled to rank 1, Off-Balance,
and its back-rank-only skills go offline. Bruno (SPD 4, later in the round)
Body Slams it: round(1.2 × 10 × 1.5) = **18 instead of 12** — and the slam
shoves it back *out* again, re-arming Off-Balance for anyone still to act.
String Theory refunds Mora 1 energy: net cost 2.

**S2. Wire the Pile** (the payoff spike).
Versus two front enemies (all that live): Pixel (SPD 8, usually first) Trip
Wires from rank 2: ~7 to each, both pushed 1, both Off-Balance → every
living enemy is Off-Balance → **Cat Pile prompt**: floor(0.30 × (10 + 12 +
11 + 9)) = **12** to each, DEF-ignoring. The "pile or pick" call: 24 total
guaranteed now, or decline and let Bruno + Mora swing at +50% (Body Slam 18
vs 12) while the marks last until round end.

**S3. The Poise Train** (boss burst window).
Boss (heavy, Poise 3): Mora Yanks (chip 1, +1 energy back), Bruno Body Slams
(chip 2), Pixel Trip Wires the boss's row (chip 3) → **Poise break**: windup
cancelled, boss Off-Balance, and — if the boss is alone — Cat Pile opens
(12 flat) *or* keep the mark and let the remaining actors hit for +50% with
Pixel's Opportunist adding +10 crit. Three forced-move skills in one round is
exactly affordable at battle-start energy (costs 3 + 4 + 4 vs 6/6/6 after
each cat's first regen).

**S4. Cucumber Brake** (control valve).
Boss telegraphs its 200-power row nuke ("Charging!"). Mora casts Phantom
Cucumber: 80% to Frazzle → charge cancelled AND one boss queue slot skipped.
On the 20% fail, the party still has its listed §11 outs — Guard, Hiss, or
Move-swap out of the named ranks — because the timeline shows who still acts
before the release.

**S5. Bank & Burst** (economy round).
Round N: Bruno Hisses (cost 2 — Provoked pulls all single-target damage onto
his Guarded, DEF-3 frame at −50%), Baguette Guards (Purr Engine: +1 energy
to each other cat, +2 to herself), Pixel and Mora Claw Swipe (+1 bank each).
Round N+1 everyone sits at 7–10 energy: Dumpster Dunk + Box Ambush +
Phantom Cucumber + Purrquake in a single round — the capstone alpha strike.

**Marching order default** (dungeon-side, becomes battle formation):
**R1 Bruno, R2 Pixel, R3 Mora, R4 Baguette** — the §13 worked-example order.
Advanced alternative: Pixel to R3 (Pounce opener online turn 1) with Mora at
R2 (Hairball Hex reaches from rank 2; Yank of Yarn does not — a real
tradeoff). Enemy shove-threat makes the order a defensive decision too
(combat.md §8).

---

## 10. UI flavor pack

**Portrait subtitles** (`epithet`): Bruno "The Doorstop of Dumpster Court" ·
Pixel "Warranty Voider" · Mora "The Void That Stares Back" · Baguette
"Fresh from the Oven".

**Class-select blurbs** (`flavor.bio`, one string each):

- *Bruno:* "Ten years guarding a bodega door. Nothing got in. Nothing gets
  past him now. He would simply prefer you didn't make him get up."
- *Pixel:* "Every object on every shelf is a to-do list. Every enemy is an
  object on a shelf."
- *Mora:* "She was somebody's familiar once. The yarn obeys her. The corners
  of rooms know her name. Please stop asking about the witch."
- *Baguette:* "Baked to perfection in a shop window, now applying warmth as
  a combat discipline. Carries the snacks. Guards the snacks."

**Combat barks** (floating `Text`, picked by event):

| Event | Bruno | Pixel | Mora | Baguette |
|---|---|---|---|---|
| crit | "Filed under: trash." | "YEET." | "As foretold." | "Oven's hot!" |
| own KO | "...five minutes..." | "rude." | "I have been here before." | "Mind the snacks." |
| Cat Pile | "PILE ON." | "DOGPILE! ...cat-pile!" | "The stars align." | "Group hug!" |

**Procedural palettes** (`palette`, PixiJS Graphics blob tints):

| Cat | body | ears | eyes |
|---|---|---|---|
| Bruno | `0xE08A2E` (marmalade) | `0xB5661C` | `0xF2C14E` (amber) |
| Pixel | `0x9AA7B0` (static gray) | `0x6E7B85` | `0x7CE577` (laser green) |
| Mora | `0x2B2333` (void) | `0x1C1626` | `0xFFD447` (lantern) |
| Baguette | `0xEED9B7` (crust cream) | `0xD9B98C` | `0x8A5A2B` (warm brown) |

Blob construction per combat.md §1: rounded-rect body, triangle ears, dot
eyes, line whiskers; Bruno widest, Pixel smallest with a jagged "glitch"
notch, Mora with slightly taller ears, Baguette an oval loaf with no visible
paws. Life pips render as paw prints under the portrait (combat.md §12).

---

## 11. Balance checkpoints (L1, for the tuning pass)

| Check | Value | Verdict |
|---|---|---|
| Claw Swipe DPT (Pixel vs DEF 1) | 11 avg | baseline |
| Pounce burst (Pixel, 3 en) | 17 avg | ~1.5× baseline, costs formation |
| Body Slam into Off-Balance | 18 vs 12 | shove-first ordering pays 50% |
| Cat Pile | 12 × each enemy | matches §13 example (`0.30 × 42`) |
| Full heal-out (Purrquake) | ≤ 11/cat over 3 turns | can't outpace 2 mooks' DPT — attrition holds |
| Capstone costs (5–6) | 1–2 bank turns | Bank & Burst is a real decision, not a default |
| Max crit (Pixel L8 tier 2 vs OB) | 39% | bounded; damage multiplier ceiling still 2.475 (§3) |

---

## 12. Consistency and delta ledger (vs combat.md)

| Item | Status |
|---|---|
| Level-1 party stats | Identical to §13 worked example (Bruno/Pixel/Mora/Baguette) — the example is canonically a level-1 party; Mora's 8 Lives is an early Life loss, not a level artifact |
| 8 reference skills (§4 table) | Reproduced verbatim, zero number changes |
| Class skill count | Exactly 12 (§14 budget "4 classes × 4 skills" incl. Claw Swipe per cat): the 8 existing + 4 new capstones |
| New skills use existing fields only | Dumpster Dunk (`moveTarget`), Box Ambush (rank reach), Phantom Cucumber (`applies` frazzled), Purrquake (row heal + `applies` mending) — no new engine verbs |
| `applies[].to` field | **Additive.** Formalizes Hiss's own §4 prose ("Guarded to self and Provoked to all enemies"); default `'target'` keeps every other skill unchanged |
| `cleanses`, `revivePct`, `oncePerBattle` | **Additive.** Formalize Soothing Purr / Nine Lives Nudge prose from §4 into data |
| Traits | Reuse `Combatant.traits` (precedent: `'heavy'`); four hooks with exact pipeline injection points (§§4–7 above); emit `TraitTriggered` events for the UI |
| Box Ambush reaching rank 5 | The deliberate "almost" in §1's "almost no skill reaches rank 5"; level-gated (L4) and nuke-priced (cost 6) |
| Frazzled / Off-Balance / Poise / Cat Pile rules | Untouched; capstones interact strictly through §6/§8/§11 rules |
| Leveling | New content (combat.md defers XP/loot to the dungeon layer, §12 "Victory"); deterministic, no engine changes; level-up heals only by the max-HP delta so floor attrition (§12) is preserved |
| Estimated added code | ~120 LoC data (`data/classes.ts`, `data/skills.ts`) + ~60 LoC trait hooks + ~40 LoC leveling — within the §14 "content, not engine" line |
