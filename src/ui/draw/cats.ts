/**
 * WP-08 — procedural cats (ui-art §4). One recipe draws all four classes:
 * 96×96 design canvas, origin at the feet center (48, 92) so callers place
 * the Graphics' local (0,0) on a ground line / slot. Chunky flat fills with
 * 3px outlines in the class's own darker shade. Cats face right; flip the
 * container's scale.x for left-facing.
 */
import { Graphics } from "pixi.js";
import type { ClassId } from "../../core/types.js";
import { PAL, KO_GREY, BANDANA_OUTLINE } from "../palette.js";

export type CatPose = "sit" | "battle";

interface CatColors {
  body: number;
  accent: number;
  belly: number;
  outline: number;
  eye: number;
}

function colors(cls: ClassId, ko: boolean): CatColors {
  const c = PAL[cls];
  if (!ko) return c;
  // KO greyscale (ui-art §4): grey fills, dim accents
  return {
    body: KO_GREY.body,
    accent: KO_GREY.accent,
    belly: KO_GREY.body,
    outline: KO_GREY.accent,
    eye: PAL.textDim,
  };
}

/**
 * Draw one cat into `g`. Feet end up at local (0, 0); the visual spans
 * roughly x −48..48, y −100..0 (Bruno at 1.12× slightly more).
 *
 * `scale` multiplies the whole recipe (mini uses, size grades); `ko` swaps
 * to greyscale fills and ×-ed eyes (results screen, KO'd portraits).
 */
export function drawCat(
  g: Graphics,
  cls: ClassId,
  pose: CatPose,
  scale = 1,
  ko = false,
): void {
  const c = colors(cls, ko);
  // Bruiser: whole cat at 1.12× (class marker table)
  const s = scale * (cls === "bruiser" ? 1.12 : 1);
  // Trickster: 0.9× body scale, head full size (big-headed sneak)
  const bodyS = cls === "trickster" ? 0.9 : 1;
  // recipe coords → local coords (feet (48,92) → (0,0)), whole-cat scale s
  const X = (x: number) => (x - 48) * s;
  const Y = (y: number) => (y - 92) * s;
  // body-part variant: additionally scaled toward the feet by bodyS
  const bX = (x: number) => (x - 48) * s * bodyS;
  const bY = (y: number) => (y - 92) * s * bodyS;
  const outline = { width: 3 * s, color: c.outline };

  // 1. tail — stroked cubic bezier, width 7 (trickster 5, 12px longer)
  const tailW = (cls === "trickster" ? 5 : 7) * s * bodyS;
  const tip: [number, number] = cls === "trickster" ? [4, 40] : [18, 46];
  g.moveTo(bX(28), bY(82))
    .bezierCurveTo(bX(10), bY(78), bX(8), bY(56), bX(tip[0]), bY(tip[1]))
    .stroke({ width: tailW, color: c.accent, cap: "round" });

  // 2. body (seated pear) — battle pose crouches: ry 20
  const bodyRy = pose === "battle" ? 20 : 22;
  g.ellipse(bX(48), bY(66 + (22 - bodyRy)), 24 * s * bodyS, bodyRy * s * bodyS)
    .fill(c.body)
    .stroke(outline);

  // 3. belly patch (medic: enlarged white bib rx 15, ry 14)
  const [bellyRx, bellyRy] = cls === "medic" ? [15, 14] : [13, 12];
  g.ellipse(bX(48), bY(74), bellyRx * s * bodyS, bellyRy * s * bodyS).fill(
    c.belly,
  );

  // 4. front paws — battle pose: 4px forward (facing +x)
  const pawDx = pose === "battle" ? 4 : 0;
  for (const px of [38, 58]) {
    g.ellipse(bX(px + pawDx), bY(88), 6 * s * bodyS, 4 * s * bodyS)
      .fill(c.body)
      .stroke(outline);
  }

  // 5. head (medic: r 22, rounder)
  const headR = cls === "medic" ? 22 : 20;
  g.circle(X(48), Y(34), headR * s)
    .fill(c.body)
    .stroke(outline);

  // 6. ears (hexer: shorter, tips at y 10) + inner-ear pink insets
  const earTipY = cls === "hexer" ? 10 : 4;
  const earL: [number, number][] = [
    [30, 24],
    [33, earTipY],
    [46, 15],
  ];
  const earR: [number, number][] = earL.map(([ex, ey]) => [96 - ex, ey]);
  for (const tri of [earL, earR]) {
    g.poly(tri.flatMap(([ex, ey]) => [X(ex), Y(ey)]))
      .fill(c.body)
      .stroke(outline);
    // inner triangle inset 4px: lerp each vertex toward the centroid
    const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    g.poly(
      tri.flatMap(([ex, ey]) => [
        X(ex + (cx - ex) * 0.45),
        Y(ey + (cy - ey) * 0.45),
      ]),
    ).fill(ko ? KO_GREY.accent : PAL.earInner);
  }

  // 7. eyes — vertical-slit pupils (KO: '×' strokes instead)
  for (const ex of [40, 56]) {
    if (ko) {
      const r = 4 * s;
      g.moveTo(X(ex) - r, Y(33) - r)
        .lineTo(X(ex) + r, Y(33) + r)
        .moveTo(X(ex) + r, Y(33) - r)
        .lineTo(X(ex) - r, Y(33) + r)
        .stroke({ width: 2 * s, color: PAL.textDim });
    } else {
      g.ellipse(X(ex), Y(33), 4.5 * s, 6 * s).fill(c.eye);
      g.roundRect(X(ex) - 1.5 * s, Y(33) - 4.5 * s, 3 * s, 9 * s, 1.5 * s).fill(
        PAL.void,
      );
    }
  }

  // 8. nose + 'ω' mouth: two 6px-radius arcs from the nose tip
  g.poly([X(45), Y(40), X(51), Y(40), X(48), Y(44)]).fill(PAL.nosePink);
  g.moveTo(X(48), Y(44))
    .arc(X(42), Y(44), 6 * s, 0, Math.PI)
    .stroke({ width: 2 * s, color: c.outline });
  g.moveTo(X(48), Y(44))
    .arc(X(54), Y(44), 6 * s, Math.PI, 0, true)
    .stroke({ width: 2 * s, color: c.outline });

  // 9. whiskers — 3 per side, PAL.text alpha 0.55
  const whisker = { width: 1.5 * s, color: PAL.text, alpha: 0.55 };
  const wys: [number, number][] = [
    [37, 36],
    [40, 40],
    [43, 45],
  ];
  for (const [fromY, toY] of wys) {
    g.moveTo(X(34), Y(fromY)).lineTo(X(16), Y(toY)).stroke(whisker);
    g.moveTo(X(62), Y(fromY)).lineTo(X(80), Y(toY)).stroke(whisker);
  }

  // 10. class markers
  if (cls === "bruiser") {
    // notched left ear: bgDeep bite
    g.poly([X(36), Y(10), X(40), Y(14), X(38), Y(6)]).fill(PAL.bgDeep);
    // 3 tabby stripes across the back, rotated −15°
    for (const [sx, sy] of [
      [30, 58],
      [34, 66],
      [32, 74],
    ] as const) {
      g.save()
        .translateTransform(bX(sx), bY(sy))
        .rotateTransform((-15 * Math.PI) / 180)
        .roundRect(-7 * s, -2 * s, 14 * s, 4 * s, 2 * s)
        .fill(ko ? KO_GREY.accent : c.accent)
        .restore();
    }
  } else if (cls === "trickster") {
    // red bandana
    g.poly([X(36), Y(50), X(60), Y(50), X(48), Y(62)])
      .fill(ko ? KO_GREY.accent : PAL.danger)
      .stroke({ width: 3 * s, color: BANDANA_OUTLINE });
  } else if (cls === "hexer") {
    // witch hat: brim + cone + gold band
    g.ellipse(X(48), Y(12), 17 * s, 4.5 * s)
      .fill(PAL.panel)
      .stroke(outline);
    g.poly([X(36), Y(12), X(60), Y(12), X(54), Y(-8)])
      .fill(PAL.panel)
      .stroke(outline);
    g.moveTo(X(38), Y(10))
      .lineTo(X(58), Y(10))
      .stroke({ width: 2 * s, color: ko ? KO_GREY.accent : PAL.gold });
  } else {
    // medic: collar line + gold bell
    g.moveTo(X(36), Y(50))
      .lineTo(X(60), Y(50))
      .stroke({ width: 2 * s, color: c.accent });
    g.circle(X(48), Y(53), 3.5 * s)
      .fill(ko ? KO_GREY.accent : PAL.gold)
      .stroke({ width: 1.5 * s, color: ko ? KO_GREY.body : PAL.goldDark });
  }
}

/**
 * Mini-portrait (HUD cards, initiative ribbon): steps 5–9 only — head,
 * ears, eyes, nose, whiskers — at stroke 2, sized to a 48×48 box whose
 * center is the head center. `ko` renders the greyscale ×-eyed variant.
 */
export function drawCatPortrait(g: Graphics, cls: ClassId, ko = false): void {
  const c = colors(cls, ko);
  const s = 0.92; // head recipe (~52px wide incl. whiskers) into 48px
  const X = (x: number) => (x - 48) * s;
  const Y = (y: number) => (y - 30) * s; // head block centered vertically
  const outline = { width: 2, color: c.outline };

  const headR = cls === "medic" ? 22 : 20;
  g.circle(X(48), Y(34), headR * s)
    .fill(c.body)
    .stroke(outline);

  const earTipY = cls === "hexer" ? 10 : 4;
  const earL: [number, number][] = [
    [30, 24],
    [33, earTipY],
    [46, 15],
  ];
  for (const tri of [earL, earL.map(([ex, ey]) => [96 - ex, ey])] as [
    number,
    number,
  ][][]) {
    g.poly(tri.flatMap(([ex, ey]) => [X(ex), Y(ey)]))
      .fill(c.body)
      .stroke(outline);
    const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    g.poly(
      tri.flatMap(([ex, ey]) => [
        X(ex + (cx - ex) * 0.45),
        Y(ey + (cy - ey) * 0.45),
      ]),
    ).fill(ko ? KO_GREY.accent : PAL.earInner);
  }

  for (const ex of [40, 56]) {
    if (ko) {
      g.moveTo(X(ex) - 4, Y(33) - 4)
        .lineTo(X(ex) + 4, Y(33) + 4)
        .moveTo(X(ex) + 4, Y(33) - 4)
        .lineTo(X(ex) - 4, Y(33) + 4)
        .stroke({ width: 2, color: PAL.textDim });
    } else {
      g.ellipse(X(ex), Y(33), 4.5 * s, 6 * s).fill(c.eye);
      g.roundRect(X(ex) - 1.5, Y(33) - 4.5, 3, 9, 1.5).fill(PAL.void);
    }
  }

  g.poly([X(45), Y(40), X(51), Y(40), X(48), Y(44)]).fill(PAL.nosePink);
  g.moveTo(X(48), Y(44))
    .arc(X(42), Y(44), 6 * s, 0, Math.PI)
    .stroke({ width: 2, color: c.outline });
  g.moveTo(X(48), Y(44))
    .arc(X(54), Y(44), 6 * s, Math.PI, 0, true)
    .stroke({ width: 2, color: c.outline });
  const whisker = { width: 1.5, color: PAL.text, alpha: 0.55 };
  for (const [fromY, toY] of [
    [37, 36],
    [40, 40],
    [43, 45],
  ] as const) {
    g.moveTo(X(34), Y(fromY)).lineTo(X(18), Y(toY)).stroke(whisker);
    g.moveTo(X(62), Y(fromY)).lineTo(X(78), Y(toY)).stroke(whisker);
  }
}

/**
 * Nine Lives paw glyph (ui-art §4): pad circle r 2.5 + three r 1.2 toes,
 * 7×7px total at scale 1, centered on (cx, cy). `alive` = PAL.gold fill;
 * spent = PAL.hpBack fill with 1px PAL.border outline.
 */
export function drawPaw(
  g: Graphics,
  cx: number,
  cy: number,
  scale = 1,
  alive = true,
  color?: number,
): void {
  const fill = color ?? (alive ? PAL.gold : PAL.hpBack);
  const toes: [number, number][] = [
    [-2.2, -2.2],
    [0, -2.9],
    [2.2, -2.2],
  ];
  g.circle(cx, cy + 1 * scale, 2.5 * scale).fill(fill);
  for (const [dx, dy] of toes) {
    g.circle(cx + dx * scale, cy + dy * scale, 1.2 * scale).fill(fill);
  }
  if (!alive && color === undefined) {
    g.circle(cx, cy + 1 * scale, 2.5 * scale).stroke({
      width: 1,
      color: PAL.border,
    });
  }
}
