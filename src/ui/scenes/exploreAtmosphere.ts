/**
 * WP-10 (visual v3) — the dungeon's air.
 *
 * Three world-space layers that turn the explore scene from "dim tiles
 * floating in a black void" into "a lit pocket carved out of solid rock":
 *
 *   rock   (under the tiles)  an endless textured rock/fog field — the wall
 *                             tile texture tiled, tinted and speckled with a
 *                             deterministic noise field, extended well past
 *                             the floor rect so the frame never shows an edge.
 *   fog    (over the tiles)   ONE sprite backed by a 1-px-per-tile canvas
 *                             texture. Per tile it stores how hidden that
 *                             tile is (unseen ≫ remembered ≫ lit, plus a
 *                             distance-from-party falloff); the field is box
 *                             blurred across tiles and the GPU's bilinear
 *                             upscale turns it into a genuinely soft,
 *                             feathered frontier instead of a staircase of
 *                             opaque quads.
 *   light  (over the fog)     an additive warm radial lantern on the party,
 *                             plus a wide ambient bloom, with a slow flicker.
 *
 * PRESENTATION ONLY. Nothing here reads or writes gameplay state beyond the
 * FloorState's own `explored` / `visible` sets, and nothing here can change
 * what the party may see — `core/dungeon/floor.ts` still owns fog of war.
 *
 * Fail-soft: no 2D canvas (headless/exotic browser) → the fog layer degrades
 * to nothing and the scene still renders; no `tile:wall` texture → the rock
 * field falls back to its procedural noise alone.
 */
import { Container, Graphics, Sprite, Texture, TilingSprite } from "pixi.js";
import type { FloorState } from "../../core/types.js";
import { PAL, THEMES, mix } from "../palette.js";
import { spriteTextureFor } from "../sprites.js";

/* ---------------------------------------------------------------------- */
/* Tuning                                                                  */
/* ---------------------------------------------------------------------- */

/** Fog opacity of never-seen rock. Below 1 on purpose: the rock texture must
 *  stay legible through it, otherwise "unexplored" is just black again. */
const A_UNSEEN = 0.6;
/** …how much per-tile noise that opacity wanders by (soft cloud banding). */
const A_UNSEEN_NOISE = 0.1;
/** Remembered-but-not-visible: clearly dimmed and cooled, still readable. */
const A_REMEMBERED = 0.34;
/** Currently lit: a whisper of atmosphere only. */
const A_LIT = 0.02;
/** Extra dimming per tile of distance from the party, and its cap. */
const A_FALLOFF = 0.028;
const A_FALLOFF_MAX = 0.26;
/** Rock swallows distance harder than a lit floor does. */
const A_ROCK_FALLOFF_MAX = 0.24;
/** Memory does NOT fade with distance the way lit ground does — a remembered
 *  corridor across the floor must stay legible, so its falloff is token. */
const A_MEM_FALLOFF = 0.012;
const A_MEM_FALLOFF_MAX = 0.09;
/** Blur passes over the tile field — this is what feathers the frontier. */
const BLUR_PASSES = 3;

/* ---------------------------------------------------------------------- */
/* Deterministic visual noise (NOT a gameplay RNG stream — see §4)         */
/* ---------------------------------------------------------------------- */

const hash2 = (x: number, y: number): number =>
  ((Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x7f4a, 0xc2b2ae35)) >>>
    0) /
  4294967296;

/* ---------------------------------------------------------------------- */
/* Radial gradient texture (the lantern)                                   */
/* ---------------------------------------------------------------------- */

let glowTex: Texture | null = null;
let glowTried = false;

/** A 128² white radial falloff, built once and shared by every light. */
function radialTexture(): Texture | null {
  if (glowTried) return glowTex;
  glowTried = true;
  try {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const c2d = canvas.getContext("2d");
    if (!c2d) return null;
    const grd = c2d.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.35, "rgba(255,255,255,0.55)");
    grd.addColorStop(0.7, "rgba(255,255,255,0.16)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    c2d.fillStyle = grd;
    c2d.fillRect(0, 0, size, size);
    glowTex = Texture.from(canvas);
    return glowTex;
  } catch {
    return null; // decoration only
  }
}

/* ---------------------------------------------------------------------- */
/* Public surface                                                          */
/* ---------------------------------------------------------------------- */

export interface Atmosphere {
  /** Textured rock field — add BELOW the tile layer. */
  rock: Container;
  /** Feathered fog veil — add ABOVE the tile layer. */
  fog: Container;
  /** Warm party lantern — add ABOVE the fog, below entities. */
  light: Container;
  /** Recompute the fog field from the floor's knowledge state (per step). */
  refresh(): void;
  /** Per-frame lantern follow + flicker. `px`/`py` are world pixels. */
  update(dtMs: number, px: number, py: number): void;
  /**
   * Release the GPU-side fog texture. The three containers are owned by the
   * scene graph — whoever added them destroys them — so this deliberately
   * does NOT destroy them (double-destroying a Container throws in pixi).
   */
  destroy(): void;
}

/**
 * Build the three atmosphere layers for one floor.
 *
 * @param f      the live FloorState (read every `refresh`)
 * @param tile   world px per tile
 * @param bleed  tiles of rock/fog generated beyond the floor rect
 * @param themeIdx  THEMES index for the floor band
 */
export function makeAtmosphere(
  f: FloorState,
  tile: number,
  bleed: number,
  themeIdx: number,
): Atmosphere {
  const th = THEMES[Math.max(0, Math.min(THEMES.length - 1, themeIdx))];

  const fw = f.w + bleed * 2;
  const fh = f.h + bleed * 2;
  const x0 = -bleed * tile;
  const y0 = -bleed * tile;
  const wpx = fw * tile;
  const hpx = fh * tile;

  /* ---- rock field --------------------------------------------------- */

  // A lifted base under the (dark) wall art: 0.82-alpha strata over a lighter
  // plate raises the texture's blacks, so the rock still reads as masonry once
  // the fog veil sits on top instead of collapsing into a flat black.
  const rockBase = mix(th.wallTop, PAL.bgDeep, 0.3);
  const rockLite = mix(th.wallTop, PAL.text, 0.15);

  const rock = new Container();
  rock.eventMode = "none";
  rock.addChild(new Graphics().rect(x0, y0, wpx, hpx).fill(rockBase));

  const wallTex = spriteTextureFor("tile:wall");
  if (wallTex && wallTex.width > 0) {
    const strata = new TilingSprite({
      texture: wallTex,
      width: wpx,
      height: hpx,
    });
    strata.position.set(x0, y0);
    // ONE texture per tile, aligned to the tile grid: the rock field is
    // literally the same masonry as an explored wall cell, so the frontier
    // between "known wall" and "unknown rock" has no material seam — only
    // the fog gradient.
    strata.tileScale.set(tile / wallTex.width);
    strata.alpha = 0.82;
    rock.addChild(strata);
  }

  // deterministic speckle + boulders, one Graphics, drawn once
  const grain = new Graphics();
  for (let gy = 0; gy < fh; gy += 2) {
    for (let gx = 0; gx < fw; gx += 2) {
      const h1 = hash2(gx * 3 + 1, gy * 7 + 2);
      const h2 = hash2(gx * 11 + 5, gy * 13 + 3);
      const h3 = hash2(gx * 17 + 9, gy * 19 + 4);
      const cx = x0 + (gx + h1) * tile;
      const cy = y0 + (gy + h2) * tile;
      const rr = tile * (0.18 + h3 * 0.45);
      grain.ellipse(cx, cy, rr, rr * (0.55 + h1 * 0.5)).fill({
        color: h3 > 0.5 ? rockLite : PAL.void,
        alpha: 0.04 + h2 * 0.06,
      });
    }
  }
  // a handful of big soft masses so the field has large-scale shape
  for (let i = 0; i < 30; i++) {
    const h1 = hash2(i * 31 + 7, i * 17 + 11);
    const h2 = hash2(i * 13 + 3, i * 29 + 5);
    const h3 = hash2(i * 43 + 1, i * 7 + 23);
    grain
      .ellipse(
        x0 + h1 * wpx,
        y0 + h2 * hpx,
        tile * (1.5 + h3 * 4),
        tile * (1 + h1 * 3),
      )
      .fill({ color: h3 > 0.5 ? PAL.void : rockLite, alpha: 0.05 });
  }
  rock.addChild(grain);

  /* ---- fog field ---------------------------------------------------- */

  const fog = new Container();
  fog.eventMode = "none";

  const fogColor = mix(PAL.void, th.wallFace, 0.55);
  const fr = (fogColor >> 16) & 0xff;
  const fg = (fogColor >> 8) & 0xff;
  const fb = fogColor & 0xff;

  let canvas: HTMLCanvasElement | null = null;
  let c2d: CanvasRenderingContext2D | null = null;
  let img: ImageData | null = null;
  let fogTex: Texture | null = null;
  const fieldA = new Float32Array(fw * fh);
  const fieldB = new Float32Array(fw * fh);

  try {
    canvas = document.createElement("canvas");
    canvas.width = fw;
    canvas.height = fh;
    c2d = canvas.getContext("2d");
    if (c2d) {
      img = c2d.createImageData(fw, fh);
      fogTex = Texture.from(canvas);
      fogTex.source.scaleMode = "linear";
      const sp = new Sprite(fogTex);
      sp.position.set(x0, y0);
      sp.width = wpx;
      sp.height = hpx;
      fog.addChild(sp);
    }
  } catch {
    c2d = null; // no canvas → no fog veil; the scene still runs
  }

  /** Separable 1-2-1 blur, `BLUR_PASSES` times, A → A (B is scratch). */
  const blur = (): void => {
    for (let p = 0; p < BLUR_PASSES; p++) {
      for (let y = 0; y < fh; y++) {
        const row = y * fw;
        for (let x = 0; x < fw; x++) {
          const l = fieldA[row + (x > 0 ? x - 1 : 0)];
          const c = fieldA[row + x];
          const r = fieldA[row + (x < fw - 1 ? x + 1 : fw - 1)];
          fieldB[row + x] = (l + c * 2 + r) * 0.25;
        }
      }
      for (let x = 0; x < fw; x++) {
        for (let y = 0; y < fh; y++) {
          const u = fieldB[(y > 0 ? y - 1 : 0) * fw + x];
          const c = fieldB[y * fw + x];
          const d = fieldB[(y < fh - 1 ? y + 1 : fh - 1) * fw + x];
          fieldA[y * fw + x] = (u + c * 2 + d) * 0.25;
        }
      }
    }
  };

  const refresh = (): void => {
    if (!c2d || !img || !fogTex) return;
    const px = f.party.x;
    const py = f.party.y;

    for (let y = 0; y < fh; y++) {
      const ty = y - bleed;
      for (let x = 0; x < fw; x++) {
        const tx = x - bleed;
        const o = y * fw + x;
        const dx = tx - px;
        const dy = ty - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const inside = tx >= 0 && ty >= 0 && tx < f.w && ty < f.h;
        const i = ty * f.w + tx;
        if (!inside || !f.explored[i]) {
          // rock: dark, cloudy, and it keeps getting darker with distance so
          // the party always sits in a pool of light inside endless stone
          fieldA[o] =
            A_UNSEEN +
            (hash2(x, y) - 0.5) * A_UNSEEN_NOISE * 2 +
            Math.min(A_ROCK_FALLOFF_MAX, dist * A_FALLOFF);
          continue;
        }
        fieldA[o] = f.visible.has(i)
          ? A_LIT + Math.min(A_FALLOFF_MAX, dist * A_FALLOFF)
          : A_REMEMBERED + Math.min(A_MEM_FALLOFF_MAX, dist * A_MEM_FALLOFF);
      }
    }
    blur();

    const data = img.data;
    for (let o = 0, p = 0; o < fieldA.length; o++, p += 4) {
      data[p] = fr;
      data[p + 1] = fg;
      data[p + 2] = fb;
      const a = fieldA[o];
      data[p + 3] = a <= 0 ? 0 : a >= 1 ? 255 : (a * 255) | 0;
    }
    c2d.putImageData(img, 0, 0);
    fogTex.source.update();
  };

  /* ---- lantern ------------------------------------------------------ */

  const light = new Container();
  light.eventMode = "none";
  const warm = mix(PAL.gold, th.accent, 0.25);
  const halo = new Container();
  const tex = radialTexture();
  if (tex) {
    const wide = new Sprite({ texture: tex, anchor: 0.5 });
    wide.width = tile * 15;
    wide.height = tile * 15;
    wide.tint = mix(warm, PAL.energy, 0.35);
    wide.alpha = 0.16;
    wide.blendMode = "add";

    const core = new Sprite({ texture: tex, anchor: 0.5 });
    core.width = tile * 7.5;
    core.height = tile * 7.5;
    core.tint = warm;
    core.alpha = 0.34;
    core.blendMode = "add";

    halo.addChild(wide, core);
  }
  light.addChild(halo);

  let t = 0;
  refresh();

  return {
    rock,
    fog,
    light,
    refresh,
    update(dtMs: number, px: number, py: number) {
      t += dtMs;
      halo.position.set(px, py);
      const flick = 1 + Math.sin(t / 610) * 0.05 + Math.sin(t / 197) * 0.025;
      halo.scale.set(flick);
      halo.alpha = 0.94 + Math.sin(t / 430) * 0.06;
    },
    destroy() {
      fogTex?.destroy(true);
      fogTex = null;
      canvas = null;
      c2d = null;
      img = null;
    },
  };
}
