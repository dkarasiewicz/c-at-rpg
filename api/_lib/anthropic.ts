/**
 * Anthropic SDK wrapper for the GM functions.
 *
 * Official @anthropic-ai/sdk only (never an OpenAI-compat shim). All
 * generation uses STRUCTURED OUTPUTS (`output_config.format` json_schema) so
 * responses are guaranteed-valid JSON against the hand-written schemas in
 * each endpoint — no parse/repair layer.
 *
 * Model ids are config, not code:
 *   GM_MODEL        (default claude-haiku-4-5)  — events, items, steering
 *   GM_PARTY_MODEL  (default claude-sonnet-5)   — run-start party generation
 */
import Anthropic from "@anthropic-ai/sdk";
import type { StructuredGenClient } from "./generate";

export function gmModel(): string {
  return process.env.GM_MODEL ?? "claude-haiku-4-5";
}

export function gmPartyModel(): string {
  return process.env.GM_PARTY_MODEL ?? "claude-sonnet-5";
}

const MAX_TOKENS = 2000;

class AnthropicGenClient implements StructuredGenClient {
  private readonly client: Anthropic;

  constructor() {
    // Reads ANTHROPIC_API_KEY from the environment (Vercel env var).
    this.client = new Anthropic();
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

/** Lazily constructed so importing a handler never requires an API key. */
export function getAnthropicGen(): StructuredGenClient {
  defaultGen ??= new AnthropicGenClient();
  return defaultGen;
}
