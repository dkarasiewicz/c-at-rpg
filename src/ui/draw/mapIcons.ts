/**
 * WP-10 (visual v3) — the shared cartography vocabulary.
 *
 * ONE renderer draws the floor's explored topology and ONE icon set marks
 * everything on it, so the docked minimap and the full-screen [M] map are the
 * same map at two scales — a player never has to relearn a symbol.
 *
 * Reading rules (dungeon.md §§10-11 knowledge states are respected by the
 * caller, which only ever passes tiles/entities the party actually knows):
 *   • rooms   — filled cells, brighter than corridors, with a hairline rim
 *   • corridors — a thin centered ribbon, so the topology reads as plumbing
 *   • walls   — the dark body the rooms are carved out of (explored only)
 *   • icons   — semantic PAL colors: stairs heal-green, chests gold, events
 *     Frazzled-violet, threats danger-red, the party warm gold with a facing
 *     wedge. Nothing here invents a color.
 *
 * Pure presentation: everything takes a `FloorState` and draws; no mutation,
 * no gameplay decisions.
 */
import { Container, Graphics } from "pixi.js";
import { Tile } from "../../core/types.js";
import type { FloorState, Roamer } from "../../core/types.js";
import { CHEST_WOOD, PAL, mix } from "../palette.js";
import { label } from "../widgets.js";

/* ---------------------------------------------------------------------- */
/* Terrain palette                                                         */
/* ---------------------------------------------------------------------- */

/**
 * Map terrain tones. The dungeon.md §11 greys, pushed apart so a room reads
 * as a shape at 7px/tile instead of a uniform smear.
 */
export const MAP = {
  wall: mix(PAL.bgDeep, PAL.void, 0.45),
  wallRim: mix(PAL.border, PAL.void, 0.45),
  room: mix(PAL.border, PAL.text, 0.28),
  roomRim: mix(PAL.border, PAL.text, 0.55),
  corridor: mix(PAL.border, PAL.text, 0.16),
  door: PAL.goldDark,
} as const;

export type MapIconKind =
  "stairs" | "chest" | "chestOpen" | "event" | "enemy" | "boss" | "party";

/** Facing of the party marker's wedge. */
export type MapFacing = "N" | "E" | "S" | "W";

const FACING_ROT: Record<MapFacing, number> = {
  N: -Math.PI / 2,
  E: 0,
  S: Math.PI / 2,
  W: Math.PI,
};

const isPack = (e: FloorState["entities"][number]): e is Roamer =>
  e.kind === "roamer" || e.kind === "boss";

const tileIdx = (f: FloorState, x: number, y: number): number => y * f.w + x;

/* ---------------------------------------------------------------------- */
/* Topology                                                                */
/* ---------------------------------------------------------------------- */

/** Bitmask of "this tile lies inside a room rect" for the whole floor. */
function roomMask(f: FloorState): Uint8Array {
  const mask = new Uint8Array(f.w * f.h);
  for (const r of f.rooms) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x >= 0 && y >= 0 && x < f.w && y < f.h) mask[tileIdx(f, x, y)] = 1;
      }
    }
  }
  return mask;
}

/**
 * Draw the explored topology at `cell` px per tile into `g` (which is
 * cleared first). Unexplored tiles stay transparent — the panel behind shows
 * through, so the known world reads as an island of light on dark chrome.
 */
export function drawTopology(g: Graphics, f: FloorState, cell: number): void {
  g.clear();
  const inRoom = roomMask(f);
  const thin = Math.max(1, Math.round(cell * 0.52));
  const pad = (cell - thin) / 2;

  // 1. the dark rock body: every explored wall
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = tileIdx(f, x, y);
      if (!f.explored[i] || f.tiles[i] !== Tile.Wall) continue;
      g.rect(x * cell, y * cell, cell, cell);
    }
  }
  g.fill(MAP.wall);

  // 2. rooms — full cells
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = tileIdx(f, x, y);
      if (!f.explored[i] || f.tiles[i] === Tile.Wall) continue;
      if (!inRoom[i]) continue;
      g.rect(x * cell, y * cell, cell, cell);
    }
  }
  g.fill(MAP.room);

  /** Known and walkable — the ribbon only bridges to tiles like this. */
  const walkable = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return false;
    const i = tileIdx(f, x, y);
    return f.explored[i] === 1 && f.tiles[i] !== Tile.Wall;
  };

  // 3. corridors — a thin ribbon, extended half a cell toward every walkable
  //    neighbour so a passage draws as one continuous line, not a dotted one
  const half = cell / 2;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = tileIdx(f, x, y);
      if (!f.explored[i] || f.tiles[i] === Tile.Wall || inRoom[i]) continue;
      const px = x * cell;
      const py = y * cell;
      g.rect(px + pad, py + pad, thin, thin);
      if (walkable(x, y - 1)) g.rect(px + pad, py, thin, half);
      if (walkable(x, y + 1)) g.rect(px + pad, py + half, thin, half);
      if (walkable(x - 1, y)) g.rect(px, py + pad, half, thin);
      if (walkable(x + 1, y)) g.rect(px + half, py + pad, half, thin);
    }
  }
  g.fill(MAP.corridor);

  // 4. doors — a bright stud on the ribbon so junctions are countable
  const stud = Math.max(1, thin * 0.62);
  const spad = (cell - stud) / 2;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = tileIdx(f, x, y);
      if (!f.explored[i] || f.tiles[i] !== Tile.Door) continue;
      g.rect(x * cell + spad, y * cell + spad, stud, stud);
    }
  }
  g.fill(MAP.door);

  // 5. room rims — only for rooms the party has actually seen into
  for (const r of f.rooms) {
    let seen = false;
    for (let y = r.y; y < r.y + r.h && !seen; y++) {
      for (let x = r.x; x < r.x + r.w && !seen; x++) {
        if (f.explored[tileIdx(f, x, y)]) seen = true;
      }
    }
    if (!seen) continue;
    g.rect(r.x * cell, r.y * cell, r.w * cell, r.h * cell).stroke({
      width: 1,
      color: MAP.roomRim,
      alpha: 0.7,
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Icons                                                                   */
/* ---------------------------------------------------------------------- */

/**
 * One map symbol, centered on (cx, cy) and sized to fit a `s`×`s` box.
 * `facing` only matters for the party marker.
 */
export function drawMapIcon(
  g: Graphics,
  kind: MapIconKind,
  cx: number,
  cy: number,
  s: number,
  facing: MapFacing = "S",
): void {
  const r = Math.max(2, s / 2);
  const ink = PAL.void;
  switch (kind) {
    case "stairs": {
      // downward chevron in a soft halo — the floor's goal, always loudest
      g.circle(cx, cy, r * 1.5).fill({ color: PAL.heal, alpha: 0.22 });
      g.moveTo(cx - r, cy - r * 0.8)
        .lineTo(cx + r, cy - r * 0.8)
        .lineTo(cx, cy + r)
        .closePath()
        .fill(PAL.heal)
        .stroke({ width: 1, color: ink, alpha: 0.8 });
      break;
    }
    case "chest": {
      g.roundRect(cx - r, cy - r * 0.78, r * 2, r * 1.56, r * 0.35)
        .fill(CHEST_WOOD)
        .stroke({ width: 1, color: ink, alpha: 0.85 });
      g.rect(cx - r, cy - r * 0.2, r * 2, Math.max(1, r * 0.34)).fill(PAL.gold);
      break;
    }
    case "chestOpen": {
      g.roundRect(cx - r, cy - r * 0.78, r * 2, r * 1.56, r * 0.35).stroke({
        width: 1,
        color: PAL.textDim,
      });
      break;
    }
    case "event": {
      g.circle(cx, cy, r).fill(PAL.stFrazzled).stroke({
        width: 1,
        color: ink,
        alpha: 0.85,
      });
      g.circle(cx, cy, Math.max(0.8, r * 0.32)).fill(PAL.text);
      break;
    }
    case "enemy": {
      g.moveTo(cx, cy - r)
        .lineTo(cx + r, cy + r * 0.8)
        .lineTo(cx - r, cy + r * 0.8)
        .closePath()
        .fill(PAL.danger)
        .stroke({ width: 1, color: ink, alpha: 0.85 });
      break;
    }
    case "boss": {
      g.circle(cx, cy, r * 1.6).fill({ color: PAL.danger, alpha: 0.24 });
      g.moveTo(cx, cy - r * 1.25)
        .lineTo(cx + r * 1.25, cy + r)
        .lineTo(cx - r * 1.25, cy + r)
        .closePath()
        .fill(PAL.danger)
        .stroke({ width: 1, color: PAL.eliteRing });
      break;
    }
    case "party": {
      const a = FACING_ROT[facing];
      const nose = {
        x: cx + Math.cos(a) * r * 1.9,
        y: cy + Math.sin(a) * r * 1.9,
      };
      const l = {
        x: cx + Math.cos(a + 2.4) * r * 1.25,
        y: cy + Math.sin(a + 2.4) * r * 1.25,
      };
      const rr = {
        x: cx + Math.cos(a - 2.4) * r * 1.25,
        y: cy + Math.sin(a - 2.4) * r * 1.25,
      };
      g.circle(cx, cy, r * 2.3).fill({ color: PAL.gold, alpha: 0.18 });
      g.moveTo(nose.x, nose.y)
        .lineTo(l.x, l.y)
        .lineTo(cx, cy)
        .lineTo(rr.x, rr.y)
        .closePath()
        .fill(PAL.text)
        .stroke({ width: 1, color: PAL.goldDark });
      break;
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Entity pass                                                             */
/* ---------------------------------------------------------------------- */

export interface MapMark {
  kind: MapIconKind;
  x: number;
  y: number;
}

/**
 * Every icon the party is entitled to see: chests/events once their tile is
 * explored, packs ONLY while currently visible (dungeon.md §10 — the map
 * forgets monsters), plus the stairs down once found.
 */
export function collectMarks(f: FloorState): MapMark[] {
  const out: MapMark[] = [];
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = tileIdx(f, x, y);
      if (f.explored[i] && f.tiles[i] === Tile.StairsDown) {
        out.push({ kind: "stairs", x, y });
      }
    }
  }
  for (const e of f.entities) {
    const known = f.explored[tileIdx(f, e.x, e.y)] === 1;
    if (e.kind === "chest") {
      if (known)
        out.push({ kind: e.opened ? "chestOpen" : "chest", x: e.x, y: e.y });
    } else if (e.kind === "event") {
      if (known && !e.used) out.push({ kind: "event", x: e.x, y: e.y });
    } else if (isPack(e) && !e.dead) {
      if (f.visible.has(tileIdx(f, e.x, e.y))) {
        out.push({
          kind: e.kind === "boss" ? "boss" : "enemy",
          x: e.x,
          y: e.y,
        });
      }
    }
  }
  return out;
}

/** Draw `marks` at `cell` px/tile into a cleared Graphics. */
export function drawMarks(
  g: Graphics,
  marks: readonly MapMark[],
  cell: number,
): void {
  g.clear();
  // icons scale with the map but stop growing once they are comfortably
  // legible — at 20 px/tile a chest must not become a crate
  const s = Math.max(4, Math.min(cell * 1.15, 14));
  for (const m of marks) {
    drawMapIcon(g, m.kind, (m.x + 0.5) * cell, (m.y + 0.5) * cell, s);
  }
}

/* ---------------------------------------------------------------------- */
/* Legend                                                                  */
/* ---------------------------------------------------------------------- */

export const LEGEND: readonly { kind: MapIconKind; text: string }[] = [
  { kind: "party", text: "The clowder" },
  { kind: "stairs", text: "Stairs down" },
  { kind: "chest", text: "Chest" },
  { kind: "event", text: "Something odd" },
  { kind: "enemy", text: "Prowling pack" },
  { kind: "boss", text: "Lair" },
];

export interface LegendOpts {
  /** Row pitch in px. */
  rowH?: number;
  /** Icon box size. */
  icon?: number;
  /** Caption size. */
  text?: number;
  /** Rows before wrapping into the next column (default: all in one). */
  rows?: number;
  /** Column pitch when wrapping. */
  colW?: number;
}

/**
 * The legend: one icon + caption per row, wrapping into columns after
 * `rows` entries. Origin is the top-left of the first row.
 */
export function makeLegend(opts: LegendOpts = {}): Container {
  const rowH = opts.rowH ?? 20;
  const icon = opts.icon ?? 11;
  const textSize = opts.text ?? 11;
  const rows = opts.rows ?? LEGEND.length;
  const colW = opts.colW ?? 150;

  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  LEGEND.forEach((entry, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const cx = col * colW + icon;
    const cy = row * rowH + rowH / 2;
    drawMapIcon(g, entry.kind, cx, cy, icon * 0.9);
    const t = label(entry.text, { size: textSize, dim: true });
    t.position.set(cx + icon * 1.3, cy - textSize * 0.72);
    view.addChild(t);
  });
  view.eventMode = "none";
  return view;
}
