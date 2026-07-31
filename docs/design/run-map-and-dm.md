# Run Map + the Tabletop DM — design v3

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
- per-floor numeric caps, exactly as `/api/gm/eventResolve` already does for
  free-text event options.

### Determinism & replay

Every adjudication is recorded into the run log as `{prompt, verdict, effects,
rngDraws}`. A replay of the same seed with the same transcript reproduces the
run exactly; the model is never re-consulted on replay. This is the same
memoisation principle as Stand resonances (`stand-powers.md` Layer 3).

## 4. The DM agent (Vercel eve)

The six stateless `api/gm/*` endpoints become one **persistent agent with a
durable session per run**, so the GM remembers the whole adventure: that you
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
  subagents/
    encounter/             one fight's adjudicator: gets the battle snapshot
      agent.ts             (ranks, HP, statuses, powers), narrower toolset
      instructions.md      returns a structured verdict via outputSchema
  channels/eve.ts          HTTP channel: CORS to the game origin, auth
```

Why eve rather than more endpoints:

- **Durable sessions** (Vercel Workflows) give run-long memory for free, and
  survive cold starts, redeploys and a player leaving the tab for an hour —
  which is precisely the lifetime of a run.
- **Subagents** (`agent/subagents/*`) are the natural unit for "this fight's
  DM": fresh context, narrower tools, its own identity, delegated with
  `{ message, outputSchema }` and returning typed data.
- **One-shot still works.** `session.send({ message, outputSchema })` returns
  schema-valid typed data, so party generation, item generation and resonance
  compilation stay exactly as structured as they are today — no loss.
- Model calls resolve through **AI Gateway** with the deployment's OIDC token,
  so there is no provider secret to manage.

### Migration

`api/gm/*` keeps working while the agent is built; each capability moves over
once the agent reaches parity, and the endpoints are deleted last. The client
keeps one seam (`src/services/gm.ts`) so the swap is invisible to the scenes.

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
| **events** | the free-text option alongside the authored choices (already shipped). |
| **fights** | improvise an action; the encounter subagent adjudicates it into a bounded effect and it costs the turn (already shipped). |

Exploration is the missing one. It is also the most natural place to talk,
because nothing is under time pressure — so it should feel like the table
between fights, not a command prompt.

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

## 5. Build order

1. **Run map core** — graph generator on its own RNG stream, node/edge types,
   run-state migration, tests. Engine only, no art.
2. **Run map scene** — the painted map, route selection, node icons, transitions
   into the existing encounter scenes. Retire explore/minimap.
3. **DM agent** — scaffold, tools, encounter subagent, deploy, CORS, health.
4. **Tabletop input** — the text field in encounter and battle scenes, the
   verdict pipeline, the record-into-run-log path, offline degradation.
