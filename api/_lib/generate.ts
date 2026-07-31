/**
 * Generate → lint → regenerate-once pipeline (gm-system.md: "server-side
 * lint rejects and regenerates once").
 *
 * The model client is injected behind `StructuredGenClient` so handlers are
 * unit-testable with a fake (no real API calls); the production impl lives
 * in api/_lib/anthropic.ts.
 */

export interface StructuredGenClient {
  /** Returns the raw JSON text of a structured-outputs completion. */
  generate(opts: {
    model: string;
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<string>;
}

/** Lint result: `value` present iff `errors` is empty. */
export interface LintResult<T> {
  value?: T;
  errors: string[];
}

export class GmGenerationError extends Error {
  constructor(
    message: string,
    public readonly lintErrors: string[],
  ) {
    super(message);
    this.name = "GmGenerationError";
  }
}

function parseJson(text: string): { parsed?: unknown } {
  try {
    return { parsed: JSON.parse(text) as unknown };
  } catch {
    return {};
  }
}

function parseAndLint<T>(
  text: string,
  lint: (parsed: unknown) => LintResult<T>,
): LintResult<T> & { parsed?: unknown } {
  const { parsed } = parseJson(text);
  if (parsed === undefined) {
    return { errors: ["response is not valid JSON"] };
  }
  return { ...lint(parsed), parsed };
}

/**
 * One generation with ONE regenerate-on-invalid retry: the second attempt
 * gets the first output plus the exact constraint violations to fix. Throws
 * `GmGenerationError` when both attempts fail the lint — unless an optional
 * `salvage` hook can repair the second (parsed) output into a valid value
 * (e.g. /api/gm/party swapping a twice-invalid Power Script for a stock one).
 */
export async function generateValidated<T>(
  gen: StructuredGenClient,
  opts: {
    model: string;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    lint: (parsed: unknown) => LintResult<T>;
    maxTokens?: number;
    /** Last-resort repair of the second attempt's parsed JSON. */
    salvage?: (parsed: unknown) => T | undefined;
  },
): Promise<T> {
  const first = await gen.generate({
    model: opts.model,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    schema: opts.schema,
    maxTokens: opts.maxTokens,
  });
  const firstResult = parseAndLint(first, opts.lint);
  if (firstResult.errors.length === 0 && firstResult.value !== undefined) {
    return firstResult.value;
  }

  const retryNote =
    "Your previous output violated these HARD mechanical constraints:\n" +
    firstResult.errors.map((e) => `- ${e}`).join("\n") +
    "\nRegenerate the COMPLETE JSON object, fixing every violation. " +
    "Change only what the violations require.";
  const second = await gen.generate({
    model: opts.model,
    system: opts.system,
    messages: [
      { role: "user", content: opts.user },
      { role: "assistant", content: first },
      { role: "user", content: retryNote },
    ],
    schema: opts.schema,
    maxTokens: opts.maxTokens,
  });
  const secondResult = parseAndLint(second, opts.lint);
  if (secondResult.errors.length === 0 && secondResult.value !== undefined) {
    return secondResult.value;
  }
  if (opts.salvage && secondResult.parsed !== undefined) {
    const repaired = opts.salvage(secondResult.parsed);
    if (repaired !== undefined) return repaired;
  }
  throw new GmGenerationError(
    "generation failed constraint lint twice",
    secondResult.errors,
  );
}
