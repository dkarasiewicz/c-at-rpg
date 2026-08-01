/**
 * CAT TOWN — the hub between runs (balance-and-meta.md §4,
 * roster-and-persistence.md §4).
 *
 * A PLACE, not a menu, laid out in four honest regions so the screen answers
 * four questions in the order a player asks them:
 *
 *   top-left      THE ARCHIVE — what you have met, who you have lost, and the
 *                 way back out (Title · The Bestiary · The Memorial)
 *   top-right     THE TIN — what you have, what you have ever had, and how
 *                 much of the town is still unbuilt
 *   bottom-left   THE CLOWDER — the cats who live here, who is setting out,
 *                 and (a tap) the Den sheet for any of them
 *   bottom-right  WHAT YOU DO — The Den · The Roster · Begin the descent
 *
 * Between them is the painting, and the unlocks are six LOCATIONS pinned to
 * the thing they name in it (the notice board, the bowls, the cart, the
 * stoop, the fence, the storm drain). Their name plates are ONE LINE now —
 * the blurb moved to a hover tip and the panel — because six two-line plates
 * on a 1280×720 room merged into an unreadable strip.
 *
 * Everything it knows about progression comes from core/meta — this file
 * computes no costs and grants no content. Buying is
 * `purchase()` → `saveMeta()`; managing a cat is `overlays/townDen.ts` →
 * `saveMeta()`; starting a run is `startRun(seed, applyUnlocks(meta), {meta})`,
 * so the engine never learns that a meta layer exists.
 *
 * Chrome is the shared kit (widgets.ts) exactly as landing.ts uses it:
 * `sceneBackdrop`, `vignette`, `panel`, `avatar`, `bar`, `heading`, `label`,
 * `button`, `chip`, `scrim`, `toastCard`, `makeSpriteIcon`. FAIL-SOFT: with
 * no generated art at all the scene still renders — palette wash behind,
 * glyph markers, and the procedural cat recipe for the clowder.
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { CatId, ClassId, EnemyId } from "../../core/types.js";
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
  descendingCats,
  feedCat,
  livingRoster,
  setDescending,
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
  chip,
  enemyAvatar,
  heading,
  label,
  makeSpriteIcon,
  makeTooltip,
  panel,
  scrim,
  sceneBackdrop,
  toastCard,
  UNKNOWN_SPRITE_ID,
  vignette,
} from "../widgets.js";
import { isTouch, padHit, padHitBox } from "../touch.js";
import { makeIntelBlock, makeLevelChip, makeTierPill } from "../draw/intel.js";
import { drawCat } from "../draw/cats.js";
import { catTexture, hasSprite } from "../sprites.js";
import { tween } from "../tween.js";
import { randomSeed } from "./title.js";
import { applyPartyContent } from "./partyCreator.js";
import { makeRosterPanel } from "../overlays/rosterPanel.js";
import { makeTownDenBox } from "../overlays/townDen.js";
import type { ProgressPanelApi } from "../overlays/progressPanel.js";
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
const MARGIN = 40;

const EYEBROW_Y = 30;
const BANNER_Y = 58;
const SUB_Y = 100;

/** THE ARCHIVE — the reading room, top-left. */
const NAV_Y = 26;
const NAV_W = 150;
const NAV_H = 38;

const TIN_W = 300;
const TIN_H = 96;
const TIN_X = DESIGN_W - MARGIN - TIN_W;
const TIN_Y = 26;

const RECEIPT_W = TIN_W;
const RECEIPT_X = TIN_X;
const RECEIPT_Y = TIN_Y + TIN_H + SPACE.md;

/** Marker: painted art disc + a ONE-LINE name plate under it. */
const MARK_ART = 76;
/** MINIMUM plate width — a long name widens it (see `makeMarker`). */
const MARK_W = 132;
const PLATE_H = 26;

/**
 * THE CLOWDER band — its own glass strip along the bottom-left.
 *
 * The cats used to stand free on the painted floor, which was charming right
 * up until the roster screen made this row load-bearing: the caption ran into
 * the place plates above it and the last cat ran into the action bar beside
 * it. A band gives the region an edge, keeps it clear of both, and the glass
 * is translucent enough that the cats still read as standing IN the room.
 */
const CLOWDER_X = MARGIN;
const CLOWDER_Y = 536;
const CLOWDER_W = 530;
const CLOWDER_H = 164;
const CLOWDER_PAD = SPACE.md;
/** Feet on the band's floor line. */
const CLOWDER_FEET_Y = CLOWDER_Y + 124;
const CAT_H = 80;
const CAT_PITCH_MAX = 104;
/** More than this and the band would rather point at the Den. */
const CLOWDER_MAX = 6;

const BAR_Y = 650;
const BAR_H = 52;
/** Action-bar button widths, right-to-left from the primary action. */
const BTN_DESCEND = 300;
const BTN_ACTION = 158;

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

/** "THE NOTICE BOARD" → "NOTICE BOARD": the article is not information. */
export function plateName(name: string): string {
  return name.replace(/^THE\s+/i, "");
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

/** The clowder band's second line — what the town is, in one count. */
export function clowderLine(
  living: number,
  going: number,
  capacity: number,
): string {
  return `${living} live here · ${going} of ${capacity} set out`;
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
  private tipLayer: Container | null = null;
  private tinText: Text | null = null;
  private lifetimeText: Text | null = null;
  private townBar: { view: Container; set(v: number, m: number): void } | null =
    null;
  private townBuiltText: Text | null = null;
  private townLeftText: Text | null = null;
  private placeBox: Container | null = null;
  private openPlace: string | null = null;
  /** The Bestiary modal, and which species it has drilled into. */
  private bestiaryBox: Container | null = null;
  private bestiaryEntry: EnemyId | null = null;
  /** The roster modal, and whether it is showing the memorial. */
  private rosterBox: Container | null = null;
  private rosterMemorial = false;
  /** THE DEN, as a town building (roster-and-persistence.md §4). */
  private denBox: Container | null = null;
  private denApi: ProgressPanelApi | null = null;
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

    /* ---- the archive (top-left): the two records, and the way out ----- */
    // These three sell nothing and decide nothing, which is exactly why they
    // are NOT down on the action bar with the three things that do.
    let navX = MARGIN;
    for (const [text, hotkey, onTap] of [
      ["Title", "T", () => this.toTitle()],
      ["The Bestiary", "B", () => this.showBestiary(null)],
      ["The Memorial", "M", () => this.showRoster(true)],
    ] as const) {
      const b = button(text, NAV_W, NAV_H, onTap, {
        hotkey,
        fontSize: TYPE.small,
      });
      b.view.position.set(navX, NAV_Y);
      view.addChild(b.view);
      navX += NAV_W + SPACE.sm;
    }

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
    // Laid out right-to-left from the primary action, so "Begin the descent"
    // is always in the same corner however many buttons live beside it.
    let barX = DESIGN_W - MARGIN - BTN_DESCEND;
    const descend = button(
      "Begin the descent",
      BTN_DESCEND,
      BAR_H,
      () => this.beginDescent(),
      { primary: true, hotkey: "Enter" },
    );
    descend.view.position.set(barX, BAR_Y);
    view.addChild(descend.view);

    barX -= SPACE.lg + BTN_ACTION;
    const roster = button(
      "The Roster",
      BTN_ACTION,
      BAR_H,
      () => this.showRoster(false),
      { hotkey: "R" },
    );
    roster.view.position.set(barX, BAR_Y);
    view.addChild(roster.view);

    barX -= SPACE.lg + BTN_ACTION;
    const den = button("The Den", BTN_ACTION, BAR_H, () => this.showDen(), {
      hotkey: "P",
    });
    den.view.position.set(barX, BAR_Y);
    view.addChild(den.view);

    /* ---- tips and toasts ride above everything ----------------------- */
    this.tipLayer = new Container();
    view.addChild(this.tipLayer);

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
    if (this.denBox) {
      if (key === "esc" || key === "p") {
        this.closeDen();
        return true;
      }
      this.denApi?.onKey(key);
      return true; // modal, like the place panel
    }
    if (this.rosterBox) {
      if (key === "esc" || key === "r") {
        this.closeRoster();
        return true;
      }
      if (key === "m") {
        this.showRoster(!this.rosterMemorial);
        return true;
      }
      return true; // modal, like the place panel
    }
    if (this.bestiaryBox) {
      if (key === "esc" || key === "b") {
        if (this.bestiaryEntry !== null) this.showBestiary(null);
        else this.closeBestiary();
        return true;
      }
      return true; // modal, like the place panel
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
    if (key === "p") {
      this.showDen();
      return true;
    }
    if (key === "r") {
      this.showRoster(false);
      return true;
    }
    if (key === "m") {
      this.showRoster(true);
      return true;
    }
    if (key === "b") {
      this.showBestiary(null);
      return true;
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
    this.tipLayer = null;
    this.tinText = null;
    this.lifetimeText = null;
    this.townBar = null;
    this.townBuiltText = null;
    this.townLeftText = null;
    this.placeBox = null;
    this.openPlace = null;
    this.bestiaryBox = null;
    this.bestiaryEntry = null;
    this.rosterBox = null;
    this.rosterMemorial = false;
    this.denApi = null;
    this.denBox = null;
    this.view?.destroy({ children: true });
    this.view = null;
  }

  /* ---- tips + toasts ---------------------------------------------------- */

  private clearTip(): void {
    const host = this.tipLayer;
    if (!host) return;
    for (const c of host.removeChildren()) c.destroy({ children: true });
  }

  private showTip(text: string, x: number, y: number): void {
    const host = this.tipLayer;
    if (!host) return;
    this.clearTip();
    const tip = makeTooltip(text);
    tip.position.set(
      Math.max(SPACE.sm, Math.min(x, DESIGN_W - Math.ceil(tip.width) - 8)),
      Math.max(SPACE.sm, Math.min(y, DESIGN_H - Math.ceil(tip.height) - 8)),
    );
    host.addChild(tip);
  }

  /** One line, bottom-centre, gone in a moment — the Den's only voice here. */
  private toast(text: string): void {
    const host = this.tipLayer;
    if (!host) return;
    const card = toastCard(text);
    card.position.set((DESIGN_W - card.width) / 2, DESIGN_H - 120);
    host.addChild(card);
    tween(card, { alpha: 0 }, 2200, "linear", () => {
      if (!card.destroyed) card.destroy({ children: true });
    });
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
    this.lifetimeText.position.set(SPACE.lg, 36);
    card.addChild(this.lifetimeText);

    // How much of the town is actually built — the kit's xp bar, honestly
    // used, with the sentence SPLIT either side of it. The old single line
    // ("town 13/13 · 2650 ✦ to build it all") argued with itself: it printed
    // the catalog's original price next to a town that had already bought all
    // of it. What is BUILT sits under the left of the bar, what is LEFT TO
    // BUY under the right — and at zero the right-hand half says so.
    const b = bar(TIN_W - SPACE.lg * 2, 8, { kind: "xp" });
    b.view.position.set(SPACE.lg, 58);
    card.addChild(b.view);
    this.townBar = b;

    this.townBuiltText = label("", { mono: true, dim: true, size: TYPE.tiny });
    this.townBuiltText.position.set(SPACE.lg, 70);
    card.addChild(this.townBuiltText);

    this.townLeftText = label("", { mono: true, dim: true, size: TYPE.tiny });
    this.townLeftText.anchor.set(1, 0);
    this.townLeftText.position.set(TIN_W - SPACE.lg, 70);
    card.addChild(this.townLeftText);
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

    // ONE LINE, sized to its CONTENT. Six two-line plates (name + blurb) on a
    // 1280×720 room is 264 px of stacked text in the middle of a painting,
    // and four of the six overlapped: the plates merged into an unreadable
    // strip and two of them buried their own hotkey chip. The blurb is one
    // hover away, and it is printed in full the moment the place is opened —
    // which is where a player is actually deciding anything.
    const name = heading(plateName(place.name), 3, {
      center: true,
      fill: PAL.text,
    });
    const hotkey = label(`${index + 1}`, {
      mono: true,
      size: TYPE.tiny,
      fill: PAL.gold,
    });
    const hotW = Math.ceil(hotkey.width) + SPACE.sm * 2;
    const plateW = Math.max(
      MARK_W,
      Math.ceil(name.width) + hotW + SPACE.md * 2,
    );

    const plate = panel(plateW, PLATE_H, {
      variant: "glass",
      radius: RADIUS.button,
    });
    plate.position.set(-plateW / 2, MARK_ART / 2 + 8);
    view.addChild(plate);
    // centre the name in the space RIGHT OF the hotkey, so the chip always
    // has room of its own
    name.position.set(hotW + (plateW - hotW) / 2, 5);
    hotkey.position.set(SPACE.sm, 7);
    plate.addChild(name, hotkey);

    const badge = new Container();
    badge.position.set(MARK_ART / 2 - 4, -MARK_ART / 2 + 2);
    view.addChild(badge);

    view.eventMode = "static";
    view.cursor = "pointer";
    padHitBox(
      view,
      -MARK_ART / 2,
      -MARK_ART / 2,
      MARK_ART,
      MARK_ART + PLATE_H + 8,
    );
    view.on("pointertap", () => this.showPlace(place.id));
    view.on("pointerover", () => {
      if (isTouch()) return; // no hover lift on a finger
      tween(view.scale, { x: 1.05, y: 1.05 }, 120);
      this.showTip(
        `${place.name} — ${place.blurb}`,
        place.x - 120,
        place.y + MARK_ART / 2 + PLATE_H + 14,
      );
    });
    view.on("pointerout", () => {
      tween(view.scale, { x: 1, y: 1 }, 120);
      if (!isTouch()) this.clearTip();
    });

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
    if (this.townBuiltText) {
      this.townBuiltText.text = `town ${owned}/${this.catalog.length} built`;
    }
    if (this.townLeftText) {
      // What is LEFT to build, never what the catalog cost when it was empty.
      const remaining = this.catalog.filter((d) => !isUnlocked(meta, d.id));
      const left = catalogCost(remaining);
      this.townLeftText.text =
        remaining.length === 0 ? "every door open" : `${left} ✦ still to build`;
      this.townLeftText.style.fill =
        remaining.length === 0 ? PAL.heal : PAL.textDim;
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
    const c = chip(text, { fill });
    m.badge.addChild(c.view);
    m.badge.x = MARK_ART / 2 - c.width / 2;
  }

  /** The cats who actually live here, standing in their own band. */
  private refreshClowder(): void {
    const host = this.clowderLayer;
    const ctx = this.ctx;
    if (!host || !ctx) return;
    for (const c of host.removeChildren()) c.destroy({ children: true });
    this.cats = [];

    // Who LIVES here is a list of INDIVIDUALS, not a class pool
    // (roster-and-persistence.md §1) — and who SETS OUT is the player's own
    // pick from the roster screen, not a draw at the door. So the town floor
    // can tell the truth: these are the cats, and these are the ones going
    // down tonight.
    const roster = livingRoster(ctx.meta);
    const capacity = this.overlay.partyCapacity;
    const going = descendingCats(ctx.meta, capacity);
    const goingIds = new Set(going.map((c) => c.id));
    const shown = roster.slice(0, CLOWDER_MAX);
    const lost = ctx.meta.memorial?.length ?? 0;

    const band = panel(CLOWDER_W, CLOWDER_H, { variant: "glass" });
    band.position.set(CLOWDER_X, CLOWDER_Y);
    host.addChild(band);

    const title = heading("THE CLOWDER", 3);
    title.position.set(CLOWDER_PAD, SPACE.sm);
    band.addChild(title);

    const counts = label(clowderLine(roster.length, going.length, capacity), {
      size: TYPE.tiny,
      dim: true,
      mono: true,
    });
    counts.anchor.set(1, 0);
    counts.position.set(CLOWDER_W - CLOWDER_PAD, SPACE.sm + 3);
    band.addChild(counts);

    const inner = CLOWDER_W - CLOWDER_PAD * 2;
    const pitch = Math.min(CAT_PITCH_MAX, inner / Math.max(1, shown.length));
    const x0 = CLOWDER_X + CLOWDER_PAD + pitch / 2;

    shown.forEach((cat, i) => {
      const descends = goingIds.has(cat.id);
      const cx = x0 + i * pitch;
      const c = new Container();
      c.position.set(cx, CLOWDER_FEET_Y);
      const tex = catTexture(cat.classId);
      if (tex && tex.height > 0) {
        const sp = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
        sp.scale.set(CAT_H / tex.height);
        c.addChild(sp);
      } else {
        const g = new Graphics();
        drawCat(g, cat.classId, "sit", 0.8);
        c.addChild(g);
      }
      // A cat staying home stands further back: smaller and dimmer, but
      // never invisible — at 0.55 over the dark town floor the grey ones
      // (Pixel especially) read as failed-to-load art.
      if (!descends) {
        c.alpha = 0.72;
        c.scale.set(0.84); // feet are the anchor, so it plants correctly
      }
      // Every cat is a doorway into its own sheet: tapping one opens THE DEN
      // on it, which is the whole point of the town rebuild (§4 — you manage
      // the cats you own, here, between runs).
      c.eventMode = "static";
      c.cursor = "pointer";
      padHitBox(c, -pitch / 2, -CAT_H, pitch, CAT_H);
      c.on("pointertap", () => this.showDen(cat.id));
      c.on("pointerover", () => {
        if (isTouch()) return;
        this.showTip(
          `${cat.name} — ${CLASSES[cat.classId].className} · Lv ${cat.level}\n` +
            `「${cat.standName}」\n` +
            (descends ? "setting out tonight" : "staying home") +
            " · click for the Den",
          cx - 130,
          CLOWDER_Y - 78,
        );
      });
      c.on("pointerout", () => {
        if (!isTouch()) this.clearTip();
      });
      host.addChild(c);
      this.cats.push({ view: c, baseY: CLOWDER_FEET_Y, phase: i * 0.9 });

      const name = label(cat.name, {
        size: TYPE.tiny,
        center: true,
        bold: descends,
        fill: descends ? PAL.text : PAL.textDim,
      });
      name.position.set(cx, CLOWDER_FEET_Y + SPACE.xs);
      host.addChild(name);

      const rank = going.findIndex((g) => g.id === cat.id);
      // Short enough to fit the pitch with six cats on the floor — the level
      // and the gear live on the Den sheet, which is where a player is
      // actually comparing them.
      const role = label(
        descends ? `sets out · ${rank + 1}` : `home · Lv ${cat.level}`,
        { size: TYPE.tiny, center: true, dim: true },
      );
      role.alpha = descends ? 0.9 : 0.7;
      role.position.set(cx, CLOWDER_FEET_Y + SPACE.xs + 14);
      host.addChild(role);
    });

    // The two things the band cannot show: cats past the sixth, and the ones
    // who are not coming back at all. Both live on the header's SECOND line —
    // under the floor is where the cats' own name and role labels are, and a
    // footer there landed straight on top of them.
    const subY = 26;
    if (roster.length > shown.length) {
      const more = label(
        `+${roster.length - shown.length} more — see The Den`,
        {
          size: TYPE.tiny,
          dim: true,
        },
      );
      more.position.set(CLOWDER_PAD, subY);
      band.addChild(more);
    }
    const memo = label(
      lost > 0 ? `${lost} did not come back — The Memorial` : "nobody lost yet",
      { size: TYPE.tiny, dim: true, fill: lost > 0 ? PAL.danger : PAL.textDim },
    );
    memo.anchor.set(1, 0);
    memo.position.set(CLOWDER_W - CLOWDER_PAD, subY);
    memo.eventMode = "static";
    memo.cursor = "pointer";
    padHitBox(memo, -Math.ceil(memo.width), 0, Math.ceil(memo.width), 16);
    memo.on("pointertap", () => this.showRoster(true));
    band.addChild(memo);
  }

  /* ---- THE DEN, as a town building (§4) --------------------------------- */

  /**
   * The screen the feedback asked for: levels, skills and gear on the cats
   * you actually own, between runs. It is the SAME panel the run uses
   * (overlays/progressPanel.ts) reading a different book, so the two can
   * never drift apart — see overlays/townDen.ts.
   */
  private showDen(catId?: CatId): void {
    const view = this.view;
    const ctx = this.ctx;
    if (!view || !ctx) return;
    this.closeDen();
    this.clearTip();
    const box = makeTownDenBox({
      getMeta: () => ctx.meta,
      setMeta: (meta) => {
        ctx.meta = meta;
        saveMeta(meta);
        this.refreshClowder();
      },
      capacity: this.overlay.partyCapacity,
      onClose: () => this.closeDen(),
      toast: (t) => this.toast(t),
      ...(catId !== undefined ? { catId } : {}),
    });
    view.addChild(box.view);
    // tips and toasts must stay on top of a modal that fills the screen
    if (this.tipLayer) view.addChild(this.tipLayer);
    this.denBox = box.view;
    this.denApi = box.api;
  }

  private closeDen(): void {
    this.denApi = null;
    this.denBox?.destroy({ children: true });
    this.denBox = null;
  }

  /* ---- THE ROSTER SCREEN (roster-and-persistence.md §3) ---------------- */

  /**
   * Who descends, and (flipped with M) who did not come back. It is a modal
   * here, exactly like the Bestiary, rather than a SceneManager overlay:
   * overlays are run-scoped (loot, pause) and Cat Town has no run.
   *
   * Every interaction round-trips through the profile — pick → `setDescending`
   * → `saveMeta` → rebuild — so what the town floor draws and what
   * `beginDescent` sends down can never disagree.
   */
  private showRoster(memorial = this.rosterMemorial): void {
    const view = this.view;
    const ctx = this.ctx;
    if (!view || !ctx) return;
    this.rosterBox?.destroy({ children: true });
    this.rosterMemorial = memorial;
    this.clearTip();

    const capacity = this.overlay.partyCapacity;
    const picked = descendingCats(ctx.meta, capacity).map((c) => c.id);
    const box = makeRosterPanel({
      meta: ctx.meta,
      capacity,
      descending: picked,
      memorial,
      onChange: (next: CatId[]) => this.setDescent(next),
      onToggleMemorial: (show: boolean) => this.showRoster(show),
      onClose: () => this.closeRoster(),
      // §3: hunger is bought off HERE, out of the same tin the unlocks come
      // out of. That competition is the decision the design asks for.
      shinies: ctx.meta.shinies,
      onFeed: (id: CatId) => this.feed(id),
    });
    view.addChild(box);
    if (this.tipLayer) view.addChild(this.tipLayer);
    this.rosterBox = box;
  }

  private setDescent(ids: readonly CatId[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.meta = setDescending(ctx.meta, ids);
    saveMeta(ctx.meta);
    this.showRoster();
    this.refreshClowder();
  }

  /**
   * FEED ONE CAT (roster-and-persistence.md §3). The wallet pays, the roster
   * screen rebuilds, and the tin on the town floor drops by what it cost —
   * the whole point being that the player watches an unlock get further away.
   */
  private feed(id: CatId): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const out = feedCat(ctx.meta, id);
    if (out.spent <= 0) return;
    ctx.meta = out.meta;
    saveMeta(ctx.meta);
    this.showRoster();
    this.refreshAll();
  }

  private closeRoster(): void {
    this.rosterBox?.destroy({ children: true });
    this.rosterBox = null;
    this.rosterMemorial = false;
    this.refreshClowder();
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
    this.clearTip();

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
    if (this.tipLayer) view.addChild(this.tipLayer);
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
    this.clearTip();

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
    if (this.tipLayer) view.addChild(this.tipLayer);
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
    // THE ROSTER GOES DOWN, not a draw at the door: `startRun` reads the
    // player's pick (roster screen → `setDescending`) out of the profile.
    ctx.run = startRun(
      seed === undefined || seed === "" ? randomSeed() : seed,
      applyUnlocks(ctx.meta, this.catalog),
      { meta: ctx.meta },
    );
    ctx.scenes.goto("floorgen");
  }

  private toTitle(): void {
    this.ctx?.scenes.goto("title");
  }
}
