/**
 * Touch runtime (docs/design/mobile.md §§1-3).
 *
 * THREE jobs, and nothing else:
 *
 *  1. **Am I a finger?** `isTouch()` answers once, from the pointer media
 *     query plus `maxTouchPoints`, with a `?touch=1` / `?touch=0` override so
 *     a desktop browser (and a CI smoke) can force either mode. The answer is
 *     also stamped on `<html data-touch>` so `public/style.css` can key the
 *     rotate gate and the system button off it without a second detector.
 *
 *  2. **How big is a finger, in design pixels?** The game renders at a fixed
 *     1280×720 design resolution scaled uniformly into the window (main.ts),
 *     so a 44 CSS px target — the smallest reliable one — is `44 / scale`
 *     DESIGN px, and that number moves with the window. On an iPhone-class
 *     844×390 landscape viewport the scale is 0.54, so 44 CSS px is 81 design
 *     px: nearly every button in the game is visually smaller than that.
 *
 *  3. **So grow the TARGET, not the art.** `padHit` installs a hit area that
 *     recomputes its own padding on every hit test from the live scale. The
 *     button still LOOKS like a 34px-tall chip on a desktop monitor; under a
 *     finger it answers to a 44 CSS px box centred on the same pixels. On a
 *     fine pointer the padding is zero and the hit area is exactly the art —
 *     mouse users get no sloppy overhang.
 *
 * Pixi-light on purpose: only `Container` is imported (for the hit-area
 * helpers), and nothing here touches gameplay.
 */
import type { Container } from "pixi.js";
import { DESIGN_H, DESIGN_W } from "./layout.js";

/** The smallest reliable touch target, in CSS pixels. */
export const MIN_TOUCH_CSS = 44;

/**
 * Never inflate a target by more than this fraction of its own size on each
 * side. A 16px status chip asking for a 81px box would swallow its whole row;
 * capping keeps neighbours reachable while still roughly doubling the chip.
 */
const MAX_GROWTH = 1.1;

let coarse = false;
let scale = 1;
let detected = false;

/** Read the `?touch=` override, if any. */
function override(): boolean | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("touch");
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

/**
 * Detect the pointer kind and stamp it on `<html>`. Idempotent; call once
 * from the bootstrap, before the first scene mounts.
 */
export function initTouch(): void {
  if (detected) return;
  detected = true;
  const forced = override();
  if (forced !== null) {
    coarse = forced;
  } else if (typeof window !== "undefined") {
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)")
        : null;
    coarse =
      (mq?.matches ?? false) ||
      (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.touch = coarse ? "1" : "0";
  }
}

/** Is the primary pointer a finger? */
export function isTouch(): boolean {
  if (!detected) initTouch();
  return coarse;
}

/**
 * Feed the live letterbox scale (main.ts's `layout()` owns it). Everything
 * below converts CSS pixels to design pixels through this number.
 */
export function setViewScale(next: number): void {
  if (next > 0) scale = next;
}

export function viewScale(): number {
  return scale;
}

/** The current design-pixel size of one 44 CSS px touch target. */
export function minHitDesign(): number {
  return MIN_TOUCH_CSS / scale;
}

/**
 * Extra design px to add on EACH side of a `size`-wide edge so the whole
 * edge reaches `MIN_TOUCH_CSS`. Zero on a fine pointer, and never more than
 * `MAX_GROWTH ×` the edge itself.
 */
export function touchPad(size: number): number {
  if (!isTouch()) return 0;
  const want = (minHitDesign() - size) / 2;
  if (want <= 0) return 0;
  return Math.min(want, size * MAX_GROWTH);
}

/**
 * Give `view` a rectangular hit area of `w`×`h` (local coords, origin at the
 * top-left unless `origin` says otherwise) that grows under a finger.
 *
 * The returned hit area is DYNAMIC: `contains` reads the live scale, so one
 * call at build time keeps working after a rotate or a window resize without
 * the scene rebuilding anything.
 */
export function padHit(
  view: Container,
  w: number,
  h: number,
  opts: { origin?: "topLeft" | "center" } = {},
): void {
  const centred = opts.origin === "center";
  const x0 = centred ? -w / 2 : 0;
  const y0 = centred ? -h / 2 : 0;
  view.hitArea = {
    contains(px: number, py: number): boolean {
      const mx = touchPad(w);
      const my = touchPad(h);
      return (
        px >= x0 - mx && px <= x0 + w + mx && py >= y0 - my && py <= y0 + h + my
      );
    },
  };
}

/** Circular sibling of `padHit` — medallions, avatars, round chips. */
export function padHitCircle(view: Container, r: number): void {
  view.hitArea = {
    contains(px: number, py: number): boolean {
      const rr = r + touchPad(r * 2);
      return px * px + py * py <= rr * rr;
    },
  };
}

/**
 * A hit area that is a rect in the view's own coordinates but whose box is
 * given explicitly — for units whose art is centred on their feet, or any
 * other non-top-left anchor.
 */
export function padHitBox(
  view: Container,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  view.hitArea = {
    contains(px: number, py: number): boolean {
      const mx = touchPad(w);
      const my = touchPad(h);
      return (
        px >= x - mx && px <= x + w + mx && py >= y - my && py <= y + h + my
      );
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Hover → tap                                                             */
/* ---------------------------------------------------------------------- */

export interface RevealOpts {
  /** Show the informational thing (tooltip, nameplate, preview). */
  show(): void;
  /** Hide it again. */
  hide(): void;
  /**
   * What a COMMITTING tap does. When present the widget is "inspect first,
   * commit second" on touch: the first tap reveals, a second tap on the same
   * widget commits. On a mouse, hover reveals and one click commits, exactly
   * as before.
   */
  commit?: () => void;
  /** True while the reveal is already up (the caller owns that state). */
  isShown(): boolean;
}

/**
 * Wire ONE informational affordance so it works with both a mouse and a
 * finger (docs/design/mobile.md §2).
 *
 *  • mouse — `pointerover` shows, `pointerout` hides, `pointertap` commits.
 *    Byte-identical behaviour to the hover-only code it replaces.
 *  • touch — the first `pointertap` shows (nothing is committed yet), the
 *    second commits. With no `commit` the second tap just hides again, so a
 *    purely informational tooltip is still reachable and still dismissible.
 *
 * The view must already be `eventMode: 'static'`.
 */
export function tapToReveal(view: Container, opts: RevealOpts): void {
  view.on("pointerover", () => {
    if (isTouch()) return; // a synthetic hover from a tap must not double-fire
    opts.show();
  });
  view.on("pointerout", () => {
    if (isTouch()) return;
    opts.hide();
  });
  view.on("pointertap", () => {
    if (!isTouch()) {
      opts.hide();
      opts.commit?.();
      return;
    }
    if (opts.isShown()) {
      opts.hide();
      opts.commit?.();
      return;
    }
    opts.show();
  });
}

/* ---------------------------------------------------------------------- */
/* Orientation                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Is the window too portrait to lay the game out? The design is 16:9 and
 * every screen is wide by nature (a 4v5 battle line, a route map, a shop), so
 * mobile.md's ruling is: gate portrait behind a rotate prompt rather than
 * ship a broken reflow. Desktop windows are never gated — a narrow desktop
 * window is the user's business.
 */
export function isPortraitGated(): boolean {
  if (typeof window === "undefined") return false;
  if (!isTouch()) return false;
  return window.innerHeight > window.innerWidth;
}

/** The design-resolution aspect, exported so CSS/tests agree with main.ts. */
export const DESIGN_ASPECT = DESIGN_W / DESIGN_H;
