/**
 * ART STYLE CONTRACT — docs/design/visual-v2.md §"Style contract".
 *
 * One versioned source of truth consumed by BOTH the pregeneration batches
 * (sprite-generation skill / Masonry CLI) and the runtime GM service, so
 * on-the-fly art is indistinguishable from shipped art.
 *
 * Content-layer purity: plain data only — no imports, no functions, no I/O.
 * Prompt composition lives in src/services/artPrompt.ts.
 *
 * Every generated asset (build-time or runtime) records `styleVersion` in its
 * manifest/pool row; bumping the style bible bumps `version` here so the pool
 * can filter or lazily regenerate stale-style art instead of mixing styles.
 */

/** Framing categories — one camera/lighting paragraph per asset class. */
export type ArtCategory = "battleSprite" | "icon" | "tile" | "scene";

export interface ArtStyleContract {
  /** Bump when the style bible changes; recorded on every generated asset. */
  version: number;
  /** The exact cel-shading paragraph appended to every prompt in this repo. */
  basePrompt: string;
  /** Comma-separated negatives (appended as an "Avoid:" clause). */
  negative: string;
  /** Named palette hexes (mirrors src/ui/palette.ts core values). */
  palette: Readonly<Record<string, string>>;
  /** Primary generator — best anchor-faithful edits/layout obedience. */
  model: string;
  /** Fallback generator — best original character fidelity. */
  fallbackModel: string;
  /**
   * Deployed copy of docs/art/style-anchor-bruno.png (served from the site's
   * own public/ root) so the server-side generator can pass it as a
   * reference image.
   */
  anchorUrl: string;
  /** Per-category framing prompts (camera, staging, lighting). */
  framing: Readonly<Record<ArtCategory, string>>;
}

export const ART_STYLE: ArtStyleContract = {
  version: 1,

  // The canonical cel-shading paragraph (visual-v2.md "Art style bible") used
  // by the batch pipelines for every shipped asset under public/assets/gen/.
  basePrompt:
    "Anime cel-shading with bold ink outlines, dramatic rim light, gritty " +
    "90s OVA flavor, subtle menacing-aura sparks. Stands are translucent " +
    "purple-and-gold spectral energy; mortal subjects are solid and crisp. " +
    "Rich saturated color on a flat #1a1626 background for clean keying. " +
    "NOT chibi, NOT pixel art, NOT flat vector.",

  negative:
    "chibi, pixel art, flat vector art, photorealism, 3D render, soft " +
    "airbrush shading, gradient background, watermark, signature, text, " +
    "caption, frame, border, blurry",

  palette: {
    background: "#1a1626", // PAL.bgDeep — flat keying background of every asset
    ink: "#0e0c16", // PAL.void — outline / letterbox black
    gold: "#f5c84c", // PAL.gold — Stand energy highlight, attention accent
    goldDark: "#b98a1f", // PAL.goldDark — pressed gold, gold outlines
    standPurple: "#a98bd6", // translucent Stand body energy
    standPurpleDeep: "#6e549c", // Stand shadow/core energy
    text: "#f2ede4", // warm off-white
    danger: "#e5484d", // damage red
    energy: "#3fc1c9", // cat energy teal
  },

  model: "gpt-image-2",
  fallbackModel: "gemini-3-pro-image-preview",

  anchorUrl: "/art/style-anchor-bruno.png",

  framing: {
    battleSprite:
      "Full-body battle sprite of a single character: the cat solid and " +
      "crisp in the foreground, its Stand a translucent purple/gold figure " +
      "looming behind it. Dramatic three-quarter pose, whole silhouette in " +
      "frame, centered on a flat #1a1626 background.",
    icon:
      "Small item icon: one object, centered, filling most of the frame, " +
      "readable at 64 pixels, bold ink outline, cel shading, slight " +
      "dramatic rim light, flat #1a1626 background, no text.",
    tile:
      "Square dungeon tile texture seen top-down, drawn edge to edge with " +
      "seamless-friendly borders, muted low-contrast values so sprites " +
      "read on top, bold ink accents, no characters, no text.",
    scene:
      "Wide cinematic event illustration, dramatic staging and rim light, " +
      "cel-shaded painterly background, characters small in the frame, " +
      "letterbox-friendly composition.",
  },
};
