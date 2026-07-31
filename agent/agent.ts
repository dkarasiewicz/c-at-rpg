/**
 * The persistent Dungeon Master (docs/design/run-map-and-dm.md §4).
 *
 * One durable eve session per run: the six stateless `api/gm/*` endpoints
 * collapse into a single agent that remembers the whole adventure. Session
 * memory lives in `lib/memory.ts` (`defineState`, durable across cold starts,
 * redeploys and a player leaving the tab for an hour).
 *
 * The model id is an AI Gateway slug, so the deployment authenticates with its
 * own OIDC token and there is NO provider API key to manage
 * (docs/design/run-map-and-dm.md §4, eve `guides/deployment/vercel`).
 */
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-haiku-4.5",
  limits: {
    // A run is a session. Long enough to survive "I'll finish this tomorrow",
    // short enough that an abandoned tab does not live forever.
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  },
});
