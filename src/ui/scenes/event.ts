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
 */
import { Container, Graphics, Text } from "pixi.js";
import type {
  EnemyId,
  EventOption,
  GameEvent,
  Requirement,
  ResultLine,
  Rng,
  RunState,
} from "../../core/types";
import { CLASSES } from "../../content/classes";
import { CONSUMABLES } from "../../content/consumables";
import { EVENTS } from "../../content/events";
import {
  isOptionAvailable,
  requirementMet,
  resolveOption,
  resolveScalar,
  type FightRequest,
} from "../../core/events/resolve";
import { selectEvent } from "../../core/events/select";
import { addShinies } from "../../core/loot/inventory";
import { mulberry32 } from "../../core/rng";
import { PAL } from "../palette";
import { R, RADIUS, type Rect } from "../layout";
import { display, ui } from "../textStyles";
import { makeButton, makeHotkeyChip, makePanel } from "../widgets";
import { makeEventGlyph, type EventGlyphId } from "../draw/glyphs";
import { layer, type GameCtx, type Scene } from "../sceneManager";
import type { EventWinContext } from "../overlays/loot";

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

type State = "prompt" | "result";

export class EventScene implements Scene {
  private view: Container | null = null;
  private panel: Container | null = null;
  private dynamic: Container | null = null;
  private glyph: Container | null = null;
  private glyphBaseY = 0;
  private t = 0;

  private ctx: GameCtx | null = null;
  private rng: Rng | null = null;
  private event: GameEvent | null = null;
  private eventEntityId = 0;
  private state: State = "prompt";
  private fight: FightRequest | null = null;
  private hotkeys: ((() => void) | null)[] = [];
  private continueFn: (() => void) | null = null;

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    const p = params as EventSceneParams;
    this.ctx = ctx;
    this.eventEntityId = p.eventId;
    this.rng = mulberry32(p.eventSeed);
    const run = ctx.run!;

    const view = new Container();
    this.view = view;
    layer(root, "hud").addChild(view);

    // backdrop: deep bg + the §9 scrim (the modal look, explore is gone)
    view.addChild(new Graphics().rect(...R.event.scrim).fill(PAL.bgDeep));
    view.addChild(
      new Graphics()
        .rect(...R.event.scrim)
        .fill({ color: PAL.scrim, alpha: 0.6 }),
    );
    const [px, py, pw, ph] = R.event.panel;
    const panel = new Container();
    panel.position.set(px, py);
    panel.addChild(makePanel(pw, ph));
    view.addChild(panel);
    this.panel = panel;
    this.dynamic = new Container();
    panel.addChild(this.dynamic);

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
    );
    this.showPrompt();
  }

  update(dtMs: number): void {
    // event glyph bobs ±3px, like its tile (ui-art §7)
    this.t += dtMs;
    if (this.glyph) {
      this.glyph.y = this.glyphBaseY + Math.sin(this.t / 400) * 3;
    }
  }

  onKey(key: string): boolean {
    if (key === "esc") return true; // consumed, does nothing (events.md §3)
    if (this.state === "prompt") {
      const i = "1234".indexOf(key);
      if (i >= 0) {
        this.hotkeys[i]?.();
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
    this.view?.destroy({ children: true });
    this.view = null;
    this.panel = null;
    this.dynamic = null;
    this.glyph = null;
    this.hotkeys = [];
    this.continueFn = null;
  }

  /* ---- static header: title + glyph ---------------------------------- */

  private setHeader(
    title: string,
    glyphId: EventGlyphId,
    floorNum: number,
  ): void {
    const panel = this.panel!;
    const [px, py] = R.event.panel;
    const [tx, ty, tw] = R.event.title;
    const titleText = new Text({
      text: title,
      style: display(22, {
        fill: PAL.gold,
        wordWrap: true,
        wordWrapWidth: tw,
      }),
    });
    titleText.position.set(tx - px, ty - py);
    panel.addChild(titleText);

    const themeIndex = Math.min(2, Math.floor((floorNum - 1) / 2));
    const glyph = makeEventGlyph(glyphId, themeIndex);
    const [gx, gy, gw, gh] = R.event.glyph;
    glyph.position.set(gx - px + gw / 2, gy - py + gh / 2);
    this.glyphBaseY = glyph.y;
    this.glyph = glyph;
    panel.addChild(glyph);
  }

  /* ---- PROMPT --------------------------------------------------------- */

  private showPrompt(): void {
    const run = this.ctx!.run!;
    const event = this.event!;
    const dyn = this.dynamic!;
    this.state = "prompt";
    this.hotkeys = [];

    const [px, py] = R.event.panel;
    const [bx, by, bw] = R.event.body;
    const body = new Text({
      text: event.prompt,
      style: ui(16, { wordWrap: true, wordWrapWidth: bw, lineHeight: 24 }),
    });
    body.position.set(bx - px, by - py);
    dyn.addChild(body);

    // last option sits in the Leave row; the rest fill the option rects
    const n = event.options.length;
    event.options.forEach((option, i) => {
      const isLeave = i === n - 1;
      const rect = isLeave ? R.event.leave : R.event.options[i];
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
  }

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
    const row = new Container();
    row.position.set(x - px, y - py);

    const bg = new Graphics();
    const paint = (hover: boolean) => {
      bg.clear()
        .roundRect(0, 0, w, h, RADIUS.button)
        .fill(hover ? PAL.panelLite : PAL.panel)
        .stroke({ width: 2, color: hover ? PAL.gold : PAL.border });
    };
    paint(false);
    row.addChild(bg);

    const chip = makeHotkeyChip(hotkey, available);
    chip.view.position.set(12, (h - 16) / 2);
    row.addChild(chip.view);

    const label = new Text({
      text: option.label,
      style: small ? ui(14, { fill: PAL.textDim }) : ui(16),
    });
    label.anchor.set(0, 0.5);
    label.position.set(40, h / 2);
    row.addChild(label);

    if (option.requires) {
      const met = requirementMet(run, option.requires);
      const tagText = new Text({
        text: gateTag(option.requires, run),
        style: ui(11, { fill: met ? PAL.gold : PAL.textDim }),
      });
      const tw = Math.ceil(tagText.width) + 12;
      const tag = new Container();
      tag.addChild(
        new Graphics().roundRect(0, 0, tw, 18, RADIUS.chip).fill(PAL.panelLite),
      );
      tagText.position.set(6, 3);
      tag.addChild(tagText);
      tag.position.set(w - tw - 12, (h - 18) / 2);
      row.addChild(tag);
    }

    if (available) {
      row.eventMode = "static";
      row.cursor = "pointer";
      row.on("pointerover", () => paint(true));
      row.on("pointerout", () => paint(false));
      row.on("pointertap", onPick);
    } else {
      // unmet requirement: alpha 0.45, not clickable, still VISIBLE —
      // showing locked doors sells build value (events.md §3)
      row.alpha = 0.45;
    }
    return row;
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

    const [px, py, pw] = R.event.panel;
    const [bx, by, bw] = R.event.body;
    const body = new Text({
      text,
      style: ui(16, {
        fontStyle: "italic",
        wordWrap: true,
        wordWrapWidth: bw,
        lineHeight: 24,
      }),
    });
    body.position.set(bx - px, by - py);
    dyn.addChild(body);

    // one delta line per emitted result, color-coded (events.md §3)
    let ly = by - py + Math.ceil(body.height) + 14;
    for (const line of lines) {
      const t = new Text({
        text: line.text,
        style: ui(15, { fill: TONE_COLOR[line.tone] }),
      });
      t.position.set(bx - px, ly);
      dyn.addChild(t);
      ly += 22;
    }

    const isFight = this.fight !== null;
    const btn = makeButton(
      isFight ? "[E] Fight!" : "[E] Continue",
      240,
      36,
      () => this.leave(),
      { primary: true, fontSize: 15 },
    );
    const [, lyR] = R.event.leave;
    btn.view.position.set((pw - 240) / 2, lyR - py);
    dyn.addChild(btn.view);
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
      this.ctx.scenes.goto("explore");
    }
  }
}
