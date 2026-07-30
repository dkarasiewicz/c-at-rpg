/**
 * WP-12 — the Landing scene (GDD §7 ruling, loot.md §6, gameloop.md §4):
 * the between-floors stairwell after floors 1–5. In order: ① free catnap
 * heal `floor(0.25 × maxHP)` per living cat (floaters), ② the Peddler —
 * stock from the shop stream, buy/sell, Warm Lap once per landing —
 * ③ marching-order editor, ④ Descend → floorgen.
 *
 * On mount this scene applies the arrival steps itself (floor-mod expiry +
 * catnap via core APIs) so the cards, floaters and Warm Lap all see the
 * same HP; Descend then performs only the floor bookkeeping (core
 * `descend()` bundles the catnap and would double-heal — see notes).
 */
import { Container, Graphics, Text } from "pixi.js";
import type { ClassId, RunState } from "../../core/types";
import { CLASSES } from "../../content/classes";
import { CONSUMABLES } from "../../content/consumables";
import { EQUIP_DEFS } from "../../content/equipment";
import { hash, mulberry32 } from "../../core/rng";
import {
  buyStockItem,
  buyWarmLap,
  rollShopStock,
  warmLapHeal,
  type ShopStock,
} from "../../core/loot/shop";
import { expireFloorMods, maxHp } from "../../core/run/party";
import { catnapHeal, FLOOR_COUNT } from "../../core/run/runState";
import { PAL, CHEST_WOOD } from "../palette";
import { DESIGN_H, DESIGN_W, RADIUS } from "../layout";
import { display, mono, ui } from "../textStyles";
import { tween } from "../tween";
import {
  makeBar,
  makeButton,
  makePanel,
  makePawRow,
  type Bar,
} from "../widgets";
import { drawCat, drawCatPortrait } from "../draw/cats";
import {
  equipName,
  equipStatsText,
  makeInventoryPanel,
  RARITY_COLOR,
  type InventoryPanelApi,
} from "../overlays/inventoryPanel";
import { layer, type GameCtx, type Scene } from "../sceneManager";

/** Factory used by main.ts's scene table. */
export function createLandingScene(): Scene {
  return new LandingScene();
}

interface CatCard {
  view: Container;
  catIndex: number;
  bar: Bar;
  hpText: Text;
  set(hp: number, max: number): void;
}

export class LandingScene implements Scene {
  private view: Container | null = null;
  private ctx: GameCtx | null = null;
  private stock: ShopStock | null = null;
  private stockLayer: Container | null = null;
  private cards: CatCard[] = [];
  private fxLayer: Container | null = null;
  private marchLayer: Container | null = null;
  private marchSelected: number | null = null;
  private sellBox: Container | null = null;
  private sellPanel: InventoryPanelApi | null = null;
  private shiniesText: Text | null = null;
  private peddlerCat: Container | null = null;
  private peddlerBaseY = 0;
  private t = 0;
  private descendFn: (() => void) | null = null;

  mount(root: Container, ctx: GameCtx): void {
    this.ctx = ctx;
    const view = new Container();
    this.view = view;
    layer(root, "hud").addChild(view);

    let run = ctx.run!;
    const n = run.floorNum; // the floor just cleared

    // ---- arrival: floor mods expire, free catnap (GDD §7 ①) ------------
    const expired = run.cats.map((c) => expireFloorMods(c, run.level));
    const { cats, healed } = catnapHeal(expired, run.level);
    run = { ...run, cats };
    ctx.run = run;

    // ---- Peddler stock: one roll from the shop stream (loot.md §6) -----
    const shopRng = mulberry32(hash(run.runSeed, "shop", n));
    const stock = rollShopStock(shopRng, {
      floor: n,
      livingClasses: run.cats.filter((c) => c.lives > 0).map((c) => c.classId),
      uniquesDropped: run.uniquesDropped,
      nextUid: run.inventory.nextUid,
    });
    this.stock = stock;
    // a stocked Mewthical counts as dropped this run (loot.md §5)
    for (const slot of stock.slots) {
      if (slot.kind === "equip" && slot.item.hook) {
        if (!run.uniquesDropped.includes(slot.item.hook)) {
          run = {
            ...run,
            uniquesDropped: [...run.uniquesDropped, slot.item.hook],
          };
          ctx.run = run;
        }
      }
    }

    // ---- backdrop ------------------------------------------------------
    view.addChild(
      new Graphics().rect(0, 0, DESIGN_W, DESIGN_H).fill(PAL.bgDeep),
    );
    // stairwell flavor: steps descending into the dark
    const steps = new Graphics();
    for (let i = 0; i < 6; i++) {
      steps
        .rect(80 + i * 60, 200 + i * 56, 420 - i * 60, 16)
        .fill({ color: PAL.panel, alpha: 0.5 - i * 0.06 });
    }
    view.addChild(steps);

    const title = new Text({
      text: "THE LANDING",
      style: display(32, { fill: PAL.gold }),
    });
    title.anchor.set(0.5, 0);
    title.position.set(DESIGN_W / 2, 20);
    view.addChild(title);
    const sub = new Text({
      text: `Floor ${n} cleared — the stairwell is quiet. The way up has already collapsed.`,
      style: ui(14, { fill: PAL.textDim }),
    });
    sub.anchor.set(0.5, 0);
    sub.position.set(DESIGN_W / 2, 62);
    view.addChild(sub);

    // ---- cat cards + catnap floaters -----------------------------------
    this.cards = [];
    this.fxLayer = new Container();
    let cy = 100;
    run.cats.forEach((_cat, i) => {
      const card = this.makeCatCard(run, i, 24, cy);
      view.addChild(card.view);
      this.cards.push(card);
      cy += 78;
    });
    view.addChild(this.fxLayer);
    healed.forEach((amount, i) => {
      if (amount > 0) {
        this.floatText(224, 100 + i * 78 + 18, `+${amount}`, PAL.heal, i * 150);
      }
    });

    // ---- Peddler panel -------------------------------------------------
    this.buildPeddler(view);

    // ---- marching-order editor ----------------------------------------
    this.marchLayer = new Container();
    this.marchLayer.position.set(24, 480);
    view.addChild(this.marchLayer);
    this.refreshMarch();

    // ---- bottom buttons ------------------------------------------------
    const sellBtn = makeButton("Sell to the Peddler", 220, 40, () =>
      this.toggleSell(true),
    );
    sellBtn.view.position.set(24, 656);
    view.addChild(sellBtn.view);

    const canDescend = n < FLOOR_COUNT;
    const descendBtn = makeButton(
      `[Enter] Descend to Floor ${n + 1}`,
      280,
      48,
      () => this.descend(),
      { primary: true, fontSize: 16 },
    );
    descendBtn.view.position.set(DESIGN_W - 304, 648);
    descendBtn.setEnabled(canDescend);
    view.addChild(descendBtn.view);
    this.descendFn = canDescend ? () => this.descend() : null;

    this.refreshAll();
  }

  update(dtMs: number): void {
    this.t += dtMs;
    if (this.peddlerCat) {
      // idle bob (ui-art §12 freebie ambience)
      this.peddlerCat.y =
        this.peddlerBaseY + Math.sin((this.t * 2 * Math.PI) / 1600) * 2;
    }
  }

  onKey(key: string): boolean {
    if (this.sellBox) {
      if (key === "esc" || key === "x") {
        this.toggleSell(false);
        return true;
      }
      return this.sellPanel?.onKey(key) ?? false;
    }
    if (key === "enter") {
      this.descendFn?.();
      return true;
    }
    const i = "1234".indexOf(key);
    if (i >= 0) {
      this.marchTap(i);
      return true;
    }
    return false;
  }

  unmount(): void {
    this.sellPanel?.destroy();
    this.sellPanel = null;
    this.sellBox = null;
    this.view?.destroy({ children: true });
    this.view = null;
    this.cards = [];
    this.stockLayer = null;
    this.marchLayer = null;
    this.fxLayer = null;
    this.peddlerCat = null;
    this.descendFn = null;
  }

  /* ---- cat cards ------------------------------------------------------ */

  private makeCatCard(
    run: RunState,
    catIndex: number,
    x: number,
    y: number,
  ): CatCard {
    const cat = run.cats[catIndex];
    const cls = CLASSES[cat.classId];
    const viewC = new Container();
    viewC.position.set(x, y);
    viewC.addChild(makePanel(244, 68));

    const face = new Graphics();
    drawCatPortrait(face, cat.classId, cat.lives <= 0);
    face.position.set(32, 34);
    viewC.addChild(face);

    const name = new Text({
      text: cls.catName,
      style: ui(13, { fontWeight: "bold", fill: PAL[cat.classId].body }),
    });
    name.position.set(64, 8);
    viewC.addChild(name);

    const bar = makeBar(120, 10);
    bar.view.position.set(64, 28);
    viewC.addChild(bar.view);
    const hpText = new Text({ text: "", style: mono(11) });
    hpText.position.set(190, 26);
    viewC.addChild(hpText);

    const paws = makePawRow(cat.lives);
    paws.view.position.set(64, 48);
    viewC.addChild(paws.view);

    if (cat.lives <= 0) {
      viewC.alpha = 0.35;
      const gone = new Text({
        text: "GONE",
        style: ui(11, { fill: PAL.danger, fontWeight: "bold" }),
      });
      gone.position.set(150, 48);
      viewC.addChild(gone);
    }

    const card: CatCard = {
      view: viewC,
      catIndex,
      bar,
      hpText,
      set(hp: number, max: number) {
        bar.set(max > 0 ? hp / max : 0);
        hpText.text = `${hp}/${max}`;
      },
    };
    const max = maxHp(cat, run.level);
    card.set(cat.hp, max);
    return card;
  }

  private floatText(
    x: number,
    y: number,
    text: string,
    color: number,
    delayMs = 0,
  ): void {
    const fx = this.fxLayer;
    if (!fx) return;
    const t = new Text({ text, style: mono(14, { fill: color }) });
    t.anchor.set(0.5);
    t.position.set(x, y);
    t.alpha = 0;
    fx.addChild(t);
    window.setTimeout(() => {
      if (t.destroyed) return;
      t.alpha = 1;
      tween(t, { y: y - 24 }, 700, "quadOut");
      tween(t, { alpha: 0 }, 700, "linear", () => {
        if (!t.destroyed) t.destroy();
      });
    }, delayMs);
  }

  /* ---- The Peddler ---------------------------------------------------- */

  private buildPeddler(view: Container): void {
    const panel = new Container();
    panel.position.set(656, 96);
    panel.addChild(makePanel(600, 370));
    view.addChild(panel);

    // the fat orange cat on a cushion with a bindle
    const cushion = new Graphics()
      .ellipse(70, 96, 52, 14)
      .fill(PAL.stProvoked)
      .stroke({ width: 2, color: PAL.border });
    panel.addChild(cushion);
    const cat = new Container();
    const catG = new Graphics();
    drawCat(catG, "bruiser", "sit", 0.9);
    cat.addChild(catG);
    cat.position.set(70, 92);
    this.peddlerCat = cat;
    this.peddlerBaseY = cat.y;
    panel.addChild(cat);
    const bindle = new Graphics();
    bindle
      .moveTo(108, 40)
      .lineTo(132, 84)
      .stroke({ width: 3, color: CHEST_WOOD });
    bindle
      .circle(112, 38, 10)
      .fill(PAL.panelLite)
      .stroke({ width: 2, color: PAL.border });
    panel.addChild(bindle);

    const title = new Text({
      text: "THE PEDDLER",
      style: display(22, { fill: PAL.gold }),
    });
    title.position.set(150, 16);
    panel.addChild(title);
    const blurb = new Text({
      text: '"Mrrp. Everything is for sale. Especially the things I found."',
      style: ui(12, { fill: PAL.textDim, fontStyle: "italic" }),
    });
    blurb.position.set(150, 48);
    panel.addChild(blurb);

    this.shiniesText = new Text({
      text: "",
      style: mono(14, { fill: PAL.gold }),
    });
    this.shiniesText.anchor.set(1, 0);
    this.shiniesText.position.set(584, 20);
    panel.addChild(this.shiniesText);

    this.stockLayer = new Container();
    this.stockLayer.position.set(16, 130);
    panel.addChild(this.stockLayer);
  }

  private refreshAll(): void {
    const run = this.ctx?.run;
    if (!run) return;
    if (this.shiniesText) {
      this.shiniesText.text = `${run.inventory.shinies} ✦`;
    }
    for (const card of this.cards) {
      const cat = run.cats[card.catIndex];
      card.set(cat.hp, maxHp(cat, run.level));
    }
    this.refreshStock();
    this.sellPanel?.refresh();
  }

  private refreshStock(): void {
    const layer = this.stockLayer;
    const stock = this.stock;
    const run = this.ctx?.run;
    if (!layer || !stock || !run) return;
    for (const c of layer.removeChildren()) c.destroy({ children: true });

    let y = 0;
    stock.slots.forEach((slot, i) => {
      const isEquipSlot = slot.kind === "equip";
      const h = isEquipSlot ? 50 : 38;
      const row = new Container();
      row.position.set(0, y);
      row.addChild(
        new Graphics()
          .roundRect(0, 0, 568, h - 4, RADIUS.button)
          .fill(PAL.hpBack)
          .stroke({ width: 1, color: PAL.border }),
      );

      const icon = new Text({
        text:
          slot.kind === "consumable"
            ? CONSUMABLES[slot.defId].icon
            : EQUIP_DEFS[slot.item.defId].icon,
        style: mono(18, {
          fill:
            slot.kind === "equip" ? RARITY_COLOR[slot.item.rarity] : PAL.text,
        }),
      });
      icon.position.set(12, 6);
      row.addChild(icon);

      const name = new Text({
        text:
          slot.kind === "consumable"
            ? CONSUMABLES[slot.defId].name
            : `${equipName(slot.item)} — ${slot.item.rarity} L${slot.item.itemLevel}`,
        style: ui(14),
      });
      name.position.set(44, 6);
      row.addChild(name);
      if (slot.kind === "equip") {
        const stats = new Text({
          text: equipStatsText(slot.item),
          style: mono(10, { fill: PAL.textDim }),
        });
        stats.position.set(44, 27);
        row.addChild(stats);
      }

      if (slot.sold) {
        row.alpha = 0.5;
        const sold = new Text({
          text: "SOLD",
          style: mono(12, { fill: PAL.danger }),
        });
        sold.anchor.set(1, 0);
        sold.position.set(556, 8);
        row.addChild(sold);
      } else {
        const price = new Text({
          text: `${slot.price} ✦`,
          style: mono(14, { fill: PAL.gold }),
        });
        price.anchor.set(1, 0);
        price.position.set(480, 8);
        row.addChild(price);
        const buy = makeButton("Buy", 64, 26, () => this.buy(i), {
          fontSize: 13,
        });
        buy.view.position.set(492, (h - 4 - 26) / 2);
        buy.setEnabled(run.inventory.shinies >= slot.price);
        row.addChild(buy.view);
      }
      layer.addChild(row);
      y += h;
    });

    // Warm Lap service row (once per landing)
    const h = 40;
    const row = new Container();
    row.position.set(0, y + 4);
    row.addChild(
      new Graphics()
        .roundRect(0, 0, 568, h - 4, RADIUS.button)
        .fill(PAL.panelLite)
        .stroke({ width: 1, color: PAL.border }),
    );
    const label = new Text({
      text: "Warm Lap — every living cat heals 40% of max HP",
      style: ui(13),
    });
    label.position.set(12, 9);
    row.addChild(label);
    if (stock.warmLapUsed) {
      const used = new Text({
        text: "USED",
        style: mono(12, { fill: PAL.textDim }),
      });
      used.anchor.set(1, 0);
      used.position.set(556, 9);
      row.addChild(used);
    } else {
      const price = new Text({
        text: `${stock.warmLapCost} ✦`,
        style: mono(14, { fill: PAL.gold }),
      });
      price.anchor.set(1, 0);
      price.position.set(480, 9);
      row.addChild(price);
      const buy = makeButton("Lap", 64, 26, () => this.warmLap(), {
        fontSize: 13,
      });
      buy.view.position.set(492, 5);
      buy.setEnabled(run.inventory.shinies >= stock.warmLapCost);
      row.addChild(buy.view);
    }
    layer.addChild(row);
  }

  private buy(slotIndex: number): void {
    const ctx = this.ctx;
    const stock = this.stock;
    if (!ctx || !stock) return;
    const run = ctx.run!;
    const r = buyStockItem(stock, slotIndex, run.inventory);
    if (!r.ok) return; // sold / can't afford / backpack full
    this.stock = r.stock;
    ctx.run = { ...run, inventory: r.inv };
    this.refreshAll();
  }

  private warmLap(): void {
    const ctx = this.ctx;
    const stock = this.stock;
    if (!ctx || !stock) return;
    const run = ctx.run!;
    const r = buyWarmLap(stock, run.inventory);
    if (!r.ok) return;
    this.stock = r.stock;
    const cats = run.cats.map((cat, i) => {
      if (cat.lives <= 0) return cat;
      const max = maxHp(cat, run.level);
      const hp = Math.min(max, cat.hp + warmLapHeal(max));
      if (hp > cat.hp) {
        this.floatText(224, 100 + i * 78 + 18, `+${hp - cat.hp}`, PAL.heal);
      }
      return hp === cat.hp ? cat : { ...cat, hp };
    });
    ctx.run = { ...run, cats, inventory: r.inv };
    this.refreshAll();
  }

  /* ---- marching-order editor (③) -------------------------------------- */

  private refreshMarch(): void {
    const layer = this.marchLayer;
    const run = this.ctx?.run;
    if (!layer || !run) return;
    for (const c of layer.removeChildren()) c.destroy({ children: true });

    const label = new Text({
      text: "MARCHING ORDER — front → back (click or 1-4 to swap)",
      style: ui(13, { fill: PAL.textDim }),
    });
    layer.addChild(label);

    run.marchingOrder.forEach((classId, i) => {
      const slot = new Container();
      slot.position.set(i * 76, 26);
      const selected = this.marchSelected === i;
      slot.addChild(
        new Graphics()
          .roundRect(0, 0, 64, 78, RADIUS.button)
          .fill(PAL.panel)
          .stroke({ width: 2, color: selected ? PAL.gold : PAL.border }),
      );
      const face = new Graphics();
      drawCatPortrait(face, classId, false);
      face.position.set(32, 34);
      slot.addChild(face);
      const rank = new Text({
        text: `${i + 1}`,
        style: mono(12, { fill: PAL.gold }),
      });
      rank.position.set(4, 2);
      slot.addChild(rank);
      const nm = new Text({
        text: CLASSES[classId].catName,
        style: ui(10, { fill: PAL[classId].body }),
      });
      nm.anchor.set(0.5, 0);
      nm.position.set(32, 62);
      slot.addChild(nm);

      slot.eventMode = "static";
      slot.cursor = "pointer";
      slot.on("pointertap", () => this.marchTap(i));
      layer.addChild(slot);
    });
  }

  private marchTap(i: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const run = ctx.run!;
    if (i >= run.marchingOrder.length) return;
    if (this.marchSelected === null) {
      this.marchSelected = i;
    } else if (this.marchSelected === i) {
      this.marchSelected = null;
    } else {
      const order = run.marchingOrder.slice();
      const tmp = order[this.marchSelected];
      order[this.marchSelected] = order[i];
      order[i] = tmp;
      ctx.run = { ...run, marchingOrder: order as ClassId[] };
      this.marchSelected = null;
    }
    this.refreshMarch();
  }

  /* ---- sell (inventory panel in 'sell' mode) --------------------------- */

  private toggleSell(open: boolean): void {
    const view = this.view;
    const ctx = this.ctx;
    if (!view || !ctx) return;
    if (!open) {
      this.sellPanel?.destroy();
      this.sellPanel = null;
      this.sellBox?.destroy({ children: true });
      this.sellBox = null;
      this.refreshAll();
      return;
    }
    if (this.sellBox) return;
    const box = new Container();
    const scrim = new Graphics()
      .rect(0, 0, DESIGN_W, DESIGN_H)
      .fill({ color: PAL.scrim, alpha: 0.6 });
    scrim.eventMode = "static";
    box.addChild(scrim);
    const panel = makeInventoryPanel({
      mode: "sell",
      getRun: () => ctx.run!,
      setRun: (r) => {
        ctx.run = r;
      },
      onChanged: () => this.refreshAll(),
    });
    panel.view.position.set((DESIGN_W - 960) / 2, 180);
    box.addChild(panel.view);
    const close = makeButton(
      "[Esc] Done",
      160,
      36,
      () => this.toggleSell(false),
      {
        primary: true,
        fontSize: 14,
      },
    );
    close.view.position.set((DESIGN_W - 160) / 2, 180 + 340);
    box.addChild(close.view);
    view.addChild(box);
    this.sellBox = box;
    this.sellPanel = panel;
  }

  /* ---- Descend (④) ----------------------------------------------------- */

  private descend(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const run = ctx.run!;
    if (run.floorNum >= FLOOR_COUNT) return;
    // Arrival already expired floor mods + applied the catnap (mount).
    // Remaining descend bookkeeping (core/run/runState.descend minus the
    // heal, which would double-apply — see contract notes):
    ctx.run = {
      ...run,
      floorNum: run.floorNum + 1,
      score: { ...run.score, floorsReached: run.score.floorsReached + 1 },
      floorFiredEventIds: [],
      floor: null,
    };
    ctx.save(); // autosave point: landing descend
    ctx.scenes.goto("floorgen");
  }
}
