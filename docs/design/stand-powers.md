# Stand Powers — LLM-compiled, engine-executed

How player-imagined (and generated) Stand superpowers work in combat without
giving up determinism, latency, or replayability.

## Principle

**The LLM authors rules; the engine executes them.** No LLM call ever sits in
the combat action loop. Free-form powers are *compiled once* into a small
deterministic DSL ("Power Script"), validated, stored, and executed like any
other rule. Unique Stand-vs-Stand interactions are compiled lazily on first
encounter and memoized in the shared DB — first meeting anywhere in the world
pays one LLM call; afterwards every player gets the rule for free.

## Layer 1 — deterministic substrate (Power Script DSL)

A Stand superpower is data, executed by a new pure interpreter in
`src/core/combat/powers.ts`:

```ts
interface PowerScript {
  id: string;               // 'power:teslapurr'
  version: number;          // framework version it was compiled against
  name: string;             // "TESLA PURR"
  flavor: string;           // announced line
  budget: number;           // computed power-budget score (see Balance)
  trigger: Trigger;         // when the engine consults this power
  conditions: Predicate[];  // all must hold
  effects: EffectSpec[];    // bounded, existing effect union + numeric caps
  charges?: { perBattle?: number; perRound?: number };
}
type Trigger =
  | 'onTurnStart' | 'onTurnEnd' | 'onDealHit' | 'onTakeHit' | 'onCrit'
  | 'onAllyKO' | 'onStatusApplied' | 'onForcedMove' | 'onBattleStart'
  | 'activated';            // costs energy, appears as an extra skill slot
type Predicate =            // tiny closed set, engine-evaluable
  | { kind: 'hpBelowPct'; pct: number }
  | { kind: 'targetHasStatus'; status: StatusId }
  | { kind: 'selfRank'; ranks: number[] }
  | { kind: 'roundAtLeast'; n: number }
  | { kind: 'chance'; pct: number };   // rolled on the battle RNG stream
```

Effects reuse the EXISTING `EffectSpec` union (damage/heal/status/move/energy/
cooldown/cleanse...) — powers cannot introduce new mechanics, only recombine
them. That's what keeps compilation safe and the interpreter ~200 LoC.

Standard skills keep working exactly as today; a power is an extra rule card
attached to a combatant, consulted at its trigger points by `resolveAction`/
`startRound` hooks.

## Layer 2 — compilation (LLM, out of combat)

- **Party creation** (`/api/gm/party`): free-text cat description → the GM
  returns the normal kit PLUS one `PowerScript` per cat, generated under the
  framework json-schema (structured outputs) and passed through the
  **budget lint** (below). Invalid → one regenerate → fallback to a stock
  power from the pool.
- **Enemies/bosses** get hand-authored or pooled PowerScripts the same shape.

## Layer 3 — interaction compilation (memoized resonances)

When combatants with powers A and B are in the same battle, the engine emits
`interactionKey = sortedPair(A.id, B.id) + frameworkVersion` in the battle
setup log. The client asks `/api/gm/resonance` for the key:

- **DB hit** → the `InteractionRule` (same DSL: trigger/conditions/effects +
  flavor line + `announce` text) is attached to the battle from the start.
- **DB miss** → battle runs on base rules; the endpoint compiles the
  interaction async (LLM sees both PowerScripts + the framework + caps),
  validates, stores in the `interactions` table. The rule applies from the
  NEXT battle — surfaced as a discovery: "**STAND RESONANCE DISCOVERED:**
  STRING THEORY conducts TESLA PURR — shocks now arc along the threads."
  Discoveries are global: every player enriches the resonance codex, and the
  results screen credits "first discovered by <session>".

Compilation policy: most pairs SHOULD compile to `null` (no resonance) — the
LLM is instructed that resonances are notable, not universal (target ~1 in 3
pairs, judged on thematic fit). Null results are also memoized (cheapest row).

## Determinism & replay

- A battle's rule set is fixed at `createBattle` (powers + already-compiled
  interactions, all referenced by id+version in the battle record). Same seed
  + same rule ids = identical battle. Mid-battle nothing ever changes.
- `chance` predicates roll on the existing battle RNG stream, in slot order,
  after status rolls (documented in the RNG roll-order contract).

## Balance (budget lint)

Pure function `powerBudget(script)` prices every effect/trigger/condition
(e.g. damage pct × trigger frequency class − condition strictness). Caps:
cat powers ≤ B_cat, enemy ≤ B_tier, interactions ≤ B_res, hard numeric caps
per effect (no effect may exceed 40% of a floor-appropriate HP pool, stat
mods capped ±30%, no infinite loops: power effects cannot trigger powers).
The lint runs server-side at compile time AND client-side at battle setup
(defense in depth — a tampered pool row is rejected and replaced by no-op).

## DB additions (content pool)

- `powers`: id, version, json, budget, flavor, art hints, provenance, rating.
- `interactions`: pairKey, version, json|null, flavor, announce, provenance,
  times_triggered, rating, first_discovered_by.

## Scope ladder

1. MUST: DSL + interpreter + budget lint + stock powers for the 4 default
   cats and both bosses (hand-authored scripts prove the substrate).
2. SHOULD: /api/gm/party emits PowerScripts; /api/gm/resonance with memoized
   compilation + discovery banner.
3. COULD: rare "Wild Resonance" narrative event where a one-off free-text
   player action is adjudicated by the GM into a one-battle temporary rule
   (the only place an LLM output lands mid-run, still schema-bounded, and
   still cached).
