/**
 * Prompt composition against the versioned art style contract
 * (src/content/artStyle.ts, visual-v2.md §Style contract).
 *
 * Every visualPrompt/iconPrompt the DM authors is composed here from
 * ART_STYLE.basePrompt + the category framing — nothing hand-writes style
 * wording, so runtime art matches the pregenerated batches. Models generate
 * SUBJECT-ONLY descriptions; the house style is appended.
 *
 * Lived in `api/_lib/artPrompt.ts` while the `api/gm/*` endpoints composed it
 * server-side; the DM one-shots return subjects and the browser composes.
 */
import { ART_STYLE, type ArtCategory } from "../content/artStyle.js";

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
