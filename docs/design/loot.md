# c(at)rpg Loot, Items & Economy — FINAL DESIGN
## "Shinies & Snacks" (Nine Lives Edition)

Companion to `combat.md` ("Claws & Ranks: Nine Lives Edition" — the single source of
truth for stats, formulas, statuses, and battle rules). This doc defines currency,
equipment, consumables, drop tables, the merchant, and inventory rules. Every number is
exact; all loot RNG is seeded and drawn in a specified order.

> **Realignment note:** this doc replaces the earlier "Shinies & Snacks" written against
> the superseded combat spec (Vigor/LCK/Zoomies era). Anything in `dungeon.md` §9.4,
> `events.md`, or `gameloop.md` that names old items (Stat Treat, Catnip Sprig, Sardine
> Oil, Jingle Decoy, Grooming Kit) or old stats/statuses is superseded by the tables
> below — see the Realignment Ledger (§12).

Design pillars:

1. **Every drop is readable in one glance** — an item is (slot, rarity color, 1–3 stat
   lines, maybe one effect line). No sockets, no durability, no crafting.
2. **Loot feeds combat.md, never forks it** — items touch only the six stats
   (`hp atk def spd crt enMax`), the six statuses, Energy, Poise, Off-Balance, Cat
   Pile, and Nine Lives. Zero new combat mechanics; every Mewthical effect is one
   conditional on a rule that already exists.
3. **Items are reliable** — no accuracy rolls in combat, so no chance-to-fail on
   items either. Every `applies` on an item is `chance: 1.0`. Scarcity, not
   probability, is the balance knob.
4. **Shinies must hurt to spend** — one faucet curve, three sinks (consumables, gear,
   paid healing), tuned so a floor's income buys roughly one meaningful thing.
5. **Deterministic** — per-floor loot streams, rolls in a fixed order; the same
   `runSeed` produces the same chests, drops, and shop stock.

**Assumed run shape** (owned by `dungeon.md`, restated as the tuning baseline):
a run is **6 floors**; bosses on floors **3 and 6**; per floor ~**6 regular fights**,
**`2 + floor(n/3)` chests** (2,2,3,3,3,4), **1–2 events**. Enemy stats are assumed to
roughly double from floor 1 to floor 6; the gear curve in §3 is tuned against that.
**XP/leveling is out of scope here** (classes/gameloop layer); this doc is the gear
half of the power curve only.

---

## 1. Currency — **Shinies** ✦

Cats do not care about gold. They care about **Shinies**: bottle caps, foil balls, a
lost earring, one (1) human car key. A single fungible party-wide currency.

- Integer, **cap 999** (HUD: `✦ 137`). Takes no inventory slot.
- Overflow beyond 999 is discarded with a smug log line ("The pile is tall enough.").
- **Faucets:** fight victories, chests, bosses, events, selling items.
- **Sinks:** the Peddler's stock (consumables + one gear piece), the Warm Lap healing
  service, event options that cost Shinies.
- Shinies do **not** persist between runs (no meta-currency in v1).
- **Lives are never for sale.** Per combat.md §12, only a rare shrine *event* can
  restore a Life pip. No item or shop service touches Lives (the Ninth Bell unique,
  §4, prevents one loss — it never restores).

### Shiny income (exact; `n` = floor number)

| Source | Amount |
|---|---|
| Regular fight victory | `8 + 4n + rngInt(0, 4)` |
| Chest (always, on open, plus its draws §5) | `15 + 8n` |
| "Shiny pile" chest draw (§5b) | additional `15 + 8n` |
| Floor boss (floors 3, 6) | `60 + 25n` |
| Events | per event data, via bundles (§5d) |
| Selling an item | §6 sell formula |

Fleeing ("Scatter!") yields nothing — the encounter entity remains (combat.md §12).

---

## 2. Equipment Model — 2 slots per cat

Each cat has exactly **2 equipment slots**:

| Slot | What | Who can equip |
|---|---|---|
| **Weapon** | Class weapon (4 archetypes, one per class) | Only its class |
| **Trinket** | Collar/charm/toy (6 archetypes) | Any cat (universal) |

**Why this split (the pick, justified):** class-locked weapons carry class identity
and guarantee ATK is distributed across the party instead of funneled onto one cat
(ATK powers heals too — combat.md §3 — so the Medic's "weapon" matters with zero
extra code). Universal trinkets guarantee that every trinket drop is relevant to
somebody, so loot moments never whiff completely. 2 slots × 4 cats = 8 equipped
pieces — a steady upgrade drip over 6 floors (~15 equipment drops/run, §5) without an
inventory-management minigame. **No armor slot:** `def`/`hp` roll on trinkets and
weapon secondaries, and ranks + Guard already carry the defense gameplay.

- Equipping/unequipping/swapping between cats: **free, exploration only** (never
  mid-battle). Replaced gear returns to the shared inventory.
- Equipped items do not occupy inventory slots.
- Item stats are **flat additive bonuses** summed onto the cat's base stats. Combat
  reads the summed value everywhere (`atk` in the damage/heal formulas and Cat Pile,
  `spd` in initiative and flee, `crt` in the crit roll, `enMax` as the energy cap —
  which items may push past 10, per combat.md §3's note). Bonus `hp` raises max HP
  and current HP by the same amount on equip; on unequip, current HP drops by the
  bonus but never below 1.
- **When a cat dies for good** (0 Lives, combat.md §12) its equipment drops into the
  shared inventory (grief loot). Its class weapon becomes sell fodder — and its class
  weapons stop dropping (§5 class roll is over *living* classes).

### Archetypes (10 fixed defs — data, not code)

**Weapons** (primary stat always `atk`; secondary pool fixed per def):

| Class | Weapon def | Icon | Secondary pool |
|---|---|---|---|
| Bruiser | Mitts of Menace | `▣` | `[hp, def]` |
| Trickster | Ribbon Rapier | `⌇` | `[spd, crt]` |
| Hexer | Tangle Talisman | `✶` | `[crt, enMax]` |
| Medic | Chime Bell | `ᛒ` | `[hp, enMax]` |

**Trinkets** (primary stat fixed per def):

| Trinket def | Icon | Primary | Secondary pool |
|---|---|---|---|
| Fluffy Collar | `◯` | `hp` | `[def, spd]` |
| Cardboard Cuirass | `⩌` | `def` | `[hp, spd]` |
| Tin Bell | `°` | `spd` | `[crt, enMax]` |
| Dried Lucky Beetle | `⋔` | `crt` | `[spd, atk]` |
| Yarn Bangle | `❋` | `enMax` | `[hp, crt]` |
| Spiked Collar | `ʌ` | `atk`* | `[def, crt]` |

\* The Spiked Collar uses the reduced **trinket-atk base** (§3) so it supplements a
weapon rather than replacing one.

Display name = rarity prefix + def name: Stray (no prefix), "Sleek …", "Pedigree …";
Mewthical items use unique hand-authored names (§4).

---

## 3. Rarity, Item Level & Stat Values (exact)

```
Rarity       color     rarityMult  secondary lines  extra
stray        #9aa0a6   1.00        0                —
sleek        #4caf50   1.25        1 (rolled from pool of 2)
pedigree     #42a5f5   1.50        2 (the whole pool)
mewthical    #f2b01e   1.75        2 (the whole pool) + unique effect (§4)
```

- **Item level `L`** = the floor the item dropped on. Boss drops and the Peddler's
  gear stock use `L = floor + 1` (formulas are linear; L may exceed 6).
- Per-stat **base values** by L (these are the whole scaling model — no separate
  floor multiplier):

| Stat | base(L) | L=1..6 |
|---|---|---|
| `atk` (weapon) | `1 + L` | 2, 3, 4, 5, 6, 7 |
| `atk` (trinket) | `ceil((1 + L) / 2)` | 1, 2, 2, 3, 3, 4 |
| `hp` | `3 + 2L` | 5, 7, 9, 11, 13, 15 |
| `crt` (percentage points) | `3 + L` | 4, 5, 6, 7, 8, 9 |
| `def` | `L <= 3 ? 1 : 2` | 1, 1, 1, 2, 2, 2 |
| `spd` | `L <= 3 ? 1 : 2` | 1, 1, 1, 2, 2, 2 |
| `enMax` | `L <= 3 ? 1 : 2` | 1, 1, 1, 2, 2, 2 |

`def`, `spd`, and `enMax` are deliberately tiny: the damage formula subtracts flat
DEF (each point negates ~1 damage per hit, min 1), a point of SPD reorders the whole
timeline, and a point of enMax deepens every bank. Big numbers live on `atk`/`hp`.

```
primaryValue(stat, L, rarity)   = max(1, round(base(stat, L) · rarityMult))
secondaryValue(stat, L, rarity) = max(1, round(0.5 · base(stat, L) · rarityMult))
```

`round` = round half up, matching combat.md. Values are **formulas, not rolls** —
the only randomness in an item is *which* secondary a Sleek picks (§5 roll order).
Adjacent rarities can tie on base-1 stats; the extra secondary line (and the
Mewthical hook) still makes every tier strictly better.

Reference — **weapon `atk` primary**:

| L | stray | sleek | pedigree | mewthical |
|---|---|---|---|---|
| 1 | +2 | +3 | +3 | +4 |
| 3 | +4 | +5 | +6 | +7 |
| 6 | +7 | +9 | +11 | +12 |

(**`hp` primary**: L1 = 5/6/8/9 … L6 = 15/19/23/26.)

### Worked item examples

- **Sleek Ribbon Rapier, L3** (Trickster): `atk +5`, plus one of `spd +1` /
  `crt +4` (secondary roll). Pixel's Pounce goes from base 18 to 25.5 pre-variance.
- **Pedigree Cardboard Cuirass, L5**: `def +3, hp +10, spd +2`. On Bruno (DEF 3 →
  6), a floor-5 rat's 12-damage Shiv drops to 6 — Guarded on top makes it 1s.
- **Mewthical Yarn Bangle = "Ball of Pure Yarn", L6**: `enMax +4, hp +13, crt +8`
  + starts battles at 6 Energy (§4). Nine Lives Nudge (cost 6) is live on turn 1.

---

## 4. Mewthical Uniques (the whole list — hand-authored, one hook each)

A Mewthical drop of a given def **is** that def's unique: fixed name, stats per §3 at
×1.75 with both secondaries, plus one effect. 8 uniques (4 weapons, 4 trinkets;
Cardboard Cuirass and Spiked Collar have none — see the roll rule in §5). Each effect
is one conditional in an existing combat.md code path:

| Def | Unique name | Effect (exact) | Hook location |
|---|---|---|---|
| Mitts of Menace | Dumpster Lid Mitts | Wearer's forced-move attempts chip **2 Poise** on `heavy` targets (instead of 1; still max once per skill use) | `resolve` movement step (combat.md §11.1) |
| Ribbon Rapier | The Red Dot | Wearer's crits also inflict **Off-Balance** on the target (`heavy`: chip 1 Poise instead; max once per skill use) | `resolve` damage step |
| Tangle Talisman | Grandmother's Cursed Yarn | Wearer's skill `applies` chances are treated as **1.0** | `resolve` status step |
| Chime Bell | Bell of Purrfect Pitch | Wearer's heal-kind skills also grant **Mending** value 2, 2 rounds (stacking per combat.md §6) | `resolve` heal step |
| Fluffy Collar | Static-Charged Fluff | When an enemy force-moves the wearer (clamped distance ≥ 1), the mover becomes **Off-Balance** (`heavy` mover: chip 1 Poise) | `resolve` movement step |
| Tin Bell | The Ninth Bell | Once per run: when the wearer would lose a Life after battle, it doesn't. The bell cracks (effect flag disabled on the instance) | `turns` Lives bookkeeping (combat.md §12) |
| Dried Lucky Beetle | Alpha Beetle | **Cat Pile** counts the wearer's `atk` twice in `sum(living cats' atk)` | `resolve` Cat Pile (combat.md §8) |
| Yarn Bangle | Ball of Pure Yarn | Wearer starts every battle at **6 Energy** (instead of 4; cap still applies) | battle setup (combat.md §5) |

No unique alters targeting, the initiative queue, or adds a seventh status — the
resolver stays pure, and combat.md's worked example remains a valid unit test with no
gear equipped. RNG note: Grandmother's Cursed Yarn changes roll *consumption* (see
the chance-1.0 rule in §5e); that is deterministic because gear is part of state.

---

## 5. Drop Tables (exact weights)

All weighted rolls are d100 against cumulative weights from the appropriate stream
(§5e). Rarity weights by floor band (fights, chests, and event `GEAR`):

| Floors | stray | sleek | pedigree | mewthical |
|---|---|---|---|---|
| 1–2 | 55 | 35 | 9 | 1 |
| 3–4 | 30 | 40 | 25 | 5 |
| 5–6 | 15 | 35 | 40 | 10 |

Equipment roll, once rarity is known: slot `weapon 40 / trinket 60`; weapon class
uniform over **living cats' classes** (a dead class's weapon never drops again);
trinket def uniform over the 6 defs. **Mewthical rule:** the drop becomes that def's
unique (§4); if that unique already dropped this run — or the def has no unique — the
drop downgrades to Pedigree of the same def.

### 5a. Regular fight victory
1. Shinies: always (§1).
2. Consumable: **25%** → 1 roll on the consumable table (§7 weights).
3. Equipment: **10%** → rarity by floor band, `L = floor`.
(Both can hit on the same fight; rolls in this order.)

### 5b. Chest
Shinies `15 + 8n` on open, then **2 independent draws**, each:

| Draw | Weight | Contents |
|---|---|---|
| Consumable | 60 | 1 roll on the consumable table (§7) |
| Equipment | 30 | 1 piece, rarity by floor band, `L = floor` |
| Shiny pile | 10 | additional `15 + 8n` ✦ |

Chest contents are **pre-rolled at floor generation** and stored on the chest entity
(dungeon.md — savescumming a chest is impossible).

### 5c. Floor boss (floors 3 and 6)
Guaranteed, in order:
1. Shinies `60 + 25n`.
2. **1 equipment**, `L = floor + 1`, rarity `pedigree 70 / mewthical 30`.
3. **2 consumable rolls** (§7 table).
(The floor-6 boss still drops — the victory screen doubles as the run scoreboard.)

### 5d. Events
Events reference **named bundles** so event data stays declarative and never invents
loot math:

| Bundle | Contents |
|---|---|
| `SNACK_STASH` | 2 consumable rolls (§7) |
| `SHINY_HOARD` | `30 + 10n` ✦ |
| `GEAR` | 1 equipment, rarity by floor band, `L = floor` |
| `GEAR_FANCY` | 1 equipment, `L = floor + 1`, rarity `pedigree 70 / mewthical 30` |
| `TITHE` (punishment) | lose `min(current, 20 + 5n)` ✦ |
| `MOULT` (punishment) | a seeded-random **equipped** item is unequipped and downgraded one rarity tier (values recomputed per §3; sleek→stray drops its secondary; stray → destroyed). No equipped items → a seeded-random cat loses 12 HP (min 1 left) instead |

(The Life-restoring shrine in events.md is an event *effect*, not a loot bundle —
combat.md §12 owns that rule.)

### 5e. Determinism contract (streams and roll order)

- **Floor loot stream:** `mulberry32(hash(runSeed, 'loot', n))` — chest pre-rolls at
  generation (in chest placement order), then fight/event rolls in play order.
- **Shop stream:** `mulberry32(hash(runSeed, 'shop', n))` — Peddler stock (§6).
- **Battle stream** (combat.md §3) is never touched by loot: item use in battle
  consumes **zero rolls** — item skills have `power: 0` (no variance/crit) and all
  `applies` are `chance: 1.0`. Engine-wide rule: **a status chance of exactly 1.0
  draws no roll** (also covers Hiss's Provoked and Grandmother's Cursed Yarn).
- Per loot grant, rolls in this order (unneeded rolls are skipped, not burned):
  ① Shinies variance (fights only) → ② drop-chance rolls (§5a) → ③ category/draw
  roll → ④ rarity → ⑤ slot → ⑥ def pick (weapon class / trinket def) →
  ⑦ Sleek secondary pick (1 roll, uniform over the pool of 2; Pedigree/Mewthical
  take both, no roll). Stat values are formulas (§3) — no rolls.

Per-run expected equipment: ~3.6 from fights + ~10 from chests + 2 boss + 5 shop
stock ≈ **15–17 pieces** against 8 slots — enough churn to see the rarity ladder
climb without flooding the 16-slot inventory (§8).

---

## 6. Merchant — **The Peddler at the Landing** (kept, relocated)

**Kept, not cut** — without a sink, Shinies are dead weight and half of every chest
is noise. But the merchant is **not a dungeon tile**: he is a screen. Between floors
(after taking the stairs down, before the next floor loads) the party passes a
stairwell landing where a fat orange cat sits on a cushion with a bindle. This cuts
all map/pathfinding/tile integration — the Peddler is a pure PixiJS panel that
appears exactly 5 times per run (after floors 1–5), which also gives the economy a
fixed cadence: *floor income → landing spend*.

**Stock** (rolled once from the shop stream when the landing opens; `n` = the floor
just cleared; sold-out slots stay empty):

1. **Tuna Snack** (always).
2. **Sardine Tin 50 / Warm Milk 50** (one roll).
3. Two rolls on the consumable table (§7; duplicates allowed).
4. **1 equipment piece**, `L = n + 1`, rarity `sleek 50 / pedigree 40 / mewthical 10`.
5. **Warm Lap** (service, once per landing): every living cat heals
   `round(0.40 × maxHp)`. The only out-of-combat party heal in the game — combat.md's
   "no auto-heal" attrition stands; recovery is a priced decision.

### Prices (exact)

```
consumable buy  = def.price                     // §7 table
equipValue(L,r) = round((15 + 9L) · pmult)      // pmult: 1 / 1.6 / 2.5 / 4
equipment buy   = equipValue
Warm Lap        = 30 + 15n                      // 45, 60, 75, 90, 105
sell (anything) = floor(buy value / 4), min 1   // only at a landing
```

Reference: after floor 3 (~384 ✦ income, §9) the landing offers an L4 Pedigree piece
at `round(51·2.5)` = **128 ✦**, a 75 ✦ Warm Lap, and snacks — buying all of it means
arriving on floor 4 broke. Off-class or duplicate Mewthicals sell for
`floor((15+9L)·4/4)` = 15+9L — a payday, not a jackpot.

---

## 7. Consumables (10 — every effect maps to combat.md verbatim)

Used via the **Item** action in battle (one full turn, combat.md §9, usable from any
rank) or freely during exploration where marked. Per combat.md §4, item effects are
Skill-shaped data with `cost: 0` resolved by the normal pipeline — which means a
thrown Squeaky Toy's forced move inflicts Off-Balance, chips boss Poise, and **can
complete a Cat Pile setup** (the pile check runs after any cat action, §8). Items
locked by combat.md §9/§4 keep their exact numbers (Tuna 12, Catnip +2, Feather Wand
25%, Cucumber = guaranteed Frazzle once per battle).

| # | Item | Icon | Price ✦ | Effect (exact) | Where | Weight |
|---|---|---|---|---|---|---|
| 1 | Tuna Snack | `▸` | 20 | Heal one cat **12 HP** | battle + exploration | 20 |
| 2 | Sardine Tin | `▶` | 45 | Heal one cat **to full HP** | battle + exploration | 6 |
| 3 | Warm Milk | `∪` | 30 | One ally gains **Mending** value 4, 2 rounds (ticks at its turn start, §6) | battle only | 10 |
| 4 | Catnip | `❋` | 25 | One ally gains **+2 Energy** (cap = its `enMax`) | battle only | 13 |
| 5 | The Cucumber | `⌁` | 40 | One enemy, any rank: **Frazzled** (guaranteed). Invalid vs an already-Frazzled target (§6 no-reapply). Works on bosses — cancels a charging windup (§11). **Max one Cucumber use per battle** (they wise up) | battle only | 8 |
| 6 | Squeaky Toy | `♢` | 25 | Throw at one enemy, ranks 1–3: `moveTarget: +1`, power 0 — forced move, so **Off-Balance** (`heavy`: **chip 1 Poise**). Clamped-to-0 pushes do nothing (§8) | battle only | 12 |
| 7 | Bag of Fleas | `⁘` | 25 | One enemy, any rank: **Scratched** value 3 (guaranteed; stacking per §6) | battle only | 11 |
| 8 | Cardboard Box | `⩌` | 20 | One ally hunkers: **Guarded** until the start of its next turn (no bonus energy — that's Guard-the-action's perk, §9) | battle only | 12 |
| 9 | Can-Opener Recording | `≈` | 35 | **Non-boss.** Party flees: Scatter! succeeds with no roll (all normal flee consequences, §12) | battle only | 6 |
| 10 | Feather Wand | `⌒` | 60 | Revive one KO'd ally at **25% max HP**, placed in rank 4, others shift forward (mirrors Nine Lives Nudge, §4). In-battle revival — **no Life lost** (§12) | battle only | 2 |

Weights sum to 100 — this is the single "consumable table" every source in §5
references. Heal values are fixed, not floor-scaled: Tuna decays from near-half-heal
to top-up across the run while Sardine Tin grows into relevance — natural tiering
with zero scaling code. Item statuses obey all combat.md stacking/duration rules; no
item touches the initiative queue or grants extra actions.

**Starting kit:** 20 ✦, 2 Tuna Snacks, 1 Cardboard Box; each cat wears its Stray
L1 class weapon (`atk +2`, fixed — no rolls at run start), no trinkets.

---

## 8. Inventory Rules

- **One shared party inventory** (the Bruiser carries the backpack; item juggling is
  not a cat fantasy). Shinies and the 8 equipped pieces live outside it.
- **16 slots.** Equipment: 1 item per slot. Consumables: stack up to **5** per slot,
  same-id stacks merge automatically. (Tight enough that hoarding consumables costs
  gear space — use the snacks.)
- **Full inventory at pickup:** modal shows the new item vs the grid — *Take*
  (choose a slot to replace; the replaced item drops to the tile and can be re-picked
  while the party remains on this floor) or *Leave it*. Descending abandons anything
  on the ground (the way up collapses — dungeon.md).
- In battle, the Item action lists consumables only; using one consumes the turn.
- Sort button: equipment first (slot, rarity desc, L desc), then consumables in
  table order. Pure sort, no gameplay effect.

---

## 9. Economy & Power-Curve Sanity Check

Expected honest-clear income per floor (6 fights, all chests, boss floors 3/6;
excluding events, shiny-pile draws, and selling):

| Floor | Fights `6·(10+4n)` | Chests | Boss | Total |
|---|---|---|---|---|
| 1 | 84 | 2×23 = 46 | — | **130** |
| 2 | 108 | 2×31 = 62 | — | **170** |
| 3 | 132 | 3×39 = 117 | 135 | **384** |
| 4 | 156 | 3×47 = 141 | — | **297** |
| 5 | 180 | 3×55 = 165 | — | **345** |
| 6 | 204 | 4×63 = 252 | 210 | **666** (scoreboard) |

Spendable before the final descent ≈ **1330 ✦** against sinks of: 5 Warm Laps = 375,
shop gear 50–280 a piece, snacks 20–60. A party that laps every landing and restocks
snacks affords ~1–2 shop gear pieces per run — drops carry the curve; the shop
patches holes. That's the intended pinch.

Power curve: a floor-6 party with on-curve gear (~2 upgrades/floor across 8 slots)
carries roughly `atk +9`, `hp +15`, and 2–4 points of `def/spd/crt/enMax` per cat —
about +60% effective offense over base, tracking the assumed ~×2 enemy scaling
closely enough that Off-Paw sequencing, Cat Pile timing, and the Energy economy stay
the deciding factors. Under-geared runs feel it first as floor attrition (HP
persists between fights, §12), which routes players to the intended sinks: Warm Lap
and Tuna. `def` is capped small by design — the §3 base table cannot produce a cat
that trivializes the `max(1, dmg − def)` floor.

---

## 10. Data Shapes

```ts
type StatKey = 'hp' | 'atk' | 'def' | 'spd' | 'crt' | 'enMax';
type Rarity  = 'stray' | 'sleek' | 'pedigree' | 'mewthical';

interface EquipDef {                    // 10 fixed defs (4 weapons + 6 trinkets)
  id: string; name: string; icon: string;
  slot: 'weapon' | 'trinket';
  classId?: ClassId;                    // weapons only
  primary: StatKey;
  secondaryPool: [StatKey, StatKey];
  uniqueId?: MewHookId;                 // links to the §4 unique, if any
}

interface EquipInstance {               // what sits in inventory / a slot
  uid: number;                          // running counter, UI identity
  defId: string;
  itemLevel: number;                    // L
  rarity: Rarity;
  stats: Partial<Record<StatKey, number>>;  // fully resolved at drop time (§3)
  hook?: MewHookId;                     // mewthical only
  hookSpent?: boolean;                  // the Ninth Bell's crack
}

type MewHookId =
  | 'poiseChip2' | 'critOffBalance' | 'appliesAlwaysHit' | 'healsGrantMending'
  | 'moverOffBalance' | 'ninthBell' | 'catPileDouble' | 'startEnergy6';

interface ConsumableDef {               // §7 — resolved by the combat pipeline
  id: string; name: string; icon: string;
  price: number;
  battleSkill?: Skill;                  // combat.md §4 shape, cost 0; absent =>
                                        //   exploration-only would apply (none in v1)
  explore?: { heal: number | 'full' }; // Tuna, Sardine Tin only
  oncePerBattle?: boolean;              // The Cucumber
  nonBoss?: boolean;                    // Can-Opener Recording
}

interface ConsumableStack { defId: string; count: number; }   // 1..5

interface Inventory {
  shinies: number;                      // 0..999
  slots: (EquipInstance | ConsumableStack | null)[];          // length 16
}
```

Drop tables, rarity weights, bundles, and prices are plain exported arrays/objects in
`loot/data.ts` — content, not code.

---

## 11. Implementation Budget (~470 LoC, module `loot/`)

| Module | Est. LoC | Notes |
|---|---|---|
| `loot/data.ts` — 10 EquipDefs, 8 hook ids, 10 ConsumableDefs (with §7 skills), tables §5–§7 | 170 | plain objects |
| `loot/gen.ts` — streams, `rollLoot(source, floor)` per §5, §3 value formulas, prices | 100 | pure functions |
| `loot/inventory.ts` — slots, stacks, equip/unequip, stat summing, sell, grief loot | 80 | pure functions |
| `loot/peddlerUI.ts` — landing screen (stock rows, Warm Lap, sell mode) | 120 | Graphics + Text only |

The pickup modal and inventory panel land in the dungeon UI budget. The 8 Mewthical
hooks cost ~25 LoC total inside combat's existing `resolve.ts`/`turns.ts` steps (§4
lists the exact hook points). Consumables add **zero** resolver branches — they are
skills.

---

## 12. Realignment Ledger (what other docs must change)

| Doc | Stale reference | Replacement |
|---|---|---|
| `dungeon.md` §9.4 | Chest tables naming Tuna Snack 40%-heal, Stat Treat, Sardine full-heal, Catnip Sprig/Zoomies, Cucumber/Startle | Chests roll §5b against the §7 consumable table; Zoomies/Startle don't exist (statuses are combat.md's six); **Stat Treats are cut** (see Cuts) |
| `dungeon.md` | Merchant tile, if added during realignment | None — the Peddler is the between-floor landing screen (§6) |
| `events.md` | Old bundle names / loot math in event defs | The six §5d bundles only |
| `gameloop.md` | Camp/heal cadence | Warm Lap at landings is the only out-of-combat heal (§6) |
| `classes.md` | Old class names (Pouncer/Oracle/Purrmedic) on weapons | Bruiser / Trickster / Hexer / Medic (combat.md §4) |

---

## Appendix: Deliberate Cuts

- **Armor slot / 3rd slot** — `def` rolls on trinkets; ranks + Guard are the defense
  game. Fewer slots = every drop is a bigger fraction of a cat's power.
- **Permanent stat food ("Stat Treats")** — overlaps equipment as the stat faucet and
  compounds invisibly across a run; the gear ladder is the one power treadmill.
- **Crafting, upgrading, sockets, durability** — pure LoC with no new decisions at
  this scope; rarity + item level already provide the upgrade drip.
- **Random affix names / prefix–suffix generation** — 10 fixed defs read faster and
  test easier than generated word salad.
- **Damage-dealing consumables** — combat.md item-skills scale power off the user's
  `atk`, so a "bomb" would secretly be a stat check; the Squeaky Toy (shove), Bag of
  Fleas (bleed), and Cucumber (stun) are the offensive items, and all route through
  existing statuses.
- **Buyback / restock / haggling** — sinks work without them.
- **Meta-currency between runs** — combat.md leaves meta-unlocks out of scope;
  resetting Shinies keeps run economies identical and testable.
- **Life-restoring items** — Lives are combat.md §12's dread currency; only the rare
  shrine event touches them. The Ninth Bell (once-per-run *prevention*) is the
  scoped-down version of that fantasy.
