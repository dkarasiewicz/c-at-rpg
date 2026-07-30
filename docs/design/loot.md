# c(at)rpg Loot, Items & Economy — FINAL DESIGN
## "Shinies & Snacks"

Companion to `combat.md` (single source of truth for stats, statuses, formulas). This doc
defines currency, equipment, consumables, drop tables, the merchant, and inventory rules.
Every number is exact; all loot RNG is seeded and consumed in a specified order.

Design pillars:

1. **Every drop is readable in one glance** — an item is (slot, rarity color, 1–3 stat
   lines, maybe one effect line). No sockets, no durability, no crafting.
2. **Loot feeds the combat doc, never forks it** — items only touch the 5 stats, Vigor,
   and the 7 existing statuses. Zero new combat mechanics; Mewthical effects are single
   hook flags on rules that already exist.
3. **Shinies must hurt to spend** — one faucet curve, three sinks (consumables, gear,
   healing), tuned so a floor's income buys roughly one meaningful thing.
4. **Deterministic** — a per-floor loot RNG stream, rolls in a fixed order, so the same
   seed always produces the same chest contents.

**Assumed run shape** (dependency for the floor-generation doc, tunable constants):
a run is **6 floors**, each with ~6 regular fights, 2 chests, 1–2 events, 1 merchant tile,
1 floor boss. Enemy stats are assumed to scale ≈ `×(1 + 0.25·(floor−1))`; the gear curve
below (`×(1 + 0.35·(floor−1))` on drops the party actually equips, at ~2 upgrades per
floor across 8 slots) is tuned against that.

---

## 1. Currency — **Shinies** ✦

Cats do not care about gold. They care about **Shinies**: bottle caps, foil balls, lost
earrings, one (1) human car key. A single fungible currency.

- Integer, party-wide, **cap 999** (display `✦ 37`). No inventory slot.
- Overflow beyond 999 is discarded with a smug HUD message ("The pile is tall enough.").
- Faucets: fight victories, chests, bosses, events, selling items.
- Sinks: merchant stock (consumables + 1 gear piece), merchant healing ("Warm Lap"),
  event options that cost Shinies.
- Shinies do **not** persist between runs (no meta-currency in v1).

### Shiny income (exact)

| Source | Amount |
|---|---|
| Regular fight victory | `(8 + 4·floor) + rngInt(0..4)` |
| Chest (always, plus its item) | `15 + 8·floor` |
| "Big shinies" chest result (§5) | `2 × (15 + 8·floor)` |
| Floor boss | `60 + 25·floor` |
| Events | per event data, typical range `10..40 + 10·floor` |
| Selling an item | §7 sell formula |

Fleeing a fight yields nothing (per combat.md §11). Expected honest income per floor:
~6 fights + 2 chests + boss ≈ **190 ✦ on floor 1 → 440 ✦ on floor 6**.

---

## 2. Equipment Model — 2 slots per cat

Each cat has exactly **2 equipment slots**:

| Slot | What | Who can wear it |
|---|---|---|
| **Weapon** | Class weapon (4 archetypes, one per class) | Only its class |
| **Trinket** | Collar/charm/toy (6 archetypes) | Any cat (universal) |

**Why this split (the "pick, justify"):** class-locked weapons carry class identity and
guarantee that ATK-stick power is distributed across the party rather than funneled onto
one cat; universal trinkets guarantee that *every* trinket drop is relevant to somebody,
so loot moments never whiff completely. Two slots × 4 cats = 8 equipped pieces — enough
for a steady upgrade drip over 6 floors (~12–15 equipment drops per run) without an
inventory-management minigame. No armor slot: DEF/HP roll on trinkets and weapon
secondaries instead, and the front/back row + Guard already carry defense gameplay.

- Equipping/unequipping: **free, exploration only** (never mid-battle). Swapping between
  cats is free. Replaced gear returns to the shared inventory.
- Equipped items do not occupy inventory slots.
- Item stats are **flat additive bonuses** applied to the cat's base stats. `effATK` etc.
  in combat.md read the summed value; status multipliers apply on top as written there.

### Archetypes (fixed defs, data)

**Weapons** (primary stat always **ATK**):

| Class | Weapon def | Icon |
|---|---|---|
| Bruiser | Heavy Paw Wraps | `▣` |
| Pouncer | Claw Caps | `ʌ` |
| Oracle | Whisker Bell | `ᛒ` |
| Purrmedic | Grooming Brush | `⌒` |

(ATK scales heals too — combat.md §3 — so the Purrmedic's "weapon" is a brush and it
works with zero extra code.)

**Trinkets** (primary stat fixed per def):

| Trinket def | Primary | Icon |
|---|---|---|
| Padded Collar | HP | `◯` |
| Tiny Bell | LCK | `°` |
| Knitted Booties | DEF | `⩌` |
| Feather Toy | SPD | `⌇` |
| Fish Skeleton Charm | ATK | `⋔` |
| Mouse Ghost Locket | HP | `▽` |

Display name = `[rarity prefix] + def name`: Common (none), Uncommon "Fine", Rare
"Pristine", Mewthical items use unique hand-authored names (§4).

---

## 3. Rarity, Item Level & Stat Rolls (exact)

```
Rarity        color     rarityMult  secondaries  extra
common        #9aa0a6   1.0         0            —
uncommon      #4caf50   1.3         1            —
rare          #42a5f5   1.6         2            —
mewthical     #ba68c8   2.0         2            + one unique effect (§4)
```

- **itemLevel L** = the floor the item dropped on (merchant stock: the current floor).
- `floorScale(L) = 1 + 0.35·(L − 1)`
- Per-stat base budgets: `HP 6, ATK 3, DEF 2, SPD 2, LCK 3`
  (DEF base is lowest because divisor mitigation makes each point strong).

```
primaryValue(stat, L, rarity)  = max(1, round(base[stat] · floorScale(L) · rarityMult))
secondaryValue(stat, L)        = max(1, round(0.5 · base[stat] · floorScale(L)))   // no rarity mult
```

Rarity buys a bigger primary and **more** secondaries; floor buys raw size. Reference
table for the **ATK primary** (base 3):

| L | common | uncommon | rare | mewthical |
|---|---|---|---|---|
| 1 | +3 | +4 | +5 | +6 |
| 3 | +5 | +7 | +8 | +10 |
| 6 | +8 | +11 | +13 | +17 |

(HP primary, base 6: L1 = 6/8/10/12 … L6 = 17/21/26/33.)

**Secondary stats:** drawn without replacement from the allowed pool —
weapons: `{HP, DEF, SPD, LCK}`; trinkets: any stat except the def's primary.

### Data shapes

```ts
type StatId = 'HP' | 'ATK' | 'DEF' | 'SPD' | 'LCK';
type Rarity = 'common' | 'uncommon' | 'rare' | 'mewthical';

interface EquipDef {                 // 10 fixed defs (4 weapons + 6 trinkets)
  id: string; name: string; icon: string;
  slot: 'weapon' | 'trinket';
  classId?: ClassId;                 // weapons only
  primary: StatId;
}

interface EquipInstance {            // what actually sits in inventory / a slot
  uid: number;                       // running counter, for UI identity
  defId: string;
  itemLevel: number;
  rarity: Rarity;
  stats: Partial<Record<StatId, number>>;  // fully resolved at drop time
  effect?: MewEffectId;              // mewthical only
}

interface ConsumableDef {            // §6
  id: string; name: string; icon: string;
  price: number;                     // merchant buy price, fixed
  use: ConsumableUse;                // small tagged union, see §6
  combatOnly?: boolean;              // default: usable in exploration too
}
```

### Loot generation algorithm (determinism contract)

One `mulberry32` stream per floor: `seed = hash(dungeonSeed, 'loot', floor)`. Every loot
grant consumes rolls in this exact order (unneeded rolls are **skipped, not burned**):

① category roll (if the source's table has one) → ② rarity roll → ③ def pick
(uniform over legal defs; weapons: uniform over all 4 classes — off-class weapons are
sell fodder, and that's fine) → ④ secondary stat picks in pool order, one roll each →
⑤ Shinies variance roll (fight victories only). Mewthical effect is fixed per def
(no roll, §4). Chests/events on a floor are generated **lazily at open/resolve time**
in interaction order (player-order-dependent, still fully replayable from input log).

---

## 4. Mewthical Uniques (the whole list — hand-authored, one hook each)

A Mewthical drop of a given def **is** that unique (fixed name + effect; stats still roll
per §3 at ×2.0). Ten defs → ten uniques. Every effect is one `if` in an existing code
path of combat.md:

| Def | Unique name | Effect (exact) | Hook location |
|---|---|---|---|
| Heavy Paw Wraps | Mitts of the Mountain | Wearer's Guard grants +2 Vigor (not +1) | Guard post-hook |
| Claw Caps | Phantom Claw Caps | Wearer's Stalk grants +3 Vigor (not +2) | Stalk post-hook |
| Whisker Bell | Bell of Ill Omen | Wearer's weakness hits use tagMult 1.65 (not 1.5) | damage `tagMult` |
| Grooming Brush | The Silver Brush | Wearer's heals ×1.25 (multiplicative with class passive) | heal formula |
| Padded Collar | Bottomless Yarn Collar | Wearer starts battles at 5 Vigor (not 3) | battle setup |
| Tiny Bell | Deafening Tiny Bell | Wearer's `yowl` skills: power +20 (flat, pre-formula) | skill resolve |
| Knitted Booties | Cardboard Armor | Wearer takes ×0.85 damage (own mult slot, stacks with Guard) | damage `mult` |
| Feather Toy | The Red Dot | Wearer's Swipe grants +2 Vigor (not +1) | Swipe post-hook |
| Fish Skeleton Charm | Ancestor Fishbone | Wearer's crit chance +10% flat (after LCK) | crit roll |
| Mouse Ghost Locket | Mouse Ghost Locket (it's already haunted) | Once per battle: a hit that would KO the wearer leaves it at 1 HP instead (no Life spent) | death check |

No unique alters targeting, turn order, or adds statuses — the resolver stays pure and
the worked example in combat.md remains a valid unit test with no gear equipped.

---

## 5. Drop Tables (exact weights)

All rolls d100 against cumulative weights, from the floor's loot stream (§3 order).

### 5a. Regular fight victory
- Shinies: always (§1).
- Consumable: **25%** → roll on the consumable table (§6 weights).
- Equipment: **10%** → rarity `common 60 / uncommon 30 / rare 9 / mewthical 1`.
(Both can hit on the same fight; consumable roll first.)

### 5b. Chest
- Shinies: always (§1).
- Then one category roll:

| Roll | Weight | Contents |
|---|---|---|
| Consumables | 55 | 2 rolls on the consumable table (§6) |
| Equipment | 35 | 1 piece, rarity `common 45 / uncommon 35 / rare 17 / mewthical 3` |
| Big shinies | 10 | additional `2 × (15 + 8·floor)` ✦ |

### 5c. Floor boss
Guaranteed, in order:
1. Shinies (§1).
2. **1 equipment**, rarity `rare 70 / mewthical 30` (never below rare).
3. **2 consumable rolls** (§6 table).

### 5d. Events
Events reference **named bundles** (event data stays declarative). The five bundles:

| Bundle | Contents |
|---|---|
| `SNACK_STASH` | 2 consumable rolls (§6) |
| `SHINY_HOARD` | `30 + 10·floor` ✦ |
| `TRINKET_CACHE` | 1 trinket (never weapon), rarity `uncommon 55 / rare 35 / mewthical 10` |
| `TITHE` (punishment) | lose `min(current, 20 + 5·floor)` ✦ |
| `MOULT` (punishment) | a seeded-random equipped item is unequipped **and** downgraded one rarity tier (stats re-rolled at new tier; common → destroyed). No equipped items → lose 15 HP on a seeded-random cat instead |

Event definitions carry `{ reward?: BundleId, punish?: BundleId }` per dialog option;
the event system never invents loot math of its own.

---

## 6. Consumables (8 — every effect maps to combat.md verbatim)

Used via the **Item** action in battle (full turn, combat.md §6) or freely during
exploration unless `combatOnly`. Statuses applied by items are **guaranteed** (no LCK
resist — items are reliable by design; scarcity is the balance knob).

| # | Item | Icon | Price ✦ | Effect (exact) | Weight |
|---|---|---|---|---|---|
| 1 | Fresh Tuna | `▸` | 15 | Heal one cat 15 HP | 22 |
| 2 | Whole Salmon | `▶` | 40 | Heal one cat 40 HP | 8 |
| 3 | Catnip Sprig | `❋` | 25 | One cat gains **Zoomies** (duration 2) | 12 |
| 4 | The Cucumber | `⌁` | 30 | **combatOnly.** One enemy is **Startled** — guaranteed, ignores Wary. vs boss: +1 Poise instead. Max one Cucumber use per battle (it only works once; they wise up) | 10 |
| 5 | Sardine Oil Vial | `≈` | 20 | **combatOnly.** One enemy gains **Gunked** (duration 2) | 13 |
| 6 | Grooming Kit | `✚` | 20 | Cleanse **Ruffled, Bleeding, Gunked** from one cat | 13 |
| 7 | Treat Pouch | `⁘` | 25 | **combatOnly.** One cat gains +4 Vigor (cap 10) | 13 |
| 8 | Jingle Decoy | `♢` | 20 | **combatOnly, non-boss.** Party flees, **no roll** (all normal flee consequences per combat.md §11) | 9 |

Weights sum to 100 and are the single "consumable table" referenced by §5. Heal values
are intentionally fixed (not floor-scaled): Tuna decays from full-heal to top-up across
the run while Salmon grows into relevance — a natural tiering with zero scaling code.
"Nine Lives Treat" (mid-battle revive) stays cut, as flagged in combat.md §11.

Item use consumes **no combat RNG rolls** (guaranteed effects, no variance) — the battle
stream contract in combat.md §3 is untouched.

---

## 7. Merchant — **The Peddler** (kept, small)

**Kept, not cut** — without a sink, Shinies are dead weight and chests lose half their
payload. Scope is contained: fixed stock, fixed prices, no haggling, no buyback list;
~150 LoC including UI (a PixiJS panel with 5 rows: click to buy, click inventory to sell).

- **One Peddler tile per floor** (placed by floor gen; a fat cat blob with a bindle).
  Interacting opens the shop; usable any number of times while on the floor.
- **Stock** (rolled once per floor from the loot stream, at floor generation):
  1. 3 consumables: 3 rolls on the §6 table (duplicates allowed).
  2. 1 equipment piece at `itemLevel = floor`, rarity `uncommon 60 / rare 35 / mewthical 5`.
  3. **Warm Lap** (service, unlimited): every cat heals 30% of max HP, KO'd cats are
     unaffected (they're not present; revival is battle-victory-only per combat.md §11).
- Sold-out slots stay empty (no restock).

### Prices (exact)

```
equipValue(L, rarity) = round((10 + 5·L) · rvMult)      // rvMult: 1 / 1.5 / 2.5 / 5
buy  equipment  = 2 × equipValue(L, rarity)
sell equipment  = floor(0.5 × equipValue(L, rarity))
buy  consumable = def.price                              // §6 table
sell consumable = floor(0.5 × def.price)
Warm Lap        = 25 + 10·floor
```

Reference: floor-3 rare gear costs `2·round(25·2.5)` = **126 ✦** against ~250 ✦ floor
income — buying it means skipping most snacks and healing that floor. Selling happens in
the same shop panel (click any inventory item while the shop is open). Off-class Mewthical
weapon sells for `floor(0.5·(10+5L)·5)` — finding one is still a payday.

---

## 8. Inventory Rules

- **One shared party inventory** (the Bruiser carries the backpack; no per-cat weight
  minigame — item juggling is not a cat fantasy).
- **20 slots.** Equipment: 1 item per slot. Consumables: stack up to **9** per slot,
  same-id stacks merge automatically.
- Equipped gear (8 pieces max) and Shinies live outside the slots.
- **Full inventory at pickup:** a modal shows the new item vs. the grid — *Take* (choose
  a slot to drop-and-replace; the replaced item falls to the tile and can be re-picked
  this floor) or *Leave it*. Descending a floor abandons anything on the ground.
- In battle, the Item action lists only consumables (equipment is untargetable there).
- Sort button: equipment first (slot, then rarity desc, then itemLevel desc), then
  consumables by table order. Pure sort, no gameplay effect.

```ts
interface Inventory {
  shinies: number;                       // 0..999
  slots: (EquipInstance | ConsumableStack | null)[];   // length 20
}
interface ConsumableStack { defId: string; count: number; }  // 1..9
```

---

## 9. Power-Curve Sanity Check

Floor-1 Pip (ATK 15) with a common Claw Caps (+3) Pounces (power 160, per combat.md §3)
into a DEF-3 rat for `raw 28.8 → mit 27.96` ≈ +20% over naked — noticeable, not warping.
By floor 6, a party wearing on-curve gear (~2 upgrades/floor) carries roughly +55–70%
effective stats over base, tracking the assumed ×2.25 enemy scaling closely enough that
Startle setup, rows, and Vigor economy stay the deciding factors — gear keeps you on the
treadmill; combat.md decisions win fights. Under-geared runs feel it first in attrition
(HP persists between fights), which routes players to the intended sinks: Warm Lap and
tuna.

---

## 10. Implementation Budget (~380 LoC, module `loot/`)

| Module | Est. LoC | Notes |
|---|---|---|
| `loot/data.ts` — 10 EquipDefs, 10 Mew effects (ids), 8 ConsumableDefs, tables §5–§6 as arrays | 140 | plain objects |
| `loot/gen.ts` — floor stream, rollLoot(source) per §3/§5, price formulas | 80 | pure functions |
| `loot/inventory.ts` — slots, stacks, equip/unequip, stat summing, sell | 70 | pure functions |
| `loot/shopUI.ts` + pickup modal — PixiJS panels | 90 | Graphics + Text only |

Mewthical hooks land inside combat's existing budget (10 one-line `if`s across
`engine.ts`). The consumable `use` union resolves through the existing status/heal
codepaths — no new resolver branches.

---

## Appendix: Deliberate Cuts

- **Armor slot / 3rd slot** — DEF rolls on trinkets; rows + Guard are the defense game.
- **Crafting, upgrading, sockets, durability** — pure LoC with no new decisions at this
  scope; rarity + itemLevel already provide the upgrade drip.
- **Random affix names / prefix-suffix generation** — 10 fixed defs read faster and test
  easier than generated word salad.
- **Buyback / merchant restock / haggling** — sinks work without them.
- **Meta-currency between runs** — combat.md leaves meta-unlocks optional; Shinies reset
  keeps run economies identical and testable.
- **Mid-battle revive item** — explicitly deferred by combat.md §11; the Mouse Ghost
  Locket's KO-prevention flag is the scoped-down version of that fantasy.
