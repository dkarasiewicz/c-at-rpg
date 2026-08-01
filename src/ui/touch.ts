/**
 * Touch runtime (docs/design/mobile.md §§1-3).
 *
 * FOUR jobs, and nothing else:
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
 *  4. **What does a finger MEAN?** `tapAct` answers with one rule, used
 *     everywhere: a TAP ACTS and a LONG PRESS READS. The old model — tap to
 *     inspect, tap again to commit — made an attack impossible to land the
 *     moment anything reset the inspect state between the two taps, and it
 *     charged every single turn an extra tap. A tap now commits, full stop;
 *     the details you used to get for free from a hover are a 400 ms hold.
 *
 * Nothing here touches gameplay: it is pointer plumbing plus the one ring
 * that acknowledges a held finger.
 */
import { Graphics, type Container } from "pixi.js";
import { DESIGN_H, DESIGN_W } from "./layout.js";
import { PAL } from "./palette.js";
import { killTweens, tween } from "./tween.js";

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
/* Tap = act, long press = details                                         */
/* ---------------------------------------------------------------------- */

/**
 * How long a finger must stay down to mean "tell me about this" rather than
 * "do this". 400 ms is the platform convention (iOS's own callout timer) and
 * comfortably longer than any tap a player makes on purpose.
 */
export const LONG_PRESS_MS = 400;

/**
 * How far the finger may travel, in CSS px, before the press stops counting
 * as a press. A long press must never fight a drag or a flick.
 */
export const LONG_PRESS_SLOP = 12;

export interface TapActOpts {
  /**
   * COMMIT — what the widget is for. A tap fires this immediately, with no
   * confirmation step: on touch, ambiguity between "inspect" and "act" is
   * what made an attack impossible to land (docs/design/mobile.md §2).
   * Omit for a purely informational affordance; then a tap toggles `details`
   * instead, because there is nothing to commit and the info must stay
   * reachable.
   */
  act?: () => void;
  /** Open the details (tooltip, inspect card, nameplate). */
  details?: () => void;
  /** Close them again. */
  hideDetails?: () => void;
  /** True while the details are up — lets a long press toggle them. */
  detailsShown?: () => boolean;
  /**
   * Also wire `pointerover`/`pointerout` to `details`/`hideDetails` on a fine
   * pointer. Off by default, for callers that already own their own hover
   * handlers (battle units sync the targeting preview in theirs).
   */
  hover?: boolean;
  /**
   * Draw the press ring inside the view. Default true. Turn it off for views
   * that are clipped, masked, or measured by their children.
   */
  ack?: boolean;
  /**
   * Close the details before committing. Default true — a tooltip about a
   * thing that just changed is stale. Set false when `act` owns the details
   * itself (battle units toggle the inspect card from inside their act).
   */
  hideOnAct?: boolean;
}

/**
 * Wire ONE affordance so it works with both a mouse and a finger.
 *
 *  • **mouse** — unchanged forever: hover reveals (when `hover`), one click
 *    commits.
 *  • **touch** — a TAP COMMITS, immediately. A LONG PRESS (`LONG_PRESS_MS`)
 *    opens the details instead and swallows the tap that follows it, with a
 *    ring growing under the finger so the wait reads as deliberate rather
 *    than as lag. Any finger travel past `LONG_PRESS_SLOP`, or a cancelled
 *    pointer, aborts the press cleanly.
 *
 * The view must already be `eventMode: 'static'`.
 */
export function tapAct(view: Container, opts: TapActOpts): void {
  if (opts.hover === true) {
    view.on("pointerover", () => {
      if (isTouch()) return; // a synthetic hover from a tap must not double-fire
      opts.details?.();
    });
    view.on("pointerout", () => {
      if (isTouch()) return;
      opts.hideDetails?.();
    });
  }

  const commit = (): void => {
    if (opts.act) {
      if (opts.hideOnAct !== false) opts.hideDetails?.();
      opts.act();
      return;
    }
    // informational only: nothing to commit, so a tap toggles the details —
    // they must stay reachable, and there is no action for it to shadow
    if (opts.detailsShown?.() === true) opts.hideDetails?.();
    else opts.details?.();
  };

  if (!isTouch()) {
    view.on("pointertap", commit);
    return;
  }

  /* ---- the finger --------------------------------------------------- */
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ring: Container | null = null;
  let from: { x: number; y: number } | null = null;
  /** The long press already fired; the `pointertap` behind it is not an act. */
  let consumed = false;

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    from = null;
    const r = ring;
    ring = null;
    if (r) fadeRing(r);
  };

  const fire = (): void => {
    timer = null;
    from = null;
    if (view.destroyed) return;
    consumed = true;
    popRing(ring);
    ring = null;
    buzz();
    if (opts.detailsShown?.() === true) opts.hideDetails?.();
    else opts.details?.();
  };

  view.on("pointerdown", (e) => {
    consumed = false;
    stop();
    if (opts.details === undefined) return;
    from = { x: e.global.x, y: e.global.y };
    ring =
      opts.ack === false ? null : pressRing(view, e.getLocalPosition(view));
    timer = setTimeout(fire, LONG_PRESS_MS);
  });
  view.on("globalpointermove", (e) => {
    if (from === null) return;
    const dx = e.global.x - from.x;
    const dy = e.global.y - from.y;
    if (dx * dx + dy * dy > LONG_PRESS_SLOP * LONG_PRESS_SLOP) stop();
  });
  view.on("pointerup", stop);
  view.on("pointerupoutside", () => {
    stop();
    consumed = false;
  });
  view.on("pointercancel", () => {
    stop();
    consumed = true; // an interrupted press must not fall through to an act
  });
  view.on("pointertap", () => {
    if (consumed) {
      consumed = false;
      return;
    }
    commit();
  });
}

/* ---- press acknowledgement ------------------------------------------- */

/**
 * The ring that grows under a held finger. It exists so a 400 ms wait reads
 * as a gesture in progress instead of as a dropped tap: the moment the ring
 * is full, the details are open.
 */
function pressRing(view: Container, at: { x: number; y: number }): Container {
  const g = new Graphics()
    .circle(0, 0, 34)
    .stroke({ width: 3, color: PAL.gold, alpha: 1 });
  g.position.set(at.x, at.y);
  g.scale.set(0.3);
  g.alpha = 0;
  g.eventMode = "none";
  view.addChild(g);
  tween(g, { alpha: 0.7 }, 130);
  tween(g.scale, { x: 1, y: 1 }, LONG_PRESS_MS, "quadOut");
  return g;
}

function fadeRing(g: Container): void {
  if (g.destroyed) return;
  killTweens(g);
  killTweens(g.scale);
  tween(g, { alpha: 0 }, 90, "linear", () => {
    if (!g.destroyed) g.destroy();
  });
}

function popRing(g: Container | null): void {
  if (!g || g.destroyed) return;
  killTweens(g);
  killTweens(g.scale);
  tween(g.scale, { x: 1.4, y: 1.4 }, 150, "quadOut");
  tween(g, { alpha: 0 }, 150, "linear", () => {
    if (!g.destroyed) g.destroy();
  });
}

/** Haptic tick where the platform has one. Silently absent on iOS Safari. */
function buzz(): void {
  try {
    (navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
  } catch {
    /* a missing haptic is never worth a frame */
  }
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
