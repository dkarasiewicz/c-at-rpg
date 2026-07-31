/**
 * WP-12 — shared party inventory UI (loot.md §8, progression.md §4): the
 * 16-slot grid with per-cat equip/unequip + stat-delta preview and Sort in
 * 'manage' mode, sell-at-quarter-value in 'sell' mode (the landing), plus
 * the full-inventory pickup modal (Take → replace a slot / Leave it).
 *
 * Pure presentation: every mutation goes through core/loot APIs and is
 * written back via `setRun`. This file exports embeddable components — the
 * pause overlay (Party/Inventory tabs), the landing scene (sell) and the
 * loot overlay (pickup path) host them; overlay ids stay 'loot' | 'pause'
 * (ARCHITECTURE.md §3).
 *
 * Chrome is the shared kit (widgets.ts): `panel` for the frame, every cell
 * and every cat card, `avatar()` for cat faces (painted-first — never a
 * flat vector portrait next to painted art), `makeSpriteIcon` for item art,
 * `heading`/`label` type and the one `button` language.
 */
import { Container, Graphics } from "pixi.js";
import type {
  ClassId,
  ConsumableStack,
  EquipInstance,
  EquipSlot,
  InventorySlot,
  Rarity,
  RunState,
  StatKey,
} from "../../core/types.js";
import { EQUIP_SLOTS } from "../../core/types.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { CONSUMABLE_WEIGHTS } from "../../content/lootTables.js";
import {
  addEquip,
  canEquip,
  equipItem,
  isEquip,
  removeSlot,
  sortInventory,
  takeReplacing,
  unequipItem,
} from "../../core/loot/inventory.js";
import { sellFromInventory, sellValue } from "../../core/loot/shop.js";
import { PAL, mix } from "../palette.js";
import { DESIGN_H, DESIGN_W, RADIUS, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  avatar,
  button,
  heading,
  label,
  makeSpriteIcon,
  makeTooltip,
  panel,
  scrim,
} from "../widgets.js";

/* ---------------------------------------------------------------------- */
/* Shared item-presentation helpers (also used by the loot overlay)        */
/* ---------------------------------------------------------------------- */

/** Rarity → text/icon color (PAL only — the violet is the Frazzled fill). */
export const RARITY_COLOR: Record<Rarity, number> = {
  stray: PAL.textDim,
  sleek: PAL.text,
  pedigree: PAL.gold,
  mewthical: PAL.stFrazzled,
};

/**
 * Readable name color for a cat: the class body color lifted toward
 * PAL.text, because two of the four cats (soot-black Pixel, dusk Mora) are
 * darker than the panel fill and vanish when their raw body color is used
 * as type. Shared by every screen that prints a cat's name on a panel.
 */
export function catNameColor(classId: ClassId): number {
  return mix(PAL[classId].body, PAL.text, 0.4);
}

const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  atk: "ATK",
  def: "DEF",
  spd: "SPD",
  crt: "CRT",
  enMax: "EN",
};

/** Empty-slot placeholder glyph per equip slot. */
const SLOT_GLYPH: Record<EquipSlot, string> = {
  weapon: "W",
  trinket: "T",
  collar: "C",
};

/** Display name — Mewthical uniques show their hand-authored unique name. */
export function equipName(item: EquipInstance): string {
  const def = EQUIP_DEFS[item.defId];
  return item.rarity === "mewthical" && def.uniqueName
    ? def.uniqueName
    : def.name;
}

/** "ATK +3  SPD +1" — the item's fully-resolved stat lines. */
export function equipStatsText(item: EquipInstance): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(item.stats) as [StatKey, number][]) {
    parts.push(`${STAT_LABEL[k]} ${v >= 0 ? "+" : ""}${v}`);
  }
  return parts.join("  ");
}

/** Stat-delta preview vs the currently equipped piece in the same slot. */
export function statDeltaText(
  incoming: EquipInstance,
  current: EquipInstance | null,
): string {
  const keys = new Set<StatKey>([
    ...(Object.keys(incoming.stats) as StatKey[]),
    ...(current ? (Object.keys(current.stats) as StatKey[]) : []),
  ]);
  const parts: string[] = [];
  for (const k of keys) {
    const d = (incoming.stats[k] ?? 0) - (current?.stats[k] ?? 0);
    if (d !== 0) parts.push(`${STAT_LABEL[k]} ${d > 0 ? "+" : ""}${d}`);
  }
  return parts.length > 0 ? parts.join("  ") : "no change";
}

function slotIcon(slot: EquipInstance | ConsumableStack): string {
  return isEquip(slot)
    ? EQUIP_DEFS[slot.defId].icon
    : CONSUMABLES[slot.defId].icon;
}

/**
 * Generated-icon manifest id for an inventory slot: consumables map to
 * 'item:<defId>', equipment to 'equip:<defId>' — except Mewthical uniques,
 * which carry their own hand-drawn 'equip:<uniqueId>' art (loot.md §5:
 * uniques ARE the def's Mewthical drop). Shared with the loot overlay,
 * landing shop and explore HUD belt.
 */
export function itemSpriteId(slot: EquipInstance | ConsumableStack): string {
  if (isEquip(slot)) {
    const def = EQUIP_DEFS[slot.defId];
    const art =
      slot.rarity === "mewthical" && def.uniqueId ? def.uniqueId : slot.defId;
    return `equip:${art}`;
  }
  return `item:${slot.defId}`;
}

function slotTooltipText(
  slot: EquipInstance | ConsumableStack,
  sellMode: boolean,
): string {
  if (isEquip(slot)) {
    const lines = [
      `${equipName(slot)} — ${slot.rarity} L${slot.itemLevel}`,
      equipStatsText(slot),
    ];
    if (slot.hook) {
      lines.push(
        `Mewthical hook: ${slot.hook}${slot.hookSpent ? " (spent)" : ""}`,
      );
    }
    if (sellMode) lines.push(`Sell: ${sellValue(slot)} ✦`);
    return lines.join("\n");
  }
  const def = CONSUMABLES[slot.defId];
  const lines = [`${def.name} ×${slot.count}`, def.battleSkill.desc];
  if (sellMode) lines.push(`Sell: ${sellValue(slot.defId)} ✦ each`);
  return lines.join("\n");
}

/** §7 table order for the Sort button (loot.md §8). */
const CONSUMABLE_ORDER = CONSUMABLE_WEIGHTS.map((c) => c.id);

/* ---------------------------------------------------------------------- */
/* One grid cell                                                           */
/* ---------------------------------------------------------------------- */

const CELL = 64;
const GAP = 6;
const COLS = 8;

/** Selection / hover / rarity ring — the one outline language for cells. */
function cellRing(size: number, color: number, alpha = 1): Graphics {
  return new Graphics()
    .roundRect(1, 1, size - 2, size - 2, RADIUS.button)
    .stroke({ width: 2, color, alpha });
}

interface CellOpts {
  index: number;
  slot: InventorySlot;
  selected: boolean;
  sellMode: boolean;
  tipLayer: Container;
  onTap: (index: number) => void;
}

function makeCell(o: CellOpts): Container {
  const cell = new Container();
  cell.position.set(
    (o.index % COLS) * (CELL + GAP),
    Math.floor(o.index / COLS) * (CELL + GAP),
  );
  cell.addChild(panel(CELL, CELL, { variant: "solid", radius: RADIUS.button }));

  const hoverRing = cellRing(CELL, PAL.gold, 0.55);
  hoverRing.visible = false;
  cell.addChild(hoverRing);
  if (o.selected) cell.addChild(cellRing(CELL, PAL.gold));

  if (o.slot !== null) {
    const slot = o.slot;
    const art = makeSpriteIcon(itemSpriteId(slot), CELL - 10);
    if (art) {
      art.position.set(CELL / 2, CELL / 2);
      cell.addChild(art);
      if (isEquip(slot)) {
        // the glyph's fill used to carry rarity — keep it as an inner ring
        cell.addChild(cellRing(CELL, RARITY_COLOR[slot.rarity], 0.9));
      }
    } else {
      const icon = label(slotIcon(slot), {
        mono: true,
        size: TYPE.h2,
        center: true,
        fill: isEquip(slot) ? RARITY_COLOR[slot.rarity] : PAL.text,
      });
      icon.position.set(CELL / 2, CELL / 2 - 4);
      cell.addChild(icon);
    }
    const corner = label(
      isEquip(slot) ? `L${slot.itemLevel}` : `×${slot.count}`,
      {
        mono: true,
        dim: true,
        size: TYPE.tiny,
      },
    );
    corner.anchor.set(1, 1);
    corner.position.set(CELL - 5, CELL - 3);
    cell.addChild(corner);

    let tip: Container | null = null;
    cell.eventMode = "static";
    cell.cursor = "pointer";
    cell.on("pointerover", () => {
      hoverRing.visible = true;
      tip = makeTooltip(slotTooltipText(slot, o.sellMode));
      tip.position.set(cell.x + 12, cell.y + CELL + 4);
      o.tipLayer.addChild(tip);
    });
    cell.on("pointerout", () => {
      hoverRing.visible = false;
      tip?.destroy({ children: true });
      tip = null;
    });
    cell.on("pointertap", () => {
      tip?.destroy({ children: true });
      tip = null;
      o.onTap(o.index);
    });
  }
  return cell;
}

/* ---------------------------------------------------------------------- */
/* The embeddable inventory panel                                          */
/* ---------------------------------------------------------------------- */

export type InventoryPanelMode = "manage" | "sell";

export interface InventoryPanelOpts {
  mode: InventoryPanelMode;
  getRun(): RunState;
  setRun(run: RunState): void;
  /** Fired after every successful mutation (HUD counters, autosave, …). */
  onChanged?(): void;
  toast?(text: string): void;
  width?: number;
  height?: number;
}

export interface InventoryPanelApi {
  view: Container;
  /** Re-read the run and repaint everything. */
  refresh(): void;
  /** 's' sorts in manage mode. Returns true when consumed. */
  onKey(key: string): boolean;
  destroy(): void;
}

/* ---- panel + cat-card geometry ---------------------------------------- */
/** Default panel box: the 8×2 grid column beside four cat cards. */
const PANEL_W = 960;
const PANEL_H = 316;

/** Default panel size — hosts lay their own chrome out against these. */
export const INVENTORY_PANEL_W = PANEL_W;
export const INVENTORY_PANEL_H = PANEL_H;
const CARD_W = 344;
const CARD_H = 60;
const CARD_GAP = 6;
const CHIP = 40;

/**
 * Build the 16-slot inventory panel (default 960×330). Manage mode: click
 * an equipment piece → eligible cats light up with a stat-delta preview →
 * click a cat to equip (the replaced piece returns to the freed slot);
 * click an equipped chip to unequip. Sell mode: click any item to sell one
 * unit / the piece at `floor(buy/4)` (loot.md §6).
 */
export function makeInventoryPanel(
  opts: InventoryPanelOpts,
): InventoryPanelApi {
  const W = opts.width ?? PANEL_W;
  const H = opts.height ?? PANEL_H;
  const view = new Container();
  view.addChild(panel(W, H, { variant: "raised" }));

  const title = heading(
    opts.mode === "sell" ? "SELL — ¼ OF BUY VALUE" : "INVENTORY",
    3,
  );
  title.position.set(SPACE.lg, SPACE.lg);
  const shinies = label("", { mono: true, fill: PAL.gold, size: TYPE.body });
  shinies.anchor.set(1, 0);
  shinies.position.set(W - SPACE.lg, SPACE.md + 2);
  view.addChild(title, shinies);

  const gridLayer = new Container();
  gridLayer.position.set(SPACE.lg, 48);
  const rightLayer = new Container();
  rightLayer.position.set(W - SPACE.lg - CARD_W, 44);
  const tipLayer = new Container();
  view.addChild(gridLayer, rightLayer, tipLayer);

  // one standing instruction under the grid, so the empty half of the
  // backpack never reads as dead space
  const gridHint = label(
    "Click a piece of gear, then a cat to equip it.\nClick a worn item to take it off.",
    { dim: true, size: TYPE.tiny },
  );
  gridHint.style.lineHeight = 18;
  gridHint.position.set(SPACE.lg, 48 + 2 * (CELL + GAP) + SPACE.md);
  view.addChild(gridHint);

  let selected: number | null = null;
  let destroyed = false;

  const doSort = (): void => {
    const run = opts.getRun();
    opts.setRun({
      ...run,
      inventory: sortInventory(run.inventory, CONSUMABLE_ORDER),
    });
    selected = null;
    opts.onChanged?.();
    refresh();
  };

  const sortBtn = button("Sort", 96, 30, doSort, {
    hotkey: "S",
    fontSize: TYPE.small,
  });
  sortBtn.view.position.set(W - SPACE.lg - CARD_W - 96 - SPACE.lg, SPACE.md);
  sortBtn.view.visible = opts.mode === "manage";
  view.addChild(sortBtn.view);

  function sell(index: number): void {
    const run = opts.getRun();
    const { inv, gained } = sellFromInventory(run.inventory, index, 1);
    if (gained <= 0) return;
    opts.setRun({
      ...run,
      inventory: inv,
      score: {
        ...run.score,
        shiniesCollected: run.score.shiniesCollected + gained,
      },
    });
    opts.toast?.(`+${gained} ✦`);
    opts.onChanged?.();
    refresh();
  }

  function onCellTap(index: number): void {
    const run = opts.getRun();
    const slot = run.inventory.slots[index];
    if (slot === null) {
      selected = null;
      refresh();
      return;
    }
    if (opts.mode === "sell") {
      sell(index);
      return;
    }
    if (isEquip(slot)) {
      selected = selected === index ? null : index;
      refresh();
    }
  }

  function equipSelected(catIndex: number): void {
    if (selected === null) return;
    const run = opts.getRun();
    const item = run.inventory.slots[selected];
    if (item === null || !isEquip(item)) {
      selected = null;
      refresh();
      return;
    }
    const cat = run.cats[catIndex];
    if (cat.lives <= 0 || !canEquip(cat, item)) return;
    const { inv } = removeSlot(run.inventory, selected);
    const r = equipItem(cat, item);
    let inv2 = inv;
    if (r.replaced) inv2 = addEquip(inv2, r.replaced).inv; // freed slot takes it
    const cats = run.cats.slice();
    cats[catIndex] = r.cat;
    selected = null;
    opts.setRun({ ...run, cats, inventory: inv2 });
    opts.onChanged?.();
    refresh();
  }

  function unequip(catIndex: number, slotName: EquipSlot): void {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    if (!cat[slotName]) return;
    if (!run.inventory.slots.includes(null)) {
      opts.toast?.("Backpack full — no room to unequip");
      return;
    }
    const r = unequipItem(cat, slotName);
    const inv = addEquip(run.inventory, r.removed!).inv;
    const cats = run.cats.slice();
    cats[catIndex] = r.cat;
    opts.setRun({ ...run, cats, inventory: inv });
    opts.onChanged?.();
    refresh();
  }

  function makeCatRow(run: RunState, catIndex: number, y: number): Container {
    const cat = run.cats[catIndex];
    const cls = CLASSES[cat.classId];
    const row = new Container();
    row.position.set(0, y);
    const dead = cat.lives <= 0;

    const sel = selected !== null ? run.inventory.slots[selected] : null;
    const selEquip = sel !== null && isEquip(sel) ? sel : null;
    const eligible = !dead && selEquip !== null && canEquip(cat, selEquip);

    row.addChild(
      panel(CARD_W, CARD_H, {
        variant: "solid",
        radius: RADIUS.button,
        ...(eligible ? { accent: PAL.gold } : {}),
      }),
    );

    const face = avatar(cat.classId, 36, { dead });
    face.position.set(SPACE.lg + 6, CARD_H / 2);
    row.addChild(face);

    const name = label(cls.catName, {
      bold: true,
      fill: dead ? PAL.textDim : catNameColor(cat.classId),
    });
    name.position.set(52, 8);
    row.addChild(name);

    if (eligible && selEquip) {
      const slotName = EQUIP_DEFS[selEquip.defId].slot;
      const delta = label(statDeltaText(selEquip, cat[slotName] ?? null), {
        mono: true,
        size: TYPE.tiny,
        fill: PAL.energy,
      });
      delta.position.set(52, 30);
      row.addChild(delta);
    }

    // gear chips: weapon / trinket / collar (progression.md §4 slot order)
    const chipsW = EQUIP_SLOTS.length * CHIP + (EQUIP_SLOTS.length - 1) * 6;
    const chipX0 = CARD_W - SPACE.md - chipsW;
    EQUIP_SLOTS.forEach((slotName, i) => {
      const item = cat[slotName] ?? null;
      const chip = new Container();
      chip.position.set(chipX0 + i * (CHIP + 6), (CARD_H - CHIP) / 2);
      chip.addChild(
        panel(CHIP, CHIP, { variant: "glass", radius: RADIUS.button }),
      );
      if (item) {
        const art = makeSpriteIcon(itemSpriteId(item), CHIP - 6);
        if (art) {
          art.position.set(CHIP / 2, CHIP / 2);
          chip.addChild(art, cellRing(CHIP, RARITY_COLOR[item.rarity], 0.9));
        } else {
          const icon = label(EQUIP_DEFS[item.defId].icon, {
            mono: true,
            size: TYPE.h3,
            center: true,
            fill: RARITY_COLOR[item.rarity],
          });
          icon.position.set(CHIP / 2, CHIP / 2);
          chip.addChild(icon);
        }
        if (!dead) {
          let tip: Container | null = null;
          chip.eventMode = "static";
          chip.cursor = "pointer";
          chip.on("pointerover", () => {
            tip = makeTooltip(
              `${slotTooltipText(item, false)}\n(click to unequip)`,
            );
            tip.position.set(rightLayer.x + 180, rightLayer.y + y + CARD_H);
            tipLayer.addChild(tip);
            view.addChild(tipLayer); // keep tips on top
          });
          chip.on("pointerout", () => {
            tip?.destroy({ children: true });
            tip = null;
          });
          chip.on("pointertap", () => {
            tip?.destroy({ children: true });
            tip = null;
            unequip(catIndex, slotName);
          });
        }
      } else {
        const ph = label(SLOT_GLYPH[slotName], {
          mono: true,
          dim: true,
          size: TYPE.small,
          center: true,
        });
        ph.position.set(CHIP / 2, CHIP / 2);
        chip.addChild(ph);
      }
      row.addChild(chip);
    });

    if (dead) row.alpha = 0.35;
    else if (eligible) {
      row.eventMode = "static";
      row.cursor = "pointer";
      row.on("pointertap", () => equipSelected(catIndex));
    }
    return row;
  }

  function refresh(): void {
    if (destroyed) return;
    const run = opts.getRun();
    shinies.text = `${run.inventory.shinies} ✦`;

    for (const c of gridLayer.removeChildren()) c.destroy({ children: true });
    for (const c of tipLayer.removeChildren()) c.destroy({ children: true });
    run.inventory.slots.forEach((slot, i) => {
      gridLayer.addChild(
        makeCell({
          index: i,
          slot,
          selected: selected === i,
          sellMode: opts.mode === "sell",
          tipLayer,
          onTap: onCellTap,
        }),
      );
    });

    for (const c of rightLayer.removeChildren()) c.destroy({ children: true });
    if (opts.mode === "manage") {
      run.cats.forEach((_cat, i) => {
        rightLayer.addChild(makeCatRow(run, i, i * (CARD_H + CARD_GAP)));
      });
    } else {
      const hint = label(
        "Click an item to sell one.\nThe Peddler pays a quarter\nof buy value, minimum 1 ✦.",
        { dim: true, wrap: CARD_W - SPACE.md },
      );
      hint.style.lineHeight = 20;
      hint.position.set(SPACE.sm, SPACE.sm);
      rightLayer.addChild(hint);
    }
    gridHint.visible = opts.mode === "manage";
  }

  refresh();

  return {
    view,
    refresh,
    onKey(key: string): boolean {
      if (opts.mode === "manage" && key === "s") {
        doSort();
        return true;
      }
      return false;
    },
    destroy(): void {
      destroyed = true;
      view.destroy({ children: true });
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Full-inventory pickup modal (loot.md §8)                                */
/* ---------------------------------------------------------------------- */

export interface PickupModalOpts {
  incoming: EquipInstance | ConsumableStack;
  getRun(): RunState;
  setRun(run: RunState): void;
  /**
   * Called once when resolved. `dropped` is the replaced slot content on
   * Take (v1: the way up collapses — dropped items are simply left behind,
   * the dungeon layer has no ground-item entity), null on Leave it.
   */
  onDone(taken: boolean, dropped: InventorySlot): void;
}

export interface PickupModal {
  view: Container;
  onKey(key: string): boolean;
  destroy(): void;
}

/**
 * "Backpack full!" — the new item vs the 16-slot grid. Click a slot to
 * replace its content (loot.md §8 Take path) or press Leave It / Esc.
 */
export function makePickupModal(opts: PickupModalOpts): PickupModal {
  const view = new Container();
  const back = scrim(DESIGN_W, DESIGN_H);
  back.eventMode = "static"; // swallow clicks under the modal
  view.addChild(back);

  const PW = 660;
  const PH = 420;
  const px = (DESIGN_W - PW) / 2;
  const py = (DESIGN_H - PH) / 2;
  const card = new Container();
  card.position.set(px, py);
  card.addChild(panel(PW, PH, { variant: "raised", accent: PAL.danger }));
  view.addChild(card);

  const eyebrow = heading("NO ROOM IN THE BACKPACK", 3, { center: true });
  eyebrow.position.set(PW / 2, SPACE.md);
  const title = heading("BACKPACK FULL!", 2, {
    center: true,
    fill: PAL.gold,
  });
  title.position.set(PW / 2, SPACE.md + 22);
  card.addChild(eyebrow, title);

  const inc = opts.incoming;
  const incArt = makeSpriteIcon(itemSpriteId(inc), 34);
  if (incArt) {
    incArt.position.set(SPACE.xl + 17, 90);
    card.addChild(incArt);
  } else {
    const incIcon = label(slotIcon(inc), {
      mono: true,
      size: TYPE.h2,
      center: true,
      fill: isEquip(inc) ? RARITY_COLOR[inc.rarity] : PAL.text,
    });
    incIcon.position.set(SPACE.xl + 17, 90);
    card.addChild(incIcon);
  }
  const incName = label(
    isEquip(inc)
      ? `${equipName(inc)} — ${inc.rarity} L${inc.itemLevel}   ${equipStatsText(inc)}`
      : `${CONSUMABLES[inc.defId].name} ×${inc.count}`,
    { size: TYPE.body, bold: true },
  );
  incName.position.set(SPACE.xl + 44, 82);
  const hint = label(
    "Pick a slot to replace — the old item is left behind — or leave it.",
    { dim: true },
  );
  hint.position.set(SPACE.xl, 110);
  card.addChild(incName, hint);

  const tipLayer = new Container();
  const gridLayer = new Container();
  gridLayer.position.set((PW - (COLS * CELL + (COLS - 1) * GAP)) / 2, 148);
  card.addChild(gridLayer, tipLayer);

  let done = false;
  const finish = (taken: boolean, dropped: InventorySlot) => {
    if (done) return;
    done = true;
    opts.onDone(taken, dropped);
  };

  const run = opts.getRun();
  run.inventory.slots.forEach((slot, i) => {
    gridLayer.addChild(
      makeCell({
        index: i,
        slot,
        selected: false,
        sellMode: false,
        tipLayer,
        onTap: (index) => {
          const cur = opts.getRun();
          const { inv, dropped } = takeReplacing(
            cur.inventory,
            index,
            opts.incoming,
          );
          opts.setRun({ ...cur, inventory: inv });
          finish(true, dropped);
        },
      }),
    );
  });

  const leave = button("Leave it", 200, 44, () => finish(false, null), {
    hotkey: "Esc",
  });
  leave.view.position.set(PW / 2 - 100, PH - 44 - SPACE.lg);
  card.addChild(leave.view);

  return {
    view,
    onKey(key: string): boolean {
      if (key === "esc" || key === "l") {
        finish(false, null);
        return true;
      }
      return true; // modal is exclusive while open
    },
    destroy(): void {
      view.destroy({ children: true });
    },
  };
}
