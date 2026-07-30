# GM service — deploy & operations

The AI Game Master (docs/design/gm-system.md) runs as Vercel serverless
functions under `api/gm/*`, next to the static Vite build of the game. The
game is fully playable without it — every client call falls back to static
content on any failure.

## Layout

| Path | What |
|---|---|
| `api/gm/party.ts` | POST — free-text cats → 4 legal CatClass-shaped kits + Stands (GM_PARTY_MODEL) |
| `api/gm/event.ts` | POST — run context → one `GameEvent` in the events.md schema, pool-first |
| `api/gm/item.ts` | POST — floor/rarity/party → one `EquipDef` + icon prompt, pool-first |
| `api/gm/steer.ts` | POST — run summary → bounded director nudges |
| `api/_lib/anthropic.ts` | Official `@anthropic-ai/sdk` wrapper; structured outputs (`output_config.format` json_schema) |
| `api/_lib/constraints.ts` | Pure server-side lints: classes.md stat/skill budgets, event effect caps, item hook menu |
| `api/_lib/generate.ts` | generate → lint → regenerate-once pipeline (injectable client for tests) |
| `api/_lib/pool.ts` | Shared content pool: in-memory (dev) or Upstash Redis REST; p = min(0.7, size/200) |
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

## UI wiring plan (not wired yet — UI is owned by another workstream)

All client entry points live in `src/services/gm.ts` and return `null` on
any failure; the UI must always keep the static path working:

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
  but no image jobs are enqueued; clients keep procedural art.
- **No `/api/gm/event/resolve`** — the free-text event option from
  gm-system.md is not implemented; generated events use fixed options only.
- **Items are equipment-only** — GM consumables (which embed a battle
  `Skill` payload) are out of scope for the scaffold.
- **Party endpoint skips pool-first reads** — descriptions are personal;
  parties are still *written* to the `stands` pool for future
  browse/surprise-me features.
- **Rate limiting is per-warm-instance** — move it into Upstash for real
  enforcement.
- **Pool curation** — `times_used`/`rating` columns from gm-system.md are
  not implemented; the pool is a capped Redis list of validated JSON.
