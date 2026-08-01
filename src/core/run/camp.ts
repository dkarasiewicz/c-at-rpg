/**
 * THE CAMP — the engine (docs/design/roster-and-persistence.md §4).
 *
 * "A run-map node type where the party stops. Cats interact with EACH OTHER,
 * not with the dungeon."
 *
 * A camp is a small, closed decision: the fire holds `CAMP_EMBERS` embers, and
 * every action spends one. That is the shared resource §4 asks for — the party
 * cannot eat AND bandage AND tend AND talk AND keep watch, so a camp is a
 * question about what this particular clowder needs most right now.
 *
 *   eat       hunger down, a little HP back — the §3 condition, acted on
 *   bandage   HP back, the biggest single heal at the fire
 *   tend      a scar stops pulling until the stairs down (a floor-long
 *             tempMod that cancels it — the scar itself is permanent)
 *   talk      two named cats, one exchange, and a Bond that outlives the run
 *   watch     nobody sleeps deeply, and everybody starts the next fight with
 *             energy in hand
 *
 * EVERYTHING here is the existing vocabulary: HP clamped to `maxHp`, `TempMod`
 * deltas, `energyNextBattle` (capped exactly where `events.md` caps it) and
 * `CatCondition`s. There is no camp-only stat and no camp-only rule.
 *
 * PURE: run in, new run out. No rng — what the fire says is derived from the
 * node's own payload seed, which is itself derived (`hash(runSeed, floor,
 * 'node', id)`), so a camp is the same camp on a reload and on a replay.
 */
import type {
  CatId,
  CatRunState,
  ItemId,
  ResultLine,
  RunState,
} from "../types.js";
import { CONSUMABLES } from "../../content/consumables.js";
import {
  CAMP_ACTION_LINES,
  CAMP_EXCHANGES,
  CAMP_OPENERS,
  type CampExchange,
  type CampTag,
} from "../../content/camp.js";
import { QUIRKS } from "../../content/conditions.js";
import { hash } from "../rng.js";
import { isStack, removeConsumable } from "../loot/inventory.js";
import { maxHp } from "./party.js";
import { catById, fieldedCats } from "./runState.js";
import {
  conditionMods,
  grantCondition,
  hungerOf,
  isTended,
  scarsOf,
  tendMods,
  withConditions,
  withHunger,
  type CatCondition,
} from "./conditions.js";

/* ------------------------------------------------------------------ */
/* the shared resource                                                 */
/* ------------------------------------------------------------------ */

/**
 * How many actions ONE camp buys. Three, because the interesting number is
 * the one that cannot cover the party: a three-cat clowder cannot bandage
 * everybody, so somebody's need loses.
 */
export const CAMP_EMBERS = 3;

/** Bandage: fraction of max HP restored. */
export const CAMP_BANDAGE_PCT = 0.25;

/** Eat with real food in the bag: fraction of max HP, on top of the food. */
export const CAMP_EAT_PCT = 0.1;

/** Hunger a proper meal takes off; scraps take off half of it (rounded up). */
export const CAMP_MEAL_HUNGER = 2;

/** `energyNextBattle` ceiling — the same one `events.md` §1 enforces. */
export const ENERGY_NEXT_CAP = 6;

/** Energy the watch hands every fielded cat, and the watcher on top. */
export const WATCH_ENERGY = 1;
export const WATCH_ENERGY_WATCHER = 1;

export type CampActionId = "eat" | "bandage" | "tend" | "talk" | "watch";

export interface CampActionDef {
  id: CampActionId;
  name: string;
  /** Hotkey the scene prints. */
  hotkey: string;
  /** Embers it burns. */
  cost: number;
  /** One line on the button. */
  blurb: string;
  /** How many cats it is aimed at. */
  target: "cat" | "pair";
  /** Once per camp, whoever it is aimed at? (`talk` and `watch` are). */
  once: boolean;
}

/** The five camp actions, in menu order (§4's list, verbatim). */
export const CAMP_ACTIONS: readonly CampActionDef[] = [
  {
    id: "eat",
    name: "Eat",
    hotkey: "1",
    cost: 1,
    blurb: "Break out the tin. Takes the edge off the hunger.",
    target: "cat",
    once: false,
  },
  {
    id: "bandage",
    name: "Bandage",
    hotkey: "2",
    cost: 1,
    blurb: "Someone gets patched up properly.",
    target: "cat",
    once: false,
  },
  {
    id: "tend",
    name: "Tend a scar",
    hotkey: "3",
    cost: 1,
    blurb: "An old mark stops pulling until the stairs down.",
    target: "cat",
    once: false,
  },
  {
    id: "talk",
    name: "Talk",
    hotkey: "4",
    cost: 1,
    blurb: "Two of them sit up. Something gets said.",
    target: "pair",
    once: true,
  },
  {
    id: "watch",
    name: "Keep watch",
    hotkey: "5",
    cost: 1,
    blurb: "Nobody is surprised in the next fight.",
    target: "cat",
    once: true,
  },
];

export const campAction = (id: CampActionId): CampActionDef =>
  CAMP_ACTIONS.find((a) => a.id === id)!;

/* ------------------------------------------------------------------ */
/* the session                                                         */
/* ------------------------------------------------------------------ */

/**
 * One fire, in progress. Scene-scoped: a camp node is marked resolved the
 * moment the party walks onto it (the run map's rule for every node), so
 * there is no state here worth surviving a reload — which is also why nothing
 * in this module is written onto `RunState`.
 */
export interface CampSession {
  embers: number;
  /** `"bandage:cat-3"`, `"watch"` — what has already been done here. */
  spent: string[];
}

export const newCampSession = (): CampSession => ({
  embers: CAMP_EMBERS,
  spent: [],
});

const spendKey = (id: CampActionId, who: readonly CatId[]): string =>
  campAction(id).once ? id : `${id}:${who[0] ?? ""}`;

export interface CampCheck {
  ok: boolean;
  /** Why not, in words the button can print. Empty when `ok`. */
  why: string;
}

/**
 * May the party take this action, on these cats, right now? Total: an unknown
 * action or an unknown cat is a plain "no", never a throw.
 */
export function canTakeCamp(
  run: RunState,
  session: CampSession,
  id: CampActionId,
  who: readonly CatId[],
): CampCheck {
  const def = CAMP_ACTIONS.find((a) => a.id === id);
  if (!def) return { ok: false, why: "nothing to do" };
  if (session.embers < def.cost) return { ok: false, why: "the fire is out" };
  if (session.spent.includes(spendKey(id, who))) {
    return {
      ok: false,
      why: def.once ? "already done" : "already saw to them",
    };
  }
  const need = def.target === "pair" ? 2 : 1;
  const cats = who.map((cid) => catById(run, cid));
  if (cats.length < need || cats.some((c) => !c || c.lives <= 0)) {
    return { ok: false, why: "nobody to do it to" };
  }
  const cat = cats[0] as CatRunState;
  if (id === "bandage" && cat.hp >= maxHp(cat, run.level)) {
    return { ok: false, why: "not a scratch on them" };
  }
  if (id === "tend" && untendedScar(cat) === undefined) {
    return { ok: false, why: "no old marks to tend" };
  }
  if (id === "talk" && who[0] === who[1]) {
    return { ok: false, why: "takes two" };
  }
  return { ok: true, why: "" };
}

/** The first scar this cat is carrying that is not already tended. */
export function untendedScar(cat: CatRunState): CatCondition | undefined {
  return scarsOf(cat.conditions).find((s) => !isTended(cat, s.id));
}

/** Any food in the backpack, for `eat` — the first stack that heals. */
export function campFood(run: RunState): ItemId | null {
  for (const slot of run.inventory.slots) {
    if (!isStack(slot)) continue;
    if (CONSUMABLES[slot.defId]?.explore?.heal !== undefined) return slot.defId;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* taking an action                                                    */
/* ------------------------------------------------------------------ */

export interface CampOutcome {
  run: RunState;
  session: CampSession;
  /** Delta lines, the same shape the event and loot screens print. */
  results: ResultLine[];
  /** One authored line of flavour — what it looked like. */
  flavour: string;
}

const healed = (cat: CatRunState, level: number, amount: number): number =>
  Math.max(0, Math.min(amount, maxHp(cat, level) - cat.hp));

const patch = (
  run: RunState,
  id: CatId,
  fn: (c: CatRunState) => CatRunState,
): RunState => ({
  ...run,
  cats: run.cats.map((c) => (c.id === id ? fn(c) : c)),
});

/**
 * DO IT. Returns the run untouched (and no results) when the action is not
 * legal, so a caller can fire and forget; otherwise the ember is spent and the
 * effects land through the ordinary vocabulary.
 */
export function takeCampAction(
  run: RunState,
  session: CampSession,
  id: CampActionId,
  who: readonly CatId[],
): CampOutcome {
  const check = canTakeCamp(run, session, id, who);
  if (!check.ok) return { run, session, results: [], flavour: "" };

  const def = campAction(id);
  const a = catById(run, who[0]) as CatRunState;
  const b = who[1] !== undefined ? catById(run, who[1]) : undefined;
  const results: ResultLine[] = [];
  let next = run;

  switch (id) {
    case "eat": {
      const food = campFood(run);
      let heal = 0;
      let points = 1;
      if (food) {
        const { inv } = removeConsumable(run.inventory, food, 1);
        next = { ...next, inventory: inv };
        const spec = CONSUMABLES[food].explore?.heal;
        const max = maxHp(a, run.level);
        heal =
          spec === "full"
            ? max - a.hp
            : healed(
                a,
                run.level,
                (spec ?? 0) + Math.floor(CAMP_EAT_PCT * max),
              );
        points = CAMP_MEAL_HUNGER;
        results.push({
          text: `${CONSUMABLES[food].name} → ${a.name}`,
          tone: "neutral",
        });
      } else {
        heal = healed(
          a,
          run.level,
          Math.floor(CAMP_EAT_PCT * maxHp(a, run.level)),
        );
        results.push({ text: "Scraps and grit", tone: "neutral" });
      }
      const before = hungerOf(a.conditions);
      next = patch(next, a.id, (c) => {
        const fedCat = withConditions(
          c,
          withHunger(c.conditions, before - points),
        );
        return { ...fedCat, hp: fedCat.hp + heal };
      });
      if (before > 0) {
        results.push({
          text: `${a.name} hunger −${Math.min(points, before)}`,
          tone: "gain",
        });
      }
      if (heal > 0) {
        results.push({ text: `${a.name} +${heal} HP`, tone: "gain" });
      }
      break;
    }

    case "bandage": {
      const heal = healed(
        a,
        run.level,
        Math.max(1, Math.floor(CAMP_BANDAGE_PCT * maxHp(a, run.level))),
      );
      next = patch(next, a.id, (c) => ({ ...c, hp: c.hp + heal }));
      results.push({ text: `${a.name} +${heal} HP`, tone: "gain" });
      break;
    }

    case "tend": {
      const scar = untendedScar(a);
      if (!scar) return { run, session, results: [], flavour: "" };
      const mods = tendMods(scar);
      next = patch(next, a.id, (c) => {
        const tended = { ...c, tempMods: [...c.tempMods, ...mods] };
        // an hpMax scar giving ground gives the HP back with it
        const back = mods
          .filter((m) => m.stat === "hpMax" && m.amount > 0)
          .reduce((n, m) => n + m.amount, 0);
        return back > 0 ? { ...tended, hp: tended.hp + back } : tended;
      });
      results.push({
        text: `${a.name}: ${scar.label} eases off until the stairs down`,
        tone: "buff",
      });
      break;
    }

    case "talk": {
      const other = b as CatRunState;
      next = patch(next, a.id, (c) => bondWith(c, other.name));
      next = patch(next, other.id, (c) => bondWith(c, a.name));
      next = patch(next, a.id, (c) => addEnergy(c, 1));
      next = patch(next, other.id, (c) => addEnergy(c, 1));
      results.push({
        text: `${a.name} and ${other.name}: +1 Energy next fight`,
        tone: "buff",
      });
      break;
    }

    case "watch": {
      for (const cat of fieldedCats(run)) {
        const extra = cat.id === a.id ? WATCH_ENERGY_WATCHER : 0;
        next = patch(next, cat.id, (c) => addEnergy(c, WATCH_ENERGY + extra));
      }
      next = patch(next, a.id, (c) => grantCondition(c, watchfulCondition()));
      results.push({
        text: `The party starts the next fight with +${WATCH_ENERGY} Energy`,
        tone: "buff",
      });
      break;
    }
  }

  return {
    run: next,
    session: {
      embers: session.embers - def.cost,
      spent: [...session.spent, spendKey(id, who)],
    },
    results,
    flavour: actionFlavour(id, a.name, b?.name ?? "", run, who),
  };
}

const addEnergy = (c: CatRunState, n: number): CatRunState => ({
  ...c,
  energyNextBattle: Math.min(ENERGY_NEXT_CAP, c.energyNextBattle + n),
});

const quirk = (id: string): { id: string; label: string } => {
  const def = QUIRKS.find((q) => q.id === id);
  return { id, label: def?.label ?? id };
};

const watchfulCondition = (): CatCondition => quirk("quirk:watchful");

/**
 * The Bond, granted at the fire and carried home. One per cat, ever — a cat
 * cannot stack five bonds into a speed build, which is what keeps the camp a
 * story beat rather than a stat vending machine.
 */
function bondWith(cat: CatRunState, otherName: string): CatRunState {
  const bond = quirk("quirk:bond");
  return grantCondition(cat, {
    ...bond,
    label: `${bond.label} · ${otherName}`,
    data: { with: otherName },
  });
}

/* ------------------------------------------------------------------ */
/* what the fire SAYS (offline — the DM overrides it when reachable)   */
/* ------------------------------------------------------------------ */

/** Deterministic pick out of a list. Never draws from an `Rng`. */
const pick = <T>(rows: readonly T[], seed: number): T | undefined =>
  rows.length === 0 ? undefined : rows[seed % rows.length];

/** The line over the fire when the party sits down. */
export function campOpener(seed: number): string {
  return pick(CAMP_OPENERS, seed) ?? CAMP_OPENERS[0];
}

/** Everything that is true at this fire, for filtering the exchange pool. */
export function campTags(run: RunState, isBossFloor: boolean): CampTag[] {
  const tags: CampTag[] = [];
  const party = fieldedCats(run);
  if (party.some((c) => hungerOf(c.conditions) >= 2)) tags.push("hungry");
  if (party.some((c) => scarsOf(c.conditions).length > 0)) tags.push("scarred");
  if (party.some((c) => c.hp * 2 <= maxHp(c, run.level))) tags.push("hurt");
  if (party.some((c) => c.lives === 1)) tags.push("lastLife");
  if (run.cats.some((c) => c.lives <= 0)) tags.push("fallen");
  if (isBossFloor) tags.push("boss");
  if (run.floorNum >= 4) tags.push("deep");
  if (run.floorNum <= 2) tags.push("early");
  if (run.inventory.shinies >= 60) tags.push("flush");
  if (run.inventory.shinies === 0) tags.push("broke");
  return tags;
}

/**
 * WHO TALKS. Two fielded cats, derived from the node seed so the same fire
 * always seats the same pair. A party of one gets itself twice, and the
 * caller renders a monologue rather than an exchange.
 */
export function campPair(run: RunState, seed: number): CatRunState[] {
  const party = fieldedCats(run);
  if (party.length === 0) return [];
  if (party.length === 1) return [party[0]];
  const i = seed % party.length;
  const j = (i + 1 + (hash(seed, "pair") % (party.length - 1))) % party.length;
  return [party[i], party[j]];
}

export interface CampExchangeView {
  /** The two cats, in `{a}` / `{b}` order. */
  cats: CatRunState[];
  /** The exchange's id (so a second draw at the same fire can avoid it). */
  id: string;
  /** Lines with `{a}` / `{b}` already interpolated. */
  lines: string[];
}

/**
 * ONE EXCHANGE, offline. Situational lines first (a fire where somebody is on
 * their last life should be about that), falling back to the always-there
 * pool — which is why camp is never silent without a DM.
 *
 * `avoid` lets a second exchange at the same fire pick something new.
 */
export function campExchange(
  run: RunState,
  seed: number,
  opts: {
    isBossFloor?: boolean;
    cats?: readonly CatRunState[];
    avoid?: readonly string[];
  } = {},
): CampExchangeView | null {
  const cats = (opts.cats ?? campPair(run, seed)).slice(0, 2);
  if (cats.length === 0) return null;
  const a = cats[0];
  const b = cats[1] ?? cats[0];

  const tags = new Set(campTags(run, opts.isBossFloor ?? false));
  if (sharesBond(a, b)) tags.add("bonded");
  const avoid = new Set(opts.avoid ?? []);
  const fits = (x: CampExchange): boolean =>
    !avoid.has(x.id) && x.tags.some((t) => tags.has(t));
  const generic = (x: CampExchange): boolean =>
    !avoid.has(x.id) && x.tags.length === 0;

  // Situational lines lead — but not always, or a hungry party only ever
  // talks about lunch. The seed decides, and the generic pool is the floor
  // under it, so there is ALWAYS an exchange to render.
  const situational = CAMP_EXCHANGES.filter(fits);
  const plain = CAMP_EXCHANGES.filter(generic);
  const preferSituational = situational.length > 0 && seed % 4 !== 0;
  let pool = preferSituational ? situational : plain;
  if (pool.length === 0) pool = situational.length > 0 ? situational : plain;
  const chosen =
    pick(pool, hash(seed, "exchange")) ??
    CAMP_EXCHANGES.find((x) => x.tags.length === 0)!;

  return {
    cats: cats.length === 1 ? [a] : [a, b],
    id: chosen.id,
    lines: chosen.lines.map((l) =>
      l.text.replace(/\{a\}/g, a.name).replace(/\{b\}/g, b.name),
    ),
  };
}

const sharesBond = (a: CatRunState, b: CatRunState): boolean =>
  (a.conditions ?? []).some(
    (c) => c.id === "quirk:bond" && c.data?.with === b.name,
  );

/** One authored line describing what an action looked like. */
export function actionFlavour(
  id: CampActionId,
  aName: string,
  bName: string,
  run: RunState,
  who: readonly CatId[],
): string {
  const rows = CAMP_ACTION_LINES[id] ?? [];
  const line = pick(rows, hash(run.runSeed, run.floorNum, id, who.join("+")));
  return (line ?? "")
    .replace(/\{a\}/g, aName)
    .replace(/\{b\}/g, bName || aName);
}

/**
 * The camp's own condition mods, recomputed. Exported for the scene's
 * "what is this cat carrying" panel — it is the same list `runCat` built.
 */
export const campConditionMods = conditionMods;
