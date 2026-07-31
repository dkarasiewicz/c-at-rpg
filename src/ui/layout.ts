/**
 * WP-08 — every screen rectangle from ui-art.md §§7-11, at the 1280×720
 * design resolution. All rects are [x, y, w, h] in design pixels. Corner
 * radius conventions (ui-art §1): 8 panels, 6 buttons, 4 chips.
 */

export type Rect = [x: number, y: number, w: number, h: number];

/** Design resolution (ui-art §1). */
export const DESIGN_W = 1280;
export const DESIGN_H = 720;

/** Corner radii (ui-art §1) + the shared chrome kit's avatar/bar radii. */
export const RADIUS = {
  panel: 8,
  button: 6,
  chip: 4,
  avatar: 12,
  bar: 3,
} as const;

/**
 * The ONE spacing scale for the shared chrome kit: panel padding, gaps
 * between widgets, rows in a stack. Screens should reach for these instead
 * of ad-hoc numbers so gutters line up across scenes.
 */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 20, xl: 32 } as const;

export const R = {
  /* ---- §7 Exploration screen -------------------------------------- */
  explore: {
    viewport: [0, 0, 1280, 632] as Rect, // world layer; tiles 48×48, camera on party
    floorChip: [12, 12, 232, 36] as Rect, // "Floor 2 — Cellars" UI-14 + theme accent dot
    seedChip: [12, 52, 232, 22] as Rect, // "seed 8F3A21C9" MONO-11 PAL.textDim
    minimap: [1080, 12, 188, 140] as Rect, // panel; map centered inside at 4px/tile
    partyStrip: [0, 632, 1280, 88] as Rect, // bottom HUD panel (square corners, full-bleed)
    catCards: [
      [16, 644, 244, 68],
      [272, 644, 244, 68],
      [528, 644, 244, 68],
      [784, 644, 244, 68],
    ] as Rect[],
    goldChip: [1044, 644, 220, 30] as Rect, // coin + "128g" UI-14
    itemChips: [1044, 680, 220, 26] as Rect, // consumable glyph chips ×N
    toast: [340, 560, 600, 48] as Rect, // centered toast, auto-hide 2.5s
    tileSize: 48,
  },

  /* ---- §8 Combat screen -------------------------------------------- */
  combat: {
    ribbon: [160, 8, 960, 60] as Rect, // initiative timeline (frozen per round)
    roundChip: [24, 16, 120, 32] as Rect, // "ROUND 3" UI-14 bold
    fleeChip: [1136, 16, 120, 32] as Rect, // "R Scatter!" chip; hidden in boss fights
    battlefield: [0, 84, 1280, 440] as Rect, // world layer; ground line y = 460
    groundY: 460,
    // rank slot centers on the ground line (x positions; unit feet sit here):
    catSlots: { 1: 544, 2: 440, 3: 336, 4: 232 } as Record<number, number>,
    enemySlots: {
      1: 736,
      2: 840,
      3: 944,
      4: 1048,
      5: 1152,
    } as Record<number, number>,
    logLine: [16, 540, 1248, 26] as Rect, // latest event, MONO-14
    logScrollback: [16, 300, 560, 236] as Rect, // click or L opens; last 40 events
    skillBar: [16, 576, 824, 128] as Rect, // 6 slots
    slotRects: [
      [24, 584, 128, 112],
      [160, 584, 128, 112],
      [296, 584, 128, 112],
      [432, 584, 128, 112],
      [568, 584, 128, 112],
      [704, 584, 128, 112],
    ] as Rect[],
    activePanel: [856, 576, 408, 128] as Rect, // active cat readout
    catPileBanner: [340, 260, 600, 140] as Rect, // "CAT PILE?!" DISPLAY-40
  },

  /* ---- §9 Event dialog (modal over exploration) --------------------- */
  event: {
    scrim: [0, 0, 1280, 720] as Rect, // PAL.scrim alpha 0.6
    panel: [240, 96, 800, 528] as Rect,
    glyph: [272, 128, 96, 96] as Rect, // event icon, procedural
    title: [392, 140, 620, 32] as Rect, // DISPLAY-22 PAL.gold
    body: [272, 240, 736, 140] as Rect, // UI-16, lineHeight 24, wrap 736
    options: [
      [272, 396, 736, 52],
      [272, 456, 736, 52],
      [272, 516, 736, 52],
    ] as Rect[],
    leave: [272, 576, 736, 36] as Rect, // always-present Leave row, UI-14 PAL.textDim
  },

  /* ---- §10 Results screens ------------------------------------------ */
  results: {
    victoryPanel: [340, 100, 600, 520] as Rect, // post-battle victory popup
    statsBlock: [400, 220, 480, 240] as Rect, // run-end MONO-14 two columns
    headerY: 140, // "THE ALLEY REMEMBERS" / "NINE LIVES WELL SPENT"
    catsY: 480, // the four cats in sit pose
    catSpacing: 120, // centered, 120px apart
    buttonsY: 620, // "[Enter] New Run" + "[S] Same Seed"
  },

  /* ---- §11 Title screen --------------------------------------------- */
  title: {
    logoCenter: { x: 640, y: 200 }, // "c(at)rpg" DISPLAY-72
    subtitleY: 260, // UI-18 PAL.textDim
    moon: { x: 980, y: 150, r: 90, craterDx: 18, craterDy: -12, craterR: 82 },
    rooftopY: 470, // skyline strip spans y 470–720
    // Bruno, Pixel, Mora, Baguette (sit pose) — flanking the center column
    // so the lineup never overlaps the menu buttons (K3; buttons x 500–780)
    catXs: [180, 300, 960, 1080],
    menuButtons: [
      [500, 360, 280, 48],
      [500, 420, 280, 48],
      [500, 480, 280, 48],
    ] as Rect[], // New Run / Seed… / How to Play (280×48, centered x)
    seedChip: [12, 692, 232, 20] as Rect, // current seed MONO-11 bottom-left
  },
} as const;

/** Word-wrap widths (ui-art §3). */
export const WRAP = { eventBody: 740, tooltip: 260 } as const;

export const rx = (r: Rect): number => r[0];
export const ry = (r: Rect): number => r[1];
export const rw = (r: Rect): number => r[2];
export const rh = (r: Rect): number => r[3];
export const rcx = (r: Rect): number => r[0] + r[2] / 2;
export const rcy = (r: Rect): number => r[1] + r[3] / 2;
