/**
 * WP-12 — shared party inventory UI (loot.md §8): the 16-slot grid with
 * per-cat equip/unequip + stat-delta preview and Sort in 'manage' mode,
 * sell-at-quarter-value in 'sell' mode (the landing), plus the
 * full-inventory pickup modal (Take → replace a slot / Leave it).
 *
 * Pure presentation: every mutation goes through core/loot APIs and is
 * written back via `setRun`. This file exports embeddable components — the
 * pause overlay (Party/Inventory tabs), the landing scene (sell) and the
 * loot overlay (pickup path) host them; overlay ids stay 'loot' | 'pause'
 * (ARCHITECTURE.md §3).
 */
import { Container, Graphics, Text } from "pixi.js";
import type {
  ConsumableStack,
  EquipInstance,
  InventorySlot,
  Rarity,
  RunState,
  StatKey,
} from "../../core/types";
import { CLASSES } from "../../content/classes";
import { CONSUMABLES } from "../../content/consumables";
import { EQUIP_DEFS } from "../../content/equipment";
import { CONSUMABLE_WEIGHTS } from "../../content/lootTables";
import {
  addEquip,
  canEquip,
  equipItem,
  isEquip,
  removeSlot,
  sortInventory,
  takeReplacing,
  unequipItem,
} from "../../core/loot/inventory";
import { sellFromInventory, sellValue } from "../../core/loot/shop";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W, RADIUS } from "../layout";
import { display, mono, ui } from "../textStyles";
import { makeButton, makePanel, makeTooltip } from "../widgets";
import { drawCatPortrait } from "../draw/cats";

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

const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  atk: "ATK",
  def: "DEF",
  spd: "SPD",
  crt: "CRT",
  enMax: "EN",
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
  const bg = new Graphics();
  const paint = (hover: boolean) => {
    bg.clear()
      .roundRect(0, 0, CELL, CELL, RADIUS.button)
      .fill(PAL.hpBack)
      .stroke({
        width: 2,
        color: o.selected ? PAL.gold : hover ? PAL.panelLite : PAL.border,
      });
  };
  paint(false);
  cell.addChild(bg);

  if (o.slot !== null) {
    const slot = o.slot;
    const icon = new Text({
      text: slotIcon(slot),
      style: mono(24, {
        fill: isEquip(slot) ? RARITY_COLOR[slot.rarity] : PAL.text,
      }),
    });
    icon.anchor.set(0.5);
    icon.position.set(CELL / 2, CELL / 2 - 4);
    cell.addChild(icon);
    const corner = new Text({
      text: isEquip(slot) ? `L${slot.itemLevel}` : `×${slot.count}`,
      style: mono(10, { fill: PAL.textDim }),
    });
    corner.anchor.set(1, 1);
    corner.position.set(CELL - 4, CELL - 2);
    cell.addChild(corner);

    let tip: Container | null = null;
    cell.eventMode = "static";
    cell.cursor = "pointer";
    cell.on("pointerover", () => {
      paint(true);
      tip = makeTooltip(slotTooltipText(slot, o.sellMode));
      tip.position.set(cell.x + 12, cell.y + CELL + 4);
      o.tipLayer.addChild(tip);
    });
    cell.on("pointerout", () => {
      paint(false);
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
  const W = opts.width ?? 960;
  const H = opts.height ?? 330;
  const view = new Container();
  view.addChild(makePanel(W, H));

  const title = new Text({
    text: opts.mode === "sell" ? "SELL — ¼ of buy value" : "INVENTORY",
    style: ui(16, { fontWeight: "bold" }),
  });
  title.position.set(16, 14);
  const shinies = new Text({ text: "", style: mono(14, { fill: PAL.gold }) });
  shinies.anchor.set(1, 0);
  shinies.position.set(W - 16, 16);
  view.addChild(title, shinies);

  const gridLayer = new Container();
  gridLayer.position.set(16, 48);
  const rightLayer = new Container();
  rightLayer.position.set(600, 44);
  const tipLayer = new Container();
  view.addChild(gridLayer, rightLayer, tipLayer);

  let selected: number | null = null;
  let destroyed = false;

  const sortBtn = makeButton(
    "Sort",
    72,
    26,
    () => {
      const run = opts.getRun();
      opts.setRun({
        ...run,
        inventory: sortInventory(run.inventory, CONSUMABLE_ORDER),
      });
      selected = null;
      opts.onChanged?.();
      refresh();
    },
    { fontSize: 13 },
  );
  sortBtn.view.position.set(W - 180, 12);
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

  function unequip(catIndex: number, slotName: "weapon" | "trinket"): void {
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

    const bg = new Graphics()
      .roundRect(0, 0, 344, 60, RADIUS.button)
      .fill(PAL.panel)
      .stroke({ width: 2, color: eligible ? PAL.gold : PAL.border });
    row.addChild(bg);

    const face = new Graphics();
    drawCatPortrait(face, cat.classId, dead);
    face.scale.set(0.8);
    face.position.set(26, 30);
    row.addChild(face);

    const name = new Text({
      text: cls.catName,
      style: ui(13, { fontWeight: "bold", fill: PAL[cat.classId].body }),
    });
    name.position.set(52, 8);
    row.addChild(name);

    if (eligible && selEquip) {
      const slotName = EQUIP_DEFS[selEquip.defId].slot;
      const delta = new Text({
        text: statDeltaText(selEquip, cat[slotName]),
        style: mono(10, { fill: PAL.energy }),
      });
      delta.position.set(52, 28);
      row.addChild(delta);
    }

    // gear chips: weapon / trinket
    (["weapon", "trinket"] as const).forEach((slotName, i) => {
      const item = cat[slotName];
      const chip = new Container();
      chip.position.set(232 + i * 52, 8);
      const cbg = new Graphics()
        .roundRect(0, 0, 44, 44, RADIUS.button)
        .fill(PAL.hpBack)
        .stroke({ width: 1, color: PAL.border });
      chip.addChild(cbg);
      if (item) {
        const icon = new Text({
          text: EQUIP_DEFS[item.defId].icon,
          style: mono(18, { fill: RARITY_COLOR[item.rarity] }),
        });
        icon.anchor.set(0.5);
        icon.position.set(22, 22);
        chip.addChild(icon);
        if (!dead) {
          let tip: Container | null = null;
          chip.eventMode = "static";
          chip.cursor = "pointer";
          chip.on("pointerover", () => {
            tip = makeTooltip(
              `${slotTooltipText(item, false)}\n(click to unequip)`,
            );
            tip.position.set(rightLayer.x + 200, rightLayer.y + y + 52);
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
        const ph = new Text({
          text: slotName === "weapon" ? "W" : "T",
          style: mono(12, { fill: PAL.textDim }),
        });
        ph.anchor.set(0.5);
        ph.position.set(22, 22);
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
        rightLayer.addChild(makeCatRow(run, i, i * 66));
      });
    } else {
      const hint = new Text({
        text: "Click an item to sell one.\nThe Peddler pays a quarter\nof buy value, minimum 1 ✦.",
        style: ui(13, { fill: PAL.textDim, lineHeight: 20 }),
      });
      hint.position.set(8, 8);
      rightLayer.addChild(hint);
    }
  }

  refresh();

  return {
    view,
    refresh,
    onKey(key: string): boolean {
      if (opts.mode === "manage" && key === "s") {
        const run = opts.getRun();
        opts.setRun({
          ...run,
          inventory: sortInventory(run.inventory, CONSUMABLE_ORDER),
        });
        selected = null;
        opts.onChanged?.();
        refresh();
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
  const scrim = new Graphics()
    .rect(0, 0, DESIGN_W, DESIGN_H)
    .fill({ color: PAL.scrim, alpha: 0.6 });
  scrim.eventMode = "static"; // swallow clicks under the modal
  view.addChild(scrim);

  const PW = 660;
  const PH = 420;
  const px = (DESIGN_W - PW) / 2;
  const py = (DESIGN_H - PH) / 2;
  const panel = new Container();
  panel.position.set(px, py);
  panel.addChild(makePanel(PW, PH));
  view.addChild(panel);

  const title = new Text({
    text: "BACKPACK FULL!",
    style: display(22, { fill: PAL.gold }),
  });
  title.anchor.set(0.5, 0);
  title.position.set(PW / 2, 16);
  panel.addChild(title);

  const inc = opts.incoming;
  const incIcon = new Text({
    text: slotIcon(inc),
    style: mono(22, {
      fill: isEquip(inc) ? RARITY_COLOR[inc.rarity] : PAL.text,
    }),
  });
  incIcon.position.set(24, 56);
  const incName = new Text({
    text: isEquip(inc)
      ? `${equipName(inc)} — ${inc.rarity} L${inc.itemLevel}   ${equipStatsText(inc)}`
      : `${CONSUMABLES[inc.defId].name} ×${inc.count}`,
    style: ui(15),
  });
  incName.position.set(56, 60);
  const hint = new Text({
    text: "Pick a slot to replace — the old item is left behind — or leave it.",
    style: ui(13, { fill: PAL.textDim }),
  });
  hint.position.set(24, 86);
  panel.addChild(incIcon, incName, hint);

  const tipLayer = new Container();
  const gridLayer = new Container();
  gridLayer.position.set(48, 116);
  panel.addChild(gridLayer, tipLayer);

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

  const leave = makeButton("[Esc] Leave it", 180, 36, () =>
    finish(false, null),
  );
  leave.view.position.set(PW / 2 - 90, PH - 52);
  panel.addChild(leave.view);

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
