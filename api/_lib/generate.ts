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

function parseAndLint<T>(
  text: string,
  lint: (parsed: unknown) => LintResult<T>,
): LintResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ["response is not valid JSON"] };
  }
  return lint(parsed);
}

/**
 * One generation with ONE regenerate-on-invalid retry: the second attempt
 * gets the first output plus the exact constraint violations to fix. Throws
 * `GmGenerationError` when both attempts fail the lint.
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
  throw new GmGenerationError(
    "generation failed constraint lint twice",
    secondResult.errors,
  );
}
