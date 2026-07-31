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
import { probeGm, requestGmEventResolve } from "../../services/gm.js";
import type { GmEventResolveOutcome } from "../../services/gmTypes.js";
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
    const [px, py, pw, ph] = R.event.panel;
    const modal = new Container();
    modal.position.set(px, py);
    modal.addChild(panel(pw, ph, { variant: "raised", accent: PAL.gold }));
    view.addChild(modal);
    this.panel = modal;
    this.dynamic = new Container();
    modal.addChild(this.dynamic);

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

    // The typed-action option: probe once per session, fire-and-forget; when
    // something answers and the prompt is still up, re-render with the extra
    // "[T] Do something else…" row. Offline both probes fail and the modal
    // stays byte-identical. The persistent DM wins when both are up — it is
    // the one that remembers the rest of the run.
    // The persistent DM is asked FIRST and, when it answers, the legacy
    // `api/gm/*` deployment is never probed at all: it is the fallback, and
    // probing it anyway costs a request per session that is guaranteed to be
    // discarded (and, on a dev server with no /api, a 404 in the console).
    void probeDm().then((ok) => {
      if (ok) {
        this.dmReady = true;
        this.enableTabletop();
        return;
      }
      void probeGm().then((gmOk) => {
        if (gmOk) this.enableTabletop();
      });
    });
  }

  /** Show the typed-action row (idempotent; safe from either probe). */
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
    this.glyph = null;
    this.illustrated = false;
    this.hotkeys = [];
    this.continueFn = null;
    this.gmAvailable = false;
  }

  /* ---- static header: title + glyph ---------------------------------- */

  private setHeader(
    title: string,
    glyphId: EventGlyphId,
    floorNum: number,
    sceneId?: string,
  ): void {
    const modal = this.panel!;
    const [px, py, pw, ph] = R.event.panel;

    // Surround: the same painting, blown up, blurred and pushed way down so
    // it reads as the room the card is sitting in. Falls back to the palette
    // wash on its own when there is no art (sceneBackdrop is fail-soft).
    this.backdrop?.addChild(
      sceneBackdrop(sceneId ?? "", DESIGN_W, DESIGN_H, {
        // the §9 scrim (0.6) and vignette (0.7) both land on top of this, so
        // the dim here stays light or the surround goes black again
        dim: 0.3,
        blur: true,
      }),
    );

    // Generated illustration (scene:event:<id>): fills the panel, subject
    // in the right third (the scene set's composition contract), clipped
    // to the panel's rounded corners. A left→right + bottom-up gradient
    // scrim keeps the title/body/options text readable over the art.
    const illo = sceneId
      ? makeCoverSprite(sceneId, pw, ph, {
          align: "right",
          radius: RADIUS.panel,
        })
      : null;
    if (illo) {
      const gradient = new Graphics();
      const deep = (a: number) => `rgba(26, 22, 38, ${a})`; // PAL.bgDeep
      gradient
        .rect(0, 0, pw, ph)
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
        .rect(0, ph - 250, pw, 250)
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
      modal.addChildAt(illo, 1); // above the panel bg, below `dynamic`
      this.illustrated = true;
    }

    // procedural glyph is the assetless stand-in for the illustration; it
    // also decides where the title column starts
    if (!illo) {
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
    titleText.style.wordWrapWidth = pw - this.textX() - SPACE.lg;
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

  /** Wrap width for body copy (illustrated layouts hug the dark left). */
  private wrapW(): number {
    const [, , pw] = R.event.panel;
    return this.illustrated ? 420 : pw - this.textX() - SPACE.lg;
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

    // Last option sits in the Leave row; the rest fill the option rects.
    // The Leave band follows the last option row (instead of sitting at a
    // fixed y) so a 2-option event has no orphan gap above it. With the GM
    // up the band is split so a "[T] Do something else…" row fits beside it.
    const n = event.options.length;
    const [lx, , lw, lh] = R.event.leave;
    const [, opt0Y] = R.event.options[0];
    const optRowH = R.event.options[1][1] - opt0Y; // 60: 52 row + 8 gap
    const ly = opt0Y + Math.max(1, n - 1) * optRowH + SPACE.sm;
    const leaveRect: Rect = this.gmAvailable
      ? [lx, ly, 486, lh]
      : [lx, ly, lw, lh];
    event.options.forEach((option, i) => {
      const isLeave = i === n - 1;
      const rect = isLeave ? leaveRect : R.event.options[i];
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
        [lx + 496, ly, lw - 496, lh],
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
    const [px, py] = R.event.panel;
    const [x, y, w, h] = rect;
    const text = option.requires
      ? `${option.label}   ·   ${gateTag(option.requires, run)}`
      : option.label;
    const b = button(text, w, h, onPick, {
      hotkey,
      disabled: !available,
      fontSize: small ? TYPE.small : TYPE.body,
    });
    b.view.position.set(x - px, y - py);
    return b.view;
  }

  /* ---- the tabletop layer (run-map-and-dm.md §3, out of combat) ------- */

  /** The shared "what do you do?" card, built on first use. */
  private ensureTabletop(): TabletopBar {
    this.tabletop ??= createTabletopBar({
      rect: [280, 300, 720, 200],
      placeholder: "Bruno pries the grate open with the crowbar…",
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
      if (!check.applied) {
        // A refusal is the DM saying no, in character; a dropped verdict
        // reads the same. Either way the prompt is still on the table.
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
   * Ask the persistent DM when one is up, else the stateless `/api/gm`
   * endpoint (the seam gm.ts has always owned). Both return the same
   * `{ allowed?, narration|text, effects }` shape to the lint above.
   */
  private async askDm(
    text: string,
    run: RunState,
    ev: GameEvent,
  ): Promise<unknown> {
    const partyHp = run.cats.filter((c) => c.lives > 0).map((c) => c.hp);
    if (this.dmReady && this.ctx) {
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
    const outcome = await requestGmEventResolve({
      floor: run.floorNum,
      text,
      eventId: ev.id,
      eventPrompt: ev.prompt,
      optionLabels: ev.options.map((o) => o.label),
      partyHp,
      shinies: run.inventory.shinies,
    });
    // the /api/gm seam has no refusal channel: a verdict is always an "allowed"
    return outcome === null
      ? null
      : { allowed: true, narration: outcome.text, effects: outcome.effects };
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
   * Apply the GM's Outcome-shaped verdict through the SAME resolveOption
   * path as a fixed option (per-floor caps were linted server-side; clamps,
   * fired-id bookkeeping and the fight handoff all stay intact).
   */
  private applyFreeText(label: string, verdict: GmEventResolveOutcome): void {
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

    const [, , pw] = R.event.panel;
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

    // one primary action, parked in the panel's action band
    const isFight = this.fight !== null;
    const bw = 260;
    const bh = 52;
    const b = button(
      isFight ? "Fight!" : "Continue",
      bw,
      bh,
      () => this.leave(),
      { primary: true, hotkey: "E" },
    );
    const [, , , ph] = R.event.panel;
    b.view.position.set((pw - bw) / 2, ph - bh - SPACE.lg);
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
