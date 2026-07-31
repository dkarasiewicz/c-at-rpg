/**
 * WP-10 (run map) — THE floor screen (docs/design/run-map-and-dm.md §2).
 *
 * Replaces the tile crawl: a floor is a painted route map, not a maze. The
 * party stands on one node, 2-3 inked routes lead onward, and picking one IS
 * the gameplay — "walking from A to B is not gameplay; *choosing* B is".
 *
 * What this scene owns:
 *  · the painted per-floor backdrop (`scene:map:<floor>`, fail-soft),
 *  · one illustrated medallion per node (`node:<type>` + the `node:visited` /
 *    `node:locked` state overlays, procedural pewter medallions when the art
 *    pack is absent — the game is fully playable with ZERO generated assets),
 *  · the inked route lines, with taken / live / open / closed states, so the
 *    branches the party sealed off are visibly sealed (the regret is the point),
 *  · the party marker, which physically walks the chosen edge,
 *  · the party strip (portraits, HP, Lives, shinies, the consumable belt).
 *
 * What it does NOT own: any gameplay outcome. Traversal goes through
 * `core/map/traverse` (`optionsForRun` / `advance`, which throws on an illegal
 * move), encounters come from `core/map/encounter`, healing from
 * `core/run/runState`. The scene renders state and dispatches nodes to scenes.
 *
 * ── NODE → SCENE (the flow) ─────────────────────────────────────────────
 *   fight · elite · boss → BATTLE   (pack from the node's payload seed)
 *   event                → EVENT    (eventSeed = the node's payload seed)
 *   shop                 → LANDING  in Peddler-only mode
 *   rest                 → in-scene catnap panel (core `catnapHeal`)
 *   treasure             → the LOOT overlay on a `rollChest` of the node seed
 * Every one of them comes back here; the terminal node, once cleared, opens
 * the way down (LANDING on floors 1-5, RESULTS after the floor-6 boss).
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type {
  ClassId,
  ItemId,
  MapNode,
  NodeType,
  RunState,
} from "../../core/types.js";
import { mulberry32 } from "../../core/rng.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { ENEMIES } from "../../content/enemies.js";
import { encounterFor, encounterIndexOf } from "../../core/map/encounter.js";
import {
  advance,
  atTerminal,
  closedNodes,
  optionsForRun,
} from "../../core/map/traverse.js";
import {
  FLOOR_COUNT,
  catnapHeal,
  floorConfig,
  generateCurrentFloorMap,
} from "../../core/run/runState.js";
import { maxHp } from "../../core/run/party.js";
import { isStack, removeConsumable } from "../../core/loot/inventory.js";
import { rollChest, type LootCtx } from "../../core/loot/roll.js";
import { CHEST_WOOD, PAL, THEMES, mix } from "../palette.js";
import {
  DESIGN_H,
  DESIGN_W,
  SPACE,
  rh,
  rw,
  rx,
  ry,
  type Rect,
} from "../layout.js";
import { TYPE, display, mono } from "../textStyles.js";
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
import { drawChest, drawStairs } from "../draw/glyphs.js";
import { catNameColor } from "../overlays/inventoryPanel.js";
import { spriteTextureFor } from "../sprites.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";
import type { LootOverlayParams } from "../overlays/loot.js";
import type { BattleSceneParams } from "./battle.js";
import type { EventSceneParams } from "./event.js";
import type { LandingParams } from "./landing.js";

/**
 * Additive, optional extension of the §2.9 RunState (same pattern as
 * `runState.ts`'s `customParty`): which nodes have already been HANDED to
 * their scene. `visitedNodeIds` cannot answer that on its own — the node the
 * party is standing on is visited the instant it arrives, both before its
 * encounter runs and after it comes back from the battle scene. It rides
 * along with the save (serializeRun spreads the run), so Continue never
 * re-fights the node the player already cleared.
 *
 * The record is stamped with its floor: node ids restart at 0 on every floor,
 * so a stale set from the floor above would silently skip encounters. A
 * mismatched floor simply reads as "nothing resolved yet".
 */
declare module "../../core/types" {
  interface RunState {
    /** Nodes already dispatched to their scene, scoped to one floor. */
    resolvedNodes?: { floor: number; ids: number[] };
  }
}

/** Mount params (all optional — the scene reads its state from the run). */
export interface RunMapParams {
  /** Which scene handed control back (debug/telemetry only). */
  from?: string;
}

/* ---------------------------------------------------------------------- */
/* Geometry (1280×720 design px, [x, y, w, h] like ui/layout.ts)           */
/* ---------------------------------------------------------------------- */

const RM = {
  /** Top rail: floor name, seed, key hints. */
  header: [16, 12, 1248, 34] as Rect,
  /** The graph board — node centres are laid out inside this rect. */
  board: [76, 92, 1128, 452] as Rect,
  /** Bottom party bar (full bleed). */
  strip: [0, 628, 1280, 92] as Rect,
  /** The four cat cards inside the strip. */
  cards: [
    [16, 638, 244, 74],
    [270, 638, 244, 74],
    [524, 638, 244, 74],
    [778, 638, 244, 74],
  ] as Rect[],
  /** Shinies chip (right end of the strip). */
  goldChip: [1036, 638, 228, 30] as Rect,
  /** Consumable belt under the shinies chip. */
  belt: [1036, 672, 228, 34] as Rect,
  /** Prompt band under the board ("pick a route" / "the way down is open"). */
  prompt: [340, 556, 600, 56] as Rect,
  /** Toast, centred over the board. */
  toast: [390, 500, 500, 40] as Rect,
} as const;

/** Medallion radii. */
const R_NODE = 33;
const R_BOSS = 42;

/** How long the party takes to walk one edge. */
const TRAVEL_MS = 560;

/** How far above a medallion's rim the party marker floats. */
const MARKER_LIFT = 28;

/** Theme band for a floor number (floors 1-2 / 3-4 / 5-6). */
const themeIndex = (floorNum: number): number =>
  Math.min(THEMES.length - 1, Math.floor((floorNum - 1) / 2));

/** Accent colour of a node type — the medallion's inner wash + route tint. */
const NODE_TINT: Record<NodeType, number> = {
  fight: mix(PAL.danger, PAL.panel, 0.45),
  elite: PAL.gold,
  event: PAL.stFrazzled,
  shop: PAL.energy,
  rest: PAL.heal,
  treasure: CHEST_WOOD,
  boss: PAL.danger,
};

/** Medallion caption (also the tooltip title). */
const NODE_NAME: Record<NodeType, string> = {
  fight: "Fight",
  elite: "Elite",
  event: "Unknown",
  shop: "The Peddler",
  rest: "Catnap",
  treasure: "Treasure",
  boss: "Boss",
};

/** What the party KNOWS about a node before walking into it. */
const NODE_BLURB: Record<NodeType, string> = {
  fight: "Something is prowling this stretch. A normal pack, a normal scrap.",
  elite: "Big shapes, bad smell. Hits harder — and drops better.",
  event: "Nobody can tell what's down there. Could be a gift. Could be a bill.",
  shop: "The Peddler set up shop. Shinies in, kit out.",
  rest: "A warm spot to curl up. Every living cat mends a little.",
  treasure: "Something glitters. Unattended, apparently.",
  boss: "The thing this floor belongs to. No running from it.",
};

/* ---------------------------------------------------------------------- */
/* Small pure helpers                                                      */
/* ---------------------------------------------------------------------- */

/**
 * Deterministic ±1 wobble from a node's payload seed. Presentation only —
 * it perturbs pixels, never gameplay, and never touches an `Rng`.
 */
const wobble = (seed: number, salt: number): number => {
  const h = (Math.imul(seed ^ salt, 0x9e3779b1) >>> 8) & 0xffff;
  return h / 0x8000 - 1;
};

interface Curve {
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
}

/** Point on a cubic bezier at t (the party walks this). */
function bezier(c: Curve, t: number): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.x1 + b * c.c1x + d * c.c2x + e * c.x2,
    y: a * c.y1 + b * c.c1y + d * c.c2y + e * c.y2,
  };
}

type EdgeState = "taken" | "live" | "open" | "closed";

interface EdgeView {
  from: number;
  to: number;
  curve: Curve;
  g: Graphics;
  motes: Graphics;
  state: EdgeState;
}

interface NodeView {
  node: MapNode;
  view: Container;
  art: Container;
  /** `node:visited` / `node:locked` overlay sprites (or procedural stand-ins). */
  visitedMark: Container;
  lockedMark: Container;
  /** Gold selection ring drawn around a legal next node. */
  ring: Graphics;
  hotkey: Container;
  /** The node's type, spelled out under the medallion. */
  caption: Text;
  r: number;
  x: number;
  y: number;
}

/* ---------------------------------------------------------------------- */
/* The scene                                                               */
/* ---------------------------------------------------------------------- */

export class RunMapScene implements Scene {
  private ctx!: GameCtx;
  private mounted = false;
  private t = 0;

  // layer-owned containers
  private bgC = new Container();
  private worldC = new Container();
  private hudC = new Container();
  private modalC = new Container();

  // board
  private edgesC = new Container();
  private nodesC = new Container();
  private partyC = new Container();
  private nodeViews: NodeView[] = [];
  private edgeViews: EdgeView[] = [];

  // hud
  private cards: {
    catIndex: number;
    view: Container;
    hp: ValueBar;
    hpText: Text;
    paws: { view: Container; set(n: number): void };
  }[] = [];
  private shiniesText: Text | null = null;
  private beltC = new Container();
  private promptC = new Container();
  private toastC: Container | null = null;
  private toastMs = 0;
  private tooltip: Container | null = null;
  /** What Enter does when the party is standing on the terminal node. */
  private enterFn: (() => void) | null = null;

  // interaction
  private options: MapNode[] = [];
  private selected = 0;
  private busy = false;
  private restBox: Container | null = null;

  /* ------------------------------ lifecycle ---------------------------- */

  mount(root: Container, ctx: GameCtx): void {
    this.ctx = ctx;
    if (!ctx.run) throw new Error("runMap: mounted without a run");
    // defensive: a run that somehow arrived without a generated map (a hand
    // built ctx, a dev hook) gets one rather than a blank screen.
    if (!ctx.run.floorMap) ctx.run = generateCurrentFloorMap(ctx.run);
    this.mounted = true;
    this.t = 0;
    this.busy = false;

    const run = ctx.run;
    const floorNum = run.floorNum;

    this.bgC = new Container();
    this.worldC = new Container();
    this.hudC = new Container();
    this.modalC = new Container();
    layer(root, "bg").addChild(this.bgC);
    layer(root, "world").addChild(this.worldC);
    layer(root, "hud").addChild(this.hudC);
    layer(root, "modal").addChild(this.modalC);

    // ---- backdrop: the painted floor map, palette wash when absent ------
    this.bgC.addChild(
      sceneBackdrop(`scene:map:${floorNum}`, DESIGN_W, DESIGN_H, { dim: 0.42 }),
      vignette(DESIGN_W, DESIGN_H, 0.85),
    );

    // ---- the graph ------------------------------------------------------
    this.edgesC = new Container();
    this.nodesC = new Container();
    this.partyC = new Container();
    this.worldC.addChild(this.edgesC, this.nodesC, this.partyC);
    this.buildBoard();
    this.buildParty();

    // ---- HUD ------------------------------------------------------------
    this.buildHeader();
    this.buildStrip();
    this.promptC = new Container();
    this.hudC.addChild(this.promptC);

    // ---- arrive: resolve the node the party is standing on --------------
    this.refresh();
    this.resolveArrival();
  }

  unmount(): void {
    this.mounted = false;
    this.tooltip = null;
    this.restBox = null;
    this.enterFn = null;
    this.toastC = null;
    this.nodeViews = [];
    this.edgeViews = [];
    this.cards = [];
    this.shiniesText = null;
    for (const c of [this.bgC, this.worldC, this.hudC, this.modalC]) {
      c.parent?.removeChild(c);
      c.destroy({ children: true });
    }
  }

  update(dtMs: number): void {
    if (!this.mounted) return;
    this.t += dtMs;

    // live routes: gold motes drifting toward the choices on offer
    const phase = (this.t / 1400) % 1;
    for (const e of this.edgeViews) {
      if (e.state !== "live") continue;
      e.motes.clear();
      for (let i = 0; i < 3; i++) {
        const p = bezier(e.curve, (phase + i / 3) % 1);
        const a = 0.25 + 0.55 * Math.sin(((phase + i / 3) % 1) * Math.PI);
        e.motes.circle(p.x, p.y, 3).fill({ color: PAL.gold, alpha: a });
      }
    }

    // legal medallions breathe; the selected one wears the bright ring
    const pulse = 0.5 + 0.5 * Math.sin(this.t / 320);
    for (const nv of this.nodeViews) {
      const legal = this.options.some((o) => o.id === nv.node.id);
      if (!legal) continue;
      const sel = this.options[this.selected]?.id === nv.node.id;
      nv.ring.alpha = sel ? 0.7 + 0.3 * pulse : 0.3 + 0.2 * pulse;
      const s = sel ? 1.06 + 0.02 * pulse : 1;
      nv.art.scale.set(s);
    }

    if (this.toastC && this.toastMs > 0) {
      this.toastMs -= dtMs;
      if (this.toastMs <= 0) this.hideToast();
    }
  }

  onKey(key: string): boolean {
    if (!this.mounted) return false;
    if (this.restBox) {
      if (key === "enter" || key === "space" || key === "e" || key === "esc") {
        this.closeRest();
      }
      return true;
    }
    if (this.busy) return true;

    if (this.enterFn && (key === "enter" || key === "space" || key === "e")) {
      this.enterFn();
      return true;
    }
    if (this.options.length === 0) return false;

    if (key === "up" || key === "left" || key === "w" || key === "a") {
      this.select(this.selected - 1);
      return true;
    }
    if (key === "down" || key === "right" || key === "s" || key === "d") {
      this.select(this.selected + 1);
      return true;
    }
    if (key === "enter" || key === "space") {
      this.take(this.options[this.selected]);
      return true;
    }
    const i = "123".indexOf(key);
    if (i >= 0 && i < this.options.length) {
      this.select(i);
      this.take(this.options[i]);
      return true;
    }
    return false;
  }

  /* ------------------------------- board ------------------------------- */

  private get run(): RunState {
    return this.ctx.run as RunState;
  }

  /** Nodes already dispatched on THIS floor (see the augmentation above). */
  private resolvedIds(): number[] {
    const rec = this.run.resolvedNodes;
    return rec && rec.floor === this.run.floorNum ? rec.ids : [];
  }

  private markResolved(id: number): void {
    const ids = this.resolvedIds();
    if (ids.includes(id)) return;
    this.ctx.run = {
      ...this.run,
      resolvedNodes: { floor: this.run.floorNum, ids: [...ids, id] },
    };
  }

  /** Node centre in board space. Columns spread by depth, rows by row. */
  private nodePos(node: MapNode): { x: number; y: number } {
    const bx = rx(RM.board);
    const by = ry(RM.board);
    const bw = rw(RM.board);
    const bh = rh(RM.board);
    const cols = this.run.floorMap?.columns ?? 1;
    const x = bx + ((node.depth + 0.5) * bw) / Math.max(1, cols);
    const y = by + ((node.row + 0.5) * bh) / Math.max(1, node.rowCount);
    // a touch of hand-drawn wobble so a column never reads as a spreadsheet
    return {
      x: x + wobble(node.seed, 0x51ed) * 9,
      y: y + wobble(node.seed, 0x2f4b) * (node.rowCount > 1 ? 12 : 26),
    };
  }

  private curveFor(a: NodeView, b: NodeView): Curve {
    const dx = (b.x - a.x) * 0.45;
    const sag = wobble(a.node.seed ^ b.node.seed, 0x7a11) * 18;
    return {
      x1: a.x,
      y1: a.y,
      c1x: a.x + dx,
      c1y: a.y + sag,
      c2x: b.x - dx,
      c2y: b.y - sag,
      x2: b.x,
      y2: b.y,
    };
  }

  private buildBoard(): void {
    const map = this.run.floorMap;
    if (!map) return;

    for (const node of map.nodes) {
      const p = this.nodePos(node);
      const nv = this.makeNodeView(node, p.x, p.y);
      this.nodeViews.push(nv);
      this.nodesC.addChild(nv.view);
    }

    for (const e of map.edges) {
      const a = this.nodeViews[e.from];
      const b = this.nodeViews[e.to];
      if (!a || !b) continue;
      const g = new Graphics();
      const motes = new Graphics();
      this.edgesC.addChild(g, motes);
      this.edgeViews.push({
        from: e.from,
        to: e.to,
        curve: this.curveFor(a, b),
        g,
        motes,
        state: "open",
      });
    }
  }

  private makeNodeView(node: MapNode, x: number, y: number): NodeView {
    const isTerminal = node.id === this.run.floorMap?.bossId;
    const r = node.type === "boss" || isTerminal ? R_BOSS : R_NODE;
    const view = new Container();
    view.position.set(x, y);

    // grounding shadow — the medallion sits ON the map, not over it
    view.addChild(
      new Graphics()
        .ellipse(0, r * 0.86, r * 0.82, r * 0.26)
        .fill({ color: PAL.void, alpha: 0.5 }),
    );

    // the terminal node is telegraphed: a halo + the stairs-down swirl badge,
    // so the end of the floor is legible from across the board
    if (isTerminal) {
      const halo = new Graphics();
      for (let i = 4; i >= 1; i--) {
        halo.circle(0, 0, r + i * 7).fill({
          color: node.type === "boss" ? PAL.danger : PAL.gold,
          alpha: 0.05,
        });
      }
      const badge = new Graphics();
      drawStairs(badge, 0, 0);
      badge.scale.set(0.62);
      badge.position.set(r * 0.72, -r * 0.72);
      view.addChild(halo, badge);
    }

    const art = new Container();
    art.addChild(this.makeMedallion(node, r));
    // The painted medallions are one pewter family, so at 66px on a busy
    // backdrop "fight" and "elite" and "boss" all read as the same disc.
    // A type-coloured rim restores the at-a-glance gamble the design asks
    // for ("a route is a legible gamble") without touching the art.
    art.addChild(
      new Graphics()
        .circle(0, 0, r + 2)
        .stroke({ width: 2.5, color: NODE_TINT[node.type], alpha: 0.85 }),
    );
    view.addChild(art);

    const ring = new Graphics()
      .circle(0, 0, r + 8)
      .stroke({ width: 3, color: PAL.gold, alpha: 0.9 });
    ring.visible = false;
    view.addChild(ring);

    // …and the type spelled out, because a colour code alone is not a
    // legend. Sits below the medallion; the hotkey chip moved to its left.
    const caption = label(
      isTerminal && node.type !== "boss"
        ? "THE WAY DOWN"
        : NODE_NAME[node.type].toUpperCase(),
      { size: TYPE.tiny, bold: true, center: true, fill: NODE_TINT[node.type] },
    );
    caption.position.set(0, r + 7);
    view.addChild(caption);

    const visitedMark = this.makeStateMark("node:visited", r);
    const lockedMark = this.makeStateMark("node:locked", r);
    visitedMark.visible = false;
    lockedMark.visible = false;
    view.addChild(visitedMark, lockedMark);

    // hotkey chip under a legal medallion
    const hotkey = new Container();
    hotkey.visible = false;
    view.addChild(hotkey);

    const nv: NodeView = {
      node,
      view,
      art,
      visitedMark,
      lockedMark,
      ring,
      hotkey,
      caption,
      r,
      x,
      y,
    };

    view.eventMode = "static";
    view.cursor = "pointer";
    view.hitArea = {
      contains: (px: number, py: number) => px * px + py * py <= (r + 8) ** 2,
    };
    view.on("pointerover", () => this.showTooltip(nv));
    view.on("pointerout", () => this.hideTooltip());
    view.on("pointertap", () => {
      const opt = this.options.find((o) => o.id === node.id);
      if (opt) {
        this.select(this.options.indexOf(opt));
        this.take(opt);
      }
    });
    return nv;
  }

  /**
   * One medallion: the generated `node:<type>` illustration when the art pack
   * has it, a procedural pewter medallion when it does not (the game must
   * stay playable with zero generated assets).
   */
  private makeMedallion(node: MapNode, r: number): Container {
    const wrap = new Container();
    const tex = spriteTextureFor(`node:${node.type}`);
    if (tex && tex.width > 0 && tex.height > 0) {
      const sp = new Sprite({ texture: tex, anchor: 0.5 });
      sp.width = r * 2;
      sp.height = r * 2;
      wrap.addChild(sp);
      return wrap;
    }
    const tint = NODE_TINT[node.type];
    const g = new Graphics();
    g.circle(0, 0, r).fill({ color: mix(PAL.panel, PAL.border, 0.35) });
    g.circle(0, 0, r - 4).fill({ color: mix(PAL.bgDeep, tint, 0.3) });
    g.circle(0, 0, r).stroke({ width: 3, color: PAL.border });
    g.circle(0, 0, r - 4).stroke({
      width: 1.5,
      color: mix(PAL.border, PAL.sheen, 0.3),
      alpha: 0.7,
    });
    wrap.addChild(g);
    wrap.addChild(this.makeNodeGlyph(node.type, r));
    return wrap;
  }

  /** The procedural pictogram inside a fallback medallion. */
  private makeNodeGlyph(type: NodeType, r: number): Container {
    const c = new Container();
    const g = new Graphics();
    const s = r / 33;
    const ink = PAL.text;
    switch (type) {
      case "fight":
      case "elite": {
        for (let i = 0; i < 3; i++) {
          const x = -11 + i * 11;
          g.moveTo(x - 4, -13)
            .lineTo(x + 4, 13)
            .stroke({ width: 3.5, color: ink, alpha: 0.92 });
        }
        if (type === "elite") {
          g.poly([
            -13, -16, -7, -22, 0, -16, 7, -22, 13, -16, 13, -13, -13, -13,
          ]).fill(PAL.gold);
        }
        break;
      }
      case "event": {
        const q = new Text({
          text: "?",
          style: display(30, { fill: PAL.text }),
        });
        q.anchor.set(0.5);
        q.position.set(0, -1);
        c.addChild(q);
        break;
      }
      case "shop": {
        // a stack of coins on the Peddler's blanket
        g.ellipse(0, 10, 20, 6).fill({ color: PAL.panel, alpha: 0.9 });
        for (let i = 0; i < 3; i++) {
          g.ellipse(0, 6 - i * 6, 12, 5)
            .fill(PAL.gold)
            .stroke({ width: 1.5, color: PAL.goldDark });
        }
        break;
      }
      case "rest": {
        g.circle(2, 0, 13).fill(PAL.text);
        g.circle(9, -5, 12).fill(mix(PAL.bgDeep, PAL.heal, 0.3));
        const z = new Text({ text: "z", style: mono(15, { fill: PAL.heal }) });
        z.anchor.set(0.5);
        z.position.set(-13, -13);
        c.addChild(z);
        break;
      }
      case "treasure":
        // the 20×14 chest pictogram needs a bump to fill a medallion
        drawChest(g, 0, 1);
        c.scale.set(1.5);
        break;
      case "boss": {
        // skull: cranium, sockets, jaw
        g.circle(0, -3, 14).fill(PAL.text);
        g.rect(-7, 8, 14, 7).fill(PAL.text);
        g.circle(-5, -4, 4).fill(PAL.void);
        g.circle(5, -4, 4).fill(PAL.void);
        g.rect(-1.5, 3, 3, 4).fill(PAL.void);
        break;
      }
    }
    g.scale.set(s);
    c.addChildAt(g, 0);
    return c;
  }

  /**
   * A state overlay (`node:visited` / `node:locked`): drawn at the SAME size
   * and centre as the medallion beneath it (the asset contract), with a
   * procedural stand-in when the art pack has no overlay.
   */
  private makeStateMark(id: string, r: number): Container {
    const wrap = new Container();
    const tex = spriteTextureFor(id);
    if (tex && tex.width > 0 && tex.height > 0) {
      const sp = new Sprite({ texture: tex, anchor: 0.5 });
      sp.width = r * 2;
      sp.height = r * 2;
      wrap.addChild(sp);
      return wrap;
    }
    // The painted overlays keep their centres transparent so the node type
    // stays readable underneath; the stand-ins honour the same rule — a light
    // wash plus a corner stamp, never a lid over the pictogram.
    const g = new Graphics();
    if (id === "node:visited") {
      g.circle(0, 0, r).fill({ color: PAL.void, alpha: 0.34 });
      const bx = r * 0.52;
      const by = r * 0.52;
      g.circle(bx, by, r * 0.3)
        .fill(PAL.panel)
        .stroke({
          width: 2,
          color: PAL.heal,
        });
      g.moveTo(bx - r * 0.14, by)
        .lineTo(bx - r * 0.03, by + r * 0.12)
        .lineTo(bx + r * 0.15, by - r * 0.13)
        .stroke({ width: 3, color: PAL.heal, alpha: 0.95 });
    } else {
      g.circle(0, 0, r).fill({ color: PAL.void, alpha: 0.5 });
      // a chain crossing the medallion, thin enough to see through
      for (const d of [-1, 1]) {
        g.moveTo(-r * 0.62 * d, -r * 0.62)
          .lineTo(r * 0.62 * d, r * 0.62)
          .stroke({ width: 3, color: PAL.textDim, alpha: 0.7 });
      }
    }
    wrap.addChild(g);
    return wrap;
  }

  private buildParty(): void {
    const run = this.run;
    const lead = run.marchingOrder[0] ?? run.cats[0].classId;
    this.partyC.removeChildren().forEach((c) => c.destroy({ children: true }));
    const marker = new Container();
    marker.addChild(
      new Graphics()
        .ellipse(0, 22, 20, 7)
        .fill({ color: PAL.void, alpha: 0.55 }),
    );
    marker.addChild(avatar(lead, 46, { ring: PAL.gold }));
    // the rest of the clowder as small coloured dots trailing the lead
    run.marchingOrder.slice(1, 4).forEach((cls, i) => {
      // catNameColor, not the raw body colour: soot-black Pixel and dusk
      // Mora are darker than the map and their dots vanish otherwise
      const dot = new Graphics()
        .circle(0, 0, 5)
        .fill(catNameColor(cls))
        .stroke({ width: 1.5, color: PAL.void });
      dot.position.set(-26 + i * 13, 26);
      marker.addChild(dot);
    });
    this.partyC.addChild(marker);
    const cur = this.currentView();
    if (cur) this.partyC.position.set(cur.x, cur.y - cur.r - MARKER_LIFT);
  }

  private currentView(): NodeView | null {
    const id = this.run.currentNodeId;
    if (id === null) return null;
    return this.nodeViews.find((n) => n.node.id === id) ?? null;
  }

  /* -------------------------------- HUD -------------------------------- */

  private buildHeader(): void {
    const run = this.run;
    const cfg = floorConfig(run.floorNum);
    const th = THEMES[themeIndex(run.floorNum)];
    const rail = new Container();
    rail.position.set(rx(RM.header), ry(RM.header));

    const dot = new Graphics().circle(8, 15, 5).fill(th.accent);
    rail.addChild(dot);

    const name = heading(
      `FLOOR ${run.floorNum} · ${cfg.name.toUpperCase()}`,
      3,
      { fill: PAL.text },
    );
    name.position.set(22, 8);
    rail.addChild(name);

    const seed = label(`seed ${run.runSeed}`, {
      mono: true,
      dim: true,
      size: TYPE.tiny,
    });
    seed.position.set(22 + Math.ceil(name.width) + SPACE.lg, 11);
    rail.addChild(seed);

    const hint = label(
      "1-3 / arrows pick a route · Enter confirms · Esc menu",
      {
        dim: true,
        size: TYPE.tiny,
      },
    );
    hint.anchor.set(1, 0);
    hint.position.set(rw(RM.header), 11);
    rail.addChild(hint);

    this.hudC.addChild(rail);
  }

  private buildStrip(): void {
    const run = this.run;
    const strip = new Container();
    strip.position.set(rx(RM.strip), ry(RM.strip));
    strip.addChild(
      new Graphics()
        .rect(0, 0, rw(RM.strip), rh(RM.strip))
        .fill({ color: PAL.bgDeep, alpha: 0.82 }),
      new Graphics()
        .moveTo(0, 0)
        .lineTo(rw(RM.strip), 0)
        .stroke({ width: 1, color: PAL.border }),
    );
    this.hudC.addChild(strip);

    this.cards = [];
    run.cats.forEach((cat, i) => {
      const rect = RM.cards[i];
      if (!rect) return;
      const view = new Container();
      view.position.set(rx(rect) - rx(RM.strip), ry(rect) - ry(RM.strip));
      const w = rw(rect);
      const h = rh(rect);
      view.addChild(panel(w, h, { variant: "glass" }));

      const face = avatar(cat.classId, 44, { dead: cat.lives <= 0 });
      face.position.set(SPACE.md + 22, h / 2);
      view.addChild(face);

      const nameText = label(
        cat.lives > 0 ? catName(cat.classId) : `${catName(cat.classId)} ✝`,
        {
          bold: true,
          size: TYPE.small,
          // the shared readable-name colour every other screen uses; the raw
          // `body` colour is unreadable for Pixel (0x33303f on 0x1a1626)
          fill: cat.lives > 0 ? catNameColor(cat.classId) : PAL.textDim,
        },
      );
      nameText.position.set(SPACE.md + 50, SPACE.sm);
      view.addChild(nameText);

      const hp = bar(w - SPACE.md - 56, 9, { kind: "hp" });
      hp.view.position.set(SPACE.md + 50, 30);
      view.addChild(hp.view);

      const hpText = label("", { mono: true, dim: true, size: TYPE.tiny });
      hpText.position.set(SPACE.md + 50, 42);
      view.addChild(hpText);

      const paws = makePawRow(cat.lives);
      paws.view.position.set(w - SPACE.md - 72, 44);
      view.addChild(paws.view);

      // A run FIELDS a subset of the four slots (balance-and-meta.md §2).
      // Undimmed, the strip shows four healthy cats while two of them are on
      // the bench — the party looks twice the size it fights at.
      if (cat.lives > 0 && !run.marchingOrder.includes(cat.classId)) {
        view.alpha = 0.55;
        const benched = label("BENCHED", { dim: true, size: TYPE.tiny });
        benched.anchor.set(1, 0);
        benched.position.set(w - SPACE.md, SPACE.sm);
        view.addChild(benched);
      }

      strip.addChild(view);
      this.cards.push({ catIndex: i, view, hp, hpText, paws });
    });

    // shinies chip
    const chip = new Container();
    chip.position.set(
      rx(RM.goldChip) - rx(RM.strip),
      ry(RM.goldChip) - ry(RM.strip),
    );
    chip.addChild(
      panel(rw(RM.goldChip), rh(RM.goldChip), { variant: "glass" }),
    );
    const coin = makeSpriteIcon("item:shinies", 18);
    if (coin) {
      coin.position.set(SPACE.md + 9, rh(RM.goldChip) / 2);
      chip.addChild(coin);
    } else {
      chip.addChild(
        new Graphics()
          .circle(SPACE.md + 9, rh(RM.goldChip) / 2, 7)
          .fill(PAL.gold)
          .stroke({ width: 2, color: PAL.goldDark }),
      );
    }
    this.shiniesText = label("0 ✦", { mono: true, fill: PAL.gold });
    this.shiniesText.position.set(SPACE.md + 24, 7);
    chip.addChild(this.shiniesText);
    strip.addChild(chip);

    // consumable belt
    this.beltC = new Container();
    this.beltC.position.set(
      rx(RM.belt) - rx(RM.strip),
      ry(RM.belt) - ry(RM.strip),
    );
    strip.addChild(this.beltC);
  }

  /** Repaint every value-carrying HUD widget from the live run. */
  private refreshHud(): void {
    const run = this.run;
    for (const card of this.cards) {
      const cat = run.cats[card.catIndex];
      if (!cat) continue;
      const max = maxHp(cat, run.level);
      card.hp.set(cat.lives > 0 ? cat.hp : 0, max);
      card.hpText.text = cat.lives > 0 ? `${cat.hp}/${max}` : "out of Lives";
      card.paws.set(cat.lives);
      card.view.alpha = cat.lives > 0 ? 1 : 0.55;
    }
    if (this.shiniesText) {
      this.shiniesText.text = `${run.inventory.shinies} ✦`;
    }
    this.buildBelt();
  }

  /**
   * The out-of-combat belt: every owned consumable, with the two that heal
   * outside battle (Tuna Snack / Sardine Tin — GDD §7) pressable. A press
   * feeds the most wounded living cat.
   */
  private buildBelt(): void {
    this.beltC.removeChildren().forEach((c) => c.destroy({ children: true }));
    const run = this.run;
    const counts = new Map<ItemId, number>();
    for (const slot of run.inventory.slots) {
      if (!isStack(slot)) continue;
      counts.set(slot.defId, (counts.get(slot.defId) ?? 0) + slot.count);
    }
    let x = 0;
    for (const [defId, count] of counts) {
      const def = CONSUMABLES[defId];
      if (!def || x > rw(RM.belt) - 34) continue;
      const usable = def.explore?.heal !== undefined;
      const cell = new Container();
      cell.position.set(x, 0);
      cell.addChild(
        new Graphics()
          .roundRect(0, 0, 32, 32, 4)
          .fill({ color: PAL.hpBack, alpha: 0.9 })
          .stroke({ width: 1, color: usable ? PAL.gold : PAL.border }),
      );
      const icon = makeSpriteIcon(`item:${defId}`, 22);
      if (icon) {
        icon.position.set(16, 16);
        cell.addChild(icon);
      } else {
        const glyph = label(def.icon, { size: TYPE.small, center: true });
        glyph.position.set(16, 16);
        cell.addChild(glyph);
      }
      const n = label(`${count}`, { mono: true, size: TYPE.tiny, dim: true });
      n.anchor.set(1, 1);
      n.position.set(31, 32);
      cell.addChild(n);
      if (usable) {
        cell.eventMode = "static";
        cell.cursor = "pointer";
        cell.on("pointertap", () => this.useConsumable(defId));
      }
      this.beltC.addChild(cell);
      x += 36;
    }
  }

  /** Belt use: heal the most wounded living cat (GDD §7 explore heals). */
  private useConsumable(defId: ItemId): void {
    const run = this.run;
    const def = CONSUMABLES[defId];
    const spec = def?.explore?.heal;
    if (spec === undefined) return;
    let target = -1;
    let worst = 0;
    run.cats.forEach((cat, i) => {
      if (cat.lives <= 0) return;
      const missing = maxHp(cat, run.level) - cat.hp;
      if (missing > worst) {
        worst = missing;
        target = i;
      }
    });
    if (target < 0) {
      this.showToast("Nobody needs patching up.");
      return;
    }
    const { inv, removed } = removeConsumable(run.inventory, defId, 1);
    if (removed < 1) return;
    const cat = run.cats[target];
    const max = maxHp(cat, run.level);
    const heal = spec === "full" ? max - cat.hp : Math.min(spec, max - cat.hp);
    this.ctx.run = {
      ...run,
      inventory: inv,
      cats: run.cats.map((c, i) =>
        i === target ? { ...c, hp: c.hp + heal } : c,
      ),
    };
    this.showToast(`${def.name}: ${catName(cat.classId)} +${heal} HP`);
    this.refreshHud();
  }

  /* ----------------------------- route state ---------------------------- */

  /** Recompute options + repaint every edge, medallion and marker state. */
  private refresh(): void {
    const run = this.run;
    const map = run.floorMap;
    if (!map) return;
    const current = run.currentNodeId;
    const visited = new Set(run.visitedNodeIds);
    const closed = new Set(closedNodes(run));
    const resolved = new Set(this.resolvedIds());
    this.options = optionsForRun(run).map((o) => o.node);
    if (this.selected >= this.options.length) this.selected = 0;

    // edges
    for (const e of this.edgeViews) {
      let state: EdgeState = "open";
      if (visited.has(e.from) && visited.has(e.to)) state = "taken";
      else if (e.from === current) state = "live";
      else if (closed.has(e.from) || closed.has(e.to)) state = "closed";
      e.state = state;
      this.paintEdge(e);
      if (state !== "live") e.motes.clear();
    }

    // nodes
    for (const nv of this.nodeViews) {
      const id = nv.node.id;
      const legal = this.options.some((o) => o.id === id);
      const isClosed = closed.has(id);
      nv.visitedMark.visible = resolved.has(id) && id !== current;
      nv.lockedMark.visible = isClosed;
      nv.ring.visible = legal;
      nv.view.alpha = isClosed ? 0.5 : 1;
      nv.view.cursor = legal ? "pointer" : "default";
      // the type label leads on the routes on offer and recedes elsewhere,
      // so the board reads "these two, and here is what they are"
      nv.caption.style.fill = isClosed
        ? PAL.textDim
        : legal || id === current
          ? NODE_TINT[nv.node.type]
          : mix(NODE_TINT[nv.node.type], PAL.textDim, 0.5);
      nv.caption.alpha = legal || id === current ? 1 : 0.7;
      if (!legal) nv.art.scale.set(1);
      this.setHotkey(
        nv,
        legal ? this.options.findIndex((o) => o.id === id) : -1,
      );
    }

    this.refreshHud();
    this.refreshPrompt();
  }

  private paintEdge(e: EdgeView): void {
    const style: Record<
      EdgeState,
      { color: number; alpha: number; w: number }
    > = {
      taken: { color: PAL.gold, alpha: 0.9, w: 4 },
      live: { color: PAL.gold, alpha: 0.75, w: 3.5 },
      open: { color: PAL.textDim, alpha: 0.42, w: 2.5 },
      // a sealed route is a faint scar, NOT a heavy black cable across the
      // board — it must recede, or the closed branches shout louder than the
      // live ones
      closed: { color: mix(PAL.void, PAL.textDim, 0.35), alpha: 0.3, w: 1.5 },
    };
    const s = style[e.state];
    const c = e.curve;
    const path = (): Graphics =>
      e.g
        .moveTo(c.x1, c.y1)
        .bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.x2, c.y2);
    e.g.clear();
    // ink under-stroke: the route reads on a busy painted backdrop (closed
    // routes get none — the halo is what made them read as the loudest line)
    if (e.state !== "closed") {
      path().stroke({ width: s.w + 4, color: PAL.void, alpha: 0.5 });
    }
    path().stroke({ width: s.w, color: s.color, alpha: s.alpha });
  }

  private setHotkey(nv: NodeView, index: number): void {
    nv.hotkey.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (index < 0) {
      nv.hotkey.visible = false;
      return;
    }
    nv.hotkey.visible = true;
    const chip = new Container();
    chip.addChild(
      new Graphics()
        .roundRect(0, 0, 20, 20, 4)
        .fill(PAL.gold)
        .stroke({ width: 1, color: PAL.goldDark }),
    );
    const n = new Text({
      text: String(index + 1),
      style: mono(13, { fill: PAL.textDark }),
    });
    n.anchor.set(0.5);
    n.position.set(10, 10);
    chip.addChild(n);
    // left of the medallion — the caption owns the space underneath
    chip.position.set(-nv.r - 26, -10);
    nv.hotkey.addChild(chip);
  }

  private select(index: number): void {
    if (this.options.length === 0) return;
    const n = this.options.length;
    this.selected = ((index % n) + n) % n;
  }

  /* ------------------------------ the choice ---------------------------- */

  private take(node: MapNode | undefined): void {
    if (!node || this.busy || !this.mounted) return;
    const from = this.currentView();
    this.busy = true;
    this.hideTooltip();
    try {
      this.ctx.run = advance(this.run, node.id);
    } catch {
      // core refused the move (never legal from the UI's own option list);
      // fail visibly rather than silently desyncing.
      this.busy = false;
      this.showToast("There is no path that way.");
      return;
    }
    const to = this.nodeViews.find((n) => n.node.id === node.id);
    const edge = this.edgeViews.find(
      (e) => e.from === (from?.node.id ?? -1) && e.to === node.id,
    );
    this.clearPrompt();

    const land = (): void => {
      if (!this.mounted) return;
      if (to) this.partyC.position.set(to.x, to.y - to.r - MARKER_LIFT);
      this.busy = false;
      this.refresh();
      this.resolveArrival();
    };

    if (!edge || !to) {
      land();
      return;
    }
    // walk the edge: the party marker rides the same bezier the ink follows
    const drive = { t: 0 };
    const lift = (from?.r ?? R_NODE) + MARKER_LIFT;
    tween(drive, { t: 1 }, TRAVEL_MS, "quadOut", land);
    const step = (): void => {
      if (!this.mounted || drive.t >= 1) return;
      const p = bezier(edge.curve, drive.t);
      const hop = Math.sin(drive.t * Math.PI) * 10;
      this.partyC.position.set(p.x, p.y - lift - hop);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* --------------------------- node resolution -------------------------- */

  /**
   * Hand the node the party is standing on to whatever resolves it. Nodes are
   * marked resolved BEFORE dispatch: a fled fight, a declined shop or a
   * closed event all mean "this node is done" — the map must never re-open an
   * encounter the player already walked out of.
   */
  private resolveArrival(): void {
    const run = this.run;
    const map = run.floorMap;
    const id = run.currentNodeId;
    if (!map || id === null) return;
    const node = map.nodes[id];
    if (!node) return;
    if (this.resolvedIds().includes(id)) {
      this.refreshPrompt();
      return;
    }
    this.markResolved(id);

    switch (node.type) {
      case "fight":
      case "elite":
      case "boss":
        this.startFight(node);
        return;
      case "event": {
        const params: EventSceneParams = {
          eventId: node.id,
          eventSeed: node.seed,
        };
        this.ctx.scenes.goto("event", params);
        return;
      }
      case "shop": {
        const params: LandingParams = {
          shop: { nodeId: node.id, seed: node.seed },
        };
        this.ctx.scenes.goto("landing", params);
        return;
      }
      case "treasure":
        this.openTreasure(node);
        return;
      case "rest":
        this.openRest();
        return;
    }
  }

  private startFight(node: MapNode): void {
    const run = this.run;
    const cfg = floorConfig(run.floorNum);
    const enemies = encounterFor(node, cfg);
    if (!enemies || enemies.length === 0) {
      // authored content gave this node nothing to fight — never strand the
      // player on a dead node; treat it as walked-through.
      this.showToast("The alley is empty. Lucky.");
      this.refresh();
      return;
    }
    const params: BattleSceneParams = {
      enemies,
      encounterIndex: encounterIndexOf(node),
      isBoss: node.type === "boss",
      nodeId: node.id,
    };
    this.ctx.scenes.goto("battle", params);
  }

  /** Treasure: one fresh stream per node seed (ARCHITECTURE.md §4). */
  private openTreasure(node: MapNode): void {
    const run = this.run;
    const lctx: LootCtx = {
      floor: run.floorNum,
      livingClasses: run.cats.filter((c) => c.lives > 0).map((c) => c.classId),
      uniquesDropped: run.uniquesDropped,
      nextUid: run.inventory.nextUid,
      currentShinies: run.inventory.shinies,
    };
    const grant = rollChest(mulberry32(node.seed), lctx);
    const params: LootOverlayParams = {
      variant: "chest",
      grant,
      onClosed: () => {
        if (!this.mounted) return;
        this.refresh();
      },
    };
    this.ctx.scenes.pushOverlay("loot", params);
  }

  /* -------------------------------- rest -------------------------------- */

  /** The catnap node: the same free heal the Landing gives (GDD §7). */
  private openRest(): void {
    const run = this.run;
    const { cats, healed } = catnapHeal(run.cats, run.level);
    this.ctx.run = { ...run, cats };
    this.ctx.save(); // the heal must survive a reload like any other autosave
    this.refreshHud();

    const w = 520;
    const h = 300;
    const box = new Container();
    box.addChild(scrim(DESIGN_W, DESIGN_H, 0.55));
    const card = panel(w, h, { variant: "raised", accent: PAL.heal });
    card.position.set((DESIGN_W - w) / 2, (DESIGN_H - h) / 2);
    box.addChild(card);

    const eyebrow = heading("A WARM SPOT", 3, { center: true });
    eyebrow.position.set(w / 2, SPACE.lg);
    const title = heading("Catnap", 1, { center: true, fill: PAL.heal });
    title.position.set(w / 2, SPACE.lg + 26);
    card.addChild(eyebrow, title);

    let y = 110;
    run.cats.forEach((cat, i) => {
      if (cat.lives <= 0) return;
      const row = label(
        healed[i] > 0
          ? `${catName(cat.classId)}  +${healed[i]} HP`
          : `${catName(cat.classId)}  already comfortable`,
        {
          mono: true,
          fill: healed[i] > 0 ? PAL.heal : PAL.textDim,
        },
      );
      row.position.set(SPACE.xl, y);
      card.addChild(row);
      y += 26;
    });

    const bw = 240;
    const b = button("Back to the route", bw, 48, () => this.closeRest(), {
      primary: true,
      hotkey: "Enter",
    });
    b.view.position.set((w - bw) / 2, h - 48 - SPACE.lg);
    card.addChild(b.view);

    this.modalC.addChild(box);
    this.restBox = box;
  }

  private closeRest(): void {
    this.restBox?.destroy({ children: true });
    this.restBox = null;
    this.refresh();
  }

  /* ------------------------------- prompt ------------------------------- */

  private clearPrompt(): void {
    this.promptC.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.enterFn = null;
  }

  /**
   * Has THIS floor's terminal node fallen? `floorsCleared` ticks exactly once
   * per floor, in `applyBattleResult`, on a victory at `floorMap.bossId` — so
   * a fled stairs guard leaves the counter behind the floor number and the
   * way down stays shut.
   */
  private floorCleared(): boolean {
    return this.run.score.floorsCleared >= this.run.floorNum;
  }

  /** Re-engage the guard the party fled from (same node, same stream). */
  private retryTerminal(): void {
    const map = this.run.floorMap;
    if (!map || this.busy) return;
    const node = map.nodes[map.bossId];
    if (node) this.startFight(node);
  }

  /**
   * The band under the board: either "the way down is open" with the Descend
   * button, or the route the party is being asked to choose.
   */
  private refreshPrompt(): void {
    this.clearPrompt();
    if (!this.mounted) return;
    const run = this.run;
    const [px, py, pw, ph] = RM.prompt;

    if (atTerminal(run)) {
      const bw = 320;
      if (!this.floorCleared()) {
        // fled the stairs guard: the way down stays shut until it falls
        const line = label("Something is still humming on the stairs.", {
          center: true,
          fill: PAL.danger,
          size: TYPE.small,
        });
        line.position.set(px + pw / 2, py + 4);
        const again = button(
          "Face them again",
          bw,
          34,
          () => this.retryTerminal(),
          { primary: true, hotkey: "Enter" },
        );
        again.view.position.set(px + (pw - bw) / 2, py + 22);
        this.promptC.addChild(line, again.view);
        this.enterFn = () => this.retryTerminal();
        return;
      }
      const last = run.floorNum >= FLOOR_COUNT;
      const b = button(
        last ? "Into the Sunbeam" : "Take the stairs down",
        bw,
        ph,
        () => this.descend(),
        { primary: true, hotkey: "Enter" },
      );
      b.view.position.set(px + (pw - bw) / 2, py);
      this.promptC.addChild(b.view);
      this.enterFn = () => this.descend();
      return;
    }

    if (this.options.length === 0) return;
    const line = label(
      this.options.length === 1
        ? "One way on. Take it."
        : `${this.options.length} routes on. Choose.`,
      { center: true, dim: true, size: TYPE.small },
    );
    line.position.set(px + pw / 2, py + 8);
    this.promptC.addChild(line);

    // one chip per route, so the choice is legible without hovering
    const cw = 168;
    const total = this.options.length * (cw + SPACE.md) - SPACE.md;
    this.options.forEach((node, i) => {
      const b = button(
        `${NODE_NAME[node.type]}`,
        cw,
        34,
        () => {
          this.select(i);
          this.take(node);
        },
        { hotkey: String(i + 1), fontSize: TYPE.small },
      );
      b.view.position.set(px + (pw - total) / 2 + i * (cw + SPACE.md), py + 26);
      b.view.on("pointerover", () => this.select(i));
      this.promptC.addChild(b.view);
    });
  }

  private descend(): void {
    if (this.busy || !this.mounted) return;
    const run = this.run;
    if (!atTerminal(run) || !this.floorCleared()) return;
    this.busy = true;
    if (run.floorNum >= FLOOR_COUNT) {
      this.ctx.scenes.goto("results", { victory: true });
      return;
    }
    this.ctx.scenes.goto("landing");
  }

  /* ------------------------------ tooltip ------------------------------- */

  private showTooltip(nv: NodeView): void {
    this.hideTooltip();
    if (!this.mounted) return;
    const run = this.run;
    const node = nv.node;
    const closed = closedNodes(run).includes(node.id);
    const resolved = this.resolvedIds().includes(node.id);
    const isTerminal = node.id === run.floorMap?.bossId;

    const w = 268;
    const wrap = new Container();
    const lines: { text: string; fill?: number }[] = [];
    if (node.type === "boss" || isTerminal) {
      const cfg = floorConfig(run.floorNum);
      const bossId = cfg.boss?.bossId;
      const bossName = bossId ? ENEMIES[bossId]?.name : undefined;
      lines.push({
        text:
          node.type === "boss"
            ? (bossName ?? "Something enormous") + " holds the way down."
            : "A pack is squatting on the stairs. Through them, then.",
        fill: PAL.danger,
      });
    } else {
      lines.push({ text: NODE_BLURB[node.type] });
    }
    if (resolved) lines.push({ text: "Already dealt with.", fill: PAL.heal });
    else if (closed) {
      lines.push({ text: "Out of reach now.", fill: PAL.textDim });
    }

    const title = heading(
      isTerminal && node.type !== "boss"
        ? "The Way Down"
        : NODE_NAME[node.type],
      2,
      { fill: closed ? PAL.textDim : NODE_TINT[node.type] },
    );
    title.position.set(SPACE.md, SPACE.sm);
    let y = SPACE.sm + 30;
    const body: Text[] = [];
    for (const l of lines) {
      const t = label(l.text, {
        size: TYPE.small,
        wrap: w - SPACE.md * 2,
        ...(l.fill !== undefined ? { fill: l.fill } : { dim: true }),
      });
      t.position.set(SPACE.md, y);
      y += Math.ceil(t.height) + 6;
      body.push(t);
    }
    const h = y + SPACE.sm;
    wrap.addChild(panel(w, h, { variant: "raised" }), title, ...body);
    // keep the card on screen: flip to the left of the node when it would
    // overflow, and clamp vertically against the party strip
    const wantLeft = nv.x + nv.r + 12 + w > DESIGN_W - 8;
    wrap.position.set(
      wantLeft ? nv.x - nv.r - 12 - w : nv.x + nv.r + 12,
      Math.max(56, Math.min(ry(RM.strip) - h - 8, nv.y - h / 2)),
    );
    wrap.eventMode = "none";
    this.hudC.addChild(wrap);
    this.tooltip = wrap;
  }

  private hideTooltip(): void {
    this.tooltip?.destroy({ children: true });
    this.tooltip = null;
  }

  /* ------------------------------- toast -------------------------------- */

  private showToast(text: string, ms = 2400): void {
    this.hideToast();
    const [tx, ty, tw, th] = RM.toast;
    const wrap = new Container();
    wrap.addChild(panel(tw, th, { variant: "raised" }));
    const t = label(text, { center: true, size: TYPE.small });
    t.position.set(tw / 2, th / 2 - 8);
    wrap.addChild(t);
    wrap.position.set(tx, ty);
    wrap.eventMode = "none";
    this.hudC.addChild(wrap);
    this.toastC = wrap;
    this.toastMs = ms;
  }

  private hideToast(): void {
    this.toastC?.destroy({ children: true });
    this.toastC = null;
    this.toastMs = 0;
  }
}

/** Display name of a cat (the content table — a custom party overrides it). */
const catName = (classId: ClassId): string => CLASSES[classId].catName;

/** Factory for the scene registry (main.ts wires it by id 'runMap'). */
export const createRunMapScene = (): RunMapScene => new RunMapScene();
