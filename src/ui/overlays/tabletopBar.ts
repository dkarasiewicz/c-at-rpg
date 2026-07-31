/**
 * The tabletop bar — "what do you do?" (docs/design/run-map-and-dm.md §3).
 *
 * ONE component, used by BOTH the battle scene and the encounter/event scene:
 * a kit-styled card with a text field, the player's line echoed back, and the
 * DM's reply streamed in as it arrives. It renders and it collects text — it
 * decides nothing. Every verdict, lint and effect belongs to the caller.
 *
 * Why a DOM `<input>` and not a pixi widget: pixi has no text entry, the game
 * already does exactly this for the GM free-text option in the event scene,
 * and a real input gets IME, mobile keyboards, selection and paste for free.
 * The element is positioned THROUGH the same letterbox transform main.ts
 * applies to the root container, so it sits inside the card at any window
 * size, and it stops keyboard events from reaching the game's single window
 * listener while it has focus.
 *
 * Offline-first: this component is never built when the DM is unreachable.
 * A scene that cannot reach a DM simply never calls `createTabletopBar`.
 */
import { Container, Graphics } from "pixi.js";
import { DESIGN_H, DESIGN_W, SPACE, type Rect } from "../layout.js";
import { PAL } from "../palette.js";
import { TYPE } from "../textStyles.js";
import { button, heading, label, panel } from "../widgets.js";
import { MAX_PROMPT } from "../../services/tabletop.js";

/** How the DM's answer reads. */
export type ReplyTone =
  /** the DM told you what happened */
  | "told"
  /** the DM said no, in character — NEVER an error */
  | "refused"
  /** the DM did not answer in time; the moment passes */
  | "quiet";

export interface TabletopBarOpts {
  /** Card rect in design px. Defaults to a centred 760×212 card. */
  rect?: Rect;
  /** Eyebrow over the field. */
  title?: string;
  placeholder?: string;
  /** Enter with a non-empty line. */
  onSubmit(text: string): void;
  /** Esc, or the Never mind button. */
  onCancel?: () => void;
  /** Called once the reply has been read and the card dismissed. */
  onDismiss?: () => void;
}

export interface TabletopBar {
  /** Add this to a scene layer (modal is the intended one). */
  view: Container;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Switch to the waiting beat: the line echoed, the DM thinking. */
  waiting(prompt: string): void;
  /** Streamed narration so far (cumulative, not a delta). */
  stream(soFar: string): void;
  /** The final beat. `tone` styles it; refusals are never red-alert errors. */
  reply(text: string, tone: ReplyTone): void;
  /** Ellipsis animation; call from the scene's update. */
  update(dtMs: number): void;
  destroy(): void;
}

/**
 * The card's WIDTH and its top-left; the height is set per phase (see
 * `fitCard`) so the typing beat is not a tall empty box with one line of
 * text at the top and the key hint stranded at the bottom.
 */
const DEFAULT_RECT: Rect = [(DESIGN_W - 760) / 2, DESIGN_H / 2 - 150, 760, 212];

type Phase = "closed" | "typing" | "waiting" | "reply";

/**
 * The design→client transform main.ts installs on the root container:
 * uniform letterbox scale, centred. Returns null when the canvas is not in
 * the document (headless tests), and the caller falls back to fixed CSS.
 */
function designToClient(): { x: number; y: number; scale: number } | null {
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

export function createTabletopBar(opts: TabletopBarOpts): TabletopBar {
  const [rx, ry, rw] = opts.rect ?? DEFAULT_RECT;
  const view = new Container();
  view.position.set(rx, ry);
  view.visible = false;

  // rebuilt by `fitCard` — the card grows from the typing beat to the reply
  let card = panel(rw, 1, { variant: "raised", accent: PAL.gold });
  view.addChild(card);

  const eyebrow = heading(opts.title ?? "WHAT DO YOU DO?", 3, {
    fill: PAL.gold,
  });
  eyebrow.position.set(SPACE.lg, SPACE.md);
  view.addChild(eyebrow);

  // the field's visual well; the real <input> is layered over it in the DOM
  const wellY = SPACE.md + 28;
  const wellH = 44;
  const well = new Graphics()
    .roundRect(SPACE.lg, wellY, rw - SPACE.lg * 2, wellH, 6)
    .fill({ color: PAL.hpBack, alpha: 0.95 })
    .stroke({ width: 1, color: PAL.border });
  view.addChild(well);

  const echo = label("", {
    size: TYPE.body,
    wrap: rw - SPACE.lg * 2,
    fill: PAL.text,
  });
  echo.position.set(SPACE.lg, wellY + 10);
  echo.visible = false;
  view.addChild(echo);

  const body = label("", {
    size: TYPE.body,
    wrap: rw - SPACE.lg * 2,
    dim: true,
  });
  body.position.set(SPACE.lg, wellY + wellH + SPACE.md);
  view.addChild(body);

  /**
   * Typing-beat guidance. It is here for composition (the card would
   * otherwise be two thirds empty) but it earns its place: refusal is a
   * legitimate outcome (run-map-and-dm.md §3) and the player should know
   * that before typing, not discover it from a "no".
   */
  const guide = label(
    "Say it in your own words. The DM answers in character — and is\n" +
      "allowed to tell you no.",
    { size: TYPE.tiny, dim: true },
  );
  guide.style.lineHeight = 17;
  guide.position.set(SPACE.lg, wellY + wellH + SPACE.md);
  view.addChild(guide);

  const hint = label("Enter to act  ·  Esc to think better of it", {
    size: TYPE.tiny,
    dim: true,
  });
  view.addChild(hint);

  const dismiss = button("Continue", 160, 40, () => dismissReply(), {
    primary: true,
    hotkey: "E",
  });
  dismiss.view.visible = false;
  view.addChild(dismiss.view);

  /** Height of the typing beat: eyebrow, well, guide, key hint. */
  const TYPING_H =
    wellY +
    wellH +
    SPACE.md +
    Math.ceil(guide.height) +
    SPACE.lg +
    14 +
    SPACE.md;

  /**
   * Resize the card to `h` and pin the footer chrome to its new bottom.
   * `panel()` bakes its size into a Graphics, so it is rebuilt rather than
   * scaled (scaling would smear the 1px border and the corner radius).
   */
  const fitCard = (h: number): void => {
    card.destroy({ children: true });
    card = panel(rw, h, { variant: "raised", accent: PAL.gold });
    view.addChildAt(card, 0);
    hint.position.set(SPACE.lg, h - 14 - SPACE.md);
    dismiss.view.position.set(rw - 160 - SPACE.lg, h - 40 - SPACE.md);
  };

  /** Reply/waiting beat: exactly as tall as the narration needs. */
  const fitToBody = (): void => {
    body.position.y = echo.y + Math.ceil(echo.height) + SPACE.md;
    const bottom = body.position.y + Math.ceil(body.height);
    fitCard(bottom + SPACE.md + 40 + SPACE.md);
  };

  fitCard(TYPING_H);

  let phase: Phase = "closed";
  let inputEl: HTMLInputElement | null = null;
  let ellipsis = 0;
  let waitingBase = "";

  /* ---- the DOM field ------------------------------------------------- */

  const placeField = (): void => {
    if (!inputEl) return;
    const t = designToClient();
    const fx = rx + SPACE.lg;
    const fy = ry + wellY;
    const fw = rw - SPACE.lg * 2;
    if (t) {
      inputEl.style.left = `${t.x + fx * t.scale}px`;
      inputEl.style.top = `${t.y + fy * t.scale}px`;
      inputEl.style.width = `${fw * t.scale}px`;
      inputEl.style.height = `${wellH * t.scale}px`;
      inputEl.style.fontSize = `${Math.max(11, Math.round(17 * t.scale))}px`;
    } else {
      // headless / canvas-less fallback: centred, like the old event input
      inputEl.style.left = "50%";
      inputEl.style.top = "62%";
      inputEl.style.transform = "translateX(-50%)";
      inputEl.style.width = "min(600px, 86vw)";
      inputEl.style.fontSize = "16px";
    }
  };

  const openField = (): void => {
    if (inputEl || typeof document === "undefined") return;
    const el = document.createElement("input");
    el.type = "text";
    el.maxLength = MAX_PROMPT;
    el.placeholder = opts.placeholder ?? "Bruno pries the grate open…";
    el.autocomplete = "off";
    el.spellcheck = false;
    el.style.cssText =
      "position:fixed;box-sizing:border-box;padding:0 14px;" +
      `color:${css(PAL.text)};background:transparent;` +
      "border:none;outline:none;z-index:10;font-family:inherit;";
    // the game's single window key listener must never see typing
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const text = el.value.trim().slice(0, MAX_PROMPT);
        if (text.length > 0) opts.onSubmit(text);
      } else if (e.key === "Escape") {
        closeField();
        bar.close();
        opts.onCancel?.();
      }
    });
    el.addEventListener("keyup", (e) => e.stopPropagation());
    document.body.appendChild(el);
    inputEl = el;
    placeField();
    window.addEventListener("resize", placeField);
    el.focus();
  };

  const closeField = (): void => {
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", placeField);
    }
    inputEl?.remove();
    inputEl = null;
  };

  const dismissReply = (): void => {
    bar.close();
    opts.onDismiss?.();
  };

  /* ---- the handle ---------------------------------------------------- */

  const bar: TabletopBar = {
    view,

    open() {
      phase = "typing";
      view.visible = true;
      well.visible = true;
      echo.visible = false;
      body.text = "";
      body.visible = false;
      guide.visible = true;
      hint.visible = true;
      dismiss.view.visible = false;
      fitCard(TYPING_H);
      openField();
    },

    close() {
      phase = "closed";
      closeField();
      view.visible = false;
    },

    isOpen() {
      return phase !== "closed";
    },

    waiting(prompt: string) {
      phase = "waiting";
      closeField();
      view.visible = true;
      well.visible = false;
      echo.visible = true;
      echo.text = `“${prompt}”`;
      body.visible = true;
      body.style.fill = PAL.textDim;
      guide.visible = false;
      waitingBase = "the DM considers it";
      body.text = waitingBase;
      hint.visible = false;
      dismiss.view.visible = false;
      ellipsis = 0;
      fitToBody();
    },

    stream(soFar: string) {
      if (phase !== "waiting") return;
      waitingBase = "";
      body.style.fill = PAL.text;
      body.text = soFar;
      fitToBody();
    },

    reply(text: string, tone: ReplyTone) {
      phase = "reply";
      closeField();
      view.visible = true;
      well.visible = false;
      echo.visible = true;
      waitingBase = "";
      body.visible = true;
      guide.visible = false;
      body.style.fill =
        tone === "refused"
          ? PAL.gold
          : tone === "quiet"
            ? PAL.textDim
            : PAL.text;
      body.text = text;
      hint.visible = false;
      dismiss.view.visible = true;
      fitToBody();
    },

    update(dtMs: number) {
      if (phase !== "waiting" || waitingBase === "") return;
      ellipsis += dtMs;
      const dots = 1 + (Math.floor(ellipsis / 400) % 3);
      body.text = waitingBase + ".".repeat(dots);
    },

    destroy() {
      closeField();
      view.parent?.removeChild(view);
      view.destroy({ children: true });
    },
  };

  return bar;
}

/**
 * The always-visible affordance that opens the bar: a small gold-keyed chip
 * ("[T] say what you do"). Scenes park it in their HUD and only build it when
 * a DM is reachable.
 */
export function createTabletopChip(
  onTap: () => void,
  text = "say what you do",
): { view: Container; setEnabled(on: boolean): void } {
  const b = button(text, 220, 30, onTap, { hotkey: "T", fontSize: TYPE.small });
  return b;
}

/** Exposed for tests/layout: the card's default rect. */
export const TABLETOP_CARD_RECT: Rect = DEFAULT_RECT;
