/**
 * CONDITIONS — what a cat carries between runs
 * (docs/design/roster-and-persistence.md §3).
 *
 * Three kinds, one vocabulary:
 *
 *   HUNGER  one condition, a number 0..5 that rises every time a cat comes
 *           home from a descent and only falls when the player spends shinies
 *           on food in town. It is the pressure that makes "rest a cat" a real
 *           decision, and it competes with the unlock catalog for the same
 *           wallet.
 *   SCARS   permanent. A cat that burned a Life down there comes back marked,
 *           with a name the DM can call back to and a small, fixed cost.
 *   QUIRKS  earned from what actually happened — killing a boss, coming home,
 *           getting deep, sitting up all night with somebody at a camp fire.
 *           Good and bad, and never more than one new one per run.
 *
 * EVERY effect here is a `BuffStat` delta, i.e. the SAME vocabulary
 * `events.md` §1 tempMods already use, folded by `effectiveStats` through the
 * same clamps. There is no new mechanic in this file: a starving cat is a cat
 * with `atk -1`, and the engine cannot tell the difference between that and a
 * cursed shrine. That is the point (§3: "bounded by the existing stat/effect
 * vocabulary").
 *
 * Data only — `core/run/conditions.ts` is the engine that reads it.
 */
import type { BuffStat } from "../core/types.js";

/** What sort of thing a condition is. */
export type ConditionKind = "hunger" | "scar" | "quirk";

/** One stat delta. Same shape as a `TempMod` minus its run bookkeeping. */
export interface ConditionMod {
  stat: BuffStat;
  amount: number;
}

/** An authored condition: what it is called, what it costs, what it means. */
export interface ConditionDef {
  /** `'hunger'`, `'scar:<slug>'`, `'quirk:<slug>'` — namespaced like unlocks. */
  id: string;
  kind: ConditionKind;
  /** What the roster card prints. Short — it sits under a name. */
  label: string;
  /** One line of story. The camp panel and the tooltip print this. */
  blurb: string;
  /** The stat cost (or gift). Empty for a condition that is pure flavour. */
  mods: readonly ConditionMod[];
}

/* ------------------------------------------------------------------ */
/* hunger                                                              */
/* ------------------------------------------------------------------ */

/** The condition id hunger always occupies. There is only ever one. */
export const HUNGER_ID = "hunger";

/** A cat cannot be hungrier than this. */
export const HUNGER_MAX = 5;

/** How much hunger one finished descent adds. */
export const HUNGER_PER_RUN = 1;

/** …plus this much if the run ended badly. Coming home hungry is a story. */
export const HUNGER_ON_DEFEAT = 1;

/**
 * ONE STAGE of hunger. `at` is the lowest value the stage covers; the table is
 * read bottom-up, so a cat at 4 is `starving` and a cat at 1 is fine.
 *
 * Shape of the curve: nothing at all for the first descent (a cat that eats
 * once a run never notices), then CRIT, then max HP, and only at the very
 * bottom a point of ATK.
 *
 * The order of those stats is measured, not aesthetic. One point of ATK on
 * every cat is worth about NINE POINTS of clear rate in the scripted-run
 * harness (200 seeds, floors 1-6) — it multiplies every skill and every heal,
 * so it is the single most violent number in the game to touch. Crit and max
 * HP are worth a fraction of that. A condition that is meant to be TEXTURE
 * therefore spends crit first, HP second, speed third, and reaches for attack
 * only when the player has ignored four bowls in a row.
 */
export interface HungerStage {
  at: number;
  label: string;
  blurb: string;
  mods: readonly ConditionMod[];
}

export const HUNGER_STAGES: readonly HungerStage[] = [
  {
    at: 0,
    label: "fed",
    blurb: "Fed. Bowl licked clean and no complaints.",
    mods: [],
  },
  {
    at: 1,
    label: "peckish",
    blurb: "Peckish. Keeps looking at the backpack.",
    mods: [],
  },
  {
    at: 2,
    label: "hungry",
    blurb: "Hungry. Sloppier about where the claws land.",
    mods: [{ stat: "crt", amount: -3 }],
  },
  {
    at: 3,
    label: "famished",
    blurb: "Famished. Thinner than it was, and it shows.",
    mods: [
      { stat: "crt", amount: -3 },
      { stat: "hpMax", amount: -2 },
    ],
  },
  {
    at: 4,
    label: "starving",
    blurb: "Starving. Ribs you can count, and a temper to match.",
    mods: [
      { stat: "crt", amount: -3 },
      { stat: "hpMax", amount: -3 },
      { stat: "spd", amount: -1 },
    ],
  },
  {
    at: 5,
    label: "wasting",
    blurb: "Wasting. This cat should not be going anywhere near a basement.",
    mods: [
      { stat: "crt", amount: -6 },
      { stat: "hpMax", amount: -5 },
      { stat: "spd", amount: -1 },
    ],
  },
];

/**
 * What one point of hunger costs to feed, in shinies.
 *
 * Priced against the unlock catalog on purpose (§3: "feeding costs shinies, so
 * hunger competes with unlocks for the same currency"). The cheapest things in
 * Cat Town are 90 ✦; a three-cat clowder that came home from one descent owes
 * ~108 ✦ to eat back to zero. So on a GOOD run (a victory banks ~1000 ✦) food
 * is a rounding error, and on a BAD one (a floor-3 wipe banks ~200 ✦) it is
 * most of the tin — which is exactly when the choice is interesting.
 */
export const FEED_COST_PER_POINT = 18;

/* ------------------------------------------------------------------ */
/* scars (§3: "a permanent mark from a near-death")                    */
/* ------------------------------------------------------------------ */

/**
 * A cat picks up AT MOST ONE of these per descent, and only by burning a Life
 * down there. They never heal — a camp fire can only take the edge off for a
 * floor (`tend`, core/run/camp.ts).
 *
 * NONE of them touches ATK, for the reason `HUNGER_STAGES` records: attack is
 * the one stat that is worth ~9 points of clear rate per point, and a scar has
 * to be somewhere between "a story" and "a reason to bench them", never a
 * reason to delete a cat. A veteran with three of these is measurably slower
 * and sloppier and is still a cat you would field.
 */
export const SCARS: readonly ConditionDef[] = [
  {
    id: "scar:notchedEar",
    kind: "scar",
    label: "Notched Ear",
    blurb: "Half an ear, left somewhere in the dark. Sounds arrive crooked.",
    mods: [{ stat: "spd", amount: -1 }],
  },
  {
    id: "scar:stiffShoulder",
    kind: "scar",
    label: "Stiff Shoulder",
    blurb: "Something went in and did not come all the way out again.",
    mods: [{ stat: "crt", amount: -4 }],
  },
  {
    id: "scar:cloudedEye",
    kind: "scar",
    label: "Clouded Eye",
    blurb: "Milk-white on one side. Depth is a rumour now.",
    mods: [{ stat: "crt", amount: -4 }],
  },
  {
    id: "scar:shortWind",
    kind: "scar",
    label: "Short Wind",
    blurb: "Breathes like a kettle after any real work.",
    mods: [{ stat: "hpMax", amount: -3 }],
  },
  {
    id: "scar:crookedTail",
    kind: "scar",
    label: "Crooked Tail",
    blurb: "Kinked at the third joint. Corners are an argument now.",
    mods: [{ stat: "spd", amount: -1 }],
  },
  {
    id: "scar:brokenFang",
    kind: "scar",
    label: "Broken Fang",
    blurb: "Snapped on something that should not have been that hard.",
    mods: [{ stat: "crt", amount: -4 }],
  },
  {
    id: "scar:singedCoat",
    kind: "scar",
    label: "Singed Coat",
    blurb: "A bald stripe that will not grow back, and does not insulate.",
    mods: [{ stat: "hpMax", amount: -3 }],
  },
  {
    id: "scar:tornPad",
    kind: "scar",
    label: "Torn Pad",
    blurb: "Lands wrong on cold floors and pretends otherwise.",
    mods: [{ stat: "spd", amount: -1 }],
  },
];

/* ------------------------------------------------------------------ */
/* quirks (§3: "earned traits, good and bad, from what happened")      */
/* ------------------------------------------------------------------ */

/**
 * The gifts are as bounded as the costs, and for the same measured reason
 * (see `HUNGER_STAGES`): a quirk that handed every cat a point of ATK was
 * worth THIRTY points of clear rate across a career, which is not texture,
 * it is a difficulty setting. Crit, 2 max HP and a point of speed are what a
 * career is allowed to be worth.
 *
 * What EARNED a quirk. Checked in this file's declaration order at settle
 * time, and at most one is granted per cat per run — so a clowder's quirks
 * accumulate over a career rather than in an afternoon.
 *
 *   boss       this cat was standing when a boss went down
 *   victory    it came home from a winning run
 *   deep       it got to floor 5 or lower
 *   mauled     it burned a Life (and so also took a scar)
 *   routed     the run ended on floor 1 or 2, badly
 *   camp       granted AT the camp fire, not at settle (core/run/camp.ts)
 */
export type QuirkTrigger =
  "boss" | "victory" | "deep" | "mauled" | "routed" | "camp";

export interface QuirkDef extends ConditionDef {
  kind: "quirk";
  trigger: QuirkTrigger;
  /** Good ones read gold on the card, bad ones read red. */
  good: boolean;
}

export const QUIRKS: readonly QuirkDef[] = [
  {
    id: "quirk:bossBlooded",
    kind: "quirk",
    trigger: "boss",
    good: true,
    label: "Boss-Blooded",
    blurb: "Stood in the room when the big one fell. Knows it can be done.",
    mods: [{ stat: "crt", amount: 4 }],
  },
  {
    id: "quirk:deepWalker",
    kind: "quirk",
    trigger: "deep",
    good: true,
    label: "Deep-Walker",
    blurb: "Has been further down than the stories go, and came back up.",
    mods: [{ stat: "hpMax", amount: 2 }],
  },
  {
    id: "quirk:homecoming",
    kind: "quirk",
    trigger: "victory",
    good: true,
    label: "Homecoming",
    blurb: "Walked out under its own power. Sits differently now.",
    mods: [{ stat: "hpMax", amount: 2 }],
  },
  {
    id: "quirk:bond",
    kind: "quirk",
    trigger: "camp",
    good: true,
    label: "Bonded",
    blurb: "Sat up half the night with somebody. Watches their flank now.",
    mods: [{ stat: "spd", amount: 1 }],
  },
  {
    id: "quirk:watchful",
    kind: "quirk",
    trigger: "camp",
    good: true,
    label: "Watchful",
    blurb: "Took the last watch once and never quite stopped taking it.",
    mods: [{ stat: "crt", amount: 4 }],
  },
  {
    id: "quirk:skittish",
    kind: "quirk",
    trigger: "mauled",
    good: false,
    label: "Skittish",
    blurb: "Flinches at pipework. Fast about it, at least.",
    mods: [
      { stat: "hpMax", amount: -2 },
      { stat: "spd", amount: 1 },
    ],
  },
  {
    id: "quirk:jumpy",
    kind: "quirk",
    trigger: "routed",
    good: false,
    label: "Jumpy",
    blurb: "It went badly and early, and something in there remembers.",
    mods: [{ stat: "crt", amount: -3 }],
  },
];

/**
 * A cat carries at most this many conditions. Hunger is always one of them,
 * so the real ceiling on scars + quirks is five. Beyond that the roster card
 * stops being readable and the stat drift stops being small — both of which
 * §3 asks us to avoid.
 */
export const MAX_CONDITIONS = 6;

/** Every authored condition def except hunger (which is a stage table). */
export const CONDITION_DEFS: readonly ConditionDef[] = [...SCARS, ...QUIRKS];
