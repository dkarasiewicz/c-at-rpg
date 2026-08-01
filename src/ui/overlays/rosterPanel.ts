/**
 * THE ROSTER SCREEN — the missing UI (docs/design/roster-and-persistence.md §3).
 *
 * This is the screen `recruitCat` never had. Cat Town houses individuals now,
 * and here the player picks WHICH OF THEM DESCEND, up to party capacity, and
 * in what order they march. Everything a choice needs is on the card — level,
 * Lives, the three gear slots, the Stand, and whatever conditions the cat is
 * carrying — because a choice you cannot see the cost of is not a choice.
 *
 * It also holds THE MEMORIAL (§2): the cats who did not come back, with how
 * far they got and what did it. Perma-death is only worth having if the loss
 * is somewhere you can go and look at it.
 *
 * Pure presentation over `core/meta/roster.ts`: this file decides nothing.
 * Tapping a card calls back with a new order and the SCENE writes it through
 * `setDescending`, so the panel can be rebuilt from the profile at any time.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import type { CatId, EquipInstance } from "../../core/types.js";
import type {
  MemorialEntry,
  MetaCat,
  MetaProfile,
} from "../../core/meta/types.js";
import { livingRoster } from "../../core/meta/roster.js";
import { feedCost, hungerOf } from "../../core/run/conditions.js";
import { CLASSES } from "../../content/classes.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, RADIUS, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  avatar,
  button,
  heading,
  label,
  panel,
  sceneBackdrop,
  scrim,
  vignette,
} from "../widgets.js";
import { hasSprite, spriteTextureFor } from "../sprites.js";
import { padHit } from "../touch.js";

/* ---- geometry (design px) -------------------------------------------- */
export const ROSTER_W = 1000;
export const ROSTER_H = 640;
const CARD_W = 300;
const CARD_H = 148;
const CARD_GAP = SPACE.md;
const CARD_COLS = 3;
const GRID_TOP = 118;
const FOOT_H = 44;

/* ---- the art (visual-v2 §backdrops) ---------------------------------- */

/** Backdrop id per face of the screen. Absent art ⇒ the old flat scrim. */
const SCREEN_ART = {
  clowder: "scene:roster",
  memorial: "scene:memorial",
} as const;
/** The keyed emblem the memorial is titled with. */
const MEMORIAL_MARK = "prop:memorialMark";
/** Emblem size in the header, and in the "nobody yet" empty state. */
const MARK_H = 56;
const MARK_EMPTY = 132;

export interface RosterPanelOpts {
  meta: MetaProfile;
  /** How many cats may descend (the run overlay's `partyCapacity`). */
  capacity: number;
  /** Current pick, front→back. */
  descending: readonly CatId[];
  /** The player changed the pick; the scene persists it and rebuilds. */
  onChange(next: CatId[]): void;
  /** Close the screen. */
  onClose(): void;
  /** Show the memorial instead of the roster. */
  memorial?: boolean;
  onToggleMemorial(show: boolean): void;

  /* ---- §3 conditions: hunger is bought off in town, in shinies ---- */

  /** The town wallet, so a card can say whether the meal is affordable. */
  shinies?: number;
  /**
   * Feed one cat (roster-and-persistence.md §3). ABSENT ⇒ no bowls are drawn
   * at all, which is what every caller that predates conditions gets.
   */
  onFeed?(id: CatId): void;
}

/**
 * TOGGLE a cat in or out of the descent, or — if it is already in and not
 * last — move it one place FORWARD in the marching order.
 *
 * One tap doing two jobs is deliberate: with at most four cats, a separate
 * "reorder" mode is more chrome than the problem deserves, and the rule reads
 * as one sentence on screen ("tap to send · tap again to move up · shift-tap
 * to bench"). Pure, so it is testable without pixi.
 */
export function toggleDescending(
  current: readonly CatId[],
  id: CatId,
  capacity: number,
  opts: { remove?: boolean } = {},
): CatId[] {
  const at = current.indexOf(id);
  if (at < 0) {
    if (opts.remove) return current.slice();
    if (current.length >= capacity) return current.slice();
    return [...current, id];
  }
  if (opts.remove || at === 0) return current.filter((c) => c !== id);
  const next = current.slice();
  next[at] = next[at - 1];
  next[at - 1] = id;
  return next;
}

/* ---- words ----------------------------------------------------------- */

const gearName = (e: EquipInstance | null): string =>
  e ? (EQUIP_DEFS[e.defId]?.name ?? e.defId) : "—";

/** "Bin Lid · — · Spiked Collar" — the three slots, always all three. */
export function gearLine(cat: MetaCat): string {
  return [cat.weapon, cat.trinket, cat.collar].map(gearName).join(" · ");
}

/** "9 lives" / "1 life" — a cat on its last one is the loudest state here. */
export function livesLine(n: number): string {
  return `${n} ${n === 1 ? "life" : "lives"}`;
}

/** What the cat is carrying between runs (§3). Empty ⇒ "rested". */
export function conditionLine(cat: MetaCat): string {
  const cs = cat.conditions ?? [];
  if (cs.length === 0) return "rested";
  return cs.map((c) => c.label).join(" · ");
}

/**
 * A one-line label that never overruns `room` px: too long and it is cut back
 * to a whole separated item plus "…", so the line still reads as a list that
 * continues rather than a word that broke. Measuring is the only way to know
 * — the strings here are content (a cat's scars and quirks), not layout.
 */
function fitted(
  text: string,
  room: number,
  opts: Parameters<typeof label>[1],
): ReturnType<typeof label> {
  const made = label(text, opts);
  if (made.width <= room) return made;
  // whole items first — "hungry · Clouded Eye …" beats "hungry · Clouded E…"
  const parts = text.split(" · ");
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    made.text = `${parts.slice(0, keep).join(" · ")} …`;
    if (made.width <= room) return made;
  }
  // one item, and even it does not fit: fall back to characters rather than
  // dropping the line, because "Clou…" still names something and "…" does not
  const first = parts[0] ?? text;
  for (let n = first.length - 1; n > 0; n--) {
    made.text = `${first.slice(0, n)}…`;
    if (made.width <= room) return made;
  }
  made.text = "…";
  return made;
}

/**
 * The bowl (§3: "hunger… fed in town for shinies, so it competes with unlocks
 * for the same currency"). The label says the price out loud, because that
 * competition is the decision and a hidden price is not a decision.
 */
export function feedLine(cat: MetaCat, shinies: number): string {
  const cost = feedCost(cat.conditions);
  if (cost === 0) return "fed";
  return shinies >= cost ? `Feed · ${cost} ✦` : `Feed · ${cost} ✦ (short)`;
}

/** The sentence under the title — what this screen is FOR. */
export function rosterNote(picked: number, capacity: number): string {
  if (picked === 0) {
    return `Nobody is going down. Tap a cat to send them — up to ${capacity}.`;
  }
  if (picked < capacity) {
    return (
      `${picked} of ${capacity} are going down, in the order shown. ` +
      `Tap an unsent cat to add them; tap a sent one to move it forward.`
    );
  }
  return (
    `The party is full at ${capacity}, in the order shown. ` +
    `Tap a sent cat to move it forward, or shift-tap to leave it home.`
  );
}

/** One memorial line, as a sentence. */
export function memorialLine(m: MemorialEntry): string {
  return `${m.name} · Lv ${m.level} · floor ${m.floor} · ${m.cause}`;
}

/* ---- the art ---------------------------------------------------------- */

/**
 * The painting INSIDE a card: cover-fitted, masked to the card's own rounded
 * corners, and washed darker as it goes down so rows and buttons keep their
 * contrast.
 *
 * This is the difference between a screen and a form. The clowder grid is
 * three cats wide and six deep, so a town with two cats in it left two thirds
 * of a 1000×640 card as flat purple — and the memorial with three names on it
 * was worse, because the emptiness is the subject there. The art fills that
 * space with the place the screen is ABOUT, and everything readable is drawn
 * on top of an opaque tile regardless.
 *
 * Fail-soft like every other painted-first helper: no texture, no art, and
 * the caller's layout does not move a pixel.
 */
function cardArt(
  id: string,
  w: number,
  h: number,
  opts: { alpha?: number; fade?: number } = {},
): Container | null {
  const tex = spriteTextureFor(id);
  if (!tex || tex.width <= 0 || tex.height <= 0) return null;
  const view = new Container();

  const sp = new Sprite({ texture: tex });
  const s = Math.max(w / tex.width, h / tex.height);
  sp.scale.set(s);
  sp.position.set((w - tex.width * s) / 2, (h - tex.height * s) / 2);
  sp.alpha = opts.alpha ?? 0.5;
  view.addChild(sp);

  // Top-lit: the header band keeps the painting and the body sinks into the
  // card, because everything the player has to READ is lower down and the
  // brightest thing in both paintings (candle wax, moonlit crates) is too.
  //
  // 40 bands, eased: fewer and the step between two flat alphas is a visible
  // horizontal seam across the card — 14 of them looked like scan lines.
  //
  // WASH_FLOOR is the part of the wash that is NOT a gradient. Without it the
  // top of the card is unwashed paint, and that is what made these two panels
  // the least tonally even screens in the game: measured across a 4×3 grid the
  // clowder spanned 41 levels of luma and the memorial 38, against 22 for the
  // Den, 25 for the Bestiary and 25 for a battle. The bright half of a
  // painting outranking the UI is not "art direction", it is a screen that
  // does not match the rest of the game. The floor costs the top of the card
  // some paint and brings both panels inside the house range; the t² term
  // above it still sinks the body, so nothing about the reading order moves.
  const wash = new Graphics();
  const steps = 40;
  const deep = opts.fade ?? 0.62;
  const WASH_FLOOR = 0.38;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    wash.rect(0, (h * i) / steps, w, h / steps + 1).fill({
      color: PAL.bgDeep,
      alpha: deep * (WASH_FLOOR + (1 - WASH_FLOOR) * t * t),
    });
  }
  view.addChild(wash);

  const mask = new Graphics()
    .roundRect(0, 0, w, h, RADIUS.panel)
    .fill(PAL.text);
  view.addChild(mask);
  view.mask = mask;
  view.eventMode = "none";
  return view;
}

/** The keyed memorial emblem at `size`, or null when the art pack lacks it. */
function memorialMark(size: number): Container | null {
  const tex = spriteTextureFor(MEMORIAL_MARK);
  if (!tex || tex.height <= 0) return null;
  const view = new Container();
  const sp = new Sprite({ texture: tex, anchor: 0.5 });
  sp.scale.set(size / tex.height);
  view.addChild(sp);
  view.eventMode = "none";
  return view;
}

/* ---- the panel ------------------------------------------------------- */

/**
 * Build the whole modal. Returns the container to add to the scene; the
 * caller destroys it and rebuilds on every change (the panel is small and
 * cheap, and a rebuild-from-state screen cannot drift out of sync).
 */
export function makeRosterPanel(opts: RosterPanelOpts): Container {
  const box = new Container();

  // WHERE YOU ARE, not what you left. The clowder and the memorial are two
  // different places in the town, so each gets its own room behind the card
  // instead of a blur of whatever screen the modal opened over. With no art
  // pack this is exactly the flat scrim it has always been.
  const artId = opts.memorial ? SCREEN_ART.memorial : SCREEN_ART.clowder;
  const painted = hasSprite(artId);
  //
  // The room is BEHIND the modal and has to look it. At dim 0.52 / scrim 0.34
  // the painting outside the card was brighter than the card in places, which
  // reads as a leak rather than a room — worst on a phone, where a 2.16 aspect
  // crops to the busiest part of both paintings. These values keep the room
  // legible and put the card back on top of it.
  if (painted) {
    box.addChild(
      sceneBackdrop(artId, DESIGN_W, DESIGN_H, { dim: 0.6 }),
      vignette(DESIGN_W, DESIGN_H, 0.95),
    );
  }
  const back = scrim(DESIGN_W, DESIGN_H, painted ? 0.44 : 0.72);
  back.eventMode = "static";
  back.on("pointertap", () => opts.onClose());
  box.addChild(back);

  const card = panel(ROSTER_W, ROSTER_H, {
    variant: "raised",
    accent: PAL.gold,
  });
  card.position.set((DESIGN_W - ROSTER_W) / 2, (DESIGN_H - ROSTER_H) / 2);
  box.addChild(card);
  const inside = cardArt(artId, ROSTER_W, ROSTER_H, {
    alpha: opts.memorial ? 0.5 : 0.44,
    fade: 0.84,
  });
  if (inside) card.addChild(inside);

  const roster = livingRoster(opts.meta);
  const fallen = opts.meta.memorial ?? [];
  const picked = opts.descending.filter((id) =>
    roster.some((c) => c.id === id),
  );

  // The memorial is titled with the keyed candle emblem; the clowder is not,
  // because a shrine mark over a list of living cats would be a lie.
  const mark = opts.memorial ? memorialMark(MARK_H) : null;
  if (mark) {
    mark.position.set(SPACE.lg + MARK_H / 2, SPACE.md + 28);
    card.addChild(mark);
  }
  const textX = SPACE.lg + (mark ? MARK_H + SPACE.md : 0);

  const title = heading(opts.memorial ? "THE MEMORIAL" : "THE CLOWDER", 2, {
    fill: PAL.gold,
  });
  title.position.set(textX, SPACE.md);
  card.addChild(title);

  const note = label(
    opts.memorial
      ? "Everyone who went down there and did not come back."
      : rosterNote(picked.length, opts.capacity),
    { dim: true, size: TYPE.small, wrap: ROSTER_W - textX - SPACE.lg - 260 },
  );
  note.position.set(textX, SPACE.md + 34);
  card.addChild(note);

  const tally = label(
    opts.memorial
      ? `${fallen.length} lost`
      : `${picked.length}/${opts.capacity} descending · ${roster.length} in town`,
    { mono: true, fill: picked.length > 0 ? PAL.gold : PAL.textDim },
  );
  tally.anchor.set(1, 0);
  tally.position.set(ROSTER_W - SPACE.lg, SPACE.md + 6);
  card.addChild(tally);

  if (opts.memorial) buildMemorial(card, fallen);
  else buildGrid(card, roster, picked, opts);

  const footY = ROSTER_H - FOOT_H - SPACE.md;
  const flip = button(
    opts.memorial ? "Back to the clowder" : `The memorial · ${fallen.length}`,
    240,
    FOOT_H,
    () => opts.onToggleMemorial(!opts.memorial),
    { hotkey: "M" },
  );
  flip.view.position.set(SPACE.lg, footY);
  card.addChild(flip.view);

  const close = button("Back to town", 200, FOOT_H, () => opts.onClose(), {
    hotkey: "Esc",
  });
  close.view.position.set(ROSTER_W - 200 - SPACE.lg, footY);
  card.addChild(close.view);

  return box;
}

/* ---- the grid -------------------------------------------------------- */

function buildGrid(
  card: Container,
  roster: readonly MetaCat[],
  picked: readonly CatId[],
  opts: RosterPanelOpts,
): void {
  if (roster.length === 0) return; // impossible (the §2 guard rail), but total
  const gridX =
    (ROSTER_W - (CARD_COLS * CARD_W + (CARD_COLS - 1) * CARD_GAP)) / 2;

  // Sent cats first, in marching order — the screen reads top-left to
  // bottom-right as "front of the line to back, then everyone staying home".
  const order = [
    ...picked
      .map((id) => roster.find((c) => c.id === id))
      .filter((c): c is MetaCat => c !== undefined),
    ...roster.filter((c) => !picked.includes(c.id)),
  ];

  order.forEach((cat, i) => {
    const rank = picked.indexOf(cat.id);
    const tile = makeCatCard(cat, rank, opts.capacity, {
      ...(opts.shinies !== undefined ? { shinies: opts.shinies } : {}),
      ...(opts.onFeed ? { onFeed: opts.onFeed } : {}),
    });
    tile.position.set(
      gridX + (i % CARD_COLS) * (CARD_W + CARD_GAP),
      GRID_TOP + Math.floor(i / CARD_COLS) * (CARD_H + CARD_GAP),
    );
    tile.eventMode = "static";
    tile.cursor = "pointer";
    padHit(tile, CARD_W, CARD_H);
    tile.on("pointertap", (e) => {
      const shift = typeof e?.shiftKey === "boolean" ? e.shiftKey : false;
      opts.onChange(
        toggleDescending(picked, cat.id, opts.capacity, { remove: shift }),
      );
    });
    card.addChild(tile);
  });
}

/**
 * ONE CAT, everything the choice needs: who, what, how strong, how close to
 * gone, what it is wearing and what it is carrying.
 */
export interface CatCardOpts {
  /** Town wallet — only needed when `onFeed` is given. */
  shinies?: number;
  /** Feeding this cat. Absent ⇒ the card draws no bowl. */
  onFeed?(id: CatId): void;
}

export function makeCatCard(
  cat: MetaCat,
  rank: number,
  capacity: number,
  opts: CatCardOpts = {},
): Container {
  const going = rank >= 0;
  const tile = new Container();
  tile.addChild(
    panel(CARD_W, CARD_H, {
      variant: going ? "raised" : "solid",
      radius: RADIUS.button,
      ...(going ? { accent: PAL.gold } : {}),
    }),
  );
  if (!going) tile.alpha = 0.68;

  const face = avatar(cat.classId, 46, going ? { ring: PAL.gold } : {});
  face.position.set(SPACE.md + 24, 44);
  tile.addChild(face);

  const textX = SPACE.md + 56;
  const name = label(cat.name, { bold: true, size: TYPE.body });
  name.position.set(textX, SPACE.sm);
  tile.addChild(name);

  const cls = label(
    `${CLASSES[cat.classId].className} · Lv ${cat.level} · ${livesLine(cat.lives)}`,
    { size: TYPE.tiny, dim: true },
  );
  cls.position.set(textX, SPACE.sm + 20);
  tile.addChild(cls);

  const stand = label(`「${cat.standName}」`, {
    size: TYPE.tiny,
    fill: PAL.gold,
  });
  stand.alpha = 0.9;
  stand.position.set(textX, SPACE.sm + 36);
  tile.addChild(stand);

  const gear = label(gearLine(cat), {
    size: TYPE.tiny,
    dim: true,
    wrap: CARD_W - SPACE.md * 2,
  });
  gear.position.set(SPACE.md, CARD_H - 46);
  tile.addChild(gear);

  const hunger = hungerOf(cat.conditions);
  // The conditions share this line with THE BOWL, and a cat that has picked
  // up a scar and a quirk on top of being hungry ("hungry · Clouded Eye ·
  // Skittish") is longer than the space left over. Unclipped it ran under the
  // Feed button and died mid-word, which reads as a rendering fault rather
  // than a list that continues — so it is fitted to the room it actually has.
  const bowlDrawn = opts.onFeed !== undefined && hunger > 0;
  const condRoom =
    CARD_W - SPACE.md - SPACE.sm - (bowlDrawn ? 108 + SPACE.sm : SPACE.md);
  const cond = fitted(conditionLine(cat), condRoom, {
    size: TYPE.tiny,
    ...(hunger >= 2 ? { fill: PAL.danger } : { dim: true }),
  });
  cond.alpha = 0.85;
  cond.position.set(SPACE.md, CARD_H - 28);
  tile.addChild(cond);

  // THE BOWL. Only drawn for a cat that is actually hungry — a fed clowder
  // shows no chrome at all, so the button IS the state.
  if (bowlDrawn) {
    const cost = feedCost(cat.conditions);
    const afford = (opts.shinies ?? 0) >= cost;
    const feed = button(
      feedLine(cat, opts.shinies ?? 0),
      108,
      22,
      () => opts.onFeed?.(cat.id),
      { disabled: !afford, fontSize: TYPE.tiny },
    );
    feed.view.position.set(CARD_W - 108 - SPACE.sm, CARD_H - 30);
    // the bowl is its own target: tapping it must not also re-order the party
    feed.view.on("pointertap", (e) => e.stopPropagation());
    tile.addChild(feed.view);
  }

  // The rank badge IS the marching order — the number the battle screen will
  // draw this cat at. "3/3" says "and the party is full".
  const badge = label(going ? `${rank + 1}` : "home", {
    size: TYPE.tiny,
    mono: true,
    bold: going,
    fill: going ? PAL.gold : PAL.textDim,
  });
  badge.anchor.set(1, 0);
  badge.position.set(CARD_W - SPACE.sm, SPACE.xs);
  tile.addChild(badge);
  if (going && rank === capacity - 1) {
    const full = label("last", { size: TYPE.tiny, dim: true });
    full.anchor.set(1, 0);
    full.position.set(CARD_W - SPACE.sm, SPACE.xs + 14);
    tile.addChild(full);
  }
  return tile;
}

/* ---- the memorial ---------------------------------------------------- */

const MEM_ROW_H = 40;

function buildMemorial(
  card: Container,
  fallen: readonly MemorialEntry[],
): void {
  if (fallen.length === 0) {
    // An empty memorial is the best state in the game and it used to look
    // like a failed fetch: one grey sentence on a slab of purple. It gets the
    // emblem and a place to stand instead — over the QUIET third of the
    // painting (the shrine itself is weighted right), on a plate, because a
    // line of type laid straight onto candlelit stone cannot be read.
    const cx = ROSTER_W * 0.29;
    const mid = ROSTER_H / 2 + 4;
    const emblem = memorialMark(MARK_EMPTY);
    if (emblem) {
      emblem.position.set(cx, mid - 34);
      card.addChild(emblem);
    }
    const none = label("Nobody yet. Keep it that way.", {
      size: TYPE.body,
      center: true,
    });
    const ny = mid + (emblem ? MARK_EMPTY / 2 + 6 : 0);
    const plate = new Graphics()
      .roundRect(
        cx - none.width / 2 - SPACE.md,
        ny - SPACE.xs,
        none.width + SPACE.md * 2,
        none.height + SPACE.sm,
        RADIUS.button,
      )
      .fill({ color: PAL.panel, alpha: 0.72 });
    none.position.set(cx, ny);
    card.addChild(plate, none);
    return;
  }
  const w = ROSTER_W - SPACE.lg * 2;
  const rows = Math.min(
    fallen.length,
    Math.floor((ROSTER_H - GRID_TOP - FOOT_H - SPACE.lg * 2) / MEM_ROW_H),
  );
  for (let i = 0; i < rows; i++) {
    const m = fallen[i];
    const row = new Container();
    row.position.set(SPACE.lg, GRID_TOP + i * MEM_ROW_H);
    // A plate per name, not a bare hairline: the card is painted now, and a
    // name has to read over candlelight without the row dissolving into it.
    row.addChild(
      new Graphics()
        .roundRect(-SPACE.sm, 0, w + SPACE.sm * 2, MEM_ROW_H - 4, RADIUS.button)
        .fill({ color: PAL.panel, alpha: 0.66 })
        .moveTo(0, MEM_ROW_H - 3)
        .lineTo(w, MEM_ROW_H - 3)
        .stroke({ width: 1, color: PAL.border, alpha: 0.55 }),
    );
    const face = avatar(m.classId, 26, { frame: false, dead: true });
    face.position.set(14, MEM_ROW_H / 2 - 2);
    row.addChild(face);

    const name = label(m.name, { bold: true, size: TYPE.small });
    name.position.set(36, 2);
    const detail = label(
      `Lv ${m.level} · fell on floor ${m.floor} · ${m.cause}` +
        (m.runs > 0
          ? ` · ${m.runs} descent${m.runs === 1 ? "" : "s"} survived`
          : ""),
      { size: TYPE.tiny, dim: true },
    );
    detail.position.set(36, 19);
    row.addChild(name, detail);

    const stand = label(`「${m.standName}」`, { size: TYPE.tiny, dim: true });
    stand.anchor.set(1, 0.5);
    stand.alpha = 0.8;
    stand.position.set(w - SPACE.sm, MEM_ROW_H / 2 - 2);
    row.addChild(stand);
    card.addChild(row);
  }
  if (fallen.length > rows) {
    const more = label(`…and ${fallen.length - rows} more`, {
      size: TYPE.tiny,
      dim: true,
    });
    more.position.set(SPACE.lg + 36, GRID_TOP + rows * MEM_ROW_H + 4);
    card.addChild(more);
  }
}
