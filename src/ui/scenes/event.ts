/**
 * WP-12 — the event modal scene (geometry per ui-art §9, interaction per
 * events.md §3): PROMPT → RESULT states, one button per option with
 * hotkeys 1–4, grayed-but-visible gated options, color-coded delta lines,
 * and the `Fight!` handoff to the battle scene.
 *
 * All gameplay goes through core/events (selectEvent / resolveOption) on
 * one `mulberry32(eventSeed)` stream; the UI renders result lines only.
 * Esc does nothing here — walking away is an explicit option, not a
 * keybind (events.md §3; ARCHITECTURE.md WP-12 acceptance).
 *
 * Chrome is the shared kit (widgets.ts): a `sceneBackdrop`+`scrim` stage,
 * one raised `panel`, `heading`/`label` type, and one `button` language for
 * every option row — each carrying its hotkey chip and, when gated, its
 * requirement tag in the label. Nothing here paints its own rectangle.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import type {
  Effect,
  EnemyId,
  EventOption,
  GameEvent,
  Requirement,
  ResultLine,
  Rng,
  RunState,
} from "../../core/types.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { EVENTS } from "../../content/events.js";
import {
  isOptionAvailable,
  resolveOption,
  resolveScalar,
  type FightRequest,
} from "../../core/events/resolve.js";
import { selectEvent } from "../../core/events/select.js";
import { addShinies } from "../../core/loot/inventory.js";
import { mulberry32 } from "../../core/rng.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, R, RADIUS, SPACE, type Rect } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  button,
  heading,
  label,
  makeCoverSprite,
  panel,
  scrim,
  sceneBackdrop,
  vignette,
} from "../widgets.js";
import { makeEventGlyph, type EventGlyphId } from "../draw/glyphs.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";
import type { EventWinContext } from "../overlays/loot.js";
import {
  ensureDmSession,
  markDmUnreachable,
  probeDm,
  requestEncounterVerdict,
} from "../../services/dm.js";
import {
  validateEncounterVerdict,
  withAdjudication,
  withDmSession,
  type TabletopRun,
} from "../../services/tabletop.js";
import {
  createTabletopBar,
  type TabletopBar,
} from "../overlays/tabletopBar.js";

/* ---------------------------------------------------------------------- */
/* Params (in from explore's StepTrigger, out to the battle scene)         */
/* ---------------------------------------------------------------------- */

/** What explore passes on `{ t: 'event' }` (core/types StepTrigger). */
export interface EventSceneParams {
  eventId: number; // event entity id on the floor
  eventSeed: number; // hash(runSeed, floor, 'event', eventIndex)
}

/**
 * `Fight!` handoff (events.md §2.4). Mirrors the battle StepTrigger shape;
 * `roamerId: null` marks an event fight (no floor entity dies on victory).
 * `encounterIndex` is `1000 + event entity id` — unique per event tile, so
 * the battle stream `mulberry32(hash(runSeed, floor, encounterIndex))`
 * never collides with roamer encounters.
 */
export interface EventFightParams {
  t: "battle";
  roamerId: null;
  encounterIndex: number;
  enemies: EnemyId[];
  isBoss: false;
  /** loot flag for the victory roll (events.md §2.4) */
  eventLoot: "none" | "normal" | "bonus";
  /** onWinEffects context for the loot overlay (null when none) */
  eventWin: EventWinContext | null;
}

/* ---------------------------------------------------------------------- */
/* Presentation tables                                                     */
/* ---------------------------------------------------------------------- */

const TONE_COLOR: Record<ResultLine["tone"], number> = {
  gain: PAL.heal,
  loss: PAL.danger,
  buff: PAL.hexer.body,
  neutral: PAL.textDim,
};

/** Event id → 96×96 glyph (ui-art §9: four glyphs cover v1). */
const EVENT_GLYPH: Record<string, EventGlyphId> = {
  yarnBall: "yarnBall",
  redDot: "yarnBall",
  suspiciousHuman: "fishBones",
  milkBowl: "fishBones",
  elderStray: "fishBones",
  shrineOfNine: "pawShrine",
  cursedPost: "pawShrine",
  catnipPatch: "pawShrine",
  perfectBox: "strangeBox",
  dormantRoomba: "strangeBox",
};

/** Right-aligned gate chip text (ui-art §9: "[Bruiser]" / "[SPD 8+]" …). */
function gateTag(req: Requirement, run: RunState): string {
  switch (req.kind) {
    case "class":
      return `[${CLASSES[req.class].className}]`;
    case "stat":
      return `[${req.stat.toUpperCase()} ${req.min}+]`;
    case "item": {
      const name = CONSUMABLES[req.item]?.name ?? req.item;
      const n = req.count ?? 1;
      return `[${name}${n > 1 ? ` ×${n}` : ""}]`;
    }
    case "shinies":
      return `[${resolveScalar(req.cost, run.floorNum)} ✦]`;
  }
}

/* ---------------------------------------------------------------------- */
/* The scene                                                               */
/* ---------------------------------------------------------------------- */

type State = "prompt" | "freetext" | "waiting" | "result";

/* ---------------------------------------------------------------------- */
/* Card geometry (the card FITS ITS CONTENT — ui-art §9)                   */
/* ---------------------------------------------------------------------- */
//
// `R.event.panel` is a fixed 800×528 with the option rows nailed to absolute
// y's inside it. That made two problems that were reported together:
//
//   · a two-line prompt left ~165px of nothing between the body and the
//     first option, because the options started at a constant y no matter
//     how much prose was above them;
//   · the generated illustration fills the whole card with its subject in
//     the right third, and the full-width option rows were painted straight
//     across it — the art was clipped by its own buttons.
//
// So the card is measured, not decreed: the option stack follows the body,
// the card's HEIGHT is whatever the content needs (clamped), and when an
// illustration is up the whole text column — prose AND buttons — keeps to
// the left, leaving the painting's subject visible where it was composed.

const CARD_W = R.event.panel[2];
const CARD_MIN_H = 288;
const CARD_MAX_H = R.event.panel[3];
/** One option row, and the gap under it. */
const OPT_H = 52;
const OPT_GAP = SPACE.sm;
/** The last option ("walk away") rides a shorter row. */
const LEAVE_H = 36;
/** Gutter between the body copy and the first option. */
const OPT_GUTTER = SPACE.xl;
/** Padding under the last row / the primary button. */
const CARD_FOOT = SPACE.lg;
/** Text-column width when a painting is behind the card. */
const ILLO_COL_W = 430;

export class EventScene implements Scene {
  private view: Container | null = null;
  private panel: Container | null = null;
  private dynamic: Container | null = null;
  private glyph: Container | null = null;
  private glyphBaseY = 0;
  /** Holds the full-screen backdrop; filled in once the event is known. */
  private backdrop: Container | null = null;
  /**
   * Panel-local y where body copy starts — measured from the real title
   * bottom rather than R.event.body's fixed 240, which left a ~75px orphan
   * gap under every one-line title.
   */
  private bodyTop = 0;
  /** true when a generated scene illustration is up (text hugs the left) */
  private illustrated = false;
  /** Manifest id of this event's painting, or "" — re-read on every resize. */
  private sceneId = "";
  /** The card's background + illustration, rebuilt whenever it resizes. */
  private cardArt: Container | null = null;
  private t = 0;

  private ctx: GameCtx | null = null;
  private rng: Rng | null = null;
  private event: GameEvent | null = null;
  private eventEntityId = 0;
  private state: State = "prompt";
  private fight: FightRequest | null = null;
  private hotkeys: ((() => void) | null)[] = [];
  private continueFn: (() => void) | null = null;
  /**
   * The typed-action option (run-map-and-dm.md §3): shown only when SOMETHING
   * can answer it. Offline both probes fail, the row is never rendered, and
   * the modal is byte-identical to the authored one.
   */
  private gmAvailable = false;
  /** true ⇒ the persistent DM answers; false ⇒ the stateless /api/gm seam. */
  private dmReady = false;
  private tabletop: TabletopBar | null = null;

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    const p = params as EventSceneParams;
    this.ctx = ctx;
    this.eventEntityId = p.eventId;
    this.rng = mulberry32(p.eventSeed);
    const run = ctx.run!;

    const view = new Container();
    this.view = view;
    layer(root, "hud").addChild(view);

    // Backdrop: palette wash + the §9 scrim (the modal look, explore is
    // gone) + vignette, all from the kit. There is no one "event stage"
    // painting, so the surround stays an empty container until the event is
    // picked and `setHeader` can blow THIS event's own illustration up
    // behind the card — otherwise the screen is a black void with a floating
    // panel in it.
    const backdrop = new Container();
    this.backdrop = backdrop;
    view.addChild(
      backdrop,
      scrim(DESIGN_W, DESIGN_H),
      vignette(DESIGN_W, DESIGN_H, 0.7),
    );
    const modal = new Container();
    modal.x = (DESIGN_W - CARD_W) / 2;
    view.addChild(modal);
    this.panel = modal;
    // z-order inside the card: art (bg + illustration + scrim gradient),
    // then the header, then whatever the current state is drawing
    this.cardArt = new Container();
    this.dynamic = new Container();
    modal.addChild(this.cardArt, this.dynamic);
    this.resizeCard(CARD_MAX_H);

    // ---- which event fires (eventRng draw #1 / shiny fallback) ---------
    const sel = selectEvent(
      EVENTS,
      run.floorNum,
      run.firedEventIds,
      run.floorFiredEventIds,
      this.rng,
    );
    if (sel.kind === "fallback") {
      const inv = addShinies(run.inventory, sel.shinies);
      ctx.run = {
        ...run,
        inventory: inv,
        score: {
          ...run.score,
          shiniesCollected:
            run.score.shiniesCollected + (inv.shinies - run.inventory.shinies),
        },
      };
      ctx.save();
      this.setHeader("A Glint in the Dark", "strangeBox", run.floorNum);
      this.showResult(sel.text, [{ text: `+${sel.shinies} ✦`, tone: "gain" }]);
      return;
    }

    this.event = sel.event;
    this.setHeader(
      sel.event.title,
      EVENT_GLYPH[sel.event.id] ?? "strangeBox",
      run.floorNum,
      `scene:event:${sel.event.id}`,
    );
    this.showPrompt();

    // The typed-action option: probe the DM once per session,
    // fire-and-forget; when it answers and the prompt is still up, re-render
    // with the extra "[T] Do something else…" row. With no DM reachable the
    // probe fails, the row is never built and the modal is byte-identical to
    // the offline game.
    void probeDm().then((ok) => {
      if (!ok) return;
      this.dmReady = true;
      this.enableTabletop();
    });
  }

  /** Show the typed-action row (idempotent). */
  private enableTabletop(): void {
    if (this.gmAvailable || !this.view || !this.event) return;
    this.gmAvailable = true;
    if (this.state === "prompt") this.rerenderPrompt();
  }

  update(dtMs: number): void {
    // event glyph bobs ±3px, like its tile (ui-art §7)
    this.t += dtMs;
    if (this.glyph) {
      this.glyph.y = this.glyphBaseY + Math.sin(this.t / 400) * 3;
    }
    this.tabletop?.update(dtMs);
  }

  onKey(key: string): boolean {
    // The tabletop card owns the keyboard while it is up: the DOM field stops
    // propagation itself, and the reply beat takes any confirm key to dismiss.
    if (this.state === "freetext" || this.state === "waiting") {
      if (this.tabletop && !this.tabletop.isOpen()) this.cancelFreeText();
      else if (key === "e" || key === "enter" || key === "space") {
        this.cancelFreeText();
      }
      return true;
    }
    if (key === "esc") return true; // consumed, does nothing (events.md §3)
    if (this.state === "prompt") {
      const i = "1234".indexOf(key);
      if (i >= 0) {
        this.hotkeys[i]?.();
        return true;
      }
      if (key === "t" && this.gmAvailable && this.event) {
        this.openFreeText();
        return true;
      }
      return false;
    }
    if (key === "e" || key === "space" || key === "enter") {
      this.continueFn?.();
      return true;
    }
    return false;
  }

  unmount(): void {
    // the tabletop card owns a DOM <input>: destroy it before its pixi
    // parent goes, or the element is orphaned over the next scene
    this.tabletop?.destroy();
    this.tabletop = null;
    this.view?.destroy({ children: true });
    this.view = null;
    this.panel = null;
    this.dynamic = null;
    this.cardArt = null;
    this.glyph = null;
    this.illustrated = false;
    this.sceneId = "";
    this.hotkeys = [];
    this.continueFn = null;
    this.gmAvailable = false;
  }

  /* ---- static header: title + glyph ---------------------------------- */

  /**
   * (Re)build the card's background and illustration at height `h`, and
   * re-centre the card on screen. Everything else in the modal (`dynamic`,
   * the header, the glyph) is positioned in card-local space and does not
   * move, so a state that needs a taller or shorter card just calls this.
   */
  private resizeCard(h: number): void {
    const modal = this.panel;
    const art = this.cardArt;
    if (!modal || !art) return;
    modal.y = Math.round((DESIGN_H - h) / 2);
    for (const c of art.removeChildren()) c.destroy({ children: true });
    art.addChild(panel(CARD_W, h, { variant: "raised", accent: PAL.gold }));

    // Generated illustration (scene:event:<id>): fills the card, subject in
    // the right third (the scene set's composition contract), clipped to the
    // card's rounded corners. A left→right + bottom-up gradient scrim keeps
    // the text column readable over the art — and the option rows now keep
    // to that same column, so they no longer crop the subject.
    const illo = this.sceneId
      ? makeCoverSprite(this.sceneId, CARD_W, h, {
          align: "right",
          radius: RADIUS.panel,
        })
      : null;
    if (!illo) return;
    const gradient = new Graphics();
    const deep = (a: number): string => `rgba(26, 22, 38, ${a})`; // PAL.bgDeep
    gradient
      .rect(0, 0, CARD_W, h)
      .fill(
        new FillGradient({
          end: { x: 1, y: 0 },
          colorStops: [
            { offset: 0, color: deep(0.95) },
            { offset: 0.45, color: deep(0.78) },
            { offset: 0.72, color: deep(0.3) },
            { offset: 1, color: deep(0.05) },
          ],
        }),
      )
      .rect(0, Math.max(0, h - 250), CARD_W, Math.min(250, h))
      .fill(
        new FillGradient({
          end: { x: 0, y: 1 },
          colorStops: [
            { offset: 0, color: deep(0) },
            { offset: 1, color: deep(0.88) },
          ],
        }),
      );
    illo.addChild(gradient); // clipped by the cover mask with the art
    art.addChild(illo);
  }

  private setHeader(
    title: string,
    glyphId: EventGlyphId,
    floorNum: number,
    sceneId?: string,
  ): void {
    const modal = this.panel!;
    const [px, py] = R.event.panel;
    this.sceneId = sceneId ?? "";

    // Surround: the same painting, blown up, blurred and pushed way down so
    // it reads as the room the card is sitting in. Falls back to the palette
    // wash on its own when there is no art (sceneBackdrop is fail-soft).
    this.backdrop?.addChild(
      sceneBackdrop(this.sceneId, DESIGN_W, DESIGN_H, {
        // the §9 scrim (0.6) and vignette (0.7) both land on top of this, so
        // the dim here stays light or the surround goes black again
        dim: 0.3,
        blur: true,
      }),
    );

    // Is there art? Ask once, at full height, and keep the answer: it decides
    // the whole card's column geometry (`textX` / `wrapW` / the option width).
    this.illustrated =
      this.sceneId !== "" &&
      makeCoverSprite(this.sceneId, CARD_W, CARD_MAX_H) !== null;
    this.resizeCard(CARD_MAX_H);

    // procedural glyph is the assetless stand-in for the illustration; it
    // also decides where the title column starts
    if (!this.illustrated) {
      const themeIndex = Math.min(2, Math.floor((floorNum - 1) / 2));
      const glyph = makeEventGlyph(glyphId, themeIndex);
      const [gx, gy, gw, gh] = R.event.glyph;
      glyph.position.set(gx - px + gw / 2, gy - py + gh / 2);
      this.glyphBaseY = glyph.y;
      this.glyph = glyph;
      modal.addChild(glyph);
    }

    const eyebrow = heading("AN EVENT", 3);
    eyebrow.position.set(this.textX(), SPACE.lg);
    const titleText = heading(title, 2, { fill: PAL.gold });
    titleText.style.wordWrap = true;
    titleText.style.wordWrapWidth = this.wrapW();
    titleText.position.set(this.textX(), SPACE.lg + SPACE.lg);
    modal.addChild(eyebrow, titleText);
    // body copy starts one gutter under the title, however tall it wrapped
    this.bodyTop = titleText.y + Math.ceil(titleText.height) + SPACE.lg;
  }

  /** Left edge of the text column: past the glyph, or the panel padding. */
  private textX(): number {
    const [px] = R.event.panel;
    const [gx, , gw] = R.event.glyph;
    return this.illustrated ? SPACE.xl : gx - px + gw + SPACE.lg;
  }

  /**
   * Width of the whole text column — prose, title AND option rows.
   *
   * With a painting behind the card the column stops well short of the right
   * edge: the scene set composes its subject into the right third, and a
   * full-width button row painted over that is what "the illustration is
   * clipped by the options" meant. Without art the column is the card.
   */
  private colW(): number {
    return this.illustrated ? ILLO_COL_W : CARD_W - this.textX() - SPACE.lg;
  }

  /** Wrap width for body copy — the same column the buttons live in. */
  private wrapW(): number {
    return this.colW();
  }

  /* ---- PROMPT --------------------------------------------------------- */

  private showPrompt(): void {
    const run = this.ctx!.run!;
    const event = this.event!;
    const dyn = this.dynamic!;
    this.state = "prompt";
    this.hotkeys = [];

    // with an illustration up the prompt hugs the scrim-dark left column
    const body = label(event.prompt, {
      size: TYPE.body,
      wrap: this.wrapW(),
    });
    body.position.set(this.textX(), this.bodyTop);
    dyn.addChild(body);

    // The option stack FOLLOWS the body. The rows used to sit at absolute y's
    // inside a fixed card, so a short prompt left a ~165px hole above the
    // first button; now the first row starts one gutter under whatever the
    // prose actually measured, and the card is cut to fit the result.
    const n = event.options.length;
    const x = this.textX();
    const w = this.colW();
    const stackTop = this.bodyTop + Math.ceil(body.height) + OPT_GUTTER;
    const stackH = Math.max(0, n - 1) * (OPT_H + OPT_GAP) + LEAVE_H;
    this.resizeCard(
      Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, stackTop + stackH + CARD_FOOT)),
    );

    // Last option rides the shorter Leave row. With the GM up that row is
    // split so a "[T] Do something else…" row fits beside it.
    const ly = stackTop + Math.max(0, n - 1) * (OPT_H + OPT_GAP);
    const splitGap = SPACE.md;
    const leaveW = this.gmAvailable ? Math.round((w - splitGap) * 0.6) : w;
    event.options.forEach((option, i) => {
      const isLeave = i === n - 1;
      const rect: Rect = isLeave
        ? [x, ly, leaveW, LEAVE_H]
        : [x, stackTop + i * (OPT_H + OPT_GAP), w, OPT_H];
      const available = isOptionAvailable(run, option);
      const row = this.makeOptionRow(
        rect,
        `${i + 1}`,
        option,
        available,
        isLeave,
        run,
        () => this.pick(i),
      );
      dyn.addChild(row);
      this.hotkeys[i] = available ? () => this.pick(i) : null;
    });
    if (this.gmAvailable) {
      const row = this.makeOptionRow(
        [x + leaveW + splitGap, ly, w - leaveW - splitGap, LEAVE_H],
        "T",
        { label: "Do something else…", outcomes: [] },
        true,
        true,
        run,
        () => this.openFreeText(),
      );
      dyn.addChild(row);
    }
  }

  /** Rebuild the PROMPT in place (after the GM probe resolves). */
  private rerenderPrompt(): void {
    if (this.state !== "prompt" || !this.dynamic) return;
    for (const c of this.dynamic.removeChildren()) {
      c.destroy({ children: true });
    }
    this.showPrompt();
  }

  /**
   * One option row — the kit `button`, hotkey chip included. A gated option
   * carries its requirement in the label ("… · [SPD 8+]") and, when unmet,
   * renders disabled: dimmed but still VISIBLE, because showing locked
   * doors sells build value (events.md §3).
   *
   * `rect` is CARD-LOCAL (the card moves and resizes now, so screen-space
   * rects with the old panel origin subtracted back out would drift).
   */
  private makeOptionRow(
    rect: Rect,
    hotkey: string,
    option: EventOption,
    available: boolean,
    small: boolean,
    run: RunState,
    onPick: () => void,
  ): Container {
    const [x, y, w, h] = rect;
    const text = option.requires
      ? `${option.label}   ·   ${gateTag(option.requires, run)}`
      : option.label;
    const b = button(text, w, h, onPick, {
      hotkey,
      disabled: !available,
      fontSize: small ? TYPE.small : TYPE.body,
    });
    b.view.position.set(x, y);
    return b.view;
  }

  /* ---- the tabletop layer (run-map-and-dm.md §3, out of combat) ------- */

  /** The shared "what do you do?" card, built on first use. */
  private ensureTabletop(): TabletopBar {
    this.tabletop ??= createTabletopBar({
      rect: [280, 300, 720, 200],
      // The context, not the copy: the eyebrow, placeholder and guidance all
      // come from the shared component's `encounter` mode, so this host and
      // the fight/run-map ones cannot drift into three different DMs
      // (run-map-and-dm.md §4b).
      mode: "encounter",
      onSubmit: (text) => this.submitFreeText(text),
      onCancel: () => this.cancelFreeText(),
      onDismiss: () => this.cancelFreeText(),
    });
    if (this.tabletop.view.parent === null) {
      this.view?.addChild(this.tabletop.view);
    }
    return this.tabletop;
  }

  private openFreeText(): void {
    if (this.state !== "prompt" || !this.ctx || !this.event) return;
    this.state = "freetext";
    this.ensureTabletop().open();
  }

  /** Nothing happened: back to the untouched prompt (no RNG was drawn). */
  private cancelFreeText(): void {
    this.tabletop?.close();
    if (this.state === "result") return;
    this.state = "prompt";
    this.rerenderPrompt();
  }

  /**
   * One typed action, adjudicated by whichever DM answered the probe. The
   * verdict is re-linted CLIENT-SIDE (run-map-and-dm.md §3 "defence in
   * depth") and every beat — told, refused, or dropped — is recorded into
   * the run transcript before anything is applied.
   */
  private submitFreeText(text: string): void {
    if (this.state !== "freetext" || !this.ctx || !this.event) return;
    this.state = "waiting";
    const bar = this.ensureTabletop();
    bar.waiting(text);
    const run = this.ctx.run!;
    const ev = this.event;

    void this.askDm(text, run, ev).then((raw) => {
      if (!this.view || this.state !== "waiting" || this.event !== ev) return;
      if (raw === null) {
        // failure mid-run: the option disappears, the prompt returns
        // untouched (no RNG was drawn, nothing was paid or fired)
        if (this.dmReady) markDmUnreachable();
        this.gmAvailable = false;
        bar.reply("The night holds its breath, and lets it out.", "quiet");
        return;
      }
      const check = validateEncounterVerdict(raw, run.floorNum);
      const verdict = check.verdict;
      if (!verdict) {
        this.gmAvailable = false;
        bar.reply("The night holds its breath, and lets it out.", "quiet");
        return;
      }
      this.recordBeat(text, verdict, check.applied, check.problems);
      if (!check.resolved) {
        // The DM said no, or answered with something unusable. Either way the
        // party did not do the thing, so the prompt is still on the table.
        bar.reply(verdict.narration, verdict.allowed ? "told" : "refused");
        return;
      }
      bar.close();
      this.applyFreeText(text, {
        text: verdict.narration,
        effects: verdict.effects,
      });
    });
  }

  /**
   * Ask the persistent DM. Returns the RAW structured payload — the lint
   * above is what decides whether the engine ever sees it — or null when
   * there is no DM, the turn failed, or it timed out.
   */
  private async askDm(
    text: string,
    run: RunState,
    ev: GameEvent,
  ): Promise<unknown> {
    if (!this.dmReady || !this.ctx) return null;
    const partyHp = run.cats.filter((c) => c.lives > 0).map((c) => c.hp);
    const ensured = await ensureDmSession(run as TabletopRun);
    if (!ensured) return null;
    this.ctx.run = ensured.run;
    const res = await requestEncounterVerdict(ensured.session, {
      floor: run.floorNum,
      prompt: text,
      situation:
        `The party is at "${ev.title}". ${ev.prompt} ` +
        `Their options were: ${ev.options.map((o) => o.label).join("; ")}.`,
      shinies: run.inventory.shinies,
      partyHp,
      onDelta: (_delta, soFar) => this.tabletop?.stream(soFar),
    });
    if (!res) return null;
    if (this.ctx.run) {
      this.ctx.run = withDmSession(this.ctx.run as TabletopRun, res.session);
    }
    return res.data;
  }

  /** Record one adjudication into the run log, then autosave it. */
  private recordBeat(
    prompt: string,
    verdict: { allowed: boolean; narration: string; effects: Effect[] },
    applied: boolean,
    problems: string[],
  ): void {
    if (!this.ctx?.run) return;
    const run = this.ctx.run;
    this.ctx.run = withAdjudication(run as TabletopRun, {
      where: "encounter",
      floor: run.floorNum,
      nodeId: run.currentNodeId,
      prompt,
      narration: verdict.narration,
      allowed: verdict.allowed,
      effects: verdict.effects,
      applied,
      problems,
    });
    this.ctx.save();
  }

  /**
   * Apply the DM's Outcome-shaped verdict through the SAME resolveOption
   * path as a fixed option (per-floor caps were re-linted client-side by
   * `validateEncounterVerdict`; clamps, fired-id bookkeeping and the fight
   * handoff all stay intact).
   */
  private applyFreeText(
    label: string,
    verdict: { text: string; effects: Effect[] },
  ): void {
    if (!this.ctx || !this.event || !this.rng) return;
    const run = this.ctx.run!;
    // restoreLife is runtime-gated (events.md invariant 7): when no living
    // cat is below 9 Lives, drop that effect rather than the whole verdict.
    const anyBelow9 = run.cats.some((c) => c.lives > 0 && c.lives < 9);
    const effects = verdict.effects.filter(
      (e) => e.kind !== "restoreLife" || anyBelow9,
    );
    const synthetic: GameEvent = {
      ...this.event,
      options: [
        ...this.event.options,
        { label, outcomes: [{ weight: 1, text: verdict.text, effects }] },
      ],
    };
    const out = resolveOption(
      run,
      synthetic,
      synthetic.options.length - 1,
      this.rng,
    );
    this.ctx.run = out.state;
    this.fight = out.fightRequest;
    this.ctx.save(); // autosave point: event outcome (same as pick())
    this.showResult(out.outcome.text, out.results);
  }

  /* ---- RESULT --------------------------------------------------------- */

  private pick(optionIndex: number): void {
    if (this.state !== "prompt" || !this.ctx || !this.event || !this.rng) {
      return;
    }
    const run = this.ctx.run!;
    const out = resolveOption(run, this.event, optionIndex, this.rng);
    this.ctx.run = out.state;
    this.fight = out.fightRequest;
    this.ctx.save(); // autosave point: event outcome
    this.showResult(out.outcome.text, out.results);
  }

  private showResult(text: string, lines: ResultLine[]): void {
    const dyn = this.dynamic!;
    this.state = "result";
    this.hotkeys = [];
    for (const c of dyn.removeChildren()) c.destroy({ children: true });

    const body = label(text, { size: TYPE.body, wrap: this.wrapW() });
    body.position.set(this.textX(), this.bodyTop);
    dyn.addChild(body);

    // one delta line per emitted result, color-coded (events.md §3)
    let ly = this.bodyTop + Math.ceil(body.height) + SPACE.md;
    for (const line of lines) {
      const t = label(line.text, { fill: TONE_COLOR[line.tone], bold: true });
      t.position.set(this.textX(), ly);
      dyn.addChild(t);
      ly += 22;
    }

    // one primary action, one gutter under the last delta line — and the card
    // cut to fit, exactly like the prompt state
    const isFight = this.fight !== null;
    const bw = 260;
    const bh = 52;
    const btnY = ly + OPT_GUTTER - 22;
    this.resizeCard(
      Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, btnY + bh + CARD_FOOT)),
    );
    const b = button(
      isFight ? "Fight!" : "Continue",
      bw,
      bh,
      () => this.leave(),
      { primary: true, hotkey: "E" },
    );
    // centred on the TEXT COLUMN, not the card: with a painting up the right
    // third belongs to the art
    b.view.position.set(
      this.textX() + Math.round((this.colW() - bw) / 2),
      btnY,
    );
    dyn.addChild(b.view);
    this.continueFn = () => this.leave();
  }

  private leave(): void {
    if (!this.ctx) return;
    const fight = this.fight;
    if (fight) {
      const params: EventFightParams = {
        t: "battle",
        roamerId: null,
        encounterIndex: 1000 + this.eventEntityId,
        enemies: fight.encounter,
        isBoss: false,
        eventLoot: fight.loot,
        eventWin:
          fight.onWinEffects.length > 0
            ? {
                eventId: fight.eventId,
                effects: fight.onWinEffects,
                gateCatIndex: fight.gateCatIndex,
                rng: this.rng!, // onWinEffects continue the SAME stream
              }
            : null,
      };
      this.ctx.scenes.goto("battle", params);
    } else {
      this.ctx.scenes.goto("runMap");
    }
  }
}
