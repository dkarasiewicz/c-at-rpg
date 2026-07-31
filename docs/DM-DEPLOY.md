# The persistent DM — deploy & operations

The Dungeon Master (docs/design/run-map-and-dm.md §4) is a
[Vercel **eve**](https://eve.dev/docs) agent living in `agent/` at the repo
root. It replaces the six stateless `api/gm/*` functions with **one agent that
holds a durable session per run**, so it remembers the whole adventure: that the
party bribed the rat king on floor 2, that Baguette is out of lives, that they
promised the elder stray they would come back.

`api/gm/*` is still live and still what the client calls. Nothing is deleted
until parity is proven — see [Migration](#migration).

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
  battle setup and `api/_lib/powers.ts` runs server-side.
- **The floor.** A ramp of `(2 + floor) / 8` scales the shipped caps: floor 1
  improvisation is worth 3/8 of a full Stand power, floor 6 exactly one. It can
  never exceed `BUDGET_CAPS.cat`, `EFFECT_CAPS.damagePct`, or the rest.
- **Defence in depth.** The tools *authorise*; they do not execute. The client
  re-lints on application (docs/design/run-map-and-dm.md §3), so a tampered
  response degrades to pure narration.
- **Refusal is an outcome.** A failed lint returns `{ applied: false, problems }`
  rather than throwing, so the DM narrates the smaller thing that happened.

## Models and credentials

Model ids are **AI Gateway slugs** (`anthropic/claude-haiku-4.5`), so the
deployment authenticates with its own OIDC token. **There is no provider API
key to manage** — nothing like the `ANTHROPIC_API_KEY` the `api/gm/*` functions
need.

For local development against the gateway, either link the Vercel project (eve
pulls `VERCEL_OIDC_TOKEN`) or set `AI_GATEWAY_API_KEY` in `.env.local`.

## Environment variables

| Var | Where | Required | What |
|---|---|---|---|
| `DM_ALLOWED_ORIGINS` | agent deployment | no | comma-separated CORS origins. Defaults to `https://c-at-rpg.vercel.app,http://localhost:5173,http://127.0.0.1:5173`. Add preview origins here rather than editing `agent/channels/eve.ts`. |
| `AI_GATEWAY_API_KEY` | local only | no | gateway credential when the project is not linked |
| `VERCEL_OIDC_TOKEN` | pulled by `eve link` | — | how a linked project reaches the gateway |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | local | no | set before `eve dev <url>` if the deployment has Deployment Protection on |
| `VITE_GM_URL` | game build | later | points the client seam at the DM. Not used yet — the client still calls `/api/gm/*`. |

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

Everything `api/gm/*` does today survives as a schema'd one-shot. Pass the
matching schema from `agent/lib/oneshot.ts` as `outputSchema` and read
`result.data`:

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
contract, so the payload shape cannot drift from what `src/services/gm.ts`
already re-validates.

### Endpoint → capability

| Today | On the agent |
|---|---|
| `POST /api/gm/party` | `session.send({ outputSchema: partyOutputSchema })` + the `party` skill |
| `POST /api/gm/item` | `session.send({ outputSchema: itemOutputSchema })` + the `item` skill |
| `POST /api/gm/event` | `session.send({ outputSchema: eventOutputSchema })` + the `event` skill |
| `POST /api/gm/resonance` | `session.send({ outputSchema: resonanceOutputSchema })` + the `resonance` skill |
| `POST /api/gm/eventResolve` | a conversational beat → the `apply_effect` tool (same caps, now with run memory behind it) |
| `POST /api/gm/steer` | subsumed by durable memory + `offer_encounter` (the director no longer needs a round trip to know how the run is going) |
| `GET /api/gm/health` | `GET /eve/v1/health` |

Memoisation (the Redis pool behind `party` / `item` / `event` / `resonance`) is
**not** part of the agent. Resonance compilation in particular is memoized
forever by design (stand-powers.md Layer 3), so whatever calls the agent keeps
owning that cache — the agent is the compiler, not the store.

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

## Migration

1. `api/gm/*` keeps working while the agent is built. **Do not delete it yet.**
2. Move one capability at a time behind the single client seam
   (`src/services/gm.ts`), prove parity, then retire that endpoint.
3. **`agent/lib/catalog.ts` imports `EVENT_CAPS` from
   `api/_lib/constraints.ts`** — the per-floor numeric cap table, deliberately
   shared rather than copied. When `api/gm/*` is finally deleted, move
   `EVENT_CAPS` (and `ROLE_STAT_TOTALS` / `MEW_HOOKS`, used by
   `agent/skills/*.ts`) into `src/core` and update those imports. Do not
   duplicate the numbers.
4. **The tabletop UI has landed** (`src/services/tabletop.ts`,
   `src/services/dm.ts`, `src/ui/overlays/tabletopBar.ts`, and the `[T]` paths
   in `scenes/battle.ts` / `scenes/event.ts`). The client mirrors
   `agent/lib/effects.ts`'s floor ramp and `api/_lib/constraints.ts`'s
   `EVENT_CAPS` rather than importing them (the browser must not pull in agent
   or api code, or zod); both mirrors are pinned to their originals by parity
   tests in `tests/tabletop.spec.ts` over every floor. When `EVENT_CAPS` and
   `floorRamp` move into `src/core` per item 3, delete the mirrors and the
   parity tests with them.
5. **The event scene asks the DM first.** `probeDm()` runs, and only if it says
   no does `probeGm()` fire — so a reachable agent costs zero legacy requests.

## Gotchas

1. **Explicit `.js` import specifiers are mandatory.** `package.json` is
   `"type": "module"` and Vercel transpiles without bundling, so every relative
   specifier under `agent/` carries `.js` — same rule as `src/`, `api/`,
   `tests/` and `scripts/`. Do not "tidy" them away.
2. **The agent is excluded from the app's typecheck.** The root tsconfig still
   includes only `src/`, exactly like `api/`. Check it with
   `npm run typecheck:agent`; `npm run lint` (`eslint .`) does cover `agent/`.
3. **State is never shared with subagents.** `defineState` values do not cross
   the parent/child boundary — pack context into `message`.
4. **A tool call is an authorisation, not an application.** Nothing under
   `agent/tools/` mutates game state; the client applies the emission and
   re-lints it. Anything that skips that step has skipped the safety net.
