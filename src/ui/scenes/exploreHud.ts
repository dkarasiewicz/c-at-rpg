/**
 * WP-10 (visual v3) — exploration HUD, re-chromed through the shared UI kit.
 *
 * Everything the old HUD hand-rolled (flat rects, procedural head glyphs,
 * bespoke bars) now goes through `widgets.panel / avatar / bar / label /
 * heading`, so the explore screen reads as the same game as results, battle
 * and landing. Contents are unchanged: the header rail (floor + seed + key
 * hints), the four cat cards (painted portrait, HP bar, Lives paw row), the
 * shinies chip, the item belt (all owned consumables shown; only Tuna Snack
 * / Sardine Tin pressable outside battle — GDD §7), toasts, and the Tab
 * marching-order panel.
 *
 * Pure presentation + input: every gameplay mutation goes through the
 * callbacks the explore scene provides (UI never computes outcomes).
 */
import { Container, Graphics, Text } from "pixi.js";
import type { ClassId, ItemId, RunState } from "../../core/types.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { CLASSES } from "../../content/classes.js";
import { FLOORS } from "../../content/floors.js";
import { isStack } from "../../core/loot/inventory.js";
import { maxHp } from "../../core/run/party.js";
import { PAL, THEMES } from "../palette.js";
import { RADIUS, rcx, rh, rw, rx, ry } from "../layout.js";
import { mono } from "../textStyles.js";
import {
  avatar,
  bar,
  heading,
  label,
  makePawRow,
  makeSpriteIcon,
  makeTooltip,
  panel,
} from "../widgets.js";
import { makeLegend } from "../draw/mapIcons.js";
import { EX, MARCH_PANEL } from "./exploreLayout.js";

export interface HudCallbacks {
  getRun(): RunState;
  /** Use an explore-usable consumable on the cat at fixed party index. */
  onUseConsumable(defId: ItemId, catIndex: number): void;
  /** Commit a new marching order when the Tab panel closes. */
  onReorder(order: ClassId[]): void;
}

interface BeltEntry {
  defId: ItemId;
  count: number;
}

/** Theme band for a floor number (floors 1-2 / 3-4 / 5-6). */
export const themeIndex = (floorNum: number): number =>
  Math.min(THEMES.length - 1, Math.floor((floorNum - 1) / 2));

/** Display name of a floor (content table first, theme band as fallback). */
export const floorName = (floorNum: number): string =>
  FLOORS[floorNum - 1]?.name ?? THEMES[themeIndex(floorNum)].name;

function beltEntries(run: RunState): BeltEntry[] {
  const byId = new Map<ItemId, number>();
  for (const slot of run.inventory.slots) {
    if (isStack(slot))
      byId.set(slot.defId, (byId.get(slot.defId) ?? 0) + slot.count);
  }
  return [...byId.entries()].map(([defId, count]) => ({ defId, count }));
}

const KEY_HINTS =
  "WASD / ↑↓←→ move · [E] descend · [M] map · [Tab] order · [Esc] menu";

export class ExploreHud {
  readonly view = new Container();

  private readonly cbs: HudCallbacks;
  private readonly cards = new Container();
  private readonly goldChip = new Container();
  private readonly belt = new Container();
  private readonly toastBox = new Container();
  private readonly marching = new Container();
  private readonly pickRings = new Container();
  private tooltip: Container | null = null;

  private readonly objective = new Container();
  private objectiveSig = "";

  private toastTimer = 0; // ms left; Infinity = sticky
  private pickDefId: ItemId | null = null;
  private dirtySig = "";

  // marching-panel state
  private marchOpen = false;
  private order: ClassId[] = [];
  private sel = 0;
  private grabbed = false;

  constructor(cbs: HudCallbacks) {
    this.cbs = cbs;
    const run = cbs.getRun();
    const th = THEMES[themeIndex(run.floorNum)];

    // ---- bottom party strip (full bleed, square corners) --------------
    // Hand-drawn rather than a kit `panel()`: a 1280×92 full-bleed plate has
    // no corners, no visible drop shadow (it runs off three screen edges) and
    // no free sides for the sheen — the kit call would cost thirteen
    // screen-wide blends a frame to render one lit top edge. Same tokens.
    const strip = new Container();
    strip.position.set(rx(EX.strip), ry(EX.strip));
    strip.addChild(
      new Graphics()
        .rect(0, 0, rw(EX.strip), rh(EX.strip))
        .fill({ color: PAL.panel, alpha: 0.96 })
        .rect(0, 0, rw(EX.strip), 1)
        .fill({ color: PAL.sheen, alpha: 0.1 })
        .moveTo(0, 0)
        .lineTo(rw(EX.strip), 0)
        .stroke({ width: 2, color: PAL.border }),
    );

    // ---- header rail: floor identity + the key map --------------------
    const header = new Container();
    header.position.set(rx(EX.header), ry(EX.header));
    header.addChild(panel(rw(EX.header), rh(EX.header), { variant: "glass" }));
    header.addChild(
      new Graphics()
        .circle(16, rh(EX.header) / 2, 5)
        .fill(th.accent)
        .stroke({ width: 1, color: PAL.void, alpha: 0.6 }),
    );
    const title = label(
      `FLOOR ${run.floorNum} · ${floorName(run.floorNum).toUpperCase()}`,
      { size: 13, bold: true },
    );
    title.position.set(30, rh(EX.header) / 2 - 8);
    const seed = label(`seed ${run.runSeed}`, {
      size: 11,
      mono: true,
      dim: true,
    });
    seed.position.set(30 + title.width + 16, rh(EX.header) / 2 - 7);
    const hints = label(KEY_HINTS, { size: 11, dim: true });
    hints.anchor.set(1, 0.5);
    hints.position.set(rw(EX.header) - 14, rh(EX.header) / 2);
    header.addChild(title, seed, hints);

    // ---- right column: map key + this-floor status --------------------
    const side = new Container();
    side.position.set(rx(EX.legend), ry(EX.legend));
    side.addChild(panel(rw(EX.legend), rh(EX.legend)));
    const keyTitle = heading("MAP KEY", 3);
    keyTitle.position.set(14, 12);
    const legend = makeLegend({ rowH: 20, icon: 11, text: 11 });
    legend.position.set(18, 32);
    const rule = new Graphics()
      .rect(14, 160, rw(EX.legend) - 28, 1)
      .fill({ color: PAL.border, alpha: 0.8 });
    const statusTitle = heading("THIS FLOOR", 3);
    statusTitle.position.set(14, 172);
    this.objective.position.set(14, 194);
    side.addChild(keyTitle, legend, rule, statusTitle, this.objective);

    this.view.addChild(
      strip,
      header,
      side,
      this.cards,
      this.pickRings,
      this.goldChip,
      this.belt,
      this.toastBox,
      this.marching,
    );
    this.refresh();
  }

  /* ---------------------------------------------------------------- */
  /* public surface                                                    */
  /* ---------------------------------------------------------------- */

  /** True while a HUD modal (marching panel / belt target pick) is up. */
  get blocksWorld(): boolean {
    return this.marchOpen || this.pickDefId !== null;
  }

  get marchingOpen(): boolean {
    return this.marchOpen;
  }

  /** Toast inside the viewport; `stickyMs = 0` keeps it until hideToast. */
  showToast(text: string, stickyMs = 2500): void {
    this.toastBox
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    const box = new Container();
    box.position.set(rx(EX.toast), ry(EX.toast));
    box.addChild(
      panel(rw(EX.toast), rh(EX.toast), {
        variant: "raised",
        accent: PAL.gold,
      }),
    );
    const txt = label(text, { size: 14, center: true });
    txt.position.set(rw(EX.toast) / 2, rh(EX.toast) / 2);
    box.addChild(txt);
    this.toastBox.addChild(box);
    this.toastTimer = stickyMs === 0 ? Infinity : stickyMs;
  }

  /**
   * The "THIS FLOOR" block in the right column: one line per fact the party
   * has actually learned (stairs found / locked, packs still prowling, loose
   * chests). Purely a readout of FloorState — no gameplay decisions here.
   */
  setObjective(lines: readonly { text: string; tone?: number }[]): void {
    const sig = lines.map((l) => `${l.text}|${l.tone ?? 0}`).join("\n");
    if (sig === this.objectiveSig) return;
    this.objectiveSig = sig;
    this.objective
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    let y = 0;
    for (const line of lines) {
      const t = label(line.text, {
        size: 12,
        wrap: rw(EX.legend) - 32,
        ...(line.tone !== undefined ? { fill: line.tone } : { dim: true }),
      });
      t.position.set(0, y);
      this.objective.addChild(t);
      y += Math.ceil(t.height) + 6;
    }
  }

  hideToast(): void {
    this.toastBox
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    this.toastTimer = 0;
  }

  openMarching(): void {
    if (this.marchOpen) return;
    this.marchOpen = true;
    this.order = this.cbs.getRun().marchingOrder.slice();
    this.sel = 0;
    this.grabbed = false;
    this.buildMarching();
  }

  closeMarching(): void {
    if (!this.marchOpen) return;
    this.marchOpen = false;
    this.grabbed = false;
    this.marching
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    this.cbs.onReorder(this.order);
  }

  /** Overlay-style key handling; true = consumed. */
  onKey(key: string): boolean {
    if (this.marchOpen) {
      if (key === "tab" || key === "esc") this.closeMarching();
      else if (key === "up" || key === "w") this.marchMove(-1);
      else if (key === "down" || key === "s") this.marchMove(1);
      else if (key === "enter" || key === "space" || key === "e") {
        this.grabbed = !this.grabbed;
        this.buildMarching();
      }
      return true; // panel swallows everything while open
    }
    if (this.pickDefId !== null && key === "esc") {
      this.exitPick();
      return true;
    }
    return false;
  }

  update(dtMs: number): void {
    if (this.toastTimer !== Infinity && this.toastTimer > 0) {
      this.toastTimer -= dtMs;
      if (this.toastTimer <= 0) this.hideToast();
    }
    // cheap dirty-check: HP/Lives/shinies/belt can change under overlays
    const run = this.cbs.getRun();
    const sig =
      run.cats.map((c) => `${c.hp},${c.lives}`).join(";") +
      `|${run.inventory.shinies}|${run.level}` +
      `|${beltEntries(run)
        .map((b) => `${b.defId}:${b.count}`)
        .join(",")}` +
      `|${run.marchingOrder.join(",")}`;
    if (sig !== this.dirtySig) {
      this.dirtySig = sig;
      this.refresh();
    }
  }

  destroy(): void {
    this.clearTooltip();
    this.view.destroy({ children: true });
  }

  /* ---------------------------------------------------------------- */
  /* cards + gold + belt                                               */
  /* ---------------------------------------------------------------- */

  refresh(): void {
    const run = this.cbs.getRun();
    this.buildCards(run);
    this.buildGold(run);
    this.buildBelt(run);
  }

  private buildCards(run: RunState): void {
    this.cards.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.pickRings
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    run.cats.forEach((cat, i) => {
      const r = EX.cards[i];
      if (!r) return;
      const w = rw(r);
      const h = rh(r);
      const gone = cat.lives <= 0;
      const lead = run.marchingOrder[0] === cat.classId;

      const card = new Container();
      card.position.set(rx(r), ry(r));
      card.addChild(
        panel(w, h, {
          variant: "glass",
          accent: gone ? PAL.textDim : PAL[cat.classId].body,
        }),
      );

      const face = avatar(cat.classId, 48, {
        shape: "rounded",
        dead: gone,
        ...(lead && !gone ? { ring: PAL.gold } : {}),
      });
      face.position.set(38, h / 2);
      card.addChild(face);

      const cls = CLASSES[cat.classId];
      const name = label(cls.catName, {
        size: 13,
        bold: true,
        fill: gone ? PAL.textDim : PAL[cat.classId].body,
      });
      name.position.set(70, 8);
      card.addChild(name);

      if (lead && !gone) {
        const leadTag = label("LEAD", { size: 9, mono: true, fill: PAL.gold });
        leadTag.anchor.set(1, 0);
        leadTag.position.set(w - 12, 9);
        card.addChild(leadTag);
      }

      const max = maxHp(cat, run.level);
      const hp = bar(112, 9, { kind: "hp" });
      hp.view.position.set(70, 28);
      hp.set(cat.hp, max, false);
      const hpTxt = label(`${cat.hp}/${max}`, {
        size: 11,
        mono: true,
        dim: true,
      });
      hpTxt.anchor.set(1, 0);
      hpTxt.position.set(w - 12, 25);
      card.addChild(hp.view, hpTxt);

      const paws = makePawRow(cat.lives);
      paws.view.position.set(70, 46);
      card.addChild(paws.view);

      if (gone) {
        card.alpha = 0.4;
        const goneTxt = label("GONE", {
          size: 11,
          bold: true,
          fill: PAL.danger,
          center: true,
        });
        goneTxt.position.set(w / 2, h / 2);
        goneTxt.rotation = -0.12;
        card.addChild(goneTxt);
      } else {
        card.eventMode = "static";
        card.on("pointertap", () => {
          if (this.pickDefId !== null) {
            const defId = this.pickDefId;
            this.exitPick();
            this.cbs.onUseConsumable(defId, i);
          }
        });
        // gold target ring, shown only during belt target-pick
        const ring = new Graphics()
          .roundRect(rx(r) - 3, ry(r) - 3, w + 6, h + 6, RADIUS.panel + 2)
          .stroke({ width: 2, color: PAL.gold });
        ring.visible = this.pickDefId !== null;
        this.pickRings.addChild(ring);
      }
      this.cards.addChild(card);
    });
  }

  private buildGold(run: RunState): void {
    this.goldChip
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    const r = EX.goldChip;
    const chip = new Container();
    chip.position.set(rx(r), ry(r));
    chip.addChild(panel(rw(r), rh(r), { variant: "glass" }));
    chip.addChild(
      new Graphics()
        .circle(18, rh(r) / 2, 7)
        .fill(PAL.gold)
        .stroke({ width: 2, color: PAL.goldDark }),
    );
    const txt = label(`${run.inventory.shinies}`, {
      size: 15,
      bold: true,
      fill: PAL.gold,
    });
    txt.position.set(32, rh(r) / 2 - 9);
    const unit = label("shinies", { size: 11, dim: true });
    unit.anchor.set(1, 0.5);
    unit.position.set(rw(r) - 12, rh(r) / 2);
    chip.addChild(txt, unit);
    this.goldChip.addChild(chip);
  }

  private buildBelt(run: RunState): void {
    this.belt.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.clearTooltip();
    const r = EX.belt;
    const entries = beltEntries(run);
    const size = 26;
    const gap = 4;
    const holder = new Container();
    holder.position.set(rx(r), ry(r));
    this.belt.addChild(holder);

    if (entries.length === 0) {
      const empty = label("belt empty", { size: 11, dim: true });
      empty.position.set(2, (rh(r) - 14) / 2);
      holder.addChild(empty);
      return;
    }

    entries.slice(0, 8).forEach((entry, i) => {
      const def = CONSUMABLES[entry.defId];
      const usable = def?.explore !== undefined;
      const chip = new Container();
      chip.position.set(i * (size + gap), (rh(r) - size) / 2);
      chip.addChild(
        new Graphics()
          .roundRect(0, 0, size, size, RADIUS.chip)
          .fill({ color: PAL.panelLite, alpha: 0.9 })
          .stroke({ width: 1, color: usable ? PAL.gold : PAL.border }),
      );
      const art = makeSpriteIcon(`item:${entry.defId}`, size - 6);
      let icon: Container;
      if (art) {
        art.position.set(size / 2, size / 2);
        icon = art;
      } else {
        const glyph = new Text({
          text: def?.icon ?? "?",
          style: mono(13),
        });
        glyph.anchor.set(0.5);
        glyph.position.set(size / 2, size / 2 - 1);
        icon = glyph;
      }
      const count = label(String(entry.count), {
        size: 9,
        mono: true,
        dim: true,
      });
      count.anchor.set(1, 1);
      count.position.set(size - 1, size + 1);
      chip.addChild(icon, count);
      if (!usable) chip.alpha = 0.5;

      chip.eventMode = "static";
      chip.cursor = usable ? "pointer" : "default";
      chip.on("pointertap", () => {
        if (!usable) return;
        this.pickDefId = entry.defId;
        this.showToast(`${def.name} — click a cat card (Esc cancels)`, 0);
        for (const ring of this.pickRings.children) ring.visible = true;
      });
      chip.on("pointerover", () => {
        this.clearTooltip();
        this.tooltip = makeTooltip(
          usable ? def.name : `${def?.name} — battle only`,
        );
        // above the whole strip, not just the belt row — otherwise it lands
        // on top of the shinies chip
        this.tooltip.position.set(
          Math.min(rx(r) + i * (size + gap), 1280 - this.tooltip.width - 6),
          ry(EX.strip) - this.tooltip.height - 6,
        );
        this.view.addChild(this.tooltip);
      });
      chip.on("pointerout", () => this.clearTooltip());
      holder.addChild(chip);
    });
  }

  private exitPick(): void {
    this.pickDefId = null;
    this.hideToast();
    for (const ring of this.pickRings.children) ring.visible = false;
  }

  private clearTooltip(): void {
    if (this.tooltip) {
      this.tooltip.destroy({ children: true });
      this.tooltip = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tab marching-order panel (dungeon.md §9.2)                         */
  /* ---------------------------------------------------------------- */

  private marchMove(dir: -1 | 1): void {
    const n = this.order.length;
    if (n === 0) return;
    if (this.grabbed) {
      const to = this.sel + dir;
      if (to < 0 || to >= n) return;
      const [cat] = this.order.splice(this.sel, 1);
      this.order.splice(to, 0, cat);
      this.sel = to;
    } else {
      this.sel = (this.sel + dir + n) % n;
    }
    this.buildMarching();
  }

  private buildMarching(): void {
    this.marching
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    const rowH = MARCH_PANEL.rowH;
    const w = MARCH_PANEL.w;
    const h = 60 + this.order.length * rowH + 36;
    const cx = rcx(EX.viewport);
    const cy = ry(EX.viewport) + rh(EX.viewport) / 2;

    const wrap = new Container();
    wrap.position.set(Math.round(cx - w / 2), Math.round(cy - h / 2));
    wrap.addChild(panel(w, h, { variant: "raised", accent: PAL.gold }));
    const title = label("MARCHING ORDER", {
      size: 15,
      bold: true,
      fill: PAL.gold,
    });
    title.position.set(18, 14);
    const sub = label("front of the line takes the first swipe", {
      size: 11,
      dim: true,
    });
    sub.position.set(18, 34);
    wrap.addChild(title, sub);

    this.order.forEach((classId, i) => {
      const row = new Container();
      row.position.set(14, 58 + i * rowH);
      const selected = i === this.sel;
      row.addChild(
        new Graphics()
          .roundRect(0, 0, w - 28, rowH - 6, RADIUS.button)
          .fill({
            color: selected ? PAL.panelLite : PAL.panel,
            alpha: 0.95,
          })
          .stroke({
            width: 2,
            color: selected
              ? this.grabbed
                ? PAL.gold
                : PAL.textDim
              : PAL.border,
          }),
      );
      const rank = label(String(i + 1), {
        size: 14,
        mono: true,
        fill: PAL.gold,
      });
      rank.position.set(14, rowH / 2 - 11);
      const face = avatar(classId, 34, { shape: "rounded" });
      face.position.set(52, rowH / 2 - 3);
      const name = label(
        `${CLASSES[classId].catName} — ${CLASSES[classId].className}`,
        { size: 14, bold: true, fill: PAL[classId].body },
      );
      name.position.set(78, rowH / 2 - 12);
      row.addChild(rank, face, name);
      row.eventMode = "static";
      row.cursor = "pointer";
      row.on("pointertap", () => {
        if (this.grabbed) {
          const [cat] = this.order.splice(this.sel, 1);
          this.order.splice(i, 0, cat);
          this.grabbed = false;
          this.sel = i;
        } else if (this.sel === i) {
          this.grabbed = true;
        } else {
          this.sel = i;
        }
        this.buildMarching();
      });
      wrap.addChild(row);
    });

    const hint = label(
      this.grabbed
        ? "↑/↓ move cat · Enter drop · Tab close"
        : "↑/↓ select · Enter grab · Tab close",
      { size: 11, dim: true },
    );
    hint.position.set(18, h - 26);
    wrap.addChild(hint);
    this.marching.addChild(wrap);
  }
}
