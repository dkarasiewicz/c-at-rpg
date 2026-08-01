/**
 * WP-08 — shared HUD widgets (ui-art §6): bars, energy pips, status chips,
 * hotkey chips, buttons, panels, tooltips, paw-pip rows. Pure presentation:
 * widgets are fed values; they never compute gameplay outcomes.
 *
 * ── SHARED UI CHROME KIT (visual v3) ────────────────────────────────────
 * Everything below the "chrome kit" divider is the canonical look every
 * screen must use instead of hand-rolling rects, faces, bars and buttons:
 *
 *   panel(w, h, opts)                  the one panel look
 *   avatar(classId, size, opts)        the one cat face (painted first!)
 *   enemyAvatar(speciesId, size, opts) the one enemy face (+ `unknown`)
 *   bar(w, h, { kind })                the one HP/Energy/XP/Poise bar
 *   heading(text, level) / label(text) the one type scale
 *   button(label, w, h, onTap, opts)   the one interactive button
 *   iconTile(id, size, opts)           the one framed art tile
 *   statusGlyph(id, size)              the one status mark
 *   makeStatusChip(id, value, opts)    the one status chip
 *   wordmark(size) / emblem(size)      the one brand mark (painted first!)
 *   vignette / scrim / sceneBackdrop   cheap full-screen atmosphere,
 *                                      painted to the REAL screen edges
 *
 * Rules the kit keeps for you:
 *  • FAIL-SOFT — a missing generated texture never throws; the procedural
 *    draw/* renderer takes over silently (art packs land incrementally).
 *  • PAINTED-FIRST — `avatar()`/`enemyAvatar()` always prefer the generated
 *    `portrait:*` / `enemy:*` art, so no screen can mix painted portraits
 *    next to flat-vector ones ever again.
 *  • PURE PIXI — no external deps, no filters beyond core BlurFilter (and
 *    that one is optional + guarded).
 *  • TOKENS ONLY — colors from PAL, radii/gaps from layout, text from
 *    textStyles. Nothing here hardcodes a hex or a font.
 *
 * Older `make*` helpers stay exported unchanged; they are the legacy path
 * and screens should migrate to the kit as they get restyled.
 */
import { BlurFilter, Container, Graphics, Sprite, Text } from "pixi.js";
import type { ClassId, StatusId } from "../core/types.js";
import { ENEMIES } from "../content/enemies.js";
import { PAL, darken, hpColor, mix } from "./palette.js";
import {
  DESIGN_H,
  DESIGN_W,
  RADIUS,
  SPACE,
  WRAP,
  bleedRect,
  onViewBleed,
  type Rect,
} from "./layout.js";
import {
  TYPE,
  display,
  headingStyle,
  labelStyle,
  mono,
  ui,
  type LabelOpts,
} from "./textStyles.js";
import { tween } from "./tween.js";
import { isTouch, padHit } from "./touch.js";
import { drawCatPortrait, drawPaw } from "./draw/cats.js";
import { drawEnemy } from "./draw/enemies.js";
import { makeBustSprite } from "./draw/spriteFrame.js";
import {
  enemyTexture,
  hasSprite,
  portraitTexture,
  spriteTextureFor,
} from "./sprites.js";

/** Status chip glyphs + fills (ui-art §2). */
export const STATUS_STYLE: Record<StatusId, { glyph: string; color: number }> =
  {
    scratched: { glyph: "/", color: PAL.stScratched },
    frazzled: { glyph: "z", color: PAL.stFrazzled },
    offBalance: { glyph: "!", color: PAL.stOffBal },
    guarded: { glyph: "O", color: PAL.stGuarded },
    provoked: { glyph: ">", color: PAL.stProvoked },
    mending: { glyph: "+", color: PAL.stMending },
    // balance-and-meta.md §1: post-Off-Balance immunity window
    braced: { glyph: "=", color: PAL.stBraced },
  };

/**
 * Manifest id of a status's painted glyph. The art pack draws these at 256²
 * in the same hues as `STATUS_STYLE`, so a chip can swap the MONO letter for
 * the picture without changing its colour language. Absent art = the letter.
 */
export const statusSpriteId = (id: StatusId): string => `status:${id}`;

/**
 * What each status MEANS, in one line (enemy-intel.md §5: "never a bare icon
 * whose meaning must be memorised"). Every chip the kit renders can explain
 * itself on hover/tap from this table, so the glyph is a shortcut for players
 * who have learned it and never a wall for players who have not.
 */
export const STATUS_INFO: Record<StatusId, { name: string; blurb: string }> = {
  scratched: {
    name: "Scratched",
    blurb: "Bleeds for its stacked value at the end of each of its turns.",
  },
  frazzled: {
    name: "Frazzled",
    blurb: "Loses its next turn entirely. Wears off after it is skipped.",
  },
  offBalance: {
    name: "Off-Balance",
    blurb:
      "Takes +30% damage until it steadies. Every enemy Off-Balance at once ⇒ CAT PILE.",
  },
  guarded: { name: "Guarded", blurb: "Takes −50% damage until its next turn." },
  provoked: {
    name: "Provoked",
    blurb: "Must aim at whoever provoked it while any legal target remains.",
  },
  mending: {
    name: "Mending",
    blurb: "Heals its value at the start of each of its turns.",
  },
  braced: {
    name: "Braced",
    blurb:
      "Immune to Off-Balance for a beat — the window after being steadied.",
  },
};

/* ---------------------------------------------------------------------- */
/* Bar                                                                     */
/* ---------------------------------------------------------------------- */

export interface Bar {
  view: Container;
  /** Set fill fraction 0..1. Tweens 200ms; damage leaves a 300ms ghost. */
  set(frac: number, animate?: boolean): void;
}

/**
 * Track PAL.hpBack + 1px PAL.border outline, fill inset 1px (ui-art §6).
 * `hp: true` recolors the fill by fraction (heal / warn / danger); otherwise
 * the fixed `color` is used (e.g. PAL.energy for XP bars).
 */
export function makeBar(
  w = 64,
  h = 7,
  opts: { hp?: boolean; color?: number } = {},
): Bar {
  const view = new Container();
  const track = new Graphics()
    .rect(0, 0, w, h)
    .fill(PAL.hpBack)
    .stroke({ width: 1, color: PAL.border });
  const ghost = new Graphics().rect(0, 0, w - 2, h - 2).fill(PAL.text);
  ghost.position.set(1, 1);
  ghost.scale.x = 0;
  const fill = new Graphics().rect(0, 0, w - 2, h - 2).fill(0xffffff);
  fill.position.set(1, 1);
  view.addChild(track, ghost, fill);

  let frac = 1;
  const recolor = () => {
    fill.tint =
      opts.hp !== false && opts.color === undefined
        ? hpColor(frac)
        : (opts.color ?? PAL.heal);
  };
  recolor();
  fill.scale.x = 1;

  return {
    view,
    set(next: number, animate = true) {
      const prev = frac;
      frac = Math.max(0, Math.min(1, next));
      recolor();
      if (!animate) {
        fill.scale.x = frac;
        ghost.scale.x = 0;
        return;
      }
      tween(fill.scale, { x: frac }, 200);
      if (frac < prev) {
        // classic chip-away: PAL.text ghost lingers 300ms then shrinks.
        // The scene can unmount inside that 300 ms (a KO that ends the
        // battle), so the deferred tween re-checks its target.
        ghost.scale.x = prev;
        setTimeout(() => {
          if (ghost.destroyed) return;
          tween(ghost.scale, { x: frac }, 200);
        }, 300);
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Energy pips                                                             */
/* ---------------------------------------------------------------------- */

export interface PipRow {
  view: Container;
  set(n: number): void;
}

/**
 * 10 rounded-rects 6×8, r 2, gap 2 (78px total), PAL.energy when banked
 * else PAL.hpBack. Gaining pips pop scale 1.4→1 over 120ms.
 */
export function makeEnergyPips(count = 10, pw = 6, ph = 8, gap = 2): PipRow {
  const view = new Container();
  const pips: Graphics[] = [];
  for (let i = 0; i < count; i++) {
    const p = new Graphics()
      .roundRect(-pw / 2, -ph / 2, pw, ph, 2)
      .fill(0xffffff);
    p.position.set(i * (pw + gap) + pw / 2, ph / 2);
    p.tint = PAL.hpBack;
    view.addChild(p);
    pips.push(p);
  }
  let banked = 0;
  return {
    view,
    set(n: number) {
      const next = Math.max(0, Math.min(count, Math.round(n)));
      for (let i = 0; i < count; i++) {
        const on = i < next;
        const was = i < banked;
        pips[i].tint = on ? PAL.energy : PAL.hpBack;
        if (on && !was) {
          pips[i].scale.set(1.4);
          tween(pips[i].scale, { x: 1, y: 1 }, 120);
        }
      }
      banked = next;
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Chips                                                                   */
/* ---------------------------------------------------------------------- */

export interface StatusChipOpts {
  /** Stacked magnitude (scratched / mending) — printed bottom-right. */
  value?: number;
  /** Rounds left — printed as a `2r` tail to the right of the chip. */
  duration?: number;
  /** Chip edge length (default 16). */
  size?: number;
  /**
   * Explain itself on hover/tap from `STATUS_INFO` (enemy-intel.md §5). The
   * tooltip is added to the chip, so the caller only has to keep the chip in
   * a container that is allowed to overflow.
   */
  explain?: boolean;
}

/**
 * A status's mark at `size`×`size`, centered on the returned container's
 * ORIGIN: the painted `status:*` glyph when the art pack has it, the MONO
 * letter from `STATUS_STYLE` when it does not. Anything that today prints a
 * bare status letter (turn-strip markers, threat previews) should call this
 * so the two never disagree.
 */
export function statusGlyph(
  id: StatusId,
  size: number,
  opts: { fill?: number } = {},
): Container {
  const view = new Container();
  const tex = spriteTextureFor(statusSpriteId(id));
  if (tex && tex.width > 0 && tex.height > 0) {
    const sp = new Sprite({ texture: tex, anchor: 0.5 });
    sp.width = size;
    sp.height = size;
    view.addChild(sp);
    return view;
  }
  const t = new Text({
    text: STATUS_STYLE[id].glyph,
    style: mono(Math.max(7, Math.round(size * 0.92)), {
      fill: opts.fill ?? PAL.text,
    }),
  });
  t.anchor.set(0.5);
  view.addChild(t);
  return view;
}

/**
 * Status chip (ui-art §6). Two looks, one silhouette:
 *
 *  • PAINTED (art pack present) — a dark plate in the status's own hue with a
 *    1px lit edge of it, and the `status:*` glyph on top at full colour. The
 *    picture is what carries the meaning; the plate is only there so the
 *    glyph sits on a consistent value and reads over any backdrop.
 *  • FALLBACK (no art) — exactly today's chip: solid status-coloured fill,
 *    darkened outline, MONO letter.
 *
 * Both share geometry, so `duration`, the stacked numeral and the tap-to-
 * explain tooltip are identical either way. Scratched/Mending show their
 * stacked value as a small numeral bottom-right; `duration` adds an `Nr`
 * tail; `explain` makes the chip tell you what it does instead of assuming
 * you memorised the glyph.
 */
export function makeStatusChip(
  id: StatusId,
  value?: number,
  opts: StatusChipOpts = {},
): Container {
  const { color } = STATUS_STYLE[id];
  const s = opts.size ?? 16;
  const chip = new Container();
  const painted = hasSprite(statusSpriteId(id));
  chip.addChild(
    painted
      ? new Graphics()
          .roundRect(0, 0, s, s, RADIUS.chip)
          .fill({ color: mix(color, PAL.void, 0.74), alpha: 0.96 })
          .stroke({ width: 1, color: mix(color, PAL.void, 0.25) })
      : new Graphics()
          .roundRect(0, 0, s, s, RADIUS.chip)
          .fill(color)
          .stroke({ width: 1, color: darken(color) }),
  );
  // 0.86 keeps a painted glyph inside the plate's rounded corners; the MONO
  // letter is measured cap-to-cap and wants a touch less.
  const g = statusGlyph(id, Math.round(s * (painted ? 0.86 : 0.82)));
  g.position.set(s / 2, s / 2);
  chip.addChild(g);
  const stacked = value ?? opts.value;
  if (stacked !== undefined && (id === "scratched" || id === "mending")) {
    const v = new Text({ text: String(stacked), style: mono(9) });
    v.anchor.set(1, 1);
    v.position.set(s, s + 1);
    // A painted glyph fills the whole chip, so the stacked numeral needs its
    // own ground to stay readable on top of it (the flat fallback fill has
    // plenty of contrast already).
    if (painted) {
      const wv = Math.ceil(v.width) + 3;
      chip.addChild(
        new Graphics()
          .roundRect(s - wv, s - 10, wv, 11, 2)
          .fill({ color: PAL.void, alpha: 0.72 }),
      );
    }
    chip.addChild(v);
  }
  if (opts.duration !== undefined && opts.duration > 0) {
    const d = new Text({
      text: `${opts.duration}r`,
      style: mono(9, { fill: PAL.textDim }),
    });
    d.position.set(s + 2, s / 2 - 5);
    chip.addChild(d);
  }
  if (opts.explain === true) {
    const info = STATUS_INFO[id];
    let tip: Container | null = null;
    const drop = (): void => {
      tip?.destroy({ children: true });
      tip = null;
    };
    // ABOVE the chip: these rows sit at the bottom of the battle HUD, where a
    // tooltip hanging below would fall off the screen.
    const raise = (): void => {
      if (tip) return;
      const built = makeTooltip(`${info.name.toUpperCase()} — ${info.blurb}`);
      built.position.set(-8, -Math.ceil(built.height) - 6);
      chip.addChild(built);
      tip = built;
    };
    chip.eventMode = "static";
    chip.cursor = "help";
    // A 16px chip is 9 CSS px under a finger — unhittable without padding.
    padHit(chip, s, s);
    // Hover explains on a mouse; tap toggles on both (a status chip commits
    // nothing, so "tap to inspect" needs no second tap to confirm).
    chip.on("pointerover", () => {
      if (!isTouch()) raise();
    });
    chip.on("pointerout", () => {
      if (!isTouch()) drop();
    });
    chip.on("pointertap", () => {
      if (tip) drop();
      else raise();
    });
  }
  return chip;
}

export interface HotkeyChip {
  view: Container;
  setEnabled(on: boolean): void;
}

/**
 * Hotkey chip (ui-art §6): 16×16 r 4 PAL.gold with MONO-12 PAL.textDark
 * numeral. Disabled: PAL.panel fill, PAL.textDim numeral.
 */
export function makeHotkeyChip(label: string, enabled = true): HotkeyChip {
  const view = new Container();
  const bg = new Graphics();
  const num = new Text({ text: label, style: mono(12) });
  num.anchor.set(0.5);
  num.position.set(8, 8);
  view.addChild(bg, num);
  const paint = (on: boolean) => {
    bg.clear()
      .roundRect(0, 0, 16, 16, RADIUS.chip)
      .fill(on ? PAL.gold : PAL.panel)
      .stroke({ width: 1, color: on ? PAL.goldDark : PAL.border });
    num.style.fill = on ? PAL.textDark : PAL.textDim;
  };
  paint(enabled);
  return { view, setEnabled: paint };
}

/* ---------------------------------------------------------------------- */
/* Button & panel                                                          */
/* ---------------------------------------------------------------------- */

export interface Button {
  view: Container;
  setEnabled(on: boolean): void;
  setLabel(text: string): void;
}

/**
 * Button (ui-art §6): r 6 PAL.panel + 2px PAL.border; hover PAL.panelLite +
 * gold border; pressed offsets content 1px down; disabled alpha 0.5.
 * Primary (Enter-bound): PAL.gold fill, PAL.textDark text.
 */
export function makeButton(
  label: string,
  w: number,
  h: number,
  onTap: () => void,
  opts: { primary?: boolean; fontSize?: number } = {},
): Button {
  const view = new Container();
  const bg = new Graphics();
  const content = new Container();
  const txt = new Text({
    text: label,
    style: ui(opts.fontSize ?? 18, {
      fill: opts.primary ? PAL.textDark : PAL.text,
    }),
  });
  txt.anchor.set(0.5);
  txt.position.set(w / 2, h / 2);
  content.addChild(txt);
  view.addChild(bg, content);

  let enabled = true;
  let hover = false;
  const paint = () => {
    const fill = opts.primary ? PAL.gold : hover ? PAL.panelLite : PAL.panel;
    const border = opts.primary ? PAL.goldDark : hover ? PAL.gold : PAL.border;
    bg.clear()
      .roundRect(0, 0, w, h, RADIUS.button)
      .fill(fill)
      .stroke({ width: 2, color: border });
    view.alpha = enabled ? 1 : 0.5;
  };
  paint();

  view.eventMode = "static";
  view.cursor = "pointer";
  padHit(view, w, h);
  view.on("pointerover", () => {
    hover = true;
    paint();
  });
  view.on("pointerout", () => {
    hover = false;
    content.y = 0;
    paint();
  });
  view.on("pointerdown", () => {
    if (enabled) content.y = 1;
  });
  view.on("pointerup", () => {
    content.y = 0;
    if (enabled) onTap();
  });
  view.on("pointerupoutside", () => {
    content.y = 0;
  });

  return {
    view,
    setEnabled(on: boolean) {
      enabled = on;
      view.eventMode = on ? "static" : "none";
      paint();
    },
    setLabel(text: string) {
      txt.text = text;
    },
  };
}

/** Panel (ui-art §6): r 8, PAL.panel alpha 0.92, 2px PAL.border. */
export function makePanel(w: number, h: number, r = RADIUS.panel): Graphics {
  return new Graphics()
    .roundRect(0, 0, w, h, r)
    .fill({ color: PAL.panel, alpha: 0.92 })
    .stroke({ width: 2, color: PAL.border });
}

/**
 * Tooltip: UI-14 on PAL.panelLite, wrapped at 260px (ui-art §§3, 6), 8px
 * padding. Position it yourself; add to a top layer.
 */
export function makeTooltip(text: string): Container {
  const view = new Container();
  const txt = new Text({
    text,
    style: ui(14, { wordWrap: true, wordWrapWidth: WRAP.tooltip }),
  });
  txt.position.set(8, 6);
  const w = Math.ceil(txt.width) + 16;
  const h = Math.ceil(txt.height) + 12;
  view.addChild(
    new Graphics()
      .roundRect(0, 0, w, h, RADIUS.button)
      .fill(PAL.panelLite)
      .stroke({ width: 2, color: PAL.border }),
    txt,
  );
  return view;
}

/* ---------------------------------------------------------------------- */
/* Generated-art helpers (visual v2 — fail-soft, procedural fallback)      */
/* ---------------------------------------------------------------------- */

/**
 * Square icon sprite for a manifest id ('item:tunaSnack', 'equip:tinBell'…),
 * anchored center and sized to `size`×`size`. Returns null when the sprite
 * pack is absent so callers keep their procedural glyph fallback.
 */
export function makeSpriteIcon(id: string, size: number): Sprite | null {
  const tex = spriteTextureFor(id);
  if (!tex) return null;
  const icon = new Sprite(tex);
  icon.anchor.set(0.5);
  icon.width = size;
  icon.height = size;
  return icon;
}

export interface IconTileOpts {
  /** Plate + border colour (default PAL.border). */
  accent?: number;
  /** Dim the whole tile — unusable skills, unequippable gear. */
  dim?: boolean;
  /** Draw the dark plate behind the art (default true). */
  plate?: boolean;
  radius?: number;
}

/**
 * THE art tile: a generated icon (`skill:*`, `equip:*`, `item:*`…) sitting on
 * a small dark plate with a 1px edge, origin at the TOP-LEFT and spanning
 * `size`×`size`.
 *
 * This is the one "art in a box" look — skill cards use it, and anything else
 * that wants a framed icon rather than a bare floating sprite should too, so
 * the icons in the busiest screen in the game all share a silhouette and the
 * eye can scan the column instead of re-parsing each card.
 *
 * Returns NULL when the id has no texture, which is the caller's cue to keep
 * its pre-art layout (the icons land incrementally; a missing one is normal).
 */
export function iconTile(
  id: string,
  size: number,
  opts: IconTileOpts = {},
): Container | null {
  const tex = spriteTextureFor(id);
  if (!tex || tex.width <= 0 || tex.height <= 0) return null;
  const view = new Container();
  const r = opts.radius ?? RADIUS.button;
  if (opts.plate !== false) {
    // Deliberately faint. The plate exists to line the icons up into a
    // scannable column, not to draw a second border inside a card that
    // already has one — anything heavier and six cards read as a grid of
    // boxes instead of a row of pictures.
    // A DIMMED tile inverts the plate instead of deepening it: the painted
    // icons are dark to begin with, so a darker plate under a faded icon
    // leaves one unreadable smudge. A faint LIGHT plate keeps the
    // silhouette separated from the row it sits on.
    const plate = new Graphics()
      .roundRect(0, 0, size, size, r)
      .fill(
        opts.dim === true
          ? { color: PAL.text, alpha: 0.09 }
          : { color: PAL.void, alpha: 0.26 },
      );
    if (opts.accent !== undefined) {
      plate
        .roundRect(0, 0, size, size, r)
        .stroke({ width: 1, color: opts.accent, alpha: 0.85, alignment: 1 });
    }
    view.addChild(plate);
  }
  const sp = new Sprite({ texture: tex, anchor: 0.5 });
  // 0.98 keeps the keyed art just clear of the plate's rounded corners
  sp.width = size * 0.98;
  sp.height = size * 0.98;
  sp.position.set(size / 2, size / 2);
  view.addChild(sp);
  if (opts.dim === true) {
    // Opacity only. A tint MULTIPLIES, and most of this art pack is dark
    // paint on a dark key — multiplying it by PAL.textDim crushed the
    // unlearned rows in THE DEN to black rectangles. Fading keeps the hue,
    // which is the only thing that still says "this is a picture".
    view.alpha = 0.62;
  }
  return view;
}

/**
 * Cover-fit a generated illustration ('scene:*'…) into a w×h region:
 * scaled to fill, cropped by a rounded-rect mask. `align: 'right'` keeps
 * the right edge (the scene set's subjects sit in the right third);
 * `dim` adds a PAL.bgDeep darkening overlay for text-over-art readability.
 * Extra children added to the returned container are clipped by the same
 * mask. Returns null when the texture is absent (procedural bg stays).
 */
export function makeCoverSprite(
  id: string,
  w: number,
  h: number,
  opts: { align?: "center" | "right"; radius?: number; dim?: number } = {},
): Container | null {
  const tex = spriteTextureFor(id);
  if (!tex || tex.width <= 0 || tex.height <= 0) return null;
  const view = new Container();
  const sp = new Sprite(tex);
  const s = Math.max(w / tex.width, h / tex.height);
  sp.scale.set(s);
  const sw = tex.width * s;
  const sh = tex.height * s;
  sp.position.set(opts.align === "right" ? w - sw : (w - sw) / 2, (h - sh) / 2);
  view.addChild(sp);
  const mask = new Graphics()
    .roundRect(0, 0, w, h, opts.radius ?? 0)
    .fill(0xffffff);
  view.addChild(mask);
  view.mask = mask;
  if (opts.dim !== undefined && opts.dim > 0) {
    view.addChild(
      new Graphics()
        .rect(0, 0, w, h)
        .fill({ color: PAL.bgDeep, alpha: opts.dim }),
    );
  }
  return view;
}

/* ---------------------------------------------------------------------- */
/* Nine Lives paw pips                                                     */
/* ---------------------------------------------------------------------- */

/**
 * A cat's Lives as a row of 9 paw glyphs, 7×7px each with 1px gaps
 * (ui-art §4). Remaining lives PAL.gold; spent pips PAL.hpBack with a 1px
 * PAL.border outline.
 */
export function makePawRow(lives: number, max = 9): PipRow {
  const view = new Container();
  const paws: Graphics[] = [];
  for (let i = 0; i < max; i++) {
    const g = new Graphics();
    g.position.set(i * 8, 0); // 7px glyph + 1px gap
    view.addChild(g);
    paws.push(g);
  }
  const paint = (n: number) => {
    for (let i = 0; i < max; i++) {
      paws[i].clear();
      drawPaw(paws[i], 3.5, 3.5, 1, i < n);
    }
  };
  paint(lives);
  return { view, set: paint };
}

/* ======================================================================== */
/* ==  SHARED UI CHROME KIT (visual v3)                                  == */
/* ======================================================================== */

/* ---------------------------------------------------------------------- */
/* Internals                                                               */
/* ---------------------------------------------------------------------- */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Cheap fake drop shadow: `steps` concentric rounded rects behind the shape,
 * each a little bigger and fainter. No filters, one Graphics, batches fine.
 */
function softShadow(
  g: Graphics,
  w: number,
  h: number,
  r: number,
  steps = 6,
  alpha = 0.26,
): void {
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    g.roundRect(-i, -i + 2, w + i * 2, h + i * 2, r + i).fill({
      color: PAL.shadow,
      alpha: alpha * (1 - t) * 0.9,
    });
  }
}

/**
 * Inner top highlight shared by panels and buttons (the "lit edge"): a 1px
 * bright line on the top edge plus a soft falloff faked as `BANDS` stacked
 * strips, so the sheen never leaves a hard horizontal seam mid-panel.
 */
function innerSheen(
  g: Graphics,
  w: number,
  h: number,
  r: number,
  strength = 1,
): void {
  const BANDS = 7;
  const reach = Math.min(h - 2, Math.max(6, h * 0.5));
  const rr = Math.max(0, r - 1);
  // nested rects all anchored at the top edge: overlapping them builds a
  // falloff without a single visible seam, and they share the panel's corners
  for (let i = 0; i < BANDS; i++) {
    const height = (reach * (i + 1)) / BANDS;
    g.roundRect(1, 1, w - 2, height, rr).fill({
      color: PAL.sheen,
      alpha: 0.01 * strength,
    });
  }
  g.moveTo(Math.min(r, w / 2), 1.5)
    .lineTo(w - Math.min(r, w / 2), 1.5)
    .stroke({ width: 1, color: PAL.sheen, alpha: 0.11 * strength });
}

/* ---------------------------------------------------------------------- */
/* panel                                                                   */
/* ---------------------------------------------------------------------- */

export type PanelVariant = "solid" | "glass" | "raised";

export interface PanelOpts {
  /** solid = HUD default, glass = over artwork, raised = hovered/modal. */
  variant?: PanelVariant;
  /** Accent color for the left edge bar + tinted border (usually PAL.gold). */
  accent?: number;
  radius?: number;
}

/**
 * THE panel. Dark translucent fill, inner top highlight, 1px palette border,
 * soft drop shadow, optional accent edge. Origin at the top-left, spans
 * w×h; add your content as children on top.
 *
 * Use this instead of any hand-rolled `Graphics().rect().fill()` panel.
 *
 * NOTE: the container's *bounds* run ~8px past w×h (the drop shadow), so
 * lay out with the w/h you passed in — never with `panel(...).width`.
 */
export function panel(w: number, h: number, opts: PanelOpts = {}): Container {
  const variant = opts.variant ?? "solid";
  const r = opts.radius ?? RADIUS.panel;
  const view = new Container();
  const g = new Graphics();

  softShadow(
    g,
    w,
    h,
    r,
    variant === "raised" ? 8 : 6,
    variant === "raised" ? 0.34 : 0.24,
  );

  const fill =
    variant === "glass"
      ? { color: PAL.glass, alpha: 0.62 }
      : variant === "raised"
        ? { color: PAL.panelLite, alpha: 0.96 }
        : { color: PAL.panel, alpha: 0.9 };

  g.roundRect(0, 0, w, h, r)
    .fill(fill)
    .stroke({ width: 1, color: PAL.border, alignment: 1 });
  innerSheen(g, w, h, r, variant === "glass" ? 1.4 : 1);

  if (opts.accent !== undefined) {
    g.roundRect(0, 0, w, h, r).stroke({
      width: 1,
      color: opts.accent,
      alpha: 0.6,
      alignment: 1,
    });
    // accent edge: a 3px bar hugging the left side, inset past the corners
    g.roundRect(0, r * 0.7, 3, Math.max(2, h - r * 1.4), 1.5).fill({
      color: opts.accent,
      alpha: 0.95,
    });
  }

  view.addChild(g);
  return view;
}

/* ---------------------------------------------------------------------- */
/* avatar / enemyAvatar                                                    */
/* ---------------------------------------------------------------------- */

export interface AvatarOpts {
  /** KO'd: greyed sprite / ×-eyed procedural face, dimmed. */
  dead?: boolean;
  /** Status ring color drawn just outside the frame (e.g. PAL.gold = active). */
  ring?: number;
  /** Draw the 2px framed border (default true). */
  frame?: boolean;
  /** 'circle' (default) or 'rounded' square. */
  shape?: "circle" | "rounded";
  /**
   * `enemyAvatar` only: this species has not been MET. Draws the shared
   * `bestiary:unknown` silhouette instead of the real art, so an unearned
   * bestiary entry is a shape with a question in it rather than an empty
   * plate — and never a recognisable spoiler of the thing you have not
   * fought. Falls back to a voided tint of the real art when that texture
   * is missing (today's rendering).
   */
  unknown?: boolean;
}

/** Manifest id of the shared "not met yet" bestiary silhouette. */
export const UNKNOWN_SPRITE_ID = "bestiary:unknown";

/**
 * Shared avatar shell: backing disc, masked art, frame, ring, KO wash.
 * `content` is the art container, already centered on (0, 0).
 */
function avatarShell(
  size: number,
  opts: AvatarOpts,
  content: Container,
): Container {
  const half = size / 2;
  const r = opts.shape === "rounded" ? Math.max(4, size * 0.2) : half;
  const view = new Container();

  const back = new Graphics();
  softShadow(back, size, size, r, 5, 0.3);
  back.position.set(-half, -half);
  const disc = new Graphics()
    .roundRect(-half, -half, size, size, r)
    .fill({ color: PAL.hpBack, alpha: 0.95 });
  view.addChild(back, disc);

  const mask = new Graphics()
    .roundRect(-half, -half, size, size, r)
    .fill(0xffffff);
  content.mask = mask;
  view.addChild(content, mask);

  if (opts.dead === true) {
    // KO wash kept light: the art is already tinted grey, and dark cats go
    // unreadable if we stack a heavy scrim on top of that.
    view.addChild(
      new Graphics()
        .roundRect(-half, -half, size, size, r)
        .fill({ color: PAL.void, alpha: 0.2 }),
    );
    view.alpha = 0.85;
  }

  if (opts.frame !== false) {
    view.addChild(
      new Graphics()
        .roundRect(-half, -half, size, size, r)
        .stroke({ width: 2, color: PAL.border, alignment: 0.5 }),
    );
  }
  if (opts.ring !== undefined) {
    view.addChild(
      new Graphics()
        .roundRect(-half - 3, -half - 3, size + 6, size + 6, r + 3)
        .stroke({ width: 2, color: opts.ring, alpha: 0.95 }),
    );
  }
  return view;
}

/**
 * THE cat face. Always prefers the painted `portrait:<name>` texture and
 * only falls back to the procedural `drawCatPortrait` recipe when that
 * texture is missing — so a screen can never show a flat-vector cat next to
 * a painted one. Centered on the container's origin, spans `size`×`size`
 * (bounds run a few px wider: drop shadow + status ring).
 */
export function avatar(
  classId: ClassId,
  size: number,
  opts: AvatarOpts = {},
): Container {
  const content = new Container();
  const tex = portraitTexture(classId);
  if (tex && tex.width > 0 && tex.height > 0) {
    const sp = new Sprite({ texture: tex, anchor: 0.5 });
    sp.scale.set(size / Math.min(tex.width, tex.height)); // cover-fit
    if (opts.dead === true) sp.tint = mix(PAL.textDim, PAL.void, 0.1);
    content.addChild(sp);
  } else {
    const g = new Graphics();
    drawCatPortrait(g, classId, opts.dead === true);
    g.scale.set(size / 52); // the head recipe spans ~52px incl. whiskers
    content.addChild(g);
  }
  return avatarShell(size, opts, content);
}

/**
 * THE enemy face — `enemy:*` / `boss:*` texture first, procedural
 * `drawEnemy` recipe (fitted into the box) as the fallback. Unknown species
 * ids render an empty framed disc rather than throwing.
 */
export function enemyAvatar(
  speciesId: string,
  size: number,
  opts: AvatarOpts = {},
): Container {
  const content = new Container();
  if (opts.unknown === true) {
    const q = spriteTextureFor(UNKNOWN_SPRITE_ID);
    if (q && q.width > 0 && q.height > 0) {
      const sp = new Sprite({ texture: q, anchor: 0.5 });
      sp.scale.set(size / Math.min(q.width, q.height));
      content.addChild(sp);
      return avatarShell(size, opts, content);
    }
  }
  const tex = enemyTexture(speciesId);
  // head-and-shoulders crop, not the whole aura-padded battle frame — fitting
  // the frame is what made turn-strip chips read as purple smudges
  const bust = makeBustSprite(tex, size);
  if (bust) {
    if (opts.dead === true) bust.tint = mix(PAL.textDim, PAL.void, 0.1);
    content.addChild(bust);
  } else {
    const look = ENEMIES[speciesId]?.look;
    if (look) {
      const g = new Graphics();
      drawEnemy(g, look);
      // recipe: feet at (0,0), body spans ~110px up at grade scale 1
      const grade = look.sizeGrade === "boss" ? 1.6 : 1;
      const inner = new Container();
      inner.addChild(g);
      inner.scale.set(size / (128 * grade));
      inner.position.set(0, size * 0.42);
      if (opts.dead === true) inner.alpha = 0.6;
      content.addChild(inner);
    }
  }
  return avatarShell(size, opts, content);
}

/* ---------------------------------------------------------------------- */
/* bar                                                                     */
/* ---------------------------------------------------------------------- */

export type BarKind = "hp" | "energy" | "xp" | "poise";

export interface ValueBar {
  view: Container;
  /** Feed raw value/max; the widget does the math, coloring and animation. */
  set(value: number, max: number, animate?: boolean): void;
}

export interface BarOpts {
  kind?: BarKind;
  /** Pip ticks: `true` = one per unit of max, a number = that many segments. */
  ticks?: boolean | number;
}

const BAR_COLOR: Record<Exclude<BarKind, "hp">, number> = {
  energy: PAL.energy,
  xp: PAL.xp,
  poise: PAL.stGuarded,
};

/**
 * THE bar. Rounded track (PAL.hpBack + 1px border), inset fill colored by
 * `kind` (hp recolors by fraction), a thin top highlight on the fill, an
 * optional pip-tick overlay, and the classic chip-away damage ghost.
 * Poise bars tick per point by default.
 */
export function bar(w = 120, h = 10, opts: BarOpts = {}): ValueBar {
  const kind = opts.kind ?? "hp";
  const r = Math.min(RADIUS.bar, h / 2);
  const iw = w - 2;
  const ih = h - 2;

  const view = new Container();
  view.addChild(
    new Graphics()
      .roundRect(0, 0, w, h, r)
      .fill({ color: PAL.hpBack, alpha: 0.95 })
      .stroke({ width: 1, color: PAL.border, alignment: 1 }),
  );

  const ghost = new Graphics().rect(0, 0, iw, ih).fill(PAL.text);
  ghost.position.set(1, 1);
  ghost.alpha = 0.45;
  ghost.scale.x = 0;

  const fillWrap = new Container();
  fillWrap.position.set(1, 1);
  const fill = new Graphics().rect(0, 0, iw, ih).fill(0xffffff);
  const sheen = new Graphics()
    .rect(0, 0, iw, Math.max(1, Math.round(ih * 0.34)))
    .fill({ color: PAL.sheen, alpha: 0.22 });
  fillWrap.addChild(fill, sheen);

  const ticks = new Graphics();
  view.addChild(ghost, fillWrap, ticks);

  let frac = 1;
  let tickN = 0;
  fillWrap.scale.x = 1;

  const recolor = (): void => {
    fill.tint = kind === "hp" ? hpColor(frac) : BAR_COLOR[kind];
  };
  const retick = (max: number): void => {
    const want =
      opts.ticks === undefined
        ? kind === "poise"
          ? Math.round(max)
          : 0
        : opts.ticks === true
          ? Math.round(max)
          : opts.ticks === false
            ? 0
            : Math.round(opts.ticks);
    const n = Math.max(0, Math.min(40, want));
    if (n === tickN) return;
    tickN = n;
    ticks.clear();
    for (let i = 1; i < n; i++) {
      const x = 1 + (iw * i) / n;
      ticks
        .moveTo(x, 1)
        .lineTo(x, h - 1)
        .stroke({ width: 1, color: PAL.bgDeep, alpha: 0.8 });
    }
  };
  recolor();

  return {
    view,
    set(value: number, max: number, animate = true) {
      retick(max);
      const prev = frac;
      frac = max > 0 ? clamp01(value / max) : 0;
      recolor();
      if (!animate) {
        fillWrap.scale.x = frac;
        ghost.scale.x = 0;
        return;
      }
      tween(fillWrap.scale, { x: frac }, 200);
      if (frac < prev) {
        // same 300 ms window as `bar()` — the target can be gone by then
        ghost.scale.x = prev;
        setTimeout(() => {
          if (ghost.destroyed) return;
          tween(ghost.scale, { x: frac }, 200);
        }, 300);
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* heading / label                                                         */
/* ---------------------------------------------------------------------- */

/**
 * THE heading. level 1 = screen banner (DISPLAY-34), 2 = panel title
 * (DISPLAY-22), 3 = section eyebrow (UI-15 bold, letterspaced, dim).
 * `center: true` anchors on the text's center so you can place it by x.
 */
export function heading(
  text: string,
  level: 1 | 2 | 3 = 1,
  opts: { fill?: number; center?: boolean } = {},
): Text {
  const t = new Text({
    text,
    style: headingStyle(
      level,
      opts.fill !== undefined ? { fill: opts.fill } : {},
    ),
  });
  if (opts.center === true) t.anchor.set(0.5);
  return t;
}

/** THE label — body/secondary copy on the shared type scale. */
export function label(
  text: string,
  opts: LabelOpts & { center?: boolean } = {},
): Text {
  const t = new Text({ text, style: labelStyle(opts) });
  if (opts.center === true) t.anchor.set(0.5);
  return t;
}

/* ---------------------------------------------------------------------- */
/* button                                                                  */
/* ---------------------------------------------------------------------- */

export interface ButtonOpts {
  /** Enter-bound / confirming action: gold fill, dark text. */
  primary?: boolean;
  disabled?: boolean;
  /** Keyboard hint rendered as a chip inside the button ('Enter', 'N'…). */
  hotkey?: string;
  fontSize?: number;
}

/**
 * THE button: panel-family fill + 1px border + soft shadow, inner sheen,
 * hover lift (lighter fill, gold border), 1px press offset, disabled dim,
 * and an optional hotkey chip on the left. Same `Button` handle shape as
 * the legacy `makeButton`.
 */
export function button(
  labelText: string,
  w: number,
  h: number,
  onTap: () => void,
  opts: ButtonOpts = {},
): Button {
  const view = new Container();
  const bg = new Graphics();
  const content = new Container();
  const primary = opts.primary === true;
  const r = RADIUS.button;

  let chipW = 0;
  // The hotkey chip names a KEY, and a phone has no keys. Printing "Esc",
  // "Enter", "E" or "T" beside a button a finger is about to press is dead
  // chrome at best and a promise the device cannot keep at worst — the
  // player goes looking for an Escape key that a virtual keyboard does not
  // have. So on a coarse pointer the chip is not built at all, and the label
  // simply centres in the full width (`chipW` stays 0). Nothing moves on a
  // mouse. The skill cards' 1-6 are drawn elsewhere and stay: those read as
  // slot numbers, not as keys.
  const showHotkey =
    opts.hotkey !== undefined && opts.hotkey !== "" && !isTouch();
  if (showHotkey) {
    const chip = new Container();
    const key = new Text({
      text: opts.hotkey,
      style: mono(TYPE.tiny, {
        fill: primary ? PAL.textDark : PAL.textDim,
      }),
    });
    key.anchor.set(0.5);
    const cw = Math.max(18, Math.ceil(key.width) + 10);
    const chH = Math.min(h - 12, 18);
    key.position.set(cw / 2, chH / 2);
    chip.addChild(
      new Graphics()
        .roundRect(0, 0, cw, chH, RADIUS.chip)
        .fill({
          color: primary ? PAL.goldDark : PAL.hpBack,
          alpha: primary ? 0.5 : 0.9,
        })
        .stroke({
          width: 1,
          color: primary ? PAL.goldDark : PAL.border,
        }),
      key,
    );
    chip.position.set(SPACE.md, (h - chH) / 2);
    content.addChild(chip);
    chipW = cw + SPACE.md;
  }

  const txt = new Text({
    text: labelText,
    style: ui(opts.fontSize ?? TYPE.body, {
      fontWeight: "bold",
      fill: primary ? PAL.textDark : PAL.text,
    }),
  });
  txt.anchor.set(0.5);
  txt.position.set(chipW + (w - chipW) / 2, h / 2);
  content.addChild(txt);
  view.addChild(bg, content);

  let enabled = opts.disabled !== true;
  let hover = false;
  let pressed = false;

  const paint = (): void => {
    const base = primary ? PAL.gold : PAL.panel;
    const face = pressed
      ? mix(base, PAL.shadow, 0.18)
      : hover
        ? primary
          ? mix(base, PAL.sheen, 0.14)
          : PAL.panelLite
        : base;
    const border = primary ? PAL.goldDark : hover ? PAL.gold : PAL.border;
    bg.clear();
    softShadow(bg, w, h, r, pressed ? 3 : 5, hover ? 0.3 : 0.22);
    bg.roundRect(0, 0, w, h, r)
      .fill({ color: face, alpha: primary ? 1 : 0.94 })
      .stroke({ width: 1, color: border, alignment: 1 });
    innerSheen(bg, w, h, r, primary ? 0.7 : 1);
    view.alpha = enabled ? 1 : 0.45;
  };
  paint();

  view.eventMode = enabled ? "static" : "none";
  view.cursor = "pointer";
  // THE touch-parity line for the whole game (docs/design/mobile.md §3): the
  // kit's buttons are 30-52 design px tall, which at an iPhone-class 0.54
  // letterbox scale is 16-28 CSS px — well under a fingertip. `padHit` grows
  // the TARGET to 44 CSS px without touching a pixel of the art, and it reads
  // the live scale on every hit test, so it keeps up with a rotate.
  padHit(view, w, h);
  view.on("pointerover", () => {
    // Touch emits a synthetic hover around every tap; honouring it would
    // leave the last-tapped button lit up as though the finger were resting
    // on it. Hover is a mouse affordance and stays one.
    if (isTouch()) return;
    hover = true;
    paint();
  });
  view.on("pointerout", () => {
    hover = false;
    pressed = false;
    content.y = 0;
    paint();
  });
  view.on("pointerdown", () => {
    if (!enabled) return;
    pressed = true;
    content.y = 1;
    paint();
  });
  view.on("pointerup", () => {
    pressed = false;
    content.y = 0;
    paint();
    if (enabled) onTap();
  });
  view.on("pointerupoutside", () => {
    pressed = false;
    content.y = 0;
    paint();
  });

  return {
    view,
    setEnabled(on: boolean) {
      enabled = on;
      view.eventMode = on ? "static" : "none";
      paint();
    },
    setLabel(next: string) {
      txt.text = next;
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Brand: the wordmark and the emblem                                      */
/* ---------------------------------------------------------------------- */

/**
 * THE wordmark — "c(at)rpg" with gold parens, on the DISPLAY face, centred
 * on its own origin so a caller only has to place a point. Two screens show
 * it (boot and title) and they must never drift apart, so it lives in the
 * kit rather than in either of them.
 */
export function wordmark(size: number = TYPE.h1): Container {
  const view = new Container();
  const parts: [string, number][] = [
    ["c", PAL.text],
    ["(at)", PAL.gold],
    ["rpg", PAL.text],
  ];
  const texts = parts.map(
    ([text, fill]) => new Text({ text, style: display(size, { fill }) }),
  );
  const total = texts.reduce((s, t) => s + t.width, 0);
  let x = -total / 2;
  for (const t of texts) {
    t.anchor.set(0, 0.5);
    t.position.set(x, 0);
    x += t.width;
    view.addChild(t);
  }
  return view;
}

/**
 * THE emblem — the keyed `title:logo` medallion, centred on its own origin
 * and scaled to `size` tall, over a warm pool so it reads on any backdrop.
 *
 * Fail-soft like every other painted-first helper in the kit: with no
 * generated logo it falls back to the procedural gold paw (draw/cats.ts),
 * which is what the boot screen drew before the art landed.
 */
export function emblem(size: number): Container {
  const view = new Container();

  // warm pool — concentric goldDark rings, cheapest possible glow
  const glow = new Graphics();
  const rings = 9;
  for (let i = rings; i >= 1; i--) {
    glow.circle(0, 0, (size * 0.62 * i) / rings).fill({
      color: PAL.goldDark,
      alpha: 0.035 * (1 - (i - 1) / rings),
    });
  }
  view.addChild(glow);

  const tex = spriteTextureFor("title:logo");
  if (tex && tex.height > 0) {
    const sp = new Sprite({ texture: tex, anchor: 0.5 });
    sp.scale.set(size / tex.height);
    view.addChild(sp);
  } else {
    // the pre-art mark: drawPaw is a 7-unit glyph at scale 1, and its toes
    // and pad together stand ~8.6 units tall — so `size` here is the same
    // optical height the medallion would have had
    const paw = new Graphics();
    drawPaw(paw, 0, 0, size / 8.6, true);
    view.addChild(paw);
  }
  view.eventMode = "none";
  return view;
}

/* ---------------------------------------------------------------------- */
/* Atmosphere: vignette / scrim / sceneBackdrop                            */
/* ---------------------------------------------------------------------- */

/**
 * Screen-sized chrome must paint the SCREEN, not the safe area.
 *
 * 1280×720 is a contain-fitted safe box (ui/layout.ts): on a 19.5:9 phone
 * ~139 design px per side of real screen sit outside it, and on a 4:3 tablet
 * ~90 px above and below. Anything asked to cover the whole design box is
 * therefore re-fitted to the box GROWN BY the live overhang, and re-fitted
 * again whenever the window resizes or the phone rotates — that overhang is
 * what used to be black letterbox.
 *
 * Smaller rects (a panel-sized backdrop, a card wash) are laid out exactly as
 * asked and never subscribe.
 */
function bleedFit(
  view: Container,
  w: number,
  h: number,
  fit: (r: Rect) => void,
): void {
  // `>=` not `===`: battle's backdrop asks for the design box plus its
  // parallax margin, and it is still a full-screen backdrop.
  if (w < DESIGN_W || h < DESIGN_H) {
    fit([0, 0, w, h]);
    return;
  }
  const apply = (): void => {
    const [, , bw, bh] = bleedRect();
    const dx = (bw - DESIGN_W) / 2;
    const dy = (bh - DESIGN_H) / 2;
    fit([-dx, -dy, w + dx * 2, h + dy * 2]);
  };
  apply();
  const off = onViewBleed(apply);
  // The subscription outlives nothing: scenes destroy their whole view on
  // unmount, and pixi fires 'destroyed' for every child of that tree.
  view.on("destroyed", off);
}

/**
 * Cheap edge darkening for full-screen art — concentric PAL.void strokes,
 * one Graphics, no filters. `strength` 0..1 (default 0.6). Never eats input.
 * Full-screen vignettes hug the REAL screen edge, not the safe-area edge.
 */
export function vignette(w: number, h: number, strength = 0.6): Container {
  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  view.eventMode = "none";
  bleedFit(view, w, h, ([x, y, fw, fh]) => {
    g.clear();
    const steps = 12;
    const band =
      Math.max(4, Math.round(Math.min(fw, fh) / 14 / steps) * steps) / 2;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const inset = i * band;
      g.rect(x + inset, y + inset, fw - inset * 2, fh - inset * 2).stroke({
        width: band,
        color: PAL.void,
        alpha: clamp01(strength) * 0.1 * (1 - t) * (1 - t),
        alignment: 0,
      });
    }
  });
  return view;
}

/**
 * Flat modal scrim (ui-art §9): PAL.scrim over the whole screen — the WHOLE
 * screen, bleed included, or a modal would leave two bright undimmed bands
 * beside it on a phone. Callers keep the `Graphics` they always got.
 *
 * `color` exists for the washes that are not modal scrims — the title's
 * poster dim is PAL.bgDeep — so they get the same bleed instead of each
 * hand-rolling a design-sized rect, which leaves a hard seam at the
 * safe-area edge on any aspect wider than 16:9.
 */
export function scrim(
  w: number,
  h: number,
  alpha = 0.6,
  color: number = PAL.scrim,
): Graphics {
  const g = new Graphics();
  bleedFit(g, w, h, ([x, y, fw, fh]) => {
    g.clear().rect(x, y, fw, fh).fill({ color, alpha });
  });
  return g;
}

/**
 * Vertical PAL.bgDeep → PAL.void wash, drawn as `steps` bands (no gradient
 * fill needed). The fallback under every scene backdrop.
 */
function paintWash(g: Graphics, [x, y, w, h]: Rect, steps = 16): void {
  g.clear();
  const bh = Math.ceil(h / steps);
  for (let i = 0; i < steps; i++) {
    g.rect(x, y + i * bh, w, bh + 1).fill(mix(PAL.bgDeep, PAL.void, i / steps));
  }
}

export interface BackdropOpts {
  /** 0..1 PAL.bgDeep wash over the art for text readability. */
  dim?: number;
  /** Blur the art (core BlurFilter; silently skipped if unavailable). */
  blur?: boolean;
  /**
   * Where the vertical overflow is taken from when cover-fitting: 0 keeps the
   * top of the art, 0.5 centres (the default), 1 keeps the bottom.
   *
   * Cover-fit on a very wide viewport crops height, and centring that crop
   * decapitates art whose subject sits high in the frame — which is exactly
   * the title hero. Biasing toward the top keeps the cast's heads.
   */
  anchorY?: number;
}

/**
 * THE screen backdrop: cover-fit a generated `scene:*` texture over w×h with
 * an optional dim wash, over a palette gradient that also serves as the
 * fallback when the texture is missing (scene art lands incrementally — a
 * missing id is normal, never an error).
 *
 * A backdrop asked to cover the whole design box covers the whole SCREEN
 * instead (`bleedFit`): the art keeps its aspect and grows past the safe area
 * into the overhang, so a 19.5:9 phone shows painted alley instead of two
 * black bars. Generated scene art is 1600×900 against a 1280×720 box, so
 * there is real image out there to show — and the wash underneath covers the
 * corners at any aspect regardless.
 *
 * The overhang is decoration only. Nothing interactive is ever placed there;
 * every rect in ui/layout.ts stays inside 1280×720.
 */
export function sceneBackdrop(
  id: string,
  w: number,
  h: number,
  opts: BackdropOpts = {},
): Container {
  const view = new Container();
  const wash = new Graphics();
  view.addChild(wash);

  const tex = spriteTextureFor(id);
  const art =
    tex && tex.width > 0 && tex.height > 0
      ? new Sprite({ texture: tex })
      : null;
  if (art) {
    if (opts.blur === true) {
      try {
        art.filters = [new BlurFilter({ strength: 8, quality: 2 })];
      } catch {
        /* blur is decoration only — never let it break the screen */
      }
    }
    view.addChild(art);
  }
  // The dim rides over the art (it was baked into the cover sprite before)
  // and, with no art, over the bare wash — same two cases as before.
  const dim =
    opts.dim !== undefined && opts.dim > 0
      ? view.addChild(new Graphics())
      : null;

  bleedFit(view, w, h, (r) => {
    paintWash(wash, r);
    const [x, y, fw, fh] = r;
    if (art && tex) {
      // COVER: fill the rect, keep the aspect, centre the overflow. No mask
      // — the canvas edge is the only crop that matters out here.
      const s = Math.max(fw / tex.width, fh / tex.height);
      art.scale.set(s);
      const ay = Math.min(1, Math.max(0, opts.anchorY ?? 0.5));
      art.position.set(
        x + (fw - tex.width * s) / 2,
        y + (fh - tex.height * s) * ay,
      );
    }
    if (dim) {
      dim
        .clear()
        .rect(x, y, fw, fh)
        .fill({ color: PAL.bgDeep, alpha: opts.dim ?? 0 });
    }
  });

  view.eventMode = "none";
  return view;
}
