/**
 * THE RUNTIME ART LOOP — dream a picture, KEEP the picture.
 *
 * Before this file the DM could only ever hand back a *prompt*: `iconPrompt`
 * on a generated item, `visualPrompt` on a Stand. Nothing in the deployed
 * agent turned a prompt into bytes, so `contribute_content`'s re-host path had
 * no URL to re-host and every dreamed thing landed in `catrpg.content` with
 * `art_url = null`. A later player saw the words and no picture.
 *
 * This closes it:
 *
 *   subject ──composeArtPrompt──▶ prompt ──gateway──▶ PNG bytes
 *          ──pool.putArt──▶ public `catrpg-art` URL ──▶ content.art_url + art row
 *
 * Three properties that are not negotiable:
 *
 *  1. **The bytes become ours.** The generator's response is uploaded to the
 *     public bucket and the PUBLIC URL is what gets stored. A generator URL is
 *     not a durable host (roster-and-persistence.md §6); a row pointing at one
 *     is not persisted, it is remembered wrong.
 *  2. **Best-effort, always.** Every failure — no gateway credential, model
 *     error, timeout, unreachable bucket — returns `null`. The contribution
 *     still lands, with its prompt recorded, and the run never notices. The
 *     offline-first invariant is untouched: nothing here is on a path the game
 *     needs.
 *  3. **Style-stamped.** The prompt is composed by `composeArtPrompt` from the
 *     SAME `ART_STYLE` contract the batch pipelines use, and the row records
 *     `ART_STYLE.version`, so runtime art is indistinguishable from shipped
 *     art and a style bump can find it again (`pool.staleArt`).
 *
 * ## Credentials
 *
 * None to manage. The model id is an AI Gateway slug and the deployment
 * authenticates with its own OIDC token, exactly like the DM's language model
 * (`agent/agent.ts`). Locally, `AI_GATEWAY_API_KEY` or a pulled
 * `VERCEL_OIDC_TOKEN` works.
 *
 * ## Switches
 *
 *  - `DM_ART_MODEL`   — gateway image slug. Default `openai/gpt-image-2`,
 *    which is `ART_STYLE.model` on the gateway. Set to `off` to make the DM
 *    prompt-only again (the pre-existing behaviour) without a redeploy of the
 *    game.
 *  - `DM_ART_TIMEOUT_MS` — hard ceiling on one generation. Default 60s.
 */
import { generateImage } from "ai";
import { ART_STYLE, type ArtCategory } from "../../src/content/artStyle.js";
import { composeArtPrompt } from "../../src/services/artPrompt.js";
import type { ArtRow, ContentPool } from "./pool.js";

/**
 * `ART_STYLE.model` / `fallbackModel` are the Masonry CLI's names for the
 * models the shipped batches were drawn with. The runtime path reaches the
 * same models through the AI Gateway, which namespaces them by provider — so
 * the mapping lives here, next to the only code that calls the gateway.
 */
const GATEWAY_SLUG: Record<string, string> = {
  "gpt-image-2": "openai/gpt-image-2",
  "gpt-image-1.5": "openai/gpt-image-1.5",
  "gpt-image-1": "openai/gpt-image-1",
  "gpt-image-1-mini": "openai/gpt-image-1-mini",
  "gemini-3-pro-image-preview": "google/gemini-3-pro-image",
  "gemini-3-pro-image": "google/gemini-3-pro-image",
};

export const DEFAULT_ART_MODEL =
  GATEWAY_SLUG[ART_STYLE.model] ?? "openai/gpt-image-2";

/** `off` / `none` / `0` disables generation; anything else is a gateway slug. */
export function artModel(): string | null {
  const raw = (process.env.DM_ART_MODEL ?? "").trim();
  if (!raw) return DEFAULT_ART_MODEL;
  if (/^(off|none|0|false|disabled)$/i.test(raw)) return null;
  return GATEWAY_SLUG[raw] ?? raw;
}

function timeoutMs(): number {
  const n = Number.parseInt(process.env.DM_ART_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Frame shapes that match what the shipped batches produced: square icons and
 * sprites, letterboxed scenes. `gpt-image-*` only accepts these three.
 */
const SIZE: Record<ArtCategory, `${number}x${number}`> = {
  icon: "1024x1024",
  battleSprite: "1024x1536",
  tile: "1024x1024",
  scene: "1536x1024",
};

/** A picture that now lives in the game's own bucket. */
export interface DreamedArt {
  /** PUBLIC `catrpg-art` URL. Safe to store on a row and to hand a browser. */
  url: string;
  /** The full composed prompt, recorded so the picture can be redrawn. */
  prompt: string;
  model: string;
  key: string;
  bytes: number;
  styleVersion: number;
}

/** Object-path-safe: the bucket key is derived, never taken raw from a model. */
function slug(text: string): string {
  return (
    text
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "unnamed"
  );
}

/**
 * Generate one picture for `subject`, upload it, record it, and return the
 * public URL — or `null` if any step did not work out.
 *
 * `key` is the asset id the `art` table is keyed by (`item:sardineTin`), and
 * the bucket path is derived from it plus the style version, so re-dreaming
 * the same thing under a new style contract does not overwrite the old bytes
 * that older rows still point at.
 */
export async function dreamArt(
  pool: ContentPool,
  opts: {
    key: string;
    category: ArtCategory;
    /** SUBJECT ONLY — what to draw. The house style is appended here. */
    subject: string;
  },
): Promise<DreamedArt | null> {
  const model = artModel();
  if (!model) return null;
  if (!opts.subject.trim()) return null;

  const prompt = composeArtPrompt(opts.category, opts.subject);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs());

  try {
    const result = await generateImage({
      model,
      prompt,
      size: SIZE[opts.category],
      // One retry, not the default two: a DM turn is a player waiting.
      maxRetries: 1,
      abortSignal: controller.signal,
    });
    const bytes = result.image.uint8Array;
    if (bytes.length === 0) return null;

    // The bucket's allowed mime types are png/webp/jpeg (supabase/001_init.sql
    // §storage); anything else would be rejected on upload, so refuse early.
    const mediaType = result.image.mediaType || "image/png";
    if (!/^image\/(png|webp|jpeg)$/.test(mediaType)) return null;
    const ext = mediaType.split("/")[1].replace("jpeg", "jpg");

    const path = `dreamed/${slug(opts.key)}-v${ART_STYLE.version}.${ext}`;
    const url = await pool.putArt(path, bytes, mediaType);
    if (!url) return null; // no bucket ⇒ no durable picture ⇒ no claim of one

    const row: ArtRow = {
      key: opts.key,
      url,
      prompt,
      styleVersion: ART_STYLE.version,
    };
    await pool.putArtRow(row);

    return {
      url,
      prompt,
      model,
      key: opts.key,
      bytes: bytes.length,
      styleVersion: ART_STYLE.version,
    };
  } catch {
    // Gateway down, model refusal, abort, upload failure — all the same to the
    // caller: there is no picture, and the beat carries on without one.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
