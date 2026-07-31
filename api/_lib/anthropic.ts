/**
 * Anthropic SDK wrapper for the GM functions, routed through Vercel AI Gateway.
 *
 * Official @anthropic-ai/sdk only (never an OpenAI-compat shim). The gateway
 * implements the Anthropic Messages API spec, so this stays a plain Anthropic
 * client with a different `baseURL` — no adapter layer, and all generation
 * keeps using STRUCTURED OUTPUTS (`output_config.format` json_schema, GA on
 * the gateway) for guaranteed-valid JSON against each endpoint's hand-written
 * schema. No parse/repair layer.
 *
 * Auth (docs/GM-DEPLOY.md): `AI_GATEWAY_API_KEY` if set, else the
 * `VERCEL_OIDC_TOKEN` that Vercel injects into every deployment — which means
 * a deployed GM needs NO provider secret at all. `ANTHROPIC_API_KEY` is still
 * honoured as a last resort so the functions can be pointed straight at
 * api.anthropic.com (set GM_BASE_URL) for local debugging.
 *
 * Model ids are config, not code, and are GATEWAY slugs (`provider/model`,
 * dotted minor versions — `anthropic/claude-haiku-4.5`, NOT the direct-API
 * `claude-haiku-4-5`):
 *   GM_MODEL        (default anthropic/claude-haiku-4.5) — events, items, steering
 *   GM_PARTY_MODEL  (default anthropic/claude-sonnet-5)  — run-start party generation
 */
import Anthropic from "@anthropic-ai/sdk";
import type { StructuredGenClient } from "./generate.js";

/** Vercel AI Gateway's Anthropic-compatible base URL. */
export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

export function gmModel(): string {
  return process.env.GM_MODEL ?? "anthropic/claude-haiku-4.5";
}

export function gmPartyModel(): string {
  return process.env.GM_PARTY_MODEL ?? "anthropic/claude-sonnet-5";
}

/**
 * Gateway key, deployment OIDC token, or a direct Anthropic key.
 *
 * The OIDC path has a sharp edge worth spelling out: in a DEPLOYED function
 * Vercel does NOT set `VERCEL_OIDC_TOKEN` in the environment — it puts the
 * token on the `x-vercel-oidc-token` header of each incoming Request
 * (https://vercel.com/docs/oidc "In Vercel Functions"). The env var only
 * exists at build time and locally after `vercel env pull`. Resolving the
 * credential therefore needs the request, and the credential can change
 * between invocations (the token is rotated roughly every 45 minutes), which
 * is why the client below is cached per-credential rather than once per
 * process.
 */
export function gmApiKey(req?: Request): string | undefined {
  return (
    process.env.AI_GATEWAY_API_KEY ??
    req?.headers.get("x-vercel-oidc-token") ??
    process.env.VERCEL_OIDC_TOKEN ??
    process.env.ANTHROPIC_API_KEY ??
    undefined
  );
}

function gmBaseUrl(): string {
  return process.env.GM_BASE_URL ?? GATEWAY_BASE_URL;
}

const MAX_TOKENS = 2000;

class AnthropicGenClient implements StructuredGenClient {
  private readonly client: Anthropic;

  constructor(credential: string | undefined) {
    this.client = new Anthropic({
      apiKey: credential,
      baseURL: gmBaseUrl(),
    });
  }

  async generate(opts: {
    model: string;
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<string> {
    const response = await this.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? MAX_TOKENS,
      system: opts.system,
      messages: opts.messages,
      output_config: {
        format: { type: "json_schema", schema: opts.schema },
      },
    });
    if (response.stop_reason === "refusal") {
      throw new Error("model refused the request");
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text) throw new Error("no text block in model response");
    return text.text;
  }
}

/**
 * Clients keyed by credential. The OIDC token rotates, so a single
 * process-wide client would pin a token that eventually expires; keying by
 * credential keeps warm instances reusing a client while still picking up a
 * rotated token. Bounded to a couple of entries in practice.
 */
const clients = new Map<string, StructuredGenClient>();

/**
 * The generation client for THIS request. Pass the request so the deployed
 * OIDC token (an `x-vercel-oidc-token` header, see `gmApiKey`) is found;
 * omitting it falls back to environment credentials only.
 */
export function getAnthropicGen(req?: Request): StructuredGenClient {
  const credential = gmApiKey(req);
  const key = credential ?? "none";
  let client = clients.get(key);
  if (!client) {
    client = new AnthropicGenClient(credential);
    if (clients.size > 4) clients.clear(); // rotation, not a cache to grow
    clients.set(key, client);
  }
  return client;
}

/** Which credential was chosen — for /api/gm/health, never the value. */
export function credentialSource(req?: Request): string {
  if (process.env.AI_GATEWAY_API_KEY) return "AI_GATEWAY_API_KEY";
  if (req?.headers.get("x-vercel-oidc-token")) return "oidc-header";
  if (process.env.VERCEL_OIDC_TOKEN) return "VERCEL_OIDC_TOKEN";
  if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  return "none";
}

/**
 * One live round-trip through the configured gateway/model, returning the
 * error MESSAGE rather than throwing. Used only by the health endpoint: the
 * generating routes deliberately swallow failures (offline-first), which makes
 * a misconfigured deployment otherwise invisible.
 */
export async function probeGeneration(req?: Request): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    await getAnthropicGen(req).generate({
      model: gmModel(),
      system: "You reply with JSON.",
      messages: [{ role: "user", content: "Say ok." }],
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      maxTokens: 32,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
}
