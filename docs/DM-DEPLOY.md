# The persistent DM — deploy & operations

The Dungeon Master (docs/design/run-map-and-dm.md §4) is a
[Vercel **eve**](https://eve.dev/docs) agent living in `agent/` at the repo
root. It replaced the six stateless `api/gm/*` functions with **one agent that
holds a durable session per run**, so it remembers the whole adventure: that the
party bribed the rat king on floor 2, that Baguette is out of lives, that they
promised the elder stray they would come back.

**`api/gm/*` is gone.** The migration is finished: the endpoints, their
`api/_lib` support and the game's whole `api/` directory are deleted, and the
browser talks only to this agent. What each endpoint became is recorded in
[Where the endpoints went](#where-the-endpoints-went); the one capability that
did NOT survive is in [What the agent does not cover](#what-the-agent-does-not-cover).

The offline-first invariant is unchanged: no DM reachable ⇒ the typed-action
input is hidden and the game is fully playable on authored content. A 401, a
cold start, a deleted deployment — all of them look identical to "the player
chose not to use the DM".

## Layout

| Path | What |
|---|---|
| `agent/agent.ts` | `defineAgent({ model: "anthropic/claude-haiku-4.5" })`, 7-day session lifetime |
| `agent/instructions.md` | the DM's voice, the hard bounds, the refusal policy |
| `agent/channels/eve.ts` | HTTP channel: CORS to the game origin, browser-workable auth |
| `agent/lib/effects.ts` | the zod mirror of the engine's `EffectSpec` union + the per-floor ramp; pricing is **imported** from `src/core/combat/powers.ts`, never reimplemented |
| `agent/lib/memory.ts` | `defineState` run memory: the fact ledger and the emission ledger |
| `agent/lib/catalog.ts` | the closed item menu and the per-floor shinies cap |
| `agent/lib/pool.ts` | the shared content pool (Upstash REST or in-memory). SERVER-SIDE ONLY — it reads `process.env`, so `src/` never imports it. It outlived `api/` because `contribute_content` and `scripts/seed-pool.ts` write to it |
| `agent/lib/oneshot.ts` | output schemas for the one-shot capabilities, with compile-time parity assertions against `src/core/types.ts` / `src/services/gmTypes.ts` |
| `agent/tools/narrate.ts` | flavour text only — no mechanics, and the home of refusals |
| `agent/tools/apply_effect.ts` | 1–3 bounded `EffectSpec`s, floor-capped, budget-linted |
| `agent/tools/grant_item.ts` | an item that already exists (consumables + equipment) |
| `agent/tools/adjust_shinies.ts` | currency, capped by `EVENT_CAPS.shiniesMax(floor)` |
| `agent/tools/remember.ts` | write a fact to run state for a later callback |
| `agent/tools/offer_encounter.ts` | advisory bias for the next run-map node |
| `agent/skills/{item,event}.ts` | the remaining one-shot procedures, with budgets interpolated from the shipped lint tables. **`party` and `resonance` are not skills any more** — they are subagents, below |
| `agent/subagents/encounter/` | the fight adjudicator: battle snapshot in, structured verdict out |
| `agent/subagents/party/` | the party forge. **No `tools/` directory**: brief in, four kits out, nothing else to call |
| `agent/subagents/resonance/` | the Stand-pair judge. Same shape, same reason |
| `agent/tsconfig.json` | standalone typecheck (`npm run typecheck:agent`) — the app's root tsconfig still includes only `src/` |

## The bounds, and where they are actually enforced

The DM authors content; it never computes outcomes. Every mechanical thing it
emits is checked by machinery that already exists and is already tested:

- **The union.** `agent/lib/effects.ts` mirrors `EffectSpec` from
  `src/core/combat/powerTypes.ts` and carries a compile-time parity assertion
  (`EFFECT_SPEC_PARITY`). Add a seventh effect kind to the engine without
  updating the mirror and `npm run typecheck:agent` fails.
- **The price.** `lintImprovisedEffects()` wraps the effects in a synthetic
  `activated` `PowerScript` and runs the engine's own `powerBudget()` +
  `validatePowerScript()` — the same functions `initPowersState()` runs at
  battle setup and `src/services/powerLint.ts` runs in the browser on every
  verdict.
- **The floor.** A ramp of `(2 + floor) / 8` scales the shipped caps: floor 1
  improvisation is worth 3/8 of a full Stand power, floor 6 exactly one. It can
  never exceed `BUDGET_CAPS.cat`, `EFFECT_CAPS.damagePct`, or the rest. The ramp
  and the per-floor `EVENT_CAPS` table live in **`src/services/caps.ts`, once**;
  the agent and the browser both import them, so the numbers the DM is briefed
  with are by construction the numbers the client will accept.
- **Defence in depth.** The tools *authorise*; they do not execute. The client
  re-lints on application (docs/design/run-map-and-dm.md §3), so a tampered
  response degrades to pure narration.
- **Refusal is an outcome.** A failed lint returns `{ applied: false, problems }`
  rather than throwing, so the DM narrates the smaller thing that happened.

## Models and credentials

Model ids are **AI Gateway slugs** (`anthropic/claude-haiku-4.5`), so the
deployment authenticates with its own OIDC token. **There is no provider API
key to manage** — nothing like the `ANTHROPIC_API_KEY` the retired `api/gm/*`
functions needed. The game's own Vercel project now ships **no serverless
functions at all**; `vercel.json` carries only the schema line.

For local development against the gateway, either link the Vercel project (eve
pulls `VERCEL_OIDC_TOKEN`) or set `AI_GATEWAY_API_KEY` in `.env.local`.

## Environment variables

| Var | Where | Required | What |
|---|---|---|---|
| `DM_ALLOWED_ORIGINS` | agent deployment | no | comma-separated CORS origins. Defaults to `https://c-at-rpg.vercel.app,http://localhost:5173,http://127.0.0.1:5173`. Add preview origins here rather than editing `agent/channels/eve.ts`. |
| `AI_GATEWAY_API_KEY` | local only | no | gateway credential when the project is not linked |
| `VERCEL_OIDC_TOKEN` | pulled by `eve link` | — | how a linked project reaches the gateway |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | local | no | set before `eve dev <url>` if the deployment has Deployment Protection on |
| `VITE_DM_URL` | game build | **yes, for any DM feature** | absolute origin of this deployment, e.g. `https://c-at-rpg-dm.vercel.app`. UNSET IS A SUPPORTED STATE: the probe short-circuits without a request and the game plays offline on authored content. But with it unset there is no party generation, no typed actions and no resonance — there is no `/api` fallback any more. |

## Deploy

Node 24 is required (`engines.node: ">=24"` in `package.json`, an eve
requirement).

### The Vercel-project conflict, and how to avoid it

The repo root is **already linked** to the game's Vercel project (`.vercel/`
holds `c-at-rpg`). `eve link` would overwrite that link. Give the DM its **own**
project and keep the game's link untouched by passing the target explicitly:

```bash
# once, from a scratch directory — creates the project without touching .vercel
vercel project add c-at-rpg-dm

# then, from the repo root, deploy the agent to it
VERCEL_ORG_ID=<team id> VERCEL_PROJECT_ID=<prj_ id of c-at-rpg-dm> npm run dm:deploy
```

If you would rather use the interactive flow, do it in a separate checkout or
git worktree so the game's `.vercel/project.json` is never rewritten:

```bash
eve link           # links / creates the project and pulls its env
npm run dm:deploy  # eve deploy → vercel deploy --prod
```

### Local

```bash
npm run dm:dev              # eve dev — local server + TUI at http://127.0.0.1:3000
npm run dm:dev -- https://c-at-rpg-dm.vercel.app   # drive the deployed agent
npm run typecheck:agent     # tsc -p agent/tsconfig.json
```

`eve build` writes to `.vercel/output` when `VERCEL` is set; locally it writes
`.eve/` and `.output/`. All three are gitignored.

## Health check

```bash
curl https://c-at-rpg-dm.vercel.app/eve/v1/health
curl https://c-at-rpg-dm.vercel.app/eve/v1/info
```

`/eve/v1/health` is the liveness probe (it does **not** make a model call — for
a real generation probe, start a session and send a trivial message).

> **The browser probe must use `/eve/v1/info`, not `/eve/v1/health`.** eve
> serves `health` from the workflow runtime, *outside* the eve channel's CORS
> middleware, so it answers `200` with **no `Access-Control-Allow-Origin`
> header**. `curl` sees a perfectly healthy endpoint; a browser cannot read the
> response at all, so the probe fails and the game silently concludes the DM is
> offline — the offline path is working as designed, which is precisely what
> makes this invisible. `/eve/v1/info` is served by the channel, carries the
> CORS headers, and also makes no model call. `src/services/dm.ts#probeDm` uses
> it for exactly this reason; do not "simplify" it back to `health`.
>
> This class of bug only reproduces in a real browser against a real
> deployment. Verify it that way.

## HTTP surface

`eveChannel()` mounts:

| Route | Use |
|---|---|
| `GET /eve/v1/health` | liveness |
| `GET /eve/v1/info` | discovered agent surface |
| `POST /eve/v1/session` | **start a run** → `{ sessionId, continuationToken }` |
| `POST /eve/v1/session/:sessionId` | a beat in that run |
| `POST /eve/v1/session/:sessionId/cancel` | abandon the in-flight turn |
| `GET /eve/v1/session/:sessionId/stream` | NDJSON event stream |

**One eve session == one run.** Persist `sessionId` in the run state next to the
seed; a returning player resumes the same DM with the same memory. A new run
starts a new session.

### CORS

Narrowed in `agent/channels/eve.ts` to `DM_ALLOWED_ORIGINS` (or the defaults),
methods `GET`/`POST`, headers `authorization`/`content-type`, 600s preflight
cache. Add a preview origin by setting the env var and redeploying — no code
change.

### Auth

The policy is `[vercelOidc(), localDev(), none()]`.

- `vercelOidc()` — the eve CLI/TUI and other deployments on the team get a real
  principal.
- `localDev()` — loopback origins during `eve dev`.
- `none()` — **anonymous browser traffic is accepted.** This is deliberate: the
  caller is a single-player game with no accounts and no user data, so there is
  no credential to present and nothing to impersonate. The eve scaffold's
  `placeholderAuth()` would 401 every browser in production, which for an
  offline-first game means the DM silently disappears rather than fails loudly.

`none()` is terminal — it halts the auth walk, so it must stay last. If the DM
ever costs real money per player or touches anything worth protecting, replace
`none()` with a real `AuthFn` (see eve `guides/auth-and-route-protection`) and
keep the ordering.

## Structured (one-shot) calls

**A one-shot is answered by a subagent, never by the DM itself.** That is the
whole design and it was learned the hard way.

The obvious thing — `session.send({ message, outputSchema })` against the root
DM — does not work, and no amount of prompting made it work. `agent/
instructions.md` says *"you may only change the world through your tools"*,
which is correct and load-bearing for play, and it beats a per-message
`outputSchema` every time: measured against this deployment, **0 of 5**
structured turns produced a `result.completed`. Each ended on `narrate` or an
effect tool and eve failed the turn with `OUTPUT_SCHEMA_NOT_FULFILLED`.
Swapping haiku for `anthropic/claude-sonnet-5` was **also 0 of 5**, and twice as
slow — a stronger model follows the dominant instruction *more* reliably. It was
never a model problem.

So the structured work moved to agents that have no such instruction and, by
construction, nothing else to do:

| Subagent | Answers | Declares |
|---|---|---|
| `agent/subagents/party/` | four cat kits | `outputSchema: partyOutputSchema` |
| `agent/subagents/resonance/` | one Stand-pair verdict | `outputSchema: resonanceOutputSchema` |
| `agent/subagents/encounter/` | one in-battle verdict | `outputSchema: verdictSchema` |

**Neither `party/` nor `resonance/` has a `tools/` directory at all.** A declared
subagent inherits nothing from the root (eve `subagents` §"The isolation
boundary") — not `narrate`, not `apply_effect`, not the DM's instructions — so
there is no wrong action left to take. Their instructions say the only thing
they can do is return the object, and that is also the only thing they can do.

`outputSchema` is declared on the subagent rather than passed per message
because a delegation is a **task-mode run** (eve `agent-config` §`outputSchema`),
so the runtime holds the child to the schema and the parent needs no schema of
its own.

### How the browser gets the answer

The eve HTTP channel routes to the root session and nowhere else — a client
cannot address a subagent directly. It does not need to. eve reports every
delegation on the **parent** stream:

```json
{"type":"subagent.completed","data":{"subagentName":"party","output":"{\"kits\":[…]}"}}
```

`output` is the child's structured answer, JSON-stringified by the runtime. So:

1. `src/services/oneshot.ts` opens the message with a marker line —
   `PARTY BRIEF —` / `RESONANCE BRIEF —` — and sends **no `outputSchema`**;
2. `agent/instructions.md` §"Briefs" tells the root exactly one thing to do with
   such a message: pass it to that subagent **unchanged**, call nothing else,
   and answer with one short line;
3. `src/services/dm.ts#sendDmTurn` takes `subagent: "party"`, harvests
   `subagent.completed`, and returns the parsed child output as `data`
   (`collectSubagentOutput` / `subagentResult`).

The root is a relay. It never sees the schema, and asking it for one on top
would only buy a second, slower copy of an object it cannot type.

A server-side caller with `eve/client` can do the same thing more directly:

```ts
const response = await session.send({
  message: "PARTY BRIEF — pass this whole message to `party`.\n\n…",
});
// the party arrives on the stream as subagent.completed
```

### Schemas carry every bound they can express

`agent/lib/oneshot.ts` used to describe shape only, and left every number to the
prose brief plus the client lint. That cost real generations. The first party
generated through the new subagent came back with **32 lint errors**, 29 of
which were the schema's fault rather than the model's:

- `growth` rows were typed over all six `STAT_KEYS`, so `enMax` in a growth row
  was formally legal — `contentLint` has never accepted it, and the model put it
  in all 28 rows;
- `agent/lib/effects.ts` derived its status menu from `STATUS_COST`, which
  prices **seven** statuses because the engine applies `braced` itself. The
  browser's lints accept the **six** in `caps.ts#STATUS_IDS`. Every `braced` the
  DM authored was rejected on arrival;
- `move.delta` / `energy.amount` said "non-zero" with a zod `.refine()`, which
  has no JSON Schema spelling and is silently dropped in the projection the
  model actually sees. A live Stand power came back with `delta: 0`.

All three are fixed at the source, and every remaining expressible bound —
per-stat `STAT_BOUNDS`, `enMax`, `GROWTH_KEYS`, skill costs, the three power
ceilings (as a `union` → `anyOf`, since the narrow two depend on sibling
fields) — is now in the schema. What a schema *cannot* say (a role's stat SUM,
total skill cost, `powerBudget`) stays with the client lint and the retry loop.

Result, measured on the same brief: **32 lint errors → 4 → 0** on the first
answer.

### Where the endpoints went

| Retired | Where it lives now |
|---|---|
| `POST /api/gm/party` | `services/oneshot.ts#requestDmParty` → a `PARTY BRIEF —` relayed to the `party` subagent, then **lint → regenerate → salvage** (see below), budget stamping via `normalizePower()`, and `stand.visualPrompt` composed through `artPrompt.ts`. Every one of those steps used to happen inside the function |
| `POST /api/gm/resonance` | `services/oneshot.ts#requestDmResonance` → a `RESONANCE BRIEF —` relayed to the `resonance` subagent. `readResonanceVerdict` stamps `pairKey` / `version` / recomputed `budget` and lints at `BUDGET_CAPS.resonance`. **The memo store did not survive — see below** |
| `POST /api/gm/eventResolve` | a conversational beat: `services/dm.ts#requestEncounterVerdict`, re-linted by `tabletop.ts#validateEncounterVerdict` against the same `EVENT_CAPS`, now with run memory behind it |
| `POST /api/gm/item` | `session.send({ outputSchema: itemOutputSchema })` + the `item` skill. **No game caller** — loot rolls from the static tables |
| `POST /api/gm/event` | `session.send({ outputSchema: eventOutputSchema })` + the `event` skill. **No game caller** — events draw from `content/events.ts` |
| `POST /api/gm/steer` | subsumed by durable memory + `offer_encounter`. **No game caller** — it was never wired |
| `GET /api/gm/health` | deleted. It reported which Anthropic credential the function resolved; there is no such credential any more. Liveness is `GET /eve/v1/health` (curl) / `GET /eve/v1/info` (browser) |

The lints those endpoints ran did not move to the model — they moved to the
CONSUMER. `src/services/contentLint.ts` (`lintParty`, `lintEvent`, `lintItem`)
and `src/services/powerLint.ts` are imported by the browser AND by the agent's
`contribute_content` tool, so a payload is checked by the same function
wherever it lands.

### The lint pipeline: derive, salvage, and only then regenerate

`api/_lib/generate.ts` wrapped every generation in *generate → lint →
regenerate once → salvage*. That loop is still here, but it is now the LAST
resort rather than the first, because a regeneration costs the player ~80s of
spinner and lands on the same arithmetic. In order:

1. **The schema stops what a schema can stop** (above). Growth keys, per-stat
   bounds, skill-id case, skill costs, the three power ceilings, the six
   statuses, non-zero move/energy — all enforced by the runtime on the forge,
   before the answer is ever sent.
2. **`completeBaseStats` derives what the model should never have authored.**
   `hp` is not in the party schema at all: the client computes
   `ROLE_STAT_TOTALS[role] − (atk + def + spd + crt)` and moves the slack
   through `crt` if that lands outside 24..40. `enMax` is likewise stamped, not
   asked for. "stat total 63 != 64" was the most common single lint failure in
   live measurement and it is now unrepresentable — which is also just the
   house rule (*"you never do arithmetic that matters"*) applied to the DM's own
   output.
3. **`salvagePartyPowers` runs BEFORE the retry.** If the kits are legal and
   only Stand powers are over budget, the offending powers become
   `STOCK_POWERS[role]` and the party ships. The player keeps every cat they
   described; they lose one bespoke power, which is exactly stand-powers.md
   Layer 2's documented fallback. Regenerating four cats to fix a budget product
   the model cannot evaluate is not a trade worth ~80s.
4. **Then, and only then, one retry** (`PARTY_RETRIES` = 1, down from 2). It is
   a fresh, self-contained brief — the forge is a subagent and sees no history,
   so the retry repeats the descriptions and carries over the four identities
   (name / class / epithet / Stand) so the player keeps the cats they were
   shown. Failing that, the creator falls back to the four canonical strays,
   exactly as it always did.

**Budget the wait from the tail.** Twenty-two timed party turns against the
deployed forge: 41, 43, 45, 65, 71, 71, 72, 72, 75, 75, 77, 77, 79, 79, 81, 82,
92, 93, 95, 96, 105, 106, 116s. `DM_PARTY_TIMEOUT_MS` is **150s per turn** —
about 30% above the worst measured turn. It briefly had to go UP to 180s (from 120s)
because at 120s two of five end-to-end runs were not slow answers but the
offline path; it came back down only once derivation and salvage had made a
party a ONE-turn job, so the budget covers one turn rather than three. What a
player waits is the median: **51s**.

### Measured, end to end, against the live deployment

Every row is `requestDmParty` against `https://c-at-rpg-dm.vercel.app`, five
runs, distinct briefs, through the real client.

| Build | Result | Latency |
|---|---|---|
| Schema passed to the root DM | **0 / 5** — every turn `OUTPUT_SCHEMA_NOT_FULFILLED`; no result at all | 121, 121, 121s: the whole budget, then the spinner |
| Subagent route, first cut | 3 / 5 | 48-251s |
| + tightened schema, 180s budget, early salvage | 3 / 5 | 72-150s |
| + derived `hp`, trimmed growth rows (180s budget) | **5 / 5** | 43, 46, 65, 79, 82s — median 65s |
| **the same, with the budget cut back to 150s** | **5 / 5** | 45, 46, 51, 79, 92s — median **51s**, every one a single turn |

First-answer lint failures on the same briefs went 32 errors → 0-3 → 0. The
three classes that survived the schema were all arithmetic, and all three moved
to the client rather than to a regeneration: the stat sum (`hp` derived), the
growth-row budget (trimmed), the Power Script budget (salvaged to
`STOCK_POWERS[role]`).

And under a finger, on the real game (Playwright chromium, 844x390 landscape,
`hasTouch`, taps only): title → *Create your party* → two typed cats → *Summon
the GM* → the preview showed four generated Stands in **114s** — Marmalade the
Wandering Bladebeast with 「SEPPUKU SATISFACTION」, Static the Nervous Disruptor
with 「WHITE NOISE WATCHER」 — and *Take them in* started the run with them.
Every stat total landed exactly on `ROLE_STAT_TOTALS`.

## What the agent does not cover

Two things. Neither is a reason to bring an endpoint back; both are recorded
here so the next person does not rediscover them by accident.

**1. A party is still ONE ~65s generation, and the next fix is parallelism.**
Five of five is where it stands, but the sample is five and a single bad kit
still costs the whole answer. The shape that improves both the tail and the
latency is a `cat` subagent that forges ONE kit for one
named role, fanned out FOUR TIMES IN PARALLEL from the client (four sessions,
`Promise.all`) rather than one `party` call:

- latency becomes the max of four ~25s answers instead of the sum of one long
  one;
- a bad kit costs one ~25s regeneration, not a whole party;
- "party is missing the 'support' role" and "exactly 4 kits" stop being lint
  rules at all, because the client assigns the roles;
- cross-kit rules that remain (unique names) are cheap to check and cheap to
  redo.

The cost is that four cats designed independently have no party-level
composition, which the brief can partly buy back by giving each call the other
three descriptions as context. This is an `agent/` + `src/services/oneshot.ts`
change and nothing else; the routing, harvesting and lint machinery it needs
already exists.

**2. Global resonance memoisation.** `POST /api/gm/resonance` kept a keyed
`interactions` row per pair, so a verdict compiled by one player was reused by
every other player, forever — stand-powers.md Layer 3 calls that memoisation
part of the design. The agent has no such store (memoisation was always the
caller's job, and the caller is now a browser), so verdicts are cached in a
`Map` for the life of one browser session and `firstDiscoveredBy` is gone.

Two things make this a smaller regression than it reads:

- it was **never live**. `GET /api/gm/health` on the production game reported
  `poolBacked: false` — `UPSTASH_REDIS_REST_URL` was never set, so the "shared"
  memo was a per-warm-lambda `Map` that evaporated on every cold start;
- a wrong or missing verdict is not a failure. `rule: null` and "not fetched
  yet" both mean the battle runs on base rules, and the pair recompiles next
  session.

The right home for it is the agent, not another endpoint: `agent/lib/pool.ts`
already offers `getEntry`/`setEntry` on a keyed `interactions` table and the DM
already writes to the pool via `contribute_content`. A `resonance_memo` tool (or
a pool read from the `resonance` subagent) restores the global codex without
bringing back a serverless function or a second model credential. Provision
Upstash first, or it will be exactly as inert as it was.

## The combat path

In-battle free text goes to the `encounter` subagent, delegated as a tool call
named after its directory:

```ts
encounter({
  message: "<battle snapshot: ranks, HP, statuses, energy, powers, floor> " +
           "The player types: 'Pixel throws the lantern at the oil slick'",
  outputSchema: verdictSchema,
})
```

It returns `{ allowed, narration, effects[], energyCost, target }`, which
`resolveAction` executes like any other action. The subagent has exactly one
tool — `check_effect_budget`, which runs the engine's lint so it can correct
itself before answering — and it shares **no** state with the parent (declared
subagents always start fresh), which is why the parent must pack the whole
snapshot into `message`.

Every adjudication should be recorded into the run log as
`{ prompt, verdict, effects, rngDraws }`; a replay of the same seed with the
same transcript reproduces the run exactly and never re-consults the model
(docs/design/run-map-and-dm.md §3).

## Migration (done)

Kept as a record of where things moved, because half of it is load-bearing.

| Was | Is |
|---|---|
| `api/_lib/constraints.ts` | split: numeric tables → `src/services/caps.ts`, lints → `src/services/contentLint.ts` |
| `api/_lib/powers.ts` | `src/services/powerLint.ts` (still a wrapper over `core/combat/powers.ts`, which still owns the pricing) |
| `api/_lib/artPrompt.ts` | `src/services/artPrompt.ts` |
| `api/_lib/pool.ts` | `agent/lib/pool.ts` — server-side only, and the one `api/_lib` module that outlived the endpoints |
| `api/_lib/{anthropic,generate,http}.ts` | deleted. The model client, the generate→lint→retry loop and the Vercel Request/Response shim are eve's job now |
| `src/services/gm.ts` | deleted. `dm.ts` (transport + beats) and `oneshot.ts` (party, resonance) |
| `EVENT_CAPS_MIRROR` in `tabletop.ts`, `floorRamp` in `agent/lib/effects.ts` | both re-export `src/services/caps.ts`. The two parity tests that pinned the mirrors are deleted — there is nothing left to pin |
| `tests/gm.spec.ts` endpoint smokes | the client-side pipelines: `lintGeneratedParty`, `readResonanceVerdict` |

Three rules survived the move and are still non-negotiable:

1. **The numbers have one home.** `src/services/caps.ts`. The agent imports it,
   the browser imports it. Never copy a cap into a prompt or a mirror.
2. **`src/` never imports from the agent, and the agent never imports pixi.**
   The dependency runs one way: `agent/` → `src/services` → `src/core`.
3. **A model never computes its own budget.** `normalizePower()` stamps it on
   receipt, wherever receipt happens to be.

## Gotchas

1. **Explicit `.js` import specifiers are mandatory.** `package.json` is
   `"type": "module"` and Vercel transpiles without bundling, so every relative
   specifier under `agent/` carries `.js` — same rule as `src/`, `tests/` and
   `scripts/`. Do not "tidy" them away.
2. **The agent is excluded from the app's typecheck.** The root tsconfig
   includes only `src/`. Check the agent with `npm run typecheck:agent` (which
   pulls `src/` in transitively, since the agent imports the shipped lints);
   `npm run lint` (`eslint .`) does cover `agent/`.
3. **A schema'd turn sometimes answers in PROSE.** Roughly one turn in three on
   the resonance one-shot came back with no `result.completed` event and the
   schema-shaped object sitting in the assistant text instead. `sendDmTurn`
   therefore falls back to `parseEmbeddedJson(text)` when a turn that asked for
   an `outputSchema` produced no structured result. It is a fallback, not a
   parser: the caller re-lints whatever comes out, so a bad guess costs exactly
   what a missing result costs. Do not remove it — the failure it covers is
   intermittent and looks like "the DM ignored me".
4. **State is never shared with subagents.** `defineState` values do not cross
   the parent/child boundary — pack context into `message`.
5. **A tool call is an authorisation, not an application.** Nothing under
   `agent/tools/` mutates game state; the client applies the emission and
   re-lints it. Anything that skips that step has skipped the safety net.
