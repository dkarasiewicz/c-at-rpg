# Balance, Difficulty Curve, and the Meta Layer

Three connected problems, one design: the game is too easy at the start, its
best mechanic is too strong, and it has nothing to give the player between runs.

## 1. Off-Balance is overtuned

**Measured today** (`core/combat/status.ts`, `resolve.ts`): `offBalance` is a
flat **×1.5 damage taken**, lasts **until round end**, is applied at **100%
chance** by several cheap skills, and applies to **every** attacker for the rest
of the round. It multiplies with crit (×1.5 × ×1.5 = **×2.25**) and Pixel's
Opportunist adds +10/+20 crit chance against it.

So one cheap shove buys the whole party a +50% damage round, and the correct
opening is always "shove, then everyone swings." A combo engine should reward
setup; this one deletes the decision.

**Fixes (keep the identity, cut the dominance):**

- Multiplier **×1.5 → ×1.3**. Crit+OffBalance drops from ×2.25 to ×1.95, still a
  spike worth building toward.
- **Braced**: when `offBalance` expires or is consumed, the victim gains
  `braced` for 1 round — immune to re-application. This kills perma-shove locks
  outright, and makes "who do we destabilise *this* round" a real choice.
- **Tier resistance**: tier-2 enemies resist application 25% of the time,
  tier-3 40%. Bosses keep Poise (already correct — do not touch §11.1).
- Re-tune the skills that apply it: not every shove should land it at 100%.
  Cheap single-target shoves drop to ~60-75%; the expensive setup skills keep
  1.0. That is what makes the expensive ones worth their energy.
- **Cat Pile** naturally becomes rarer under the above; verify it still triggers
  a few times per run rather than most fights, and re-check its damage after the
  ×1.3 change so it does not quietly become the only win condition.

Every number here is a starting point to be validated by simulation, not a
truth. Add a headless balance harness (`scripts/sim.ts`) that runs N seeded
battles per floor and reports win rate, average rounds, damage share per cat,
and Cat Pile frequency — tune against that, not against vibes.

### 1.1 SHIPPED — what was actually built and measured

`npm run sim` is that harness. It drives the real engine with the AI playing
both sides; one trial is a floor "chain" of 3 seeded encounters with HP
persisting between them (one walk across a floor), no rests, shops or
consumables — so it is deliberately harsher than the real game.

Implemented exactly as specified above, plus two things the spec left open:

- The two Off-Paw gates are drawn **only when the application could otherwise
  land** (target alive, not already Off-Balance, not Braced). Determinism is a
  hard contract, so the roll order is written into `combat.md` §3.2 as a table.
- Braced lasts **1 round when Off-Balance expired at round end, 2 when it was
  consumed mid-round** (Cat Pile, cleanse). Both mean "immune for one full
  round"; the difference is only which round-end sweep ticks it.

**Measured, 600 trials/floor, seed `BASE-1`** (`pile/bt` = Cat Piles per
battle; `OB%` = share of living-enemy-rounds carrying Off-Balance):

| | floor | win% | clear% | rounds | OB% | pile/bt | lives lost |
|---|---|---|---|---|---|---|---|
| **BEFORE** (4 cats, ×1.5, no gates) | 1 | 100.0 | 100.0 | 1.8 | 44.3 | 0.36 | 0.00 |
| | 2 | 100.0 | 100.0 | 2.1 | 43.3 | 0.38 | 0.01 |
| | 3 | 100.0 | 100.0 | 2.8 | 34.6 | 0.22 | 0.63 |
| | 4 | 99.5 | 98.0 | 3.3 | 26.8 | 0.08 | 1.27 |
| | 5 | 99.8 | 99.3 | 3.4 | 24.6 | 0.09 | 0.47 |
| | 6 | 99.9 | 99.5 | 3.5 | 25.9 | 0.05 | 0.37 |
| **AFTER** (2→3 cats, ×1.3, gates, curve) | 1 | 98.1 | 94.3 | 3.0 | 6.4 | 0.00 | 0.39 |
| | 2 | 97.1 | 91.2 | 3.8 | 4.1 | 0.00 | 0.65 |
| | 3 | 94.0 | 82.2 | 4.0 | 8.9 | 0.03 | 1.23 |
| | 4 | 90.9 | 73.2 | 4.5 | 12.9 | 0.05 | 1.49 |
| | 5 | 90.4 | 71.8 | 3.7 | 17.4 | 0.09 | 1.27 |
| | 6 | 85.3 | 56.8 | 3.4 | 20.9 | 0.14 | 1.30 |

The BEFORE table is the complaint, in numbers: a flat 100% win rate for three
floors, Off-Balance up 44% of the time on floor 1, a Cat Pile in more than a
third of all fights, and zero Lives at risk before floor 3.

What changed and why it reads as an improvement:

- **The run has a shape now.** Clear rate falls monotonically 94% → 57%
  instead of sitting at 100% until floor 4.
- **Off-Balance inverted its curve.** It used to be strongest on floor 1
  (44%) and decay; it now starts near-absent (6%) and grows to 21% by floor 6,
  which is the §3 teaching order: floor 1 shows you a shove, the late floors
  make it a system.
- **Cat Pile became an event.** ~1 per run, concentrated on floors 4-6, versus
  most fights on floors 1-2.
- **Concentration fell against even share.** Top cat was 48.0% of party damage
  at 4 cats (1.92× an even split); it is now 47.4% at 3 cats (1.42× even).

Known and deliberate:

- **Floors 1-2 show a top share of 50-59%.** With two cats an even split is
  50% — the "≤40%" target is only meaningful at 3-4 cats.

### 1.2 The damage-share target, measured properly

The share column above was originally computed as *a cat's damage ÷ all
damage on the floor*, which is wrong whenever the cat is not in every party.
`rosterFor` rotates Bruno's partner, so Baguette is fielded in a third of
3-cat trials and her raw share read a third of what she actually contributes.
The harness now also reports **`fieldedPct`** — damage ÷ the damage of the
parties that cat was actually IN — and that is the number the ≤40% target is
about. (`--roster=bruiser,trickster,hexer` pins a composition; `--skills`
breaks a cat's output down per skill.)

Re-measured at 600 trials, seed `BASE-1`, as `fieldedPct` (×N vs an even
split):

| floor | Pixel | Bruno | Mora | Baguette |
|---|---|---|---|---|
| 3 | 47.4 (1.42×) | 36.2 (1.09×) | 19.5 (0.58×) | 7.5 (0.22×) |
| 4 | 41.7 (1.25×) | 39.6 (1.19×) | 19.8 (0.59×) | 9.9 (0.30×) |
| 5 | 44.8 (1.34×) | 32.4 (0.97×) | 23.4 (0.70×) | 14.0 (0.42×) |
| 6 | 47.3 (1.42×) | 24.0 (0.72×) | 28.1 (0.84×) | 20.6 (0.62×) |

Pinning the composition explains the shape, and shows the target is partly
ill-posed:

- **With a Medic** (`bruiser,trickster,medic`) Pixel is **49.6-56.8%** and
  Bruno 36.6-44.2%, because Baguette spends her turns healing and contributes
  2.8-11.4%. Two carries splitting ~92% of the damage is **~46% each by
  arithmetic**. ≤40% is unreachable in any party with a dedicated healer
  unless the healer becomes a damage dealer.
- **Without a Medic** (`bruiser,trickster,hexer` — all three combat-capable)
  Pixel is **40.4-45.5%** (1.21-1.36×) and Bruno 24.1-36.9%. Here the target
  is meaningful and Pixel misses it by 0-5pp.

Two tunes were tried against that miss and both are recorded here so they are
not tried again:

- **Pounce 150 → 130 power** moved Pixel's share by **0.2pp**. Pounce is the
  only skill in the game at 50 power/energy (next: Body Slam at 30), so it
  looks like the culprit — but `--skills` shows her output split across four
  skills (pounce 12-16%, Trip Wire 10-17%, Box Ambush 5-17%, Claw Swipe
  9-13%), and weakening one just makes the AI pick another. Reverted: it
  breaks three docs and a fixture for nothing. (An earlier attempt at Pounce
  *cost* 3→4 moved <1pp for the same reason.)
- **Statline (ATK 12→10, CRT 15→10)** does work — Pixel drops to 35-40% — and
  costs **15pp of floor-6 clear rate** (46.5% → 31.5% in the no-Medic party)
  while deleting the documented Trickster identity ("highest ATK/CRT/SPD").
  Not worth it.

So: **the concentration is a statline property of the Trickster plus the
action economy of a 3-cat party with a support in it, not an Off-Balance
problem.** The rework already took the top cat from 1.92× an even split (4
cats, before) to 1.42× (3 cats, after). Closing the last 3-5pp is a
`classes.md` decision about what a Trickster is, and it should be taken with
the clear-rate cost in front of it.
- **A 4-cat party still wins 100% of floors 1-5** (`npm run sim -- --party=4`).
  The whole curve is now tuned for the default capacity of three; the fourth
  slot is a genuine Cat Town power spike, which is what §4 sells it as.
- The harness's cat policy is deliberately not clairvoyant — it does not plan
  Cat Piles two rounds out — so `pile/bt` is a floor, not a ceiling.
- **Cat Pile is ~0.9 per run** (3 fights/floor × the pile/bt column), and
  **exactly zero on floors 1-2**. That is the low edge of "a few times per
  run" but on the right side of the failure mode the spec names ("rather than
  most fights", which was 0.36/battle before). It is structural, not a bug: a
  pile needs *every* living enemy Off-Balance, and two cats get two actions a
  round against packs of 2.6-3.7 bodies. It becomes reachable exactly when the
  third cat arrives, which reads as the mechanic opening up rather than being
  taught and then withdrawn.
- **Whether you drew the Medic matters more than the floor curve does.** Same
  floors, pinned compositions, 400 trials: floor-3 clear is **98.3%** with
  Baguette and **80.5%** without; floor 6 is 73.8% vs 46.5%. The aggregate
  rows above average a bimodal distribution. Worth knowing before anyone
  reads a single clear-rate number as "the" difficulty.

## 2. The party is too strong on floor 1

Four cats with full kits against floor-1 trash is a walkover, and it wastes the
best moment a roguelike has: the fragile opening.

- **Start with two cats** (Bruno + one). The run *earns* its clowder: a third
  joins via a recruit encounter mid-run, the fourth is a meta unlock.
- Rebalance floor-1/2 encounter budgets around a 2-cat party so the opening is
  tense rather than trivial, and re-tune later floors for the party actually
  fielded rather than an assumed four.
- Marching order, Cat Pile and the rank system must all still work at party
  sizes 2, 3 and 4 — this is a real constraint on the combat code, not just a
  content change.

### 2.1 SHIPPED — the roster model

`RunState.cats` still carries **all four ClassId slots** (the frozen §2.9
contract, and every classId-keyed system downstream). What changed is that
`marchingOrder` is now the **fielded roster**, and cats outside it are on the
bench — levelling quietly in the background so a recruit arrives at the
party's current level rather than as a level-1 liability.

| API (`core/run/runState.ts`) | |
|---|---|
| `STARTING_PARTY_SIZE` = 2 | Bruno + one, drawn from its own `hash(runSeed, 'roster')` stream so it cannot shift any other seeded sequence |
| `DEFAULT_PARTY_CAPACITY` = 3, `MAX_PARTY_CAPACITY` = 4 | `RunState.partyCapacity` overrides it; Cat Town raises it |
| `fieldedCats` / `benchedCats` / `canRecruit` | roster queries |
| `recruitCat(run, classId?)` | **the seam a recruit encounter calls.** Pure, total, joins at full HP for the current level |
| `RECRUIT_FLOOR` = 3 | `descend()` recruits here if the roster has room — the floor of what a run gets, not the ceiling |
| `newRun(seed, customParty?, { partyCapacity, roster })` | Cat Town's entry point |

The combat-side constraint was the interesting half. A two-cat party has no
ranks 3-4, which silently disabled Soothing Purr, Nine Lives Nudge, Pounce and
Yank of Yarn — most of two kits. Fixed by **rank projection** (`combat.md`
§1.1): `usableFrom` is a position in the line, not a coordinate, so it is
clamped to the living bodies on that side. It is an exact no-op at full
occupancy, it preserves rank denial (at two cats, [3,4] projects to {2} only,
so a Medic shoved to the front still loses her kit), and as a bonus it stops a
lone Laser Ghost from being permanently unable to act.

## 3. Difficulty progression

Introduce mechanics on a curve instead of all at once:

| Floor | Teaches |
|---|---|
| 1 | basic attacks, ranks, one shove |
| 2 | Off-Balance combos, first elite |
| 3 | boss Poise, status pressure |
| 4 | multi-status enemies, back-rank threats |
| 5 | resistances, resource attrition |
| 6 | everything, plus the Dogfather |

Enemy stat growth per floor should follow an explicit curve rather than
hand-typed numbers, so the whole run can be retuned by changing one table.

### 3.1 SHIPPED — the curve

`ENEMY_CURVE` in `content/floors.ts` — six rows, applied in `createBattle`
from `BattleSetup.floor`. HP and ATK are multipliers (the two numbers fight
length hangs on); DEF/SPD/CRT are flat adds, because a multiplier on a 0-2
stat is noise. **Bosses are excluded**: their blocks are authored against the
§11 flag set, and scaling them would silently move Poise-break pacing and the
50% phase threshold.

| Floor | hp × | atk × | def + | spd + | crt + | threat budget (was) |
|---|---|---|---|---|---|---|
| 1 | 1.00 | 1.00 | 0 | 0 | 0 | 2–4 (3–4) |
| 2 | 1.06 | 1.06 | 0 | 0 | 0 | 4–5 (4–5) |
| 3 | 1.14 | 1.16 | 0 | 0 | 3 | 5–7 (5–6) |
| 4 | 1.20 | 1.20 | 1 | 0 | 3 | 6–7 (6–8) |
| 5 | 1.24 | 1.24 | 1 | 1 | 5 | 6–8 (8–10) |
| 6 | 1.28 | 1.26 | 1 | 1 | 5 | 7–9 (10–12) |

Two things the simulation taught that guessing did not:

- **DEF adds are far more violent than they look.** Flat subtraction off every
  hit, so +2 DEF on floor 6 cost the party ~15% of its damage output and took
  the floor-6 clear rate to 0%. The shipped curve caps DEF at +1.
- **The party out-levels a gentle curve.** Against the XP table the party
  gains roughly a level per floor, which swamps a 6-8%/floor enemy ramp — the
  first curve I tried left floors 1-4 at a 100% win rate. Enemy ATK had to
  climb almost as fast as HP for the back half to have any teeth.
## 4. Cat Town — the meta layer

A persistent hub between runs (the existing `MetaFile` / `META_KEY` save slot is
already there and unused for this).

- **Currency**: shinies banked at the end of a run (win or lose) — a losing run
  must still pay out, or failure feels wasted.
- **Unlocks**, each a permanent addition to the *pool of possibilities*, never a
  flat power increase: extra starting cat slots, new cat classes/Stands,
  starting gear, shop upgrades, new encounter and event types, later biomes.
- **The unlock IS the content pool.** Stands, items and events that players and
  the GM have generated land in the shared pool; Cat Town is where they become
  available to you. Meta progression and the generative system are the same
  system viewed from two ends.
- Cat Town is a scene, not a menu: painted hub art, the cats you have recruited
  visibly living there, unlocks as places rather than list rows.

## 5. Randomness comes from the LLM

A deliberate architectural stance that changes what we invest in.

Classic roguelikes buy variety with large hand-authored random tables. We do
not: **the seeded RNG governs mechanical outcomes (so runs stay deterministic
and replayable), and the GM supplies novelty** — events, items, enemy flavour,
encounter framing, and the adjudication of whatever the player types.

Consequences:

- Do not grow big static content tables. Author enough for a good offline
  fallback and let the GM plus the shared pool provide the long tail.
- Every generated artefact is validated, budget-linted and persisted, so variety
  accumulates across players instead of being rerolled per run.
- Determinism is preserved because generation happens *outside* the resolution
  loop and its results are recorded (see `run-map-and-dm.md` §3).
