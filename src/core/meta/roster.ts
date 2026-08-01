/**
 * THE ROSTER — cats as persisted individuals (roster-and-persistence.md §1-§3).
 *
 * This module is the whole life cycle of a cat outside a battle:
 *
 *   seed     a fresh town houses the classes the overlay says it houses,
 *            one instance each (`syncRoster`) — which is what finally makes a
 *            `class:*` unlock DELIVER a cat instead of widening a pool nobody
 *            could reach (§0, the reported bug);
 *   choose   `descendingCats` is who the player picked, clamped to capacity
 *            and repaired against the living roster;
 *   descend  `runCat` projects a MetaCat into a `CatRunState`;
 *   return   `bankCat` writes the survivor back — xp, level, Lives, gear;
 *   die      `buryCat` removes it from the roster FOREVER and writes the
 *            memorial line.
 *
 * GUARD RAIL (§2, mandatory): `ensureRoster` runs after every removal and on
 * every load. A town with no living cats gets a free stray at the gate, so
 * there is no reachable state where the roster is empty and the player cannot
 * descend. `tests/roster.spec.ts` kills everybody to prove it.
 *
 * Pure: profile in, NEW profile out. No rng, no clock, no I/O.
 */
import type {
  CatId,
  CatRunState,
  ClassId,
  EquipInstance,
  StatKey,
} from "../types.js";
import type {
  CatCondition,
  MemorialEntry,
  MetaCat,
  MetaProfile,
  RunOverlay,
} from "./types.js";
import { CLASSES } from "../../content/classes.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { LEVEL_CAP } from "../../content/floors.js";
import { levelForXp, maxHp, XP_CAP } from "../run/party.js";
import { makeCat, PARTY_ORDER, standNameFor } from "../run/runState.js";
import {
  afterRun,
  conditionMods,
  fed,
  feedCost,
  type RunConditionCtx,
} from "../run/conditions.js";
import { BASE_CLASS_POOL, eligibleClasses } from "./overlay.js";

/** A town always houses at least this many cats (§2's no-dead-end rule). */
export const MIN_ROSTER = 1;

/** The class a free stray at the gate belongs to when nothing is unlocked. */
export const GATE_STRAY_CLASS: ClassId = "bruiser";

/** The line a gate stray carries in the roster screen. */
export const GATE_STRAY_ORIGIN = "turned up at the gate";

/* ------------------------------------------------------------------ */
/* minting                                                             */
/* ------------------------------------------------------------------ */

const isClassId = (id: string): id is ClassId =>
  (PARTY_ORDER as readonly string[]).includes(id);

/** Every class the town houses, in class-table order, ids only. */
export function townClasses(overlay?: RunOverlay): ClassId[] {
  const pool = overlay ? eligibleClasses(overlay) : BASE_CLASS_POOL;
  return PARTY_ORDER.filter((id) => pool.includes(id));
}

/** Next free `EquipInstance.uid` for the town, and the bumped profile. */
function takeUid(meta: MetaProfile, n = 1): { uid: number; next: number } {
  const used = [
    meta.nextUid ?? 0,
    ...(meta.roster ?? []).flatMap(gearOf).map((e) => e.uid + 1),
    ...(meta.stash ?? []).map((e) => e.uid + 1),
    1,
  ];
  const uid = Math.max(...used);
  return { uid, next: uid + n };
}

/**
 * Mint a `CatId`. The FIRST instance of a class takes the class's own name
 * (`'hexer'`) because a town houses one of each until it does not — that is
 * what keeps a default descent byte-identical to the pre-instance engine
 * (see `CatId` in core/types.ts). Anything after that gets `cat-<n>`.
 */
export function mintCatId(
  meta: MetaProfile,
  classId?: ClassId,
): { id: CatId; nextCatId: number } {
  const taken = new Set([
    ...(meta.roster ?? []).map((c) => c.id),
    ...(meta.memorial ?? []).map((m) => m.catId),
  ]);
  const counter = meta.nextCatId ?? 1;
  if (classId !== undefined && !taken.has(classId)) {
    return { id: classId, nextCatId: counter };
  }
  let n = counter;
  while (taken.has(`cat-${n}`)) n += 1;
  return { id: `cat-${n}`, nextCatId: n + 1 };
}

export interface MintOpts {
  name?: string;
  standName?: string;
  origin?: string;
  /** Start above level 1 (a recruit that is already somebody). */
  xp?: number;
}

/**
 * Add ONE new cat of `classId` to the town, wearing a fresh Stray L1 class
 * weapon. Returns the profile AND the cat, because callers want to say its
 * name ("Mora moves in").
 */
export function addCat(
  meta: MetaProfile,
  classId: ClassId,
  opts: MintOpts = {},
): { meta: MetaProfile; cat: MetaCat } {
  const { id, nextCatId } = mintCatId(meta, classId);
  const { uid, next } = takeUid(meta);
  const seed = makeCat(classId, {
    id,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.standName !== undefined ? { standName: opts.standName } : {}),
    weaponUid: uid,
  });
  const xp = clampXp(opts.xp ?? 0);
  const cat: MetaCat = {
    id,
    name: seed.name,
    classId,
    standName:
      seed.standName ?? standNameFor(classId) ?? CLASSES[classId].className,
    level: levelForXp(xp),
    xp,
    lives: 9,
    weapon: seed.weapon,
    trinket: null,
    collar: null,
    conditions: [],
    runs: 0,
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  };
  return {
    cat,
    meta: {
      ...meta,
      roster: [...(meta.roster ?? []), cat],
      nextCatId,
      nextUid: next,
    },
  };
}

const clampXp = (xp: number): number =>
  Math.max(0, Math.min(XP_CAP, Math.floor(xp)));

const gearOf = (cat: MetaCat): EquipInstance[] =>
  [cat.weapon, cat.trinket, cat.collar].filter(
    (e): e is EquipInstance => e !== null && e !== undefined,
  );

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

/** Every cat that is alive and living here. */
export function livingRoster(meta: MetaProfile): MetaCat[] {
  return (meta.roster ?? []).filter((c) => c.lives > 0);
}

export function rosterCat(meta: MetaProfile, id: CatId): MetaCat | undefined {
  return (meta.roster ?? []).find((c) => c.id === id);
}

/**
 * WHO DESCENDS, front→back: the player's pick from the roster screen,
 * repaired on every read — unknown ids and cats that have since died drop
 * out, duplicates collapse, and the list is clamped to `capacity`. An empty
 * or absent pick falls back to the first `capacity` living cats, so "Begin
 * the descent" always has a party even if the player never opened the screen.
 */
export function descendingCats(meta: MetaProfile, capacity: number): MetaCat[] {
  const living = livingRoster(meta);
  const out: MetaCat[] = [];
  for (const id of meta.descending ?? []) {
    const cat = living.find((c) => c.id === id);
    if (cat && !out.includes(cat)) out.push(cat);
  }
  const picked = out.length > 0 ? out : living;
  return picked.slice(0, Math.max(1, Math.floor(capacity)));
}

/** Record the player's pick. Order IS the marching order. */
export function setDescending(
  meta: MetaProfile,
  ids: readonly CatId[],
): MetaProfile {
  const living = livingRoster(meta).map((c) => c.id);
  const kept: CatId[] = [];
  for (const id of ids) {
    if (living.includes(id) && !kept.includes(id)) kept.push(id);
  }
  return { ...meta, descending: kept };
}

/** The party level a descent starts at — see `runCats`. */
export function partyXpFor(cats: readonly MetaCat[]): number {
  return cats.reduce((n, c) => Math.max(n, clampXp(c.xp)), 0);
}

/* ------------------------------------------------------------------ */
/* descending & returning                                              */
/* ------------------------------------------------------------------ */

/**
 * Project a town cat into a run cat, at FULL HP for `level`. Everything the
 * individual owns rides along — gear, spent Whisker Points, loadout, name,
 * Stand and CONDITIONS; only the run-scoped fields (current HP, temp mods,
 * owed energy) are new, because those are what a run IS.
 *
 * CONDITIONS (roster-and-persistence.md §3) arrive as `tempMods` with
 * `duration: 'run'` — the same events.md §1 vocabulary a cursed shrine uses,
 * so a starving cat is simply a cat with `atk -1` as far as the engine is
 * concerned. They are folded BEFORE the HP fill, so a hungry cat descends at
 * its reduced maximum rather than at a full bar it cannot hold.
 *
 * A cat carrying nothing keeps `conditions` ABSENT and produces a
 * byte-identical `CatRunState` to the pre-conditions engine.
 */
export function runCat(cat: MetaCat, level: number): CatRunState {
  const conditions = cat.conditions ?? [];
  const out: CatRunState = {
    id: cat.id,
    name: cat.name,
    standName: cat.standName,
    classId: cat.classId,
    hp: 1,
    lives: Math.max(1, cat.lives),
    weapon: cat.weapon,
    trinket: cat.trinket,
    collar: cat.collar,
    tempMods: conditionMods(conditions),
    energyNextBattle: 0,
    ...(cat.points ? { points: { ...cat.points } } : {}),
    ...(cat.loadout ? { loadout: [...cat.loadout] } : {}),
    ...(conditions.length > 0 ? { conditions: conditions.map((c) => c) } : {}),
  };
  out.hp = maxHp(out, level);
  return out;
}

/**
 * The whole descending party plus the level it descends at.
 *
 * The party shares ONE level, as it always has, and that level is the MOST
 * experienced cat's: a veteran carries the rookie rather than being dragged
 * back down to them, and the rookie catches up on the way home (`bankCat`
 * never lowers a cat's xp, and levels every survivor to the party's total).
 * A clowder of level-1 strays therefore starts exactly where every run
 * started before instances existed.
 */
export function runCats(cats: readonly MetaCat[]): {
  cats: CatRunState[];
  xp: number;
  level: number;
} {
  const xp = partyXpFor(cats);
  const level = levelForXp(xp);
  return { cats: cats.map((c) => runCat(c, level)), xp, level };
}

/**
 * What the run DID, as far as conditions are concerned. Absent ⇒ `bankCat`
 * carries the cat's conditions home verbatim and charges nothing for the
 * descent (the shape every pre-conditions caller still gets).
 */
export interface BankCtx {
  seed: string;
  victory: boolean;
  floorsReached: number;
  bossesDefeated: number;
}

/**
 * Write a survivor back into the town. Lives, gear, points and loadout are
 * whatever the run left them; xp is the better of what the cat had and what
 * the party finished on, so nobody comes home behind the party they walked
 * with. Current HP is deliberately NOT stored — a cat rests in town.
 *
 * CONDITIONS (§3) come home too, and with `ctx` they also come home CHANGED:
 * hunger rises, a cat that burned a Life takes a scar, and what it did down
 * there may have earned it a quirk (`afterRun`, core/run/conditions.ts). Any
 * condition the camp fire granted mid-run is already on `ran` and rides along.
 */
export function bankCat(
  cat: MetaCat,
  ran: CatRunState,
  partyXp: number,
  ctx?: BankCtx,
): MetaCat {
  const xp = clampXp(Math.max(cat.xp, partyXp));
  const carried = ran.conditions ?? cat.conditions ?? [];
  const next: MetaCat = {
    ...cat,
    name: ran.name,
    classId: ran.classId,
    standName: ran.standName ?? cat.standName,
    xp,
    level: Math.min(LEVEL_CAP, levelForXp(xp)),
    lives: Math.max(0, ran.lives),
    weapon: ran.weapon,
    trinket: ran.trinket,
    collar: ran.collar ?? null,
    runs: (cat.runs ?? 0) + 1,
    conditions: ctx
      ? afterRun(carried, {
          seed: ctx.seed,
          catId: cat.id,
          livesLost: Math.max(0, cat.lives - Math.max(0, ran.lives)),
          victory: ctx.victory,
          floorsReached: ctx.floorsReached,
          bossesDefeated: ctx.bossesDefeated,
          runs: cat.runs ?? 0,
        } satisfies RunConditionCtx)
      : carried.map((c) => c),
  };
  if (ran.points)
    next.points = { ...(ran.points as Partial<Record<StatKey, number>>) };
  if (ran.loadout) next.loadout = [...ran.loadout];
  return next;
}

/* ------------------------------------------------------------------ */
/* the town's side of hunger (§3)                                      */
/* ------------------------------------------------------------------ */

/** What feeding this cat all the way back to `fed` costs. 0 when fed. */
export function feedPrice(meta: MetaProfile, id: CatId): number {
  return feedCost(rosterCat(meta, id)?.conditions);
}

/**
 * FEED ONE CAT out of the town wallet (§3: "fed in town for shinies, so
 * hunger competes with unlocks for the same currency").
 *
 * Buys as many points of hunger off as the wallet covers, so a poor town can
 * still take the edge off. Pure and total: an unknown or already-fed cat, or
 * an empty wallet, returns the SAME profile and `spent: 0`.
 */
export function feedCat(
  meta: MetaProfile,
  id: CatId,
): { meta: MetaProfile; spent: number; points: number } {
  const cat = rosterCat(meta, id);
  if (!cat) return { meta, spent: 0, points: 0 };
  const out = fed(cat.conditions, meta.shinies);
  if (out.points <= 0) return { meta, spent: 0, points: 0 };
  return {
    meta: {
      ...meta,
      shinies: Math.max(0, meta.shinies - out.spent),
      roster: (meta.roster ?? []).map((c) =>
        c.id === id ? { ...c, conditions: out.conditions } : c,
      ),
    },
    spent: out.spent,
    points: out.points,
  };
}

/* ------------------------------------------------------------------ */
/* death (roster-and-persistence.md §2)                                */
/* ------------------------------------------------------------------ */

export interface DeathCtx {
  /** Deepest floor the cat got to. */
  floor: number;
  /** What killed them, in words. */
  cause: string;
  seed: string;
}

/**
 * PERMA-DEATH. The cat leaves the roster and never comes back; a memorial
 * line takes its place, and everything it was wearing goes into the town
 * stash.
 *
 * WHY THE GEAR COMES HOME rather than dying with them (§2 leaves the call to
 * us): the roster here starts at one or two cats, so a single death can be
 * most of what the player owns. Taking the cat is the stake; taking the
 * Mewthical it spent four runs earning as well turns one bad fight into an
 * unrecoverable town. Losing the cat is permanent. Losing the collar is not.
 */
export function buryCat(
  meta: MetaProfile,
  cat: MetaCat,
  ctx: DeathCtx,
): MetaProfile {
  const entry: MemorialEntry = {
    catId: cat.id,
    name: cat.name,
    classId: cat.classId,
    standName: cat.standName,
    level: cat.level,
    floor: Math.max(1, Math.floor(ctx.floor)),
    cause: ctx.cause,
    seed: ctx.seed,
    runs: cat.runs ?? 0,
  };
  return {
    ...meta,
    roster: (meta.roster ?? []).filter((c) => c.id !== cat.id),
    memorial: [entry, ...(meta.memorial ?? [])],
    descending: (meta.descending ?? []).filter((id) => id !== cat.id),
    stash: [...(meta.stash ?? []), ...gearOf(cat)],
  };
}

/**
 * THE RUN COMING HOME — the one write that closes a descent (§1-§2).
 *
 * Survivors bank their xp, Lives and gear; anyone at 0 Lives is buried; a cat
 * the run picked up that the town has never met is adopted; and whatever was
 * still in the backpack — including the gear of the cats who fell, which
 * grief loot already put there — lands in the town stash.
 *
 * Total and idempotent-ish: a summary with no `cats` changes nothing, and the
 * guard rail runs last, so this can never hand back an empty town.
 */
export function settleRun(
  meta: MetaProfile,
  summary: {
    cats?: readonly CatRunState[];
    carried?: readonly EquipInstance[];
    cause?: string;
    seed: string;
    floorsReached: number;
    xp?: number;
    /** §3: what the descent earned a cat. Absent ⇒ conditions ride home as-is. */
    victory?: boolean;
    bossesDefeated?: number;
  },
  overlay?: RunOverlay,
): MetaProfile {
  let out = meta;
  const partyXp = clampXp(summary.xp ?? 0);
  const ctx: DeathCtx = {
    floor: summary.floorsReached,
    cause: summary.cause ?? "never came back",
    seed: summary.seed,
  };
  const bank: BankCtx = {
    seed: summary.seed,
    victory: summary.victory === true,
    floorsReached: Math.max(1, Math.floor(summary.floorsReached)),
    bossesDefeated: Math.max(0, Math.floor(summary.bossesDefeated ?? 0)),
  };

  for (const ran of summary.cats ?? []) {
    const known = rosterCat(out, ran.id);
    if (ran.lives <= 0) {
      // the dead take no conditions home; the memorial is what carries them
      if (known) out = buryCat(out, bankCat(known, ran, partyXp), ctx);
      continue;
    }
    if (known) {
      const banked = bankCat(known, ran, partyXp, bank);
      out = {
        ...out,
        roster: (out.roster ?? []).map((c) => (c.id === ran.id ? banked : c)),
      };
      continue;
    }
    // adopted: a cat the descent picked up (a recruit encounter) and brought
    // home. It moves in as itself, keeping its id, gear and experience.
    const adopted: MetaCat = bankCat(
      {
        id: ran.id,
        name: ran.name,
        classId: ran.classId,
        standName: ran.standName ?? standNameFor(ran.classId) ?? "",
        level: 1,
        xp: 0,
        lives: ran.lives,
        weapon: null,
        trinket: null,
        collar: null,
        conditions: [],
        origin: "followed the party home",
        runs: 0,
      },
      ran,
      partyXp,
      // an adopted cat settles exactly like a resident: it walked the same run
      bank,
    );
    out = { ...out, roster: [...(out.roster ?? []), adopted] };
  }

  const carried = summary.carried ?? [];
  if (carried.length > 0) {
    out = { ...out, stash: [...(out.stash ?? []), ...carried] };
  }
  return ensureRoster(out, overlay);
}

/* ------------------------------------------------------------------ */
/* the guard rail (§2) + the unlock→cat bridge (§0)                    */
/* ------------------------------------------------------------------ */

/**
 * THE NO-DEAD-END GUARANTEE. A town with nobody left in it gets a free stray
 * at the gate — no cost, no prerequisite, no unlock. It is deliberately the
 * plainest cat available (the town's first class, Bruno if the town has
 * nothing), because this is a floor under the player, not a reward.
 *
 * Idempotent: a town that already houses a living cat is returned untouched.
 */
export function ensureRoster(
  meta: MetaProfile,
  overlay?: RunOverlay,
): MetaProfile {
  if (livingRoster(meta).length >= MIN_ROSTER) return meta;
  const classId = townClasses(overlay)[0] ?? GATE_STRAY_CLASS;
  return addCat(meta, classId, { origin: GATE_STRAY_ORIGIN }).meta;
}

/**
 * THE FIX FOR THE REPORTED BUG (§0). Every class the town has unlocked and
 * does not yet house gets an instance, so buying `class:hexer` puts Mora on
 * the roster where the player can actually field her.
 *
 * A class whose only instance DIED is not re-issued: perma-death would mean
 * nothing if the shop quietly restocked. That is what `memorial` is checked
 * for — the unlock bought the introduction, not an infinite supply.
 */
export function syncRoster(
  meta: MetaProfile,
  overlay?: RunOverlay,
): MetaProfile {
  let out = meta;
  const buried = new Set((meta.memorial ?? []).map((m) => m.classId));
  const housed = new Set((meta.roster ?? []).map((c) => c.classId));
  for (const classId of townClasses(overlay)) {
    if (housed.has(classId) || buried.has(classId)) continue;
    out = addCat(out, classId, { origin: "moved into Cat Town" }).meta;
    housed.add(classId);
  }
  return ensureRoster(out, overlay);
}

/* ------------------------------------------------------------------ */
/* repair (called by migrateMeta)                                      */
/* ------------------------------------------------------------------ */

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

/**
 * Repair one stored equipment instance, or DROP it.
 *
 * The `defId` must name a def THIS BUILD SHIPS, not merely be a string. Two
 * things reach the stash that are not equipment and would otherwise sail
 * through: a `ConsumableStack` (`{defId, count}` — same duck, no `uid`) and
 * an `ItemId` from content the build no longer carries. Both then crash the
 * first screen that asks the def for its slot or its icon — `canEquip` and
 * the Den's row builder read `EQUIP_DEFS[defId].slot` unguarded, so an
 * unknown id is an uncaught TypeError on opening The Den, i.e. a town the
 * player cannot use. Dropping here is the same rule `startRun` already
 * applies to granted gear ("content this build does not ship"), applied at
 * the one boundary where a profile from another build arrives.
 */
function readEquip(v: unknown): EquipInstance | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Partial<EquipInstance>;
  if (typeof e.defId !== "string") return null;
  if (!EQUIP_DEFS[e.defId]) return null;
  return {
    uid: num(e.uid, 0),
    defId: e.defId,
    itemLevel: num(e.itemLevel, 1),
    rarity: e.rarity ?? "stray",
    stats: (e.stats ?? {}) as EquipInstance["stats"],
    ...(e.hook ? { hook: e.hook } : {}),
    ...(e.hookSpent ? { hookSpent: true } : {}),
  };
}

function readConditions(v: unknown): CatCondition[] {
  if (!Array.isArray(v)) return [];
  const out: CatCondition[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Partial<CatCondition>;
    if (typeof c.id !== "string" || c.id === "") continue;
    out.push({
      id: c.id,
      label: str(c.label, c.id),
      ...(typeof c.value === "number" ? { value: c.value } : {}),
      ...(c.data ? { data: c.data } : {}),
    });
  }
  return out;
}

/** Repair one stored roster entry, or drop it (unknown class, no id). */
export function readMetaCat(v: unknown): MetaCat | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<MetaCat>;
  const classId = str(c.classId);
  if (!isClassId(classId)) return null;
  const id = str(c.id, classId);
  if (id === "") return null;
  const xp = clampXp(num(c.xp));
  return {
    id,
    name: str(c.name, CLASSES[classId].catName),
    classId,
    standName: str(
      c.standName,
      standNameFor(classId) ?? CLASSES[classId].className,
    ),
    xp,
    level: Math.min(LEVEL_CAP, Math.max(1, num(c.level, levelForXp(xp)))),
    lives: Math.max(0, Math.min(9, Math.floor(num(c.lives, 9)))),
    weapon: readEquip(c.weapon),
    trinket: readEquip(c.trinket),
    collar: readEquip(c.collar),
    ...(c.points ? { points: c.points } : {}),
    ...(Array.isArray(c.loadout)
      ? { loadout: c.loadout.filter((s): s is string => typeof s === "string") }
      : {}),
    conditions: readConditions(c.conditions),
    ...(c.origin !== undefined ? { origin: str(c.origin) } : {}),
    runs: Math.max(0, Math.floor(num(c.runs))),
  };
}

/** Repair a stored roster: valid cats only, alive only, ids unique. */
export function readRoster(v: unknown): MetaCat[] {
  if (!Array.isArray(v)) return [];
  const out: MetaCat[] = [];
  const seen = new Set<CatId>();
  for (const raw of v) {
    const cat = readMetaCat(raw);
    if (!cat || cat.lives <= 0 || seen.has(cat.id)) continue;
    seen.add(cat.id);
    out.push(cat);
  }
  return out;
}

/** Repair a stored memorial. Corrupt lines are dropped, never invented. */
export function readMemorial(v: unknown): MemorialEntry[] {
  if (!Array.isArray(v)) return [];
  const out: MemorialEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Partial<MemorialEntry>;
    const classId = str(m.classId);
    if (!isClassId(classId)) continue;
    out.push({
      catId: str(m.catId, classId),
      name: str(m.name, CLASSES[classId].catName),
      classId,
      standName: str(m.standName, standNameFor(classId) ?? ""),
      level: Math.max(1, Math.floor(num(m.level, 1))),
      floor: Math.max(1, Math.floor(num(m.floor, 1))),
      cause: str(m.cause, "never came back"),
      seed: str(m.seed),
      runs: Math.max(0, Math.floor(num(m.runs))),
    });
  }
  return out;
}

/** Repair a stored stash. */
export function readStash(v: unknown): EquipInstance[] {
  if (!Array.isArray(v)) return [];
  return v.map(readEquip).filter((e): e is EquipInstance => e !== null);
}
