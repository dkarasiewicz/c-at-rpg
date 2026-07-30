# c(at)rpg Classes — FINAL DESIGN
## "The Four Strays" — party classes, leveling, and synergies

Companion to `docs/design/combat.md` (the single source of truth for combat rules).
This document defines the four cat classes, their exact stats, growths, skills, passives,
the XP/leveling system, intended party synergies, and UI-facing flavor text. Every number
here is final; every skill uses the `Skill` interface from combat.md §6 verbatim.

The four reference cats from combat.md §2 (Bruno, Pip, Miso, Tofu) **are** the level-1
stat blocks of the four classes. The worked example in combat.md §12 therefore doubles as
a level-1 class balance test.

Design goals:

1. **Each class owns one axis of the combat system.** Bruiser owns geometry (rows, push,
   taunt), Pouncer owns the Stalk→Pounce burst loop, Oracle owns the weakness/bestiary
   game, Purrmedic owns attrition (HP persistence + Nine Lives economy).
2. **No dead levels, no builds.** Leveling is linear and data-driven: stats every level,
   a new skill at 3 and 5. Depth lives in combat decisions, not menus.
3. **Reuse before invention.** All 8 example skills from combat.md ship as class skills;
   only 8 new skills are added (16 class skills total + universal actions ≈ the "~20
   skills" v1 budget from combat.md §6).

---

## 1. Data Shapes

```ts
// battle/state.ts already defines: Stats = { hp, atk, def, spd, lck }
interface StatBlock { hp: number; atk: number; def: number; spd: number; lck: number; }

type ClassId = 'bruiser' | 'pouncer' | 'oracle' | 'purrmedic';
type PassiveId = 'thick-fur' | 'patient-hunter' | 'keen-whiskers' | 'bedside-manner';

interface ClassDef {
  id: ClassId;
  className: string;        // "Bruiser" — the class
  catName: string;          // "Bruno" — the default party member (fixed party v1)
  title: string;            // UI flavor: "Duke of the Dumpsters"
  bodyColor: number;        // procedural blob fill (PixiJS hex)
  accentColor: number;      // ear/stripe tint
  icon: string;             // one char, drawn as PixiJS Text in the HUD
  role: 'tank' | 'striker' | 'control' | 'support';
  base: StatBlock;          // level 1
  growth: StatBlock;        // added per level-up (integers, flat)
  passive: PassiveId;
  skills: { skillId: string; unlockLevel: 1 | 3 | 5 }[];   // exactly 4 per class
  defaultRow: 'front' | 'back';
  blurb: string;            // 1-line class select text
  barks: { levelUp: string; ko: string; lowHp: string };   // UI toast lines
}
```

Classes are plain data in `data/classes.ts`. The party is fixed in v1: one cat of each
class, named as below (renaming/recruiting is a later hook, not v1).

### Passives are enumerated engine hooks (no scripting)

| PassiveId | Class | Exact rule | Engine hook point |
|---|---|---|---|
| `thick-fur` | Bruiser | While in the **front row**, incoming damage ×0.8. Implemented as an extra `passiveMult` factor in the §3 damage `mult` chain (multiplicative with Guarding, Ruffled, etc.). Applies to Cat Pile? N/A (cats never take pile damage). Does **not** reduce Bleeding (true damage). | damage formula, defender side |
| `patient-hunter` | Pouncer | **Stalking never expires** (ignore the 3-turn expiry; still consumed on use, still no stacking). | status tick |
| `keen-whiskers` | Oracle | The **first bestiary discovery per battle** (any cat's hit records any previously-`?` tag result — weak, resist, or neutral — for any species) grants the Oracle **+2 Vigor** immediately (cap 10). Once per battle; does not trigger if the Oracle is KO'd. | bestiary write |
| `bedside-manner` | Purrmedic | Heals **cast by the Purrmedic** on an ally currently in the **front row** are ×1.25: `heal = floor(caster.effATK * |power| * 1.25 / 100)` (one floor at the end, per combat.md heal rule). Self counts if the Purrmedic is front. | heal resolution |

---

## 2. Engine Deltas (sanctioned by combat.md, made exact here)

combat.md promises three pieces of content its engine spec doesn't fully pin down. These
are the complete resolutions — total cost ≈ 35 LoC, no new systems:

1. **`Looming` status (the taunt).** combat.md §6 lists a "taunt-yowl" in the Bruiser kit;
   the status table (§8) needs one addition:

   | Status | Type | Effect (exact) | Stacking |
   |---|---|---|---|
   | **Looming** | buff | While any living cat has Looming: enemy AI **step 4 (temper targeting)** restricts the legal-target set to Looming cats, if at least one Looming cat is a legal target for the chosen skill; otherwise targeting is unaffected. Steps 0 (lethal check) and 1 (panic) **ignore** Looming — a killer still goes for the kill. Duration 2. Cats only. | No stack; refresh. |

   It ticks at the owner's turn start like every status, clears on KO, and is drawn as a
   puffed-up outline on the cat blob. AI cost: one filter line in `battle/ai.ts`.

2. **`cleanse` effect kind.** combat.md §8 says "Cleansing (Purrmedic groom skill) removes
   Ruffled, Bleeding, Gunked." Extend `EffectSpec`:

   ```ts
   interface EffectSpec {
     kind: 'status' | 'move' | 'cleanse';
     // kind 'cleanse': remove ALL of Ruffled, Bleeding (all stacks), Gunked
     // from the target. No roll, no LCK interaction, no other fields.
     ...
   }
   ```

3. **Buffs are not LCK-resisted (clarification).** The §3 status-application roll
   `applied = rng() < (chance − target.LCK / 100)` applies to **debuff-type statuses
   only** (Startled, Ruffled, Bleeding, Gunked). Buff-type statuses (Zoomies, Stalking,
   Guarding, Looming) apply at raw `chance` — a lucky ally must not shrug off his own
   Zoomies. Roll consumption is unchanged (one roll per effect per target, same order),
   so determinism is unaffected.

4. **Cat ultimate cooldowns.** Already sanctioned (§6: `cooldown?` — "enemies; also cat
   ultimates"). Exact rule for cats: after use, the skill is grayed out for `cooldown`
   of that cat's turns; tick down by 1 at the cat's turn start (same place enemy
   cooldowns tick). Cooldowns reset at battle start.

---

## 3. The Four Classes

Formation default (matches combat.md §12): **front:** Bruno, Pip — **back:** Miso, Tofu.

---

### 3.1 BRUNO the BRUISER — "Duke of the Dumpsters"

A vast, scarred orange tom with one chewed ear and the serene confidence of a cat who has
never lost an argument with a raccoon. He doesn't dodge. He doesn't need to.

- **Role:** tank / bruiser — owns the front row, the push game, and enemy attention.
- **Icon:** `▲`  **Body:** `0xE8863A` (marmalade) **Accent:** `0xB35B1E`
- **Default row:** front. **Passive:** `thick-fur` (−20% incoming damage while front row).

**Stats** (base = combat.md reference; growth per level-up):

| | HP | ATK | DEF | SPD | LCK |
|---|---|---|---|---|---|
| Base (L1) | 46 | 14 | 9 | 7 | 5 |
| Growth | +7 | +2 | +1 | +0 | +0 |
| L3 | 60 | 18 | 11 | 7 | 5 |
| L6 (cap) | 81 | 24 | 14 | 7 | 5 |

Slow forever (usually acts last — he's the round's cleanup hitter and the Cat Pile
closer, exactly as in the §12 worked example), never lucky, increasingly immovable.

**Skills** (4 = 2 starting + L3 + L5):

```ts
// L1 — from combat.md §6
{ id:'rake', name:'Rake', icon:'≡', tag:'claw', range:'melee', target:'enemy-one',
  cost:2, power:100, effects:[{kind:'status', status:'bleeding', chance:0.8, duration:3}],
  description:'Claws rake deep. 80% chance to inflict Bleeding.' },

// L1 — from combat.md §6
{ id:'body-slam', name:'Body Slam', icon:'●', tag:'pounce', range:'melee', target:'enemy-one',
  cost:4, power:130, effects:[{kind:'move', move:'push'}],
  description:'All of the cat, at once. Heavy hit that shoves the target back (Ruffling it).' },

// L3 — NEW (the taunt-yowl promised in combat.md §6)
{ id:'puff-up', name:'Puff Up', icon:'!', tag:'yowl', range:'reach', target:'self',
  cost:2, power:0, effects:[{kind:'status', status:'looming', chance:1.0, duration:2}],
  description:'Fur to maximum. Enemies can only look at YOU for 2 turns.' },

// L5 — NEW ultimate (the "push tricks" promised in combat.md §6)
{ id:'dumpster-quake', name:'Dumpster Quake', icon:'▼', tag:'pounce', range:'melee',
  target:'enemy-row', cost:5, cooldown:3, power:90,
  effects:[{kind:'move', move:'push'}],
  description:'Land on the whole front row like a dropped fridge. Shoves everything back — and everything shoved gets Ruffled.' },
```

**Playstyle notes.** Body Slam and Dumpster Quake are `pounce`-tag, so Bruno can Stalk on
a wasted turn and cash a free auto-crit slam — a tank with a burst option. Dumpster Quake
vs a full enemy front row is up to 3 Ruffles in one action (or 3 failed pushes if their
back row is full — read the board first); vs a boss the push converts to Ruffled directly
(combat.md §1). Puff Up + Guard next turn = ×0.8 × ×0.5 = 60% damage reduction while
everything swings at him.

---

### 3.2 PIP the POUNCER — "The Ambush in Socks"

A small tuxedo cat, permanently vibrating, pupils the size of dinner plates. Pip has two
states: perfectly motionless, and airborne. There is no third state.

- **Role:** single-target burst striker — owns the Stalk→Pounce→Startle loop.
- **Icon:** `»`  **Body:** `0x2B2B33` (tuxedo black) **Accent:** `0xF5F5F0` (white socks)
- **Default row:** front. **Passive:** `patient-hunter` (Stalking never expires).

**Stats:**

| | HP | ATK | DEF | SPD | LCK |
|---|---|---|---|---|---|
| Base (L1) | 32 | 15 | 5 | 13 | 12 |
| Growth | +4 | +3 | +0 | +1 | +1 |
| L3 | 40 | 21 | 5 | 15 | 14 |
| L6 (cap) | 52 | 30 | 5 | 18 | 17 |

Highest ATK and SPD in the party, DEF 5 forever: he acts first, deletes something, and
dies to a stiff breeze if the geometry goes wrong. LCK 17 at cap = 22% crit on non-Stalk
hits.

**Skills:**

```ts
// L1 — from combat.md §6
{ id:'pounce', name:'Pounce', icon:'🐾', tag:'pounce', range:'melee', target:'enemy-one',
  cost:3, power:160, effects:[{kind:'move', move:'self-front'}],
  description:'Leap on one enemy for heavy damage. You land in the front row.' },

// L1 — NEW (the "Shred" named in combat.md §6)
{ id:'shred', name:'Shred', icon:'∥', tag:'claw', range:'melee', target:'enemy-one',
  cost:2, power:80, effects:[{kind:'status', status:'bleeding', chance:0.9, duration:3, stacks:2}],
  description:'A blur of claws. 90% chance of Bleeding, 2 stacks deep.' },

// L3 — NEW (the "self-move tricks" from combat.md §6)
{ id:'slink', name:'Slink Strike', icon:'⌐', tag:'trick', range:'melee', target:'enemy-one',
  cost:2, power:70, effects:[{kind:'move', move:'self-back'}],
  description:'Bite and vanish: hit, then melt into the back row.' },

// L5 — NEW ultimate
{ id:'ninefold-flurry', name:'Ninefold Flurry', icon:'✻', tag:'pounce', range:'melee',
  target:'enemy-one', cost:5, cooldown:3, power:220,
  effects:[{kind:'move', move:'self-front'}],
  description:'Every life at once. A single target experiences nine cats.' },
```

**Playstyle notes.** The intended loop: turn 1 Stalk (+2 Vigor, Stalking banked forever
thanks to the passive), turn 2 Pounce free + auto-crit — vs a pounce-weak target that is
power 160 × crit 1.5 × weak 1.5 and a guaranteed Startle. Ninefold Flurry with Stalking
banked is the boss-poise nuke (it still counts as one weakness *hit* for the Poise meter,
per combat.md §10 — poise counts hits, not damage). Slink Strike is the panic button:
damage plus retreat out of melee reach when the front row gets hot. Shred gives him a
boss-fight job between bursts — 2 Bleeding stacks is 6 true damage per boss turn.

---

### 3.3 MISO the ORACLE — "She Who Stares at Walls"

A cream seal-point who watches empty corners with total conviction. Sometimes the corner
watches back, and then Miso knows things: what the rat fears, where the piper stands, why
the red dot can never be caught.

- **Role:** control / utility caster — owns the weakness game, the bestiary, and enemy
  geometry (pulls).
- **Icon:** `?`  **Body:** `0xEDE0C8` (cream) **Accent:** `0x6B4F3A` (seal points)
- **Default row:** back. **Passive:** `keen-whiskers` (first bestiary discovery per
  battle → Oracle +2 Vigor).

**Stats:**

| | HP | ATK | DEF | SPD | LCK |
|---|---|---|---|---|---|
| Base (L1) | 28 | 12 | 4 | 9 | 8 |
| Growth | +3 | +2 | +0 | +1 | +1 |
| L3 | 34 | 16 | 4 | 11 | 10 |
| L6 (cap) | 43 | 22 | 4 | 14 | 13 |

Frailest cat in the party; everything she has is `reach`, so she never needs to leave the
back row — protect her and she turns every fight into an open-book test.

**Skills:**

```ts
// L1 — from combat.md §6
{ id:'caterwaul', name:'Caterwaul', icon:'♪', tag:'yowl', range:'reach', target:'enemy-row',
  cost:4, power:70,
  description:'An unholy midnight noise hits an entire enemy row. Cancels boss charges.' },

// L1 — from combat.md §6
{ id:'curious-paw', name:'Curious Paw', icon:'?', tag:'trick', range:'reach', target:'enemy-one',
  cost:3, power:90, effects:[{kind:'move', move:'pull'}],
  description:'Bat the target like a dubious object, yanking it to the front row (Ruffled).' },

// L3 — from combat.md §6
{ id:'hairball', name:'Hairball', icon:'@', tag:'bite', range:'reach', target:'enemy-one',
  cost:2, power:50, effects:[{kind:'status', status:'gunked', chance:0.7, duration:2}],
  description:'Horrifying. 70% chance to Gunk the target (ATK −30%).' },

// L5 — NEW ultimate
{ id:'old-gods-yowl', name:'Yowl of the Old Gods', icon:'Ω', tag:'yowl', range:'reach',
  target:'enemy-all', cost:5, cooldown:3, power:75,
  description:'The corner she stares at stares out. Every enemy hears it; yowl-weak enemies drop where they stand.' },
```

**Playstyle notes.** Miso's four skills cover four of the five tags (yowl, trick, bite —
and Swipe covers claw), so she is the party's bestiary scanner: her passive pays +2 Vigor
for the scan, which usually funds the next probe. Curious Paw is the famous triple-threat
from combat.md §7 (reposition + Ruffle + formation warp). Yowl of the Old Gods hits every
enemy in one action: against a yowl-weak pack it is a one-button mass Startle → instant
Cat Pile check, and in boss fights it cancels a charge *and* tags every minion. Her
`bite`/`yowl`/`trick` spread means she can hit almost any weakness the Pouncer can't.

---

### 3.4 TOFU the PURRMEDIC — "The Loaf That Mends"

A perfectly round white cat, usually found in full loaf position, purring at a frequency
that knits bone. Tofu is not fast, or fierce. Tofu is *inevitable*, in a comforting way.

- **Role:** support / heal — owns attrition: HP persistence, statuses, tempo gifts.
- **Icon:** `+`  **Body:** `0xF7F3EC` (rice white) **Accent:** `0xE3A6B0` (pink nose)
- **Default row:** back. **Passive:** `bedside-manner` (own heals on front-row allies ×1.25).

**Stats:**

| | HP | ATK | DEF | SPD | LCK |
|---|---|---|---|---|---|
| Base (L1) | 34 | 10 | 6 | 8 | 10 |
| Growth | +5 | +2 | +1 | +0 | +1 |
| L3 | 44 | 14 | 8 | 8 | 12 |
| L6 (cap) | 59 | 20 | 11 | 8 | 15 |

Second-toughest cat (a healer who folds to one sneeze is a bad healer). ATK growth
matters because heals scale off ATK (combat.md §3): Lick Wounds at L6 heals
`floor(20 × 1.2) = 24`, or 30 on a front-row ally.

**Skills:**

```ts
// L1 — from combat.md §6
{ id:'lick-wounds', name:'Lick Wounds', icon:'+', tag:'trick', range:'reach', target:'ally-one',
  cost:3, power:-120,
  description:'Restorative grooming: heal an ally for 120% of your ATK.' },

// L1 — NEW (the "Gunk-cleanse groom" promised in combat.md §6 & §8)
{ id:'fastidious-groom', name:'Fastidious Groom', icon:'✚', tag:'trick', range:'reach',
  target:'ally-one', cost:2, power:-40, effects:[{kind:'cleanse'}],
  description:'Aggressive tidying. Small heal; removes Ruffled, Bleeding, and Gunk.' },

// L3 — from combat.md §6
{ id:'zoom-blessing', name:'Midnight Zoomies', icon:'~', tag:'trick', range:'reach',
  target:'ally-one', cost:3, power:0,
  effects:[{kind:'status', status:'zoomies', chance:1.0, duration:2}],
  description:'Bestow the 3 AM energy: SPD ×2 next round, +1 Vigor regen.' },

// L5 — NEW ultimate
{ id:'thunderpurr', name:'Thunderpurr', icon:'≈', tag:'trick', range:'reach',
  target:'ally-all', cost:5, cooldown:3, power:-80,
  description:'The loaf resonates. Every cat is healed for 80% of Tofu\'s ATK. Front-row cats get the deluxe treatment.' },
```

**Playstyle notes.** Between casts, Tofu Swipes (banking Vigor and scanning `claw` on
whatever is adjacent) or Guards. Fastidious Groom is the counter to Gunk-heavy floors
(Rat Pipers) and to boss Bleeding, and at cost 2 it's spammable. Midnight Zoomies is
secretly an *offensive* skill — it re-orders next round's initiative strip (see synergy
#4). Thunderpurr heals up to 4×24+25% at L5-6 per action — the reason HP-persistence
attrition (combat.md §11) is survivable without grinding.

---

## 4. XP & Leveling

### Rules

- **One shared party level** (1–6). No per-cat XP: one counter in the HUD, one toast on
  level-up, no KO'd-cat-missed-XP bookkeeping. All four cats always share the level.
- **XP is awarded only on victory** (flee = 0 XP), on the loot screen — never mid-battle,
  so the battle resolver stays pure (combat.md §13).
- **XP per enemy killed:** `5 + 3 × floorNumber`. **Boss:** `30 + 15 × floorNumber`.
  (Floor 1 rat = 8 XP; floor 1 boss = 45 XP.)
- **Thresholds** (cumulative XP for level; plain data, not a formula):

  ```ts
  const XP_THRESHOLDS = [0, 50, 120, 220, 350, 520];  // index = level-1 → total XP needed
  ```

  Intended pacing over a 5-floor run (≈6 encounters + boss per floor): L2 mid-floor-1,
  L3 after boss 1, L4 during floor 2, L5 mid floor 3, L6 (cap) on floor 4. The final
  floors are faced at cap — endgame difficulty tunes against known numbers.

### What a level-up grants (all resolved on the loot screen, in this order)

1. **Stats:** every cat (including currently-KO'd cats) adds its class `growth` block.
2. **Heal:** every non-KO'd cat heals `floor(0.25 × newMaxHp)` (overheal discarded).
   KO'd cats are unaffected (they already revived at 30% if the battle was won —
   combat.md §11; revive resolves before XP).
3. **Skills:** at level 3 and level 5, each class's listed skill unlocks with a toast
   ("Pip learned **Slink Strike**!"). Ultimates arrive at 5 with their cooldowns.
4. Nothing else. No skill points, no stat choices, no respecs — v1 leveling is a
   pure data application, ~30 LoC.

### Multi-level overflow

XP can bank past a threshold (a boss kill can grant two levels); apply level-ups one at a
time in a loop. XP past level 6 is discarded.

---

## 5. Party Synergies (intended, tested-on-paper combos)

The classes are tuned so these four lines emerge naturally; enemy design should
periodically invite each one.

1. **The Softening Pull** (Miso → Pip). Miso's Curious Paw drags a back-row enemy to the
   front: it's now melee-legal, **Ruffled ×1.25**, and out of formation. Pip, Stalking
   banked, hits it with a free auto-crit Pounce: vs a pounce-weak target that's
   `power 160 × 1.5 crit × 1.5 weak × 1.25 Ruffled ≈ ×4.5` — enough to delete any
   non-boss on-level enemy in one action, with a guaranteed Startle as the corpse
   insurance. Cost: 3 Vigor total across two cats.

2. **Anthem & Slam Pile** (Miso + Bruno + anyone). Against packs with mixed weaknesses:
   Miso's Caterwaul/Old Gods Yowl mass-Startles the yowl-weak, Bruno's Body Slam (or a
   Stalked slam) Startles a pounce-weak straggler, and the instant the last living enemy
   is Startled the **CAT PILE** fires (combat.md §7) — `0.5 × sum(party effATK)` through
   DEF to everything. Bruno acting late in the round (SPD 7) makes him the natural pile
   trigger, exactly as in the §12 worked example.

3. **The Loaf Wall** (Bruno + Tofu). Bruno Puffs Up (Looming — tempers must target him),
   stands front (`thick-fur` ×0.8), and Guards on off-turns (×0.5, +1 Vigor) — incoming
   damage ×0.4 while the squishy back row is untouchable to temper-driven AI. Tofu's
   `bedside-manner` pays ×1.25 on every heal into him because he's front-row. The lethal
   check (AI step 0) still bypasses Looming, so the wall is strong, not degenerate: never
   let Pip sit at kill-range HP and assume the taunt saves him.

4. **Tempo Snipe** (Tofu → Pip/Miso). Midnight Zoomies doubles SPD for **next round's**
   initiative (combat.md §4): Zoomies-Pip (SPD 26+) is guaranteed first on the strip, so
   he can Startle the fastest enemy *before its turn* — deleting a whole enemy action —
   and the +1 Vigor regen funds Ninefold Flurry a turn early. Cast it the round before
   you need the burst; the strip shows you the payoff immediately.

5. **Boss Bleed Clock** (Bruno + Pip vs bosses). Bosses can't be pushed or turn-skipped,
   but Bleeding is true damage (ignores DEF and all multipliers). Rake (1 stack) + Shred
   (2 stacks) = max stacks = **9 damage per boss turn**, no rolls after application, plus
   both hits feed the Poise meter if they're on-weakness. The slow classes get a
   boss-fight identity that isn't just "hit it".

---

## 6. UI-Facing Flavor Text

### Class select / party screen blurbs (one line each)

- **Bruno — Bruiser** · *Duke of the Dumpsters.* "Tanks with his face. Argues with
  geometry, wins."
- **Pip — Pouncer** · *The Ambush in Socks.* "Two states: statue and shrapnel. Point him
  at the biggest problem."
- **Miso — Oracle** · *She Who Stares at Walls.* "Knows what the rat fears. The rat does
  not know what Miso fears. Nothing does."
- **Tofu — Purrmedic** · *The Loaf That Mends.* "Purrs at a frequency that knits bone.
  Round is a shape AND a strategy."

### Barks (drawn as floating PixiJS Text; `barks` field in ClassDef)

| Cat | Level up | KO (ghost pop) | Low HP (<25%, once per battle) |
|---|---|---|---|
| Bruno | "Bigger. Good." | "…save my spot." | "Tis a scratch." |
| Pip | "FASTER." | "was worth it" | "ow ow ow ow" |
| Miso | "As foretold." | "The corner calls." | "Inadvisable." |
| Tofu | "More loaf to love." | "brb" | "Healer needs healing!" |

### System toasts

- Level up: `"MEOWVELOUS! The party reaches level {n}!"`
- Skill unlock: `"{cat} learned {skill}!"`
- Cat Pile (already in combat.md, restated for UI): `"CAT PILE!!!"` with the dust cloud.
- Level cap: `"Level 6 — as sharp as claws get."`

---

## 7. Balance Reference (sanity numbers)

Assumed on-level enemy at floor *f*: HP ≈ `20 + 12f`, DEF ≈ `2 + 1.5f` (content doc will
finalize; classes were tuned against this line and the floor-1 blocks in combat.md §9).

| Check | Math | Result |
|---|---|---|
| L1 Pip Stalk→Pounce vs pounce-weak rat (DEF 3) | worked example §12 | 51 dmg — kills any floor-1 enemy from half HP ✓ |
| L6 Pip Ninefold Flurry (Stalked) vs floor-5 elite (DEF 10) | `30×2.2=66 → ×100/110=60 → ×1.5 crit = 90` (±var) | ~90, ~everything non-boss dies ✓ |
| L6 Bruno survivability vs floor-5 hit (ATK 25, power 100) | `25 → ×100/114 = 21.9 → ×0.8 fur` | ~17/hit → ~5 hits to drop from 81 HP ✓ |
| L6 Tofu Thunderpurr | `floor(20×0.8)=16` ×4 cats, front ×1.25→20 | 72 party HP/action, cd 3 ✓ |
| Vigor economy | costliest rotation (4+5) needs Swipe/Stalk filler turns | builders stay mandatory ✓ |

Growth deliberately keeps DEF low on Pip/Miso: the divisor formula means back-row
placement, Looming, and Startle-tempo — not stats — are their real defenses. That keeps
the row game load-bearing at every level.

## 8. Implementation Cost

Fits the combat.md §13 budget: classes/skills/passives are rows in `data/classes.ts` and
`data/skills.ts` (~120 LoC of the 350 budgeted for skills+data); engine deltas from §2
(~35 LoC: Looming filter in `ai.ts`, `cleanse` branch in the effect resolver, buff/debuff
flag on statuses, cat cooldown tick); leveling is ~30 LoC in the loot screen plus one HUD
counter (inside the 100 LoC "misc" line).
