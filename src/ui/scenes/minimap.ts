/**
 * WP-10 — minimap (dungeon.md §11, ui-art §7): 4 px/tile map inside the
 * top-right HUD panel, drawn once into a cached texture and rebuilt only
 * when the explored set (or a chest/event state) changes; the party dot is
 * a separate pulsing sprite. `M` toggles a centered large-map overlay
 * (same renderer at 12 px/tile on a scrim).
 *
 * Element table (dungeon.md §11): unseen transparent; explored
 * wall/floor/door in the fixed map greys; stairs-down green; chest gold
 * (opened: grey); event violet; roamers/boss red squares — VISIBLE ONLY
 * (the minimap forgets them, §10); party = pulsing white dot.
 */
import { Container, Graphics, Text } from "pixi.js";
import { Tile } from "../../core/types";
import type { FloorState, Roamer } from "../../core/types";
import { CHEST_WOOD, PAL } from "../palette";
import { R, rh, rw, rx, ry } from "../layout";
import { mono } from "../textStyles";
import { makePanel } from "../widgets";

/** Map terrain greys, verbatim from the dungeon.md §11 rendering table. */
const MM = { wall: 0x2a2a33, floor: 0x55555f, door: 0x7a7a66 } as const;
/** Event square violet (dungeon.md §11; = the Frazzled violet). */
const MM_EVENT = PAL.stFrazzled;

const isPack = (e: FloorState["entities"][number]): e is Roamer =>
  e.kind === "roamer" || e.kind === "boss";

const tileIdx = (f: FloorState, x: number, y: number): number => y * f.w + x;

/** Terrain + static entities (chests/events/stairs) at `cell` px/tile. */
function drawStatic(g: Graphics, f: FloorState, cell: number): void {
  g.clear();
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = tileIdx(f, x, y);
      if (!f.explored[i]) continue; // unseen = transparent
      const t = f.tiles[i];
      let color: number = MM.floor;
      if (t === Tile.Wall) color = MM.wall;
      else if (t === Tile.Door) color = MM.door;
      else if (t === Tile.StairsDown) color = PAL.heal;
      g.rect(x * cell, y * cell, cell, cell).fill(color);
      if (t === Tile.StairsUp) {
        // dim marker on the spawn stair (scenery)
        g.rect(
          x * cell + cell / 4,
          y * cell + cell / 4,
          cell / 2,
          cell / 2,
        ).fill(PAL.textDim);
      }
    }
  }
  for (const e of f.entities) {
    if (!f.explored[tileIdx(f, e.x, e.y)]) continue;
    if (e.kind === "chest") {
      g.rect(e.x * cell, e.y * cell, cell, cell).fill(
        e.opened ? PAL.textDim : CHEST_WOOD,
      );
    } else if (e.kind === "event" && !e.used) {
      g.rect(e.x * cell, e.y * cell, cell, cell).fill(MM_EVENT);
    }
  }
}

/** Roamer/boss red squares — only while their tile is currently visible. */
function drawPacks(g: Graphics, f: FloorState, cell: number): void {
  g.clear();
  for (const e of f.entities) {
    if (!isPack(e) || e.dead) continue;
    if (!f.visible.has(tileIdx(f, e.x, e.y))) continue;
    const big = e.kind === "boss" ? cell : 0; // boss: large red square
    g.rect(
      e.x * cell - big / 2,
      e.y * cell - big / 2,
      cell + big,
      cell + big,
    ).fill(PAL.danger);
  }
}

/** Static-map rebuild signature: explored count + entity state ticks. */
function signature(f: FloorState): string {
  let explored = 0;
  for (let i = 0; i < f.explored.length; i++) explored += f.explored[i];
  let opened = 0;
  let used = 0;
  for (const e of f.entities) {
    if (e.kind === "chest" && e.opened) opened++;
    if (e.kind === "event" && e.used) used++;
  }
  return `${explored}|${opened}|${used}`;
}

export interface Minimap {
  /** The HUD panel (positioned at R.explore.minimap). Add to the hud layer. */
  view: Container;
  /** Full-screen `M` overlay (hidden by default). Add to the modal layer. */
  overlay: Container;
  readonly overlayOpen: boolean;
  /** Re-read the floor after a step; rebuilds the cached map only on change. */
  refresh(): void;
  /** Per-frame party-dot pulse (visual only). */
  update(dtMs: number): void;
  toggleOverlay(): void;
  destroy(): void;
}

const PANEL_CELL = 4; // dungeon.md §11: 4 px per tile
const OVERLAY_CELL = 12; // ui-art §7: large map at 12 px/tile

/** Build the minimap component for one floor. */
export function makeMinimap(f: FloorState): Minimap {
  /* ---- panel ---------------------------------------------------------- */
  const view = new Container();
  view.position.set(rx(R.explore.minimap), ry(R.explore.minimap));
  view.addChild(makePanel(rw(R.explore.minimap), rh(R.explore.minimap)));

  const map = new Container();
  const mapW = f.w * PANEL_CELL;
  const mapH = f.h * PANEL_CELL;
  // center inside the panel; scale down only if it would not fit
  const fit = Math.min(
    1,
    (rw(R.explore.minimap) - 8) / mapW,
    (rh(R.explore.minimap) - 8) / mapH,
  );
  map.scale.set(fit);
  map.position.set(
    (rw(R.explore.minimap) - mapW * fit) / 2,
    (rh(R.explore.minimap) - mapH * fit) / 2,
  );
  view.addChild(map);

  const staticG = new Graphics();
  const staticWrap = new Container();
  staticWrap.addChild(staticG);
  const packsG = new Graphics();
  const partyDot = new Graphics()
    .rect(0, 0, PANEL_CELL, PANEL_CELL)
    .fill(PAL.text);
  map.addChild(staticWrap, packsG, partyDot);

  /* ---- overlay -------------------------------------------------------- */
  const overlay = new Container();
  overlay.visible = false;
  const scrim = new Graphics()
    .rect(0, 0, 1280, 720)
    .fill({ color: PAL.scrim, alpha: 0.6 });
  scrim.eventMode = "static"; // swallow world clicks under the map
  const bigWrap = new Container();
  const bigG = new Graphics();
  const bigParty = new Graphics();
  bigWrap.addChild(bigG, bigParty);
  const bigFit = Math.min(
    1,
    1120 / (f.w * OVERLAY_CELL),
    600 / (f.h * OVERLAY_CELL),
  );
  bigWrap.scale.set(bigFit);
  bigWrap.position.set(
    (1280 - f.w * OVERLAY_CELL * bigFit) / 2,
    (720 - f.h * OVERLAY_CELL * bigFit) / 2,
  );
  const hint = new Text({
    text: "M — close map",
    style: mono(11, { fill: PAL.textDim }),
  });
  hint.anchor.set(0.5, 1);
  hint.position.set(640, 706);
  overlay.addChild(scrim, bigWrap, hint);

  /* ---- state ---------------------------------------------------------- */
  let sig = "";
  let cached = false;
  let t = 0;

  const rebuildStatic = (): void => {
    drawStatic(staticG, f, PANEL_CELL);
    if (cached) staticWrap.updateCacheTexture();
    else {
      staticWrap.cacheAsTexture(true); // the "RenderTexture" minimap
      cached = true;
    }
  };

  const drawOverlay = (): void => {
    drawStatic(bigG, f, OVERLAY_CELL);
    drawPacks(bigG, f, OVERLAY_CELL);
    bigParty
      .clear()
      .rect(f.party.x * OVERLAY_CELL, f.party.y * OVERLAY_CELL, 8, 8)
      .fill(PAL.text);
  };

  const refresh = (): void => {
    const next = signature(f);
    if (next !== sig) {
      sig = next;
      rebuildStatic();
    }
    drawPacks(packsG, f, PANEL_CELL);
    partyDot.position.set(f.party.x * PANEL_CELL, f.party.y * PANEL_CELL);
    if (overlay.visible) drawOverlay();
  };
  refresh();

  return {
    view,
    overlay,
    get overlayOpen() {
      return overlay.visible;
    },
    refresh,
    update(dtMs: number) {
      t += dtMs;
      // 2 Hz blink (dungeon.md §11 / ui-art §7) — visual only
      const pulse =
        0.45 + 0.55 * (0.5 + 0.5 * Math.sin((t / 1000) * Math.PI * 4));
      partyDot.alpha = pulse;
      if (overlay.visible) bigParty.alpha = pulse;
    },
    toggleOverlay() {
      overlay.visible = !overlay.visible;
      if (overlay.visible) drawOverlay();
    },
    destroy() {
      if (cached) staticWrap.cacheAsTexture(false);
      view.destroy({ children: true });
      overlay.destroy({ children: true });
    },
  };
}
