/**
 * WP-10 — exploration HUD (ui-art §7, gameloop.md §3, GDD §7 rulings):
 * floor/seed chips, the four cat cards (portrait, HP bar, Lives paw row),
 * shiny counter, the item belt (all owned consumables shown; only Tuna
 * Snack / Sardine Tin pressable outside battle — others disabled with a
 * "battle only" tooltip), toasts, and the Tab marching-order panel.
 *
 * Pure presentation + input: every gameplay mutation goes through the
 * callbacks the explore scene provides (UI never computes outcomes).
 */
import { Container, Graphics, Text } from "pixi.js";
import type { ClassId, ItemId, RunState } from "../../core/types";
import { CONSUMABLES } from "../../content/consumables";
import { CLASSES } from "../../content/classes";
import { FLOORS } from "../../content/floors";
import { isStack } from "../../core/loot/inventory";
import { maxHp } from "../../core/run/party";
import { PAL, THEMES } from "../palette";
import { R, RADIUS, rh, rw, rx, ry } from "../layout";
import { mono, ui } from "../textStyles";
import { makeBar, makePanel, makePawRow, makeTooltip } from "../widgets";
import { drawCatPortrait } from "../draw/cats";

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

function beltEntries(run: RunState): BeltEntry[] {
  const byId = new Map<ItemId, number>();
  for (const slot of run.inventory.slots) {
    if (isStack(slot))
      byId.set(slot.defId, (byId.get(slot.defId) ?? 0) + slot.count);
  }
  return [...byId.entries()].map(([defId, count]) => ({ defId, count }));
}

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

    // ---- bottom party strip (full-bleed, square corners) --------------
    const strip = new Graphics()
      .rect(0, ry(R.explore.partyStrip), 1280, rh(R.explore.partyStrip))
      .fill(PAL.panel)
      .moveTo(0, ry(R.explore.partyStrip))
      .lineTo(1280, ry(R.explore.partyStrip))
      .stroke({ width: 2, color: PAL.border });

    // ---- floor + seed chips -------------------------------------------
    const floorChip = new Container();
    floorChip.position.set(rx(R.explore.floorChip), ry(R.explore.floorChip));
    floorChip.addChild(
      makePanel(rw(R.explore.floorChip), rh(R.explore.floorChip)),
    );
    const th = THEMES[themeIndex(run.floorNum)];
    const dot = new Graphics().circle(16, 18, 5).fill(th.accent);
    const floorName = FLOORS[run.floorNum - 1]?.name ?? th.name;
    const floorTxt = new Text({
      text: `Floor ${run.floorNum} — ${floorName}`,
      style: ui(14, { fontWeight: "bold" }),
    });
    floorTxt.position.set(28, 9);
    floorChip.addChild(dot, floorTxt);

    const seedTxt = new Text({
      text: `seed ${run.runSeed}`,
      style: mono(11, { fill: PAL.textDim }),
    });
    seedTxt.position.set(rx(R.explore.seedChip), ry(R.explore.seedChip));

    this.view.addChild(
      strip,
      floorChip,
      seedTxt,
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

  /** Toast at ui-art §7's rect; `stickyMs = 0` keeps it until hideToast. */
  showToast(text: string, stickyMs = 2500): void {
    this.toastBox
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    const box = new Container();
    box.position.set(rx(R.explore.toast), ry(R.explore.toast));
    box.addChild(makePanel(rw(R.explore.toast), rh(R.explore.toast)));
    const txt = new Text({ text, style: ui(14) });
    txt.anchor.set(0.5);
    txt.position.set(rw(R.explore.toast) / 2, rh(R.explore.toast) / 2);
    box.addChild(txt);
    this.toastBox.addChild(box);
    this.toastTimer = stickyMs === 0 ? Infinity : stickyMs;
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
      const r = R.explore.catCards[i];
      const card = new Container();
      card.position.set(rx(r), ry(r));
      card.addChild(
        new Graphics()
          .roundRect(0, 0, rw(r), rh(r), RADIUS.button)
          .fill({ color: PAL.panelLite, alpha: 0.55 })
          .stroke({ width: 1, color: PAL.border }),
      );
      const gone = cat.lives <= 0;
      const portrait = new Graphics();
      drawCatPortrait(portrait, cat.classId, gone);
      portrait.position.set(8 + 24, 10 + 24);
      card.addChild(portrait);

      const cls = CLASSES[cat.classId];
      const name = new Text({
        text: cls.catName,
        style: ui(13, { fontWeight: "bold", fill: PAL[cat.classId].body }),
      });
      name.position.set(64, 6);
      card.addChild(name);

      const max = maxHp(cat, run.level);
      const bar = makeBar(120, 10);
      bar.view.position.set(64, 26);
      bar.set(cat.hp / max, false);
      const hpTxt = new Text({
        text: `${cat.hp}/${max}`,
        style: mono(11, { fill: PAL.textDim }),
      });
      hpTxt.position.set(190, 24);
      card.addChild(bar.view, hpTxt);

      const paws = makePawRow(cat.lives);
      paws.view.position.set(64, 46);
      card.addChild(paws.view);

      if (gone) {
        card.alpha = 0.35;
        const goneTxt = new Text({
          text: "GONE",
          style: ui(11, { fontWeight: "bold", fill: PAL.danger }),
        });
        goneTxt.anchor.set(0.5);
        goneTxt.position.set(rw(r) / 2, rh(r) / 2);
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
          .roundRect(rx(r) - 2, ry(r) - 2, rw(r) + 4, rh(r) + 4, RADIUS.button)
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
    const r = R.explore.goldChip;
    const chip = new Container();
    chip.position.set(rx(r), ry(r));
    chip.addChild(
      new Graphics()
        .circle(12, rh(r) / 2, 7)
        .fill(PAL.gold)
        .stroke({ width: 2, color: PAL.goldDark }),
    );
    const txt = new Text({
      text: `${run.inventory.shinies} ✦`,
      style: ui(14, { fontWeight: "bold" }),
    });
    txt.position.set(26, rh(r) / 2 - 10);
    chip.addChild(txt);
    this.goldChip.addChild(chip);
  }

  private buildBelt(run: RunState): void {
    this.belt.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.clearTooltip();
    const r = R.explore.itemChips;
    const entries = beltEntries(run);
    entries.slice(0, 9).forEach((entry, i) => {
      const def = CONSUMABLES[entry.defId];
      const usable = def?.explore !== undefined;
      const chip = new Container();
      chip.position.set(rx(r) + i * 24, ry(r));
      chip.addChild(
        new Graphics()
          .roundRect(0, 0, 22, 22, RADIUS.chip)
          .fill(PAL.panel)
          .stroke({ width: 1, color: usable ? PAL.gold : PAL.border }),
      );
      const icon = new Text({ text: def?.icon ?? "?", style: mono(12) });
      icon.anchor.set(0.5);
      icon.position.set(11, 10);
      const count = new Text({
        text: String(entry.count),
        style: mono(9, { fill: PAL.textDim }),
      });
      count.anchor.set(1, 1);
      count.position.set(22, 24);
      chip.addChild(icon, count);
      if (!usable) chip.alpha = 0.55;

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
        this.tooltip.position.set(
          Math.min(chip.position.x, 1280 - this.tooltip.width - 4),
          ry(r) - this.tooltip.height - 4,
        );
        this.view.addChild(this.tooltip);
      });
      chip.on("pointerout", () => this.clearTooltip());
      this.belt.addChild(chip);
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
    const rowH = 52;
    const w = 420;
    const h = 52 + this.order.length * rowH + 34;
    const px = (1280 - w) / 2;
    const py = (632 - h) / 2;
    const panel = new Container();
    panel.position.set(px, py);
    panel.addChild(makePanel(w, h));
    const title = new Text({
      text: "MARCHING ORDER",
      style: ui(16, { fontWeight: "bold", fill: PAL.gold }),
    });
    title.position.set(16, 12);
    panel.addChild(title);

    this.order.forEach((classId, i) => {
      const row = new Container();
      row.position.set(12, 44 + i * rowH);
      const selected = i === this.sel;
      row.addChild(
        new Graphics()
          .roundRect(0, 0, w - 24, rowH - 6, RADIUS.button)
          .fill(selected ? PAL.panelLite : PAL.panel)
          .stroke({
            width: 2,
            color: selected
              ? this.grabbed
                ? PAL.gold
                : PAL.textDim
              : PAL.border,
          }),
      );
      const rank = new Text({
        text: String(i + 1),
        style: mono(14, { fill: PAL.gold }),
      });
      rank.position.set(12, 14);
      const portrait = new Graphics();
      drawCatPortrait(portrait, classId);
      portrait.scale.set(0.7);
      portrait.position.set(52, 22);
      const name = new Text({
        text: `${CLASSES[classId].catName} — ${CLASSES[classId].className}`,
        style: ui(14, { fontWeight: "bold", fill: PAL[classId].body }),
      });
      name.position.set(84, 12);
      row.addChild(rank, portrait, name);
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
      panel.addChild(row);
    });

    const hint = new Text({
      text: this.grabbed
        ? "↑/↓ move cat · Enter drop · Tab close"
        : "↑/↓ select · Enter grab · Tab close",
      style: ui(11, { fill: PAL.textDim }),
    });
    hint.position.set(16, h - 24);
    panel.addChild(hint);
    this.marching.addChild(panel);
  }
}
