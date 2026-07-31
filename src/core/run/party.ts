/**
 * c(at)rpg — party progression (ARCHITECTURE.md WP-07: core/run/party.ts).
 *
 * effectiveStats(cat) = base + growth rows + equipment + tempMods
 * (classes.md §8, events.md §1, loot.md §2), the skill list by level, the
 * XP → level pipeline (delta-HP rule), and trait tiers.
 *
 * Pure: no rng, no pixi, no mutation of inputs.
 */
import type {
  CatRunState,
  ClassId,
  SkillId,
  StatKey,
  Stats,
  TempMod,
} from "../types.js";
import { EQUIP_SLOTS } from "../types.js";
import { clamp } from "../util.js";
import { CLASSES } from "../../content/classes.js";
import { LEVEL_CAP, XP_TO_LEVEL } from "../../content/floors.js";

/** Surplus XP past the L8 threshold is ignored (classes.md §8). */
export const XP_CAP = XP_TO_LEVEL[LEVEL_CAP - 1];

/* ------------------------------------------------------------------ */
/* Whisker Points (docs/design/progression.md §1)                      */
/* ------------------------------------------------------------------ */

/** One row of the Whisker Point spend menu. */
export interface PointMenuEntry {
  stat: StatKey;
  /** UI label for the row. */
  label: string;
  /** How much of `stat` ONE point buys. */
  amount: number;
  /** Maximum points a single cat may sink into this stat. */
  cap: number;
  /** One-line UI blurb. */
  desc: string;
}

/**
 * THE spend menu — fixed, hand-tuned, and the single source of truth for both
 * the engine and the UI. Every level-up from L2..L8 grants each cat one point
 * ON TOP of its automatic growth row, so a level-8 cat has spent at most 7
 * points; the per-stat caps (4) keep any single build bounded — a maxed line
 * costs more than half the run's points.
 *
 * Per point: hp +3 · atk +1 · def +1 · spd +1 · crt +3 · enMax +1.
 */
export const POINT_MENU: readonly PointMenuEntry[] = [
  {
    stat: "hp",
    label: "Bulk",
    amount: 3,
    cap: 4,
    desc: "+3 max HP (and +3 current HP, right now).",
  },
  {
    stat: "atk",
    label: "Claws",
    amount: 1,
    cap: 4,
    desc: "+1 ATK — scales every skill's power and every heal.",
  },
  {
    stat: "def",
    label: "Hide",
    amount: 1,
    cap: 4,
    desc: "+1 DEF — flat reduction off every incoming hit.",
  },
  {
    stat: "spd",
    label: "Twitch",
    amount: 1,
    cap: 4,
    desc: "+1 SPD — earlier in the initiative order.",
  },
  {
    stat: "crt",
    label: "Instinct",
    amount: 3,
    cap: 4,
    desc: "+3 crit chance (%).",
  },
  {
    stat: "enMax",
    label: "Reserves",
    amount: 1,
    cap: 4,
    desc: "+1 max Energy — one more capstone per battle.",
  },
];

/** Menu row for a stat (undefined = that stat cannot be bought). */
export function pointMenuEntry(stat: StatKey): PointMenuEntry | undefined {
  return POINT_MENU.find((e) => e.stat === stat);
}

/** Total points this cat has spent across all stats. */
export function pointsSpent(cat: CatRunState): number {
  const p = cat.points;
  if (!p) return 0;
  let n = 0;
  for (const e of POINT_MENU) n += p[e.stat] ?? 0;
  return n;
}

/**
 * Points still burning a hole in this cat's pocket: one per level gained
 * (`level - 1`) minus everything already spent. Never negative.
 */
export function unspentPoints(cat: CatRunState, level: number): number {
  const earned = Math.max(0, Math.min(level, LEVEL_CAP) - 1);
  return Math.max(0, earned - pointsSpent(cat));
}

/** Can `stat` legally take one more point right now? */
export function canSpendPoint(
  cat: CatRunState,
  stat: StatKey,
  level: number,
): boolean {
  const entry = pointMenuEntry(stat);
  if (!entry) return false;
  if (unspentPoints(cat, level) <= 0) return false;
  return (cat.points?.[stat] ?? 0) < entry.cap;
}

/**
 * Spend ONE Whisker Point on `stat`. Pure and total: an illegal spend (no
 * points left, stat capped, unknown stat) returns the SAME state object, so
 * callers can fire and forget. A point in `hp` raises current HP by the same
 * delta — the level-up rule (classes.md §8).
 */
export function spendPoint(
  cat: CatRunState,
  stat: StatKey,
  level: number,
): CatRunState {
  if (!canSpendPoint(cat, stat, level)) return cat;
  const entry = pointMenuEntry(stat)!;
  const points = { ...(cat.points ?? {}) };
  points[stat] = (points[stat] ?? 0) + 1;
  const next: CatRunState = { ...cat, points };
  if (stat === "hp") next.hp = cat.hp + entry.amount;
  return next;
}

/**
 * Refund every point (a full respec — the UI may or may not offer it).
 * Current HP gives back exactly what the `hp` points granted, never below 1.
 */
export function clearPoints(cat: CatRunState): CatRunState {
  if (!cat.points || pointsSpent(cat) === 0) return cat;
  const hpBack = (cat.points.hp ?? 0) * (pointMenuEntry("hp")?.amount ?? 0);
  const next: CatRunState = { ...cat, points: {} };
  next.hp = Math.max(1, cat.hp - hpBack);
  return next;
}

/** The stat bonus a cat's spent points add (absent points ⇒ all zeroes). */
export function pointStats(cat: CatRunState): Partial<Stats> {
  const out: Partial<Stats> = {};
  if (!cat.points) return out;
  for (const e of POINT_MENU) {
    const n = cat.points[e.stat] ?? 0;
    if (n > 0) out[e.stat] = n * e.amount;
  }
  return out;
}

/**
 * Class base stats plus growth rows applied at L2..`level` in order
 * (classes.md §8 step 1). Level 1 = the base row untouched.
 */
export function growthStats(classId: ClassId, level: number): Stats {
  const cls = CLASSES[classId];
  const s: Stats = { ...cls.base };
  for (let l = 2; l <= level; l++) {
    const row = cls.growth[l - 2];
    if (!row) continue;
    s.hp += row.hp ?? 0;
    s.atk += row.atk ?? 0;
    s.def += row.def ?? 0;
    s.spd += row.spd ?? 0;
    s.crt += row.crt ?? 0;
    s.enMax += row.enMax ?? 0;
  }
  return s;
}

/** Fold one tempMod into a Stats object (`hpMax` maps onto `hp`). */
function addMod(s: Stats, mod: TempMod): void {
  if (mod.stat === "hpMax") s.hp += mod.amount;
  else s[mod.stat] += mod.amount;
}

/**
 * EFFECTIVE stats, folded in this order (progression.md §1):
 *   base + growth rows up to `level`
 *   + spent Whisker Points
 *   + every equipped slot (weapon, trinket, collar)
 *   + tempMods
 * then the events.md §1 clamps — `spd` floors at 1, `def`/`crt` at 0 (`atk`
 * too — negative attack is meaningless), max HP never below 1.
 *
 * A cat with no `points` and no `collar` produces byte-identical numbers to
 * the pre-progression engine.
 */
export function effectiveStats(cat: CatRunState, level: number): Stats {
  const s = growthStats(cat.classId, level);
  const pts = pointStats(cat);
  for (const e of POINT_MENU) s[e.stat] += pts[e.stat] ?? 0;
  for (const slot of EQUIP_SLOTS) {
    const item = cat[slot];
    if (!item) continue;
    s.hp += item.stats.hp ?? 0;
    s.atk += item.stats.atk ?? 0;
    s.def += item.stats.def ?? 0;
    s.spd += item.stats.spd ?? 0;
    s.crt += item.stats.crt ?? 0;
    s.enMax += item.stats.enMax ?? 0;
  }
  for (const mod of cat.tempMods) addMod(s, mod);
  s.hp = Math.max(1, s.hp);
  s.atk = Math.max(0, s.atk);
  s.def = Math.max(0, s.def);
  s.spd = Math.max(1, s.spd);
  s.crt = Math.max(0, s.crt);
  s.enMax = Math.max(0, s.enMax);
  return s;
}

/** Max HP derives from effective stats — never stored (types.ts §2.9). */
export function maxHp(cat: CatRunState, level: number): number {
  return effectiveStats(cat, level).hp;
}

/**
 * Every skill id a class KNOWS at `level`, in class-table order — Claw Swipe
 * + the L1 kit, then the milestone unlocks as they land (L2, L4 capstone, L6,
 * L8 → 7 known at cap; classes.md §8 step 2 + progression.md §2).
 *
 * Knowing a skill is not the same as taking it into battle: a cat fights with
 * 4 (see `activeSkills`).
 */
export function knownSkills(classId: ClassId, level: number): SkillId[] {
  return CLASSES[classId].skills
    .filter((s) => s.unlockLevel <= level)
    .map((s) => s.skillId);
}

/**
 * Legacy name for `knownSkills`, kept as an alias so nothing that imported it
 * breaks (ARCHITECTURE.md WP-07).
 */
export const skillsForLevel = knownSkills;

/** Slot 1 of every loadout, free and unremovable (progression.md §3). */
export const BASIC_SKILL_ID: SkillId = "clawSwipe";

/** A cat takes exactly this many skills into a battle. */
export const LOADOUT_SIZE = 4;

/**
 * The 4 skills this cat actually fights with: `clawSwipe` first, then the 3
 * chosen in `cat.loadout` (filtered to what the cat currently knows — an
 * un-relearned pick simply drops out).
 *
 * With `loadout` ABSENT this returns exactly what `knownSkills` returns,
 * truncated to 4 — which, because the class tables list the legacy kit first
 * (Claw Swipe, the two L1 skills, the L4 capstone) and the milestone unlocks
 * after, is the pre-progression kit at every level.
 */
export function activeSkills(cat: CatRunState, level: number): SkillId[] {
  const known = knownSkills(cat.classId, level);
  if (!cat.loadout) return known.slice(0, LOADOUT_SIZE);
  const picks = cat.loadout.filter(
    (id) => id !== BASIC_SKILL_ID && known.includes(id),
  );
  return [BASIC_SKILL_ID, ...picks].slice(0, LOADOUT_SIZE);
}

/**
 * Choose the 3 non-basic battle skills, in order. Pure and total: illegal
 * input (wrong length, an unknown/unlearned id, `clawSwipe` among the picks,
 * duplicates) returns the SAME state untouched. To go back to the default
 * kit, call `clearLoadout`.
 */
export function setLoadout(
  cat: CatRunState,
  level: number,
  skillIds: readonly SkillId[],
): CatRunState {
  if (skillIds.length !== LOADOUT_SIZE - 1) return cat;
  if (new Set(skillIds).size !== skillIds.length) return cat;
  if (skillIds.includes(BASIC_SKILL_ID)) return cat;
  const known = knownSkills(cat.classId, level);
  if (!skillIds.every((id) => known.includes(id))) return cat;
  return { ...cat, loadout: skillIds.slice() };
}

/** Drop a custom loadout and go back to the default kit. */
export function clearLoadout(cat: CatRunState): CatRunState {
  if (!cat.loadout) return cat;
  const next = { ...cat };
  delete next.loadout;
  return next;
}

/**
 * The skills a cat knows but is NOT taking into battle — the bench, for the
 * loadout UI.
 */
export function benchedSkills(cat: CatRunState, level: number): SkillId[] {
  const active = activeSkills(cat, level);
  return knownSkills(cat.classId, level).filter((id) => !active.includes(id));
}

/** Trait tier: 2 at the class's tier2Level (7 in v1), else 1. */
export function traitTier(classId: ClassId, level: number): 1 | 2 {
  return level >= CLASSES[classId].trait.tier2Level ? 2 : 1;
}

/**
 * Party level for a cumulative XP total: the highest level whose threshold
 * is met (XP_TO_LEVEL[level-1] <= xp), capped at LEVEL_CAP. Zero RNG.
 */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let l = 2; l <= LEVEL_CAP; l++) {
    if (xp >= XP_TO_LEVEL[l - 1]) level = l;
  }
  return level;
}

/**
 * Apply level-ups from `fromLevel` to `toLevel` (multiple levels from one
 * battle apply in order): each living cat's CURRENT HP rises only by its
 * max-HP delta from the new growth rows — level-ups relieve attrition but
 * never fully heal (classes.md §8). Cats gone for the run (0 Lives) are
 * untouched. Returns a new array; inputs are not mutated.
 *
 * Whisker Points need no bookkeeping here: `unspentPoints` derives them from
 * the party level, so a level-up automatically hands every cat one more
 * (progression.md §1).
 */
export function applyLevelUps(
  cats: readonly CatRunState[],
  fromLevel: number,
  toLevel: number,
): CatRunState[] {
  if (toLevel <= fromLevel) return cats.slice();
  return cats.map((cat) => {
    if (cat.lives <= 0) return cat;
    let hpDelta = 0;
    const rows = CLASSES[cat.classId].growth;
    for (let l = fromLevel + 1; l <= toLevel; l++) {
      hpDelta += rows[l - 2]?.hp ?? 0;
    }
    return hpDelta === 0 ? cat : { ...cat, hp: cat.hp + hpDelta };
  });
}

/**
 * Remove `duration: 'floor'` tempMods (they expire on descending the
 * stairs — events.md §1). When an expiring `hpMax` mod shrinks max HP,
 * current HP clamps into [1, new max].
 */
export function expireFloorMods(cat: CatRunState, level: number): CatRunState {
  if (!cat.tempMods.some((m) => m.duration === "floor")) return cat;
  const next: CatRunState = {
    ...cat,
    tempMods: cat.tempMods.filter((m) => m.duration === "run"),
  };
  next.hp = clamp(next.hp, 1, maxHp(next, level));
  return next;
}
