/**
 * THE DEN, AS A TOWN BUILDING (roster-and-persistence.md §4).
 *
 * The player's complaint was precise: levelling four cats they had not earned
 * "feels wrong". So the Den stops being a mid-run panel over a party the
 * engine dealt you and becomes somewhere you WALK TO in Cat Town, over the
 * clowder you actually own — each cat at its own level, spending its own
 * Whisker Points, choosing its own loadout, and kitted out of the town stash
 * that a descent (and a death) fills.
 *
 * It is the same screen: `overlays/progressPanel.ts` does all the drawing,
 * and this file only supplies the `DenBook` it reads — where the cats come
 * from, what level each one is on, and which pile of gear it may equip from.
 * Nothing is duplicated, so the town Den and the run Den can never drift.
 *
 * The pure half (everything above the pixi divider) is profile in → NEW
 * profile out and never touches pixi:
 *
 *   townDenCats     the clowder, descending first (that is the tab order)
 *   townRunCat      a MetaCat projected into the CatRunState the panel edits
 *   bankTownCat     that edit written back onto the MetaCat
 *   equipFromStash  stash → cat, whatever comes off goes back to the stash
 *   unequipToStash  cat → stash
 *
 * Gear coming home to the stash rather than evaporating is the same call
 * `buryCat` made (§2): the roster is small, and a swap you cannot undo is a
 * swap nobody makes.
 */
import { Container } from "pixi.js";
import type { CatId, CatRunState, EquipSlot } from "../../core/types.js";
import type { MetaCat, MetaProfile } from "../../core/meta/types.js";
import {
  descendingCats,
  livingRoster,
  rosterCat,
  runCat,
} from "../../core/meta/index.js";
import { canEquip, equipItem, unequipItem } from "../../core/loot/inventory.js";
import { DESIGN_H, DESIGN_W } from "../layout.js";
import { scrim } from "../widgets.js";
import {
  makeDenPanel,
  placeDenBox,
  type DenBook,
  type DenPoolItem,
  type ProgressPanelApi,
} from "./progressPanel.js";

/* ====================================================================== */
/* ==  PURE (no pixi below this line until the divider)                == */
/* ====================================================================== */

export interface TownDenCat {
  cat: MetaCat;
  /** Marching position, or -1 for a cat staying home this descent. */
  rank: number;
}

/**
 * THE TAB ORDER: whoever is going down tonight first, in marching order,
 * then everyone staying home. The Den's tab strip splits on exactly that —
 * the party at full width, the rest as quiet notes — so the screen answers
 * "who am I actually kitting out?" before the player reads a single stat.
 */
export function townDenCats(meta: MetaProfile, capacity: number): TownDenCat[] {
  const going = descendingCats(meta, capacity);
  const rankOf = new Map(going.map((c, i) => [c.id, i]));
  const out = livingRoster(meta).map((cat) => ({
    cat,
    rank: rankOf.get(cat.id) ?? -1,
  }));
  out.sort((a, b) => {
    if (a.rank >= 0 && b.rank >= 0) return a.rank - b.rank;
    return Number(a.rank < 0) - Number(b.rank < 0);
  });
  return out;
}

/**
 * A town cat as the panel wants it. `runCat` already does this for a descent
 * (full HP at the level it is on), and the Den only ever reads HP — it is the
 * truthful answer for a cat resting at home.
 */
export function townRunCat(cat: MetaCat): CatRunState {
  return runCat(cat, cat.level);
}

/**
 * Write a panel edit back onto the town cat. Only what the Den can change
 * moves: spent points, the loadout and the three gear slots. Level, xp, Lives
 * and the memorial belong to the run and to `core/meta/roster.ts`.
 */
export function bankTownCat(cat: MetaCat, ran: CatRunState): MetaCat {
  const next: MetaCat = {
    ...cat,
    weapon: ran.weapon,
    trinket: ran.trinket,
    collar: ran.collar ?? null,
  };
  if (ran.points) next.points = { ...ran.points };
  else delete next.points;
  if (ran.loadout) next.loadout = [...ran.loadout];
  else delete next.loadout;
  return next;
}

const withCat = (meta: MetaProfile, next: MetaCat): MetaProfile => ({
  ...meta,
  roster: (meta.roster ?? []).map((c) => (c.id === next.id ? next : c)),
});

/** The stash as the Den's gear pool — the handle is the stash index. */
export function stashPool(meta: MetaProfile): DenPoolItem[] {
  return (meta.stash ?? []).map((item, ref) => ({ item, ref }));
}

/**
 * Put stash piece `ref` on `catId`. Whatever it replaces goes back to the
 * stash, so a swap is always reversible. Total: an illegal request (unknown
 * cat, empty slot, a weapon of the wrong class) returns the SAME profile.
 */
export function equipFromStash(
  meta: MetaProfile,
  catId: CatId,
  ref: number,
): MetaProfile {
  const cat = rosterCat(meta, catId);
  const stash = meta.stash ?? [];
  const item = stash[ref];
  if (!cat || cat.lives <= 0 || !item) return meta;
  const ran = townRunCat(cat);
  if (!canEquip(ran, item)) return meta;
  const r = equipItem(ran, item);
  const rest = stash.filter((_, i) => i !== ref);
  return {
    ...withCat(meta, bankTownCat(cat, r.cat)),
    stash: r.replaced ? [...rest, r.replaced] : rest,
  };
}

/** Take a slot off and drop it in the stash. */
export function unequipToStash(
  meta: MetaProfile,
  catId: CatId,
  slot: EquipSlot,
): MetaProfile {
  const cat = rosterCat(meta, catId);
  if (!cat?.[slot]) return meta;
  const r = unequipItem(townRunCat(cat), slot);
  if (!r.removed) return meta;
  return {
    ...withCat(meta, bankTownCat(cat, r.cat)),
    stash: [...(meta.stash ?? []), r.removed],
  };
}

/* ====================================================================== */
/* ==  PIXI                                                            == */
/* ====================================================================== */

export interface TownDenOpts {
  getMeta(): MetaProfile;
  /** Persist and repaint — the scene does `saveMeta` + `refreshAll`. */
  setMeta(meta: MetaProfile): void;
  /** How many cats may descend, so the tabs can split party from home. */
  capacity: number;
  onClose?(): void;
  toast?(text: string): void;
  /** Open on this cat (the town floor taps through with one). */
  catId?: CatId;
}

/** The town's `DenBook`: the clowder, each cat's own level, the town stash. */
export function townBook(opts: TownDenOpts): DenBook {
  const rows = (): TownDenCat[] => townDenCats(opts.getMeta(), opts.capacity);
  const idAt = (i: number): CatId | null => rows()[i]?.cat.id ?? null;
  return {
    eyebrow: "THE CLOWDER · POINTS · SKILLS · GEAR",
    title: "THE DEN",
    cats: () => rows().map((r) => townRunCat(r.cat)),
    away(i) {
      const rank = rows()[i]?.rank ?? -1;
      if (rank >= 0) return null;
      return {
        tab: "stays home",
        sheet: "STAYING HOME · not on this descent",
      };
    },
    levelOf: (i) => rows()[i]?.cat.level ?? 1,
    xpOf: (i) => rows()[i]?.cat.xp ?? 0,
    writeCat(i, next) {
      const cat = rows()[i]?.cat;
      if (!cat) return;
      opts.setMeta(withCat(opts.getMeta(), bankTownCat(cat, next)));
    },
    poolTitle: "THE TOWN STASH",
    poolEmpty:
      "Nothing in the stash fits this cat. Weapons are class-locked; " +
      "trinkets and collars are universal — and the stash fills with " +
      "whatever a descent carries home.",
    pool: () => stashPool(opts.getMeta()),
    equipFromPool(i, ref) {
      const id = idAt(i);
      if (id !== null) opts.setMeta(equipFromStash(opts.getMeta(), id, ref));
    },
    unequip(i, slot) {
      const id = idAt(i);
      if (id !== null) opts.setMeta(unequipToStash(opts.getMeta(), id, slot));
    },
  };
}

/**
 * THE DEN as Cat Town shows it: the shared panel, parked where every host
 * parks it, over the shared modal scrim. The scene owns the container and
 * destroys it on close, exactly like the Bestiary and the Roster.
 */
export function makeTownDenBox(opts: TownDenOpts): {
  view: Container;
  api: ProgressPanelApi;
} {
  const book = townBook(opts);
  const start = opts.catId;
  const index =
    start === undefined
      ? undefined
      : Math.max(
          0,
          townDenCats(opts.getMeta(), opts.capacity).findIndex(
            (r) => r.cat.id === start,
          ),
        );
  const api = placeDenBox(
    makeDenPanel(book, {
      ...(opts.onClose ? { onClose: opts.onClose } : {}),
      ...(opts.toast ? { toast: opts.toast } : {}),
      ...(index === undefined ? {} : { catIndex: index }),
    }),
  );
  const view = new Container();
  const back = scrim(DESIGN_W, DESIGN_H, 0.72);
  back.eventMode = "static";
  back.on("pointertap", () => opts.onClose?.());
  view.addChild(back, api.view);
  return { view, api };
}
