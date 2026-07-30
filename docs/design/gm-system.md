# Game Master System — dynamic content service

A lightweight AI Game Master that steers runs and generates content on the fly.
The core game stays fully playable offline (static content = fallback); the GM
service is an enhancement layer.

## Architecture

```
browser (PixiJS game)
   │  fetch JSON
   ▼
Vercel serverless functions  /api/gm/*   (TypeScript, @anthropic-ai/sdk)
   │  claude-haiku-4-5 (default, structured outputs)      [text content]
   │  claude-sonnet-5 (optional, party generation only)   [quality tier]
   │  Masonry CLI-equivalent HTTP jobs                    [images]
   ▼
Content pool (Vercel KV / Upstash Redis or Supabase Postgres)
   – every generated stand/item/event/enemy is persisted and REUSED:
     the more people play, the bigger the shared pool grows.
```

- Official Anthropic SDK (`@anthropic-ai/sdk`) inside the functions — not an
  OpenAI-compat shim. All generation uses **structured outputs**
  (`output_config.format` json_schema) so responses are guaranteed-valid JSON
  matching the game's core types; no parsing/repair layer needed.
- Model: `claude-haiku-4-5` (fast/cheap) for events, items, barks.
  `claude-sonnet-5` for run-start party generation (bigger creative ask,
  once per run). Model ids are config, not code.
- Every endpoint has a **pool-first** policy: roll from the shared pool with
  probability p (rising as the pool grows), generate fresh otherwise; every
  fresh generation is validated (same validators the static content passes:
  `core/events/validate`, skill-budget lint) then written to the pool.
- The GM never computes combat outcomes — it authors *content* in the same
  data shapes the engines already consume. Layering stays intact.

## Endpoints

### POST /api/gm/party
Player free-text: 1–4 cat descriptions ("a paranoid sphynx who controls
static electricity, stand named TESLA PURR"). Returns 4 `CatClass`-shaped kits
+ Stand names/visual prompts, balanced under hard constraints:
- stat total, skill count, power budget, energy costs and cooldowns must match
  the classes.md budget table (server-side lint rejects and regenerates once).
- roles must cover tank/striker/control/support across the party.
- content policy: reject/sanitize inappropriate descriptions.
Also enqueues Masonry sprite jobs for each cat (returns job ids; client polls
/api/gm/assets/:id and falls back to procedural sprites until ready).

### POST /api/gm/event
Input: run context (floor, party HP/lives/shinies, recent events, theme tags).
Output: an `NarrativeEvent` in the exact events.md schema, including 2–4
options and — new — an optional **free-text option**: the player types what
they do; a follow-up call `/api/gm/event/resolve` maps the free text to
mechanical effects within a bounded effect menu (never arbitrary — the schema
constrains to the existing EffectSpec union with numeric caps per floor).

### POST /api/gm/item
Input: floor, rarity roll, party composition. Output: an `EquipDef`/consumable
in loot.md shapes with one themed hook chosen from the EXISTING hook menu
(no new mechanics), plus an icon prompt → Masonry job. Pool-first.

### POST /api/gm/steer  (the "director")
Called at floor transitions with the run summary. Returns small nudges from a
bounded set: encounter budget ±1, shop stock bias, next-event theme, one-line
floor intro text. Keeps runs deterministic-ish: nudges are recorded into the
run seed record so a replay with the same seed + same GM transcript reproduces.

## Shared content pool

Tables: `stands`, `items`, `events`, `enemies` — columns: id, schema_version,
json payload, art_url, author_session, created_at, times_used, rating.
Reuse policy: pool-first probability p = min(0.7, pool_size/200). Curation:
things that crash validation never enter; a lightweight thumbs-up/down in the
results screen feeds `rating`; negative-rated content is retired.

## Client integration

- `src/core` gains zero network code. A new `src/services/gm.ts` (ui-layer
  service) wraps fetch + zod-light validation of responses against core types,
  with timeouts and the static-content fallback on any failure.
- Free-text inputs: party creator on title screen; event free-text option.
- Offline/failed GM = the current static game, unchanged. No hard dependency.

## Safety/constraints

- All player free text goes to the GM with a system prompt that enforces
  content policy and mechanical bounds; outputs are schema-constrained.
- Rate limiting per IP on Vercel; Masonry spend capped per day.
- Secrets (ANTHROPIC_API_KEY, MASONRY_KEY, KV) live in Vercel env, never in
  the client bundle.
