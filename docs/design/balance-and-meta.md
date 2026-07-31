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
