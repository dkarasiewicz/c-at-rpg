# GM service — deploy & operations

The AI Game Master (docs/design/gm-system.md) runs as Vercel serverless
functions under `api/gm/*`, next to the static Vite build of the game. The
game is fully playable without it — every client call falls back to static
content on any failure.

## Deployment status

**Live and generating** at https://c-at-rpg-three.vercel.app — Vercel project
`dk-lab/c-at-rpg` (Vite preset auto-detected, `dist/` output, `api/**` as Node
functions with `maxDuration: 60` from `vercel.json`).

**There is no secret to configure.** Model calls go through Vercel AI Gateway
and authenticate with the deployment's own OIDC token, so no
`ANTHROPIC_API_KEY` and no `AI_GATEWAY_API_KEY` is needed on Vercel. Only
`GM_MODEL` / `GM_PARTY_MODEL` are set (gateway slugs, all three environments).
For local development, `vercel env pull` writes a 12-hour `VERCEL_OIDC_TOKEN`
into `.env.local`; refresh it by pulling again.

Check the deployment at any time:

```bash
curl 'https://c-at-rpg-three.vercel.app/api/gm/health?probe=1'
# {"ok":true,"credentialSource":"oidc-header","probe":{"ok":true}, ...}
```

`credentialSource` tells you which credential was resolved (`oidc-header` is
the healthy deployed case) and `?probe=1` makes one real round-trip so a
misconfiguration reports itself instead of hiding behind the offline fallback.

> The short `c-at-rpg.vercel.app` domain is still held by an earlier project in
> the personal scope. Free it with
> `vercel project remove c-at-rpg --scope dkarasiewiczs-projects`, then
> `vercel alias set <deployment> c-at-rpg.vercel.app`.

### Three runtime gotchas this deploy had to solve

All are properties of Vercel's Node runtime and will bite again if reverted:

1. **Explicit `.js` import specifiers are mandatory.** `package.json` is
   `"type": "module"` and Vercel *transpiles* `api/**/*.ts` without bundling,
   so Node's ESM resolver — which does no extension guessing — threw
   `ERR_MODULE_NOT_FOUND` on `import { ENEMIES } from "../../src/content/enemies"`.
   Every relative specifier in `src/`, `api/`, `tests/` and `scripts/` therefore
   carries an explicit `.js` extension. TypeScript (`moduleResolution: bundler`),
   Vite and Vitest all resolve `./foo.js` back to `foo.ts`, so this costs
   nothing locally. Do not "tidy" the extensions away.
2. **The Node runtime calls the default export with `(IncomingMessage,
   ServerResponse)`,** not the web `Request`/`Response` pair the handlers are
   written against — `req.headers.get` is not a function. Each route's default
   export is therefore wrapped in `vercelHandler()` (`api/_lib/http.ts`), which
   accepts either calling convention and additionally converts any throw into a
   clean JSON error, so a missing API key degrades to the offline fallback
   instead of `FUNCTION_INVOCATION_FAILED`. The `createXHandler(deps)` factories
   stay web-standard, which is what the unit tests drive.
3. **The OIDC token is a REQUEST HEADER at runtime, not an env var.** This is
   the one that looks most like a platform bug and isn't. Per
   [vercel.com/docs/oidc](https://vercel.com/docs/oidc), `VERCEL_OIDC_TOKEN` is
   set in the environment **during builds** and locally via `vercel env pull` —
   but in a deployed function Vercel puts the token on the
   `x-vercel-oidc-token` header of each incoming `Request`. Resolving the
   credential from `process.env` alone therefore yields nothing in production
   while working perfectly in local dev. `gmApiKey(req)` reads the header, and
   because the token rotates (~45 min), the Anthropic client is cached **per
   credential** and route deps are built **per request** rather than once per
   process. Do not "optimise" those back into a module-level singleton.

## Layout

| Path | What |
|---|---|
| `api/gm/party.ts` | POST — free-text cats → 4 legal CatClass-shaped kits + Stands (GM_PARTY_MODEL) |
| `api/gm/event.ts` | POST — run context → one `GameEvent` in the events.md schema, pool-first |
| `api/gm/eventResolve.ts` | POST — player free text at an event → one Outcome-shaped verdict (bounded effect menu, per-floor caps, one retry, nothing memoized) |
| `api/gm/item.ts` | POST — floor/rarity/party → one `EquipDef` + icon prompt, pool-first |
| `api/gm/resonance.ts` | POST — power pair → memoized `InteractionRule\|null` (stand-powers.md Layer 3); pool hit = no model call |
| `api/gm/steer.ts` | POST — run summary → bounded director nudges |
| `api/_lib/anthropic.ts` | Official `@anthropic-ai/sdk` wrapper; structured outputs (`output_config.format` json_schema) |
| `api/_lib/constraints.ts` | Pure server-side lints: classes.md stat/skill budgets, event effect caps, item hook menu |
| `api/_lib/powers.ts` | Service wrapper over the canonical core budget lint (`src/core/combat/powers.ts`): error-string lints, budget stamping, pair key, stock fallbacks, DSL JSON schemas |
| `api/_lib/artPrompt.ts` | Prompt composition against the style contract (`src/content/artStyle.ts`) |
| `api/_lib/generate.ts` | generate → lint → regenerate-once pipeline (injectable client for tests; optional salvage hook) |
| `api/_lib/pool.ts` | Shared content pool: in-memory (dev) or Upstash Redis REST; p = min(0.7, size/200); keyed powers/interactions/art tables |
| `scripts/seed-pool.ts` | Upserts generation-zero art + stock-power rows into the pool |
| `src/services/gm.ts` | Browser client: fetch, 8s timeout, hand-rolled response guards, null-on-failure |
| `src/services/gmTypes.ts` | Protocol types shared by both sides (types only, no runtime code) |

Layering: `src/core` has zero network code; api handlers import **types and
pure validators** from `src/core` / `src/content` (e.g. the same
`core/events/validate` the shipped content passes); nothing in `src` imports
runtime code from `api/`. The root tsconfig includes only `src`, so
`npm run typecheck` and `vite build` never touch `api/` — check the functions
package separately with `npx tsc -p api/tsconfig.json`.

## Environment

Copy `.env.example`. Server-side (Vercel → Project → Settings → Environment
Variables; never exposed to the client bundle):

- `ANTHROPIC_API_KEY` — required.
- `GM_MODEL` — default `claude-haiku-4-5` (events, items, steering).
- `GM_PARTY_MODEL` — default `claude-sonnet-5` (party generation, once per run).
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — optional. When
  unset, the pool is per-instance in-memory (fine for dev; pooling across
  players needs Upstash). Create a free DB at console.upstash.com and copy
  the REST credentials.

Client-side (optional): `VITE_GM_URL` — GM api base URL; defaults to
same-origin `/api`.

## Deploy (Vercel CLI)

```sh
npm i -g vercel
vercel login
vercel link                      # first time: create/link the project
vercel env add ANTHROPIC_API_KEY # repeat for the other vars
vercel                           # preview deploy (static site + functions)
vercel --prod
```

Vercel auto-detects the Vite app (`dist/`) and picks up `api/**/*.ts` as
Node-runtime functions (web `Request → Response` handlers). `vercel.json`
only raises `maxDuration` to 60s (party generation on Sonnet can take a
while).

## Local dev

```sh
vercel dev        # serves the Vite app AND the api/ functions on one port
```

`vercel dev` reads `.env` / `.env.local` for the server-side vars. Plain
`npm run dev` also works but serves no `/api` — the game then runs on static
content only (every GM call times out and falls back), or set
`VITE_GM_URL=<preview-deploy>/api` to point the local client at a deployed GM.

Smoke test an endpoint:

```sh
curl -s localhost:3000/api/gm/steer -H 'content-type: application/json' -d '{
  "floor": 2,
  "summary": {"hpPct": 0.6, "livesLost": 1, "shinies": 40,
               "enemiesDefeated": 9, "catPiles": 2}
}'
```

## Style contract & runtime art prompts

`src/content/artStyle.ts` (visual-v2.md §Style contract) is the ONE versioned
source of truth for art style: `ART_STYLE = { version, basePrompt, negative,
palette, model, fallbackModel, anchorUrl, framing }`. Every
`visualPrompt`/`iconPrompt` a GM endpoint returns is composed server-side by
`api/_lib/artPrompt.ts` as `subject + framing[category] + basePrompt +
negatives` — models are instructed to write SUBJECT-ONLY descriptions and the
pool stores those raw subjects (plus the `styleVersion` they were made at),
so bumping the style bible restyles pooled content for free. The style anchor
`docs/art/style-anchor-bruno.png` is copied to
`public/art/style-anchor-bruno.png` so `ART_STYLE.anchorUrl`
(`/art/style-anchor-bruno.png`) resolves on the deployed site and the
server-side generator can pass it as a reference image.

## Resonance endpoint (stand-powers.md Layer 3)

`POST /api/gm/resonance` with `{ pairKey, powers: [PowerScript, PowerScript],
sessionId? }`. `pairKey` MUST equal the canonical
`sortedPair(A.id, B.id)@v<frameworkVersion>` (helper: `resonancePairKey` in
`src/services/gm.ts` client-side / `api/_lib/powers.ts` server-side; the
server recomputes and 400s a mismatch, so the memo table cannot be poisoned).
Both scripts are re-linted on arrival (defense in depth). A stored row —
including a stored `json: null` "no resonance" verdict — is returned without
a model call; a miss compiles once on `GM_MODEL`, validates at the resonance
budget cap, and memoizes `{ pairKey, version, json|null, flavor, announce,
first_discovered_by }` in the keyed `interactions` table. Failed compiles are
NOT memoized (the next encounter retries). The client entry point is
`requestGmResonance` in `src/services/gm.ts` (null = transport failure ≠
null rule).

The party endpoint now also emits one budget-linted `PowerScript` per kit
(schema-enforced, one regenerate on lint failure, then per-power fallback to
a stock power — the party never 502s because of powers alone).

**Client wiring (shipped):** `battle.ts buildSetup` computes the pairKey for
every cross-side power pair. A pair with a cached verdict and a non-null rule
attaches it via `PoweredBattleSetup.interactions` — the rule executes as an
extra chargeless power of the cat in the pair, re-linted at the resonance cap
by `initPowersState` (drop-on-failure, defense in depth) and consulted after
the owner's own script. Uncached pairs fire `prefetchResonance()` (never
awaited — zero latency added to battle start; offline nothing happens) and
the compiled rule applies from the NEXT battle featuring the pair, announced
once per session by the "STAND RESONANCE DISCOVERED" banner (Cat Pile banner
pattern). Verdicts — including definitive `rule: null` — live in a
session-scoped cache in `src/services/gm.ts` (`getCachedResonance`).

## Event free-text resolver

`POST /api/gm/eventResolve` (note: the literal file route, not
`/event/resolve` — Vercel routes mirror filenames) with `{ floor, text,
eventId?, eventPrompt?, optionLabels?, partyHp?, shinies? }`. The model maps
the player's free text onto the events.md effect union ONLY (json-schema
excludes `gateCat` — there is no gate) and the result is linted by wrapping
it in a synthetic event and running the full `lintEvent` (shipped validator +
per-floor caps), so a free-text verdict can never exceed what a generated
event option could do. One regenerate on lint failure, then 502. Nothing is
pooled: free text is one-shot.

Client wiring (shipped): the event modal probes the GM once per session
(`probeGm()` — an empty POST answered by a JSON 400, no model call; cached).
When reachable, the PROMPT gains a "[T] Do something else…" row beside the
Leave row; the player types into a DOM overlay input, and the verdict is
applied through the exact same `resolveOption` path as a fixed option
(clamps, fired-id bookkeeping and the `Fight!` handoff intact) then shown as
a normal RESULT. Offline — or on any mid-flight failure — the modal is
byte-identical to the static game (the row is simply absent / the prompt
returns untouched).

## Seeding the pool (generation zero)

```sh
npx tsx scripts/seed-pool.ts
```

Reads `public/assets/gen/**/manifest.json` (missing sub-manifests are fine —
batches may be mid-generation) and `src/content/powers.ts` (module probed
dynamically; absence is fine), then upserts keyed `art` and `powers` rows
through the `PoolStore` interface. Idempotent; re-run after every asset batch
or style-version bump. Set `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`
in the shell to seed the shared Redis pool; without them it dry-runs against
the in-memory pool and just prints counts. (`npx tsx` is the runner: plain
`node --experimental-transform-types` cannot resolve the repo's extensionless
relative imports, and `--experimental-strip-types` additionally rejects the
constructor parameter properties in `api/_lib/pool.ts`.)

## Cost notes

- `claude-haiku-4-5`: $1 / $5 per MTok. An event/item/steer call is roughly
  1–3K input + <2K output tokens → well under $0.02 per call; steering runs
  once per floor, events/items only when the UI opts in.
- `claude-sonnet-5`: $3 / $15 per MTok (intro pricing $2 / $10 through
  2026-08-31). Party generation is ~2K in / ~2K out → a few cents, once per
  run, and only for players who type custom cats.
- The pool cuts spend as it grows: at 200+ pooled entries, 70% of
  event/item requests are served from Redis with no model call.
- Guardrails: per-IP rate limit (30/min, best-effort per instance) in
  `api/_lib/http.ts`; one retry max per generation; `max_tokens` 2000.

## UI wiring plan

All client entry points live in `src/services/gm.ts` and return `null` on
any failure; the UI must always keep the static path working. Already wired:
the event free-text option and battle resonance (see the sections above).
Still to wire:

1. **Title screen / party creator** — on "describe your own cats", call
   `requestGmParty(descriptions)`. On kits: build the run's `BattleSetup.cats`
   from `GeneratedCatKit` (base/growth/skills map 1:1 onto the CatClass
   shape), show `stand.name` + `flavor` in the roster UI, and hand
   `stand.visualPrompt` to the sprite pipeline (procedural fallback until a
   generated sprite exists). On `null`: the four default strays, unchanged.
2. **Floor transition** — call `requestGmSteer({floor, summary})` fire-and-
   forget with the run summary; apply `encounterBudgetDelta` to the pack
   budget roll, pass `shopBias` to shop stock, queue `nextEventTheme` for the
   next event call, and show `floorIntro` as the floor banner. Record the
   nudges into the run seed record (determinism per gm-system.md).
3. **Event tiles** — before opening a static event, optionally call
   `requestGmEvent({floor, ...context, themeTags})`; a non-null `GameEvent`
   is passed to the exact same event overlay/resolve code path as static
   events (it passed the same validator). On `null`: static draw.
4. **Loot rolls** — for a rare drop, optionally call `requestGmItem({floor,
   rarity})`; a non-null `GeneratedEquip` is registered into the run's item
   defs before `EquipInstance` resolution, `iconPrompt` goes to the sprite
   pipeline. On `null`: static tables.

## Scaffold gaps (deliberate, tracked here)

- **No Masonry jobs yet** — `stand.visualPrompt` / `iconPrompt` are returned
  (now composed from the style contract) but no image jobs are enqueued;
  clients keep procedural art. `/api/gm/event` returns no image prompts at
  all — generated events reuse shipped scene art or the procedural overlay.
- **Items are equipment-only** — GM consumables (which embed a battle
  `Skill` payload) are out of scope for the scaffold.
- **Party endpoint skips pool-first reads** — descriptions are personal;
  parties are still *written* to the `stands` pool for future
  browse/surprise-me features.
- **Rate limiting is per-warm-instance** — move it into Upstash for real
  enforcement.
- **Pool curation** — `times_used`/`rating` columns from gm-system.md are
  not implemented; the pool is a capped Redis list of validated JSON.
