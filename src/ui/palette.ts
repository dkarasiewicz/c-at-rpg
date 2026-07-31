/**
 * WP-08 — PAL + THEMES: the single source of truth for every color in the
 * game, verbatim from ui-art.md §2 ("Midnight Picture-Book"). If a hex value
 * is here, it is the value; nothing else in src/ui may hardcode a color.
 */

export const PAL = {
  // ---- chrome ----
  void: 0x0e0c16, // letterbox / outside world
  bgDeep: 0x1a1626, // screen background
  panel: 0x262038, // HUD panel fill
  panelLite: 0x322a4a, // hovered / raised panel
  border: 0x4a3f66, // default 2px panel border
  gold: 0xf5c84c, // ACTIVE / attention accent — see pillar 3
  goldDark: 0xb98a1f, // pressed gold, gold outlines
  text: 0xf2ede4, // primary text (warm off-white)
  textDim: 0x9c93b0, // secondary text, disabled labels
  textDark: 0x1a1626, // text on gold chips
  danger: 0xe5484d, // damage numbers, HP-low, Scatter!, KO, telegraphed ranks
  heal: 0x5fd068, // heal numbers, full-HP bar, Mending
  warnYel: 0xf5c84c, // mid-HP bar (same value as gold)
  energy: 0x3fc1c9, // Energy pips/bar (cats)
  crit: 0xffe066, // crit damage numbers
  offBal: 0xff9f43, // Off-Balance markers, wobble stars, "OFF-BALANCE!" tag
  hpBack: 0x241f33, // empty bar track
  scrim: 0x000000, // modal scrim, drawn at alpha 0.6

  // ---- 4 cat classes (body / accent / belly / outline / eye) ----
  bruiser: {
    body: 0xe8853b,
    accent: 0xb35f1f,
    belly: 0xf7c08a,
    outline: 0x5c3212,
    eye: 0x5fd068,
  }, // Bruno: orange tabby
  trickster: {
    body: 0x33303f,
    accent: 0x4a4560,
    belly: 0x55506b,
    outline: 0xa9a3bc,
    eye: 0xffe066,
  }, // Pixel: soot-black (light outline: dark cat, dark bg)
  hexer: {
    body: 0xa98bd6,
    accent: 0x6e549c,
    belly: 0xd6c7f0,
    outline: 0x4a3670,
    eye: 0x3fc1c9,
  }, // Mora: dusk-purple
  medic: {
    body: 0xf2e3c6,
    accent: 0xd9a066,
    belly: 0xfbf3e0,
    outline: 0x8a6a3f,
    eye: 0x7ec8e3,
  }, // Baguette: warm cream
  earInner: 0xe8a0a8, // shared pink
  nosePink: 0xd97b8a,

  // ---- enemy families (base / accent / outline / eye) ----
  vermin: {
    base: 0x8a7264,
    accent: 0xb09484,
    outline: 0x3e3028,
    eye: 0xe5484d,
  }, // rats, mice
  bird: { base: 0x4a4658, accent: 0x8f86b5, outline: 0x201c2c, eye: 0xffb84c }, // crows, pigeons; beak PAL.gold
  beast: { base: 0x7a5c43, accent: 0xa8846a, outline: 0x38281c, eye: 0xf5c84c }, // hounds, possums
  construct: {
    base: 0xb0483e,
    accent: 0xc8c4d4,
    outline: 0x4e1e1a,
    eye: 0xc8f03c,
  }, // vacuums, appliances

  // ---- enemy tier & rank markers ----
  tier1: 0x9c93b0, // floors 1-2 nameplate chevron (plum-gray)
  tier2: 0x5fa06a, // floors 3-4 chevron (sewer moss)
  tier3: 0xe5484d, // floors 5-6 chevron (ember)
  eliteRing: 0xf5c84c, // elites & bosses: gold ground-ring; boss adds pulsing outline

  // ---- the six statuses (chip fill; glyph is PAL.text, chip outline = darkened fill) ----
  stScratched: 0xe5484d, // glyph '/'  (bleed)
  stFrazzled: 0xa855f7, // glyph 'z'  (stun)
  stOffBal: 0xff9f43, // glyph '!'  (take +50%)
  stGuarded: 0x5b7a9a, // glyph 'O'  (take -50%)
  stProvoked: 0xd9744f, // glyph '>'  (must target provoker)
  stMending: 0x5fd068, // glyph '+'  (regen)

  // ---- shared chrome kit (widgets.ts panel/bar/avatar/backdrop) ----
  // Derived chrome tones, not new art colors: they only ever appear at low
  // alpha as lighting on top of the §2 fills above.
  sheen: 0xffffff, // inner top highlight on panels, bars, buttons
  shadow: 0x07060d, // soft drop shadow under panels/buttons/avatars
  glass: 0x1d1830, // translucent fill for the 'glass' panel variant
  xp: 0x7f6bd6, // XP bar fill (dusk violet — distinct from Energy cyan)
} as const;

/** Dungeon tile themes, keyed by enemy tier (floors 1-2 / 3-4 / 5-6). */
export const THEMES = [
  {
    name: "Cellars",
    floorA: 0x2e2a3e,
    floorB: 0x332e45,
    wallFace: 0x201b30,
    wallTop: 0x4a3f66,
    accent: 0x8a9a5b,
  },
  {
    name: "Sewers",
    floorA: 0x263636,
    floorB: 0x2b3d3b,
    wallFace: 0x1b2a2a,
    wallTop: 0x3f6660,
    accent: 0x3fc1c9,
  },
  {
    name: "Ember Depths",
    floorA: 0x3a2a2a,
    floorB: 0x403030,
    wallFace: 0x2a1b1b,
    wallTop: 0x66463f,
    accent: 0xe8853b,
  },
] as const;

/** Chest wood color (ui-art §7 tile recipe + minimap). */
export const CHEST_WOOD = 0xc98a3d;

/** Minimap visible-floor fill (ui-art §7). */
export const MINIMAP_VISIBLE = 0x6e6188;

/** KO greyscale fills (ui-art §4): body / accents. */
export const KO_GREY = { body: 0x55506b, accent: 0x9c93b0 } as const;

/** Trickster bandana / 'scarf' prop outline (ui-art §4 class marker table). */
export const BANDANA_OUTLINE = 0x8a2b2e;

/**
 * Multiply each RGB channel of `color` by `f` — used for "outline in a darker
 * shade of its own fill" (art pillar 1) on chips and bars.
 */
export function darken(color: number, f = 0.55): number {
  const r = Math.round(((color >> 16) & 0xff) * f);
  const g = Math.round(((color >> 8) & 0xff) * f);
  const b = Math.round((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

/**
 * Linear RGB blend of two palette colors — `t` 0 returns `a`, 1 returns `b`.
 * Used by the shared chrome kit for hover tints and gradient washes so no
 * screen has to invent an in-between color.
 */
export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const ch = (shift: number): number => {
    const av = (a >> shift) & 0xff;
    const bv = (b >> shift) & 0xff;
    return Math.round(av + (bv - av) * k);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * HP bar fill by fraction (ui-art §2): > 0.5 heal, 0.25–0.5 warn, < 0.25
 * danger.
 */
export function hpColor(frac: number): number {
  if (frac > 0.5) return PAL.heal;
  if (frac >= 0.25) return PAL.warnYel;
  return PAL.danger;
}
