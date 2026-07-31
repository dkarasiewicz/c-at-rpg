/**
 * Server-side prompt composition against the versioned art style contract
 * (src/content/artStyle.ts, visual-v2.md §Style contract).
 *
 * Every visualPrompt/iconPrompt the GM endpoints return is built here from
 * ART_STYLE.basePrompt + the category framing — endpoints never hand-write
 * style wording, so runtime art matches the pregenerated batches. Models
 * generate SUBJECT-ONLY descriptions; the house style is appended.
 */
import { ART_STYLE, type ArtCategory } from "../../src/content/artStyle";

/** `subject` is a style-free description of WHAT to draw. */
export function composeArtPrompt(
  category: ArtCategory,
  subject: string,
): string {
  const trimmed = subject.trim().replace(/[.\s]+$/, "");
  return (
    `${trimmed}. ${ART_STYLE.framing[category]} ${ART_STYLE.basePrompt} ` +
    `Avoid: ${ART_STYLE.negative}.`
  );
}
