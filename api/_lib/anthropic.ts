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

/** Gateway key, deployment OIDC token, or a direct Anthropic key. */
export function gmApiKey(): string | undefined {
  return (
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_OIDC_TOKEN ??
    process.env.ANTHROPIC_API_KEY
  );
}

function gmBaseUrl(): string {
  return process.env.GM_BASE_URL ?? GATEWAY_BASE_URL;
}

const MAX_TOKENS = 2000;

class AnthropicGenClient implements StructuredGenClient {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: gmApiKey(),
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

let defaultGen: StructuredGenClient | null = null;

/** Lazily constructed so importing a handler never requires credentials. */
export function getAnthropicGen(): StructuredGenClient {
  defaultGen ??= new AnthropicGenClient();
  return defaultGen;
}

/** Which credential the client will use — for /api/gm/health, never the value. */
export function credentialSource(): string {
  if (process.env.AI_GATEWAY_API_KEY) return "AI_GATEWAY_API_KEY";
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
export async function probeGeneration(): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    await getAnthropicGen().generate({
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
