/**
 * c(at)rpg — party progression (ARCHITECTURE.md WP-07: core/run/party.ts).
 *
 * effectiveStats(cat) = base + growth rows + equipment + tempMods
 * (classes.md §8, events.md §1, loot.md §2), the skill list by level, the
 * XP → level pipeline (delta-HP rule), and trait tiers.
 *
 * Pure: no rng, no pixi, no mutation of inputs.
 */
import type { CatRunState, ClassId, SkillId, Stats, TempMod } from "../types";
import { clamp } from "../util";
import { CLASSES } from "../../content/classes";
import { LEVEL_CAP, XP_TO_LEVEL } from "../../content/floors";

/** Surplus XP past the L8 threshold is ignored (classes.md §8). */
export const XP_CAP = XP_TO_LEVEL[LEVEL_CAP - 1];

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
 * EFFECTIVE stats: base + growth rows up to `level` + equipped weapon +
 * trinket + tempMods, then the events.md §1 clamps — `spd` floors at 1,
 * `def`/`crt` at 0 (`atk` too — negative attack is meaningless), max HP
 * never below 1.
 */
export function effectiveStats(cat: CatRunState, level: number): Stats {
  const s = growthStats(cat.classId, level);
  for (const item of [cat.weapon, cat.trinket]) {
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
 * The skill ids a class knows at `level`, in class-table order
 * (Claw Swipe + L1 kit, capstone joins at L4 — classes.md §8 step 2).
 */
export function skillsForLevel(classId: ClassId, level: number): SkillId[] {
  return CLASSES[classId].skills
    .filter((s) => s.unlockLevel <= level)
    .map((s) => s.skillId);
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
