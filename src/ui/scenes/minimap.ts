/**
 * WP-10 (visual v3) — the floor map, at two scales.
 *
 * `view`    the docked map panel in the right-hand column: kit `panel`
 *           chrome, a floor-name / seed header, the whole floor's explored
 *           topology (rooms as filled shapes, corridors as thin ribbons),
 *           the icon vocabulary from `draw/mapIcons.ts`, the party marker
 *           with facing, and a rectangle showing the camera viewport.
 * `overlay` the full-screen [M] map: the same map scaled to fill a modal
 *           panel, room labels where they are known, and a legend.
 *
 * Knowledge rules are the engine's (dungeon.md §§10-11): unexplored tiles
 * simply are not drawn, chests/events show once their tile is explored,
 * packs show ONLY while currently visible — the map forgets monsters. This
 * module never mutates the floor.
 */
import { Container, Graphics } from "pixi.js";
import type { FloorState, Roamer } from "../../core/types.js";
import { PAL, THEMES, mix } from "../palette.js";
import { RADIUS } from "../layout.js";
import { heading, label, panel, scrim } from "../widgets.js";
import {
  collectMarks,
  drawMapIcon,
  drawMarks,
  drawTopology,
  makeLegend,
  type MapFacing,
} from "../draw/mapIcons.js";
import { EX, TILE } from "./exploreLayout.js";

const isPack = (e: FloorState["entities"][number]): e is Roamer =>
  e.kind === "roamer" || e.kind === "boss";

/** Rebuild signature for the (expensive) topology pass. */
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
  /** The docked map panel. Add to the `hud` layer. */
  view: Container;
  /** Full-screen [M] map (hidden by default). Add to the `modal` layer. */
  overlay: Container;
  readonly overlayOpen: boolean;
  /** Re-read the floor after a step. */
  refresh(): void;
  /** Per-frame party-marker pulse (visual only). */
  update(dtMs: number): void;
  toggleOverlay(): void;
  /** Which way the party last stepped — drives the marker's wedge. */
  setFacing(dir: MapFacing): void;
  /** Camera rect in WORLD pixels; drawn as the viewport rectangle. */
  setCamera(x: number, y: number, w: number, h: number): void;
  destroy(): void;
}

export interface MinimapInfo {
  floorNum: number;
  floorName: string;
  seed: string;
  themeIdx: number;
}

/** One map surface: background plate + topology + marks + party + camera. */
interface MapSurface {
  view: Container;
  cell: number;
  topo: Graphics;
  marks: Graphics;
  party: Graphics;
  cam: Graphics;
  labels: Container;
}

function makeSurface(
  f: FloorState,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  pad: number,
): MapSurface {
  const cell = Math.max(
    2,
    Math.min((rw - pad * 2) / f.w, (rh - pad * 2) / f.h),
  );
  const mw = f.w * cell;
  const mh = f.h * cell;

  const view = new Container();
  view.position.set(rx, ry);
  // the plate the floor is carved out of — dark rock, never a black hole
  const plate = new Graphics()
    .roundRect(0, 0, rw, rh, RADIUS.chip)
    .fill({ color: mix(PAL.bgDeep, PAL.void, 0.4), alpha: 0.95 })
    .stroke({ width: 1, color: PAL.border, alpha: 0.7 });
  // a faint tile grid over the unknown, so the plate reads as "map paper"
  for (let gx = 0; gx <= rw; gx += cell * 4) {
    plate.moveTo(gx, 0).lineTo(gx, rh);
  }
  for (let gy = 0; gy <= rh; gy += cell * 4) {
    plate.moveTo(0, gy).lineTo(rw, gy);
  }
  plate.stroke({ width: 1, color: PAL.border, alpha: 0.18 });
  view.addChild(plate);

  const inner = new Container();
  inner.position.set((rw - mw) / 2, (rh - mh) / 2);
  const topo = new Graphics();
  const marks = new Graphics();
  const party = new Graphics();
  const cam = new Graphics();
  const labels = new Container();
  inner.addChild(topo, cam, marks, party, labels);
  view.addChild(inner);

  return { view, cell, topo, marks, party, cam, labels };
}

/** Build the minimap + [M] overlay for one floor. */
export function makeMinimap(f: FloorState, info: MinimapInfo): Minimap {
  const th = THEMES[Math.max(0, Math.min(THEMES.length - 1, info.themeIdx))];

  /* ---- docked panel --------------------------------------------------- */

  const [px, py, pw, ph] = EX.minimap;
  const view = new Container();
  view.position.set(px, py);
  view.addChild(panel(pw, ph));

  const eyebrow = label(`FLOOR ${info.floorNum}`, {
    size: 11,
    mono: true,
    dim: true,
  });
  eyebrow.position.set(14, 10);
  const seedTxt = label(`seed ${info.seed}`, {
    size: 10,
    mono: true,
    dim: true,
  });
  seedTxt.anchor.set(1, 0);
  seedTxt.position.set(pw - 14, 11);
  const name = label(info.floorName.toUpperCase(), {
    size: 15,
    bold: true,
    fill: th.accent,
  });
  name.position.set(14, 26);
  const rule = new Graphics()
    .rect(14, 50, pw - 28, 1)
    .fill({ color: PAL.border, alpha: 0.8 });
  view.addChild(eyebrow, seedTxt, name, rule);

  const small = makeSurface(f, 10, 58, pw - 20, ph - 68, 4);
  view.addChild(small.view);

  /* ---- [M] overlay ---------------------------------------------------- */

  const overlay = new Container();
  overlay.visible = false;
  const veil = scrim(1280, 720, 0.74);
  veil.eventMode = "static"; // swallow world clicks under the map
  overlay.addChild(veil);

  const [bx, by, bw, bh] = EX.bigMap;
  const bigPanel = new Container();
  bigPanel.position.set(bx, by);
  bigPanel.addChild(panel(bw, bh, { variant: "raised", accent: th.accent }));

  const bigEyebrow = heading(`FLOOR ${info.floorNum} OF 6`, 3);
  bigEyebrow.position.set(28, 20);
  const bigTitle = heading(info.floorName.toUpperCase(), 2, {
    fill: PAL.gold,
  });
  bigTitle.position.set(28, 40);
  const bigSeed = label(`seed ${info.seed}`, {
    size: 12,
    mono: true,
    dim: true,
  });
  bigSeed.anchor.set(1, 0);
  bigSeed.position.set(bw - 28, 26);
  bigPanel.addChild(bigEyebrow, bigTitle, bigSeed);

  const bigMapY = 82;
  const legendH = 78;
  const big = makeSurface(
    f,
    24,
    bigMapY,
    bw - 48,
    bh - bigMapY - legendH - 20,
    10,
  );
  bigPanel.addChild(big.view);

  const legend = makeLegend({
    rowH: 22,
    icon: 12,
    text: 12,
    rows: 2,
    colW: 190,
  });
  legend.position.set(28, bh - legendH);
  const hint = label("[M] or [Esc] — back to the dungeon", {
    size: 12,
    dim: true,
  });
  hint.anchor.set(1, 0);
  hint.position.set(bw - 28, bh - legendH + 22);
  bigPanel.addChild(legend, hint);
  overlay.addChild(bigPanel);

  /* ---- state ---------------------------------------------------------- */

  let sig = "";
  let t = 0;
  let facing: MapFacing = "S";
  let camRect = { x: 0, y: 0, w: 0, h: 0 };

  const drawCamera = (s: MapSurface): void => {
    s.cam.clear();
    if (camRect.w <= 0 || camRect.h <= 0) return;
    const x = (camRect.x / TILE) * s.cell;
    const y = (camRect.y / TILE) * s.cell;
    const w = (camRect.w / TILE) * s.cell;
    const h = (camRect.h / TILE) * s.cell;
    s.cam
      .rect(x, y, w, h)
      .fill({ color: PAL.gold, alpha: 0.06 })
      .stroke({ width: 1, color: PAL.gold, alpha: 0.55 });
    // corner ticks read as a camera frame even when the rect clips the plate
    const t = Math.min(w, h) * 0.18;
    for (const [cx, cy, sx, sy] of [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ] as const) {
      s.cam
        .moveTo(cx + sx * t, cy)
        .lineTo(cx, cy)
        .lineTo(cx, cy + sy * t)
        .stroke({ width: 2, color: PAL.gold, alpha: 0.9 });
    }
  };

  const drawParty = (s: MapSurface): void => {
    s.party.clear();
    drawMapIcon(
      s.party,
      "party",
      (f.party.x + 0.5) * s.cell,
      (f.party.y + 0.5) * s.cell,
      Math.max(5, Math.min(s.cell * 1.1, 13)),
      facing,
    );
  };

  /** Entrance / stairs / lair captions on the big map, once known. */
  const drawRoomLabels = (): void => {
    big.labels.removeChildren().forEach((c) => c.destroy({ children: true }));
    const named: { roomId: number; text: string; color: number }[] = [];
    named.push({
      roomId: f.entranceRoomId,
      text: "Entrance",
      color: PAL.textDim,
    });
    named.push({ roomId: f.exitRoomId, text: "Stairs Down", color: PAL.heal });
    for (const e of f.entities) {
      if (isPack(e) && e.kind === "boss" && !e.dead) {
        named.push({ roomId: e.homeRoom, text: "The Lair", color: PAL.danger });
      }
    }
    for (const n of named) {
      const r = f.rooms[n.roomId];
      if (!r) continue;
      let seen = false;
      for (let y = r.y; y < r.y + r.h && !seen; y++) {
        for (let x = r.x; x < r.x + r.w && !seen; x++) {
          if (f.explored[y * f.w + x]) seen = true;
        }
      }
      if (!seen) continue;
      const t2 = label(n.text, { size: 11, bold: true, fill: n.color });
      t2.anchor.set(0.5, 1);
      t2.position.set((r.x + r.w / 2) * big.cell, r.y * big.cell - 2);
      big.labels.addChild(t2);
    }
  };

  const paintTopology = (): void => {
    drawTopology(small.topo, f, small.cell);
    if (overlay.visible) {
      drawTopology(big.topo, f, big.cell);
      drawRoomLabels();
    }
  };

  const refresh = (): void => {
    const next = signature(f);
    if (next !== sig) {
      sig = next;
      paintTopology();
    }
    const marks = collectMarks(f);
    drawMarks(small.marks, marks, small.cell);
    drawParty(small);
    drawCamera(small);
    if (overlay.visible) {
      drawMarks(big.marks, marks, big.cell);
      drawParty(big);
      drawCamera(big);
    }
  };
  refresh();

  return {
    view,
    overlay,
    get overlayOpen() {
      return overlay.visible;
    },
    refresh,
    setFacing(dir: MapFacing) {
      if (dir === facing) return;
      facing = dir;
      drawParty(small);
      if (overlay.visible) drawParty(big);
    },
    setCamera(x: number, y: number, w: number, h: number) {
      camRect = { x, y, w, h };
      drawCamera(small);
      if (overlay.visible) drawCamera(big);
    },
    update(dtMs: number) {
      t += dtMs;
      // 2 Hz breath on the party marker (dungeon.md §11) — visual only
      const pulse =
        0.6 + 0.4 * (0.5 + 0.5 * Math.sin((t / 1000) * Math.PI * 4));
      small.party.alpha = pulse;
      if (overlay.visible) big.party.alpha = pulse;
    },
    toggleOverlay() {
      overlay.visible = !overlay.visible;
      if (overlay.visible) {
        drawTopology(big.topo, f, big.cell);
        drawRoomLabels();
        const marks = collectMarks(f);
        drawMarks(big.marks, marks, big.cell);
        drawParty(big);
        drawCamera(big);
      }
    },
    destroy() {
      view.destroy({ children: true });
      overlay.destroy({ children: true });
    },
  };
}
