/**
 * GET /api/gm/health — is the GM actually able to generate?
 *
 * The generating routes are deliberately silent about failures: the client is
 * offline-first and treats any error as "GM unavailable", so a misconfigured
 * deployment looks exactly like a deliberately-offline one. This endpoint is
 * the operator's view — it reports which credential the service resolved and,
 * with `?probe=1`, makes one real (tiny) round-trip through the gateway and
 * returns the underlying error message.
 *
 * It never returns a credential VALUE, only which env var was chosen.
 */
import {
  credentialSource,
  gmModel,
  gmPartyModel,
  probeGeneration,
  GATEWAY_BASE_URL,
} from "../_lib/anthropic.js";
import { json, rateLimit, vercelHandler } from "../_lib/http.js";

export interface GmHealth {
  ok: boolean;
  credentialSource: string;
  baseUrl: string;
  model: string;
  partyModel: string;
  poolBacked: boolean;
  probe?: { ok: boolean; error?: string };
}

export async function buildHealth(
  probe: boolean,
  req?: Request,
): Promise<GmHealth> {
  const source = credentialSource(req);
  const health: GmHealth = {
    ok: source !== "none",
    credentialSource: source,
    baseUrl: process.env.GM_BASE_URL ?? GATEWAY_BASE_URL,
    model: gmModel(),
    partyModel: gmPartyModel(),
    poolBacked: Boolean(process.env.UPSTASH_REDIS_REST_URL),
  };
  if (probe) {
    health.probe = await probeGeneration(req);
    health.ok = health.ok && health.probe.ok;
  }
  return health;
}

export default vercelHandler(async (req) => {
  const limited = rateLimit(req);
  if (limited) return limited;
  const probe = new URL(req.url).searchParams.get("probe") === "1";
  return json(await buildHealth(probe, req));
});
