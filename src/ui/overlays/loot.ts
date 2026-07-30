/**
 * WP-12 — the loot overlay (ui-art §10 victory panel geometry, gameloop §1
 * LOOT overlay semantics): chest and battle-victory variants, staggered
 * loot rows, party XP bar with level-up toast, the Nine-Lives ledger
 * (cracking paw pip), event `onWinEffects` delta lines, and the
 * full-inventory Take/Leave path via the pickup modal.
 *
 * The overlay APPLIES its grant (core applyLootGrant / applyEventEffects)
 * on mount and autosaves — callers only roll and hand over the LootGrant.
 */
import { Container, Graphics, Text } from "pixi.js";
import type {
  ClassId,
  Effect,
  EquipInstance,
  ItemId,
  ResultLine,
  Rng,
} from "../../core/types";
import { CLASSES } from "../../content/classes";
import { CONSUMABLES } from "../../content/consumables";
import { EQUIP_DEFS } from "../../content/equipment";
import { XP_TO_LEVEL } from "../../content/floors";
import { applyEventEffects } from "../../core/events/resolve";
import { applyLootGrant } from "../../core/run/runState";
import type { LootGrant } from "../../core/types";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W, R } from "../layout";
import { display, mono, ui } from "../textStyles";
import { tween } from "../tween";
import { makeBar, makeButton, makePanel, makePawRow } from "../widgets";
import { drawCatPortrait } from "../draw/cats";
import { layer, type GameCtx, type Overlay } from "../sceneManager";
import {
  RARITY_COLOR,
  equipName,
  equipStatsText,
  makePickupModal,
  type PickupModal,
} from "./inventoryPanel";

/* ---------------------------------------------------------------------- */
/* Params (exported for the explore / battle / event callers)              */
/* ---------------------------------------------------------------------- */

/**
 * Event-fight victory context: `onWinEffects` applied on the victory
 * screen, continuing the SAME eventRng sequence (events.md §2.2 draw 5).
 */
export interface EventWinContext {
  eventId: string;
  effects: Effect[];
  gateCatIndex: number | null;
  rng: Rng;
}

export type LootVariant = "chest" | "victory" | "boss";

export interface LootOverlayParams {
  /**
   * Explore's chest path passes `{ kind: 'chest', chestId, grant }` — the
   * mount normalizes `kind` into `variant` (default 'victory').
   */
  variant?: LootVariant;
  kind?: string;
  /** Pre-rolled grant (rollChest / rollVictory / rollBossLoot / rollBundle). */
  grant: LootGrant;
  /** run.xp / run.level BEFORE applyBattleResult — enables the XP bar. */
  xpBefore?: number;
  levelBefore?: number;
  /** Cats that stood up KO'd after a won battle (Lives ledger, pip crack). */
  livesLost?: { classId: ClassId; livesLeft: number }[];
  /** Event-fight `onWinEffects` — applied here, delta lines rendered. */
  eventWin?: EventWinContext;
  /** Extra pre-computed delta lines to render (e.g. grief-loot notes). */
  extraLines?: ResultLine[];
  onClosed?: () => void;
}

const TONE_COLOR: Record<ResultLine["tone"], number> = {
  gain: PAL.heal,
  loss: PAL.danger,
  buff: PAL.hexer.body,
  neutral: PAL.textDim,
};

const HEADERS: Record<LootVariant, string> = {
  chest: "LOOT!",
  victory: "VICTORY",
  boss: "BOSS HOARD",
};

type OverflowItem = EquipInstance | { defId: ItemId; count: number };

/* ---------------------------------------------------------------------- */
/* The overlay                                                             */
/* ---------------------------------------------------------------------- */

export class LootOverlay implements Overlay {
  private view: Container | null = null;
  private ctx: GameCtx | null = null;
  private p: LootOverlayParams | null = null;
  private variant: LootVariant = "victory";
  private timeouts: number[] = [];
  private modal: PickupModal | null = null;
  private overflowQueue: OverflowItem[] = [];
  private closed = false;

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    const p = params as LootOverlayParams;
    this.ctx = ctx;
    this.p = p;
    this.closed = false;
    this.variant = p.variant ?? (p.kind === "chest" ? "chest" : "victory");

    // ---- apply: onWinEffects (same eventRng), then the grant -----------
    let run = ctx.run!;
    const lines: ResultLine[] = [...(p.extraLines ?? [])];
    if (p.eventWin) {
      const r = applyEventEffects(
        run,
        p.eventWin.effects,
        p.eventWin.eventId,
        p.eventWin.rng,
        p.eventWin.gateCatIndex,
      );
      run = r.state;
      lines.push(...r.results);
    }
    const applied = applyLootGrant(run, p.grant);
    ctx.run = applied.run;
    this.overflowQueue = [
      ...applied.overflow.equips,
      ...applied.overflow.consumables.map((c) => ({
        defId: c.defId,
        count: Math.min(5, c.count),
      })),
    ];
    ctx.save(); // autosave point: chest loot / battle resolution

    // ---- build ---------------------------------------------------------
    const view = new Container();
    this.view = view;
    layer(root, "modal").addChild(view);

    const scrim = new Graphics()
      .rect(0, 0, DESIGN_W, DESIGN_H)
      .fill({ color: PAL.scrim, alpha: 0.6 });
    scrim.eventMode = "static";
    view.addChild(scrim);

    const [px, py, pw, ph] = R.results.victoryPanel;
    const panel = new Container();
    panel.position.set(px, py);
    panel.addChild(makePanel(pw, ph));
    view.addChild(panel);

    const header = new Text({
      text: HEADERS[this.variant],
      style: display(32, { fill: PAL.gold }),
    });
    header.anchor.set(0.5);
    header.position.set(pw / 2, 44);
    header.scale.set(1.4); // drops in with backOut 1.4→1 (ui-art §10)
    tween(header.scale, { x: 1, y: 1 }, 300, "backOut");
    panel.addChild(header);

    let y = 84;
    let delay = 0;
    const addRow = (row: Container, h: number) => {
      row.position.set(32, y);
      row.alpha = 0;
      panel.addChild(row);
      const y0 = row.y;
      const at = delay;
      delay += 120; // rows pop in 120ms apart (ui-art §10)
      this.later(() => {
        row.y = y0 + 6;
        tween(row, { y: y0, alpha: 1 }, 150, "quadOut");
      }, at);
      y += h;
    };

    // shinies row
    if (p.grant.shinies !== 0) {
      const row = new Container();
      const coin = new Graphics()
        .circle(10, 10, 7)
        .fill(PAL.gold)
        .stroke({ width: 2, color: PAL.goldDark });
      row.addChild(coin);
      const t = new Text({
        text: `${p.grant.shinies > 0 ? "+" : ""}${p.grant.shinies} ✦`,
        style: mono(16, { fill: PAL.gold }),
      });
      t.position.set(26, 1);
      row.addChild(t);
      addRow(row, 28);
    }

    // equipment rows
    for (const e of p.grant.equips) {
      const row = new Container();
      const icon = new Text({
        text: equipIcon(e),
        style: mono(18, { fill: RARITY_COLOR[e.rarity] }),
      });
      row.addChild(icon);
      const name = new Text({
        text: `${equipName(e)}  —  ${e.rarity} L${e.itemLevel}`,
        style: ui(16, { fill: RARITY_COLOR[e.rarity] }),
      });
      name.position.set(30, 0);
      row.addChild(name);
      const stats = new Text({
        text: equipStatsText(e),
        style: mono(11, { fill: PAL.textDim }),
      });
      stats.position.set(30, 21);
      row.addChild(stats);
      addRow(row, 40);
    }

    // consumable rows
    for (const c of p.grant.consumables) {
      const row = new Container();
      const icon = new Text({
        text: CONSUMABLES[c.defId].icon,
        style: mono(18),
      });
      row.addChild(icon);
      const name = new Text({
        text: `${CONSUMABLES[c.defId].name} ×${c.count}`,
        style: ui(16),
      });
      name.position.set(30, 0);
      row.addChild(name);
      addRow(row, 26);
    }

    // event-win / extra delta lines
    for (const line of lines) {
      const row = new Container();
      const t = new Text({
        text: line.text,
        style: ui(15, { fill: TONE_COLOR[line.tone] }),
      });
      row.addChild(t);
      addRow(row, 22);
    }

    // XP bar + level-up toast (victory variants)
    const runNow = ctx.run;
    if (p.xpBefore !== undefined && runNow) {
      y += 8;
      const gained = runNow.xp - p.xpBefore;
      const label = new Text({
        text: `XP +${Math.max(0, gained)}`,
        style: mono(12, { fill: PAL.energy }),
      });
      label.position.set(32, y);
      panel.addChild(label);
      const bar = makeBar(320, 10, { hp: false, color: PAL.energy });
      bar.view.position.set(120, y + 1);
      panel.addChild(bar.view);
      bar.set(xpFrac(p.xpBefore, p.levelBefore ?? runNow.level), false);
      this.later(() => bar.set(xpFrac(runNow.xp, runNow.level)), 250);
      y += 22;

      const levelBefore = p.levelBefore ?? runNow.level;
      if (runNow.level > levelBefore) {
        const toast = new Text({
          text: `LEVEL UP!  Lv ${runNow.level}`,
          style: ui(13, { fontWeight: "bold", fill: PAL.gold }),
        });
        toast.position.set(32, y);
        panel.addChild(toast);
        // gold flash: 3 alpha pulses
        const pulse = (n: number) => {
          if (n <= 0 || this.closed) return;
          tween(toast, { alpha: 0.25 }, 140, "linear", () => {
            tween(toast, { alpha: 1 }, 140, "linear", () => pulse(n - 1));
          });
        };
        pulse(3);
        y += 24;
      }
    }

    // Lives ledger (cats that stood up KO'd: pip crack + "-1 Life")
    if (p.livesLost && p.livesLost.length > 0) {
      y += 6;
      for (const lost of p.livesLost) {
        const row = new Container();
        row.position.set(32, y);
        panel.addChild(row);
        const face = new Graphics();
        drawCatPortrait(face, lost.classId, false);
        face.scale.set(0.6);
        face.position.set(14, 14);
        row.addChild(face);
        const name = new Text({
          text: CLASSES[lost.classId].catName,
          style: ui(13, {
            fontWeight: "bold",
            fill: PAL[lost.classId].body,
          }),
        });
        name.position.set(34, 0);
        row.addChild(name);
        const paws = makePawRow(lost.livesLeft);
        paws.view.position.set(34, 18);
        row.addChild(paws.view);
        const tag = new Text({
          text: "-1 Life",
          style: mono(14, { fill: PAL.danger }),
        });
        tag.position.set(130, 4);
        row.addChild(tag);
        // the cracked pip: index = livesLeft (first spent pip), splits into
        // two falling halves (ui-art §10)
        this.later(
          () => this.crackPip(row, 34 + lost.livesLeft * 8 + 3.5, 21),
          400,
        );
        y += 34;
      }
    }

    const btn = makeButton(
      this.variant === "chest" ? "[Enter] Take All" : "[Enter] Continue",
      240,
      40,
      () => this.proceed(),
      { primary: true, fontSize: 16 },
    );
    btn.view.position.set(pw / 2 - 120, ph - 56);
    panel.addChild(btn.view);
  }

  onKey(key: string): boolean {
    if (this.modal) return this.modal.onKey(key);
    if (key === "enter" || key === "space" || key === "e" || key === "esc") {
      // Esc closes loot first (gameloop §1) — same as Take All here
      this.proceed();
      return true;
    }
    return false;
  }

  unmount(): void {
    this.closed = true;
    for (const id of this.timeouts) clearTimeout(id);
    this.timeouts = [];
    this.modal?.destroy();
    this.modal = null;
    this.view?.destroy({ children: true });
    this.view = null;
  }

  /* ---- internals ------------------------------------------------------ */

  private later(fn: () => void, ms: number): void {
    this.timeouts.push(
      window.setTimeout(() => {
        if (!this.closed) fn();
      }, ms),
    );
  }

  private proceed(): void {
    if (this.modal || this.closed || !this.ctx) return;
    const next = this.overflowQueue.shift();
    if (next) {
      this.openPickup(next);
      return;
    }
    const cb = this.p?.onClosed;
    this.ctx.scenes.popOverlay(); // manager calls unmount()
    cb?.();
  }

  private openPickup(item: OverflowItem): void {
    const ctx = this.ctx!;
    this.modal = makePickupModal({
      incoming: item,
      getRun: () => ctx.run!,
      setRun: (r) => {
        ctx.run = r;
      },
      onDone: () => {
        this.modal?.destroy();
        this.modal = null;
        ctx.save();
        this.proceed();
      },
    });
    this.view?.addChild(this.modal.view);
  }

  private crackPip(host: Container, x: number, y: number): void {
    for (const dir of [-1, 1]) {
      const half = new Graphics()
        .poly([0, 0, dir * 5, 0, dir * 2, 6])
        .fill(PAL.danger);
      half.position.set(x, y);
      host.addChild(half);
      tween(
        half,
        { y: y + 30, alpha: 0, rotation: dir * 0.8 },
        500,
        "quadOut",
        () => half.destroy(),
      );
    }
  }
}

/* ---------------------------------------------------------------------- */
/* helpers                                                                 */
/* ---------------------------------------------------------------------- */

/** Fill fraction of the XP bar within the current level band. */
function xpFrac(xp: number, level: number): number {
  const lo = XP_TO_LEVEL[level - 1] ?? 0;
  const hi = XP_TO_LEVEL[level];
  if (hi === undefined || hi <= lo) return 1; // level cap
  return Math.max(0, Math.min(1, (xp - lo) / (hi - lo)));
}

function equipIcon(e: EquipInstance): string {
  return EQUIP_DEFS[e.defId].icon;
}
