/**
 * WP-10 — the explore scene (ui-art §7, dungeon.md §§9-12, gameloop.md §§1,3).
 *
 * Renders the current FloorState and drives the core step loop: one
 * `step(floor, dir)` per input, held-repeat on tween completion (~9/s),
 * click-to-path auto-walk, and every StepTrigger dispatched to the right
 * scene/overlay. The UI never computes gameplay outcomes — it renders core
 * state and hands triggers up.
 *
 * ── VISUAL V3: the floor is a place, not a void ─────────────────────────
 *  · FRAMED VIEWPORT — the world lives inside a bordered, masked viewport
 *    (`exploreLayout.EX.viewport`) with the map column docked to its right
 *    and the party strip along the bottom, instead of bleeding to the screen
 *    edges. The camera keeps its lerp but centres the floor whenever the
 *    floor is smaller than the viewport, and applies a modest zoom so tiles
 *    read at a comfortable size.
 *  · NO VOID — `exploreAtmosphere` paints an endless textured rock field
 *    UNDER the tiles and a soft, feathered fog veil OVER them, so unexplored
 *    space is solid rock the party's known world is carved out of. Tile cells
 *    are simply hidden until explored; the veil handles frontier feathering,
 *    remembered-tile dimming and distance falloff.
 *  · LIGHTING — a warm additive lantern rides the party, the fog darkens
 *    tiles by distance, and a vignette frames the viewport. Gameplay-critical
 *    entities (stairs beacon, chests, events, packs) are drawn ABOVE the veil
 *    at a knowledge-based alpha so nothing important can be swallowed.
 *
 * Presentation only: dungeon generation, fog-of-war rules and movement are
 * untouched — `core/dungeon/*` still owns all of it.
 *
 * Scene/GameCtx shapes below are structural mirrors of ARCHITECTURE.md §3;
 * `ui/sceneManager.ts` (WP-09) is their canonical home.
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import { Tile } from "../../core/types.js";
import type {
  Entity,
  FloorState,
  ItemId,
  Roamer,
  RunState,
  StepTrigger,
} from "../../core/types.js";
import { mulberry32 } from "../../core/rng.js";
import {
  idx,
  inBounds,
  recomputeVisibility,
} from "../../core/dungeon/floor.js";
import {
  applyFlee,
  contactCheck,
  step,
  type StepDir,
} from "../../core/dungeon/step.js";
import { canSeeParty } from "../../core/dungeon/roamers.js";
import { FLOOR_COUNT, generateCurrentFloor } from "../../core/run/runState.js";
import { maxHp } from "../../core/run/party.js";
import { removeConsumable } from "../../core/loot/inventory.js";
import { rollBossLoot, rollChest, type LootCtx } from "../../core/loot/roll.js";
import { ENEMIES } from "../../content/enemies.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { PAL, THEMES, mix } from "../palette.js";
import { RADIUS, rh, rw, rx, ry } from "../layout.js";
import { display, mono, worldStroke } from "../textStyles.js";
import { vignette } from "../widgets.js";
import { tween } from "../tween.js";
import { isKeyDown } from "../input.js";
import { drawCatPortrait, drawPaw } from "../draw/cats.js";
import { drawEnemy } from "../draw/enemies.js";
import { drawChest, drawStairs } from "../draw/glyphs.js";
import { spriteTextureFor } from "../sprites.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";
import type { LootOverlayParams } from "../overlays/loot.js";
import { ExploreHud, floorName, themeIndex } from "./exploreHud.js";
import { makeMinimap, type Minimap } from "./minimap.js";
import { makeAtmosphere, type Atmosphere } from "./exploreAtmosphere.js";
import { EX, FOG_BLEED, TILE, ZOOM } from "./exploreLayout.js";

/** Optional mount params: a battle scene reports a flee so the pack stuns. */
export interface ExploreParams {
  fled?: { roamerId: number };
}

/* ---------------------------------------------------------------------- */
/* constants & small helpers                                               */
/* ---------------------------------------------------------------------- */

const VX = rx(EX.viewport);
const VY = ry(EX.viewport);
const VW = rw(EX.viewport);
const VH = rh(EX.viewport);
/** World-space size of what the viewport shows, at the scene's zoom. */
const VIS_W = VW / ZOOM;
const VIS_H = VH / ZOOM;

const STEP_MS = 110; // dungeon.md §9.3 move tween

const DIR_VEC: Record<StepDir, readonly [number, number]> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

const KEY_DIRS: [string, StepDir][] = [
  ["up", "N"],
  ["w", "N"],
  ["down", "S"],
  ["s", "S"],
  ["left", "W"],
  ["a", "W"],
  ["right", "E"],
  ["d", "E"],
];

type ChestEntity = Extract<Entity, { kind: "chest" }>;
type EventEntity = Extract<Entity, { kind: "event" }>;

/**
 * Deterministic per-tile hash for floor-texture variation. Pure (x, y) —
 * NOT a gameplay RNG stream; the visual layer never draws from those.
 */
const tileHash = (x: number, y: number): number =>
  (Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;

const FLOOR_VARIANTS = ["tile:floor", "tile:floor2", "tile:floor3"] as const;

const isPack = (e: Entity): e is Roamer =>
  e.kind === "roamer" || e.kind === "boss";

const tileCx = (x: number): number => x * TILE + TILE / 2;
const tileCy = (y: number): number => y * TILE + TILE / 2;

/** Alpha for an entity marker by knowledge state (kept readable on purpose). */
const KNOWN_ALPHA = { visible: 1, remembered: 0.62 } as const;

/** Tier color of a pack's most expensive member (dungeon.md §7.3). */
function packTierColor(pack: Roamer): number {
  let best = ENEMIES[pack.enemies[0]];
  for (const id of pack.enemies) {
    const def = ENEMIES[id];
    if (def && (!best || def.threat > best.threat)) best = def;
  }
  const tier = best?.tier ?? 1;
  return tier === 3 ? PAL.tier3 : tier === 2 ? PAL.tier2 : PAL.tier1;
}

interface PackView {
  e: Roamer;
  view: Container;
  alert: Graphics;
  glow: Graphics | null;
  prevState: Roamer["state"];
}
interface ChestView {
  e: ChestEntity;
  view: Container;
  opened: boolean;
  /** Generated prop sprite (null = procedural drawChest fallback). */
  sprite: Sprite | null;
  hoard: boolean;
}
interface EventView {
  e: EventEntity;
  view: Container;
  /** Procedural "?" marker (null when the sparkle sprite is in use). */
  q: Text | null;
  /** Generated prop:eventSparkle (gentle pulse in update()). */
  sprite: Sprite | null;
}

/* ---------------------------------------------------------------------- */
/* the scene                                                               */
/* ---------------------------------------------------------------------- */

export class ExploreScene implements Scene {
  private ctx!: GameCtx;
  private floor!: FloorState;
  private mounted = false;

  private hudView: Container | null = null;
  private frame = new Container();
  private worldWrap = new Container();
  private scroller = new Container();
  private fx = new Container();
  private entityLayer = new Container();

  /** One container per tile; hidden until its tile is explored. */
  private tileCells: Container[] = [];
  private revealed!: Uint8Array;

  private atmos: Atmosphere | null = null;
  private stairsBeacon = new Graphics();

  private chestViews: ChestView[] = [];
  private eventViews: EventView[] = [];
  private packViews: PackView[] = [];

  private partyView = new Container();
  private trailDots: Graphics[] = [];
  private trail: { x: number; y: number }[] = [];

  private hud!: ExploreHud;
  private minimap!: Minimap;

  private cam = { x: 0, y: 0 };
  private camPublished = { x: -1, y: -1 };
  private busy = false;
  private stickyDescend = false;
  private bossGrowled = false;
  private mountContactMs = -1;
  private t = 0;

  // click-to-path auto-walk (dungeon.md §9.4)
  private path: { dir: StepDir; x: number; y: number }[] = [];
  private pathBaseline = new Set<number>();
  private pawDots = new Graphics();

  /* ---------------------------- lifecycle --------------------------- */

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    this.ctx = ctx;
    if (!ctx.run) throw new Error("explore: mounted without a run");
    if (!ctx.run.floor) ctx.run = generateCurrentFloor(ctx.run); // defensive
    this.floor = ctx.run.floor as FloorState;
    const run = ctx.run;

    const p = params as ExploreParams | undefined;
    if (p?.fled) applyFlee(this.floor, p.fled.roamerId);
    recomputeVisibility(this.floor);

    this.mounted = true;
    const thIdx = themeIndex(run.floorNum);

    /* ---- world stack, inside the framed viewport -------------------- */
    this.atmos = makeAtmosphere(this.floor, TILE, FOG_BLEED, thIdx);

    this.scroller = new Container();
    const tiles = this.buildTiles();
    this.entityLayer = new Container();
    this.fx = new Container();
    this.partyView = new Container();
    this.stairsBeacon = new Graphics();
    this.scroller.addChild(
      this.atmos.rock,
      tiles,
      this.atmos.fog,
      this.atmos.light,
      this.stairsBeacon,
      this.entityLayer,
      this.partyView,
      this.fx,
    );

    this.buildEntities(this.entityLayer);
    this.buildParty();
    this.pawDots = new Graphics();
    this.fx.addChild(this.pawDots);

    this.worldWrap = new Container();
    this.worldWrap.scale.set(ZOOM);
    this.worldWrap.addChild(this.scroller);

    this.frame = this.buildFrame();

    // HUD + minimap + [M] overlay
    this.hud = new ExploreHud({
      getRun: () => this.ctx.run as RunState,
      onUseConsumable: (defId, catIndex) => this.useConsumable(defId, catIndex),
      onReorder: (order) => {
        const r = this.ctx.run as RunState;
        this.ctx.run = { ...r, marchingOrder: order };
        this.buildParty(); // lead portrait / trail colors may change
      },
    });
    this.minimap = makeMinimap(this.floor, {
      floorNum: run.floorNum,
      floorName: floorName(run.floorNum),
      seed: run.runSeed,
      themeIdx: thIdx,
    });
    this.hudView = new Container();
    this.hudView.addChild(this.hud.view, this.minimap.view);

    // attach to the labeled root layers (ARCHITECTURE §3.4 / sceneManager)
    layer(root, "world").addChild(this.frame);
    layer(root, "hud").addChild(this.hudView);
    layer(root, "modal").addChild(this.minimap.overlay);

    // initial knowledge state + camera snap
    this.refreshTerrain();
    this.refreshEntities(false);
    this.minimap.refresh();
    this.updateObjective();
    const c = this.camTarget();
    this.cam.x = c.x;
    this.cam.y = c.y;
    this.applyCamera();
    this.atmos.update(
      0,
      tileCx(this.floor.party.x),
      tileCy(this.floor.party.y),
    );
    this.checkBossReveal();

    // post-battle chained contact (dungeon.md §14) after a beat
    if (contactCheck(this.floor)) this.mountContactMs = 400;
  }

  unmount(): void {
    this.mounted = false;
    this.path = [];
    this.minimap?.destroy(); // panel + [M] overlay
    this.hud?.destroy();
    if (this.hudView) {
      this.hudView.destroy({ children: true });
      this.hudView = null;
    }
    this.frame.destroy({ children: true });
    this.atmos?.destroy(); // releases the fog canvas texture (GPU side)
    this.atmos = null;
    this.tileCells = [];
    this.chestViews = [];
    this.eventViews = [];
    this.packViews = [];
    this.trailDots = [];
  }

  onKey(key: string): boolean {
    this.cancelAutoWalk(); // any keypress cancels auto-walk (§9.4)
    if (this.hud.onKey(key)) return true;
    if (this.minimap.overlayOpen) {
      if (key === "m" || key === "esc") this.minimap.toggleOverlay();
      return true; // the large map swallows everything else
    }
    for (const [k, dir] of KEY_DIRS) {
      if (key === k) {
        this.requestStep(dir);
        return true;
      }
    }
    switch (key) {
      case "esc":
        this.ctx.scenes.pushOverlay("pause");
        return true;
      case "m":
        this.minimap.toggleOverlay();
        return true;
      case "tab":
        this.tryOpenMarching();
        return true;
      case "e":
      case "enter":
      case "space":
        this.tryDescend();
        return true;
      default:
        return false;
    }
  }

  update(dtMs: number): void {
    if (!this.mounted) return;
    this.t += dtMs;

    // camera lerp 0.15/frame (frame-rate normalized), clamped to bounds
    const target = this.camTarget();
    const k = 1 - Math.pow(0.85, dtMs / 16.67);
    this.cam.x += (target.x - this.cam.x) * k;
    this.cam.y += (target.y - this.cam.y) * k;
    this.applyCamera();

    // the lantern rides the tweened party marker, not the logical tile
    this.atmos?.update(dtMs, this.partyView.x, this.partyView.y);

    // held-repeat on tween completion (~9 steps/s) + auto-walk
    if (!this.busy && !this.blocked()) {
      if (this.path.length > 0) this.autoWalkTick();
      else {
        const dir = this.heldDir();
        if (dir) this.requestStep(dir);
      }
    }

    // chained fight straight after a battle (dungeon.md §14)
    if (this.mountContactMs > 0) {
      this.mountContactMs -= dtMs;
      if (this.mountContactMs <= 0) {
        const c = contactCheck(this.floor);
        if (c) this.dispatchTrigger(c);
      }
    }

    // ambience (visual only)
    const bob = Math.sin(this.t / 300) * 3;
    const sparkle = 0.8 + 0.2 * Math.sin(this.t / 400);
    for (const ev of this.eventViews) {
      if (ev.q) ev.q.y = -2 + bob;
      if (ev.sprite) {
        ev.sprite.alpha = sparkle;
        ev.sprite.y = bob * 0.6;
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.t / 160);
    for (const pv of this.packViews) {
      pv.alert.alpha = 0.4 + 0.6 * pulse;
      if (pv.glow) pv.glow.alpha = 0.2 + 0.25 * pulse;
    }
    this.stairsBeacon.alpha =
      0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.t / 520));

    this.hud.update(dtMs);
    this.minimap.update(dtMs);
  }

  /* ------------------------------ input ----------------------------- */

  private blocked(): boolean {
    return this.hud.blocksWorld || this.minimap.overlayOpen;
  }

  private heldDir(): StepDir | null {
    for (const [k, dir] of KEY_DIRS) if (isKeyDown(k)) return dir;
    return null;
  }

  private tryOpenMarching(): void {
    if (this.chaserNear()) {
      this.hud.showToast("No re-shuffling mid-pounce!");
      return;
    }
    this.hud.openMarching();
  }

  /** A chasing pack within 3 tiles blocks the Tab panel (dungeon.md §9.2). */
  private chaserNear(): boolean {
    for (const e of this.floor.entities) {
      if (!isPack(e) || e.dead || e.state !== "chase") continue;
      const d = Math.max(
        Math.abs(e.x - this.floor.party.x),
        Math.abs(e.y - this.floor.party.y),
      );
      if (d <= 3) return true;
    }
    return false;
  }

  private tryDescend(): void {
    const f = this.floor;
    const onStairs =
      f.tiles[idx(f.w, f.party.x, f.party.y)] === Tile.StairsDown;
    if (!onStairs || f.stairsLocked) return;
    const run = this.ctx.run as RunState;
    if (run.floorNum >= FLOOR_COUNT) {
      // floor 6 exit = The Sunbeam; normally battle → results handles the win
      this.ctx.scenes.goto("results", { victory: true });
    } else {
      this.ctx.scenes.goto("landing");
    }
  }

  /* --------------------------- step driving ------------------------- */

  private requestStep(dir: StepDir): void {
    if (this.busy || this.blocked() || !this.mounted) return;
    const f = this.floor;
    const before = { x: f.party.x, y: f.party.y };
    const trigger = step(f, dir);

    this.minimap.setFacing(dir); // the map marker points where we last went

    if (trigger.t === "bump") {
      // wall bump: no step consumed, quick nudge (visual only)
      this.busy = true;
      const [dx, dy] = DIR_VEC[dir];
      const bx = tileCx(before.x);
      const by = tileCy(before.y);
      tween(this.partyView.position, { x: bx + dx * 6, y: by + dy * 6 }, 50);
      const hold = { t: 0 };
      tween(hold, { t: 1 }, 55, "linear", () => {
        if (!this.mounted) return;
        tween(this.partyView.position, { x: bx, y: by }, 50, "quadOut", () => {
          this.busy = false;
        });
      });
      return;
    }

    this.refreshTerrain();
    this.refreshEntities(true);
    this.minimap.refresh();
    this.updateObjective();
    this.checkBossReveal();

    const moved = f.party.x !== before.x || f.party.y !== before.y;
    this.busy = true;
    if (moved) {
      this.trail.unshift({ x: tileCx(before.x), y: tileCy(before.y) });
      if (this.trail.length > 3) this.trail.pop();
      this.trailDots.forEach((dot, i) => {
        const to = this.trail[i] ?? this.trail[this.trail.length - 1];
        if (to) tween(dot.position, { x: to.x, y: to.y }, STEP_MS);
      });
      tween(
        this.partyView.position,
        { x: tileCx(f.party.x), y: tileCy(f.party.y) },
        STEP_MS,
        "linear",
        () => {
          if (!this.mounted) return;
          this.busy = false;
          this.postStep(trigger);
        },
      );
    } else {
      // chest bump: step consumed, party stays put — pop the chest open
      if (trigger.t === "chest") {
        const cv = this.chestViews.find((c) => c.e.id === trigger.chestId);
        if (cv) {
          tween(cv.view.scale, { x: 1.2, y: 1.2 }, 90, "quadOut", () => {
            tween(cv.view.scale, { x: 1, y: 1 }, 120);
          });
        }
      }
      const hold = { t: 0 };
      tween(hold, { t: 1 }, 180, "linear", () => {
        if (!this.mounted) return;
        this.busy = false;
        this.postStep(trigger);
      });
    }
  }

  private postStep(trigger: StepTrigger): void {
    if (this.stickyDescend && trigger.t !== "stairs") {
      this.stickyDescend = false;
      this.hud.hideToast();
    }
    this.dispatchTrigger(trigger);
  }

  /** Route a StepTrigger to the right scene/overlay (ARCHITECTURE §3.2). */
  private dispatchTrigger(trigger: StepTrigger): void {
    const run = this.ctx.run as RunState;
    switch (trigger.t) {
      case "battle":
        this.cancelAutoWalk();
        this.ctx.scenes.goto("battle", trigger);
        break;
      case "event":
        this.cancelAutoWalk();
        this.ctx.scenes.goto("event", trigger);
        break;
      case "chest":
        this.cancelAutoWalk();
        this.openChest(trigger.chestId);
        break;
      case "stairs":
        if (trigger.locked) {
          this.hud.showToast("Something huge is still humming in there.");
        } else {
          this.stickyDescend = true;
          this.hud.showToast(
            run.floorNum >= FLOOR_COUNT
              ? "Step into the Sunbeam? [Enter]"
              : `Descend to floor ${run.floorNum + 1}? [Enter]`,
            0,
          );
        }
        break;
      case "moved":
      case "bump":
        break;
    }
  }

  private openChest(chestId: number): void {
    const run = this.ctx.run as RunState;
    const chest = this.floor.entities[chestId];
    if (!chest || chest.kind !== "chest") return;
    const rng = mulberry32(chest.chestSeed); // fresh stream per open (§4)
    const lctx: LootCtx = {
      floor: run.floorNum,
      livingClasses: run.cats.filter((c) => c.lives > 0).map((c) => c.classId),
      uniquesDropped: run.uniquesDropped,
      nextUid: run.inventory.nextUid,
      currentShinies: run.inventory.shinies,
    };
    const isHoard = chest.lootTableId === "boss_hoard";
    const grant = isHoard ? rollBossLoot(rng, lctx) : rollChest(rng, lctx);
    this.refreshEntities(false); // opened tint
    this.updateObjective();
    const params: LootOverlayParams = {
      variant: isHoard ? "boss" : "chest",
      grant,
    };
    this.ctx.scenes.pushOverlay("loot", params);
  }

  /** Belt use: Tuna Snack / Sardine Tin only (GDD §7 ruling). */
  private useConsumable(defId: ItemId, catIndex: number): void {
    const run = this.ctx.run as RunState;
    const def = CONSUMABLES[defId];
    const healSpec = def?.explore?.heal;
    if (healSpec === undefined) return;
    const cat = run.cats[catIndex];
    if (!cat || cat.lives <= 0) return;
    const max = maxHp(cat, run.level);
    if (cat.hp >= max) {
      this.hud.showToast(`${CONSUMABLES[defId].name}: already at full HP`);
      return;
    }
    const { inv, removed } = removeConsumable(run.inventory, defId, 1);
    if (removed < 1) return;
    const heal =
      healSpec === "full" ? max - cat.hp : Math.min(healSpec, max - cat.hp);
    const cats = run.cats.map((c, i) =>
      i === catIndex ? { ...c, hp: c.hp + heal } : c,
    );
    this.ctx.run = { ...run, cats, inventory: inv };
    this.hud.showToast(`${def.name}: +${heal} HP`);
  }

  /* ------------------------- click-to-path --------------------------- */

  private onWorldTap(e: FederatedPointerEvent): void {
    if (this.blocked() || !this.mounted) return;
    const local = this.scroller.toLocal(e.global);
    const tx = Math.floor(local.x / TILE);
    const ty = Math.floor(local.y / TILE);
    const f = this.floor;
    if (!inBounds(f.w, f.h, tx, ty)) return;
    const i = idx(f.w, tx, ty);
    if (!f.explored[i] || f.tiles[i] === Tile.Wall) return;
    const path = this.findPath(tx, ty);
    if (!path || path.length === 0) return;
    this.path = path;
    this.pathBaseline = this.visiblePackIds();
    this.drawPawDots();
  }

  /** BFS over explored, passable tiles — N, E, S, W, FIFO (dungeon.md §9.4). */
  private findPath(
    tx: number,
    ty: number,
  ): { dir: StepDir; x: number; y: number }[] | null {
    const f = this.floor;
    const start = idx(f.w, f.party.x, f.party.y);
    const goal = idx(f.w, tx, ty);
    if (start === goal) return null;
    const prev = new Int32Array(f.w * f.h).fill(-2); // -2 unvisited
    prev[start] = -1;
    const queue = [start];
    let head = 0;
    const dirs: [StepDir, number, number][] = [
      ["N", 0, -1],
      ["E", 1, 0],
      ["S", 0, 1],
      ["W", -1, 0],
    ];
    while (head < queue.length && prev[goal] === -2) {
      const cur = queue[head++];
      const cx = cur % f.w;
      const cy = (cur - cx) / f.w;
      for (const [, dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(f.w, f.h, nx, ny)) continue;
        const ni = idx(f.w, nx, ny);
        if (prev[ni] !== -2) continue;
        if (!f.explored[ni] || f.tiles[ni] === Tile.Wall) continue;
        prev[ni] = cur;
        queue.push(ni);
      }
    }
    if (prev[goal] === -2) return null;
    // reconstruct goal → start, then reverse into per-step directions
    const rev: { dir: StepDir; x: number; y: number }[] = [];
    let cur = goal;
    while (prev[cur] !== -1) {
      const par = prev[cur];
      const cx = cur % f.w;
      const cy = (cur - cx) / f.w;
      const px = par % f.w;
      const py = (par - px) / f.w;
      const dir = dirs.find(([, dx, dy]) => px + dx === cx && py + dy === cy);
      if (!dir) return null;
      rev.push({ dir: dir[0], x: cx, y: cy });
      cur = par;
    }
    return rev.reverse();
  }

  private visiblePackIds(): Set<number> {
    const f = this.floor;
    const out = new Set<number>();
    for (const e of f.entities) {
      if (isPack(e) && !e.dead && f.visible.has(idx(f.w, e.x, e.y))) {
        out.add(e.id);
      }
    }
    return out;
  }

  private autoWalkTick(): void {
    const f = this.floor;
    // cancel: a roamer ENTERED the visible set since the walk began
    for (const id of this.visiblePackIds()) {
      if (!this.pathBaseline.has(id)) {
        this.cancelAutoWalk();
        return;
      }
    }
    const next = this.path[0];
    // cancel: the next step would land adjacent to a visible roamer
    for (const e of f.entities) {
      if (!isPack(e) || e.dead || e.state === "stunned") continue;
      if (!f.visible.has(idx(f.w, e.x, e.y))) continue;
      if (Math.abs(e.x - next.x) + Math.abs(e.y - next.y) <= 1) {
        this.cancelAutoWalk();
        return;
      }
    }
    this.path.shift();
    this.drawPawDots();
    this.requestStep(next.dir);
    if (this.path.length === 0) this.pawDots.clear();
  }

  private cancelAutoWalk(): void {
    if (this.path.length === 0) return;
    this.path = [];
    this.pawDots.clear();
  }

  private drawPawDots(): void {
    this.pawDots.clear();
    for (const p of this.path) {
      drawPaw(this.pawDots, tileCx(p.x), tileCy(p.y), 1.2, true, PAL.text);
    }
    this.pawDots.alpha = 0.45;
  }

  /* ---------------------------- rendering ---------------------------- */

  /**
   * The framed viewport: the bezel, the masked world, the vignette, the inner
   * border, and one transparent hit pad that owns click-to-path (so taps
   * outside the frame never reach the world).
   *
   * The bezel is drawn as concentric RINGS rather than a kit `panel()`: the
   * world fills the viewport opaquely, so a ~1000×580 filled panel (plus its
   * six shadow layers and seven sheen bands) would be a screenful of blend
   * work per frame that nobody ever sees. Same tokens, same look, a fraction
   * of the fill.
   */
  private buildFrame(): Container {
    const frame = new Container();
    const bezel = new Graphics();
    for (let i = 4; i >= 1; i--) {
      bezel
        .roundRect(
          VX - 6 - i * 2,
          VY - 6 - i * 2 + 2,
          VW + 12 + i * 4,
          VH + 12 + i * 4,
          RADIUS.panel + i * 2,
        )
        .stroke({
          width: 6,
          color: PAL.shadow,
          alpha: 0.16 * (1 - i / 5),
          alignment: 0.5,
        });
    }
    bezel
      .roundRect(VX - 6, VY - 6, VW + 12, VH + 12, RADIUS.panel + 3)
      .stroke({ width: 12, color: PAL.panel, alignment: 0.5 })
      .roundRect(VX - 12, VY - 12, VW + 24, VH + 24, RADIUS.panel + 6)
      .stroke({ width: 1, color: PAL.border, alignment: 0.5 });
    frame.addChild(bezel);

    const clip = new Container();
    clip.addChild(this.worldWrap);
    const mask = new Graphics()
      .roundRect(VX, VY, VW, VH, RADIUS.panel)
      .fill(0xffffff);
    clip.mask = mask;
    frame.addChild(clip, mask);

    const vig = vignette(VW, VH, 0.85);
    vig.position.set(VX, VY);
    frame.addChild(vig);

    frame.addChild(
      new Graphics()
        .roundRect(VX, VY, VW, VH, RADIUS.panel)
        .stroke({ width: 2, color: PAL.border, alignment: 0.5 }),
    );

    const pad = new Graphics()
      .roundRect(VX, VY, VW, VH, RADIUS.panel)
      .fill({ color: PAL.void, alpha: 0 });
    pad.eventMode = "static";
    pad.on("pointertap", (e: FederatedPointerEvent) => this.onWorldTap(e));
    frame.addChild(pad);

    return frame;
  }

  /**
   * Tile cells, built ONCE per mount: one Container per tile holding the env
   * texture sprite (LINEAR-scaled 512² squares → 48 px cells) with the
   * original procedural Graphics recipe as per-cell fallback, so the game
   * stays fully playable assetless. Cells stay hidden until their tile is
   * explored — the rock field beneath is what "unexplored" looks like.
   *
   * Dressing passes: the boss-lair door gets tile:doorBoss, chest-bearing
   * dead-end alcoves get tile:nook under the chest. Floor variants are picked
   * by a pure (x, y) hash — zero draws from the gameplay RNG streams.
   */
  private buildTiles(): Container {
    const f = this.floor;
    const th = THEMES[themeIndex(f.floor)];
    const floorWash = mix(PAL.text, th.accent, 0.35);
    const wrap = new Container();
    this.tileCells = new Array<Container>(f.w * f.h);
    this.revealed = new Uint8Array(f.w * f.h);

    // boss-lair door tiles: doors 4-adjacent to the lair room (§8)
    const bossDoors = new Set<number>();
    const boss = f.entities.find((e) => e.kind === "boss");
    if (boss && isPack(boss)) {
      const lair = f.rooms[boss.homeRoom];
      if (lair) {
        const inLair = (x: number, y: number): boolean =>
          x >= lair.x &&
          x < lair.x + lair.w &&
          y >= lair.y &&
          y < lair.y + lair.h;
        for (let y = 0; y < f.h; y++) {
          for (let x = 0; x < f.w; x++) {
            if (f.tiles[idx(f.w, x, y)] !== Tile.Door) continue;
            if (
              inLair(x - 1, y) ||
              inLair(x + 1, y) ||
              inLair(x, y - 1) ||
              inLair(x, y + 1)
            ) {
              bossDoors.add(idx(f.w, x, y));
            }
          }
        }
      }
    }

    // chest-nook alcoves: chest tiles walled on 3 sides (populate §6.3)
    const nooks = new Set<number>();
    for (const e of f.entities) {
      if (e.kind !== "chest") continue;
      let walls = 0;
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const nx = e.x + dx;
        const ny = e.y + dy;
        if (
          !inBounds(f.w, f.h, nx, ny) ||
          f.tiles[idx(f.w, nx, ny)] === Tile.Wall
        ) {
          walls++;
        }
      }
      if (walls === 3) nooks.add(idx(f.w, e.x, e.y));
    }

    /** Add a textured cell; false = caller draws the procedural cell. */
    const addCell = (id: string, into: Container): boolean => {
      const tex = spriteTextureFor(id);
      if (!tex) return false;
      const s = new Sprite(tex);
      s.width = TILE;
      s.height = TILE;
      into.addChild(s);
      return true;
    };

    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = idx(f.w, x, y);
        const t = f.tiles[i];
        const cell = new Container();
        cell.position.set(x * TILE, y * TILE);
        cell.visible = false;

        if (t === Tile.Wall || t === Tile.Door) {
          const id =
            t === Tile.Door
              ? bossDoors.has(i) && spriteTextureFor("tile:doorBoss")
                ? "tile:doorBoss"
                : "tile:door"
              : "tile:wall";
          if (!addCell(id, cell)) {
            const g = new Graphics();
            g.rect(0, 0, TILE, TILE).fill(th.wallFace);
            g.rect(0, 0, TILE, 8).fill(th.wallTop);
            if (t === Tile.Door) {
              // 32×40 floorA arch inset (ui-art §7)
              g.roundRect(8, 8, 32, 40, 10).fill(th.floorA);
            }
            cell.addChild(g);
          }
        } else {
          let id: string;
          if (t === Tile.StairsDown) id = "tile:stairsDown";
          else if (t === Tile.StairsUp) id = "tile:stairsUp";
          else id = FLOOR_VARIANTS[tileHash(x, y) % FLOOR_VARIANTS.length];
          if (!addCell(id, cell)) {
            const g = new Graphics();
            g.rect(0, 0, TILE, TILE).fill(
              (x + y) % 2 === 0 ? th.floorA : th.floorB,
            );
            g.rect(1, 1, TILE - 2, TILE - 2).stroke({
              width: 1,
              color: th.wallFace,
              alpha: 0.15,
            });
            if (t === Tile.StairsDown) {
              drawStairs(g, TILE / 2, TILE / 2);
            } else if (t === Tile.StairsUp) {
              // scenery spawn stair: dim swirl ("the way back collapsed")
              g.circle(TILE / 2, TILE / 2, 16).fill(PAL.void);
              g.circle(TILE / 2, TILE / 2, 9).stroke({
                width: 2,
                color: PAL.textDim,
              });
            }
            cell.addChild(g);
          }
          // WALKABLE WASH: the floor and wall tile art are both dark masonry,
          // so a warm lift on every walkable cell is what makes rooms and
          // corridors read as paths instead of more rock. Per-cell (not one
          // big layer) so it is hidden with its cell and can never leak the
          // shape of unexplored ground through the fog.
          cell.addChild(
            new Graphics()
              .rect(0, 0, TILE, TILE)
              .fill({ color: floorWash, alpha: 0.13 }),
          );
          // alcove dressing under the chest (alpha-keyed, above the floor)
          if (nooks.has(i)) addCell("tile:nook", cell);
        }
        this.tileCells[i] = cell;
        wrap.addChild(cell);
      }
    }
    return wrap;
  }

  /**
   * Reveal newly explored tile cells and rebuild the fog field. Explored is
   * monotonic, so a cell only ever goes hidden → shown.
   */
  private refreshTerrain(): void {
    const f = this.floor;
    for (let i = 0; i < this.tileCells.length; i++) {
      if (this.revealed[i] === 1 || !f.explored[i]) continue;
      this.revealed[i] = 1;
      this.tileCells[i].visible = true;
    }
    this.atmos?.refresh();
    this.drawStairsBeacon();
  }

  /**
   * A soft gold halo + swirl over any known stairs-down, drawn ABOVE the fog
   * so the floor's goal can never be lost in the dark (lighting must never
   * cost readability).
   */
  private drawStairsBeacon(): void {
    const f = this.floor;
    const g = this.stairsBeacon;
    g.clear();
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = idx(f.w, x, y);
        if (!f.explored[i] || f.tiles[i] !== Tile.StairsDown) continue;
        const cx = tileCx(x);
        const cy = tileCy(y);
        g.circle(cx, cy, TILE * 0.7).fill({ color: PAL.heal, alpha: 0.1 });
        g.circle(cx, cy, TILE * 0.42).fill({ color: PAL.gold, alpha: 0.12 });
        drawStairs(g, cx, cy);
      }
    }
  }

  private buildEntities(into: Container): void {
    const f = this.floor;
    const th = THEMES[themeIndex(f.floor)];
    for (const e of f.entities) {
      if (e.kind === "chest") {
        const view = new Container();
        const hoard = e.lootTableId === "boss_hoard";
        const tex = spriteTextureFor(hoard ? "prop:hoardChest" : "prop:chest");
        let sprite: Sprite | null = null;
        view.addChild(
          new Graphics()
            .ellipse(0, 14, 18, 6)
            .fill({ color: PAL.void, alpha: 0.45 }),
        );
        if (tex) {
          sprite = new Sprite({ texture: tex, anchor: 0.5 });
          sprite.width = TILE - 4;
          sprite.height = TILE - 4;
          view.addChild(sprite);
        } else {
          const g = new Graphics();
          drawChest(g, 0, 0);
          view.addChild(g);
        }
        view.position.set(tileCx(e.x), tileCy(e.y) + 4);
        into.addChild(view);
        this.chestViews.push({ e, view, opened: !e.opened, sprite, hoard });
      } else if (e.kind === "event") {
        const view = new Container();
        const tex = spriteTextureFor("prop:eventSparkle");
        let sprite: Sprite | null = null;
        let q: Text | null = null;
        view.addChild(
          new Graphics()
            .circle(0, 0, 20)
            .fill({ color: PAL.stFrazzled, alpha: 0.16 }),
        );
        if (tex) {
          sprite = new Sprite({ texture: tex, anchor: 0.5 });
          sprite.width = TILE - 6;
          sprite.height = TILE - 6;
          view.addChild(sprite);
        } else {
          view.addChild(new Graphics().circle(0, 0, 14).fill(PAL.panel));
          q = new Text({
            text: "?",
            style: display(22, { fill: th.accent, stroke: worldStroke(22) }),
          });
          q.anchor.set(0.5);
          q.position.set(0, -2);
          view.addChild(q);
        }
        view.position.set(tileCx(e.x), tileCy(e.y));
        into.addChild(view);
        this.eventViews.push({ e, view, q, sprite });
      } else {
        const view = new Container();
        const isBoss = e.kind === "boss";
        let glow: Graphics | null = null;
        if (isBoss) {
          glow = new Graphics()
            .ellipse(0, 4, 46, 13)
            .fill({ color: PAL.danger, alpha: 0.35 });
          view.addChild(glow);
        } else {
          view.addChild(
            new Graphics()
              .ellipse(0, 6, 16, 6)
              .fill({ color: packTierColor(e), alpha: 0.55 }),
          );
        }
        const look = ENEMIES[e.enemies[0]]?.look ?? {
          family: "vermin" as const,
          sizeGrade: "standard" as const,
          tier: 1 as const,
        };
        const tokenTex = spriteTextureFor(`token:${look.family}`);
        if (tokenTex) {
          const token = new Sprite({ texture: tokenTex, anchor: 0.5 });
          // roamer ≈ one cell; boss reads ≈ 2 tiles wide (dungeon.md §8.2)
          const size = isBoss ? TILE * 1.8 : TILE - 6;
          token.width = size;
          token.height = size;
          token.y = isBoss ? -6 : 2;
          view.addChild(token);
        } else {
          const body = new Graphics();
          drawEnemy(body, look);
          // silhouette ≈ 34px tall (boss ≈ 2 tiles wide, dungeon.md §8.2)
          body.scale.set(isBoss ? 0.62 : 0.36);
          body.y = 4;
          view.addChild(body);
          const glyph = new Text({
            text: e.enemies[0]?.[0] ?? "?",
            style: mono(12, { stroke: worldStroke(12) }),
          });
          glyph.anchor.set(0.5);
          glyph.position.set(0, 10);
          view.addChild(glyph);
        }
        const alert = new Graphics().circle(12, -34, 4).fill(PAL.danger);
        alert.visible = false;
        view.addChild(alert);
        view.position.set(tileCx(e.x), tileCy(e.y));
        into.addChild(view);
        this.packViews.push({ e, view, alert, glow, prevState: e.state });
      }
    }
  }

  private buildParty(): void {
    const run = this.ctx.run as RunState;
    this.partyView
      .removeChildren()
      .forEach((c) => c.destroy({ children: true }));
    for (const d of this.trailDots) d.destroy();
    this.trailDots = [];

    const px = tileCx(this.floor.party.x);
    const py = tileCy(this.floor.party.y);
    this.trail = [
      { x: px, y: py },
      { x: px, y: py },
      { x: px, y: py },
    ];

    // grounding shadow keeps the marker sitting ON the floor, not over it
    this.partyView.addChild(
      new Graphics()
        .ellipse(0, 16, 17, 6)
        .fill({ color: PAL.void, alpha: 0.5 }),
    );

    const partyTex = spriteTextureFor("token:party");
    if (partyTex) {
      // generated four-cat cluster token — the whole party in one marker,
      // so the lead ring + trailing dots stay procedural-only.
      const token = new Sprite({ texture: partyTex, anchor: 0.5 });
      token.width = TILE - 2;
      token.height = TILE - 2;
      this.partyView.addChild(token);
      this.partyView.position.set(px, py);
      return;
    }

    const lead = run.marchingOrder[0] ?? run.cats[0].classId;
    const ring = new Graphics()
      .circle(0, 0, 18)
      .fill(PAL.panel)
      .stroke({ width: 2, color: PAL[lead].outline });
    const head = new Graphics();
    drawCatPortrait(head, lead);
    head.scale.set(32 / 48);
    this.partyView.addChild(ring, head);

    // 3 trailing dots in the other cats' body colors (ui-art §7)
    run.marchingOrder.slice(1, 4).forEach((cls) => {
      const dot = new Graphics().circle(0, 0, 4).fill(PAL[cls].body);
      dot.position.set(px, py);
      // insert beneath the lead marker, above the entity layer
      this.scroller.addChildAt(
        dot,
        this.scroller.getChildIndex(this.partyView),
      );
      this.trailDots.push(dot);
    });
    this.partyView.position.set(px, py);
  }

  /** Entity culling + roamer markers after a step (or on demand). */
  private refreshEntities(animate: boolean): void {
    const f = this.floor;
    for (const cv of this.chestViews) {
      const i = idx(f.w, cv.e.x, cv.e.y);
      cv.view.visible = f.explored[i] === 1;
      cv.view.alpha = f.visible.has(i)
        ? KNOWN_ALPHA.visible
        : KNOWN_ALPHA.remembered;
      if (cv.e.opened !== cv.opened) {
        cv.opened = cv.e.opened;
        // sprite chests swap to the open art; hoard (no open variant) and
        // procedural chests keep the dim-tint treatment
        const openTex =
          cv.sprite && !cv.hoard && cv.e.opened
            ? spriteTextureFor("prop:chestOpen")
            : null;
        if (cv.sprite && openTex) cv.sprite.texture = openTex;
        else cv.view.tint = cv.e.opened ? PAL.textDim : 0xffffff;
      }
    }
    for (const ev of this.eventViews) {
      const i = idx(f.w, ev.e.x, ev.e.y);
      ev.view.visible = !ev.e.used && f.explored[i] === 1;
      ev.view.alpha = f.visible.has(i)
        ? KNOWN_ALPHA.visible
        : KNOWN_ALPHA.remembered;
    }
    for (const pv of this.packViews) {
      const e = pv.e;
      if (e.dead) {
        pv.view.visible = false;
        continue;
      }
      // roamers render only while their tile is currently visible (§10)
      pv.view.visible = f.visible.has(idx(f.w, e.x, e.y));
      const tx = tileCx(e.x);
      const ty = tileCy(e.y);
      if (animate && pv.view.visible) {
        tween(pv.view.position, { x: tx, y: ty }, STEP_MS);
      } else {
        pv.view.position.set(tx, ty);
      }
      pv.view.alpha = e.state === "stunned" ? 0.6 : 1;
      pv.alert.visible = e.kind === "roamer" && canSeeParty(f, e);
      if (e.state !== pv.prevState) {
        if (e.state === "chase" && pv.view.visible) {
          this.popMarker("!", PAL.danger, tx, ty); // pounce tell (§12)
        } else if (pv.prevState === "chase" && e.state === "return") {
          if (pv.view.visible) this.popMarker("?", PAL.textDim, tx, ty);
        }
        pv.prevState = e.state;
      }
    }
  }

  /** The "THIS FLOOR" readout in the right column (presentation only). */
  private updateObjective(): void {
    const f = this.floor;
    let stairsKnown = false;
    for (let i = 0; i < f.tiles.length && !stairsKnown; i++) {
      if (f.tiles[i] === Tile.StairsDown && f.explored[i]) stairsKnown = true;
    }
    const lines: { text: string; tone?: number }[] = [];
    if (!stairsKnown) {
      lines.push({ text: "The way down is still hidden. Keep sniffing." });
    } else if (f.stairsLocked) {
      lines.push({
        text: "Stairs found — but something huge still hums in its lair.",
        tone: PAL.danger,
      });
    } else {
      lines.push({
        text: "Stairs found. Stand on them and press [E].",
        tone: PAL.heal,
      });
    }
    let packs = 0;
    let chests = 0;
    for (const e of f.entities) {
      if (isPack(e) && !e.dead) packs++;
      if (
        e.kind === "chest" &&
        !e.opened &&
        f.explored[idx(f.w, e.x, e.y)] === 1
      ) {
        chests++;
      }
    }
    lines.push({
      text:
        packs === 0
          ? "Floor cleared — nothing prowls."
          : `Packs left: ${packs}`,
      ...(packs === 0 ? { tone: PAL.heal } : {}),
    });
    if (chests > 0) {
      lines.push({ text: `Unopened chests seen: ${chests}`, tone: PAL.gold });
    }
    this.hud.setObjective(lines);
  }

  /** Floating '!' / '?' over a roamer (dungeon.md §12). Fire-and-forget. */
  private popMarker(glyph: string, color: number, x: number, y: number): void {
    const t = new Text({
      text: glyph,
      style: display(22, { fill: color, stroke: worldStroke(22) }),
    });
    t.anchor.set(0.5);
    t.position.set(x, y - 44);
    t.scale.set(1.4);
    this.fx.addChild(t);
    tween(t.scale, { x: 1, y: 1 }, 120, "backOut");
    const hold = { v: 0 };
    tween(hold, { v: 1 }, 650, "linear", () => {
      if (!this.mounted) return;
      tween(t, { alpha: 0 }, 200, "linear", () => {
        if (t.destroyed) return;
        if (t.parent) t.parent.removeChild(t);
        t.destroy();
      });
    });
  }

  /** Growl line the moment the boss lair lights up (dungeon.md §8.3). */
  private checkBossReveal(): void {
    if (this.bossGrowled) return;
    const f = this.floor;
    for (const e of f.entities) {
      if (e.kind !== "boss" || e.dead) continue;
      if (f.visible.has(idx(f.w, e.x, e.y))) {
        this.bossGrowled = true;
        this.hud.showToast("Something huge growls from its lair…", 3200);
      }
    }
  }

  /* ----------------------------- camera ------------------------------ */

  /**
   * Where the camera wants to be, in world px. A floor smaller than the
   * viewport is CENTRED (no lop-sided margin); a larger one follows the
   * party, clamped so the frame never shows past the floor's edge.
   */
  private camTarget(): { x: number; y: number } {
    const f = this.floor;
    const wpx = f.w * TILE;
    const hpx = f.h * TILE;
    const px = tileCx(f.party.x);
    const py = tileCy(f.party.y);
    return {
      x:
        wpx <= VIS_W
          ? wpx / 2
          : Math.min(Math.max(px, VIS_W / 2), wpx - VIS_W / 2),
      y:
        hpx <= VIS_H
          ? hpx / 2
          : Math.min(Math.max(py, VIS_H / 2), hpx - VIS_H / 2),
    };
  }

  private applyCamera(): void {
    this.worldWrap.position.set(
      Math.round(VX + VW / 2 - this.cam.x * ZOOM),
      Math.round(VY + VH / 2 - this.cam.y * ZOOM),
    );
    // publish the viewport rectangle to the minimap (throttled to whole px)
    const cx = Math.round(this.cam.x);
    const cy = Math.round(this.cam.y);
    if (cx !== this.camPublished.x || cy !== this.camPublished.y) {
      this.camPublished = { x: cx, y: cy };
      this.minimap.setCamera(cx - VIS_W / 2, cy - VIS_H / 2, VIS_W, VIS_H);
    }
  }
}

/** Factory for the scene registry (WP-09 wires it by id 'explore'). */
export const createExploreScene = (): ExploreScene => new ExploreScene();
