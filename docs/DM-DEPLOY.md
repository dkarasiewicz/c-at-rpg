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
| `agent/skills/{party,item,event,resonance}.ts` | the one-shot procedures, with budgets interpolated from the shipped lint tables |
| `agent/subagents/encounter/` | the fight adjudicator: battle snapshot in, structured verdict out |
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

Everything `api/gm/*` did survives as a schema'd one-shot. A server-side caller
passes the matching zod schema from `agent/lib/oneshot.ts` as `outputSchema`
and reads `result.data`:

```ts
import { Client } from "eve/client";

const session = new Client({ host: DM_URL }).session();

const response = await session.send({
  message: "Build a party. The player described: a fat orange menace ...",
  outputSchema: partyOutputSchema,
});
const { data } = await response.result();   // GeneratedCatKit[4], schema-valid
```

Each schema carries a compile-time parity assertion against the shipped core
contract, so the payload shape cannot drift from what the browser re-validates.

**The browser does not use `eve/client`.** It would drag zod and a
server-and-tooling SDK into the game bundle for four routes, so
`src/services/dm.ts` speaks the HTTP protocol with `fetch` and
`src/services/oneshot.ts` passes the same schemas **as raw JSON Schema**
(`PARTY_SCHEMA`, `RESONANCE_SCHEMA`) — eve rehydrates them server-side. The two
spellings are the same contract; the zod ones carry the compile-time assertions.

### Where the endpoints went

| Retired | Where it lives now |
|---|---|
| `POST /api/gm/party` | `services/oneshot.ts#requestDmParty` → `session.send({ outputSchema: PARTY_SCHEMA })` + the `party` skill, then **lint → regenerate → salvage** (see below), budget stamping via `normalizePower()`, and `stand.visualPrompt` composed through `artPrompt.ts`. Every one of those steps used to happen inside the function |
| `POST /api/gm/resonance` | `services/oneshot.ts#requestDmResonance` + the `resonance` skill. `readResonanceVerdict` stamps `pairKey` / `version` / recomputed `budget` and lints at `BUDGET_CAPS.resonance`. **The memo store did not survive — see below** |
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

### The regenerate-on-invalid turn is load-bearing

`api/_lib/generate.ts` wrapped every generation in *generate → lint →
regenerate once with the violations → salvage*. The agent has no equivalent:
`agent/skills/party.ts` states the budgets, but nothing makes it check its own
arithmetic (only the `encounter` subagent has a self-correcting tool,
`check_effect_budget`). Measured against the deployed DM, a first party answer
routinely breaks them — a representative run:

```
kit 0 (Sparks): base.crt=3 outside 5..15
kit 2 (Velocity): base.crt=17 outside 5..15
kit 0 (Sparks) skill 3 ('staticBurst'): row-pattern power above 60
power 'power:staticWhispers': budget 16.5 exceeds cap 12      (3 of 4 powers over cap)
```

So `requestDmParty` sends the violation list back as **the next turn of the
same session** — the model sees its own answer and the exact arithmetic it got
wrong, which is cheaper and more effective than a fresh generation. It gets
`PARTY_RETRIES` (2) of those, one more than the endpoint's single regenerate,
because the endpoint's retry was a Sonnet-class re-roll and these are haiku-class
corrections that tend to fix one thing and break another. Only when the turns
run out does `salvagePartyPowers` swap the offending powers for
`STOCK_POWERS[role]`; only a kit-level failure loses the party, and then the
creator falls back to the four canonical strays exactly as it always did.

**Budget the wait accordingly.** Measured turn latencies against the deployed
agent: 39s, 60s, 68s, and once over 90s. `DM_PARTY_TIMEOUT_MS` is therefore
**120s per turn**, and a party is minutes, not seconds. Two consecutive
end-to-end runs of `requestDmParty` at the 90s setting:

```
run 0: 155053ms -> OK    (2 turns; lintParty clean; 3 powers kept,
                          1 salvaged to the stock control power; all
                          budgets stamped, all art prompts composed)
run 1:  90012ms -> NULL  (first turn exceeded the timeout → the Strays)
```

A `NULL` there is not a bug, it is the offline path: the creator toasts and
starts a normal run. (`src/services/gm.ts` used a flat 8s for every call — which
the old Sonnet-backed `/api/gm/party` with `maxDuration: 60` cannot ever have
beaten. The creator's "GM offline, using the Strays" path was quietly doubling
as its timeout path.)

**If party generation needs to be more reliable, change the model, not the
prompt.** The endpoint ran party on `GM_PARTY_MODEL`
(`anthropic/claude-sonnet-5`) precisely because it is the hard creative ask;
`agent/agent.ts` runs everything on `anthropic/claude-haiku-4.5`. A party
subagent with its own stronger model is the clean fix, and it is an `agent/`
change, not a client one.

## What the agent does not cover

Two things. Neither is a reason to bring an endpoint back; both are recorded
here so the next person does not rediscover them by accident.

**1. Self-correcting arithmetic on the one-shots.** Covered above — the client
now owns the regenerate loop `api/_lib/generate.ts` used to. The proper fix
lives in `agent/`.

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
a pool read inside the `resonance` skill) restores the global codex without
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
