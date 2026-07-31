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
 *   enemyAvatar(speciesId, size, opts) the one enemy face
 *   bar(w, h, { kind })                the one HP/Energy/XP/Poise bar
 *   heading(text, level) / label(text) the one type scale
 *   button(label, w, h, onTap, opts)   the one interactive button
 *   vignette / scrim / sceneBackdrop   cheap full-screen atmosphere
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
import { RADIUS, SPACE, WRAP } from "./layout.js";
import {
  TYPE,
  headingStyle,
  labelStyle,
  mono,
  ui,
  type LabelOpts,
} from "./textStyles.js";
import { tween } from "./tween.js";
import { drawCatPortrait, drawPaw } from "./draw/cats.js";
import { drawEnemy } from "./draw/enemies.js";
import { enemyTexture, portraitTexture, spriteTextureFor } from "./sprites.js";

/** Status chip glyphs + fills (ui-art §2). */
export const STATUS_STYLE: Record<StatusId, { glyph: string; color: number }> =
  {
    scratched: { glyph: "/", color: PAL.stScratched },
    frazzled: { glyph: "z", color: PAL.stFrazzled },
    offBalance: { glyph: "!", color: PAL.stOffBal },
    guarded: { glyph: "O", color: PAL.stGuarded },
    provoked: { glyph: ">", color: PAL.stProvoked },
    mending: { glyph: "+", color: PAL.stMending },
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

/**
 * Status chip (ui-art §6): 16×16 rounded-rect r 4, status-colored fill, 1px
 * darkened outline, MONO-12 glyph. Scratched/Mending show their stacked
 * value as a 9px numeral bottom-right.
 */
export function makeStatusChip(id: StatusId, value?: number): Container {
  const { glyph, color } = STATUS_STYLE[id];
  const chip = new Container();
  chip.addChild(
    new Graphics()
      .roundRect(0, 0, 16, 16, RADIUS.chip)
      .fill(color)
      .stroke({ width: 1, color: darken(color) }),
  );
  const g = new Text({ text: glyph, style: mono(12) });
  g.anchor.set(0.5);
  g.position.set(8, 8);
  chip.addChild(g);
  if (value !== undefined && (id === "scratched" || id === "mending")) {
    const v = new Text({ text: String(value), style: mono(9) });
    v.anchor.set(1, 1);
    v.position.set(16, 17);
    chip.addChild(v);
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
}

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
  const tex = enemyTexture(speciesId);
  if (tex && tex.width > 0 && tex.height > 0) {
    const sp = new Sprite({ texture: tex, anchor: 0.5 });
    sp.scale.set(size / Math.min(tex.width, tex.height));
    if (opts.dead === true) sp.tint = mix(PAL.textDim, PAL.void, 0.1);
    content.addChild(sp);
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
  if (opts.hotkey !== undefined && opts.hotkey !== "") {
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
  view.on("pointerover", () => {
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
/* Atmosphere: vignette / scrim / sceneBackdrop                            */
/* ---------------------------------------------------------------------- */

/**
 * Cheap edge darkening for full-screen art — concentric PAL.void strokes,
 * one Graphics, no filters. `strength` 0..1 (default 0.6). Never eats input.
 */
export function vignette(w: number, h: number, strength = 0.6): Container {
  const view = new Container();
  const g = new Graphics();
  const steps = 12;
  const band = Math.max(4, Math.round(Math.min(w, h) / 14 / steps) * steps) / 2;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const inset = i * band;
    g.rect(inset, inset, w - inset * 2, h - inset * 2).stroke({
      width: band,
      color: PAL.void,
      alpha: clamp01(strength) * 0.1 * (1 - t) * (1 - t),
      alignment: 0,
    });
  }
  view.addChild(g);
  view.eventMode = "none";
  return view;
}

/** Flat modal scrim (ui-art §9): PAL.scrim over the whole screen. */
export function scrim(w: number, h: number, alpha = 0.6): Graphics {
  return new Graphics().rect(0, 0, w, h).fill({ color: PAL.scrim, alpha });
}

/**
 * Vertical PAL.bgDeep → PAL.void wash, drawn as `steps` bands (no gradient
 * fill needed). The fallback under every scene backdrop.
 */
function paletteWash(w: number, h: number, steps = 16): Graphics {
  const g = new Graphics();
  const bh = Math.ceil(h / steps);
  for (let i = 0; i < steps; i++) {
    g.rect(0, i * bh, w, bh + 1).fill(mix(PAL.bgDeep, PAL.void, i / steps));
  }
  return g;
}

export interface BackdropOpts {
  /** 0..1 PAL.bgDeep wash over the art for text readability. */
  dim?: number;
  /** Blur the art (core BlurFilter; silently skipped if unavailable). */
  blur?: boolean;
}

/**
 * THE screen backdrop: cover-fit a generated `scene:*` texture over w×h with
 * an optional dim wash, over a palette gradient that also serves as the
 * fallback when the texture is missing (scene art lands incrementally — a
 * missing id is normal, never an error).
 */
export function sceneBackdrop(
  id: string,
  w: number,
  h: number,
  opts: BackdropOpts = {},
): Container {
  const view = new Container();
  view.addChild(paletteWash(w, h));

  const tex = spriteTextureFor(id);
  if (tex && tex.width > 0 && tex.height > 0) {
    const art = makeCoverSprite(id, w, h, { dim: opts.dim });
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
  } else if (opts.dim !== undefined && opts.dim > 0) {
    view.addChild(
      new Graphics()
        .rect(0, 0, w, h)
        .fill({ color: PAL.bgDeep, alpha: opts.dim }),
    );
  }
  view.eventMode = "none";
  return view;
}
