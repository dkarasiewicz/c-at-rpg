/**
 * THE size contract for painted battle sprites (visual-v2.md "Pipeline" §2).
 *
 * Two problems this solves, both visible in docs/screenshots/battle.png before
 * this pass:
 *
 * 1. **Apparent size was luck.** The generated frames are a character wrapped
 *    in a Stand aura, and the character occupied anywhere from 46% (roomba) to
 *    93% (Rat Prince) of the frame height. Scaling by TEXTURE height therefore
 *    rendered the roomba at half the apparent size of the crow at the same
 *    nominal slot height, and every character small, because most of the frame
 *    was aura.
 * 2. **Sizing across families was per-sprite guesswork.** A rat and a cat could
 *    read the same height.
 *
 * `scripts/trim-sprites.mjs` re-frames every battle sprite so the SUBJECT (the
 * cat/enemy, aura excluded) always spans `[SUBJECT_TOP, SUBJECT_FOOT]` of the
 * frame height and is centred horizontally. Because that is a constant, no
 * per-sprite metadata is needed at runtime: `subjectScale` turns a desired
 * on-screen character height into a sprite scale, and `subjectFeetOffset` puts
 * the character's FEET — not the bottom of its aura — on the ground line.
 *
 * On-screen height itself comes from `UNIT_HEIGHT[grade]`: an explicit
 * small/medium/large/boss scale, so a rat is never as tall as a cat.
 *
 * Draw-layer module: pure numbers + one pixi Sprite helper, no scene state.
 */
import { Sprite, Texture, Rectangle } from "pixi.js";
import type { EnemyLook } from "../../core/types.js";

/* ---------------------------------------------------------------------- */
/* The framing contract (mirrored by scripts/trim-sprites.mjs)             */
/* ---------------------------------------------------------------------- */

/** Subject crown, as a fraction down the normalised frame. */
export const SUBJECT_TOP = 0.3;
/** Subject feet — the ground pivot — as a fraction down the frame. */
export const SUBJECT_FOOT = 0.9;
/** Subject height as a fraction of the frame height. */
export const SUBJECT_SPAN = SUBJECT_FOOT - SUBJECT_TOP;

/**
 * Sprite scale that renders the character (not the aura) `targetH` px tall.
 * Falls back to whole-texture scaling for a texture of implausible size.
 */
export const subjectScale = (texH: number, targetH: number): number =>
  texH > 0 ? targetH / (texH * SUBJECT_SPAN) : 1;

/**
 * y offset for an `anchor.y = 1` sprite placed at the ground line, so the
 * character's feet land on it and the aura's skirt hangs below. Constant
 * fraction of the character height — never per-sprite.
 */
export const subjectFeetOffset = (targetH: number): number =>
  (targetH * (1 - SUBJECT_FOOT)) / SUBJECT_SPAN;

/* ---------------------------------------------------------------------- */
/* The size-grade scale                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Presentation size grades. On-screen CHARACTER height in design px on the
 * 1280×720 stage — the number a player actually perceives, independent of how
 * much aura the art happens to carry.
 */
export type SizeGrade = "small" | "medium" | "large" | "boss";

export const UNIT_HEIGHT: Readonly<Record<SizeGrade, number>> = {
  small: 156, // dust bunny, roomba scout, sewer bat
  medium: 190, // the baseline stray-cat-sized threat
  large: 232, // elites: yarn golem, elder stray
  boss: 306, // must dwarf the party on sight
};

/** Content `look.sizeGrade` → presentation grade (one place, not per sprite). */
const LOOK_TO_GRADE: Readonly<Record<EnemyLook["sizeGrade"], SizeGrade>> = {
  minion: "small",
  standard: "medium",
  elite: "large",
  boss: "boss",
};

export const gradeForLook = (g: EnemyLook["sizeGrade"]): SizeGrade =>
  LOOK_TO_GRADE[g];

/**
 * The party reads a notch above a standard enemy — they are the protagonists
 * and the camera is on their side. Bruno (bruiser) is the big one.
 */
export const CAT_HEIGHT = 198;
export const CAT_BRUISER_HEIGHT = 216;

/* ---------------------------------------------------------------------- */
/* Avatar framing                                                          */
/* ---------------------------------------------------------------------- */

/** Fraction of the subject band a bust crop keeps (head + shoulders). */
const BUST_SPAN = 0.62;

/**
 * Head-and-shoulders crop of a normalised battle texture, cover-fitted into a
 * `size`×`size` box centred on the container origin. Framing a HUD avatar on
 * the whole aura-padded frame is what made the turn-strip chips read as purple
 * smudges; this crops to the character instead.
 *
 * Returns null when the texture is unusable, so callers keep their fallback.
 */
export function makeBustSprite(
  tex: Texture | null,
  size: number,
): Sprite | null {
  if (!tex || tex.width <= 0 || tex.height <= 0) return null;
  const side = Math.min(
    tex.width,
    Math.max(1, tex.height * SUBJECT_SPAN * BUST_SPAN),
  );
  const frame = new Rectangle(
    Math.max(0, (tex.width - side) / 2),
    Math.max(0, tex.height * SUBJECT_TOP),
    Math.min(side, tex.width),
    Math.min(side, tex.height - tex.height * SUBJECT_TOP),
  );
  let cropped: Texture;
  try {
    cropped = new Texture({ source: tex.source, frame });
  } catch {
    cropped = tex; // any frame/source mismatch: fall back to the whole image
  }
  const sp = new Sprite({ texture: cropped, anchor: 0.5 });
  sp.scale.set(size / Math.min(cropped.width, cropped.height));
  return sp;
}
