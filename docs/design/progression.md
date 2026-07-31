# c(at)rpg Progression Depth — "Points, Milestones, Loadouts, Collars"

**Status: FINAL for v1.1. Companion to `classes.md` (the cast, the XP curve) and
`loot.md` (the item model).** This document adds four systems that give a run
per-cat *decisions* between battles, without touching a single combat rule:

| # | System | The decision it creates |
|---|---|---|
| §1 | **Whisker Points** | Every level, each cat gets a point. Where does it go? |
| §2 | **Milestone unlocks** | 3 skills known at L1 → 7 at L8 (L2 / L4 / L6 / L8). |
| §3 | **Skill loadout** | Only 4 skills go into a battle. Which 3 join Claw Swipe? |
| §4 | **Collars** | A third equipment slot: defence/utility, universal. |

### THE HARD RULE — every new field is optional

`CatRunState` gains `points?`, `loadout?` and `collar?`. **When absent, every
engine function behaves exactly as it did before** — the combat.md §13 worked
example, the recorded dungeon/loot/integration fixtures and all pre-existing
tests are untouched by this work. This is also what makes the save migration
trivial (§5) and what lets the UI adopt the systems one screen at a time.

---

## 1. Whisker Points — player-chosen stat growth

Levelling already applies an automatic `growth` row per cat (classes.md §8).
That stays exactly as it is. **On top of it**, every level-up from L2..L8
grants each cat **one Whisker Point** — 7 over a full run.

**The spend menu** (`POINT_MENU`, `core/run/party.ts`) — fixed, no rolls:

| Stat | Label | Per point | Cap (points, per cat) |
|---|---|---|---|
| `hp` | Bulk | **+3** | 4 |
| `atk` | Claws | **+1** | 4 |
| `def` | Hide | **+1** | 4 |
| `spd` | Twitch | **+1** | 4 |
| `crt` | Instinct | **+3** | 4 |
| `enMax` | Reserves | **+1** | 4 |

The per-stat cap of 4 is the balance valve: a fully-committed line costs more
than half the run's entire budget, so "all 7 into ATK" is not a build. The caps
live in the exported menu data — the UI reads them, it does not hardcode them.

**Rules**

1. `unspentPoints(cat, level) = (min(level, 8) - 1) - Σ points spent`, floored
   at 0. Points are *derived from the party level*, so nothing has to be
   granted, tracked or written back at level-up time — a level-up simply makes
   one more available, everywhere, immediately.
2. Spending a point in `hp` raises **current HP by the same +3**, the same rule
   level-ups use (classes.md §8): growth relieves attrition, it never heals.
3. `effectiveStats` folds points **after** the growth rows and **before**
   equipment, then tempMods, then the events.md §1 clamps. (Everything is
   additive, so the order is documentation, not arithmetic.)
4. Spending is pure. An illegal spend (no points left, stat at cap, unknown
   stat) returns the **same object** — the UI can fire and forget.
5. Points are per cat and per run. A cat that dies for good takes them with it.

---

## 2. Milestone skill unlocks

Every class knows **3 skills at L1** (Claw Swipe + its two starters) and gains
one more at **L2**, **L4** (the existing capstone), **L6** and **L8** →
**7 known at cap**, 24 class skills + Claw Swipe in total.

The 12 new skills use only the existing `EffectSpec` vocabulary and obey the
classes.md budget (energy-gated, never cooldown-gated; L2 ≤ 4 energy, L8 ≥ 7).
None of them is a bigger version of something the cat already had:

| Cat | L2 | L6 | L8 |
|---|---|---|---|
| **Bruno** «THE DUMPSTER KING» | **Scruff Toss** — 3 en, ranks 2-4, 80 pwr, **pull 2**. His only *pull*: drags the back line into his threat range instead of shoving it away. | **BIN LID BULWARK** — 5 en, ally row 1-2, **Guarded**. Hiss taunts; this one actually armours the party. | **TRASH COMPACTOR** — 7 en, enemy **row** 1-2, 110 pwr, **shove 2**. Mass displacement finisher. |
| **Pixel** «BOX AMBUSH» | **Bottle Cap Flick** — 2 en, ranks 1-3, 70 pwr, **moveSelf +1**. Hit-and-run: cheap poke that leaves her somewhere else. | **Whisker Feint** — 4 en, 90 pwr, applies **Off-Balance without moving the target** (chance 1.0). Arms Cat Pile + her own Opportunist trait while the mark stays reachable. | **EVERY BOX AT ONCE** — 8 en, **row over ranks 1-5**, 80 pwr. Her only AoE; a crit-stacked Pixel deletes a pack. |
| **Mora** «STRING THEORY» | **Snarl of Threads** — 4 en, enemy **row 3-5**, 40 pwr, **pull 1**. Yank of Yarn is single-target; this drags the whole back line into Off-Paw at once. | **NINTH KNOT CURSE** — 5 en, any rank, 20 pwr, **Scratched 6 at chance 1.0** (no roll). Almost no up-front damage, enormous over three rounds. | **FULL UNRAVEL** — 8 en, enemy row 1-3, 70 pwr, **pull 1 + Frazzled 0.6**. Phantom Cucumber scaled to a room; the mass windup-cancel. |
| **Baguette** «PURR ENGINE» | **Knead the Knots** — 2 en, small heal, **cleanses Off-Balance + Frazzled**. The cheap tempo cleanse (Soothing Purr clears Scratched). | **Warm Loaf Press** — 4 en, ally, **Mending 5 + Guarded**, no heal. Prophylactic support: spend a turn now, save a cat later. | **OVEN SPRING** — 7 en, **revive at 60 %**, once per battle. A second revive: a fight can now survive two KOs. |

**API:** `knownSkills(classId, level)` is the clear name. `skillsForLevel` is
kept as an **alias** so nothing that imported it breaks.

**Class-table order is load-bearing.** `CatClass.skills` lists the legacy kit
first — Claw Swipe, the two L1 skills, the L4 capstone — then the milestone
unlocks (L2, L6, L8). That order is exactly what makes the *default* loadout
(§3) identical to the pre-milestone kit at every level.

---

## 3. Skill loadout — 4 skills go to war

A cat takes **4 skills into battle**. Slot 1 is **always `clawSwipe`** (free,
unremovable, the energy battery); the player picks the other **3** from that
cat's known skills. From L4 onward there are more known skills than slots —
that is the point: the loadout is a plan, revisited at every Landing.

- `CatRunState.loadout?: SkillId[]` — the 3 chosen, **in order**.
- `activeSkills(cat, level)` returns `[clawSwipe, ...loadout]` filtered to
  currently-known skills. **With `loadout` absent it returns `knownSkills`
  truncated to 4** — i.e. the pre-progression kit at L1 and at every level from
  L4 up, and the old kit plus the (previously empty) fourth slot at L2/L3.
- `setLoadout(cat, level, skillIds)` is pure and total: wrong length, an
  unknown/unlearned id, `clawSwipe` among the picks, or a duplicate ⇒ the
  **same state**, unchanged. `clearLoadout(cat)` goes back to the default.
- `benchedSkills(cat, level)` is the "not taken" list, for the loadout UI.
- **The battle scene consumes `activeSkills`** (`ui/scenes/battle.ts`
  `buildSetup`), so a loadout is what the skill bar shows and what the engine
  legalises.

---

## 4. Collars — the third equipment slot

`weapon` + `trinket` (loot.md §2) gain a universal third slot: **`collar`**.

> **This supersedes loot.md's "Armor slot / 3rd slot — cut" line.** That call
> was made to keep every drop a big fraction of a cat's power; the collar earns
> its place by being a *different axis* (pure defence/utility, never offence)
> and by carrying the third of the three per-cat decisions this doc adds.

- **Identity:** defensive/utility only. Collar defs never roll `atk` or `crt` —
  offence is the weapon's and the trinket's job, so a collar choice is always a
  survivability/tempo choice (`hp`, `def`, `spd`, `enMax`).
- **Universal:** any cat can wear any collar (weapons stay class-locked).
- **Values:** the loot.md §3 formulas, unchanged, using the non-weapon bases.
- **8 defs:** Woven Collar, Quilted Gorget, Flealess Band, The No-Name Tag,
  Lead-Lined Collar, Bubble-Wrap Ruff, Battery Collar, Ward Collar.
- **3 Mewthical uniques**, drawing from the *existing* eight-hook menu (no new
  engine hooks were added, so every hook is a real, implemented one):
  «THE NINTH WARD» (Ward Collar, `ninthBell`), «PACKING MATERIAL»
  (Bubble-Wrap Ruff, `moverOffBalance`), «IDLE THROTTLE» (Battery Collar,
  `startEnergy6`). Because loot.md §5's unique-or-downgrade rule is keyed by
  **hook**, each of these is mutually exclusive with its trinket counterpart —
  exactly one Ninth-Bell-flavoured item exists per run. The other five collars
  have no unique and downgrade to Pedigree on a Mewthical roll (like the
  Cardboard Cuirass).

**Where they drop**

- Wild ladder (chests, fights, bosses, GEAR bundles): the loot.md §5 step ⑤
  slot roll becomes **weapon 40 / trinket 40 / collar 20**. The weapon band
  keeps its original `1..40` range, so no recorded stream changes hands.
- **The Peddler stocks one collar every landing** — a sixth, dedicated stock
  slot at `L = n+1` on the usual shop rarity split, rolled *after* the gear
  slot so slots 1-5 draw exactly what they drew before. The Peddler's gear slot
  keeps the two-slot `weapon 40 / trinket 60` table (`SHOP_GEAR_SLOT_WEIGHTS`);
  rolling collars in both slots would flood the stall.

**Slot-generic core.** `EQUIP_SLOTS = ['weapon','trinket','collar'] as const`
is the canonical, ordered list; `core/loot/inventory.ts` walks it instead of
hardcoding a pair — equip/unequip, grief loot, MOULT and the inventory sort are
all slot-generic, and every existing call signature still works.

---

## 5. Save compatibility

`SAVE_VERSION` is **2**. The localStorage KEY keeps its `catrpg.save.v1` name —
it is a key, not a schema tag, and renaming it would orphan every save on disk.

`migrateSave(sf)` accepts versions 1 and 2, rejects anything else (`null` ⇒
`loadRun` deletes the blob). **v1 → v2 adds nothing**: every progression field
is optional and its absent behaviour *is* the v1 behaviour — no collar, no
points spent (the full budget waiting), the default loadout. The migration only
re-stamps the version, so a v1 save loads with zero loss.

---

## 6. Exported API contract (what the UI builds against)

```ts
// ---- core/types.ts ----
export type EquipSlot = 'weapon' | 'trinket' | 'collar';
export const EQUIP_SLOTS = ['weapon', 'trinket', 'collar'] as const;
export type SaveVersion = 1 | 2;

export interface CatRunState {
  // …unchanged v1 fields…
  collar?: EquipInstance | null;              // §4 (undefined = v1 cat)
  points?: Partial<Record<StatKey, number>>;  // §1 counts of POINTS per stat
  loadout?: SkillId[];                        // §3 the 3 chosen, in order
}

// ---- core/run/party.ts ----
export interface PointMenuEntry {
  stat: StatKey; label: string; amount: number; cap: number; desc: string;
}
export const POINT_MENU: readonly PointMenuEntry[];
export function pointMenuEntry(stat: StatKey): PointMenuEntry | undefined;
export function pointsSpent(cat: CatRunState): number;
export function unspentPoints(cat: CatRunState, level: number): number;
export function canSpendPoint(cat: CatRunState, stat: StatKey, level: number): boolean;
export function spendPoint(cat: CatRunState, stat: StatKey, level: number): CatRunState;
export function clearPoints(cat: CatRunState): CatRunState;
export function pointStats(cat: CatRunState): Partial<Stats>;

export const BASIC_SKILL_ID: SkillId;   // 'clawSwipe'
export const LOADOUT_SIZE: number;      // 4
export function knownSkills(classId: ClassId, level: number): SkillId[];
export const skillsForLevel: typeof knownSkills;          // legacy alias
export function activeSkills(cat: CatRunState, level: number): SkillId[];
export function benchedSkills(cat: CatRunState, level: number): SkillId[];
export function setLoadout(cat: CatRunState, level: number,
                           skillIds: readonly SkillId[]): CatRunState;
export function clearLoadout(cat: CatRunState): CatRunState;

export function effectiveStats(cat: CatRunState, level: number): Stats; // folds points + collar

// ---- core/loot/inventory.ts ----
export { EQUIP_SLOTS };  export type { EquipSlot };
export function canEquip(cat: CatRunState, item: EquipInstance): boolean;
export function equipItem(cat, item): { cat: CatRunState; replaced: EquipInstance | null };
export function unequipItem(cat: CatRunState, slot: EquipSlot):
  { cat: CatRunState; removed: EquipInstance | null };

// ---- core/loot/roll.ts ----
export interface EquipRollOpts {
  slotWeights?: readonly { slot: EquipSlot; weight: number }[];
  slot?: EquipSlot;   // force the slot, skip roll ⑤
}
export function rollOneEquip(rng, L, rarityWeights, ctx, opts?): EquipInstance;

// ---- content/lootTables.ts ----
export const EQUIP_SLOT_WEIGHTS;      // weapon 40 / trinket 40 / collar 20
export const SHOP_GEAR_SLOT_WEIGHTS;  // weapon 40 / trinket 60

// ---- core/run/save.ts ----
export const SAVE_VERSION: number;               // 2
export const READABLE_SAVE_VERSIONS: readonly SaveVersion[];
export function migrateSave(sf: SaveFile): SaveFile | null;
```

**Deviation from the brief, recorded here:** `spendPoint` takes `level` as a
third argument. Availability is `(level - 1) - spent`, so the function cannot
validate a spend without knowing the party level; every caller has `run.level`
to hand. Same reason `setLoadout(cat, level, ids)` takes it.

**Suggested UI surfaces** (not implemented here — this is engine + content):
a Party panel row per cat with `unspentPoints` pips and the `POINT_MENU` rows;
a loadout editor with 3 slots + the `benchedSkills` bench; a third gear chip
next to weapon/trinket in the inventory panel; a sixth Peddler stock row.

---

## 7. Tests

`tests/progression.spec.ts` — points (earn rate, caps, HP delta, fold order,
no-op purity), unlock levels and the authored content's budget/vocabulary,
loadout defaulting + validation + the byte-identical legacy default, collar
folding/equip/grief/MOULT/sort/drop-tables/shop, and the v1 → v2 migration
(including a round-trip of the new fields when they *are* present).

Existing suites were touched only where content COUNTS or the save VERSION are
asserted — never where behaviour is: `content-classes.spec.ts` (4 → 7 skills
per class), `content-loot.spec.ts` (10 → 18 defs, collar invariants),
`loot.spec.ts` (the recorded Peddler stock gains its sixth slot; slots 1-5 are
unchanged, item for item), `run.spec.ts` (the version-mismatch case now uses an
unknown version, plus a new v1-migration test) and
`tests/fixtures/integration-run.json` (`"version": 1` → `2`, and **nothing
else** — the whole recorded run is byte-identical, which is the proof that no
gameplay stream moved).
