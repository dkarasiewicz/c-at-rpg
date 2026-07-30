/**
 * WP-10 — the explore scene (ui-art §7, dungeon.md §§9-12, gameloop.md §§1,3).
 *
 * Renders the current FloorState (tile layer drawn once, per-tile fog
 * sprites updated only for tiles whose knowledge state changed, entity
 * blobs culled by knowledge state, camera lerp + clamp) and drives the
 * core step loop: one `step(floor, dir)` per input, held-repeat on tween
 * completion (~9/s), click-to-path auto-walk, and every StepTrigger
 * dispatched to the right scene/overlay. The UI never computes gameplay
 * outcomes — it renders core state and hands triggers up.
 *
 * Scene/GameCtx shapes below are structural mirrors of ARCHITECTURE.md §3;
 * `ui/sceneManager.ts` (WP-09) is their canonical home.
 */
import { Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import { Tile } from "../../core/types";
import type {
  Entity,
  FloorState,
  ItemId,
  Roamer,
  RunState,
  StepTrigger,
} from "../../core/types";
import { mulberry32 } from "../../core/rng";
import { idx, inBounds, recomputeVisibility } from "../../core/dungeon/floor";
import {
  applyFlee,
  contactCheck,
  step,
  type StepDir,
} from "../../core/dungeon/step";
import { canSeeParty } from "../../core/dungeon/roamers";
import { FLOOR_COUNT, generateCurrentFloor } from "../../core/run/runState";
import { maxHp } from "../../core/run/party";
import { removeConsumable } from "../../core/loot/inventory";
import { rollBossLoot, rollChest, type LootCtx } from "../../core/loot/roll";
import { ENEMIES } from "../../content/enemies";
import { CONSUMABLES } from "../../content/consumables";
import { PAL, THEMES } from "../palette";
import { R, rh } from "../layout";
import { display, mono, worldStroke } from "../textStyles";
import { tween } from "../tween";
import { isKeyDown } from "../input";
import { drawCatPortrait, drawPaw } from "../draw/cats";
import { drawEnemy } from "../draw/enemies";
import { drawChest, drawStairs } from "../draw/glyphs";
import { layer, type GameCtx, type Scene } from "../sceneManager";
import type { LootOverlayParams } from "../overlays/loot";
import { ExploreHud, themeIndex } from "./exploreHud";
import { makeMinimap, type Minimap } from "./minimap";

/** Optional mount params: a battle scene reports a flee so the pack stuns. */
export interface ExploreParams {
  fled?: { roamerId: number };
}

/* ---------------------------------------------------------------------- */
/* constants & small helpers                                               */
/* ---------------------------------------------------------------------- */

const TILE = R.explore.tileSize; // 48
const VIEW_W = 1280;
const VIEW_H = rh(R.explore.viewport); // 632
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

const isPack = (e: Entity): e is Roamer =>
  e.kind === "roamer" || e.kind === "boss";

const tileCx = (x: number): number => x * TILE + TILE / 2;
const tileCy = (y: number): number => y * TILE + TILE / 2;

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
}
interface EventView {
  e: EventEntity;
  view: Container;
  q: Text;
}

/* ---------------------------------------------------------------------- */
/* the scene                                                               */
/* ---------------------------------------------------------------------- */

export class ExploreScene implements Scene {
  private ctx!: GameCtx;
  private floor!: FloorState;
  private mounted = false;

  private hudView: Container | null = null;
  private scroller = new Container();
  private fx = new Container();
  private fogLayer = new Container();

  private fogSprites: Sprite[] = [];
  private know!: Uint8Array; // 0 unseen · 1 explored · 2 visible

  private chestViews: ChestView[] = [];
  private eventViews: EventView[] = [];
  private packViews: PackView[] = [];

  private partyView = new Container();
  private trailDots: Graphics[] = [];
  private trail: { x: number; y: number }[] = [];

  private hud!: ExploreHud;
  private minimap!: Minimap;

  private cam = { x: 0, y: 0 };
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

    const p = params as ExploreParams | undefined;
    if (p?.fled) applyFlee(this.floor, p.fled.roamerId);
    recomputeVisibility(this.floor);

    this.mounted = true;

    // world-space stack: tiles → entities → party → fog → fx (markers)
    this.scroller = new Container();
    const tiles = new Graphics();
    this.drawTiles(tiles);
    const entityLayer = new Container();
    this.fogLayer = new Container();
    this.fx = new Container();
    this.partyView = new Container();
    this.scroller.addChild(
      tiles,
      entityLayer,
      this.partyView,
      this.fogLayer,
      this.fx,
    );

    this.buildFog();
    this.buildEntities(entityLayer);
    this.buildParty();
    this.pawDots = new Graphics();
    this.fx.addChild(this.pawDots);

    // click-to-path input on the world
    this.scroller.eventMode = "static";
    this.scroller.hitArea = new Rectangle(
      0,
      0,
      this.floor.w * TILE,
      this.floor.h * TILE,
    );
    this.scroller.on("pointertap", (e: FederatedPointerEvent) =>
      this.onWorldTap(e),
    );

    // HUD + minimap + modal overlay
    this.hud = new ExploreHud({
      getRun: () => this.ctx.run as RunState,
      onUseConsumable: (defId, catIndex) => this.useConsumable(defId, catIndex),
      onReorder: (order) => {
        const run = this.ctx.run as RunState;
        this.ctx.run = { ...run, marchingOrder: order };
        this.buildParty(); // lead portrait / trail colors may change
      },
    });
    this.minimap = makeMinimap(this.floor);
    this.hudView = new Container();
    this.hudView.addChild(this.hud.view, this.minimap.view);

    // attach to the labeled root layers (ARCHITECTURE §3.4 / sceneManager)
    layer(root, "world").addChild(this.scroller);
    layer(root, "hud").addChild(this.hudView);
    layer(root, "modal").addChild(this.minimap.overlay);

    // initial knowledge state + camera snap
    this.refreshFogAll();
    this.refreshEntities(false);
    this.minimap.refresh();
    const c = this.camTarget();
    this.cam.x = c.x;
    this.cam.y = c.y;
    this.applyCamera();
    this.checkBossReveal();

    // post-battle chained contact (dungeon.md §14) after a beat
    if (contactCheck(this.floor)) this.mountContactMs = 400;
  }

  unmount(): void {
    this.mounted = false;
    this.path = [];
    this.minimap?.destroy(); // panel + M overlay (uncaches its texture)
    this.hud?.destroy();
    if (this.hudView) {
      this.hudView.destroy({ children: true });
      this.hudView = null;
    }
    this.scroller.destroy({ children: true });
    this.fogSprites = [];
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
    for (const ev of this.eventViews) ev.q.y = -2 + bob;
    const pulse = 0.5 + 0.5 * Math.sin(this.t / 160);
    for (const pv of this.packViews) {
      pv.alert.alpha = 0.4 + 0.6 * pulse;
      if (pv.glow) pv.glow.alpha = 0.2 + 0.25 * pulse;
    }

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
    const prevVis = f.visible;
    const trigger = step(f, dir);

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

    this.refreshFogDiff(prevVis);
    this.refreshEntities(true);
    this.minimap.refresh();
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

  private drawTiles(g: Graphics): void {
    const f = this.floor;
    const th = THEMES[themeIndex(f.floor)];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const t = f.tiles[idx(f.w, x, y)];
        const px = x * TILE;
        const py = y * TILE;
        if (t === Tile.Wall || t === Tile.Door) {
          g.rect(px, py, TILE, TILE).fill(th.wallFace);
          g.rect(px, py, TILE, 8).fill(th.wallTop);
          if (t === Tile.Door) {
            // 32×40 floorA arch inset (ui-art §7)
            g.roundRect(px + 8, py + 8, 32, 40, 10).fill(th.floorA);
          }
        } else {
          g.rect(px, py, TILE, TILE).fill(
            (x + y) % 2 === 0 ? th.floorA : th.floorB,
          );
          g.rect(px + 1, py + 1, TILE - 2, TILE - 2).stroke({
            width: 1,
            color: th.wallFace,
            alpha: 0.15,
          });
          if (t === Tile.StairsDown) {
            drawStairs(g, px + TILE / 2, py + TILE / 2);
          } else if (t === Tile.StairsUp) {
            // scenery spawn stair: dim swirl ("the way back has collapsed")
            g.circle(px + TILE / 2, py + TILE / 2, 16).fill(PAL.void);
            g.circle(px + TILE / 2, py + TILE / 2, 9).stroke({
              width: 2,
              color: PAL.textDim,
            });
          }
        }
      }
    }
  }

  private buildFog(): void {
    const f = this.floor;
    this.know = new Uint8Array(f.w * f.h).fill(255); // force first update
    this.fogSprites = new Array<Sprite>(f.w * f.h);
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const s = new Sprite(Texture.WHITE);
        s.position.set(x * TILE, y * TILE);
        s.width = TILE;
        s.height = TILE;
        this.fogSprites[idx(f.w, x, y)] = s;
        this.fogLayer.addChild(s);
      }
    }
  }

  private setFogTile(i: number): void {
    const f = this.floor;
    const state = f.visible.has(i) ? 2 : f.explored[i] ? 1 : 0;
    if (this.know[i] === state) return;
    this.know[i] = state;
    const s = this.fogSprites[i];
    if (state === 2) {
      s.visible = false; // full color
    } else if (state === 1) {
      s.visible = true; // remembered: dim quad (ui-art §7)
      s.tint = PAL.bgDeep;
      s.alpha = 0.55;
    } else {
      s.visible = true; // unseen: void
      s.tint = PAL.void;
      s.alpha = 1;
    }
  }

  private refreshFogAll(): void {
    for (let i = 0; i < this.fogSprites.length; i++) this.setFogTile(i);
  }

  /** Only tiles whose knowledge state can have changed: old ∪ new visible. */
  private refreshFogDiff(prevVis: Set<number>): void {
    for (const i of prevVis) this.setFogTile(i);
    for (const i of this.floor.visible) this.setFogTile(i);
  }

  private buildEntities(layer: Container): void {
    const f = this.floor;
    const th = THEMES[themeIndex(f.floor)];
    for (const e of f.entities) {
      if (e.kind === "chest") {
        const view = new Container();
        const g = new Graphics();
        drawChest(g, 0, 0);
        view.addChild(g);
        view.position.set(tileCx(e.x), tileCy(e.y) + 4);
        layer.addChild(view);
        this.chestViews.push({ e, view, opened: !e.opened });
      } else if (e.kind === "event") {
        const view = new Container();
        view.addChild(new Graphics().circle(0, 0, 14).fill(PAL.panel));
        const q = new Text({
          text: "?",
          style: display(22, { fill: th.accent, stroke: worldStroke(22) }),
        });
        q.anchor.set(0.5);
        q.position.set(0, -2);
        view.addChild(q);
        view.position.set(tileCx(e.x), tileCy(e.y));
        layer.addChild(view);
        this.eventViews.push({ e, view, q });
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
              .ellipse(0, 4, 14, 5)
              .fill({ color: packTierColor(e), alpha: 0.5 }),
          );
        }
        const body = new Graphics();
        const look = ENEMIES[e.enemies[0]]?.look ?? {
          family: "vermin" as const,
          sizeGrade: "standard" as const,
          tier: 1 as const,
        };
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
        const alert = new Graphics().circle(12, -34, 4).fill(PAL.danger);
        alert.visible = false;
        view.addChild(glyph, alert);
        view.position.set(tileCx(e.x), tileCy(e.y));
        layer.addChild(view);
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
    const px = tileCx(this.floor.party.x);
    const py = tileCy(this.floor.party.y);
    this.trail = [
      { x: px, y: py },
      { x: px, y: py },
      { x: px, y: py },
    ];
    run.marchingOrder.slice(1, 4).forEach((cls) => {
      const dot = new Graphics().circle(0, 0, 4).fill(PAL[cls].body);
      dot.position.set(px, py);
      // insert beneath the lead marker, above fog-free tiles
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
      cv.view.visible = f.explored[idx(f.w, cv.e.x, cv.e.y)] === 1;
      if (cv.e.opened !== cv.opened) {
        cv.opened = cv.e.opened;
        cv.view.tint = cv.e.opened ? PAL.textDim : 0xffffff;
      }
    }
    for (const ev of this.eventViews) {
      ev.view.visible =
        !ev.e.used && f.explored[idx(f.w, ev.e.x, ev.e.y)] === 1;
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

  private camTarget(): { x: number; y: number } {
    const f = this.floor;
    const wpx = f.w * TILE;
    const hpx = f.h * TILE;
    const px = tileCx(f.party.x);
    const py = tileCy(f.party.y);
    return {
      x:
        wpx <= VIEW_W
          ? wpx / 2
          : Math.min(Math.max(px, VIEW_W / 2), wpx - VIEW_W / 2),
      y:
        hpx <= VIEW_H
          ? hpx / 2
          : Math.min(Math.max(py, VIEW_H / 2), hpx - VIEW_H / 2),
    };
  }

  private applyCamera(): void {
    this.scroller.position.set(
      Math.round(VIEW_W / 2 - this.cam.x),
      Math.round(VIEW_H / 2 - this.cam.y),
    );
  }
}

/** Factory for the scene registry (WP-09 wires it by id 'explore'). */
export const createExploreScene = (): ExploreScene => new ExploreScene();
