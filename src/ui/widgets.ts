/**
 * WP-08 — shared HUD widgets (ui-art §6): bars, energy pips, status chips,
 * hotkey chips, buttons, panels, tooltips, paw-pip rows. Pure presentation:
 * widgets are fed values; they never compute gameplay outcomes.
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { StatusId } from "../core/types";
import { PAL, darken, hpColor } from "./palette";
import { RADIUS, WRAP } from "./layout";
import { mono, ui } from "./textStyles";
import { tween } from "./tween";
import { drawPaw } from "./draw/cats";
import { spriteTextureFor } from "./sprites";

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
        // classic chip-away: PAL.text ghost lingers 300ms then shrinks
        ghost.scale.x = prev;
        setTimeout(() => tween(ghost.scale, { x: frac }, 200), 300);
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
