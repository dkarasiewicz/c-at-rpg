/**
 * THE BESTIARY — knowledge as meta progression (docs/design/enemy-intel.md §4).
 *
 * Darkest Dungeon's half of the design: information is EARNED, and what you
 * have not earned is shown as `???` rather than hidden, so the panel doubles
 * as a checklist. Knowledge persists in the meta profile, which makes a later
 * run start already knowing the early roster — a real, non-numeric power
 * increase.
 *
 * Facts unlock progressively:
 *
 * | doing this…                         | reveals |
 * |-------------------------------------|---------|
 * | meeting it (any battle it is in)    | name, level, tier, description, `tell` — and its intents from the NEXT battle on |
 * | being hit by one of its skills      | that skill |
 * | a weakness or resistance FIRING     | that tag |
 * | `KILLS_TO_COMPLETE` kills           | the whole entry, forever |
 *
 * Every reveal is something the player watched happen: the engine emits an
 * `intel` event exactly when a modifier fires, so nothing here re-derives
 * rules or peeks at content the player has not seen used.
 *
 * Pure: profile in → NEW profile out, no storage, no rng, no pixi.
 */
import type {
  BattleEvent,
  BattleState,
  DeclaredIntent,
  EnemyDef,
  EnemyId,
  IntelTag,
  SkillId,
} from "../types.js";
import { ENEMIES, enemyLevel } from "../../content/enemies.js";

/** Kills that complete an entry and pin its intents open forever. */
export const KILLS_TO_COMPLETE = 5;

/** What has been learned about ONE species. Counts are lifetime. */
export interface EnemyKnowledge {
  /** battles it appeared in */
  met: number;
  /** how many of them you have put down */
  kills: number;
  /** skill ids seen land on the party, sorted */
  skills: SkillId[];
  /** weakness tags seen to fire, sorted */
  weak: IntelTag[];
  /** resistance tags seen to fire, sorted */
  resist: IntelTag[];
}

export type Bestiary = Record<EnemyId, EnemyKnowledge>;

export function emptyKnowledge(): EnemyKnowledge {
  return { met: 0, kills: 0, skills: [], weak: [], resist: [] };
}

/* ------------------------------------------------------------------ */
/* persistence helpers                                                 */
/* ------------------------------------------------------------------ */

const sorted = (xs: readonly string[]): string[] =>
  [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

const tags = (v: unknown): IntelTag[] =>
  Array.isArray(v)
    ? (sorted(v.filter((x): x is string => typeof x === "string")).filter((t) =>
        INTEL_TAGS.includes(t as IntelTag),
      ) as IntelTag[])
    : [];

/** The closed vocabulary, mirrored here so a hand-edited file cannot widen it. */
export const INTEL_TAGS: readonly IntelTag[] = [
  "shove",
  "offBalance",
  "scratched",
  "frazzled",
  "provoked",
];

/**
 * Read a stored bestiary payload, repairing rather than trusting it — the
 * v2 → v3 meta migration (a v1/v2 file simply has none, and starts empty).
 * Entries for species this build no longer ships are dropped.
 */
export function readBestiary(raw: unknown): Bestiary {
  if (!raw || typeof raw !== "object") return {};
  const out: Bestiary = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENEMIES[id] || !v || typeof v !== "object") continue;
    const k = v as Partial<EnemyKnowledge>;
    const known = ENEMIES[id];
    const legal = allSkillsOf(known);
    out[id] = {
      met: count(k.met),
      kills: count(k.kills),
      skills: Array.isArray(k.skills)
        ? sorted(
            k.skills.filter((s): s is string => typeof s === "string"),
          ).filter((s) => legal.includes(s))
        : [],
      weak: tags(k.weak),
      resist: tags(k.resist),
    };
    // a hand-edited file can claim more kills than meetings; a kill IS a meeting
    if (out[id].met < out[id].kills) out[id].met = out[id].kills;
  }
  return out;
}

/** Every skill id a species can ever use, boss phases and windup included. */
export function allSkillsOf(def: EnemyDef): SkillId[] {
  const ids = [...def.skills];
  for (const phase of def.boss?.phases ?? []) ids.push(...phase.skills);
  if (def.boss?.windup) ids.push(def.boss.windup.skillId);
  if (def.boss?.summon) ids.push(def.boss.summon.skillId);
  return sorted(ids);
}

/* ------------------------------------------------------------------ */
/* observation — one battle folded into the Bestiary                   */
/* ------------------------------------------------------------------ */

/**
 * Fold a finished battle into the Bestiary. `state` is the FINAL battle state
 * (so mid-battle summons count as met) and `events` the full log.
 *
 * Reads the log, never the rules: skills are learned from damage the party
 * actually took, weaknesses and resistances from the `intel` events the
 * resolver emits when a modifier fires.
 */
export function observeBattle(
  bestiary: Bestiary,
  state: BattleState,
  events: readonly BattleEvent[],
): Bestiary {
  const species = new Map<string, EnemyId>();
  for (const c of state.combatants) {
    if (c.side === "enemy" && c.speciesId && ENEMIES[c.speciesId]) {
      species.set(c.id, c.speciesId);
    }
  }
  if (species.size === 0) return bestiary;

  const out: Bestiary = {};
  for (const [id, k] of Object.entries(bestiary)) out[id] = { ...k };
  const entry = (id: EnemyId): EnemyKnowledge => (out[id] ??= emptyKnowledge());

  for (const id of new Set(species.values())) entry(id).met += 1;

  let actor: string | null = null;
  for (const ev of events) {
    switch (ev.t) {
      case "turnStart":
        actor = ev.id;
        break;
      case "damage": {
        // a skill reveals itself by landing on the party
        const sp = actor ? species.get(actor) : undefined;
        if (!sp || species.has(ev.id)) break;
        if (allSkillsOf(ENEMIES[sp]).includes(ev.source)) {
          const k = entry(sp);
          if (!k.skills.includes(ev.source)) {
            k.skills = sorted([...k.skills, ev.source]);
          }
        }
        break;
      }
      case "intel": {
        const sp = species.get(ev.id);
        if (!sp) break;
        const k = entry(sp);
        if (ev.effect === "weak") k.weak = tags([...k.weak, ev.tag]);
        else k.resist = tags([...k.resist, ev.tag]);
        break;
      }
      case "ko": {
        const sp = species.get(ev.id);
        if (sp) entry(sp).kills += 1;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * SPECIES that have taken a turn in this battle so far — the second half of
 * rule §5: a first-timer's telegraph stays `?` only until it acts once, and
 * from that moment the whole species reads for the rest of the fight. Keyed
 * by species (not combatant) so it pairs directly with `intentsVisibleFor`.
 */
export function actedThisBattle(
  state: BattleState,
  events: readonly BattleEvent[],
): Set<EnemyId> {
  const species = new Map<string, EnemyId>();
  for (const c of state.combatants) {
    if (c.side === "enemy" && c.speciesId) species.set(c.id, c.speciesId);
  }
  const out = new Set<EnemyId>();
  for (const ev of events) {
    if (ev.t !== "turnStart" && ev.t !== "intentBroken") continue;
    const sp = species.get(ev.id);
    if (sp) out.add(sp);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* what the UI may show                                                */
/* ------------------------------------------------------------------ */

/** A fact the panel renders as its value, or as `???`. */
export interface Fact<T> {
  known: boolean;
  /** null EXACTLY when `known` is false */
  value: T | null;
}

export interface SkillFact {
  id: SkillId;
  known: boolean;
}
export interface TagFact {
  tag: IntelTag;
  known: boolean;
}

/**
 * Everything the inspect panel and the Bestiary page may display. Unknown
 * facts are REPORTED as unknown, never omitted — the shape is the same for a
 * stranger and for a completed entry, so the UI renders `???` in place and
 * the player can see how much is left to learn.
 */
export interface KnownIntel {
  id: EnemyId;
  /** false for an id this build does not ship (everything below is unknown) */
  exists: boolean;
  met: number;
  kills: number;
  /** `kills >= KILLS_TO_COMPLETE` — the whole entry is open */
  complete: boolean;
  /** kills still needed to complete (0 when complete) */
  killsToComplete: number;
  name: Fact<string>;
  level: Fact<number>;
  tier: Fact<1 | 2 | 3>;
  description: Fact<string>;
  tell: Fact<string>;
  /** every skill it can use; `known` false ⇒ render `???` */
  skills: SkillFact[];
  weaknesses: TagFact[];
  resistances: TagFact[];
  /** facts still hidden — the checklist number */
  unknownCount: number;
  /** may the UI show this enemy's declared intent at all? (enemy-intel.md §2) */
  intentsVisible: boolean;
}

/** The profile shape this module needs — anything carrying a bestiary. */
export interface HasBestiary {
  bestiary?: Bestiary;
}

export function knowledgeOf(
  meta: HasBestiary,
  enemyId: EnemyId,
): EnemyKnowledge {
  return meta.bestiary?.[enemyId] ?? emptyKnowledge();
}

const fact = <T>(known: boolean, value: T): Fact<T> => ({
  known,
  value: known ? value : null,
});

/**
 * What the player is allowed to see about `enemyId` right now. `floor` moves
 * the displayed level with `ENEMY_CURVE`, exactly as the stat block moves
 * (enemy-intel.md §1) — pass the floor the fight is on.
 */
export function knownIntel(
  meta: HasBestiary,
  enemyId: EnemyId,
  floor = 1,
): KnownIntel {
  const def = ENEMIES[enemyId];
  const k = knowledgeOf(meta, enemyId);
  const complete = k.kills >= KILLS_TO_COMPLETE;
  const seen = k.met > 0;
  if (!def) {
    return {
      id: enemyId,
      exists: false,
      met: 0,
      kills: 0,
      complete: false,
      killsToComplete: KILLS_TO_COMPLETE,
      name: fact(false, ""),
      level: fact(false, 0),
      tier: fact(false, 1 as const),
      description: fact(false, ""),
      tell: fact(false, ""),
      skills: [],
      weaknesses: [],
      resistances: [],
      unknownCount: 5,
      intentsVisible: false,
    };
  }
  const open = complete || seen;
  const skills: SkillFact[] = allSkillsOf(def).map((id) => ({
    id,
    known: complete || k.skills.includes(id),
  }));
  const weaknesses: TagFact[] = def.weaknesses.map((tag) => ({
    tag,
    known: complete || k.weak.includes(tag),
  }));
  const resistances: TagFact[] = def.resistances.map((tag) => ({
    tag,
    known: complete || k.resist.includes(tag),
  }));
  const unknownCount =
    (open ? 0 : 5) +
    skills.filter((s) => !s.known).length +
    weaknesses.filter((w) => !w.known).length +
    resistances.filter((r) => !r.known).length;
  return {
    id: enemyId,
    exists: true,
    met: k.met,
    kills: k.kills,
    complete,
    killsToComplete: Math.max(0, KILLS_TO_COMPLETE - k.kills),
    name: fact(open, def.name),
    level: fact(open, enemyLevel(def, floor)),
    tier: fact(open, def.tier),
    description: fact(open, def.description),
    tell: fact(open, def.tell),
    skills,
    weaknesses,
    resistances,
    unknownCount,
    intentsVisible: open,
  };
}

/**
 * Rule §2/§5: a telegraph is only readable for an enemy you have MET in an
 * earlier battle. A first-timer shows `?` — until it acts once, at which
 * point you have seen it move and the mask lifts for the rest of the fight.
 */
export function intentsVisibleFor(
  meta: HasBestiary,
  enemyId: EnemyId,
  hasActedThisBattle = false,
): boolean {
  return hasActedThisBattle || knowledgeOf(meta, enemyId).met > 0;
}

/**
 * The intent as the UI may render it: the truth, or an `'unknown'` stand-in
 * carrying no numbers at all. The ENGINE is never masked — only the view is
 * (`core/combat/intent.ts` header).
 */
export function maskIntent(
  intent: DeclaredIntent,
  visible: boolean,
): DeclaredIntent {
  if (visible) return intent;
  return { id: intent.id, kind: "unknown", value: 0, round: intent.round };
}

/** Completed entries, sorted — the collection Cat Town's Bestiary displays. */
export function completedEntries(meta: HasBestiary): EnemyId[] {
  return Object.entries(meta.bestiary ?? {})
    .filter(([id, k]) => !!ENEMIES[id] && k.kills >= KILLS_TO_COMPLETE)
    .map(([id]) => id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
