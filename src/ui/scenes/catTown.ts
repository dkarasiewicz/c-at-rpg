/**
 * CAT TOWN — the hub between runs (balance-and-meta.md §4).
 *
 * A PLACE, not a menu. The painted `scene:catTown` backdrop is the room; the
 * cats you have actually recruited stand on its floor and bob; the unlocks
 * are six LOCATIONS you walk to (the notice board, the bowls, the cart, the
 * stoop, the fence, the storm drain), each a marker sitting on the thing it
 * names in the art; the tin in the top-right says exactly what you have and
 * what you have ever earned; and the only way onward is "Begin the descent".
 *
 * Everything it knows about progression comes from core/meta — this file
 * computes no costs and grants no content. Buying is
 * `purchase()` → `saveMeta()`; starting a run is
 * `startRun(seed, applyUnlocks(meta))`, so the engine never learns that a
 * meta layer exists.
 *
 * Arriving from RESULTS (`CatTownParams`) it also shows the run's payout
 * receipt and pulses every marker whose place just came within reach.
 *
 * Chrome is the shared kit (widgets.ts) exactly as landing.ts uses it:
 * `sceneBackdrop`, `vignette`, `panel`, `avatar`, `bar`, `heading`, `label`,
 * `button`, `scrim`, `makeSpriteIcon`. FAIL-SOFT: with no generated art at
 * all the scene still renders — palette wash behind, glyph markers, and the
 * procedural cat recipe for the clowder.
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { ClassId, EnemyId } from "../../core/types.js";
import type {
  PlaceDef,
  Payout,
  RunOverlay,
  UnlockDef,
  UnlockId,
} from "../../core/meta/types.js";
import {
  affordableUnlocks,
  applyUnlocks,
  catalogCost,
  isUnlocked,
  PLACES,
  purchase,
  startRun,
  eligibleClasses,
  MAX_PARTY_CAPACITY,
  STARTING_PARTY_SIZE,
  unlockCatalog,
  unlocksAt,
  unlockState,
  knownIntel,
  KILLS_TO_COMPLETE,
  type UnlockState,
} from "../../core/meta/index.js";
import { saveMeta } from "../../core/run/save.js";
import { CLASSES } from "../../content/classes.js";
import { ENEMIES } from "../../content/enemies.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, RADIUS, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  avatar,
  bar,
  button,
  enemyAvatar,
  heading,
  label,
  makeSpriteIcon,
  panel,
  scrim,
  sceneBackdrop,
  UNKNOWN_SPRITE_ID,
  vignette,
} from "../widgets.js";
import { isTouch, padHit } from "../touch.js";
import { makeIntelBlock, makeLevelChip, makeTierPill } from "../draw/intel.js";
import { drawCat } from "../draw/cats.js";
import { catTexture, hasSprite } from "../sprites.js";
import { tween } from "../tween.js";
import { randomSeed } from "./title.js";
import { applyPartyContent } from "./partyCreator.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** Factory for main.ts's scene table. */
export function createCatTownScene(): Scene {
  return new CatTownScene();
}

/**
 * Mount params. Absent = walked in from the title. Present = came home from
 * a run: the receipt is shown and `highlight` marks what the payout just put
 * within reach (computed by RESULTS with `newlyAffordable`).
 */
export interface CatTownParams {
  /** Seed typed on the title screen; absent = a fresh random one. */
  seed?: string;
  payout?: Payout;
  victory?: boolean;
  highlight?: UnlockId[];
}

/* ---- screen geometry (design px) ------------------------------------- */
const EYEBROW_Y = 32;
const BANNER_Y = 60;
const SUB_Y = 104;

const TIN_W = 300;
const TIN_H = 92;
const TIN_X = DESIGN_W - 40 - TIN_W;
const TIN_Y = 26;

const RECEIPT_W = TIN_W;
const RECEIPT_X = TIN_X;
const RECEIPT_Y = TIN_Y + TIN_H + SPACE.md;

/** Marker: painted art disc + name plate under it. */
const MARK_ART = 76;
/** MINIMUM plate width — a long name widens it (see `makeMarker`). */
const MARK_W = 168;
const PLATE_H = 44;

/** The clowder stands on the town floor, left of the action bar. */
const CLOWDER_FEET_Y = 686;
const CLOWDER_X0 = 112;
const CLOWDER_DX = 112;
const CAT_H = 118;

const BAR_Y = 648;
const BAR_H = 52;

/* ---- the Bestiary (enemy-intel.md §4) --------------------------------- */
/** Modal card, sized like the place panel's big brother. */
const BEST_W = 940;
const BEST_H = 620;
/** Grid of species tiles: 5 across × 3 down holds the whole roster. */
const TILE_W = 168;
const TILE_H = 142;
const TILE_COLS = 5;
const TILE_GAP = SPACE.md;
const TILE_TOP = 82;

/**
 * The codex reads the bestiary WITHOUT the floor-1 novice grace
 * (core/meta/bestiary.ts): the grace is an encounter affordance, and a page
 * that is explicitly a checklist of what you have earned must never show a
 * tier-1 entry as open because the player happens to be on their first run.
 */
const BESTIARY_VIEW = { grace: false } as const;

/** The place panel (a modal over the town) — height follows its rows. */
const PLACE_W = 720;
const ROW_H = 78;
const PLACE_TOP = 84;
const PLACE_FOOT = 76;
const placeHeight = (rows: number): number =>
  Math.max(
    232,
    PLACE_TOP + Math.max(1, rows) * (ROW_H + SPACE.sm) + PLACE_FOOT,
  );

interface Marker {
  place: PlaceDef;
  view: Container;
  ring: Graphics;
  badge: Container;
  hot: boolean;
  /** the name plate, so the layout pass below can move it off a neighbour */
  plate: Container;
  plateW: number;
}

/**
 * Push overlapping name plates down until none of them touch.
 *
 * A place's DISC is pinned to the object it names in the painting — that is
 * the whole idea of the scene and it must not move. The plate hanging under
 * it is free, and the authored positions put four of the six close enough
 * that their plates merged into one unreadable strip (THE CART / THE STOOP
 * sit 6px apart, THE FENCE / THE STORM DRAIN 14px). Left-to-right, each
 * plate drops by its own height until it clears everything already placed.
 */
function deconflictPlates(markers: readonly Marker[]): void {
  const GAP = 6;
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const order = [...markers].sort((a, b) => a.place.x - b.place.x);
  for (const m of order) {
    const x0 = m.place.x - m.plateW / 2;
    const x1 = m.place.x + m.plateW / 2;
    let y0 = m.place.y + m.plate.y;
    for (let guard = 0; guard < 8; guard++) {
      const y1 = y0 + PLATE_H;
      const hit = placed.find(
        (p) =>
          x0 < p.x1 + GAP &&
          x1 + GAP > p.x0 &&
          y0 < p.y1 + GAP &&
          y1 + GAP > p.y0,
      );
      if (!hit) break;
      y0 = hit.y1 + GAP;
    }
    m.plate.y = y0 - m.place.y;
    placed.push({ x0, x1, y0, y1: y0 + PLATE_H });
  }
}

interface TownCat {
  view: Container;
  baseY: number;
  phase: number;
}

/**
 * Every species the Bestiary tracks, in the order you meet them: tier first,
 * then bosses last inside a tier, then alphabetically — so the page reads as
 * a descent rather than a hash-map dump.
 */
function bestiaryRoster(): EnemyId[] {
  return Object.values(ENEMIES)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const ab = a.boss ? 1 : 0;
      const bb = b.boss ? 1 : 0;
      if (ab !== bb) return ab - bb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((d) => d.id);
}

export class CatTownScene implements Scene {
  private view: Container | null = null;
  private ctx: GameCtx | null = null;
  private params: CatTownParams = {};
  private catalog: readonly UnlockDef[] = unlockCatalog();
  private overlay: RunOverlay = applyUnlocks({
    version: 2,
    counters: { runs: 0, victories: 0 },
    records: { bestScore: 0, fastestVictoryMs: null },
    shinies: 0,
    lifetimeShinies: 0,
    unlocked: [],
    history: [],
  });
  private markers: Marker[] = [];
  private cats: TownCat[] = [];
  private clowderLayer: Container | null = null;
  private tinText: Text | null = null;
  private lifetimeText: Text | null = null;
  private townBar: { view: Container; set(v: number, m: number): void } | null =
    null;
  private townBarText: Text | null = null;
  private placeBox: Container | null = null;
  private openPlace: string | null = null;
  /** The Bestiary modal, and which species it has drilled into. */
  private bestiaryBox: Container | null = null;
  private bestiaryEntry: EnemyId | null = null;
  private t = 0;

  mount(root: Container, ctx: GameCtx, params?: unknown): void {
    this.ctx = ctx;
    this.params = (params as CatTownParams | undefined) ?? {};
    this.catalog = unlockCatalog();
    const view = new Container();
    this.view = view;
    layer(root, "hud").addChild(view);

    /* ---- backdrop ---------------------------------------------------- */
    view.addChild(
      sceneBackdrop("scene:catTown", DESIGN_W, DESIGN_H, { dim: 0.42 }),
      vignette(DESIGN_W, DESIGN_H, 0.8),
    );

    /* ---- title zone -------------------------------------------------- */
    const eyebrow = heading("BETWEEN DESCENTS", 3, { center: true });
    eyebrow.position.set(DESIGN_W / 2, EYEBROW_Y);
    const banner = heading("CAT TOWN", 1, { center: true, fill: PAL.gold });
    banner.position.set(DESIGN_W / 2, BANNER_Y);
    const sub = label(
      "Under the street, where the lamps are warm and nothing is trying to eat you.",
      { dim: true, center: true },
    );
    sub.position.set(DESIGN_W / 2, SUB_Y);
    view.addChild(eyebrow, banner, sub);

    /* ---- the tin (the currency, somewhere honest) -------------------- */
    this.buildTin(view);
    this.buildReceipt(view);

    /* ---- the places -------------------------------------------------- */
    this.markers = [];
    PLACES.forEach((place, i) => {
      const m = this.makeMarker(place, i);
      view.addChild(m.view);
      this.markers.push(m);
    });
    deconflictPlates(this.markers);

    /* ---- the clowder, living here ------------------------------------ */
    this.clowderLayer = new Container();
    view.addChild(this.clowderLayer);

    /* ---- action bar --------------------------------------------------- */
    const descend = button(
      "Begin the descent",
      320,
      BAR_H,
      () => this.beginDescent(),
      { primary: true, hotkey: "Enter" },
    );
    descend.view.position.set(DESIGN_W - 40 - 320, BAR_Y);
    view.addChild(descend.view);

    const toTitle = button("Title", 150, BAR_H, () => this.toTitle(), {
      hotkey: "T",
    });
    toTitle.view.position.set(DESIGN_W - 40 - 320 - SPACE.lg - 150, BAR_Y);
    view.addChild(toTitle.view);

    // The Bestiary is knowledge, not a purchase, so it sits on the action bar
    // rather than becoming a seventh PLACE (places sell unlocks; this one
    // sells nothing). Same button, same hotkey chip, same modal idiom.
    const bestiary = button(
      "The Bestiary",
      190,
      BAR_H,
      () => this.showBestiary(null),
      { hotkey: "B" },
    );
    bestiary.view.position.set(
      DESIGN_W - 40 - 320 - SPACE.lg - 150 - SPACE.lg - 190,
      BAR_Y,
    );
    view.addChild(bestiary.view);

    this.refreshAll();
  }

  update(dtMs: number): void {
    this.t += dtMs;
    for (const c of this.cats) {
      c.view.y =
        c.baseY + Math.sin((this.t * 2 * Math.PI) / 1600 + c.phase) * 2;
    }
    // hot markers breathe so "newly affordable" is impossible to miss
    const pulse = 0.55 + 0.45 * Math.sin((this.t * 2 * Math.PI) / 1100);
    for (const m of this.markers) {
      if (m.hot) m.ring.alpha = pulse;
    }
  }

  onKey(key: string): boolean {
    if (this.bestiaryBox) {
      if (key === "esc" || key === "b") {
        if (this.bestiaryEntry !== null) this.showBestiary(null);
        else this.closeBestiary();
        return true;
      }
      return true; // modal, like the place panel
    }
    if (key === "b") {
      this.showBestiary(null);
      return true;
    }
    if (this.placeBox) {
      if (key === "esc" || key === "x") {
        this.closePlace();
        return true;
      }
      const i = "123456".indexOf(key);
      if (i >= 0) {
        this.buyRow(i);
        return true;
      }
      return true; // the place panel is modal: it swallows everything
    }
    if (key === "enter") {
      this.beginDescent();
      return true;
    }
    if (key === "t") {
      this.toTitle();
      return true;
    }
    if (key === "esc") return true; // no run here — Esc must never pause
    const i = "123456".indexOf(key);
    if (i >= 0 && i < PLACES.length) {
      this.showPlace(PLACES[i].id);
      return true;
    }
    return false;
  }

  unmount(): void {
    this.markers = [];
    this.cats = [];
    this.clowderLayer = null;
    this.tinText = null;
    this.lifetimeText = null;
    this.townBar = null;
    this.townBarText = null;
    this.placeBox = null;
    this.openPlace = null;
    this.bestiaryBox = null;
    this.bestiaryEntry = null;
    this.view?.destroy({ children: true });
    this.view = null;
  }

  /* ---- the tin --------------------------------------------------------- */

  private buildTin(view: Container): void {
    const card = panel(TIN_W, TIN_H, { variant: "glass", accent: PAL.gold });
    card.position.set(TIN_X, TIN_Y);
    view.addChild(card);

    const eyebrow = heading("THE TIN", 3);
    eyebrow.position.set(SPACE.lg, SPACE.sm + 2);
    card.addChild(eyebrow);

    this.tinText = label("0 ✦", {
      mono: true,
      fill: PAL.gold,
      size: TYPE.h2,
    });
    this.tinText.anchor.set(1, 0);
    this.tinText.position.set(TIN_W - SPACE.lg, SPACE.sm);
    card.addChild(this.tinText);

    this.lifetimeText = label("", { mono: true, dim: true, size: TYPE.tiny });
    this.lifetimeText.position.set(SPACE.lg, 34);
    card.addChild(this.lifetimeText);

    // how much of the town is actually built — the kit's xp bar, honestly used
    const b = bar(TIN_W - SPACE.lg * 2, 8, { kind: "xp" });
    b.view.position.set(SPACE.lg, TIN_H - SPACE.lg - 6);
    card.addChild(b.view);
    this.townBar = b;
    this.townBarText = label("", { mono: true, dim: true, size: TYPE.tiny });
    this.townBarText.anchor.set(1, 1);
    this.townBarText.position.set(TIN_W - SPACE.lg, TIN_H - SPACE.lg - 8);
    card.addChild(this.townBarText);
  }

  /** The receipt from the run just finished (absent when walking in cold). */
  private buildReceipt(view: Container): void {
    const payout = this.params.payout;
    if (!payout) return;
    const rows = payout.lines.length + (payout.bonus > 0 ? 1 : 0);
    const h = 62 + rows * 20 + 34;
    const card = panel(RECEIPT_W, h, {
      variant: "glass",
      accent: this.params.victory === true ? PAL.gold : PAL.danger,
    });
    card.position.set(RECEIPT_X, RECEIPT_Y);
    view.addChild(card);

    const title = heading(
      this.params.victory === true ? "SPOILS OF A WIN" : "SALVAGED",
      3,
    );
    title.position.set(SPACE.lg, SPACE.sm + 2);
    card.addChild(title);

    let y = 34;
    const colR = RECEIPT_W - SPACE.lg;
    for (const l of payout.lines) {
      const left = label(`${l.label} ${l.count}×${l.rate}`, {
        mono: true,
        dim: true,
        size: TYPE.tiny,
      });
      left.position.set(SPACE.lg, y);
      const right = label(`${l.amount}`, {
        mono: true,
        dim: true,
        size: TYPE.tiny,
      });
      right.anchor.set(1, 0);
      right.position.set(colR, y);
      card.addChild(left, right);
      y += 20;
    }
    if (payout.bonus > 0) {
      const left = label("descent completed", {
        mono: true,
        size: TYPE.tiny,
        fill: PAL.gold,
      });
      left.position.set(SPACE.lg, y);
      const right = label(`${payout.bonus}`, {
        mono: true,
        size: TYPE.tiny,
        fill: PAL.gold,
      });
      right.anchor.set(1, 0);
      right.position.set(colR, y);
      card.addChild(left, right);
      y += 20;
    }
    // the two adjustments, spelled out — a receipt nobody can argue with
    const raw = Math.floor(payout.earned * payout.lossRate) + payout.bonus;
    const note = label(
      payout.total > raw
        ? "the tin never comes home empty"
        : `carried home at ${Math.round(payout.lossRate * 100)}%`,
      { mono: true, dim: true, size: TYPE.tiny },
    );
    note.position.set(SPACE.lg, y);
    card.addChild(note);

    const banked = label(`+${payout.total} ✦ banked`, {
      mono: true,
      bold: true,
      fill: PAL.gold,
      size: TYPE.body,
    });
    banked.anchor.set(1, 1);
    banked.position.set(colR, h - SPACE.sm);
    card.addChild(banked);
    // the number the whole screen exists for: land it, don't just print it
    banked.scale.set(1.6);
    tween(banked.scale, { x: 1, y: 1 }, 300, "backOut");
  }

  /* ---- markers: the unlocks as places ---------------------------------- */

  private makeMarker(place: PlaceDef, index: number): Marker {
    const view = new Container();
    view.position.set(place.x, place.y);

    const ring = new Graphics()
      .circle(0, 0, MARK_ART / 2 + 7)
      .stroke({ width: 3, color: PAL.gold, alpha: 0.95 });
    ring.visible = false;
    view.addChild(ring);

    const art = makeSpriteIcon(place.art, MARK_ART);
    const disc = new Graphics()
      .circle(0, 0, MARK_ART / 2)
      .fill({ color: PAL.bgDeep, alpha: art ? 0.35 : 0.9 })
      .stroke({ width: 2, color: PAL.border });
    view.addChild(disc);
    if (art) {
      const maskG = new Graphics()
        .circle(0, 0, MARK_ART / 2 - 1)
        .fill(0xffffff);
      art.mask = maskG;
      view.addChild(art, maskG);
    } else {
      const glyph = label(place.glyph, {
        mono: true,
        size: 30,
        center: true,
        fill: PAL.gold,
      });
      glyph.position.set(0, 0);
      view.addChild(glyph);
    }

    // The plate is sized to its CONTENT, not to a constant. "THE NOTICE
    // BOARD" and "THE STORM DRAIN" are both wider than MARK_W, and a fixed
    // plate let them spill out of the glass on both sides and paint straight
    // over the hotkey chip — places 1 and 6 had no visible number at all.
    const name = heading(place.name, 3, { center: true, fill: PAL.text });
    const blurb = label(place.blurb, {
      dim: true,
      size: TYPE.tiny,
      center: true,
    });
    const hotkey = label(`${index + 1}`, {
      mono: true,
      size: TYPE.tiny,
      fill: PAL.gold,
    });
    const hotW = Math.ceil(hotkey.width) + SPACE.sm * 2;
    const plateW = Math.max(
      MARK_W,
      Math.ceil(Math.max(name.width, blurb.width)) + hotW + SPACE.md,
    );

    const plate = panel(plateW, PLATE_H, {
      variant: "glass",
      radius: RADIUS.button,
    });
    plate.position.set(-plateW / 2, MARK_ART / 2 + 8);
    view.addChild(plate);
    // centre the text in the space LEFT OF nothing and RIGHT OF the hotkey,
    // so the chip always has room of its own
    const textCx = hotW + (plateW - hotW) / 2;
    name.position.set(textCx, 7);
    blurb.position.set(textCx, 26);
    hotkey.position.set(SPACE.sm, 15);
    plate.addChild(name, blurb, hotkey);

    const badge = new Container();
    badge.position.set(MARK_ART / 2 - 4, -MARK_ART / 2 + 2);
    view.addChild(badge);

    view.eventMode = "static";
    view.cursor = "pointer";
    view.on("pointertap", () => this.showPlace(place.id));
    view.on("pointerover", () => {
      if (isTouch()) return; // no hover lift on a finger
      tween(view.scale, { x: 1.05, y: 1.05 }, 120);
    });
    view.on("pointerout", () => tween(view.scale, { x: 1, y: 1 }, 120));

    return { place, view, ring, badge, hot: false, plate, plateW };
  }

  /* ---- refresh --------------------------------------------------------- */

  private refreshAll(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const meta = ctx.meta;
    this.overlay = applyUnlocks(meta, this.catalog);

    if (this.tinText) this.tinText.text = `${meta.shinies} ✦`;
    if (this.lifetimeText) {
      this.lifetimeText.text =
        `${meta.lifetimeShinies} ever earned · ` +
        `${meta.counters.runs} descents · ${meta.counters.victories} won`;
    }
    const owned = this.catalog.filter((d) => isUnlocked(meta, d.id)).length;
    this.townBar?.set(owned, Math.max(1, this.catalog.length));
    if (this.townBarText) {
      // What is LEFT to build, not what the catalog cost when it was empty:
      // the old line printed the whole catalog's price forever, so a fully
      // unlocked town said "town 13/13 · 2650 ✦ to build it all", which is a
      // sentence arguing with itself. `catalogCost` of the unbought remainder
      // is the honest number, and at zero the line says so.
      const remaining = this.catalog.filter((d) => !isUnlocked(meta, d.id));
      const left = catalogCost(remaining);
      this.townBarText.text =
        remaining.length === 0
          ? `town ${owned}/${this.catalog.length} · every door open`
          : `town ${owned}/${this.catalog.length} · ${left} ✦ still to build`;
    }

    const affordable = new Set(affordableUnlocks(meta, this.catalog));
    const hot = new Set(this.params.highlight ?? []);
    for (const m of this.markers) {
      const here = unlocksAt(m.place.id, this.catalog);
      const buyable = here.filter((d) => affordable.has(d.id)).length;
      const left = here.filter((d) => !isUnlocked(meta, d.id)).length;
      m.hot = here.some((d) => hot.has(d.id));
      m.ring.visible = m.hot || buyable > 0;
      m.ring.alpha = m.hot ? 1 : 0.5;
      this.paintBadge(m, buyable, left, here.length);
    }

    this.refreshClowder();
    if (this.openPlace) this.showPlace(this.openPlace, true);
  }

  private paintBadge(
    m: Marker,
    buyable: number,
    left: number,
    total: number,
  ): void {
    for (const c of m.badge.removeChildren()) c.destroy({ children: true });
    const text =
      left === 0
        ? "✓"
        : buyable > 0
          ? `${buyable} ready`
          : `${total - left}/${total}`;
    const fill = left === 0 ? PAL.heal : buyable > 0 ? PAL.gold : PAL.textDim;
    const t = label(text, { mono: true, size: TYPE.tiny, fill: PAL.textDark });
    const w = Math.max(22, Math.ceil(t.width) + 12);
    const chip = new Graphics()
      .roundRect(0, 0, w, 18, RADIUS.chip)
      .fill({ color: fill, alpha: 0.95 })
      .stroke({ width: 1, color: PAL.void, alpha: 0.6 });
    t.position.set(6, 3);
    m.badge.addChild(chip, t);
    m.badge.x = MARK_ART / 2 - w / 2;
  }

  /** The cats who actually live here, standing on the floor. */
  private refreshClowder(): void {
    const host = this.clowderLayer;
    if (!host) return;
    for (const c of host.removeChildren()) c.destroy({ children: true });
    this.cats = [];

    // Who LIVES here: the cats the town has. A descent takes
    // STARTING_PARTY_SIZE of them — Bruno plus one drawn at the door
    // (`startingRoster`) — so the town must not draw the cats who stay as
    // the same size and brightness as the ones who go.
    //
    // The old rule here was "index 0 sets out, everyone else is dim". With a
    // fresh town that houses exactly two cats, BOTH set out, and dimming the
    // second one contradicted the caption right above it.
    const known = eligibleClasses(this.overlay).filter(
      (id): id is ClassId => CLASSES[id as ClassId] !== undefined,
    );
    const shown = known.slice(0, MAX_PARTY_CAPACITY);
    /** Every cat in town comes along only when the town is exactly a party. */
    const allGo = shown.length <= STARTING_PARTY_SIZE;

    shown.forEach((classId, i) => {
      // the anchor always walks; the others are the draw (or, when the town
      // is only a party's worth, all of them walk)
      const descends = allGo || i === 0;
      const c = new Container();
      c.position.set(CLOWDER_X0 + i * CLOWDER_DX, CLOWDER_FEET_Y);
      const tex = catTexture(classId);
      if (tex && tex.height > 0) {
        const sp = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
        sp.scale.set(CAT_H / tex.height);
        c.addChild(sp);
      } else {
        const g = new Graphics();
        drawCat(g, classId, "sit", 0.9);
        c.addChild(g);
      }
      // A cat who is only a CANDIDATE stands further back: smaller and
      // dimmer, but never invisible — at 0.55 over the dark town floor the
      // grey ones (Pixel especially) read as failed-to-load art.
      if (!descends) {
        c.alpha = 0.72;
        c.scale.set(0.82); // feet are the anchor, so it plants correctly
      }
      host.addChild(c);
      this.cats.push({ view: c, baseY: CLOWDER_FEET_Y, phase: i * 0.9 });

      const name = label(CLASSES[classId].catName, {
        size: TYPE.tiny,
        center: true,
        bold: descends,
        fill: descends ? PAL.text : PAL.textDim,
      });
      name.position.set(CLOWDER_X0 + i * CLOWDER_DX, CLOWDER_FEET_Y + SPACE.xs);
      host.addChild(name);

      const role = label(descends ? "sets out" : "may be drawn", {
        size: TYPE.tiny,
        center: true,
        dim: true,
      });
      role.alpha = descends ? 0.9 : 0.7;
      role.position.set(
        CLOWDER_X0 + i * CLOWDER_DX,
        CLOWDER_FEET_Y + SPACE.xs + 14,
      );
      host.addChild(role);
    });

    const caption = label(
      allGo
        ? `THE CLOWDER — ${known.length} live here · all ${known.length} set ` +
            `out together · the party can grow to ${this.overlay.partyCapacity}`
        : `THE CLOWDER — ${known.length} live here · only ` +
            `${STARTING_PARTY_SIZE} set out (Bruno plus one, drawn at the ` +
            `door) · the party can grow to ${this.overlay.partyCapacity}`,
      { size: TYPE.tiny, dim: true, bold: true },
    );
    caption.position.set(CLOWDER_X0 - 48, CLOWDER_FEET_Y - CAT_H - 18);
    host.addChild(caption);
  }

  /* ---- a place you visit ------------------------------------------------ */

  private showPlace(placeId: string, keepOpen = false): void {
    const view = this.view;
    const ctx = this.ctx;
    if (!view || !ctx) return;
    if (this.placeBox && !keepOpen && this.openPlace === placeId) {
      this.closePlace();
      return;
    }
    this.placeBox?.destroy({ children: true });
    this.placeBox = null;
    this.openPlace = placeId;

    const place = PLACES.find((p) => p.id === placeId);
    if (!place) return;
    const defs = unlocksAt(placeId, this.catalog);

    const box = new Container();
    const back = scrim(DESIGN_W, DESIGN_H, 0.7);
    back.eventMode = "static";
    back.on("pointertap", () => this.closePlace());
    box.addChild(back);

    const cardH = placeHeight(defs.length);
    const card = panel(PLACE_W, cardH, {
      variant: "raised",
      accent: PAL.gold,
    });
    card.position.set((DESIGN_W - PLACE_W) / 2, (DESIGN_H - cardH) / 2);
    box.addChild(card);

    const art = makeSpriteIcon(place.art, 72);
    if (art) {
      art.position.set(SPACE.lg + 36, SPACE.lg + 24);
      card.addChild(art);
    }
    const textX = art ? SPACE.lg * 2 + 72 : SPACE.lg;
    const title = heading(place.name, 2, { fill: PAL.gold });
    title.position.set(textX, SPACE.md);
    const blurb = label(place.blurb, { dim: true });
    blurb.position.set(textX, SPACE.md + 30);
    card.addChild(title, blurb);

    const tin = label(`${ctx.meta.shinies} ✦ in the tin`, {
      mono: true,
      fill: PAL.gold,
    });
    tin.anchor.set(1, 0);
    tin.position.set(PLACE_W - SPACE.lg, SPACE.md + 4);
    card.addChild(tin);

    let y = PLACE_TOP;
    defs.forEach((def, i) => {
      card.addChild(this.makeUnlockRow(def, i, y));
      y += ROW_H + SPACE.sm;
    });
    if (defs.length === 0) {
      const empty = label("Nothing here yet. Someone will pin something up.", {
        dim: true,
      });
      empty.position.set(SPACE.lg, y);
      card.addChild(empty);
    }

    const close = button("Back to town", 200, 44, () => this.closePlace(), {
      hotkey: "Esc",
    });
    close.view.position.set(PLACE_W - 200 - SPACE.lg, cardH - 44 - SPACE.lg);
    card.addChild(close.view);

    view.addChild(box);
    this.placeBox = box;
  }

  private makeUnlockRow(def: UnlockDef, index: number, y: number): Container {
    const ctx = this.ctx!;
    const state: UnlockState = unlockState(ctx.meta, def.id, this.catalog);
    const w = PLACE_W - SPACE.lg * 2;
    const row = new Container();
    row.position.set(SPACE.lg, y);
    const accent =
      state === "owned"
        ? PAL.heal
        : state === "available"
          ? PAL.gold
          : PAL.border;
    row.addChild(
      panel(w, ROW_H, {
        variant: "solid",
        radius: RADIUS.button,
        accent,
      }),
    );

    // a cat unlock shows the cat: the painted portrait, through the kit
    const classId = def.id.startsWith("class:")
      ? (def.id.slice(6) as ClassId)
      : null;
    const face =
      classId && CLASSES[classId]
        ? avatar(classId, 44, { dead: state === "locked" })
        : null;
    if (face) {
      face.position.set(SPACE.md + 32, ROW_H / 2);
      row.addChild(face);
    }
    const textX = SPACE.md + 24 + (face ? 44 : 0);

    const name = label(def.name, {
      bold: true,
      size: TYPE.body,
      fill: state === "locked" ? PAL.textDim : PAL.text,
    });
    name.position.set(textX, SPACE.sm);
    row.addChild(name);

    const hotkey = label(`${index + 1}`, {
      mono: true,
      size: TYPE.tiny,
      fill: PAL.textDim,
    });
    hotkey.position.set(SPACE.md, SPACE.sm + 3);
    row.addChild(hotkey);

    const pitch = label(def.pitch, {
      dim: true,
      size: TYPE.small,
      wrap: w - textX - 200,
    });
    pitch.position.set(textX, SPACE.sm + 24);
    row.addChild(pitch);

    if (state === "locked") {
      const need = def.requires
        .map((r) => this.catalog.find((d) => d.id === r)?.name ?? r)
        .join(" · ");
      const gate = label(`needs ${need}`, {
        size: TYPE.tiny,
        mono: true,
        fill: PAL.danger,
      });
      gate.position.set(textX, ROW_H - 20);
      row.addChild(gate);
    }

    if (state === "owned") {
      const done = label("OPEN", { mono: true, bold: true, fill: PAL.heal });
      done.anchor.set(1, 0.5);
      done.position.set(w - SPACE.md, ROW_H / 2);
      row.addChild(done);
      return row;
    }

    const price = label(`${def.cost} ✦`, {
      mono: true,
      fill: state === "available" ? PAL.gold : PAL.textDim,
      size: TYPE.body,
    });
    price.anchor.set(1, 0.5);
    price.position.set(w - 120 - SPACE.lg, ROW_H / 2);
    row.addChild(price);

    const buy = button("Unlock", 110, 34, () => this.buy(def.id), {
      fontSize: TYPE.small,
      disabled: state !== "available",
    });
    buy.view.position.set(w - 110 - SPACE.md, (ROW_H - 34) / 2);
    row.addChild(buy.view);
    return row;
  }

  /** Number-key buy inside an open place. */
  private buyRow(index: number): void {
    if (!this.openPlace) return;
    const defs = unlocksAt(this.openPlace, this.catalog);
    const def = defs[index];
    if (def) this.buy(def.id);
  }

  private buy(id: UnlockId): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const res = purchase(ctx.meta, id, this.catalog);
    if (!res.ok) return; // owned / locked / too poor — the row already says so
    ctx.meta = res.meta;
    saveMeta(ctx.meta);
    // buying is a town event, never a run event: nothing in ctx.run is touched
    this.refreshAll();
  }

  private closePlace(): void {
    this.placeBox?.destroy({ children: true });
    this.placeBox = null;
    this.openPlace = null;
  }

  /* ---- THE BESTIARY (enemy-intel.md §4) --------------------------------- */

  /**
   * Knowledge as a collection. Cat Town hosts it because that is where the
   * meta profile lives: entries fill in as you fight, they persist across
   * runs, and a completed one is a real (non-numeric) power increase — you
   * start the next descent already reading the early roster's telegraphs.
   *
   * Darkest Dungeon's rule again: an entry you have not earned is a
   * SILHOUETTE with `???` in every field, never a hidden row — so the page
   * always shows you how much there is left to learn.
   */
  private showBestiary(entry: EnemyId | null = null): void {
    const view = this.view;
    const ctx = this.ctx;
    if (!view || !ctx) return;
    this.bestiaryBox?.destroy({ children: true });
    this.bestiaryEntry = entry;

    const box = new Container();
    const back = scrim(DESIGN_W, DESIGN_H, 0.72);
    back.eventMode = "static";
    back.on("pointertap", () => this.closeBestiary());
    box.addChild(back);

    const card = panel(BEST_W, BEST_H, { variant: "raised", accent: PAL.gold });
    card.position.set((DESIGN_W - BEST_W) / 2, (DESIGN_H - BEST_H) / 2);
    box.addChild(card);

    const ids = bestiaryRoster();
    const done = ids.filter(
      (id) => knownIntel(ctx.meta, id, 1, BESTIARY_VIEW).complete,
    ).length;
    const met = ids.filter(
      (id) => knownIntel(ctx.meta, id, 1, BESTIARY_VIEW).met > 0,
    ).length;

    const title = heading("THE BESTIARY", 2, { fill: PAL.gold });
    title.position.set(SPACE.lg, SPACE.md);
    const blurb = label(
      "Everything the alley has taught you. What you have not seen yet stays a shape and a question mark.",
      { dim: true, size: TYPE.small, wrap: BEST_W - SPACE.lg * 2 - 220 },
    );
    blurb.position.set(SPACE.lg, SPACE.md + 32);
    card.addChild(title, blurb);

    const tally = label(`${met}/${ids.length} met · ${done} complete`, {
      mono: true,
      fill: done === ids.length ? PAL.heal : PAL.gold,
    });
    tally.anchor.set(1, 0);
    tally.position.set(BEST_W - SPACE.lg, SPACE.md + 6);
    card.addChild(tally);

    if (entry === null) this.buildBestiaryGrid(card, ids);
    else this.buildBestiaryEntry(card, entry);

    const close = button(
      entry === null ? "Back to town" : "All entries",
      200,
      44,
      () => (entry === null ? this.closeBestiary() : this.showBestiary(null)),
      { hotkey: "Esc" },
    );
    close.view.position.set(BEST_W - 200 - SPACE.lg, BEST_H - 44 - SPACE.md);
    card.addChild(close.view);

    view.addChild(box);
    this.bestiaryBox = box;
  }

  /** The grid of species tiles — the collection you are filling in. */
  private buildBestiaryGrid(card: Container, ids: readonly EnemyId[]): void {
    const ctx = this.ctx!;
    const gridX =
      (BEST_W - (TILE_COLS * TILE_W + (TILE_COLS - 1) * TILE_GAP)) / 2;
    ids.forEach((id, i) => {
      const intel = knownIntel(ctx.meta, id, 1, BESTIARY_VIEW);
      const def = ENEMIES[id];
      const col = i % TILE_COLS;
      const row = Math.floor(i / TILE_COLS);
      const tile = new Container();
      tile.position.set(
        gridX + col * (TILE_W + TILE_GAP),
        TILE_TOP + row * (TILE_H + TILE_GAP),
      );
      const seen = intel.met > 0;
      tile.addChild(
        panel(TILE_W, TILE_H, {
          variant: "solid",
          radius: RADIUS.button,
          ...(intel.complete ? { accent: PAL.gold } : {}),
        }),
      );

      // A SILHOUETTE, not a blank: you can see there is something there.
      //
      // With the art pack that is the painted `bestiary:unknown` shape — one
      // bristling, glowing-eyed nobody, the same for every unmet species. It
      // replaces the old trick of tinting the REAL portrait black, which was
      // never a silhouette so much as a spoiler with the lights off: the
      // outline of the boss you have not met yet was right there. The big "?"
      // that used to sit on top of that plate goes with it — it would cover
      // the shape it is meant to be asking about, and the tile already says
      // "???" for the name and "LVL ???" underneath.
      //
      // No art ⇒ exactly the old rendering, voided tint and "?" included.
      const face = enemyAvatar(id, 58, {
        shape: "rounded",
        ...(seen ? {} : { unknown: true }),
      });
      face.position.set(TILE_W / 2, 42);
      if (!seen && !hasSprite(UNKNOWN_SPRITE_ID)) {
        face.tint = PAL.void;
        face.alpha = 0.75;
      }
      tile.addChild(face);
      if (!seen && !hasSprite(UNKNOWN_SPRITE_ID)) {
        const q = label("?", { size: 28, bold: true, center: true, dim: true });
        q.position.set(TILE_W / 2, 42);
        tile.addChild(q);
      }

      const name = label(seen ? def.name : "???", {
        size: TYPE.small,
        bold: true,
        center: true,
        fill: seen ? PAL.text : PAL.textDim,
      });
      name.position.set(TILE_W / 2, 80);
      tile.addChild(name);

      const lvl = makeLevelChip(intel.level.value);
      lvl.position.set((TILE_W - Math.ceil(lvl.width)) / 2, 96);
      tile.addChild(lvl);

      const foot = label(
        intel.complete
          ? "✓ COMPLETE"
          : `${intel.kills}/${KILLS_TO_COMPLETE} felled`,
        {
          size: TYPE.tiny,
          mono: true,
          center: true,
          fill: intel.complete ? PAL.heal : PAL.textDim,
        },
      );
      foot.position.set(TILE_W / 2, TILE_H - 18);
      tile.addChild(foot);

      tile.eventMode = "static";
      tile.cursor = "pointer";
      padHit(tile, TILE_W, TILE_H);
      tile.on("pointertap", () => this.showBestiary(id));
      tile.on("pointerover", () =>
        isTouch() ? undefined : tween(tile.scale, { x: 1.04, y: 1.04 }, 110),
      );
      tile.on("pointerout", () => tween(tile.scale, { x: 1, y: 1 }, 110));
      tile.pivot.set(TILE_W / 2, TILE_H / 2);
      tile.position.x += TILE_W / 2;
      tile.position.y += TILE_H / 2;
      card.addChild(tile);
    });
  }

  /** One species, in full — the same block the battle inspect card uses. */
  private buildBestiaryEntry(card: Container, id: EnemyId): void {
    const ctx = this.ctx!;
    const intel = knownIntel(ctx.meta, id, 1, BESTIARY_VIEW);
    const def = ENEMIES[id];
    const seen = intel.met > 0;
    const left = SPACE.lg;
    const top = 96;

    const face = enemyAvatar(id, 148, {
      shape: "rounded",
      ...(seen ? {} : { unknown: true }),
    });
    face.position.set(left + 74, top + 74);
    if (!seen && !hasSprite(UNKNOWN_SPRITE_ID)) {
      face.tint = PAL.void;
      face.alpha = 0.75;
    }
    card.addChild(face);

    const statsX = left;
    let sy = top + 160;
    const stat = (k: string, v: string): void => {
      const t = label(`${k}  ${v}`, { size: TYPE.tiny, mono: true, dim: true });
      t.position.set(statsX, sy);
      card.addChild(t);
      sy += 18;
    };
    stat("MET   ", String(intel.met));
    stat(
      "FELLED",
      intel.complete
        ? `${intel.kills} ✓`
        : `${intel.kills}/${KILLS_TO_COMPLETE}`,
    );
    stat("HP    ", seen ? String(def.stats.hp) : "???");
    stat("ATK   ", seen ? String(def.stats.atk) : "???");
    stat("DEF   ", seen ? String(def.stats.def) : "???");
    stat("SPD   ", seen ? String(def.stats.spd) : "???");
    stat("XP    ", seen ? String(def.xp) : "???");
    stat("ROW   ", seen ? def.row : "???");

    const colX = left + 180;
    const colW = BEST_W - colX - SPACE.lg;

    const name = heading(intel.name.value ?? "???", 2, {
      fill: seen ? PAL.text : PAL.textDim,
    });
    name.position.set(colX, top - 8);
    card.addChild(name);

    const lvl = makeLevelChip(intel.level.value);
    lvl.position.set(colX, top + 26);
    card.addChild(lvl);
    const tier = makeTierPill(intel.tier.value);
    tier.position.set(colX + Math.ceil(lvl.width) + 8, top + 26);
    card.addChild(tier);

    const block = makeIntelBlock(intel, colW);
    block.view.position.set(colX, top + 56);
    card.addChild(block.view);
  }

  private closeBestiary(): void {
    this.bestiaryBox?.destroy({ children: true });
    this.bestiaryBox = null;
    this.bestiaryEntry = null;
  }

  /* ---- leaving --------------------------------------------------------- */

  private beginDescent(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // restore the stock Strays before building the run (a previous custom
    // party may still have its kit overlay on the content tables)
    applyPartyContent(null);
    const seed = this.params.seed?.trim();
    ctx.run = startRun(
      seed === undefined || seed === "" ? randomSeed() : seed,
      applyUnlocks(ctx.meta, this.catalog),
    );
    ctx.scenes.goto("floorgen");
  }

  private toTitle(): void {
    this.ctx?.scenes.goto("title");
  }
}
