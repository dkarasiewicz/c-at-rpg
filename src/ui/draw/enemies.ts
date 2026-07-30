/**
 * WP-08 — procedural enemies (ui-art §5). Four family recipes on the same
 * 96×96 canvas, feet at (48, 92) → local (0, 0), 3px outlines, facing left.
 * A family's shapes never change between tiers — only nameplate chevrons
 * and stat blocks change, so learned silhouettes stay honest.
 *
 * Size grades by role: minion 0.85×, standard 1.0×, elite 1.25× + gold
 * ground-ring, boss 1.6× (+ ring; the pulsing boss outline is a separate
 * Graphics from `drawBossAura` so scenes can alpha-tween it).
 */
import { Graphics, Text } from "pixi.js";
import type { EnemyLook } from "../../core/types";
import { PAL, THEMES, BANDANA_OUTLINE } from "../palette";
import { mono } from "../textStyles";

const GRADE_SCALE: Record<EnemyLook["sizeGrade"], number> = {
  minion: 0.85,
  standard: 1.0,
  elite: 1.25,
  boss: 1.6,
};

/** Eye centers per family in recipe coords (patchEye / previews). */
const EYE_POS = {
  vermin: [21, 54],
  bird: [31, 34],
  beast: [30, 32],
  construct: [48, 46],
} as const;

/**
 * Draw an enemy into `g` per its look. Feet end at local (0, 0). Elites and
 * bosses get the gold ground-ring; props (crown / shamanStaff / scarf /
 * patchEye) draw last.
 */
export function drawEnemy(g: Graphics, look: EnemyLook): void {
  const s = GRADE_SCALE[look.sizeGrade];
  const X = (x: number) => (x - 48) * s;
  const Y = (y: number) => (y - 92) * s;

  if (look.sizeGrade === "elite" || look.sizeGrade === "boss") {
    drawEliteRing(g, s);
  }

  const fam = PAL[look.family];
  const outline = { width: 3 * s, color: fam.outline };

  switch (look.family) {
    case "vermin": {
      // bare zigzag tail first (behind the body)
      g.moveTo(X(78), Y(78))
        .lineTo(X(92), Y(70))
        .lineTo(X(86), Y(58))
        .lineTo(X(94), Y(48))
        .stroke({ width: 4 * s, color: fam.accent, cap: "round" });
      // low wide hunch
      g.ellipse(X(48), Y(72), 30 * s, 20 * s)
        .fill(fam.base)
        .stroke(outline);
      // muzzle cone
      g.poly([X(14), Y(58), X(22), Y(50), X(22), Y(66)])
        .fill(fam.base)
        .stroke(outline);
      // head merged into the body front
      g.circle(X(26), Y(58), 14 * s)
        .fill(fam.base)
        .stroke(outline);
      // huge round ears + pink inners
      for (const ex of [20, 38]) {
        g.circle(X(ex), Y(42), 9 * s)
          .fill(fam.base)
          .stroke(outline);
        g.circle(X(ex), Y(42), 5 * s).fill(PAL.earInner);
      }
      // single eye
      g.circle(X(21), Y(54), 3.5 * s).fill(fam.eye);
      break;
    }
    case "bird": {
      // stick legs
      const leg = { width: 2 * s, color: fam.outline };
      g.moveTo(X(42), Y(92)).lineTo(X(44), Y(74)).stroke(leg);
      g.moveTo(X(56), Y(92)).lineTo(X(54), Y(74)).stroke(leg);
      // tail feathers fanned from (66, 66)
      for (const deg of [-10, 0, 10]) {
        g.save()
          .translateTransform(X(66), Y(66))
          .rotateTransform((deg * Math.PI) / 180)
          .roundRect(0, -2 * s, 16 * s, 4 * s, 2 * s)
          .fill(fam.accent)
          .stroke({ width: 2 * s, color: fam.outline })
          .restore();
      }
      // teardrop body rotated −20°
      g.save()
        .translateTransform(X(48), Y(58))
        .rotateTransform((-20 * Math.PI) / 180)
        .ellipse(0, 0, 20 * s, 24 * s)
        .fill(fam.base)
        .stroke(outline)
        .restore();
      // wing
      g.ellipse(X(54), Y(58), 12 * s, 18 * s).fill(fam.accent);
      // head + gold beak + eye
      g.circle(X(34), Y(36), 11 * s)
        .fill(fam.base)
        .stroke(outline);
      g.poly([X(22), Y(34), X(34), Y(30), X(34), Y(40)])
        .fill(PAL.gold)
        .stroke({ width: 2 * s, color: PAL.goldDark });
      g.circle(X(31), Y(34), 3 * s).fill(fam.eye);
      break;
    }
    case "beast": {
      // stub tail behind
      g.circle(X(70), Y(50), 5 * s)
        .fill(fam.base)
        .stroke(outline);
      // tall boxy chest
      g.roundRect(X(30), Y(40), 36 * s, 52 * s, 12 * s)
        .fill(fam.base)
        .stroke(outline);
      // chest patch
      g.ellipse(X(44), Y(72), 10 * s, 14 * s).fill(fam.accent);
      // head block
      g.roundRect(X(22), Y(22), 30 * s, 24 * s, 9 * s)
        .fill(fam.base)
        .stroke(outline);
      // drooping ears from the head's top corners, rotated ±12°
      for (const [ex, deg] of [
        [26, -12],
        [48, 12],
      ] as const) {
        g.save()
          .translateTransform(X(ex), Y(24))
          .rotateTransform((deg * Math.PI) / 180)
          .roundRect(-4 * s, 0, 8 * s, 18 * s, 4 * s)
          .fill(fam.accent)
          .stroke({ width: 2 * s, color: fam.outline })
          .restore();
      }
      // snout block + void nose
      g.roundRect(X(12), Y(34), 16 * s, 12 * s, 5 * s)
        .fill(fam.base)
        .stroke(outline);
      g.circle(X(14), Y(38), 3 * s).fill(PAL.void);
      // eye
      g.circle(X(30), Y(32), 3.5 * s).fill(fam.eye);
      break;
    }
    case "construct": {
      // hovers 2px — whole machine sits 2px above the ground line
      const H = (y: number) => Y(y - 2);
      // hose behind, with nozzle
      g.moveTo(X(30), H(60))
        .bezierCurveTo(X(8), H(52), X(6), H(76), X(18), H(84))
        .stroke({ width: 6 * s, color: fam.accent, cap: "round" });
      g.roundRect(X(13), H(80), 10 * s, 8 * s, 2 * s)
        .fill(fam.accent)
        .stroke({ width: 2 * s, color: fam.outline });
      // wheels
      for (const wx of [34, 62]) {
        g.circle(X(wx), H(90), 6 * s)
          .fill(fam.accent)
          .stroke({ width: 2 * s, color: fam.outline });
      }
      // dome (half-circle) then chassis box
      g.moveTo(X(26), H(48))
        .arc(X(48), H(48), 22 * s, Math.PI, 0)
        .closePath()
        .fill(fam.base)
        .stroke(outline);
      g.roundRect(X(26), H(48), 44 * s, 40 * s, 6 * s)
        .fill(fam.base)
        .stroke(outline);
      // glowing eye-strip: void slot + three lamps
      g.roundRect(X(32), H(42), 32 * s, 8 * s, 4 * s).fill(PAL.void);
      for (const lx of [40, 48, 56]) {
        g.circle(X(lx), H(46), 2.5 * s).fill(fam.eye);
      }
      break;
    }
  }

  drawProps(g, look, s);
}

/**
 * Gold elite/boss ground-ring (ui-art §5): ellipse rx 34, ry 9, stroke 3
 * PAL.eliteRing at alpha 0.8, under the feet.
 */
export function drawEliteRing(g: Graphics, scale = 1.25): void {
  g.ellipse(0, 0, 34 * scale, 9 * scale).stroke({
    width: 3,
    color: PAL.eliteRing,
    alpha: 0.8,
  });
}

/**
 * The boss's pulsing outline, as its own Graphics content so the battle
 * scene can tween alpha 0.4→0.9 on a 1.2s loop (ui-art §5). Draws a gold
 * halo ellipse roughly hugging the body mass.
 */
export function drawBossAura(g: Graphics, look: EnemyLook): void {
  const s = GRADE_SCALE[look.sizeGrade];
  g.ellipse(0, -46 * s, 40 * s, 48 * s).stroke({
    width: 4,
    color: PAL.eliteRing,
  });
}

/** Data-driven accessories (ui-art §5): 1–6 primitives each, drawn last. */
function drawProps(g: Graphics, look: EnemyLook, s: number): void {
  const props = look.props ?? [];
  const X = (x: number) => (x - 48) * s;
  const Y = (y: number) => (y - 92) * s;
  const [eyeX, eyeY] = EYE_POS[look.family];
  // head-top anchor per family, for the crown
  const headTop = {
    vermin: [26, 44],
    bird: [34, 25],
    beast: [37, 22],
    construct: [48, 26],
  }[look.family];
  // neck anchor per family, for the scarf
  const neck = {
    vermin: [26, 68],
    bird: [34, 46],
    beast: [37, 46],
    construct: [48, 50],
  }[look.family];

  for (const prop of props) {
    if (prop === "crown") {
      // 5-point zigzag strip 40×12 (the Vacuum King's cardboard crown)
      const [cx, cy] = headTop;
      const base = Y(cy);
      const top = Y(cy - 12);
      const x0 = X(cx - 20);
      const step = (40 * s) / 4;
      const pts: number[] = [x0, base];
      for (let i = 0; i <= 4; i++) {
        pts.push(x0 + i * step, top);
        if (i < 4) pts.push(x0 + (i + 0.5) * step, base - 4 * s);
      }
      pts.push(x0 + 4 * step, base);
      g.poly(pts)
        .fill(PAL.gold)
        .stroke({ width: 2 * s, color: PAL.goldDark });
    } else if (prop === "shamanStaff") {
      // 2px line + circle r 4, THEMES accent by tier
      const accent = THEMES[look.tier - 1].accent;
      g.moveTo(X(12), Y(88))
        .lineTo(X(18), Y(42))
        .stroke({ width: 2 * s, color: accent });
      g.circle(X(18), Y(38), 4 * s).fill(accent);
    } else if (prop === "scarf") {
      // Pixel's bandana recipe, recolored placement per family
      const [nx, ny] = neck;
      g.poly([X(nx - 12), Y(ny), X(nx + 12), Y(ny), X(nx), Y(ny + 12)])
        .fill(PAL.danger)
        .stroke({ width: 2 * s, color: BANDANA_OUTLINE });
    } else if (prop === "patchEye") {
      // eye covered by an 8×8 void rounded-rect + 1px strap line
      g.moveTo(X(eyeX - 12), Y(eyeY - 3))
        .lineTo(X(eyeX + 12), Y(eyeY - 3))
        .stroke({ width: 1, color: PAL.void });
      g.roundRect(X(eyeX) - 4 * s, Y(eyeY) - 4 * s, 8 * s, 8 * s, 2 * s).fill(
        PAL.void,
      );
    }
  }
}

/**
 * Tier chevrons for a nameplate: "‹" ×tier, MONO-12, colored per tier
 * (ui-art §5). Tier recolors nothing on the body.
 */
export function makeTierChevrons(tier: 1 | 2 | 3): Text {
  const color = [PAL.tier1, PAL.tier2, PAL.tier3][tier - 1];
  return new Text({
    text: "‹".repeat(tier),
    style: mono(12, { fill: color }),
  });
}

/**
 * The `heavy` trait anchor glyph "▼" (MONO-12, PAL.textDim) shown next to
 * non-boss elites' nameplates — the "you can't shove me" tell.
 */
export function makeHeavyGlyph(): Text {
  return new Text({ text: "▼", style: mono(12, { fill: PAL.textDim }) });
}
