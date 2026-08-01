# Run Map + the Tabletop DM — design v3

> **STATUS: shipped, all five build steps.** The run map, the DM agent, the
> tabletop layer and both §4b presence requirements are in the tree; §5 is
> kept as a record of the order, not a plan. Where a section below still
> reads as future tense, a **SHIPPED** note names the code.

Supersedes `dungeon.md` (tile maze, fog of war, WASD movement) and reframes
`gm-system.md` from six stateless endpoints into one persistent Game Master.

Two changes, one idea: **the dungeon becomes a set of choices instead of a
grid, and the player can always just say what the party does.** Together they
turn the run into a tabletop session rather than a walking simulator.

## 1. Why the tile crawl goes

The 31×21 tile maze generated a lot of nothing. Most tiles were corridor the
player had not stepped on yet, so the screen was mostly black, the minimap was
mostly empty, and WASD movement added travel time without adding a single
decision. Walking from A to B is not gameplay; *choosing* B is.

## 2. The run map (FTL / Darkest Dungeon / Slay the Spire)

Each floor is a small directed graph, entry on the left, boss or stairs on the
right, drawn as a painted map rather than a tile grid.

- **Nodes are encounters.** Types: `fight`, `elite`, `event`, `shop` (the
  Peddler), `rest` (the catnap heal), `treasure`, `boss`. Each node advertises
  its type with an illustrated icon, so a route is a legible gamble: the short
  path past two elites, or the long safe one with a shop.
- **Edges are the decision.** From the current node the player picks among 2–3
  outgoing edges. Unreachable branches are visibly closed once passed — the
  regret is the point.
- **Deterministic.** The graph generates from the run seed on its own RNG
  stream, so the same seed is the same map (the existing determinism contract
  in `combat.md` §3 extends unchanged).
- **Density is authored, not emergent.** Per-floor node budgets replace
  `FloorConfig.roamers/chests/events`, so pacing is designed rather than a
  side-effect of maze topology.

**Replaces:** `src/core/dungeon/*` (maze gen, fog, stepping),
`src/ui/scenes/explore.ts`, `minimap.ts`, `exploreHud.ts`, and the map overlay.
**Keeps unchanged:** the combat engine, events, loot, the Peddler, floors 1–6
and their themes, progression, and the Stand power system.

## 3. The tabletop layer — type what you do

At every encounter — a fight included — the player can type an action instead
of only pressing buttons. The GM answers, in character, and the *engine*
applies whatever mechanical consequence the GM authorises.

- **Out of combat:** "Bruno pries the grate open with the crowbar" → narration
  plus, optionally, a bounded effect (damage, heal, status, shinies, an item, a
  remembered flag).
- **In combat:** "Pixel throws the lantern at the oil slick" → the encounter
  subagent adjudicates it into the engine's existing bounded vocabulary (an
  `EffectSpec` + energy cost + target), which `resolveAction` executes like any
  other action. Standard skills stay instant buttons; improvisation costs a
  turn and a beat of latency, which is the correct trade.
- **The GM may say no.** "You can't fly, you're a cat." Refusal is a legitimate
  outcome and must feel like a DM, not an error.

### Bounds (non-negotiable)

The GM authors *content*; it never computes outcomes. Everything it emits is
constrained by machinery that already exists and is already tested:

- the `EffectSpec` union in `core/combat/powerTypes.ts` — no new mechanics,
  only recombination of shipped ones;
- `EFFECT_CAPS` / `BUDGET_CAPS` and `powerBudget()` in
  `core/combat/powers.ts`, applied server-side at authoring time **and**
  client-side at application time (defence in depth — a tampered response is
  rejected and degrades to pure narration);
- per-floor numeric caps (`services/caps.ts`), applied to free-text event
  options by `tabletop.ts#validateEncounterVerdict`.

### Determinism & replay

Every adjudication is recorded into the run log as `{prompt, verdict, effects,
rngDraws}`. A replay of the same seed with the same transcript reproduces the
run exactly; the model is never re-consulted on replay. This is the same
memoisation principle as Stand resonances (`stand-powers.md` Layer 3).

## 4. The DM agent (Vercel eve)

The six stateless `api/gm/*` endpoints became one **persistent agent with a
durable session per run** (and have since been deleted — see "Migration —
DONE" below), so the GM remembers the whole adventure: that you
bribed the rat king on floor 2, that Baguette is out of lives, that you
promised the elder stray you would come back.

```
agent/
  instructions.md          the DM's voice, the bounds, the refusal policy
  agent.ts                 defineAgent({ model: 'anthropic/claude-haiku-4.5' })
  tools/
    narrate.ts             flavour text only, no mechanics
    apply_effect.ts        bounded EffectSpec, floor-capped, budget-linted
    grant_item.ts          from the existing item/hook menu, or pool-first
    adjust_shinies.ts
    remember.ts            write a fact to run state for later callback
    offer_encounter.ts     bias what the next node contains
    contribute_content.ts  publish an item/event/flavour to the shared pool
  skills/
    item.ts, event.ts      the two surviving one-shot procedures
  lib/
    effects.ts             zod mirror of EffectSpec + the per-floor ramp;
                           pricing is IMPORTED from src/, never reimplemented
    memory.ts              defineState run memory: facts + emissions
    catalog.ts             the closed item menu, per-floor shinies cap
    oneshot.ts             one-shot output schemas, parity-asserted
    pool.ts                the shared pool — SERVER-SIDE ONLY
  subagents/
    encounter/             one fight's adjudicator: gets the battle snapshot
      agent.ts             (ranks, HP, statuses, powers), narrower toolset
      instructions.md      returns a structured verdict via outputSchema
    party/                 the party forge: 1-4 descriptions in, four legal
      agent.ts             kits out. NO tools/ directory at all
      instructions.ts      declares outputSchema: partyOutputSchema
    resonance/             the Stand-pair judge, same shape and same reason
      agent.ts             declares outputSchema: resonanceOutputSchema
      instructions.ts
    encounter/tools/       check_effect_budget.ts — the ONE tool a subagent
                           has, so it can lint itself before answering
  channels/eve.ts          HTTP channel: CORS (DEFAULT_ORIGINS ∪ the env
                           var — additive, see docs/DM-DEPLOY.md), auth
```

Why eve rather than more endpoints:

- **Durable sessions** (Vercel Workflows) give run-long memory for free, and
  survive cold starts, redeploys and a player leaving the tab for an hour —
  which is precisely the lifetime of a run.
- **Subagents** (`agent/subagents/*`) are the natural unit for "this fight's
  DM": fresh context, narrower tools, its own identity, delegated with
  `{ message, outputSchema }` and returning typed data.
- **One-shot works — through a subagent, not through the DM.** The plan said
  `session.send({ message, outputSchema })` would carry party and resonance
  generation unchanged. It does not: the DM's own "you may only change the world
  through your tools" outranks a per-message schema, and 0 of 5 measured
  structured turns produced a result on either haiku or Sonnet 5. What works is
  giving the structured job to an agent with **nothing to call but the answer**
  — a declared subagent with no `tools/` directory, declaring the `outputSchema`
  itself — and reading its answer off the parent stream's `subagent.completed`.
  Same typed data, one architectural move away. See docs/DM-DEPLOY.md
  "Structured (one-shot) calls".
- Model calls resolve through **AI Gateway** with the deployment's OIDC token,
  so there is no provider secret to manage.

### Migration — DONE

`api/gm/*` kept working while the agent was built; each capability moved over
once the agent reached parity, and the endpoints were deleted last. That has
happened: **there is no `api/` directory and no `src/services/gm.ts`.** The
agent is the only back end, and there is no endpoint fallback behind it.

The client seam is now two files: `src/services/dm.ts` (transport, combat and
encounter verdicts, the presence layer) and `src/services/oneshot.ts` (the
party and resonance one-shots — routing to their subagents, plus the lint →
regenerate → salvage loop the endpoints used to run server-side). The shared bounds live in
`src/services/caps.ts`, imported by BOTH the browser and `agent/`, so there is
one copy of `EVENT_CAPS` and the floor ramp rather than the three there were.

### Offline-first (unchanged invariant)

No DM reachable ⇒ the typed-action input is hidden, encounters run on authored
content, and the game is fully playable. This is a hard rule, not a
nice-to-have: the game must never block on the network.

## 4b. The DM is present, not summoned

Two requirements that turn the DM from a feature into a character.

### Typed actions everywhere — exploration, events, fights

The "what do you do?" affordance must exist in **all three** contexts, with the
same voice and the same bounds:

| context | what typing means |
|---|---|
| **exploration** (the run map) | scout ahead, talk among yourselves, try something with a node before committing, ask the DM about the floor. May reveal intel, cost time, or spring something. |
| **events** | the free-text option alongside the authored choices. |
| **fights** | improvise an action; the encounter subagent adjudicates it into a bounded effect and it costs the turn. |

**SHIPPED — all three.** `src/ui/overlays/tabletopBar.ts` is the one typed-action
card, mounted by `scenes/runMap.ts`, `scenes/event.ts` and `scenes/battle.ts`.
Exploration was the missing one when this was written and is no longer: the
run map carries the same `[T]` affordance the other two do, which is also the
one place nothing is under time pressure, so it reads as the table between
fights rather than a command prompt.

### The DM interferes on its own

The DM must occasionally act **unprompted**, or it is a vending machine. It
interjects at authored beats:

- arriving at a node, descending a floor, entering a boss lair;
- after a spike — a KO, a Cat Pile, a crit that ends a fight, a near-death;
- when the run state is dramatic (one life left, broke, a cat benched).

An interjection may be pure narration, or — within the same bounded, linted
effect vocabulary — a small twist: an offer, a complication, a gift, a warning.
It draws on run-long session memory, so it can call back to what the party did
three floors ago.

**SHIPPED.** `src/services/dm.ts` (`planInterjection`, `requestInterjection`,
`withQueuedInterjection`, `withInterjectionRecorded`) plus the battle-scene
wiring at `scenes/battle.ts` §"presence". An interjection lands between turns
with nothing else on the card, and answering it is an ordinary improvised
turn; acting instead of answering closes it.

**Constraints (non-negotiable):**

- **Rate-limited and never blocking.** The game never waits on the DM. An
  interjection arrives asynchronously and is rendered when it lands, or never.
- **Rarity is the point.** Frequent interjections become wallpaper; target a
  handful per run, weighted toward dramatic beats.
- **Player can always answer** — an interjection is an invitation to type back,
  not a cutscene.
- **Offline ⇒ silent.** No DM, no interjections, and the game reads as complete.

### Auto-generated content, persisted

Content the DM generates during play — items, events, enemy flavour, Stand
interactions — is validated, budget-linted, and written to the shared pool with
its style version, so it is reused by later runs and other players (§4,
`gm-system.md`). Generation happens outside the resolution loop and its results
are recorded in the run log, so determinism and replay are preserved.

**SHIPPED — the WRITE side only.** `agent/tools/contribute_content.ts` lints
and publishes `item` / `event` / `flavour` into `agent/lib/pool.ts`. Nothing
reads it back into a run yet: the pool is server-side by design (`src/` never
imports it), so a pooled item or enemy description cannot currently reach the
browser. `core/meta/types.ts` already defines the seam — a `pool:<ns>` unlock
opens a namespace and `overlay.pool[ns]` is where entries would land — and
Cat Town already sells those unlocks. What is missing is the transport: a DM
tool or route that hands pool rows to the client at run start. Until then,
"the unlock IS the content pool" (`balance-and-meta.md` §4) is true of the
architecture and not yet of the content.

## 5. Build order — DONE

All four steps shipped, in this order.


1. **Run map core** — graph generator on its own RNG stream, node/edge types,
   run-state migration, tests. Engine only, no art.
2. **Run map scene** — the painted map, route selection, node icons, transitions
   into the existing encounter scenes. Retire explore/minimap.
3. **DM agent** — scaffold, tools, encounter subagent, deploy, CORS, health.
4. **Tabletop input** — the text field in encounter and battle scenes, the
   verdict pipeline, the record-into-run-log path, offline degradation.
