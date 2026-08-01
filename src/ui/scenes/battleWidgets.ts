/**
 * WP-11 / visual-v3 — the battle STAGE plus every battle HUD widget
 * (ui-art §8). Two halves:
 *
 *  1. THE STAGE (`makeBattleStage`) — a painted `scene:battle:<floor>`
 *     backdrop when the art pack has one, a layered procedural stage when it
 *     does not (atmosphere gradient, lit back wall with arches, warm key
 *     light, near silhouettes, textured ground plane). On top of either:
 *     a colour grade so backdrops never fight the sprites, readability
 *     washes behind the top/bottom HUD, a vignette, and a grounded floor
 *     plane with a warm stage pool. The backdrop drifts on a slow sine and
 *     is NOT shaken with the world layer — that difference is the parallax.
 *
 *  2. THE HUD — turn-order strip, skill cards, active-cat panel, banners,
 *     nameplates, targeting previews. All chrome comes from the shared kit
 *     in `../widgets` (`panel`, `avatar`, `bar`, `button`, `heading`,
 *     `label`), so the battle screen matches the rest of the game.
 *
 * Pure presentation: every widget is fed engine state / values and never
 * computes a gameplay outcome. Visual randomness is a UI-local LCG seeded by
 * the floor number (never a gameplay Rng — ARCHITECTURE.md §0) so a given
 * floor's fallback stage is byte-identical on every mount.
 */
import { Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type {
  BattleState,
  Combatant,
  DeclaredIntent,
  Skill,
  StatusId,
} from "../../core/types.js";
import type { KnownIntel } from "../../core/meta/bestiary.js";
import { ENEMIES } from "../../content/enemies.js";
import { PAL, THEMES, darken, mix } from "../palette.js";
import { DESIGN_H, DESIGN_W, R, RADIUS, SPACE, rh, rw } from "../layout.js";
import { TYPE, mono, ui } from "../textStyles.js";
import { tween } from "../tween.js";
import { isTouch, padHit, tapAct } from "../touch.js";
import {
  avatar,
  bar,
  button,
  enemyAvatar,
  heading,
  iconTile,
  label,
  makeHotkeyChip,
  makePawRow,
  makeStatusChip,
  panel,
  statusGlyph,
  vignette,
  sceneBackdrop,
  STATUS_STYLE,
  type Button,
  type ValueBar,
} from "../widgets.js";
import {
  drawEliteRing,
  makeHeavyGlyph,
  makeTierChevrons,
} from "../draw/enemies.js";
import {
  INTENT_VISUAL,
  intentSentence,
  makeIntelBlock,
  makeIntentBadge,
  makeLevelChip,
  makeTierPill,
  type IntentBadge,
} from "../draw/intel.js";
import { hasSprite, spriteTextureFor } from "../sprites.js";

/* ---------------------------------------------------------------------- */
/* Small shared helpers                                                    */
/* ---------------------------------------------------------------------- */

const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

/** Tile theme for a floor (floors 1-2 / 3-4 / 5-6). */
export function themeFor(floorNum: number): (typeof THEMES)[number] {
  return THEMES[clamp(Math.floor((floorNum - 1) / 2), 0, THEMES.length - 1)];
}

/**
 * Deterministic UI-only noise. NOT a gameplay Rng (ARCHITECTURE.md §0) — it
 * only ever places decorative silhouettes, and being seeded keeps the
 * fallback stage identical across mounts and CI screenshots.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Trim `t` with an ellipsis until it fits `maxW`. */
function fitText(t: Text, maxW: number): void {
  if (t.width <= maxW) return;
  const src = t.text;
  for (let n = src.length - 1; n > 0; n--) {
    t.text = `${src.slice(0, n).trimEnd()}…`;
    if (t.width <= maxW) return;
  }
  t.text = "…";
}

/**
 * Ellipsise a 「BRACKETED」 name at WORD boundaries, keeping both brackets.
 * Deliberate truncation — "「THE DUMPSTER…」", never "「THE DUMPST…」".
 */
function fitWords(t: Text, name: string, maxW: number): void {
  const words = name.split(/\s+/).filter((s) => s.length > 0);
  for (let n = words.length - 1; n >= 1; n--) {
    t.text = `「${words.slice(0, n).join(" ")}…」`;
    if (t.width <= maxW) return;
  }
  // a single word that still will not fit: fall back to a character trim
  fitText(t, maxW);
}

/* ---------------------------------------------------------------------- */
/* 1. THE STAGE                                                            */
/* ---------------------------------------------------------------------- */

/** Off-screen slack on every side so the backdrop can drift without gaps. */
const PARALLAX = 16;

export interface BattleStage {
  /** `bg` layer: backdrop art (or fallback), grade, HUD washes, vignette. */
  back: Container;
  /** `world` layer, UNDER the units: ground lip + warm stage pool. */
  ground: Container;
  /** true when a painted `scene:battle:<floor>` texture was found. */
  painted: boolean;
  /** Parallax drift + light breathing. Call once per frame. */
  update(elapsedMs: number): void;
}

/**
 * The procedural stage used when `scene:battle:<floor>` is absent — a real
 * designed background, never the old grey placeholder moon: atmosphere
 * gradient, a lit brick back wall with three arches, a warm key light from
 * the right, near-black clutter silhouettes flanking the fight, and a
 * textured perspective floor.
 */
function fallbackBackdrop(w: number, h: number, floorNum: number): Container {
  const theme = themeFor(floorNum);
  const gy = R.combat.groundY + PARALLAX; // ground line in local space
  const view = new Container();
  const rnd = lcg(floorNum * 9176 + 31);

  // ONE explicit value ladder, darkest → lightest. Everything below picks a
  // tone off this ladder, which is what stops the stage reading as fog.
  const vDeep = PAL.void; // ceiling, arch voids, near clutter
  const vWall = mix(theme.wallFace, theme.wallTop, 0.3); // the back wall
  const vMortar = mix(vWall, PAL.sheen, 0.14); // lit masonry edges
  const vFloorFar = mix(theme.floorA, PAL.void, 0.45);
  const vFloorNear = mix(theme.floorA, theme.wallTop, 0.34); // the lit stage
  const vKey = mix(theme.accent, PAL.gold, 0.55);

  /* -- ceiling / atmosphere: deepest tone, fading toward the wall ------ */
  const wallTop = gy - 330;
  const air = new Graphics();
  const bands = 18;
  const bh = Math.ceil(wallTop / bands) + 1;
  for (let i = 0; i < bands; i++) {
    air
      .rect(0, i * bh, w, bh + 1)
      .fill(mix(vDeep, vWall, Math.pow(i / (bands - 1), 1.6) * 0.8));
  }
  view.addChild(air);

  /* -- back wall: big readable masonry with LIT mortar ----------------- */
  const wall = new Graphics();
  wall.rect(0, wallTop, w, gy - wallTop).fill(vWall);
  const course = 34;
  for (let y = wallTop; y < gy; y += course) {
    wall
      .moveTo(0, y)
      .lineTo(w, y)
      .stroke({ width: 2, color: vMortar, alpha: 0.4 });
    wall
      .moveTo(0, y + 2)
      .lineTo(w, y + 2)
      .stroke({ width: 2, color: vDeep, alpha: 0.45 });
    const off = Math.round((y - wallTop) / course) % 2 === 0 ? 0 : 42;
    for (let x = off; x < w; x += 84) {
      wall
        .moveTo(x, y)
        .lineTo(x, Math.min(gy, y + course))
        .stroke({ width: 2, color: vDeep, alpha: 0.35 });
    }
  }
  // arches: holes punched into the wall, with a lit rim on the key side
  for (let i = 0; i < 3; i++) {
    const ax = w * (0.2 + i * 0.3) + (rnd() - 0.5) * 40;
    const ar = 54 + rnd() * 20;
    const ah = 170 + rnd() * 50;
    const arch = (): void => {
      wall
        .moveTo(ax - ar, gy)
        .lineTo(ax - ar, gy - ah + ar)
        .arc(ax, gy - ah + ar, ar, Math.PI, 0)
        .lineTo(ax + ar, gy)
        .closePath();
    };
    arch();
    wall.fill(vDeep);
    arch();
    wall.stroke({ width: 4, color: vMortar, alpha: 0.45 });
  }
  view.addChild(wall);

  /* -- warm key light: on the wall, low and to one side ---------------- */
  const key = new Graphics();
  for (let i = 12; i >= 1; i--) {
    const t = i / 12;
    key
      .ellipse(w * 0.76, gy - 120, 320 * t, 190 * t)
      .fill({ color: vKey, alpha: 0.014 });
  }
  key.blendMode = "add";
  view.addChild(key);

  /* -- ground plane: lighter than the wall, so units read as silhouettes */
  const floor = new Graphics();
  floor.rect(0, gy - 8, w, 10).fill({ color: vDeep, alpha: 0.6 }); // horizon seam
  let y = gy;
  let step = 5;
  let row = 0;
  while (y < h) {
    const hh = Math.min(step, h - y);
    const d = Math.min(1, (y - gy) / 170); // 0 far → 1 near
    floor
      .rect(0, y, w, hh + 1)
      .fill(mix(vFloorFar, vFloorNear, d * (row % 2 === 0 ? 1 : 0.9)));
    y += hh;
    step *= 1.28;
    row++;
  }
  // flagstone joints, widening with distance from the horizon
  for (let j = 0, jy = gy + 26; jy < h; j++) {
    floor
      .moveTo(0, jy)
      .lineTo(w, jy)
      .stroke({ width: 1, color: vDeep, alpha: 0.35 });
    const span = 90 + j * 46;
    for (let x = (j % 2 === 0 ? 0 : span / 2) - span; x < w + span; x += span) {
      floor
        .moveTo(x, jy)
        .lineTo(x - (x - w / 2) * 0.14, jy + span * 0.42)
        .stroke({ width: 1, color: vDeep, alpha: 0.28 });
    }
    jy += span * 0.42;
  }
  for (let s = 0; s < 200; s++) {
    const sy = gy + Math.pow(rnd(), 0.55) * (h - gy);
    const sz = 1 + (sy - gy) / 140;
    floor
      .rect(rnd() * w, sy, sz * (1 + rnd() * 2), Math.max(1, sz * 0.7))
      .fill({
        color: rnd() < 0.5 ? vDeep : vMortar,
        alpha: 0.14 + rnd() * 0.18,
      });
  }
  // the key light spills onto the plane it comes from
  for (let i = 9; i >= 1; i--) {
    const t = i / 9;
    floor
      .ellipse(w * 0.76, gy + 60, 430 * t, 95 * t)
      .fill({ color: vKey, alpha: 0.013 });
  }
  view.addChild(floor);

  /* -- near silhouettes: the deepest tone, flanking the fight ---------- */
  const near = new Graphics();
  for (let i = 0; i < 3; i++) {
    near
      .roundRect(-20, 18 + i * 32 + rnd() * 12, w + 40, 16 + rnd() * 12, 9)
      .fill(vDeep);
  }
  for (const base of [40, 126, 216, w - 40, w - 130, w - 222]) {
    const cx = base + (rnd() - 0.5) * 26;
    const cw = 66 + rnd() * 74;
    const ch = 64 + rnd() * 96;
    near.rect(cx - cw / 2, gy - ch, cw, ch + 14).fill(vDeep);
    near
      .moveTo(cx - cw / 2 + 6, gy - ch + 6)
      .lineTo(cx + cw / 2 - 6, gy - 4)
      .stroke({ width: 2, color: vMortar, alpha: 0.18 });
    near
      .moveTo(cx - cw / 2, gy - ch)
      .lineTo(cx + cw / 2, gy - ch)
      .stroke({ width: 2, color: vMortar, alpha: 0.22 });
  }
  view.addChild(near);

  return view;
}

/** Darkening behind the top (turn order) and bottom (log + skills) HUD. */
function hudWash(): Graphics {
  const g = new Graphics();
  const top = 108;
  for (let i = 0; i < 10; i++) {
    g.rect(0, 0, DESIGN_W, top * (1 - i / 10)).fill({
      color: PAL.void,
      alpha: 0.05,
    });
  }
  const bottom = 520;
  for (let i = 0; i < 12; i++) {
    const y = bottom + ((DESIGN_H - bottom) * i) / 12;
    g.rect(0, y, DESIGN_W, DESIGN_H - y).fill({
      color: PAL.void,
      alpha: 0.045,
    });
  }
  g.eventMode = "none";
  return g;
}

/**
 * THE battle stage. Give it the floor number; add `back` to the `bg` layer
 * and `ground` to the `world` layer BEFORE any unit, then call `update`
 * every frame.
 */
export function makeBattleStage(
  floorNum: number,
  opts: { elite?: boolean } = {},
): BattleStage {
  const theme = themeFor(floorNum);
  // An elite is an AMBUSH, not another room on the floor: it gets the one
  // shared `scene:elite` chokepoint (claw-gouged walls, hanging spiked
  // collar, violet grate light) instead of the floor's own backdrop, so the
  // fight reads as more dangerous before a single intent is declared.
  // Fail-soft in the usual way — no elite art means the floor backdrop.
  const id =
    opts.elite === true && hasSprite("scene:elite")
      ? "scene:elite"
      : `scene:battle:${floorNum}`;
  const painted = hasSprite(id);
  const W = DESIGN_W + PARALLAX * 2;
  const H = DESIGN_H + PARALLAX * 2;

  const back = new Container();
  const drift = new Container();
  drift.addChild(
    painted
      ? sceneBackdrop(id, W, H, { dim: 0.14 })
      : fallbackBackdrop(W, H, floorNum),
  );
  drift.position.set(-PARALLAX, -PARALLAX);
  back.addChild(drift);

  // colour grade — one cool wash + one theme tint so painted backdrops of
  // any brightness sit BEHIND the sprites instead of competing with them
  const grade = new Graphics();
  grade
    .rect(0, 0, DESIGN_W, DESIGN_H)
    .fill({ color: PAL.bgDeep, alpha: painted ? 0.26 : 0.12 });
  grade
    .rect(0, 0, DESIGN_W, DESIGN_H)
    .fill({ color: theme.wallTop, alpha: 0.06 });
  back.addChild(grade);

  back.addChild(hudWash());
  back.addChild(vignette(DESIGN_W, DESIGN_H, painted ? 0.85 : 0.7));
  back.eventMode = "none";

  /* -- world-layer floor: the lip the units stand on + a warm pool ---- */
  const gy = R.combat.groundY;
  const ground = new Container();

  const lip = new Graphics();
  for (let i = 7; i >= 1; i--) {
    lip
      .rect(0, gy - i * 2, DESIGN_W, i * 4)
      .fill({ color: PAL.sheen, alpha: 0.008 });
  }
  lip
    .moveTo(0, gy)
    .lineTo(DESIGN_W, gy)
    .stroke({ width: 1, color: PAL.sheen, alpha: 0.09 });
  lip.rect(0, gy + 1, DESIGN_W, 56).fill({ color: PAL.void, alpha: 0.16 });

  const pool = new Graphics();
  for (let i = 11; i >= 1; i--) {
    const t = i / 11;
    pool
      .ellipse(700, gy - 8, 640 * t, 128 * t)
      .fill({ color: mix(PAL.gold, PAL.text, 0.4), alpha: 0.011 });
  }
  pool.blendMode = "add";

  ground.addChild(lip, pool);
  ground.eventMode = "none";

  return {
    back,
    ground,
    painted,
    update(elapsedMs: number): void {
      const t = elapsedMs / 1000;
      drift.x = -PARALLAX + Math.sin(t * 0.19) * 7;
      drift.y = -PARALLAX + Math.sin(t * 0.13 + 1.1) * 4;
      pool.alpha = 0.85 + 0.15 * Math.sin(t * 0.85);
    },
  };
}

/* ---------------------------------------------------------------------- */
/* The two sides of the field + the no-man's-land between them             */
/* ---------------------------------------------------------------------- */

export interface FieldZones {
  view: Container;
  /** Slow breathing on the centre line so it reads as live, not printed. */
  update(elapsedMs: number): void;
}

/**
 * WHOSE HALF IS WHOSE (enemy-intel.md §5 readability, Darkest Dungeon's
 * rank-legibility lesson). Before this the four-to-nine units read as one
 * crowd: nothing on the stage said where the party ended and the enemy pack
 * began.
 *
 * Three cheap, non-competing cues, all on the floor plane so they never fight
 * the sprites:
 *  - a cool (cat) and a warm (enemy) ground wash, each hugging only its own
 *    ranks, with a bright edge line under the units;
 *  - a DARKENED neutral column between them — the no-man's-land is literally
 *    unlit, which is what makes both formations pop;
 *  - a dashed centre line with facing chevrons, so the divide survives even
 *    when the washes are lost to a bright painted backdrop.
 *
 * Takes world x extents, not ranks: only the scene knows where rank 3 is.
 */
export function makeFieldZones(
  catFrom: number,
  catTo: number,
  foeFrom: number,
  foeTo: number,
): FieldZones {
  const gy = R.combat.groundY;
  const view = new Container();
  const g = new Graphics();

  const pad = 74;
  const zone = (x0: number, x1: number, color: number): void => {
    const a = Math.max(6, x0 - pad);
    const b = Math.min(DESIGN_W - 6, x1 + pad);
    const w = b - a;
    const cx = (a + b) / 2;
    // soft elliptical pool of the side's colour, stacked for a feathered edge
    for (let i = 10; i >= 1; i--) {
      const t = i / 10;
      g.ellipse(cx, gy + 6, (w / 2) * t, 54 * t).fill({ color, alpha: 0.055 });
    }
    // The lit edge the units stand on, drawn as segments that fade out toward
    // both ends. (An arrowhead cap was the first draft and it read as a stray
    // UI arrow parked on the floor.)
    const SEG = 22;
    for (let x = a; x < b; x += SEG) {
      const t = (x - a) / Math.max(1, w);
      const fade = Math.min(1, Math.sin(Math.PI * t) * 1.9);
      g.moveTo(x, gy)
        .lineTo(Math.min(b, x + SEG), gy)
        .stroke({ width: 3, color, alpha: 0.6 * fade });
      g.moveTo(x, gy + 3)
        .lineTo(Math.min(b, x + SEG), gy + 3)
        .stroke({ width: 1, color: PAL.void, alpha: 0.5 * fade });
    }
  };
  zone(catFrom, catTo, PAL.energy);
  zone(foeFrom, foeTo, PAL.danger);

  // the unlit neutral column
  const mid = (catTo + foeFrom) / 2;
  const half = Math.max(40, (foeFrom - catTo) / 2);
  const dark = new Graphics();
  for (let i = 7; i >= 1; i--) {
    const t = i / 7;
    dark
      .rect(mid - half * t, gy - 230, half * 2 * t, 290)
      .fill({ color: PAL.void, alpha: 0.055 });
  }
  view.addChild(dark, g);

  // the line itself: dashed, ending in a floor lozenge with two facing
  // arrowheads — small, but the one hard edge that survives any backdrop
  const line = new Graphics();
  for (let y = gy - 196; y < gy - 12; y += 18) {
    line.moveTo(mid, y).lineTo(mid, Math.min(gy - 12, y + 9));
  }
  line.stroke({ width: 2, color: PAL.text, alpha: 0.16 });
  line
    .ellipse(mid, gy, 34, 11)
    .fill({ color: PAL.void, alpha: 0.4 })
    .stroke({ width: 1, color: PAL.text, alpha: 0.18 });
  for (const dir of [-1, 1]) {
    const c = dir < 0 ? PAL.energy : PAL.danger;
    line
      .poly([mid + dir * 8, gy - 7, mid + dir * 24, gy, mid + dir * 8, gy + 7])
      .fill({ color: c, alpha: 0.6 });
  }
  view.addChild(line);
  view.eventMode = "none";

  return {
    view,
    update(elapsedMs: number): void {
      line.alpha = 0.7 + 0.3 * Math.sin((elapsedMs / 1000) * 0.9);
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Threat highlight — "who is about to be hit, and for how much"           */
/* ---------------------------------------------------------------------- */

/** One declared attack, resolved to screen space by the scene. */
export interface ThreatLink {
  fromX: number;
  fromY: number;
  toX: number;
  /** ground y of the threatened unit (its feet) */
  toY: number;
  /** head y of the threatened unit, for the incoming chip */
  headY: number;
  color: number;
  /** expected damage summed over every intent aimed here (0 ⇒ no numeral) */
  incoming: number;
  /** the shove/status kind changes the chip's glyph */
  kind: "strike" | "shove" | "status";
  status?: StatusId;
}

export interface ThreatLayer {
  view: Container;
  set(links: readonly ThreatLink[]): void;
  update(elapsedMs: number): void;
}

/**
 * Into the Breach's core promise, at rank scale: the cost of NOT defending is
 * drawn, not implied. Each declared attack gets a tapered dashed line from the
 * attacker's badge down to a pulsing ground ring under its target, and every
 * threatened cat wears one chip totalling the damage aimed at it this round.
 */
export function makeThreatLayer(): ThreatLayer {
  const view = new Container();
  const lines = new Graphics();
  const rings = new Graphics();
  const chips = new Container();
  view.addChild(lines, rings, chips);
  view.eventMode = "none";
  let current: ThreatLink[] = [];

  const paint = (): void => {
    lines.clear();
    rings.clear();
    chips.removeChildren().forEach((c) => c.destroy({ children: true }));
    // one chip per TARGET, not per link: two rats on Bruno reads as one total
    const byTarget = new Map<number, ThreatLink[]>();
    for (const l of current) {
      const key = Math.round(l.toX);
      const arr = byTarget.get(key);
      if (arr) arr.push(l);
      else byTarget.set(key, [l]);
    }
    for (const l of current) {
      // dashed bezier-ish arc: sampled as short segments so it can taper
      const midX = (l.fromX + l.toX) / 2;
      // arc height scales with the span so a short link still bows visibly
      const midY =
        Math.min(l.fromY, l.headY) - 40 - Math.abs(l.toX - l.fromX) * 0.13;
      const N = 26;
      for (let i = 0; i < N; i += 2) {
        const t0 = i / N;
        const t1 = (i + 1) / N;
        const px = (t: number): number =>
          (1 - t) * (1 - t) * l.fromX + 2 * (1 - t) * t * midX + t * t * l.toX;
        const py = (t: number): number =>
          (1 - t) * (1 - t) * l.fromY +
          2 * (1 - t) * t * midY +
          t * t * (l.headY - 6);
        lines
          .moveTo(px(t0), py(t0))
          .lineTo(px(t1), py(t1))
          .stroke({
            width: 1.5 + 3.5 * t1,
            color: l.color,
            alpha: 0.85,
            cap: "round",
          });
      }
      // arrowhead planted on the target
      lines
        .poly([
          l.toX,
          l.headY,
          l.toX - 9,
          l.headY - 13,
          l.toX + 9,
          l.headY - 13,
        ])
        .fill({ color: l.color, alpha: 0.9 });
      rings
        .ellipse(l.toX, l.toY + 2, 50, 15)
        .stroke({ width: 3, color: l.color, alpha: 0.9 });
      rings
        .ellipse(l.toX, l.toY + 2, 50, 15)
        .fill({ color: l.color, alpha: 0.16 });
    }
    for (const [, group] of byTarget) {
      const first = group[0];
      const total = group.reduce((n, l) => n + l.incoming, 0);
      const shove = group.some((l) => l.kind === "shove");
      const st = group.find((l) => l.status)?.status;
      const parts: string[] = [];
      if (total > 0) parts.push(`▼ ${total}`);
      if (shove) parts.push("»»");
      if (st) parts.push(STATUS_STYLE[st].glyph);
      const chip = makePreviewChip(
        parts.length > 0 ? parts.join("  ") : "▼",
        first.color,
      );
      // above the arrowhead, and above the target's own status-chip row
      chip.position.set(first.toX, first.headY - 30);
      chips.addChild(chip);
    }
  };

  return {
    view,
    set(links: readonly ThreatLink[]): void {
      current = [...links];
      paint();
    },
    update(elapsedMs: number): void {
      const p = 0.55 + 0.45 * Math.abs(Math.sin((elapsedMs / 1000) * Math.PI));
      rings.alpha = p;
      lines.alpha = 0.65 + 0.35 * p;
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Unit presentation (readability: shadow, rim, glow, boss presence)       */
/* ---------------------------------------------------------------------- */

/** Soft elliptical contact shadow, drawn at a unit's feet origin. */
export function makeContactShadow(width: number, strength = 1): Graphics {
  const g = new Graphics();
  const steps = 7;
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    const k = 0.34 + t * 0.9;
    g.ellipse(0, 2, (width / 2) * k, (width / 6) * k).fill({
      color: PAL.void,
      alpha: 0.16 * strength * (1 - t * 0.5),
    });
  }
  g.eventMode = "none";
  return g;
}

/**
 * Soft light pad behind a unit so a dark silhouette still separates from a
 * dark backdrop. Additive, very low alpha — it reads as bounce light.
 */
export function makeUnitGlow(h: number, color: number, strength = 1): Graphics {
  const g = new Graphics();
  const steps = 9;
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    g.ellipse(
      0,
      -h * 0.46,
      h * 0.46 * t + h * 0.16,
      h * 0.56 * t + h * 0.12,
    ).fill({ color, alpha: 0.015 * strength });
  }
  g.blendMode = "add";
  g.eventMode = "none";
  return g;
}

/**
 * Dark rim behind a unit: `n` copies of its art offset around a small
 * circle and tinted near-black. Cheap silhouette separation with no filters
 * — it works for painted sprites and procedural Graphics alike.
 */
export function makeRim(
  make: () => Sprite | Graphics,
  radius = 3,
  alpha = 0.5,
  n = 6,
): Container {
  const view = new Container();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const copy = make();
    copy.position.set(
      copy.position.x + Math.cos(a) * radius,
      copy.position.y + Math.sin(a) * radius,
    );
    copy.tint = PAL.void;
    copy.alpha = alpha;
    view.addChild(copy);
  }
  view.eventMode = "none";
  return view;
}

export interface PresenceAura {
  view: Container;
  update(elapsedMs: number): void;
}

/**
 * Elite / boss presence: a gold ground ring plus an additive halo hugging
 * the body mass, both pulsing on the ui-art §5 1.2s loop. Bosses get the
 * bigger, brighter treatment.
 */
export function makePresenceAura(h: number, boss: boolean): PresenceAura {
  const view = new Container();
  const halo = new Graphics();
  const steps = 10;
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    halo
      .ellipse(0, -h * 0.44, h * 0.42 * t + 12, h * 0.55 * t + 12)
      .fill({ color: PAL.eliteRing, alpha: boss ? 0.014 : 0.007 });
  }
  halo.blendMode = "add";
  const ring = new Graphics();
  drawEliteRing(ring, boss ? 1.85 : 1.25);
  view.addChild(halo, ring);
  view.eventMode = "none";
  return {
    view,
    update(elapsedMs: number): void {
      const p = 0.5 + 0.5 * Math.sin(((elapsedMs / 1000) * Math.PI * 2) / 1.2);
      ring.alpha = 0.45 + 0.45 * p;
      halo.alpha = 0.65 + 0.35 * p;
    },
  };
}

/* ---------------------------------------------------------------------- */
/* 2. HUD — turn-order strip                                               */
/* ---------------------------------------------------------------------- */

const CHIP = 46;
const CHIP_GAP = 10;
const RIB_PAD = 10;

interface RibbonChip {
  entryIndex: number;
  combatantId: string;
  box: Container;
  plate: Graphics;
  ring: Graphics;
  wash: Graphics;
  frazzle: Container;
  intent: IntentBadge;
  collapsed: boolean;
}

/** Per-enemy telegraph the strip echoes, already masked for visibility. */
export type IntentMap = ReadonlyMap<string, DeclaredIntent | null>;

export interface Ribbon {
  view: Container;
  /** Rebuild all chips from the frozen round queue. */
  setRound(state: BattleState, intents?: IntentMap): void;
  /** Re-style: acted-dim, current-actor pop, frazzle glyphs, death collapse. */
  refresh(state: BattleState, intents?: IntentMap): void;
  /** Badge breathing — call once per frame. */
  update(elapsedMs: number): void;
}

/**
 * A `portrait:<speciesId>` chip face: the same cover-fit sprite behind the
 * same rounded mask `avatar()` gives a cat portrait, so a 34px enemy chip and
 * a 34px cat chip are the same picture-in-a-box.
 *
 * It is spelled out here rather than in `widgets` because preferring the
 * portrait is a TURN-STRIP rule: the bestiary plate and the 148px target
 * portrait have room for the whole creature and still want `enemyAvatar`'s
 * bust crop of the battle sprite. (`widgets` keeps its avatar shell private,
 * and its drop shadow is invisible under a chip that already draws its own
 * bordered plate.)
 */
function makeEnemyPortraitFace(
  tex: Texture,
  size: number,
  dead: boolean,
): Container {
  const half = size / 2;
  const r = Math.max(4, size * 0.2); // widgets' 'rounded' avatar radius
  const view = new Container();
  // backing plate: the portraits carry a transparent margin, so without this
  // the chip's own plate shows through the corners of the art
  view.addChild(
    new Graphics()
      .roundRect(-half, -half, size, size, r)
      .fill({ color: PAL.hpBack, alpha: 0.95 }),
  );
  const sp = new Sprite({ texture: tex, anchor: 0.5 });
  sp.scale.set(size / Math.min(tex.width, tex.height)); // cover-fit
  if (dead) sp.tint = mix(PAL.textDim, PAL.void, 0.1);
  const mask = new Graphics()
    .roundRect(-half, -half, size, size, r)
    .fill(0xffffff);
  sp.mask = mask;
  view.addChild(sp, mask);
  if (dead) {
    view.addChild(
      new Graphics()
        .roundRect(-half, -half, size, size, r)
        .fill({ color: PAL.void, alpha: 0.2 }),
    );
    view.alpha = 0.85;
  }
  return view;
}

/**
 * Kit avatar for a combatant (cat portrait / enemy face), fail-soft.
 *
 * Enemies and bosses ship the same head-and-shoulders `portrait:*` art the
 * cats do, and the strip prefers it. `enemyAvatar` otherwise squeezes a bust
 * crop of the full-body BATTLE sprite into a ~34px tile, which is what made
 * Crow Shaman and Yarn Golem read as brown smudges next to Bruno and Pixel.
 * A species with no portrait yet keeps that bust crop as the fallback.
 */
export function makeMiniPortrait(c: Combatant, size = 36): Container {
  const opts = { dead: c.ko, frame: false as const, shape: "rounded" as const };
  if (c.side === "cat" && c.classId) return avatar(c.classId, size, opts);
  const species = c.speciesId ?? "";
  const portrait = spriteTextureFor(`portrait:${species}`);
  return portrait && portrait.width > 0 && portrait.height > 0
    ? makeEnemyPortraitFace(portrait, size, c.ko)
    : enemyAvatar(species, size, opts);
}

/**
 * The turn-order queue. Reads left-to-right as a queue: the current unit is
 * scaled up, lifted and gold-ringed; already-acted units are washed out and
 * dimmed; upcoming units sit at a middle brightness; a divider then
 * "NEXT ROUND" closes the strip so the round boundary is explicit.
 */
export function makeRibbon(): Ribbon {
  const view = new Container();
  const h = rh(R.combat.ribbon);
  const maxW = rw(R.combat.ribbon);
  let plateHolder: Container | null = null;
  let chips: RibbonChip[] = [];
  let tail: Container | null = null;
  let tailW = 108;
  // The scene refreshes the strip from TWO places — the event animator (which
  // knows nothing about telegraphs) and the intent sync. Remembering the last
  // map means a plain `refresh(state)` restyles the chips without silently
  // wiping every badge off them.
  let lastIntents: IntentMap = new Map();

  const setPanelWidth = (contentW: number): void => {
    plateHolder?.destroy({ children: true });
    plateHolder = panel(Math.min(maxW, contentW), h, { variant: "glass" });
    view.addChildAt(plateHolder, 0);
  };

  const layout = (animate: boolean): void => {
    let x = RIB_PAD;
    for (const chip of chips) {
      if (chip.collapsed) continue;
      const cx = x + CHIP / 2;
      if (animate) tween(chip.box, { x: cx }, 150);
      else chip.box.x = cx;
      x += CHIP + CHIP_GAP;
    }
    if (tail) tail.x = x - CHIP_GAP / 2;
    setPanelWidth(x - CHIP_GAP / 2 + tailW + RIB_PAD);
  };

  const ribbon: Ribbon = {
    view,

    update(elapsedMs: number): void {
      for (const chip of chips) chip.intent.update(elapsedMs);
    },

    setRound(state: BattleState, intents?: IntentMap): void {
      view.removeChildren().forEach((c) => c.destroy({ children: true }));
      plateHolder = null;
      chips = [];
      tail = null;
      const perId: Record<string, number> = {};
      for (const e of state.queue) {
        perId[e.combatantId] = (perId[e.combatantId] ?? 0) + 1;
      }
      state.queue.forEach((entry, entryIndex) => {
        const c = state.combatants.find((x) => x.id === entry.combatantId);
        if (!c) return;
        const box = new Container();
        const plate = new Graphics();
        box.addChild(plate);
        const face = makeMiniPortrait(c, CHIP - 12);
        face.position.set(CHIP / 2, CHIP / 2);
        box.addChild(face);
        // side tab: a 3px colour bar telling cat rows from enemy rows
        const tab = new Graphics()
          .roundRect(6, CHIP - 6, CHIP - 12, 3, 1.5)
          .fill(c.side === "cat" ? PAL.energy : PAL.danger);
        tab.alpha = 0.9;
        box.addChild(tab);
        if ((perId[c.id] ?? 0) >= 2) {
          const tag = new Text({
            text: "×2",
            style: mono(TYPE.tiny, { fill: PAL.gold }),
          });
          tag.anchor.set(1, 1);
          tag.position.set(CHIP - 3, CHIP - 5);
          box.addChild(tag);
        }
        const wash = new Graphics()
          .roundRect(0, 0, CHIP, CHIP, RADIUS.button)
          .fill({ color: PAL.void, alpha: 0.55 });
        wash.visible = false;
        box.addChild(wash);
        const frazzle = new Container();
        // the painted glyph when the art pack has it, the MONO 'z' when not —
        // `statusGlyph` picks, so the strip can never disagree with the chip
        // on the unit's own head
        const fz = statusGlyph("frazzled", 18, { fill: PAL.stFrazzled });
        fz.position.set(CHIP / 2, CHIP / 2);
        frazzle.addChild(fz);
        frazzle.visible = false;
        box.addChild(frazzle);
        const ring = new Graphics()
          .roundRect(-3, -3, CHIP + 6, CHIP + 6, RADIUS.button + 3)
          .stroke({ width: 2, color: PAL.gold });
        ring.visible = false;
        box.addChild(ring);
        // the strip echoes each enemy's telegraph, so the whole ROUND reads
        // at a glance and not just the enemy you happen to be looking at
        // (enemy-intel.md §5)
        const intent = makeIntentBadge(0.38);
        intent.view.position.set(CHIP - 12, 11);
        box.addChild(intent.view);
        box.pivot.set(CHIP / 2, CHIP / 2);
        box.position.y = h / 2;
        view.addChild(box);
        chips.push({
          entryIndex,
          combatantId: c.id,
          box,
          plate,
          ring,
          wash,
          frazzle,
          intent,
          collapsed: false,
        });
      });

      // round boundary: divider + "NEXT ROUND" (order never shown, implied)
      tail = new Container();
      tail.addChild(
        new Graphics()
          .roundRect(0, (h - CHIP) / 2 + 2, 2, CHIP - 4, 1)
          .fill({ color: PAL.border, alpha: 0.9 }),
      );
      const next = label("NEXT ROUND", {
        size: TYPE.tiny,
        dim: true,
        bold: true,
      });
      next.anchor.set(0, 0.5);
      next.position.set(12, h / 2);
      tail.addChild(next);
      tailW = 12 + Math.ceil(next.width);
      view.addChild(tail);
      ribbon.refresh(state, intents);
      layout(false);
    },

    refresh(state: BattleState, intents?: IntentMap): void {
      if (intents) lastIntents = intents;
      const live = intents ?? lastIntents;
      let currentIndex = -1;
      for (let i = 0; i < state.queue.length; i++) {
        const entry = state.queue[i];
        const c = state.combatants.find((x) => x.id === entry.combatantId);
        if (!entry.acted && c && !c.ko && c.hp > 0) {
          currentIndex = i;
          break;
        }
      }
      let anyCollapsed = false;
      // A double-turn boss declares only its FIRST slot (enemy-intel.md §2's
      // authored uncertainty): its second entry must read `?`, not a copy of
      // the first, or the strip would promise a telegraph the engine has not
      // made.
      const declared = new Set<string>();
      for (const chip of chips) {
        const entry = state.queue[chip.entryIndex];
        const c = state.combatants.find((x) => x.id === chip.combatantId);
        if (!entry || !c) continue;
        const dead = c.ko || c.hp <= 0;
        if (dead && !chip.collapsed) {
          chip.collapsed = true;
          anyCollapsed = true;
          tween(chip.box.scale, { x: 0 }, 150);
        }
        if (chip.collapsed) continue;
        const current = chip.entryIndex === currentIndex;
        chip.box.alpha = entry.acted ? 0.42 : current ? 1 : 0.82;
        chip.wash.visible = entry.acted;
        chip.ring.visible = current;
        chip.frazzle.visible = c.statuses.some((s) => s.id === "frazzled");
        // a slot that has already acted no longer telegraphs anything
        const first = !declared.has(c.id);
        declared.add(c.id);
        chip.intent.set(
          entry.acted || c.side !== "enemy"
            ? null
            : first
              ? (live.get(c.id) ?? null)
              : {
                  id: c.id,
                  kind: "unknown",
                  value: 0,
                  round: state.round,
                },
        );
        const scale = current ? 1.2 : 1;
        tween(chip.box.scale, { x: scale, y: scale }, 120);
        tween(chip.box, { y: h / 2 - (current ? 4 : 0) }, 120);
        chip.plate
          .clear()
          .roundRect(0, 0, CHIP, CHIP, RADIUS.button)
          .fill({
            color: current
              ? PAL.panelLite
              : c.side === "cat"
                ? PAL.panel
                : mix(PAL.panel, PAL.void, 0.35),
            alpha: 0.96,
          })
          .stroke({
            width: 1,
            color: current ? PAL.gold : PAL.border,
            alignment: 1,
          });
      }
      if (anyCollapsed) layout(true);
    },
  };
  return ribbon;
}

/* ---------------------------------------------------------------------- */
/* Range strip (ui-art §8 skill bar): nine 8×8 squares + move glyphs       */
/* ---------------------------------------------------------------------- */

/**
 * Cat ranks 4..1 (gold when in `usableFrom`), a 4px gap, enemy/ally ranks
 * 1..5 (danger for enemy targets, heal for ally/self); `row` pattern
 * underlines the target half 2px. Move glyphs: `moveTarget` "→N"/"←N" in
 * PAL.offBal, `moveSelf` in PAL.energy.
 */
export function makeRangeStrip(skill: Skill): Container {
  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  const sq = 8;
  const gap = 2;
  let x = 0;
  for (let rank = 4; rank >= 1; rank--) {
    g.rect(x, 0, sq, sq).fill(
      skill.usableFrom.includes(rank) ? PAL.gold : PAL.hpBack,
    );
    x += sq + gap;
  }
  x += 4; // the gap glyph
  const targetColor = skill.target.side === "enemy" ? PAL.danger : PAL.heal;
  const targetX = x;
  for (let rank = 1; rank <= 5; rank++) {
    g.rect(x, 0, sq, sq).fill(
      skill.target.ranks.includes(rank) ? targetColor : PAL.hpBack,
    );
    x += sq + gap;
  }
  if (skill.target.pattern === "row") {
    g.rect(targetX, sq + 2, 5 * sq + 4 * gap, 2).fill(targetColor);
  }
  const arrow = (n: number, self: boolean): string => {
    // enemy-side push (+) moves right; a cat retreating (+) moves left
    const dir = self ? (n > 0 ? "←" : "→") : n > 0 ? "→" : "←";
    return `${dir}${Math.abs(n)}`;
  };
  const parts: { text: string; color: number }[] = [];
  if (skill.moveTarget) {
    parts.push({ text: arrow(skill.moveTarget, false), color: PAL.offBal });
  }
  if (skill.moveSelf) {
    parts.push({ text: arrow(skill.moveSelf, true), color: PAL.energy });
  }
  let tx = x + 4;
  for (const p of parts) {
    const t = new Text({ text: p.text, style: mono(11, { fill: p.color }) });
    t.position.set(tx, -1);
    view.addChild(t);
    tx += t.width + 4;
  }
  return view;
}

/* ---------------------------------------------------------------------- */
/* Skill bar (6 slots, hotkeys 1-6)                                        */
/* ---------------------------------------------------------------------- */

export interface SlotSpec {
  kind: "skill" | "guard" | "item";
  label: string;
  /** skill data drives cost pips + the range strip (guard/item: none). */
  skill?: Skill;
  cost?: number;
  ok: boolean;
  /** shown in the tooltip when disabled ("Needs rank 3–4 — …"). */
  reason?: string;
  /** the owner's Stand name, shown as the card's eyebrow line. */
  stand?: string;
  /**
   * Manifest id of the card's art tile. Skills pass `skill:<skillId>`, Guard
   * passes `status:guarded` (it is literally what the card applies) and the
   * belt slot passes the top consumable's `item:*`. Absent art (or an absent
   * id) simply means the pre-art full-width text layout.
   */
  icon?: string;
}

export interface SkillBar {
  view: Container;
  /** 6 entries, index = hotkey-1; null = empty slot. */
  set(slots: (SlotSpec | null)[]): void;
  setSelected(i: number | null): void;
  /** Wire before use; fired on slot click (enabled slots only). */
  onSlot: ((i: number) => void) | null;
  /** Design-space top-center of slot i (for the item flyout anchor). */
  slotTop(i: number): { x: number; y: number };
}

export function makeSkillBar(): SkillBar {
  const view = new Container();
  const barBg = panel(rw(R.combat.skillBar), rh(R.combat.skillBar), {
    variant: "solid",
  });
  barBg.position.set(R.combat.skillBar[0], R.combat.skillBar[1]);
  view.addChild(barBg);
  const slotViews: Container[] = [];
  let specs: (SlotSpec | null)[] = [];
  let selected: number | null = null;

  const bar: SkillBar = {
    view,
    onSlot: null,

    slotTop(i: number) {
      const r = R.combat.slotRects[i] ?? R.combat.slotRects[0];
      return { x: r[0] + r[2] / 2, y: r[1] };
    },

    set(next: (SlotSpec | null)[]): void {
      specs = next;
      for (const v of slotViews) v.destroy({ children: true });
      slotViews.length = 0;
      next.forEach((spec, i) => {
        const rect = R.combat.slotRects[i];
        if (!rect) return;
        const slot = buildSlot(spec, i, selected === i, () => {
          if (spec?.ok) bar.onSlot?.(i);
        });
        slot.position.set(rect[0], rect[1]);
        view.addChild(slot);
        slotViews.push(slot);
      });
    },

    setSelected(i: number | null): void {
      selected = i;
      bar.set(specs);
    },
  };
  return bar;
}

/**
 * One skill card (128×112).
 *
 * PRE-ART it reads straight down: hotkey + cost/cooldown, the Stand eyebrow,
 * the skill name across the full width, then the rank/range strip.
 *
 * WITH ART the middle band is re-cut into two columns rather than having an
 * icon shoved into the text: a 44px `iconTile` on the left at a FIXED
 * baseline (y 44 on all six cards, so the row of icons is a single scannable
 * column), the name beside it in the 58px that are left, auto-fitted from
 * 12px down so "TRASH COMPACTOR" never spills into the range strip. The
 * header row and the strip are untouched, so cost, cooldown and rank
 * legality stay exactly where a player's eye already knows to find them.
 *
 * No texture ⇒ the pre-art layout, verbatim.
 */
function buildSlot(
  spec: SlotSpec | null,
  index: number,
  selected: boolean,
  onTap: () => void,
): Container {
  const w = 128;
  const h = 112;
  const slot = new Container();
  slot.addChild(
    panel(w, h, {
      variant: spec?.ok === true ? "raised" : "solid",
      ...(selected ? { accent: PAL.gold } : {}),
    }),
  );
  if (!spec) {
    slot.alpha = 0.35;
    return slot;
  }
  if (!spec.ok) slot.alpha = 0.72;

  // hotkey chip
  const hk = makeHotkeyChip(String(index + 1), spec.ok);
  hk.view.position.set(SPACE.sm, SPACE.sm);
  slot.addChild(hk.view);

  // cost / cooldown, right-aligned on the hotkey row
  const cost = spec.kind === "skill" ? (spec.cost ?? 0) : 0;
  const cd = spec.skill?.cooldown ?? 0;
  const costRow = new Container();
  let cx = 0;
  if (spec.kind === "skill") {
    if (cost <= 0) {
      const free = label("FREE", { size: TYPE.tiny, dim: true, bold: true });
      costRow.addChild(free);
      cx = Math.ceil(free.width);
    } else {
      const pips = new Graphics();
      for (let i = 0; i < cost; i++) {
        pips.roundRect(i * 8, 3, 6, 11, 2).fill({
          color: spec.ok ? PAL.energy : PAL.textDim,
        });
      }
      costRow.addChild(pips);
      cx = cost * 8 - 2;
      const n = label(`${cost}`, {
        size: TYPE.tiny,
        mono: true,
        fill: PAL.energy,
      });
      n.position.set(cx + 3, 2);
      costRow.addChild(n);
      cx += 3 + Math.ceil(n.width);
    }
  }
  if (cd > 0) {
    const c = label(`⟳${cd}`, { size: TYPE.tiny, mono: true, dim: true });
    c.position.set(cx + 6, 2);
    costRow.addChild(c);
    cx += 6 + Math.ceil(c.width);
  }
  costRow.position.set(w - SPACE.sm - cx, SPACE.sm);
  slot.addChild(costRow);

  // Stand eyebrow — 「THE DUMPSTER KING」. The bracketed name is SIZED to fit
  // rather than chopped mid-word: shrink the type first (10 → 8px, still
  // legible at design scale), and only if the longest Stand name still
  // overflows drop whole words with an ellipsis. The old code measured the
  // bare name, then added 「」 afterwards, which is what pushed
  // "「THE DUMPST…」" past the card edge.
  if (spec.kind === "skill" && spec.stand !== undefined && spec.stand !== "") {
    // the eyebrow may use the full card width less its own left inset — it is
    // a single line with nothing to its right, and "「THE DUMPSTER KING」" needs
    // every pixel of it
    const room = w - SPACE.sm - SPACE.xs;
    const eyebrow = new Text({
      text: `「${spec.stand}」`,
      style: ui(10, {
        fontWeight: "bold",
        letterSpacing: 0.2,
        fill: spec.ok ? PAL.gold : PAL.goldDark,
      }),
    });
    for (let size = 10; size >= 7.5 && eyebrow.width > room; size -= 0.5) {
      eyebrow.style.fontSize = size;
    }
    if (eyebrow.width > room) fitWords(eyebrow, spec.stand, room);
    eyebrow.position.set(SPACE.sm, 30);
    slot.addChild(eyebrow);
  }

  // art tile + name. The tile is the card's anchor when it exists; without
  // one the name keeps the full width it has always had.
  const ART = 44;
  const ART_X = SPACE.sm;
  const ART_Y = 44;
  const tile =
    spec.icon !== undefined && spec.icon !== ""
      ? iconTile(spec.icon, ART, {
          dim: !spec.ok,
          ...(selected ? { accent: PAL.gold } : {}),
        })
      : null;
  if (tile) {
    tile.position.set(ART_X, ART_Y);
    slot.addChild(tile);
  }
  const nameX = tile ? ART_X + ART + 6 : SPACE.sm;
  const name = label(spec.label, {
    size: tile ? 12 : 13,
    bold: true,
    wrap: w - nameX - SPACE.sm,
    ...(spec.ok ? {} : { fill: PAL.textDim }),
  });
  if (tile) {
    // the two-column band is ART tall: shrink the type rather than let a
    // three-line name run into the range strip, then centre what is left
    // against the icon so a one-line and a two-line card look like siblings
    for (let size = 12; size >= 9 && name.height > ART; size -= 0.5) {
      name.style.fontSize = size;
    }
    name.position.set(nameX, ART_Y + Math.max(0, (ART - name.height) / 2));
  } else {
    name.position.set(nameX, 44);
  }
  slot.addChild(name);

  // bottom row: range strip for skills, a one-liner for guard/item
  if (spec.skill) {
    const strip = makeRangeStrip(spec.skill);
    strip.position.set(SPACE.sm, 92);
    if (!spec.ok) strip.alpha = 0.5;
    slot.addChild(strip);
  } else {
    const sub = label(
      spec.kind === "guard" ? "+2 energy" : "consumables",
      spec.kind === "guard"
        ? { size: TYPE.tiny, fill: PAL.energy }
        : { size: TYPE.tiny, dim: !spec.ok },
    );
    sub.position.set(SPACE.sm, 90);
    slot.addChild(sub);
  }

  // interaction + tooltip (reason for disabled slots, desc otherwise)
  slot.eventMode = "static";
  slot.cursor = spec.ok ? "pointer" : "default";
  padHit(slot, w, h);
  const tipText = spec.ok
    ? (spec.skill?.desc ?? "")
    : (spec.reason ?? "unavailable");
  if (!tipText) {
    slot.on("pointertap", onTap);
    return slot;
  }

  let tip: Container | null = null;
  const raise = (): void => {
    if (tip) return;
    const built = makeSlotTooltip(tipText);
    tip = built.view;
    tip.position.set(0, -built.height - 6);
    slot.addChild(tip);
  };
  const drop = (): void => {
    tip?.destroy({ children: true });
    tip = null;
  };
  slot.on("pointerover", () => {
    if (!isTouch()) raise();
  });
  slot.on("pointerout", () => {
    if (!isTouch()) drop();
  });
  /*
   * THE SAME RULE AS EVERYWHERE ELSE (docs/design/mobile.md §2): a tap picks
   * the skill, a long press reads its rules text without picking it. A card
   * is the thing you press every single turn, so it must never cost a
   * confirming tap — and the rules text is the one place a skill's actual
   * wording lives, so it must never be unreachable either.
   *
   * An UNUSABLE card has nothing to pick, so a tap simply toggles the reason
   * ("Needs rank 3-4 — Bruno is at rank 1") — the case where the text is
   * what you came for.
   */
  tapAct(slot, {
    ...(spec.ok ? { act: onTap } : {}),
    details: raise,
    hideDetails: drop,
    detailsShown: () => tip !== null,
    // the card is 128×112 and the tooltip hangs off its top edge; a ring
    // inside it reads as a smudge rather than as an acknowledgement
    ack: false,
  });
  return slot;
}

function makeSlotTooltip(text: string): { view: Container; height: number } {
  const view = new Container();
  const txt = label(text, { size: TYPE.small, wrap: 260 });
  const w = Math.ceil(txt.width) + SPACE.md * 2;
  const h = Math.ceil(txt.height) + SPACE.md;
  view.addChild(panel(w, h, { variant: "raised" }));
  txt.position.set(SPACE.md, SPACE.sm - 2);
  view.addChild(txt);
  return { view, height: h };
}

/* ---------------------------------------------------------------------- */
/* Active panel (408×128)                                                  */
/* ---------------------------------------------------------------------- */

export interface ActivePanel {
  view: Container;
  set(c: Combatant | null): void;
}

/**
 * The acting cat's readout: kit portrait with a gold "active" ring, name +
 * class eyebrow, kit HP and Energy bars with numerals, Lives paw row and
 * the live status chips.
 */
export function makeActivePanel(): ActivePanel {
  const view = new Container();
  const w = rw(R.combat.activePanel);
  const h = rh(R.combat.activePanel);
  view.addChild(panel(w, h, { variant: "solid", accent: PAL.gold }));
  const content = new Container();
  view.addChild(content);

  const COL = 128; // text column x
  const BAR_W = 176;

  return {
    view,
    set(c: Combatant | null): void {
      content.removeChildren().forEach((x) => x.destroy({ children: true }));
      view.visible = c !== null;
      if (!c || c.side !== "cat" || !c.classId) return;

      const face = avatar(c.classId, 88, {
        dead: c.ko,
        ring: PAL.gold,
        shape: "rounded",
      });
      face.position.set(SPACE.md + 44 + 2, h / 2);
      content.addChild(face);

      const name = heading(c.name, 3, { fill: PAL.text });
      name.position.set(COL, 12);
      content.addChild(name);
      const cls = label(c.classId, { size: TYPE.tiny, dim: true });
      cls.position.set(COL + Math.ceil(name.width) + SPACE.sm, 16);
      content.addChild(cls);

      const rowBar = (
        y: number,
        kind: "hp" | "energy",
        value: number,
        max: number,
      ): void => {
        const b: ValueBar = bar(BAR_W, 10, {
          kind,
          ...(kind === "energy" ? { ticks: Math.max(1, max) } : {}),
        });
        b.view.position.set(COL, y);
        b.set(value, max, false);
        content.addChild(b.view);
        const n = label(`${value}/${max}`, {
          size: TYPE.tiny,
          mono: true,
          fill: kind === "hp" ? PAL.text : PAL.energy,
        });
        n.position.set(COL + BAR_W + SPACE.sm, y - 3);
        content.addChild(n);
      };
      rowBar(40, "hp", c.hp, c.stats.hp);
      rowBar(60, "energy", c.energy, c.stats.enMax || 10);

      const paws = makePawRow(c.lives ?? 0);
      paws.view.position.set(COL, 82);
      content.addChild(paws.view);
      const livesTag = label("LIVES", { size: TYPE.tiny, dim: true });
      livesTag.position.set(COL + 9 * 8 + SPACE.sm, 80);
      content.addChild(livesTag);

      // status chips carry their duration AND explain themselves on hover/tap
      // (enemy-intel.md §5 — never a bare icon you have to have memorised)
      let sx = COL;
      for (const st of c.statuses) {
        const chip = makeStatusChip(st.id, st.value || undefined, {
          duration: st.duration,
          explain: true,
        });
        chip.position.set(sx, 100);
        content.addChild(chip);
        sx += 40;
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Round chip / flee button / log strip                                    */
/* ---------------------------------------------------------------------- */

export interface RoundChip {
  view: Container;
  set(round: number): void;
}

/** "ROUND 3" on a kit panel (ui-art §8 top-left). */
export function makeRoundChip(): RoundChip {
  const view = new Container();
  const [, , w, h] = R.combat.roundChip;
  view.addChild(panel(w, h, { variant: "glass", accent: PAL.gold }));
  const t = label("ROUND 1", { size: TYPE.small, bold: true, center: true });
  t.position.set(w / 2 + 2, h / 2);
  view.addChild(t);
  return {
    view,
    set(round: number): void {
      t.text = `ROUND ${round}`;
    },
  };
}

/** "Scatter!" flee button — kit button with an [R] hotkey chip. */
export function makeFleeButton(onTap: () => void): Button {
  const [, , w, h] = R.combat.fleeChip;
  return button("Scatter!", w, h, onTap, { hotkey: "R", fontSize: 13 });
}

/** Full-width glass strip the battle log line reads on top of. */
export function makeLogStrip(): Container {
  const view = new Container();
  const [, , w, h] = R.combat.logLine;
  view.addChild(panel(w, h, { variant: "glass" }));
  const hint = label("L  log", { size: TYPE.tiny, dim: true, mono: true });
  hint.anchor.set(1, 0.5);
  hint.position.set(w - SPACE.md, h / 2);
  view.addChild(hint);
  return view;
}

/* ---------------------------------------------------------------------- */
/* Cat Pile banner                                                         */
/* ---------------------------------------------------------------------- */

export interface CatPileBanner {
  view: Container;
  shown: boolean;
  show(damageEach: number, onAccept: () => void, onDecline: () => void): void;
  /** Collapses in 150ms. */
  hide(): void;
}

export function makeCatPileBanner(): CatPileBanner {
  const [bx, by, bw, bh] = R.combat.catPileBanner;
  const view = new Container();
  view.visible = false;

  const banner: CatPileBanner = {
    view,
    shown: false,

    show(damageEach, onAccept, onDecline): void {
      view.removeChildren().forEach((c) => c.destroy({ children: true }));
      banner.shown = true;
      view.visible = true;
      view.addChild(panel(bw, bh, { variant: "raised", accent: PAL.gold }));
      const title = heading("CAT PILE?!", 1, {
        fill: PAL.gold,
        center: true,
      });
      title.position.set(bw / 2, 34);
      view.addChild(title);
      const sub = label(
        `each enemy takes ${damageEach} — or keep them Off-Balance…`,
        { size: TYPE.small, dim: true, center: true },
      );
      sub.position.set(bw / 2, 68);
      view.addChild(sub);
      const pile = button("PILE ON", 220, 40, onAccept, {
        primary: true,
        hotkey: "Enter",
        fontSize: 16,
      });
      pile.view.position.set(bw / 2 - 240, bh - 52);
      view.addChild(pile.view);
      const hold = button("hold", 160, 40, onDecline, {
        hotkey: "Esc",
        fontSize: 16,
      });
      hold.view.position.set(bw / 2 + 40, bh - 52);
      view.addChild(hold.view);
      // slide down into place
      view.position.set(bx, by - 80);
      view.alpha = 0;
      tween(view, { y: by, alpha: 1 }, 180, "backOut");
    },

    hide(): void {
      if (!banner.shown) return;
      banner.shown = false;
      tween(view, { y: by - 40, alpha: 0 }, 150, "quadOut", () => {
        view.visible = false;
      });
    },
  };
  return banner;
}

/* ---------------------------------------------------------------------- */
/* Poise pips (boss)                                                       */
/* ---------------------------------------------------------------------- */

export interface PoisePips {
  view: Container;
  set(left: number): void;
}

/** N diamonds 12×12 (rotated squares); spent = track fill + gold outline. */
export function makePoisePips(max: number): PoisePips {
  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  const paint = (left: number): void => {
    g.clear();
    for (let i = 0; i < max; i++) {
      const cx = i * 18 + 6;
      const full = i < left;
      g.poly([cx, -6, cx + 6, 0, cx, 6, cx - 6, 0])
        .fill(full ? PAL.gold : PAL.hpBack)
        .stroke({ width: 1.5, color: full ? PAL.goldDark : PAL.gold });
    }
  };
  paint(max);
  return { view, set: paint };
}

/* ---------------------------------------------------------------------- */
/* Charge telegraph (boss windup)                                          */
/* ---------------------------------------------------------------------- */

export interface ChargeMark {
  view: Container;
  /** Bounce ±6px at 2Hz — call from the scene's update. */
  update(elapsedMs: number): void;
}

/** "!" DISPLAY-32 PAL.gold bouncing over the charging boss's head. */
export function makeChargeMark(): ChargeMark {
  const view = new Container();
  const t = heading("!", 1, { fill: PAL.gold, center: true });
  t.anchor.set(0.5, 1);
  view.addChild(t);
  return {
    view,
    update(elapsedMs: number): void {
      t.y = -Math.abs(Math.sin((elapsedMs / 1000) * Math.PI * 2)) * 6;
    },
  };
}

/**
 * Threatened cat-rank slots flooded PAL.danger alpha 0.25 (ui-art §8).
 * Takes SLOT CENTRES in world x, not ranks: rank positions are computed per
 * battle from the headcounts (layout.ts `combat.formation`), so only the scene
 * knows where rank 3 actually is.
 */
export function makeRankFlood(xs: number[]): Graphics {
  const g = new Graphics();
  const groundY = R.combat.groundY;
  for (const x of xs) {
    g.roundRect(x - 56, groundY - 176, 112, 188, 12).fill({
      color: PAL.danger,
      alpha: 0.22,
    });
    g.ellipse(x, groundY, 54, 14).fill({ color: PAL.danger, alpha: 0.25 });
  }
  return g;
}

/* ---------------------------------------------------------------------- */
/* Nameplate (hover)                                                       */
/* ---------------------------------------------------------------------- */

/** Name UI-13 bold + tier chevrons + `heavy` anchor glyph, on a kit panel. */
export function makeNameplate(c: Combatant): Container {
  const view = new Container();
  const row = new Container();
  const name = label(c.name, { size: 13, bold: true });
  row.addChild(name);
  let x = Math.ceil(name.width) + 4;
  if (c.side === "enemy") {
    const def = ENEMIES[c.speciesId ?? ""];
    if (def) {
      const chev = makeTierChevrons(def.look.tier);
      chev.position.set(x, 1);
      row.addChild(chev);
      x += Math.ceil(chev.width) + 4;
    }
    if (c.traits.includes("heavy")) {
      const anchor = makeHeavyGlyph();
      anchor.position.set(x, 1);
      row.addChild(anchor);
      x += Math.ceil(anchor.width);
    }
  }
  const plate = panel(x + 12, 24, { variant: "raised" });
  plate.position.set(-6, -4);
  row.position.set(0, 0);
  view.addChild(plate, row);
  view.pivot.set((x + 6) / 2, 0);
  return view;
}

/* ---------------------------------------------------------------------- */
/* Targeting previews                                                      */
/* ---------------------------------------------------------------------- */

/** "≈12" / "≈+11" MONO-14 preview chip above a prospective target. */
export function makePreviewChip(text: string, color: number): Container {
  const view = new Container();
  const t = new Text({ text, style: mono(14, { fill: color }) });
  t.anchor.set(0.5);
  const w = Math.ceil(t.width) + 14;
  const bg = new Graphics()
    .roundRect(-w / 2, -11, w, 22, RADIUS.chip)
    .fill({ color: PAL.hpBack, alpha: 0.94 })
    .stroke({ width: 1, color: darken(color) });
  view.addChild(bg, t);
  return view;
}

/**
 * DAMAGE PREVIEW (enemy-intel.md §5): the expected number big, the roll band
 * under it, and the HP it would leave — so a shove combo is planned rather
 * than discovered.
 *
 * `lo`/`hi` are the ±10% variance band the design's damage table specifies
 * (combat.md §3 step 2, `variance = 0.9 | 1.0 | 1.1`) shown around the
 * engine's own `previewDamage`; the chip is marked `≈` because the engine
 * rounds before subtracting DEF and the band is therefore an estimate, while
 * the headline number is not.
 */
export function makeDamagePreview(
  expected: number,
  lo: number,
  hi: number,
  opts: {
    hpLeft?: number;
    hpMax?: number;
    lethal?: boolean;
    note?: string;
  } = {},
): Container {
  const view = new Container();
  const accent = opts.lethal === true ? PAL.danger : PAL.text;
  const big = new Text({
    text: `≈${expected}`,
    style: mono(20, { fill: accent, fontWeight: "bold" }),
  });
  big.anchor.set(0.5, 0);
  const band = new Text({
    text: lo === hi ? "exact" : `${lo}–${hi}`,
    style: mono(11, { fill: PAL.textDim }),
  });
  band.anchor.set(0.5, 0);
  const rows: Text[] = [big, band];
  if (opts.hpLeft !== undefined && opts.hpMax !== undefined) {
    const t = new Text({
      text:
        opts.lethal === true ? "LETHAL" : `${opts.hpLeft}/${opts.hpMax} left`,
      style: mono(11, {
        fill: opts.lethal === true ? PAL.danger : PAL.textDim,
        fontWeight: opts.lethal === true ? "bold" : "normal",
      }),
    });
    t.anchor.set(0.5, 0);
    rows.push(t);
  }
  if (opts.note !== undefined && opts.note !== "") {
    const t = new Text({
      text: opts.note,
      style: mono(11, { fill: PAL.offBal }),
    });
    t.anchor.set(0.5, 0);
    rows.push(t);
  }
  const w = Math.max(64, Math.ceil(Math.max(...rows.map((r) => r.width))) + 18);
  const h = rows.reduce((n, r) => n + Math.ceil(r.height) + 1, 10);
  view.addChild(
    new Graphics()
      .roundRect(-w / 2, -h / 2, w, h, RADIUS.chip + 1)
      .fill({ color: PAL.bgDeep, alpha: 0.95 })
      .stroke({ width: 1.5, color: darken(accent) }),
  );
  let y = -h / 2 + 4;
  for (const r of rows) {
    r.position.set(0, y);
    view.addChild(r);
    y += Math.ceil(r.height) + 1;
  }
  return view;
}

/* ---------------------------------------------------------------------- */
/* Inspect panel (enemy-intel.md §3)                                       */
/* ---------------------------------------------------------------------- */

export interface InspectSubject {
  combatant: Combatant;
  intel: KnownIntel;
  /** the Stand name, when content carries one */
  stand: string | null;
  /** the enemy's live telegraph, already masked for visibility */
  intent: DeclaredIntent | null;
  /** display name of the intent's target, for the sentence */
  intentTargetName: string | null;
  /** true while this enemy is a legal target of the pending skill */
  targetable: boolean;
}

export interface InspectPanel {
  view: Container;
  /** null closes it. */
  show(subject: InspectSubject | null): void;
  readonly openId: string | null;
}

/** Panel geometry — parked on the left gutter, clear of the enemy ranks. */
const INSPECT = { x: 16, y: 84, w: 372 } as const;

/**
 * TAP AN ENEMY, LEARN WHAT YOU KNOW (enemy-intel.md §3).
 *
 * Darkest Dungeon's half of the design made literal: everything the Bestiary
 * has unlocked is spelled out, and everything it has NOT renders `???` in
 * place rather than being hidden — so the card doubles as a checklist of what
 * is left to learn about this species.
 *
 * It lives in the LEFT gutter on purpose: enemies always stand right of the
 * centre line, so the card can never cover the thing you are aiming at — the
 * tap that commits the attack lands on the enemy, not on the card that
 * described it (docs/design/mobile.md §2, "tap acts, long press reads").
 */
export function makeInspectPanel(onClose?: () => void): InspectPanel {
  const view = new Container();
  view.visible = false;
  let openId: string | null = null;

  const panelRef: InspectPanel = {
    view,
    get openId(): string | null {
      return openId;
    },
    show(subject: InspectSubject | null): void {
      view.removeChildren().forEach((c) => c.destroy({ children: true }));
      view.visible = subject !== null;
      openId = subject?.combatant.id ?? null;
      if (!subject) return;

      const { combatant: c, intel } = subject;
      const w = INSPECT.w;
      const pad = SPACE.md;
      const inner = w - pad * 2;
      const body = new Container();

      /* -- header: face, name, «STAND», level + tier ------------------- */
      const face = enemyAvatar(c.speciesId ?? "", 64, { shape: "rounded" });
      face.position.set(pad + 32, pad + 32);
      body.addChild(face);

      const colX = pad + 76;
      const name = heading(intel.name.value ?? c.name, 2, {
        fill: intel.name.known ? PAL.text : PAL.textDim,
      });
      fitText(name, w - colX - pad);
      name.position.set(colX, pad - 2);
      body.addChild(name);

      if (subject.stand !== null) {
        const stand = label(`「${subject.stand}」`, {
          size: TYPE.tiny,
          bold: true,
          fill: PAL.gold,
        });
        fitText(stand, w - colX - pad);
        stand.position.set(colX, pad + 26);
        body.addChild(stand);
      }

      const lvl = makeLevelChip(intel.level.value);
      lvl.position.set(colX, pad + 44);
      body.addChild(lvl);
      // tier as a WORD plus its chevrons: the nameplate's ‹‹ alone is a
      // 12px glyph nobody decodes on a stat card
      let tierX = colX + Math.ceil(lvl.width) + 8;
      const tierPill = makeTierPill(intel.tier.value);
      tierPill.position.set(tierX, pad + 44);
      body.addChild(tierPill);
      tierX += Math.ceil(tierPill.width) + 8;
      if (c.traits.includes("heavy")) {
        const anchor = label("▼ HEAVY", {
          size: TYPE.tiny,
          mono: true,
          dim: true,
        });
        anchor.position.set(tierX, pad + 47);
        body.addChild(anchor);
      }

      let y = pad + 76;

      /* -- HP (always true — it is on the screen already) --------------- */
      const hp = bar(inner - 62, 10, { kind: "hp" });
      hp.view.position.set(pad, y);
      hp.set(c.hp, c.stats.hp, false);
      body.addChild(hp.view);
      const hpNum = label(`${c.hp}/${c.stats.hp}`, {
        size: TYPE.tiny,
        mono: true,
      });
      hpNum.position.set(pad + inner - 56, y - 3);
      body.addChild(hpNum);
      y += 20;

      /* -- live statuses, each able to explain itself ------------------- */
      if (c.statuses.length > 0) {
        let sx = pad;
        for (const st of c.statuses) {
          const chip = makeStatusChip(st.id, st.value || undefined, {
            duration: st.duration,
            explain: true,
          });
          chip.position.set(sx, y);
          body.addChild(chip);
          sx += 40;
        }
        y += 24;
      }

      /* -- the telegraph, in words ------------------------------------- */
      if (subject.intent) {
        const v = INTENT_VISUAL[subject.intent.kind];
        const strip = new Container();
        const badge = makeIntentBadge(0.5);
        badge.set(subject.intent);
        badge.view.position.set(20, 18);
        strip.addChild(badge.view);
        const line = label(
          intentSentence(subject.intent, subject.intentTargetName),
          { size: TYPE.small, wrap: inner - 48, fill: v.color },
        );
        line.position.set(44, 8);
        strip.addChild(line);
        const sh = Math.max(36, Math.ceil(line.height) + 14);
        const plate = new Graphics()
          .roundRect(0, 0, inner, sh, RADIUS.button)
          .fill({ color: PAL.hpBack, alpha: 0.85 })
          .stroke({ width: 1, color: darken(v.color) });
        strip.addChildAt(plate, 0);
        badge.view.position.set(20, sh / 2);
        strip.position.set(pad, y);
        body.addChild(strip);
        y += sh + SPACE.sm;
      }

      /* -- earned knowledge -------------------------------------------- */
      const block = makeIntelBlock(intel, inner);
      block.view.position.set(pad, y);
      body.addChild(block.view);
      y += block.height + SPACE.sm;

      /* -- footer ------------------------------------------------------- */
      const foot = label(
        subject.targetable
          ? isTouch()
            ? "tap it to attack"
            : "click it to attack"
          : `met ${intel.met}×  ·  felled ${intel.kills}`,
        subject.targetable
          ? { size: TYPE.tiny, mono: true, fill: PAL.gold }
          : { size: TYPE.tiny, mono: true, dim: true },
      );
      foot.position.set(pad, y + 12);
      body.addChild(foot);
      // A real Close control, not a hint: [I] and Esc are keys, and the card
      // is the one battle surface a finger can open without a way back out
      // (docs/design/mobile.md §1).
      if (onClose) {
        const close = button("Close", 96, 32, onClose, {
          hotkey: "Esc",
          fontSize: TYPE.tiny,
        });
        close.view.position.set(w - pad - 96, y);
        body.addChild(close.view);
      }
      y += 40;

      view.addChild(
        panel(w, y + SPACE.xs, { variant: "raised", accent: PAL.danger }),
        body,
      );
      view.position.set(INSPECT.x, INSPECT.y);
    },
  };
  return panelRef;
}

/** Small status-glyph chip used for shove-destination previews. */
export function makeStatusPreviewChip(id: StatusId): Container {
  const chip = makeStatusChip(id);
  chip.alpha = 0.85;
  chip.pivot.set(8, 8);
  return chip;
}

/**
 * Ghost shove arrow (ui-art §8 targeting step 2): dashed 6/4 line, 3px,
 * with an arrowhead at the destination. Cleared/redrawn by the scene.
 */
export function drawGhostArrow(
  g: Graphics,
  fromX: number,
  toX: number,
  y: number,
  color: number,
): void {
  const dir = Math.sign(toX - fromX) || 1;
  const len = Math.abs(toX - fromX);
  for (let d = 0; d + 1 < len; d += 10) {
    const seg = Math.min(6, len - d);
    g.moveTo(fromX + dir * d, y).lineTo(fromX + dir * (d + seg), y);
  }
  g.stroke({ width: 3, color });
  g.poly([toX, y, toX - dir * 8, y - 5, toX - dir * 8, y + 5]).fill(color);
}

/** Pulsing gold underline ellipse marking a legal target. */
export function makeTargetRing(): Graphics {
  const g = new Graphics();
  g.ellipse(0, 0, 42, 12).fill({ color: PAL.gold, alpha: 0.1 });
  g.ellipse(0, 0, 40, 11).stroke({ width: 3, color: PAL.gold });
  return g;
}
