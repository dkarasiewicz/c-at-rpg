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
 * CORS. Narrowed to the game's origins, configurable per deployment with
 * `DM_ALLOWED_ORIGINS` (comma-separated) so previews can be added without a
 * code change.
 */
import { eveChannel } from "eve/channels/eve";
import { localDev, none, vercelOidc } from "eve/channels/auth";

/**
 * Origins the game is served from. Override per environment.
 *
 * The local entries cover a RANGE because Vite hops to the next free port when
 * 5173 is taken — two dev servers, or a stray one from an earlier session, and
 * the game lands on 5174 with no warning. The DM then fails CORS on the
 * reachability probe, and because this game is offline-first that failure is
 * indistinguishable from "no DM configured": the typed-action UI simply is not
 * built, and party generation silently falls back to the Strays. It cost a
 * debugging session to notice, and localhost was already trusted, so the extra
 * ports change nothing about who can reach this deployment.
 */
const DEV_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179];
const DEFAULT_ORIGINS = [
  "https://c-at-rpg.vercel.app",
  ...DEV_PORTS.flatMap((p) => [
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
  ]),
];

function allowedOrigins(): string[] {
  const configured = process.env.DM_ALLOWED_ORIGINS;
  if (!configured) return DEFAULT_ORIGINS;
  const list = configured
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return list.length > 0 ? list : DEFAULT_ORIGINS;
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
