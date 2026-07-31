/**
 * The one HTML text field the game overlays on the canvas
 * (docs/design/mobile.md §5).
 *
 * Pixi has no text entry, so every typed-action surface — the tabletop card's
 * "what do you do?", the title screen's seed entry — borrows a real `<input>`
 * positioned THROUGH main.ts's letterbox transform so it lands inside the
 * pixi widget that drew its well. One module owns that, because the hard part
 * is not the element: it is the VIRTUAL KEYBOARD.
 *
 * ── Why `visualViewport` ────────────────────────────────────────────────
 * When a phone keyboard opens it does not resize the layout viewport, so
 * `window.innerHeight` lies and a field positioned from it ends up under the
 * keyboard, invisible, while the player types blind. `window.visualViewport`
 * reports the part of the page that is actually VISIBLE: its `height` shrinks
 * to the gap above the keyboard and its `offsetTop` tracks the browser's own
 * scroll-to-reveal nudge. We listen to it and, whenever the field would fall
 * below that gap, float the field (and its backing plate) up to sit just
 * above the keyboard instead — detached from the card, still legible, always
 * on screen. On a desktop browser `visualViewport` never changes and the
 * field simply stays inside its well.
 *
 * The element also stops keyboard events from reaching the game's single
 * window listener while it has focus (src/ui/input.ts), so typing "1" into a
 * prompt can never fire skill slot 1.
 */
import { DESIGN_H, DESIGN_W } from "./layout.js";
import { PAL } from "./palette.js";
import { isTouch } from "./touch.js";

/**
 * The design→client transform main.ts installs on the root container:
 * uniform letterbox scale, centred. Returns null when the canvas is not in
 * the document (headless tests), and callers fall back to fixed CSS.
 */
export function designToClient(): {
  x: number;
  y: number;
  scale: number;
} | null {
  if (typeof document === "undefined") return null;
  const canvas = document.querySelector("canvas");
  if (!canvas) return null;
  const box = canvas.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / DESIGN_W, box.height / DESIGN_H);
  return {
    x: box.left + (box.width - DESIGN_W * scale) / 2,
    y: box.top + (box.height - DESIGN_H * scale) / 2,
    scale,
  };
}

const css = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

/**
 * iOS zooms the page when a focused field's text is under 16px, and
 * `user-scalable=no` does not always stop it. 16 is the floor everywhere on
 * touch; a desktop field can shrink with the letterbox.
 */
const MIN_FONT_PX = 16;

/** Gap kept between the field and the top edge of the virtual keyboard. */
const KEYBOARD_GAP = 10;

export interface DomInputOpts {
  /** Where the field lives in design space, when the keyboard is not up. */
  rect: { x: number; y: number; w: number; h: number };
  placeholder: string;
  maxLength: number;
  /** Enter / the keyboard's Go key, with a non-empty trimmed value. */
  onSubmit(text: string): void;
  /** Escape. Touch has no Escape — hosts must also offer a Cancel button. */
  onCancel?: () => void;
  /** Fires on every edit, for hosts that mirror the value into pixi. */
  onInput?: (text: string) => void;
  /** Uppercase-only entry with a restricted alphabet (the seed field). */
  filter?: (raw: string) => string;
  /** Virtual-keyboard action label. Default 'go'. */
  enterKeyHint?: "go" | "send" | "done" | "enter";
}

export interface DomInput {
  /** The live value, trimmed and clamped to `maxLength`. */
  value(): string;
  setValue(text: string): void;
  focus(): void;
  /** Re-place the field (call after the host card changes size). */
  reflow(): void;
  destroy(): void;
}

/**
 * Mount the field. The element is removed by `destroy()`, which every host
 * MUST call before its pixi parent is destroyed — an orphaned `<input>`
 * floats over the next scene.
 */
export function createDomInput(opts: DomInputOpts): DomInput {
  if (typeof document === "undefined") {
    return {
      value: () => "",
      setValue: () => {},
      focus: () => {},
      reflow: () => {},
      destroy: () => {},
    };
  }

  const el = document.createElement("input");
  el.type = "text";
  el.maxLength = opts.maxLength;
  el.placeholder = opts.placeholder;
  el.autocomplete = "off";
  el.spellcheck = false;
  el.enterKeyHint = opts.enterKeyHint ?? "go";
  el.setAttribute("inputmode", "text");
  el.setAttribute("autocapitalize", "sentences");
  el.setAttribute("aria-label", opts.placeholder);
  // `touch-action: manipulation` overrides the page-wide `none` so the field
  // still accepts a tap to focus and a drag to select (public/style.css sets
  // `touch-action: none` on the canvas host to kill pinch-zoom).
  el.style.cssText =
    "position:fixed;box-sizing:border-box;padding:0 14px;margin:0;" +
    `color:${css(PAL.text)};background:transparent;caret-color:${css(PAL.gold)};` +
    "border:none;outline:none;z-index:20;font-family:inherit;" +
    "touch-action:manipulation;-webkit-user-select:text;user-select:text;";

  /**
   * The backing plate. While the field sits in its well the pixi card draws
   * the well and this stays hidden; once the keyboard lifts the field OUT of
   * the card, the field would otherwise float over bare artwork, so the plate
   * comes up behind it.
   */
  const plate = document.createElement("div");
  plate.style.cssText =
    `position:fixed;z-index:19;border-radius:8px;pointer-events:none;` +
    `background:${css(PAL.bgDeep)};border:1px solid ${css(PAL.gold)};` +
    "box-shadow:0 -6px 24px rgba(0,0,0,0.55);display:none;";

  let lifted = false;

  /** Where the virtual keyboard's top edge is, in client px. */
  const keyboardTop = (): number => {
    const vv = window.visualViewport;
    if (!vv) return window.innerHeight;
    return vv.offsetTop + vv.height;
  };

  const place = (): void => {
    const t = designToClient();
    const { x, y, w, h } = opts.rect;

    if (!t) {
      // headless / canvas-less fallback: a centred field, like the old one
      el.style.left = "50%";
      el.style.top = "62%";
      el.style.transform = "translateX(-50%)";
      el.style.width = "min(600px, 86vw)";
      el.style.height = "44px";
      el.style.fontSize = `${MIN_FONT_PX}px`;
      return;
    }

    el.style.transform = "";
    const cw = w * t.scale;
    const ch = Math.max(isTouch() ? 40 : 20, h * t.scale);
    const cx = t.x + x * t.scale;
    let cy = t.y + y * t.scale;

    // Would the field (or the room under it) be swallowed by the keyboard?
    const kbTop = keyboardTop();
    const wasLifted = lifted;
    lifted = cy + ch > kbTop - KEYBOARD_GAP;
    if (lifted) cy = Math.max(4, kbTop - ch - KEYBOARD_GAP);

    el.style.left = `${Math.round(cx)}px`;
    el.style.top = `${Math.round(cy)}px`;
    el.style.width = `${Math.round(cw)}px`;
    el.style.height = `${Math.round(ch)}px`;
    el.style.fontSize = `${Math.max(
      isTouch() ? MIN_FONT_PX : 11,
      Math.round(17 * t.scale),
    )}px`;

    if (lifted) {
      plate.style.display = "block";
      plate.style.left = `${Math.round(cx - 8)}px`;
      plate.style.top = `${Math.round(cy - 8)}px`;
      plate.style.width = `${Math.round(cw + 16)}px`;
      plate.style.height = `${Math.round(ch + 16)}px`;
    } else if (wasLifted) {
      plate.style.display = "none";
    }
  };

  el.addEventListener("keydown", (e) => {
    // the game's single window key listener must never see typing
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const text = el.value.trim().slice(0, opts.maxLength);
      if (text.length > 0) opts.onSubmit(text);
    } else if (e.key === "Escape") {
      opts.onCancel?.();
    }
  });
  el.addEventListener("keyup", (e) => e.stopPropagation());
  el.addEventListener("input", () => {
    if (opts.filter) {
      const next = opts.filter(el.value);
      if (next !== el.value) el.value = next;
    }
    opts.onInput?.(el.value);
  });
  // Focus itself is what opens the keyboard; the viewport only settles a
  // frame or two later, so re-place on the way in as well as on the events.
  el.addEventListener("focus", () => {
    place();
    setTimeout(place, 120);
    setTimeout(place, 400);
  });
  el.addEventListener("blur", () => {
    lifted = false;
    plate.style.display = "none";
    place();
  });

  document.body.appendChild(plate);
  document.body.appendChild(el);
  place();

  window.addEventListener("resize", place);
  window.addEventListener("orientationchange", place);
  const vv = window.visualViewport;
  vv?.addEventListener("resize", place);
  vv?.addEventListener("scroll", place);

  return {
    value: () => el.value.trim().slice(0, opts.maxLength),
    setValue(text: string) {
      el.value = text;
    },
    focus() {
      el.focus();
      place();
    },
    reflow: place,
    destroy() {
      window.removeEventListener("resize", place);
      window.removeEventListener("orientationchange", place);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      el.remove();
      plate.remove();
    },
  };
}
