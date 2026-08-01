/**
 * THE ROSTER SPLIT — one vocabulary, one look, for "who is in the party" vs
 * "who is somewhere else entirely".
 *
 * `RunState.cats` ALWAYS carries all four class slots — every classId-keyed
 * system depends on that — but a run only FIELDS `marchingOrder`
 * (balance-and-meta.md §2), and Cat Town gates which classes a run may field
 * at all (`rosterClasses`). Drawing all four slots as equal cards with a
 * small grey tag is how a two-cat party reads as a four-cat party: same size,
 * same brightness, same prominence, four full HP bars, four rows of nine
 * paws. The tag loses that argument every time.
 *
 * So every screen that shows the roster splits it here:
 *
 *   PARTY  the cats fielded this run (plus the ones who fell doing it) —
 *          full-size cards, full brightness, unchanged.
 *   CAMP   everyone else — a compact, desaturated strip under a rule, with
 *          the reason printed on the row and a one-line explanation over the
 *          group. Small, quiet, and obviously ELSEWHERE, while still saying
 *          each cat's HP and Lives out loud.
 *
 * Presentation only: nothing here decides anything, it reads run state
 * through core's own selectors (`rosterClasses` / `partyCapacity`).
 */
import { ColorMatrixFilter, Container, Graphics } from "pixi.js";
import type { CatRunState, RunState } from "../core/types.js";
import { CLASSES } from "../content/classes.js";
import { maxHp } from "../core/run/party.js";
import { partyCapacity, rosterClasses } from "../core/run/runState.js";
import { PAL } from "./palette.js";
import { SPACE } from "./layout.js";
import { TYPE } from "./textStyles.js";
import { avatar, label } from "./widgets.js";

/* ---------------------------------------------------------------------- */
/* Standing                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Where a cat actually is.
 *   fielded  in the marching order, alive — this run's party
 *   fallen   out of Lives; it went down there and it did not come back
 *   reserve  alive, this run COULD still field it (the town houses the
 *            class) but there is no slot / no recruit yet
 *   away     the town does not house this class for this run — it is not on
 *            the descent in any sense, it just occupies a data slot
 */
export type CatStanding = "fielded" | "fallen" | "reserve" | "away";

export function catStanding(run: RunState, cat: CatRunState): CatStanding {
  if (cat.lives <= 0) return "fallen";
  if (run.marchingOrder.includes(cat.classId)) return "fielded";
  return rosterClasses(run).includes(cat.classId) ? "reserve" : "away";
}

/** True for the two standings that belong in the compact camp strip. */
export function isAtCamp(standing: CatStanding): boolean {
  return standing === "reserve" || standing === "away";
}

export interface RosterSplit {
  /** Fielded + fallen, in party-slot order — the full-size cards. */
  party: CatRunState[];
  /** Reserve + away, in party-slot order — the compact strip. */
  camp: CatRunState[];
  /** How many cats this run may field at most. */
  capacity: number;
  /** How many it is fielding right now (alive, in the marching order). */
  fielded: number;
}

export function splitRoster(run: RunState): RosterSplit {
  const party: CatRunState[] = [];
  const camp: CatRunState[] = [];
  let fielded = 0;
  for (const cat of run.cats) {
    const standing = catStanding(run, cat);
    if (standing === "fielded") fielded += 1;
    (isAtCamp(standing) ? camp : party).push(cat);
  }
  // A formation can never be shown as bigger than its own ceiling ("PARTY
  // 4/3" is nonsense on a screen); core clamps recruitment, this clamps the
  // sentence in case a save or a custom party ever arrives wider.
  const capacity = Math.max(partyCapacity(run), fielded);
  return { party, camp, capacity, fielded };
}

/* ---------------------------------------------------------------------- */
/* Words                                                                   */
/* ---------------------------------------------------------------------- */

/** The strip's own title. Where they are, not what they are not. */
export const CAMP_TITLE = "BACK IN CAT TOWN";

/** "PARTY 2/3" — the count that answers "why are there four of them?". */
export function partyCountLabel(run: RunState): string {
  const { fielded, capacity } = splitRoster(run);
  return `PARTY ${fielded}/${capacity}`;
}

/**
 * THE one-line explanation. A tag says "benched"; this says why, which is
 * the thing the player actually asked.
 */
export function campNote(run: RunState): string {
  const { camp, capacity, fielded } = splitRoster(run);
  if (camp.length === 0) return "";
  const room = capacity - fielded;
  const recruitable = camp.some((c) => catStanding(run, c) === "reserve");
  if (recruitable && room > 0) {
    return (
      `This run fields ${fielded} of ${capacity} cats. ` +
      `Room for ${room} more — one can still be found on the way down.`
    );
  }
  if (recruitable) {
    return (
      `The formation is full at ${capacity}. ` +
      `These cats stayed home and never took a step down here.`
    );
  }
  return (
    `This run fields ${fielded} of ${capacity} cats. ` +
    `These live in Cat Town and are not on this descent at all.`
  );
}

/** Past tense, for the results roll-call. */
export function campNotePast(run: RunState): string {
  const { camp, capacity, fielded } = splitRoster(run);
  if (camp.length === 0) return "";
  return (
    `The run fielded ${fielded} of ${capacity} cats. ` +
    `These never left Cat Town — their Lives and HP are the ones they woke up with.`
  );
}

/** The reason printed on one camp row. Short enough to sit under a name. */
export function campReason(run: RunState, cat: CatRunState): string {
  if (catStanding(run, cat) === "away") return "not on this run";
  const { capacity, fielded } = splitRoster(run);
  return fielded < capacity
    ? "can still join, deeper down"
    : "no room in the party";
}

/** "24/24 hp · 9 lives" — the numbers a camp row must never hide. */
export function campStats(run: RunState, cat: CatRunState): string {
  const max = maxHp(cat, run.level);
  return `${cat.hp}/${max} hp · ${cat.lives} lives`;
}

/* ---------------------------------------------------------------------- */
/* Chrome                                                                  */
/* ---------------------------------------------------------------------- */

/** Row pitch of the compact strip (two text lines beside a small face). */
export const CAMP_ROW_H = 34;

/**
 * A cat face that reads as ELSEWHERE: small, greyed out and dropped in
 * contrast. Not `avatar({ dead: true })` — that is the KO'd look, and a cat
 * sitting at home is not a corpse.
 */
export function campAvatar(cat: CatRunState, size = 22): Container {
  const face = avatar(cat.classId, size, { frame: false });
  const grey = new ColorMatrixFilter();
  grey.saturate(-0.85, false);
  face.filters = [grey];
  face.alpha = 0.8;
  return face;
}

/**
 * ONE camp row: face · name · why it is not here · HP and Lives.
 * Origin top-left, spans `w × CAMP_ROW_H`.
 */
export function campRow(run: RunState, cat: CatRunState, w: number): Container {
  const row = new Container();
  row.alpha = 0.62;

  const face = campAvatar(cat, 22);
  face.position.set(SPACE.sm + 11, CAMP_ROW_H / 2);
  row.addChild(face);

  const textX = SPACE.sm + 28;
  const name = label(CLASSES[cat.classId].catName, {
    size: TYPE.tiny,
    bold: true,
    dim: true,
  });
  name.position.set(textX, 2);
  const why = label(campReason(run, cat), {
    size: TYPE.tiny,
    fill: PAL.textDim,
  });
  why.alpha = 0.85;
  why.position.set(textX, 17);
  row.addChild(name, why);

  const stats = label(campStats(run, cat), {
    size: TYPE.tiny,
    mono: true,
    dim: true,
  });
  stats.anchor.set(1, 0.5);
  stats.position.set(w - SPACE.sm, CAMP_ROW_H / 2);
  row.addChild(stats);
  return row;
}

/**
 * The camp treatment for a fixed CARD RECT — the run map's party strip,
 * where the four slots are pre-positioned geometry and a card cannot simply
 * be dropped from the flow. Same idea, laid out inside `w × h`: no HP bar,
 * no paw row (a cat at home has spent nothing), a small greyed face pushed
 * to the corner, and the reason said in words. It is visibly a NOTE where
 * its neighbours are cards.
 */
export function campCard(
  run: RunState,
  cat: CatRunState,
  w: number,
  h: number,
): Container {
  const view = new Container();
  view.alpha = 0.5;
  view.addChild(
    new Graphics()
      .roundRect(0.5, 0.5, w - 1, h - 1, 6)
      .stroke({ width: 1, color: PAL.border, alpha: 0.8 }),
  );

  const face = campAvatar(cat, 24);
  face.position.set(SPACE.sm + 12, h / 2 + 4);
  view.addChild(face);

  // three tiny lines, centred as a block in whatever height it is given
  const top = Math.max(SPACE.sm, Math.round((h - 44) / 2) + 6);
  const textX = SPACE.sm + 30;
  const name = label(CLASSES[cat.classId].catName, {
    size: TYPE.tiny,
    bold: true,
    dim: true,
  });
  name.position.set(textX, top);
  const why = label(campReason(run, cat), { size: TYPE.tiny, dim: true });
  why.alpha = 0.85;
  why.position.set(textX, top + 15);
  const stats = label(campStats(run, cat), {
    size: TYPE.tiny,
    mono: true,
    dim: true,
  });
  stats.alpha = 0.85;
  stats.position.set(textX, top + 30);
  view.addChild(name, why, stats);

  const tag = label(CAMP_TITLE, { size: TYPE.tiny, dim: true });
  tag.anchor.set(1, 0);
  tag.alpha = 0.8;
  tag.position.set(w - SPACE.sm, SPACE.xs);
  view.addChild(tag);
  return view;
}

export interface CampSectionOpts {
  /** Override the explanation (the results screen speaks in past tense). */
  note?: string;
  /** Draw the hairline rule above the title (default true). */
  rule?: boolean;
}

export interface CampSection {
  view: Container;
  /** Total height used — lay the next thing out below it. */
  height: number;
}

/**
 * The whole secondary group: a rule, a quiet title with the count, the
 * one-line explanation, then one compact row per cat. Returns `height: 0`
 * with an empty container when the whole roster is fielded, so callers can
 * add it unconditionally.
 */
export function campSection(
  run: RunState,
  w: number,
  opts: CampSectionOpts = {},
): CampSection {
  const view = new Container();
  const { camp } = splitRoster(run);
  if (camp.length === 0) return { view, height: 0 };

  let y = 0;
  if (opts.rule !== false) {
    view.addChild(
      new Graphics()
        .moveTo(SPACE.sm, 0)
        .lineTo(w - SPACE.sm, 0)
        .stroke({ width: 1, color: PAL.border, alpha: 0.9 }),
    );
    y += SPACE.sm;
  }

  const title = label(`${CAMP_TITLE} · ${camp.length}`, {
    size: TYPE.tiny,
    bold: true,
    dim: true,
  });
  title.position.set(SPACE.sm, y);
  view.addChild(title);
  y += 15;

  const noteText = opts.note ?? campNote(run);
  if (noteText !== "") {
    const note = label(noteText, {
      size: TYPE.tiny,
      dim: true,
      wrap: w - SPACE.sm * 2,
    });
    note.alpha = 0.85;
    note.position.set(SPACE.sm, y);
    view.addChild(note);
    y += Math.ceil(note.height) + SPACE.xs;
  }

  for (const cat of camp) {
    const row = campRow(run, cat, w);
    row.position.set(0, y);
    view.addChild(row);
    y += CAMP_ROW_H;
  }
  return { view, height: y };
}
