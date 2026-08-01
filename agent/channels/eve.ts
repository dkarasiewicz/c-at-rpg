/**
 * The DM's HTTP surface (docs/design/run-map-and-dm.md §4 "channels/eve.ts:
 * CORS to the game origin, auth").
 *
 * Routes mounted by `eveChannel()` (eve `channels/eve`):
 *   GET  /eve/v1/health
 *   GET  /eve/v1/info
 *   POST /eve/v1/session                        start a run
 *   POST /eve/v1/session/:sessionId             a beat in that run
 *   POST /eve/v1/session/:sessionId/cancel      abandon the in-flight turn
 *   GET  /eve/v1/session/:sessionId/stream      NDJSON event stream
 *
 * AUTH. The caller is a browser running a single-player game with no accounts
 * and no user data — there is no credential to present and nothing to
 * impersonate. So the policy is `[vercelOidc(), localDev(), none()]`: real
 * principals for the eve CLI and for other deployments on the team, anonymous
 * for everyone else. `none()` is deliberate and terminal (it halts the auth
 * walk); the eve scaffold's `placeholderAuth()` would 401 every browser in
 * production, which is exactly the wrong failure for this app — the game is
 * offline-first, so a 401 does not break it, it just silently removes the DM.
 *
 * If the DM ever costs real money per player or touches anything worth
 * protecting, swap `none()` for a real `AuthFn` (see eve
 * `guides/auth-and-route-protection`) and keep the ordering.
 *
 * CORS. Narrowed to the game's origins: `DEFAULT_ORIGINS` below, PLUS
 * whatever `DM_ALLOWED_ORIGINS` adds, so previews can be allowed without a
 * code change. The env var is ADDITIVE — see `allowedOrigins()`.
 */
import { eveChannel } from "eve/channels/eve";
import { localDev, none, vercelOidc } from "eve/channels/auth";

/**
 * Local dev ports, as a RANGE, because Vite hops to the next free port when
 * its configured one is taken — two dev servers, or a stray one from an
 * earlier session, and the game lands one port over with no warning. The DM
 * then fails CORS on the reachability probe, and because this game is
 * offline-first that failure is indistinguishable from "no DM configured":
 * the typed-action UI simply is not built, and party generation silently
 * falls back to the Strays. It cost a debugging session to notice, and
 * localhost was already trusted, so the extra ports change nothing about who
 * can reach this deployment.
 *
 * **8080 is the one that matters.** `vite.config.ts` sets `server.port: 8080`
 * — this project has never served the game on Vite's own 5173 default, so the
 * 5173-5179 range this list used to hold could not match a single real dev
 * session. (Checked while writing this: with 8080-8082 already occupied, the
 * dev server came up on 8083.) The 5173 and 4173 rows are kept because they
 * cost nothing and cover a bare `vite` / `vite preview` run that ignores the
 * config.
 */
const range = (lo: number, hi: number): number[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const DEV_PORTS = [
  ...range(8080, 8089), // vite.config.ts server.port, + hops
  ...range(5173, 5176), // vite's own default, if the config ever goes
  ...range(4173, 4174), // vite preview
];
const DEFAULT_ORIGINS = [
  // The deployed game. Both names are live: `-three` is what Vercel assigned
  // the project, the bare name is the alias. A player can arrive on either.
  "https://c-at-rpg-three.vercel.app",
  "https://c-at-rpg.vercel.app",
  ...DEV_PORTS.flatMap((p) => [
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
  ]),
];

/**
 * `DEFAULT_ORIGINS` ∪ `DM_ALLOWED_ORIGINS`.
 *
 * ADDITIVE, not an override, and that is the whole point of this function.
 * The env var IS set on the DM's Vercel project, so while it replaced the
 * defaults it silently deleted the port range above: a preflight from
 * `http://localhost:5174` came back 204 with no `access-control-allow-origin`,
 * the game read that as "no DM", and the dead-code comment about Vite hopping
 * ports described a fix that had not applied in production since the variable
 * was first set. Union means a deployment can only ADD origins — the local
 * dev range and the deployed game can never be configured away by accident.
 *
 * To REMOVE an origin, remove it from `DEFAULT_ORIGINS` here. That is
 * deliberate: shrinking who may talk to the DM should be a reviewed change,
 * not a dashboard edit.
 */
function allowedOrigins(): string[] {
  const extra = (process.env.DM_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return [...new Set([...DEFAULT_ORIGINS, ...extra])];
}

export default eveChannel({
  auth: [vercelOidc(), localDev(), none()],
  cors: {
    origin: allowedOrigins(),
    methods: ["GET", "POST"],
    allowedHeaders: ["authorization", "content-type"],
    maxAge: 600,
  },
});
