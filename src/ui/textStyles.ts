/**
 * WP-08 — the three TextStyle presets from ui-art.md §3 (system/web-safe
 * fonts only) plus the one BitmapFont install for damage numbers and the
 * battle log line. Every text object in the game uses exactly one preset
 * (size varies).
 */
import { BitmapFont, TextStyle, type TextStyleOptions } from "pixi.js";
import { PAL } from "./palette";

/** DISPLAY — title logo, screen headers, banners, VICTORY/DEFEAT. */
export const FONT_DISPLAY = "'Trebuchet MS', Verdana, sans-serif";
/** UI — buttons, nameplates, tooltips, skill names, event body. */
export const FONT_UI = "Verdana, Geneva, sans-serif";
/** MONO — damage numbers, log line, numerals, status glyphs, seeds. */
export const FONT_MONO = "'Courier New', Courier, monospace";

/**
 * Stroke for any text drawn over the `world` layer (ui-art §3): 4px
 * PAL.void, 3px at sizes ≤ 14. Text on HUD panels gets no stroke.
 */
export const worldStroke = (
  size: number,
): { color: number; width: number } => ({
  color: PAL.void,
  width: size <= 14 ? 3 : 4,
});

/** DISPLAY preset — always bold. Sizes used: 72 / 40 / 32 / 22. */
export function display(size: number, opts: TextStyleOptions = {}): TextStyle {
  return new TextStyle({
    fontFamily: FONT_DISPLAY,
    fontWeight: "bold",
    fontSize: size,
    fill: PAL.text,
    ...opts,
  });
}

/**
 * UI preset — normal weight (pass `{ fontWeight: 'bold' }` for names).
 * Sizes used: 18 / 16 / 14 / 13 / 11.
 */
export function ui(size: number, opts: TextStyleOptions = {}): TextStyle {
  return new TextStyle({
    fontFamily: FONT_UI,
    fontWeight: "normal",
    fontSize: size,
    fill: PAL.text,
    ...opts,
  });
}

/** MONO preset — always bold. Sizes used: 26 / 34 / 22 / 14 / 12 / 11. */
export function mono(size: number, opts: TextStyleOptions = {}): TextStyle {
  return new TextStyle({
    fontFamily: FONT_MONO,
    fontWeight: "bold",
    fontSize: size,
    fill: PAL.text,
    ...opts,
  });
}

/**
 * Family name of the installed bitmap font. Damage numbers and the log line
 * use `BitmapText` with this family (ui-art §1 text-performance rule);
 * everything else is plain `Text`.
 */
export const MONO_BITMAP = "catrpg-mono";

/** Glyph set for the bitmap font: printable ASCII + the game's specials. */
const BITMAP_CHARS =
  " !\"#$%&'()*+,-./0123456789:;<=>?@" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`" +
  "abcdefghijklmnopqrstuvwxyz{|}~" +
  "…✶‹›×≈→←";

let installed = false;

/**
 * Install the MONO BitmapFont once at load (idempotent). White fill so
 * per-instance `tint` colors damage / crit / heal numbers for free; baked
 * 4px void stroke per the world-layer text rule.
 */
export function installFonts(): void {
  if (installed) return;
  installed = true;
  BitmapFont.install({
    name: MONO_BITMAP,
    style: {
      fontFamily: FONT_MONO,
      fontWeight: "bold",
      fontSize: 34, // largest use (crit); smaller sizes scale down
      fill: 0xffffff,
      stroke: { color: PAL.void, width: 4 },
    },
    chars: BITMAP_CHARS,
  });
}
