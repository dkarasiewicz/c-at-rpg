/**
 * WP-12 — the loot overlay (ui-art §10 victory panel geometry, gameloop §1
 * LOOT overlay semantics): chest and battle-victory variants, staggered
 * loot rows, party XP bar with level-up toast, the Nine-Lives ledger
 * (cracking paw pip), event `onWinEffects` delta lines, and the
 * full-inventory Take/Leave path via the pickup modal.
 *
 * The overlay APPLIES its grant (core applyLootGrant / applyEventEffects)
 * on mount and autosaves — callers only roll and hand over the LootGrant.
 *
 * Chrome is the shared kit (widgets.ts): `scrim`, one raised `panel` sized
 * to its content, `heading`/`label` type, `makeSpriteIcon` art for every
 * item, the kit `bar` for XP, `avatar()` for the Lives ledger faces, and
 * one `button` with a hotkey chip. Nothing here paints its own rectangle.
 */
import { Container, Graphics } from "pixi.js";
import type {
  ClassId,
  Effect,
  EquipInstance,
  ItemId,
  ResultLine,
  Rng,
} from "../../core/types.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { XP_TO_LEVEL } from "../../content/floors.js";
import { applyEventEffects } from "../../core/events/resolve.js";
import { applyLootGrant } from "../../core/run/runState.js";
import type { LootGrant } from "../../core/types.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import { tween } from "../tween.js";
import {
  avatar,
  bar,
  button,
  heading,
  label,
  makePawRow,
  makeSpriteIcon,
  panel,
  sceneBackdrop,
  scrim,
  vignette,
} from "../widgets.js";
import { hasSprite } from "../sprites.js";
import { layer, type GameCtx, type Overlay } from "../sceneManager.js";
import {
  RARITY_COLOR,
  catNameColor,
  equipName,
  equipStatsText,
  itemSpriteId,
  makePickupModal,
  type PickupModal,
} from "./inventoryPanel.js";
import { levelUpCardHeight, makeLevelUpCard } from "./progressPanel.js";

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

const EYEBROWS: Record<LootVariant, string> = {
  chest: "THE CHEST GIVES UP",
  victory: "THE ALLEY IS YOURS",
  boss: "THE HOARD IS YOURS",
};

/**
 * Header emblem per variant — the keyed `prop:*` chest art from `env/`.
 * `victory` deliberately has none: a battle's spoils are not a chest.
 */
const EMBLEM: Record<LootVariant, string | null> = {
  chest: "prop:chestOpen",
  victory: null,
  boss: "prop:hoardChest",
};

/* ---- panel geometry (design px) --------------------------------------- */
const PW = 640;
const HEADER_H = 104;
const FOOTER_H = 88;
const PAD = SPACE.xl;
const MIN_H = 320;
const MAX_H = 620;
/** Header emblem side, design px (the prop art ships at 2× this). */
const EMBLEM_SIZE = 84;

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

    // ---- measure: the panel is sized to what it actually shows ---------
    const runNow = ctx.run;
    const hasXp = p.xpBefore !== undefined && runNow !== null;
    const levelBefore = p.levelBefore ?? runNow?.level ?? 1;
    const leveled = hasXp && (runNow?.level ?? 1) > levelBefore;
    const ledger = p.livesLost ?? [];
    // the level-up flourish (progressPanel.makeLevelUpCard) is measured here
    const levelUpH =
      leveled && runNow
        ? levelUpCardHeight(runNow.cats, levelBefore, runNow.level)
        : 0;
    const bodyH =
      (p.grant.shinies !== 0 ? 30 : 0) +
      p.grant.equips.length * 44 +
      p.grant.consumables.length * 28 +
      lines.length * 24 +
      (hasXp ? SPACE.md + 26 + levelUpH : 0) +
      (ledger.length > 0 ? SPACE.md + ledger.length * 40 : 0);
    const ph = Math.max(MIN_H, Math.min(MAX_H, HEADER_H + bodyH + FOOTER_H));
    const px = (DESIGN_W - PW) / 2;
    const py = (DESIGN_H - ph) / 2;

    // ---- build ---------------------------------------------------------
    const view = new Container();
    this.view = view;
    layer(root, "modal").addChild(view);

    // A chest / boss hoard is opened AWAY from a battle: there is no painted
    // stage under the overlay, so those two variants bring their own backdrop
    // (`scene:treasure`, fail-soft) and lighten the scrim over it. The
    // `victory` variant keeps the flat scrim — the battle stage behind it is
    // already art and must not be doubled.
    const painted = this.variant !== "victory" && hasSprite("scene:treasure");
    if (painted) {
      view.addChild(sceneBackdrop("scene:treasure", DESIGN_W, DESIGN_H));
    }
    const back = scrim(DESIGN_W, DESIGN_H, painted ? 0.55 : 0.72);
    back.eventMode = "static";
    view.addChild(back);
    if (painted) view.addChild(vignette(DESIGN_W, DESIGN_H, 0.85));

    const card = panel(PW, ph, { variant: "raised", accent: PAL.gold });
    card.position.set(px, py);
    view.addChild(card);

    // Header emblem: the keyed chest props (env/) earn their place here —
    // the object the panel is about, on the panel. `victory` has none.
    const emblemId = EMBLEM[this.variant];
    if (emblemId !== null) {
      const emblem = makeSpriteIcon(emblemId, EMBLEM_SIZE);
      if (emblem) {
        emblem.position.set(PAD + EMBLEM_SIZE / 2 - 6, HEADER_H / 2 - 4);
        emblem.alpha = 0;
        card.addChild(emblem);
        tween(emblem, { alpha: 1 }, 320, "quadOut");
      }
    }

    const eyebrow = heading(EYEBROWS[this.variant], 3, { center: true });
    eyebrow.position.set(PW / 2, SPACE.lg);
    card.addChild(eyebrow);

    const header = heading(HEADERS[this.variant], 1, {
      center: true,
      fill: PAL.gold,
    });
    header.position.set(PW / 2, SPACE.lg + 34);
    header.scale.set(1.4); // drops in with backOut 1.4→1 (ui-art §10)
    tween(header.scale, { x: 1, y: 1 }, 300, "backOut");
    card.addChild(header);

    let y = HEADER_H;
    let delay = 0;
    const addRow = (row: Container, h: number) => {
      row.position.set(PAD, y);
      row.alpha = 0;
      card.addChild(row);
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
      const coin = makeSpriteIcon("item:shinies", 22);
      if (coin) {
        coin.position.set(11, 11);
        row.addChild(coin);
      } else {
        row.addChild(
          new Graphics()
            .circle(11, 11, 7)
            .fill(PAL.gold)
            .stroke({ width: 2, color: PAL.goldDark }),
        );
      }
      const t = label(`${p.grant.shinies > 0 ? "+" : ""}${p.grant.shinies} ✦`, {
        mono: true,
        fill: PAL.gold,
        size: TYPE.body,
      });
      t.position.set(30, 2);
      row.addChild(t);
      addRow(row, 30);
    }

    // equipment rows
    for (const e of p.grant.equips) {
      const row = new Container();
      const art = makeSpriteIcon(itemSpriteId(e), 34);
      if (art) {
        art.position.set(17, 18);
        row.addChild(art);
      } else {
        const icon = label(EQUIP_DEFS[e.defId].icon, {
          mono: true,
          size: TYPE.h2,
          fill: RARITY_COLOR[e.rarity],
        });
        row.addChild(icon);
      }
      const name = label(`${equipName(e)}  —  ${e.rarity} L${e.itemLevel}`, {
        size: TYPE.body,
        bold: true,
        fill: RARITY_COLOR[e.rarity],
      });
      name.position.set(44, 0);
      const stats = label(equipStatsText(e), {
        mono: true,
        dim: true,
        size: TYPE.tiny,
      });
      stats.position.set(44, 22);
      row.addChild(name, stats);
      addRow(row, 44);
    }

    // consumable rows
    for (const c of p.grant.consumables) {
      const row = new Container();
      const art = makeSpriteIcon(`item:${c.defId}`, 24);
      if (art) {
        art.position.set(12, 12);
        row.addChild(art);
      } else {
        row.addChild(
          label(CONSUMABLES[c.defId].icon, { mono: true, size: TYPE.h3 }),
        );
      }
      const name = label(`${CONSUMABLES[c.defId].name} ×${c.count}`, {
        size: TYPE.body,
      });
      name.position.set(44, 2);
      row.addChild(name);
      addRow(row, 28);
    }

    // event-win / extra delta lines
    for (const line of lines) {
      const row = new Container();
      row.addChild(
        label(line.text, { fill: TONE_COLOR[line.tone], bold: true }),
      );
      addRow(row, 24);
    }

    // XP bar + level-up toast (victory variants)
    if (hasXp && runNow) {
      y += SPACE.md;
      const gained = runNow.xp - (p.xpBefore ?? 0);
      const xpLabel = label(`XP +${Math.max(0, gained)}`, {
        mono: true,
        fill: PAL.xp,
        size: TYPE.small,
      });
      xpLabel.position.set(PAD, y);
      card.addChild(xpLabel);
      const xpBar = bar(360, 10, { kind: "xp" });
      xpBar.view.position.set(PW - PAD - 360, y + 4);
      card.addChild(xpBar.view);
      // a level-up restarts the band: begin empty rather than letting the
      // bar visibly shrink (and leave a chip-away ghost) across the boundary
      xpBar.set(leveled ? 0 : xpFrac(p.xpBefore ?? 0, levelBefore), 1, false);
      this.later(() => xpBar.set(xpFrac(runNow.xp, runNow.level), 1), 250);
      y += 26;

      if (leveled) {
        // THE level-up moment (progression.md): new level, the growth rows
        // gained, any milestone skill learned, and where to spend the points
        const flourish = makeLevelUpCard(
          runNow.cats,
          levelBefore,
          runNow.level,
          PW - PAD * 2,
        );
        flourish.view.position.set(PAD, y);
        card.addChild(flourish.view);
        y += flourish.height;
      }
    }

    // Lives ledger (cats that stood up KO'd: pip crack + "-1 Life")
    if (ledger.length > 0) {
      y += SPACE.md;
      for (const lost of ledger) {
        const row = new Container();
        row.position.set(PAD, y);
        card.addChild(row);
        const face = avatar(lost.classId, 32, {});
        face.position.set(16, 16);
        row.addChild(face);
        const name = label(CLASSES[lost.classId].catName, {
          bold: true,
          fill: catNameColor(lost.classId),
        });
        name.position.set(40, 0);
        row.addChild(name);
        const paws = makePawRow(lost.livesLeft);
        paws.view.position.set(40, 20);
        row.addChild(paws.view);
        const tag = label("-1 Life", { mono: true, fill: PAL.danger });
        tag.anchor.set(1, 0);
        tag.position.set(PW - PAD * 2, 6);
        row.addChild(tag);
        // the cracked pip: index = livesLeft (first spent pip), splits into
        // two falling halves (ui-art §10)
        this.later(
          () => this.crackPip(row, 40 + lost.livesLeft * 8 + 3.5, 23),
          400,
        );
        y += 40;
      }
    }

    const bw = 260;
    const b = button(
      this.variant === "chest" ? "Take All" : "Continue",
      bw,
      52,
      () => this.proceed(),
      { primary: true, hotkey: "Enter" },
    );
    b.view.position.set((PW - bw) / 2, ph - 52 - SPACE.lg);
    card.addChild(b.view);
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
