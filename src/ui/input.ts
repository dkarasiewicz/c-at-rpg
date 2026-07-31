/**
 * WP-08 — input plumbing (ARCHITECTURE.md §3.3): exactly one keydown/keyup
 * listener for the whole game, key normalization, held-key state, and a
 * pointer normalizer that converts client coordinates to 1280×720 design
 * coordinates via the root transform.
 *
 * Dispatch order: active overlay → active scene. A handler returns true to
 * consume the key. OS auto-repeat never reaches a handler (the tile crawl's
 * held-to-walk movement went with the maze — the run map is one keypress per
 * decision); a scene that wants held-key behaviour polls `isKeyDown`.
 */
import { Container, Point } from "pixi.js";

/** Returns true when the key was consumed. */
export type KeyHandler = (key: string) => boolean;

const NAME_MAP: Record<string, string> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  escape: "esc",
  " ": "space",
};

/** Normalize a KeyboardEvent.key to the game's key names. */
export function normalizeKey(raw: string): string {
  const k = raw.toLowerCase();
  return NAME_MAP[k] ?? k;
}

/** Keys we preventDefault on even when unconsumed (scroll/focus stealers). */
const SWALLOW = new Set(["up", "down", "left", "right", "space", "tab"]);

const down = new Set<string>();
let overlayHandler: KeyHandler | null = null;
let sceneHandler: KeyHandler | null = null;
let installed = false;

/** Overlay-first key routing: the active overlay's handler (or null). */
export function setOverlayKeyHandler(h: KeyHandler | null): void {
  overlayHandler = h;
}

/** The active scene's key handler (or null). */
export function setSceneKeyHandler(h: KeyHandler | null): void {
  sceneHandler = h;
}

/** Is a (normalized) key currently held? For any hold-to-act affordance. */
export function isKeyDown(key: string): boolean {
  return down.has(key);
}

/**
 * Install the one keyboard listener pair. Idempotent; call once from
 * main.ts bootstrap.
 */
export function initInput(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener("keydown", (e) => {
    const key = normalizeKey(e.key);
    if (!e.repeat) {
      down.add(key);
      const consumed = overlayHandler?.(key) || sceneHandler?.(key) || false;
      if (consumed || SWALLOW.has(key)) e.preventDefault();
    } else if (SWALLOW.has(key)) {
      e.preventDefault(); // OS auto-repeat never reaches handlers
    }
  });
  target.addEventListener("keyup", (e) => {
    down.delete(normalizeKey(e.key));
  });
  target.addEventListener("blur", () => down.clear());
}

/* ---------------------------------------------------------------------- */
/* Pointer helpers                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Make a client→design coordinate converter for the letterboxed root
 * container (ui-art §1: root is uniformly scaled + centered on the canvas).
 * With `autoDensity: true` the canvas CSS size equals renderer screen size,
 * so client offsets map straight through the root's world transform.
 */
export function makePointerNormalizer(
  canvas: HTMLCanvasElement,
  root: Container,
): (clientX: number, clientY: number) => Point {
  return (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return root.worldTransform.applyInverse(new Point(sx, sy));
  };
}

/** Convert a pixi global point (event.global) to root design coordinates. */
export function toDesign(root: Container, global: Point, out?: Point): Point {
  return root.worldTransform.applyInverse(global, out ?? new Point());
}

/** Is a design-space point inside [x, y, w, h]? */
export function pointInRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return px >= x && px < x + w && py >= y && py < y + h;
}
