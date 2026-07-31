/**
 * The tabletop bar — "what do you do?" (docs/design/run-map-and-dm.md §3, §4b).
 *
 * ONE component, used by ALL THREE hosts: the battle scene, the event scene,
 * and the run map. A kit-styled card with a text field, the player's line
 * echoed back, and the DM's reply streamed in as it arrives. It renders and it
 * collects text — it decides nothing. Every verdict, lint and effect belongs
 * to the caller.
 *
 * §4b requires the same VOICE in all three contexts, so the per-context copy
 * lives HERE, in `MODE_COPY`, keyed by `mode` — not at the three call sites,
 * where it would drift into three different DMs. A host picks a mode; it does
 * not write chrome.
 *
 * The card also renders the DM's UNPROMPTED beats (`interject`). That is the
 * same card on purpose: an interjection is an invitation to type back, so it
 * must be one Answer press away from the field it shares.
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
import { createDomInput, type DomInput } from "../domInput.js";
import { isTouch } from "../touch.js";
import { MAX_PROMPT } from "../../services/tabletop.js";

/** How the DM's answer reads. */
export type ReplyTone =
  /** the DM told you what happened */
  | "told"
  /** the DM said no, in character — NEVER an error */
  | "refused"
  /** the DM did not answer in time; the moment passes */
  | "quiet";

/**
 * Which of the three contexts the card is standing in (run-map-and-dm.md §4b
 * "typed actions everywhere"). One component, one voice, three framings.
 */
export type TabletopMode =
  /** inside a fight: it costs the turn, and the clock is running */
  | "fight"
  /** at an event card: the free-text option beside the authored ones */
  | "encounter"
  /** on the run map: the table between fights, nothing under time pressure */
  | "exploration";

interface ModeCopy {
  title: string;
  placeholder: string;
  guide: string;
}

/**
 * The per-context copy. Same DM, same bounds, same promise that "no" is a
 * legitimate answer — only the framing of what typing MEANS changes.
 */
const MODE_COPY: Record<TabletopMode, ModeCopy> = {
  fight: {
    title: "WHAT DO YOU DO?",
    placeholder: "Pixel throws the lantern at the oil slick…",
    guide:
      "Improvise instead of using a skill. It costs the turn, and the DM\n" +
      "answers in character — it is allowed to tell you no.",
  },
  encounter: {
    title: "WHAT DO YOU DO?",
    placeholder: "Bruno pries the grate open with the crowbar…",
    guide:
      "Say it in your own words. The DM answers in character — and is\n" +
      "allowed to tell you no.",
  },
  exploration: {
    title: "WHAT DO YOU DO?",
    placeholder: "Mora scouts ahead, quiet as she can…",
    guide:
      "Nothing is chasing you. Scout ahead, poke at a route before you take\n" +
      "it, ask about the floor, or just talk. The DM may still say no.",
  },
};

export interface TabletopBarOpts {
  /** Card rect in design px. Defaults to a centred 760×212 card. */
  rect?: Rect;
  /** Which context this host is (run-map-and-dm.md §4b). Default 'encounter'. */
  mode?: TabletopMode;
  /** Eyebrow over the field. Overrides the mode's title. */
  title?: string;
  /** Overrides the mode's placeholder. */
  placeholder?: string;
  /** Enter with a non-empty line. */
  onSubmit(text: string): void;
  /** Esc, or the Never mind button. */
  onCancel?: () => void;
  /** Called once the reply has been read and the card dismissed. */
  onDismiss?: () => void;
  /**
   * The player took the DM up on an interjection ([T] / Answer). The host
   * decides what answering means; the card just reopens the field.
   */
  onAnswer?: () => void;
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
  /**
   * The DM spoke without being asked (run-map-and-dm.md §4b). Renders the
   * line under an "THE DM INTERRUPTS" eyebrow, with `invite` under it and an
   * Answer button beside Continue — an interjection is never a cutscene.
   */
  interject(text: string, invite?: string | null): void;
  /** Is an unprompted beat currently on the card? */
  isInterjecting(): boolean;
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

type Phase = "closed" | "typing" | "waiting" | "reply" | "interjection";

export function createTabletopBar(opts: TabletopBarOpts): TabletopBar {
  const [rx, ry, rw] = opts.rect ?? DEFAULT_RECT;
  const copy = MODE_COPY[opts.mode ?? "encounter"];
  const askTitle = opts.title ?? copy.title;
  const view = new Container();
  view.position.set(rx, ry);
  view.visible = false;

  // rebuilt by `fitCard` — the card grows from the typing beat to the reply
  let card = panel(rw, 1, { variant: "raised", accent: PAL.gold });
  view.addChild(card);

  const eyebrow = heading(askTitle, 3, { fill: PAL.gold });
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
  const guide = label(copy.guide, { size: TYPE.tiny, dim: true });
  guide.style.lineHeight = 17;
  guide.position.set(SPACE.lg, wellY + wellH + SPACE.md);
  view.addChild(guide);

  const hint = label(
    isTouch()
      ? "type your line, then Say it"
      : "Enter to act  ·  Esc to think better of it",
    { size: TYPE.tiny, dim: true },
  );
  view.addChild(hint);

  const dismiss = button("Continue", 160, 40, () => dismissReply(), {
    primary: true,
    hotkey: "E",
  });
  dismiss.view.visible = false;
  view.addChild(dismiss.view);

  /**
   * TOUCH PARITY FOR THE TYPING BEAT (docs/design/mobile.md §§1, 5).
   *
   * With a keyboard, Enter submits and Esc backs out. A virtual keyboard has
   * a Go key that fires Enter, but it has NO Escape at all — so on touch the
   * only way out of the field would be to submit something. These two kit
   * buttons are the real controls; they sit on the typing beat only, and on a
   * desktop they are a redundant (and harmless) second path to the same two
   * calls.
   */
  const say = button("Say it", 150, 40, () => submitField(), {
    primary: true,
    hotkey: "Enter",
    fontSize: TYPE.small,
  });
  say.view.visible = false;
  view.addChild(say.view);

  const nevermind = button("Never mind", 160, 40, () => cancelField(), {
    hotkey: "Esc",
    fontSize: TYPE.small,
  });
  nevermind.view.visible = false;
  view.addChild(nevermind.view);

  /**
   * "Answer" — the button that makes an interjection a conversation instead of
   * a cutscene (run-map-and-dm.md §4b). Only ever visible on an unprompted
   * beat, and only when the host gave us an `onAnswer`.
   */
  const answer = button("Answer", 170, 40, () => answerInterjection(), {
    hotkey: "T",
  });
  answer.view.visible = false;
  view.addChild(answer.view);

  /**
   * Height of the typing beat: eyebrow, well, guide, then the action row
   * (Say it / Never mind) with the key hint tucked beside it.
   */
  const TYPING_H =
    wellY +
    wellH +
    SPACE.md +
    Math.ceil(guide.height) +
    SPACE.md +
    40 +
    SPACE.md;

  /**
   * Resize the card to `h` and pin the footer chrome to its new bottom.
   * `panel()` bakes its size into a Graphics, so it is rebuilt rather than
   * scaled (scaling would smear the 1px border and the corner radius).
   */
  /**
   * The card's key colour. Gold for "you are talking to the DM"; the spectral
   * purple for "the DM is talking to you", so an unprompted beat is legible
   * as one from across the screen without reading a word of it.
   */
  let accent: number = PAL.gold;

  // Declared before `fitCard` because resizing the card must re-place the DOM
  // field that hangs off its well.
  let phase: Phase = "closed";
  let field: DomInput | null = null;
  let ellipsis = 0;
  let waitingBase = "";

  const fitCard = (h: number): void => {
    card.destroy({ children: true });
    card = panel(rw, h, { variant: "raised", accent });
    view.addChildAt(card, 0);
    const rowY = h - 40 - SPACE.md;
    hint.position.set(SPACE.lg, rowY + 13);
    dismiss.view.position.set(rw - 160 - SPACE.lg, rowY);
    answer.view.position.set(rw - 160 - SPACE.lg - 170 - SPACE.md, rowY);
    say.view.position.set(rw - 150 - SPACE.lg, rowY);
    nevermind.view.position.set(rw - 150 - SPACE.lg - 160 - SPACE.sm, rowY);
    field?.reflow();
  };

  /**
   * Reply/waiting/interjection beat: exactly as tall as the narration needs.
   * The body hangs off the echo when there is one (an answered line) and off
   * the eyebrow when there is not (an unprompted one).
   */
  const fitToBody = (): void => {
    body.position.y = echo.visible
      ? echo.y + Math.ceil(echo.height) + SPACE.md
      : SPACE.md + 28;
    const bottom = body.position.y + Math.ceil(body.height);
    fitCard(bottom + SPACE.md + 40 + SPACE.md);
  };

  fitCard(TYPING_H);

  /* ---- the DOM field ------------------------------------------------- */
  /*
   * `createDomInput` owns the element AND the virtual keyboard: it places the
   * field inside the well through main.ts's letterbox transform, and when a
   * phone keyboard would cover it, it floats the field (on its own backing
   * plate) up to just above the keyboard using the `visualViewport` API. So
   * the player can always see what they are typing (mobile.md §5).
   */

  const submitField = (): void => {
    const text = field?.value() ?? "";
    if (text.length > 0) opts.onSubmit(text);
  };

  const cancelField = (): void => {
    closeField();
    bar.close();
    opts.onCancel?.();
  };

  const openField = (): void => {
    if (field) return;
    field = createDomInput({
      rect: { x: rx + SPACE.lg, y: ry + wellY, w: rw - SPACE.lg * 2, h: wellH },
      placeholder: opts.placeholder ?? copy.placeholder,
      maxLength: MAX_PROMPT,
      enterKeyHint: "send",
      onSubmit: (text) => opts.onSubmit(text),
      onCancel: cancelField,
    });
    field.focus();
  };

  const closeField = (): void => {
    field?.destroy();
    field = null;
  };

  const dismissReply = (): void => {
    bar.close();
    opts.onDismiss?.();
  };

  /** Answer button / [T] on an unprompted beat: straight into the field. */
  const answerInterjection = (): void => {
    if (phase !== "interjection") return;
    opts.onAnswer?.();
    bar.open();
  };

  /* ---- the handle ---------------------------------------------------- */

  const bar: TabletopBar = {
    view,

    open() {
      phase = "typing";
      accent = PAL.gold;
      eyebrow.text = askTitle;
      eyebrow.style.fill = PAL.gold;
      view.visible = true;
      well.visible = true;
      echo.visible = false;
      body.text = "";
      body.visible = false;
      guide.visible = true;
      hint.visible = true;
      dismiss.view.visible = false;
      answer.view.visible = false;
      // the typing beat is the ONLY one with a field, so it is the only one
      // that shows the field's two controls
      say.view.visible = true;
      nevermind.view.visible = true;
      fitCard(TYPING_H);
      openField();
    },

    close() {
      phase = "closed";
      closeField();
      say.view.visible = false;
      nevermind.view.visible = false;
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
      say.view.visible = false;
      nevermind.view.visible = false;
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
      accent = PAL.gold;
      eyebrow.text = askTitle;
      eyebrow.style.fill = PAL.gold;
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
      answer.view.visible = false;
      say.view.visible = false;
      nevermind.view.visible = false;
      fitToBody();
    },

    interject(text: string, invite?: string | null) {
      phase = "interjection";
      accent = PAL.stFrazzled;
      closeField();
      eyebrow.text = "THE DM INTERRUPTS";
      eyebrow.style.fill = PAL.stFrazzled;
      view.visible = true;
      well.visible = false;
      // no echo: nobody asked. The line hangs straight off the eyebrow.
      echo.visible = false;
      waitingBase = "";
      body.visible = true;
      body.style.fill = PAL.text;
      body.text =
        invite !== undefined && invite !== null && invite.length > 0
          ? `${text}\n\n${invite}`
          : text;
      guide.visible = false;
      hint.visible = false;
      dismiss.view.visible = true;
      answer.view.visible = opts.onAnswer !== undefined;
      say.view.visible = false;
      nevermind.view.visible = false;
      fitToBody();
    },

    isInterjecting() {
      return phase === "interjection";
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
