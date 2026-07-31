/**
 * WP-10 (visual v3) — the exploration screen's composition grid.
 *
 * `R.explore` (ui-art §7) describes the ORIGINAL full-bleed layout, where the
 * world filled the top 1280×632 and the minimap floated over it in a corner.
 * The rebuilt screen is framed instead: a bordered viewport on the left, a
 * docked map/legend column on the right, a header rail on top and the party
 * strip along the bottom. Those rects live here (this file is owned by the
 * explore package) so `ui/layout.ts` — shared by every other screen — stays
 * untouched.
 *
 * Everything is in 1280×720 design pixels, [x, y, w, h], same convention as
 * `ui/layout.ts`, and consumed through the same `rx/ry/rw/rh` accessors.
 */
import { R, type Rect } from "../layout.js";

/** World tile size in world-space px (unchanged: ui-art §7 tile recipe). */
export const TILE: number = R.explore.tileSize;

/**
 * Camera zoom applied to the world container. A modest bump so a 48px tile
 * reads at ~55px inside the framed viewport (≈17×10 tiles on screen) instead
 * of the old thumbnail-sized grid.
 */
export const ZOOM = 1.15;

/**
 * How many tiles of rock/fog are generated beyond the floor rect. The camera
 * is clamped to the floor rect, so the viewport can never actually reach the
 * bleed — it exists only so the frame edges never reveal the end of the field
 * (and it is kept small: every extra ring is full-screen blend work).
 */
export const FOG_BLEED = 4;

export const EX = {
  /** Top rail: floor name + seed + key hints. */
  header: [16, 12, 1248, 30] as Rect,
  /** The framed play area (world is masked to this rect). */
  viewport: [16, 50, 960, 570] as Rect,
  /** Docked minimap panel (header + map + camera rect). */
  minimap: [992, 50, 272, 306] as Rect,
  /** Legend + floor objective panel under the minimap. */
  legend: [992, 366, 272, 254] as Rect,
  /** Bottom party bar (full bleed). */
  strip: [0, 628, 1280, 92] as Rect,
  /** The four cat cards inside the strip. */
  cards: [
    [16, 638, 244, 74],
    [270, 638, 244, 74],
    [524, 638, 244, 74],
    [778, 638, 244, 74],
  ] as Rect[],
  /** Shinies chip (right end of the strip). */
  goldChip: [1036, 638, 228, 30] as Rect,
  /** Consumable belt under the shinies chip. */
  belt: [1036, 672, 228, 34] as Rect,
  /** Toast, centered inside the viewport near its bottom edge. */
  toast: [216, 548, 560, 44] as Rect,
  /** Full-screen [M] map panel. */
  bigMap: [120, 44, 1040, 632] as Rect,
} as const;

/** Marching-order panel geometry (centered on the viewport, not the screen). */
export const MARCH_PANEL = { w: 440, rowH: 54 } as const;
