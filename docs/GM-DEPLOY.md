# The GM service — retired

**The six stateless `api/gm/*` Vercel functions no longer exist.** Neither does
the `api/` directory, the `ANTHROPIC_API_KEY` they wanted, or the client seam
`src/services/gm.ts` that called them. The game's Vercel project now ships a
static bundle and nothing else.

Everything they did is done by the persistent Dungeon Master:

> ### → [docs/DM-DEPLOY.md](DM-DEPLOY.md)
>
> An eve agent in `agent/`, deployed as its own Vercel project
> (`https://c-at-rpg-dm.vercel.app`), one durable session per run, model access
> through the AI Gateway with the deployment's own OIDC token. Its
> **"Where the endpoints went"** table maps each retired route to its
> replacement, and **"What the agent does not cover"** records the one thing
> that did not survive (global resonance memoisation, which was never actually
> provisioned).

This file is kept for the two things that were never about the endpoints, and
for the deployment lessons that still apply.

---

## Style contract & runtime art prompts

`src/content/artStyle.ts` (visual-v2.md §Style contract) is the ONE versioned
source of truth for art style: `ART_STYLE = { version, basePrompt, negative,
palette, model, fallbackModel, anchorUrl, framing }`.

Models are instructed to write **subject-only** descriptions — the cat's body
and pose, the object's shape and materials — and never to mention style,
camera, background or rendering technique. The house style is appended by
`composeArtPrompt(category, subject)` in **`src/services/artPrompt.ts`** as
`subject + framing[category] + basePrompt + negatives`. It used to run
server-side in `api/_lib/artPrompt.ts`; the DM returns a subject and the
browser composes (`services/oneshot.ts#requestDmParty` does this to every
`stand.visualPrompt` before the kit is shown).

The shared pool stores the raw subjects plus the `styleVersion` they were
authored at, so bumping the style bible restyles pooled content for free.

The style anchor `docs/art/style-anchor-bruno.png` is copied to
`public/art/style-anchor-bruno.png` so `ART_STYLE.anchorUrl`
(`/art/style-anchor-bruno.png`) resolves on the deployed site and a generator
can pass it as a reference image.

## The shared content pool

`agent/lib/pool.ts` (was `api/_lib/pool.ts`) — the one `api/_lib` module that
outlived the endpoints, because the DM writes to it through the
`contribute_content` tool. **Server-side only:** it reads `process.env` and
talks to Upstash over REST, so nothing under `src/` may import it.

- unset `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` ⇒ a per-instance
  in-memory store. Fine for dev; it means nothing is actually shared. **This is
  the state production has always been in** — `api/gm/health` reported
  `poolBacked: false` right up to the day it was deleted.
- set both (free DB at console.upstash.com, copy the REST credentials) ⇒ a real
  shared pool: capped lists for `stands` / `items` / `events` / `enemies`, keyed
  hash tables for `powers` / `interactions` / `art`.

### Seeding generation zero

```sh
npx tsx scripts/seed-pool.ts
```

Reads `public/assets/gen/**/manifest.json` (missing sub-manifests are fine —
batches may be mid-generation) and `src/content/powers.ts`, then upserts keyed
`art` and `powers` rows through the `PoolStore` interface. Idempotent; re-run
after every asset batch or style-version bump. Set the Upstash vars in the
shell to seed the shared pool; without them it dry-runs against the in-memory
pool and prints counts.

(`npx tsx` is the runner: plain `node --experimental-transform-types` cannot
resolve the repo's `.js`-suffixed relative imports, and
`--experimental-strip-types` additionally rejects the constructor parameter
properties in `pool.ts`.)

## Deployment lessons that still apply

The first two bit the retired functions and will bite the agent deployment the
same way. The third is dead history, kept because it looks like a platform bug
and is not.

1. **Explicit `.js` import specifiers are mandatory.** `package.json` is
   `"type": "module"` and Vercel *transpiles* without bundling, so Node's ESM
   resolver — which does no extension guessing — throws `ERR_MODULE_NOT_FOUND`
   on `import { ENEMIES } from "../../src/content/enemies"`. Every relative
   specifier in `src/`, `agent/`, `tests/` and `scripts/` therefore carries an
   explicit `.js` extension. TypeScript (`moduleResolution: bundler`), Vite and
   Vitest all resolve `./foo.js` back to `foo.ts`, so this costs nothing
   locally. Do not "tidy" the extensions away.
2. **A CORS-clean endpoint is not a browser-readable endpoint.** The DM's
   `/eve/v1/health` answers `200` to `curl` and is unreadable from a browser
   because eve serves it outside the channel's CORS middleware. The client
   probes `/eve/v1/info` instead. Full story in DM-DEPLOY.md "Health check";
   this class of bug only reproduces in a real browser against a real
   deployment, so verify it that way.
3. **(historic) The OIDC token was a REQUEST HEADER, not an env var.** Per
   [vercel.com/docs/oidc](https://vercel.com/docs/oidc), `VERCEL_OIDC_TOKEN` is
   set in the environment during *builds* and locally via `vercel env pull`,
   but a deployed function receives it on the `x-vercel-oidc-token` header of
   each request. Reading it from `process.env` alone yielded nothing in
   production while working perfectly in local dev. The agent does not hit this
   — eve resolves gateway credentials itself — but anything else deployed to
   Vercel that needs the gateway will.

## Cost notes

The old per-endpoint arithmetic is obsolete: there is one model
(`anthropic/claude-haiku-4.5`, set in `agent/agent.ts`), one deployment, and
billing runs through the AI Gateway on the DM project's own OIDC principal. The
shapes that still hold:

- a conversational beat is ~1–3K in / <1K out;
- party generation is the expensive one (four kits, four Power Scripts) and
  happens at most once per run, only for players who type their own cats;
- resonance compiles once per power pair per browser session, fire-and-forget,
  and a `null` verdict is as good an answer as a rule;
- with no `VITE_DM_URL` the game makes **zero** model calls, because it makes
  zero requests.
