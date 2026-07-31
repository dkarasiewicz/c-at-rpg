/**
 * WP-12 — the Landing scene (GDD §7 ruling, loot.md §6, gameloop.md §4):
 * the between-floors stairwell after floors 1–5. In order: ① free catnap
 * heal `floor(0.25 × maxHP)` per living cat (floaters), ② the Peddler —
 * stock from the shop stream, buy/sell, Warm Lap once per landing —
 * ③ marching-order editor, ④ THE DEN (progression.md — Whisker Points,
 * battle loadout, three gear slots; action bar, hotkey P, with a gold
 * badge on every card that has a point unspent), ⑤ Descend → floorgen.
 *
 * On mount this scene applies the arrival steps itself (floor-mod expiry +
 * catnap via core APIs) so the cards, floaters and Warm Lap all see the
 * same HP; Descend then performs only the floor bookkeeping (core
 * `descend()` bundles the catnap and would double-heal — see notes).
 *
 * ── LAYOUT ──────────────────────────────────────────────────────────────
 * Title zone (eyebrow / banner / subtitle) · content zone (clowder +
 * marching order on the left, the Peddler on the right) · a persistent
 * action bar with the primary Descend on the right. Every piece of chrome
 * comes from the shared kit (widgets.ts): `sceneBackdrop`, `vignette`,
 * `panel`, `avatar` (painted portraits — no flat-vector cats anywhere),
 * `bar`, `makePawRow`, `makeSpriteIcon`, `heading`/`label`, `button`.
 * THE PEDDLER is the painted `npc:peddler` sprite, with the procedural
 * `drawCat` recipe kept only as the assetless fallback.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { ClassId, RunState } from "../../core/types.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { hash, mulberry32 } from "../../core/rng.js";
import {
  buyStockItem,
  buyWarmLap,
  rollShopStock,
  warmLapHeal,
  type ShopStock,
} from "../../core/loot/shop.js";
import { expireFloorMods, maxHp, unspentPoints } from "../../core/run/party.js";
import { catnapHeal, FLOOR_COUNT } from "../../core/run/runState.js";
import { PAL, CHEST_WOOD } from "../palette.js";
import { DESIGN_H, DESIGN_W, RADIUS, SPACE } from "../layout.js";
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
  scrim,
  sceneBackdrop,
  vignette,
  type ValueBar,
} from "../widgets.js";
import { drawCat } from "../draw/cats.js";
import {
  catNameColor,
  equipName,
  equipStatsText,
  itemSpriteId,
  INVENTORY_PANEL_W,
  makeInventoryPanel,
  RARITY_COLOR,
  type InventoryPanelApi,
} from "../overlays/inventoryPanel.js";
import {
  DEN_HOTKEY,
  DEN_LABEL,
  makeDenBox,
  makePointBadgeAt,
  totalUnspentPoints,
  type ProgressPanelApi,
} from "../overlays/progressPanel.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** Factory used by main.ts's scene table. */
export function createLandingScene(): Scene {
  return new LandingScene();
}

/* ---- screen geometry (design px) ------------------------------------- */
const EYEBROW_Y = 34;
const BANNER_Y = 62;
const SUB_Y = 108;

const CONTENT_Y = 148;
const MARGIN = 40;

const LEFT_W = 336;
const CLOWDER_H = 336;
const MARCH_Y = CONTENT_Y + CLOWDER_H + SPACE.md;
const MARCH_H = 132;

const PEDDLER_X = MARGIN + LEFT_W + SPACE.lg;
const PEDDLER_W = DESIGN_W - MARGIN - PEDDLER_X;
const PEDDLER_H = MARCH_Y + MARCH_H - CONTENT_Y;

/** Peddler internals. */
const NPC_COL_W = 196;
const ROW_H = 46;
const ROW_GAP = 4;

/** The action bar: one row, three slots, primary on the right. */
const BAR_Y = 640;
const BAR_H = 52;
const SLOT_W = 240;
const DESCEND_W = 300;

/**
 * The sell modal's card height. Sell mode shows only the 8×2 grid (which
 * ends at 188px) plus a three-line tip, so the manage-mode default leaves
 * the bottom third empty; this is the grid plus room for the Done button
 * inside the card.
 */
const SELL_PANEL_H = 272;

interface CatCard {
  view: Container;
  catIndex: number;
  bar: ValueBar;
  hpText: Text;
  set(hp: number, max: number): void;
  /** Unspent Whisker Points badge — the level-up must never be missed. */
  setPoints(n: number): void;
}

/**
 * Mount params. Absent = the between-floors stairwell (the floor is cleared:
 * catnap, Peddler, Den, Descend). Present = the run map's SHOP NODE, which
 * borrows the same Peddler: no catnap, no floor bookkeeping, and the primary
 * action hands the route straight back (run-map-and-dm.md §2).
 */
export interface LandingParams {
  shop?: {
    /** run-map node id (kept for the header line / future callbacks) */
    nodeId: number;
    /** the node's payload seed — the stock stream for THIS shop */
    seed: number;
  };
}

export class LandingScene implements Scene {
  private view: Container | null = null;
  private ctx: GameCtx | null = null;
  /** Peddler-node mode: no catnap, no descend, back to the map when done. */
  private shopNode: LandingParams["shop"] = undefined;
  private stock: ShopStock | null = null;
  private stockLayer: Container | null = null;
  private cards: CatCard[] = [];
  private fxLayer: Container | null = null;
  private marchLayer: Container | null = null;
  private marchSelected: number | null = null;
  private sellBox: Container | null = null;
  private sellPanel: InventoryPanelApi | null = null;
  private denBox: Container | null = null;
  private denPanel: ProgressPanelApi | null = null;
  private denBadgeHost: Container | null = null;
  private shiniesText: Text | null = null;
  private peddlerCat: Container | null = null;
  private peddlerBaseY = 0;
  private t = 0;
  private descendFn: (() => void) | null = null;

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    this.ctx = ctx;
    const view = new Container();
    this.view = view;
    layer(root, "hud").addChild(view);

    const shop = (params as LandingParams | undefined)?.shop;
    this.shopNode = shop;
    let run = ctx.run!;
    const n = run.floorNum; // the floor just cleared (stairwell mode)

    // ---- arrival: floor mods expire, free catnap (GDD §7 ①) ------------
    // A shop NODE is mid-floor: nothing expires and nothing heals there —
    // the catnap is what the rest node and the stairwell are for.
    const healed = run.cats.map(() => 0);
    if (!shop) {
      const expired = run.cats.map((c) => expireFloorMods(c, run.level));
      const napped = catnapHeal(expired, run.level);
      run = { ...run, cats: napped.cats };
      napped.healed.forEach((h, i) => (healed[i] = h));
      ctx.run = run;
    }

    // ---- Peddler stock: one roll from the shop stream (loot.md §6) -----
    // Stairwell: `hash(runSeed, 'shop', floorJustCleared)` (§4 stream table).
    // Shop node: the node's own payload seed, so what the Peddler is holding
    // never depends on the order the party took its routes in.
    const shopRng = mulberry32(shop ? shop.seed : hash(run.runSeed, "shop", n));
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
      sceneBackdrop("scene:landing", DESIGN_W, DESIGN_H, { dim: 0.6 }),
      vignette(DESIGN_W, DESIGN_H, 0.8),
    );

    // ---- title zone ----------------------------------------------------
    const eyebrow = heading(
      shop ? `FLOOR ${n} · A STALL ON THE ROUTE` : `FLOOR ${n} CLEARED`,
      3,
      { center: true },
    );
    eyebrow.position.set(DESIGN_W / 2, EYEBROW_Y);
    const banner = heading(shop ? "THE PEDDLER" : "THE LANDING", 1, {
      center: true,
      fill: PAL.gold,
    });
    banner.position.set(DESIGN_W / 2, BANNER_Y);
    const sub = label(
      shop
        ? "Blanket down, wares out. He'll be gone by the time you look back."
        : "The stairwell is quiet. The way up has already collapsed.",
      { dim: true, center: true },
    );
    sub.position.set(DESIGN_W / 2, SUB_Y);
    view.addChild(eyebrow, banner, sub);

    // ---- the clowder (cat cards + catnap floaters) ---------------------
    const clowder = panel(LEFT_W, CLOWDER_H, { variant: "glass" });
    clowder.position.set(MARGIN, CONTENT_Y);
    view.addChild(clowder);
    const clowderTitle = heading("THE CLOWDER", 3);
    clowderTitle.position.set(SPACE.lg, SPACE.md + 2);
    clowder.addChild(clowderTitle);

    this.cards = [];
    this.fxLayer = new Container();
    const cardTop = 44;
    const cardH = 72;
    run.cats.forEach((_cat, i) => {
      const card = this.makeCatCard(
        run,
        i,
        SPACE.md,
        cardTop + i * cardH,
        LEFT_W - SPACE.md * 2,
      );
      clowder.addChild(card.view);
      this.cards.push(card);
    });
    view.addChild(this.fxLayer);
    healed.forEach((amount, i) => {
      if (amount > 0) {
        this.floatText(
          MARGIN + LEFT_W - 60,
          CONTENT_Y + cardTop + i * cardH + 24,
          `+${amount}`,
          PAL.heal,
          i * 150,
        );
      }
    });

    // ---- marching-order editor (③) ------------------------------------
    const march = panel(LEFT_W, MARCH_H, { variant: "glass" });
    march.position.set(MARGIN, MARCH_Y);
    view.addChild(march);
    // (front → back is carried by the rank numerals on the chips)
    const marchTitle = heading("MARCHING ORDER", 3);
    marchTitle.position.set(SPACE.lg, SPACE.md + 2);
    march.addChild(marchTitle);
    const marchHint = label("1-4 to swap", {
      dim: true,
      size: TYPE.tiny,
      mono: true,
    });
    marchHint.anchor.set(1, 0);
    marchHint.position.set(LEFT_W - SPACE.lg, SPACE.md + 4);
    march.addChild(marchHint);
    this.marchLayer = new Container();
    this.marchLayer.position.set(SPACE.md, 42);
    march.addChild(this.marchLayer);
    this.refreshMarch();

    // ---- the Peddler (②) ----------------------------------------------
    this.buildPeddler(view);

    // ---- action bar (④) ------------------------------------------------
    const sellBtn = button(
      "Sell to the Peddler",
      SLOT_W,
      BAR_H,
      () => this.toggleSell(true),
      { hotkey: "S" },
    );
    sellBtn.view.position.set(MARGIN, BAR_Y);
    view.addChild(sellBtn.view);

    // ── PROGRESSION SLOT — THE DEN (points / skills / gear) ─────────────
    const denBtn = button(
      `${DEN_LABEL} — Party`,
      SLOT_W,
      BAR_H,
      () => this.toggleDen(true),
      { hotkey: DEN_HOTKEY },
    );
    denBtn.view.position.set(MARGIN + SLOT_W + SPACE.lg, BAR_Y);
    view.addChild(denBtn.view);
    this.denBadgeHost = new Container();
    this.denBadgeHost.position.set(SLOT_W - 46, -8);
    denBtn.view.addChild(this.denBadgeHost);

    // Primary: back to the route (shop node) or down the stairs (stairwell).
    const goOn = shop ? () => this.backToMap() : () => this.descend();
    const canGo = shop !== undefined || n < FLOOR_COUNT;
    const primary = button(
      shop ? "Back to the route" : `Descend to Floor ${n + 1}`,
      DESCEND_W,
      BAR_H,
      goOn,
      { primary: true, hotkey: "Enter", disabled: !canGo },
    );
    primary.view.position.set(DESIGN_W - MARGIN - DESCEND_W, BAR_Y);
    view.addChild(primary.view);
    this.descendFn = canGo ? goOn : null;

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
    if (this.denBox) {
      return this.denPanel?.onKey(key) ?? false;
    }
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
    if (key === "s") {
      this.toggleSell(true);
      return true;
    }
    if (key === "p") {
      this.toggleDen(true);
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
    this.denPanel?.destroy();
    this.denPanel = null;
    this.denBox = null;
    this.denBadgeHost = null;
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
    w: number,
  ): CatCard {
    const cat = run.cats[catIndex];
    const cls = CLASSES[cat.classId];
    const dead = cat.lives <= 0;
    const h = 64;
    const viewC = new Container();
    viewC.position.set(x, y);
    viewC.addChild(panel(w, h, { variant: "solid", radius: RADIUS.button }));

    const face = avatar(cat.classId, 44, { dead });
    face.position.set(SPACE.md + 22, h / 2);
    viewC.addChild(face);

    const textX = SPACE.md + 52;
    const name = label(cls.catName, {
      bold: true,
      fill: dead ? PAL.textDim : catNameColor(cat.classId),
    });
    name.position.set(textX, SPACE.sm);
    viewC.addChild(name);

    const barW = w - textX - SPACE.md - 52;
    const hpBar = bar(barW, 10, { kind: "hp" });
    hpBar.view.position.set(textX, 28);
    viewC.addChild(hpBar.view);
    const hpText = label("", { mono: true, size: TYPE.tiny });
    hpText.anchor.set(1, 0);
    hpText.position.set(w - SPACE.md, 26);
    viewC.addChild(hpText);

    const paws = makePawRow(cat.lives);
    paws.view.position.set(textX, 46);
    viewC.addChild(paws.view);

    if (dead) {
      viewC.alpha = 0.4;
      const gone = label("GONE", { bold: true, fill: PAL.danger });
      gone.anchor.set(1, 0);
      gone.position.set(w - SPACE.md, SPACE.sm);
      viewC.addChild(gone);
    }

    const badgeHost = new Container();
    badgeHost.position.set(w - 62, 4);
    viewC.addChild(badgeHost);

    const card: CatCard = {
      view: viewC,
      catIndex,
      bar: hpBar,
      hpText,
      set(hp: number, max: number) {
        hpBar.set(hp, max);
        hpText.text = `${hp}/${max}`;
      },
      setPoints(n: number) {
        for (const c of badgeHost.removeChildren())
          c.destroy({ children: true });
        const badge = makePointBadgeAt(dead ? 0 : n, 0, 0);
        if (badge) badgeHost.addChild(badge);
      },
    };
    card.set(cat.hp, maxHp(cat, run.level));
    card.setPoints(unspentPoints(cat, run.level));
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
    const t = label(text, { mono: true, fill: color, center: true });
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
    const card = panel(PEDDLER_W, PEDDLER_H, {
      variant: "glass",
      accent: PAL.gold,
    });
    card.position.set(PEDDLER_X, CONTENT_Y);
    view.addChild(card);

    const eyebrow = heading("THE STAIRWELL MERCHANT", 3);
    eyebrow.position.set(SPACE.lg, SPACE.md);
    const title = heading("THE PEDDLER", 2, { fill: PAL.gold });
    title.position.set(SPACE.lg, SPACE.md + 20);
    const blurb = label(
      '"Mrrp. Everything is for sale. Especially the things I found."',
      { dim: true, size: TYPE.tiny, wrap: NPC_COL_W },
    );
    blurb.position.set(SPACE.lg, SPACE.md + 52);
    card.addChild(eyebrow, title, blurb);

    this.shiniesText = label("", {
      mono: true,
      fill: PAL.gold,
      size: TYPE.body,
    });
    this.shiniesText.anchor.set(1, 0);
    this.shiniesText.position.set(PEDDLER_W - SPACE.lg, SPACE.md + 4);
    card.addChild(this.shiniesText);

    // the merchant himself: painted `npc:peddler` first, procedural cat on
    // a cushion only when the sprite pack has not landed yet (fail-soft)
    const npc = new Container();
    const art = makeSpriteIcon("npc:peddler", 176);
    if (art) {
      npc.addChild(art);
    } else {
      const cushion = new Graphics()
        .ellipse(0, 52, 52, 14)
        .fill(PAL.stProvoked)
        .stroke({ width: 2, color: PAL.border });
      const catG = new Graphics();
      drawCat(catG, "bruiser", "sit", 0.9);
      catG.position.set(0, 48);
      const bindle = new Graphics()
        .moveTo(38, -52)
        .lineTo(62, -8)
        .stroke({ width: 3, color: CHEST_WOOD });
      bindle
        .circle(42, -54, 10)
        .fill(PAL.panelLite)
        .stroke({ width: 2, color: PAL.border });
      npc.addChild(cushion, catG, bindle);
    }
    npc.position.set(SPACE.lg + NPC_COL_W / 2, PEDDLER_H / 2 + 20);
    this.peddlerCat = npc;
    this.peddlerBaseY = npc.y;
    card.addChild(npc);

    this.stockLayer = new Container();
    this.stockLayer.position.set(SPACE.lg + NPC_COL_W + SPACE.lg, 56);
    card.addChild(this.stockLayer);
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
      card.setPoints(unspentPoints(cat, run.level));
    }
    if (this.denBadgeHost) {
      for (const c of this.denBadgeHost.removeChildren()) {
        c.destroy({ children: true });
      }
      const badge = makePointBadgeAt(totalUnspentPoints(run), 0, 0);
      if (badge) this.denBadgeHost.addChild(badge);
    }
    this.refreshStock();
    this.sellPanel?.refresh();
  }

  /* ---- THE DEN (progression panel) ------------------------------------ */

  private toggleDen(open: boolean): void {
    const view = this.view;
    const ctx = this.ctx;
    if (!view || !ctx) return;
    if (!open) {
      this.denPanel?.destroy();
      this.denPanel = null;
      this.denBox?.destroy({ children: true });
      this.denBox = null;
      this.refreshAll();
      return;
    }
    if (this.denBox) return;
    if (this.sellBox) this.toggleSell(false);
    const box = new Container();
    const back = scrim(DESIGN_W, DESIGN_H, 0.72);
    back.eventMode = "static";
    box.addChild(back);
    const den = makeDenBox({
      getRun: () => ctx.run!,
      setRun: (r) => {
        ctx.run = r;
      },
      // the cards behind the modal track HP/points as they change
      onChanged: () => this.refreshAll(),
      onClose: () => this.toggleDen(false),
    });
    box.addChild(den.view);
    view.addChild(box);
    this.denBox = box;
    this.denPanel = den;
  }

  private refreshStock(): void {
    const host = this.stockLayer;
    const stock = this.stock;
    const run = this.ctx?.run;
    if (!host || !stock || !run) return;
    for (const c of host.removeChildren()) c.destroy({ children: true });

    const rowW = PEDDLER_W - (SPACE.lg + NPC_COL_W + SPACE.lg) - SPACE.lg;
    let y = 0;

    stock.slots.forEach((slot, i) => {
      const isEquipSlot = slot.kind === "equip";
      const row = new Container();
      row.position.set(0, y);
      row.addChild(
        panel(rowW, ROW_H, {
          variant: "solid",
          radius: RADIUS.button,
          ...(isEquipSlot
            ? { accent: RARITY_COLOR[slot.item.rarity] }
            : { accent: PAL.energy }),
        }),
      );

      const artId =
        slot.kind === "consumable"
          ? `item:${slot.defId}`
          : itemSpriteId(slot.item);
      const artSize = 32;
      const art = makeSpriteIcon(artId, artSize);
      if (art) {
        art.position.set(SPACE.md + artSize / 2, ROW_H / 2);
        row.addChild(art);
      } else {
        const icon = label(
          slot.kind === "consumable"
            ? CONSUMABLES[slot.defId].icon
            : EQUIP_DEFS[slot.item.defId].icon,
          {
            mono: true,
            size: TYPE.h3,
            center: true,
            fill:
              slot.kind === "equip" ? RARITY_COLOR[slot.item.rarity] : PAL.text,
          },
        );
        icon.position.set(SPACE.md + artSize / 2, ROW_H / 2);
        row.addChild(icon);
      }

      const textX = SPACE.md + artSize + SPACE.md;
      const name = label(
        slot.kind === "consumable"
          ? CONSUMABLES[slot.defId].name
          : `${equipName(slot.item)} — ${slot.item.rarity} L${slot.item.itemLevel}`,
        {
          bold: true,
          fill:
            slot.kind === "equip" ? RARITY_COLOR[slot.item.rarity] : PAL.text,
        },
      );
      name.position.set(textX, slot.kind === "equip" ? 6 : ROW_H / 2 - 9);
      row.addChild(name);
      if (slot.kind === "equip") {
        const stats = label(equipStatsText(slot.item), {
          mono: true,
          dim: true,
          size: TYPE.tiny,
        });
        stats.position.set(textX, 26);
        row.addChild(stats);
      }

      if (slot.sold) {
        row.alpha = 0.45;
        const sold = label("SOLD", { mono: true, fill: PAL.danger });
        sold.anchor.set(1, 0.5);
        sold.position.set(rowW - SPACE.md, ROW_H / 2);
        row.addChild(sold);
      } else {
        const buyW = 72;
        const price = label(`${slot.price} ✦`, {
          mono: true,
          fill: PAL.gold,
          size: TYPE.body,
        });
        price.anchor.set(1, 0.5);
        price.position.set(rowW - buyW - SPACE.lg * 2, ROW_H / 2);
        row.addChild(price);
        const buy = button("Buy", buyW, 30, () => this.buy(i), {
          fontSize: TYPE.small,
          disabled: run.inventory.shinies < slot.price,
        });
        buy.view.position.set(rowW - buyW - SPACE.md, (ROW_H - 30) / 2);
        row.addChild(buy.view);
      }
      host.addChild(row);
      y += ROW_H + ROW_GAP;
    });

    // Warm Lap service row (once per landing)
    const row = new Container();
    row.position.set(0, y + SPACE.xs);
    row.addChild(
      panel(rowW, ROW_H, {
        variant: "solid",
        radius: RADIUS.button,
        accent: PAL.heal,
      }),
    );
    const lapLabel = label("Warm Lap — every living cat heals 40% of max HP", {
      bold: true,
    });
    lapLabel.position.set(SPACE.md, ROW_H / 2 - 9);
    row.addChild(lapLabel);
    if (stock.warmLapUsed) {
      const used = label("USED", { mono: true, dim: true });
      used.anchor.set(1, 0.5);
      used.position.set(rowW - SPACE.md, ROW_H / 2);
      row.addChild(used);
    } else {
      const buyW = 72;
      const price = label(`${stock.warmLapCost} ✦`, {
        mono: true,
        fill: PAL.gold,
        size: TYPE.body,
      });
      price.anchor.set(1, 0.5);
      price.position.set(rowW - buyW - SPACE.lg * 2, ROW_H / 2);
      row.addChild(price);
      const buy = button("Lap", buyW, 30, () => this.warmLap(), {
        fontSize: TYPE.small,
        disabled: run.inventory.shinies < stock.warmLapCost,
      });
      buy.view.position.set(rowW - buyW - SPACE.md, (ROW_H - 30) / 2);
      row.addChild(buy.view);
    }
    host.addChild(row);
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
        this.floatText(
          MARGIN + LEFT_W - 60,
          CONTENT_Y + 44 + i * 72 + 24,
          `+${hp - cat.hp}`,
          PAL.heal,
        );
      }
      return hp === cat.hp ? cat : { ...cat, hp };
    });
    ctx.run = { ...run, cats, inventory: r.inv };
    this.refreshAll();
  }

  /* ---- marching-order editor (③) -------------------------------------- */

  private refreshMarch(): void {
    const host = this.marchLayer;
    const run = this.ctx?.run;
    if (!host || !run) return;
    for (const c of host.removeChildren()) c.destroy({ children: true });

    const chipW = 68;
    const chipH = 78;
    const gap = SPACE.sm;
    run.marchingOrder.forEach((classId, i) => {
      const selected = this.marchSelected === i;
      const chip = new Container();
      chip.position.set(i * (chipW + gap), 0);
      chip.addChild(
        panel(chipW, chipH, {
          variant: selected ? "raised" : "solid",
          radius: RADIUS.button,
          ...(selected ? { accent: PAL.gold } : {}),
        }),
      );
      const face = avatar(classId, 40, {
        ...(selected ? { ring: PAL.gold } : {}),
      });
      face.position.set(chipW / 2, 30);
      chip.addChild(face);
      const rank = label(`${i + 1}`, {
        mono: true,
        fill: PAL.gold,
        size: TYPE.tiny,
      });
      rank.position.set(SPACE.xs, 2);
      chip.addChild(rank);
      const nm = label(CLASSES[classId].catName, {
        size: TYPE.tiny,
        center: true,
        fill: catNameColor(classId),
      });
      nm.position.set(chipW / 2, 60);
      chip.addChild(nm);

      chip.eventMode = "static";
      chip.cursor = "pointer";
      chip.on("pointertap", () => this.marchTap(i));
      host.addChild(chip);
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
    const back = scrim(DESIGN_W, DESIGN_H);
    back.eventMode = "static";
    box.addChild(back);
    // Sell mode has no cat cards down the right, so the default height —
    // sized for the manage-mode column — left the bottom half of the card
    // empty and pushed 'Done' outside the panel, floating over the stock
    // list behind it. Size the card to the 8×2 grid instead and seat the
    // button INSIDE it, the way the Den's Close sits inside the Den.
    const inv = makeInventoryPanel({
      mode: "sell",
      height: SELL_PANEL_H,
      getRun: () => ctx.run!,
      setRun: (r) => {
        ctx.run = r;
      },
      onChanged: () => this.refreshAll(),
    });
    const invX = (DESIGN_W - INVENTORY_PANEL_W) / 2;
    const invY = Math.round((DESIGN_H - SELL_PANEL_H) / 2);
    inv.view.position.set(invX, invY);
    box.addChild(inv.view);
    const close = button("Done", 200, 44, () => this.toggleSell(false), {
      primary: true,
      hotkey: "Esc",
    });
    close.view.position.set(
      invX + INVENTORY_PANEL_W - 200 - SPACE.lg,
      invY + SELL_PANEL_H - 44 - SPACE.lg,
    );
    box.addChild(close.view);
    view.addChild(box);
    this.sellBox = box;
    this.sellPanel = inv;
  }

  /* ---- Leaving ---------------------------------------------------------- */

  /** Shop node: nothing to bookkeep — the route is waiting where we left it. */
  private backToMap(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save(); // autosave: whatever was bought/sold at the stall
    ctx.scenes.goto("runMap");
  }

  private descend(): void {
    const ctx = this.ctx;
    if (!ctx || this.shopNode) return;
    const run = ctx.run!;
    if (run.floorNum >= FLOOR_COUNT) return;
    // Arrival already expired floor mods + applied the catnap (mount).
    // Remaining descend bookkeeping (core/run/runState.descend minus the
    // heal, which would double-apply — see contract notes). The next floor's
    // run map is nulled here and generated by FLOORGEN; traversal resets with
    // it (run-map-and-dm.md §2).
    ctx.run = {
      ...run,
      floorNum: run.floorNum + 1,
      score: { ...run.score, floorsReached: run.score.floorsReached + 1 },
      floorFiredEventIds: [],
      floorMap: null,
      currentNodeId: null,
      visitedNodeIds: [],
    };
    ctx.save(); // autosave point: landing descend
    ctx.scenes.goto("floorgen");
  }
}
