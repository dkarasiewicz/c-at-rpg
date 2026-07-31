/**
 * ENEMIES — canonical roster per dungeon.md §7.1 (stat blocks verbatim),
 * plus events.md's event-only `elderStray`, the Laundromancer-cut summon
 * `sockWraith`, and the bosses per GDD §6 (vacuumKing 140/Poise 3,
 * dogfather 200/Poise 4, ratPrince SHOULD-tier alternate).
 *
 * Looks per ui-art.md §5 (family / sizeGrade / tier / props).
 * `enMax` is unused for enemies (always 0). Bosses and summons cost 0 threat.
 *
 * ── INTEL (docs/design/enemy-intel.md §1) ──────────────────────────────────
 * Every def also carries `level` / `description` / `tell` / `weaknesses` /
 * `resistances`. Two rules keep that data honest:
 *
 *  1. **Level is derived, never typed** — `baseLevel(tier, boss)` here, moved
 *     per floor by the same `ENEMY_CURVE` row that scales the stats
 *     (`enemyLevel`). Retuning the run still means editing six curve rows.
 *  2. **Weaknesses are mechanical.** Each tag is a modifier `resolveAction`
 *     applies (core/types.ts `IntelTag`); nothing here is decoration. The
 *     family patterns are deliberate and learnable: constructs do not bleed
 *     (`scratched` resist), elites and bosses cannot be baited (`provoked`
 *     resist), and anything top-heavy hates being shoved.
 *
 * `'offBalance'` in `resistances` IS the old tier Off-Paw resistance — the
 * magnitude still comes from `OFF_BALANCE_RESIST_BY_TIER`, but WHETHER an
 * enemy resists is now declared per def rather than implied by its tier, so
 * there is exactly one system. Every tier-2/3 non-boss declares it (the
 * balance pass shipped that and it is not regressed here); a `weaknesses`
 * entry of `'offBalance'` is the documented override — Off-Paw lands on it
 * regardless of tier.
 */
import type { EnemyDef, EnemyId, Stats } from "../core/types.js";
import { floorCurve } from "./floors.js";
import { roundHalfUp } from "../core/util.js";

/**
 * How often an enemy of each tier SHRUGS OFF an Off-Balance application
 * (docs/design/balance-and-meta.md §1 "tier resistance"). Tougher things are
 * harder to knock off their feet, so the combo engine has to be aimed rather
 * than sprayed. Cats never resist; bosses never reach this table at all (they
 * are `heavy`, and a Poise break is their only Off-Balance source, §11.1).
 *
 * Drawn by `core/combat/resolve.ts` as one `rng.float()`, and ONLY when the
 * application could otherwise land — see the combat.md §3 stream table. The
 * enemy must also DECLARE `'offBalance'` in `resistances` (and not in
 * `weaknesses`); that declaration is what `offBalanceResistOf` reads.
 */
export const OFF_BALANCE_RESIST_BY_TIER: Record<1 | 2 | 3, number> = {
  1: 0,
  2: 0.25,
  3: 0.4,
};

/* ------------------------------------------------------------------------ */
/* level derivation (enemy-intel.md §1)                                      */
/* ------------------------------------------------------------------------ */

/** Floor-1 level by tier — the rung a tier is introduced on. */
export const LEVEL_BY_TIER: Record<1 | 2 | 3, number> = { 1: 1, 2: 4, 3: 7 };

/** A boss is authored above its tier's mooks and is never curved. */
export const BOSS_LEVEL_BONUS = 5;

/** The authored (floor-1) level of a def. Called by the table below. */
export function baseLevel(tier: 1 | 2 | 3, boss = false): number {
  return LEVEL_BY_TIER[tier] + (boss ? BOSS_LEVEL_BONUS : 0);
}

/**
 * Levels earned by the floor curve: the ENEMY_CURVE row's two multipliers,
 * read as rungs. Floors 1..6 → 0, 2, 5, 6, 6, 6 — the same table that makes a
 * floor-6 Rat Thug frightening is the one that makes it level 7.
 *
 * Computed in integer BASIS POINTS, not on the raw floats. `1.27 + 1.28 - 2`
 * is `0.5499999999999998`, so the naive form silently rounded floor 4 DOWN a
 * level on a last-bit artefact — a player-facing number must not hang on
 * that. Each multiplier is snapped to bp first, summed as integers, and
 * rounded half-UP, so the ladder is a pure function of the printed table.
 */
export function curveLevelSteps(floorNum: number): number {
  const row = floorCurve(floorNum);
  const bp =
    Math.round((row.hpMult - 1) * 1000) + Math.round((row.atkMult - 1) * 1000);
  return roundHalfUp(bp / 100);
}

/**
 * The level shown on the inspect panel for THIS fight. Bosses are excluded
 * from `ENEMY_CURVE` (setup.ts), so their level is floor-independent too —
 * one rule, no drift.
 */
export function enemyLevel(def: EnemyDef, floorNum = 1): number {
  return def.boss ? def.level : def.level + curveLevelSteps(floorNum);
}

/** Convenience for callers holding only an id (unknown id ⇒ 0). */
export function enemyLevelOf(id: EnemyId, floorNum = 1): number {
  const def = ENEMIES[id];
  return def ? enemyLevel(def, floorNum) : 0;
}

const st = (
  hp: number,
  atk: number,
  def: number,
  spd: number,
  crt: number,
): Stats => ({ hp, atk, def, spd, crt, enMax: 0 });

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  /* ---------------------------------------------------------------- T1 -- */
  ratThug: {
    id: "ratThug",
    name: "Rat Thug",
    tier: 1,
    level: baseLevel(1),
    description:
      "All elbows and attitude, wearing somebody else's bottle cap like a " +
      "medal. Its Stand is barely a whisper — but it swings first.",
    tell: "Rolls the shiv from paw to paw and eyes the rank it wants.",
    // glass jaw: every Frazzle skill lands on it, gate roll and all
    weaknesses: ["frazzled"],
    resistances: [],
    threat: 1,
    row: "front",
    stats: st(18, 7, 1, 5, 5),
    skills: ["shiv"], // Shiv, usableFrom [1,2] (dungeon.md §7.1 / combat.md §13)
    traits: [],
    xp: 10,
    look: { family: "vermin", sizeGrade: "standard", tier: 1 },
  },
  sewerBat: {
    id: "sewerBat",
    name: "Sewer Bat",
    tier: 1,
    level: baseLevel(1),
    description:
      "It navigates by a screech nobody else can hear. Break the screech and " +
      "the whole creature loses the plot.",
    tell: "Hangs still for a beat too long, then folds its wings to dive.",
    weaknesses: ["frazzled"],
    resistances: ["shove"], // never on the ground — a shove finds nothing to shove
    threat: 1,
    row: "front",
    stats: st(10, 6, 0, 8, 10),
    skills: ["swoop"], // fast, fragile
    traits: [],
    xp: 10,
    look: { family: "vermin", sizeGrade: "minion", tier: 1 },
  },
  dustBunny: {
    id: "dustBunny",
    name: "Dust Bunny",
    tier: 1,
    level: baseLevel(1),
    description:
      "Hair, grit and the ghost of a sock, bound by static into something " +
      "with opinions. Cut it and it simply keeps coming apart.",
    tell: "Puffs up one size before it rolls at an ankle.",
    // floor 1's shove lesson: hit it hard enough to move it and it sheds
    weaknesses: ["scratched", "shove"],
    resistances: ["frazzled"], // no head to ring
    threat: 1,
    row: "front",
    stats: st(14, 5, 2, 3, 0),
    skills: ["nibble"], // slow chaff
    traits: [],
    xp: 10,
    look: { family: "vermin", sizeGrade: "minion", tier: 1 },
  },
  crowShaman: {
    id: "crowShaman",
    name: "Crow Shaman",
    tier: 1,
    level: baseLevel(1),
    description:
      "It has read the cellar's puddles and did not like what they said. Its " +
      "Stand hexes from the back line and it knows exactly how far back that is.",
    tell: "Draws a wet circle with the staff — the hex is already loading.",
    weaknesses: ["scratched"], // hollow bones, thin skin
    resistances: ["provoked"], // far too clever to be shouted at
    threat: 2,
    row: "back",
    stats: st(14, 8, 0, 7, 5),
    // hex usableFrom [2,3,4] — shove it to rank 1 to silence it; Peck from [1,2]
    skills: ["hex", "peck"],
    traits: [],
    xp: 20,
    look: {
      family: "bird",
      sizeGrade: "standard",
      tier: 1,
      props: ["shamanStaff"],
    },
  },

  /* ---------------------------------------------------------------- T2 -- */
  roombaScout: {
    id: "roombaScout",
    name: "Roomba Scout",
    tier: 2,
    level: baseLevel(2),
    description:
      "A disc that has decided the floor is its jurisdiction. Tall for its " +
      "wheelbase, and it has never once considered what a tip-over would mean.",
    tell: "Backs up, beeps twice, and lines its bumper up with a rank.",
    weaknesses: ["shove"], // top-heavy on a tiny wheelbase
    resistances: ["offBalance", "scratched"], // tier gate + a shell that cannot bleed
    threat: 2,
    row: "front",
    // dungeon.md's stat block is canonical (GDD §6 ruling over events.md's 34 HP/heavy)
    stats: st(24, 8, 2, 6, 5),
    skills: ["ram"], // rams: moveTarget +1 skill (shoves cats)
    traits: [],
    xp: 20,
    look: { family: "construct", sizeGrade: "standard", tier: 2 },
  },
  sprinklerImp: {
    id: "sprinklerImp",
    name: "Sprinkler Imp",
    tier: 2,
    level: baseLevel(2),
    description:
      "Half plumbing, half spite. It holds pressure until the whole row is " +
      "lined up, and one good knock to the head sets the timer back to zero.",
    tell: "The nozzle stops turning and points — that is the row it soaks.",
    weaknesses: ["frazzled"], // rap the nozzle and the cycle stalls
    resistances: ["offBalance", "scratched"], // tier gate + brass does not bleed
    threat: 2,
    row: "back",
    stats: st(20, 9, 1, 7, 5),
    skills: ["spray", "squirt"], // row-hitting spray (cooldown 2) + filler poke
    traits: [],
    xp: 20,
    look: { family: "construct", sizeGrade: "standard", tier: 2 },
  },
  yarnGolem: {
    id: "yarnGolem",
    name: "Yarn Golem",
    tier: 2,
    level: baseLevel(2),
    description:
      "Every lost ball of wool in the building, wound into a fist. It cannot " +
      "be moved — but it is, fundamentally, one long string.",
    tell: "Winds a loose end around its knuckles before it swings.",
    weaknesses: ["scratched"], // find the loose end and it unravels
    resistances: ["offBalance", "frazzled"], // tier gate + nothing in there to rattle
    threat: 3,
    row: "front",
    stats: st(40, 9, 4, 3, 0),
    skills: ["yarnSlam"],
    traits: ["heavy"], // elite — immune to forced movement (no Poise)
    xp: 35,
    look: { family: "construct", sizeGrade: "elite", tier: 2 },
  },

  /* ---------------------------------------------------------------- T3 -- */
  porcelainHound: {
    id: "porcelainHound",
    name: "Porcelain Hound",
    tier: 3,
    level: baseLevel(3),
    description:
      "A mantelpiece dog that got down. Glazed, hollow, and hairline-cracked " +
      "from the last thing that put it on the floor.",
    tell: "Sets its front paws wide — it means to put somebody down a rank.",
    // hollow and top-heavy: shoves hurt it MORE and always destabilise it —
    // the one tier-3 that declares `offBalance` as a weakness, so its tier
    // gate is 0 instead of 0.40 (enemy-intel.md §1, deliberate).
    weaknesses: ["shove", "offBalance"],
    resistances: ["scratched"], // glaze, not skin
    threat: 3,
    row: "front",
    stats: st(34, 11, 3, 6, 5),
    skills: ["bite"], // hits hard, shoves (moveTarget +1)
    traits: [],
    xp: 35,
    look: { family: "beast", sizeGrade: "standard", tier: 3 },
  },
  laserGhost: {
    id: "laserGhost",
    name: "Laser Ghost",
    tier: 3,
    level: baseLevel(3),
    description:
      "The red dot every cat has chased, still going, long after the toy " +
      "died. There is nothing there to grab — only a beam to interrupt.",
    tell: "The dot appears on a cat's chest one full beat before the beam does.",
    weaknesses: ["frazzled"], // break its focus and the beam dies
    resistances: ["offBalance", "shove", "scratched"], // no body to shove or cut
    threat: 3,
    row: "back",
    stats: st(22, 12, 0, 9, 10),
    skills: ["laserZap"], // high spd + crt glass cannon
    traits: [],
    xp: 35,
    look: { family: "construct", sizeGrade: "standard", tier: 3 },
  },
  trashPanda: {
    id: "trashPanda",
    name: "Trash Panda",
    tier: 3,
    level: baseLevel(3),
    description:
      "Masked, mangy, and entirely certain the bin is his. He does not hear " +
      "threats; he hears an inventory of what you are carrying.",
    tell: "Weighs a lid in both paws and picks a head for it.",
    weaknesses: ["scratched"], // under all that fur he is very much meat
    resistances: ["offBalance", "provoked"], // tier gate + he wants the shiny, not the fight
    threat: 4,
    row: "front",
    stats: st(48, 12, 2, 6, 10),
    skills: ["lidBash", "trashToss"], // mini-boss statline, steals nothing (v1)
    traits: [],
    xp: 50,
    look: { family: "beast", sizeGrade: "elite", tier: 3, props: ["patchEye"] },
  },

  /* ---------------------------------------- summon-only (never in pools) -- */
  sockWraith: {
    id: "sockWraith",
    name: "Sock Wraith",
    tier: 1,
    level: baseLevel(1),
    description:
      "One sock of a pair, animated by grief. Damp, heavy, and easy to fling " +
      "across the room.",
    tell: "Sags, then wrings itself out in the direction of a cat.",
    weaknesses: ["shove"],
    resistances: [],
    threat: 0, // summons cost 0 threat; never appears in floor pools
    row: "back",
    stats: st(12, 6, 0, 6, 0),
    skills: ["dampSlap"],
    traits: [],
    xp: 5,
    look: { family: "construct", sizeGrade: "minion", tier: 1 },
  },

  /* ----------------------------------------- event-only (events.md §4) -- */
  elderStray: {
    id: "elderStray",
    name: "Elder Stray",
    tier: 3,
    level: baseLevel(3),
    description:
      "He was doing this before your Stand had a name. Half an ear, three " +
      "good legs, and a stance nothing has shifted in nine years.",
    tell: "Plants his back foot and waits for you to come to him.",
    weaknesses: ["frazzled"], // old ears ring for a long time
    resistances: ["offBalance", "shove"], // tier gate + he does not budge
    threat: 0, // event-only lone elite; never in pools
    row: "front",
    // events.md: HP 55, ATK 12, DEF 3, SPD 7, no traits (crt unspecified → 0)
    stats: st(55, 12, 3, 7, 0),
    skills: ["grizzledCuff"], // his Grizzled Cuff is a moveTarget: +1 skill
    traits: [],
    xp: 50, // classes.md guideline: T3 elite ≈ 2× mook
    look: { family: "beast", sizeGrade: "elite", tier: 3, props: ["patchEye"] },
  },

  /* -------------------------------------------------------- bosses ------ */
  vacuumKing: {
    id: "vacuumKing",
    name: "The Vacuum King",
    tier: 2,
    level: baseLevel(2, true),
    description:
      "It ate the crown along with everything else, and now it wears the " +
      "crown. Its Stand is suction itself — it drags the world toward its mouth.",
    tell: "The motor climbs a pitch before it takes anything.",
    // heavy: it is never shoved, but every staggering blow tells (Poise §11.1)
    weaknesses: ["shove", "frazzled"],
    resistances: ["scratched", "provoked"],
    threat: 0,
    row: "front",
    stats: st(140, 10, 3, 4, 0),
    skills: ["hoseWhack", "dustBlast"], // phase-1 kit (phases swap the array)
    traits: ["heavy"],
    xp: 40, // GDD §5: boss XP 40 (floor 3)
    look: { family: "construct", sizeGrade: "boss", tier: 2, props: ["crown"] },
    boss: {
      poise: 3,
      doubleTurn: true,
      phases: [
        { hpPct: 1.0, skills: ["hoseWhack", "dustBlast"] },
        // phase @50% "MAX SUCTION" — pulls all cats 1 rank forward each turn
        { hpPct: 0.5, skills: ["hoseWhack", "maxSuction"] },
      ],
    },
  },
  dogfather: {
    id: "dogfather",
    name: "The Dogfather",
    tier: 3,
    level: baseLevel(3, true),
    description:
      "He does not chase. He arranges for you to arrive. «BAD TO THE BONE» " +
      "stands behind him the way a debt stands behind a favour.",
    tell: "Lowers his head an inch. Everything after that is already decided.",
    // he bleeds like anyone, and a staggering blow tells (Poise, §11.1). He is
    // deliberately NOT frazzle-resistant: The Cucumber cancelling «BAD TO THE
    // BONE»'s windup is documented counterplay (combat.md §11.4).
    weaknesses: ["scratched", "shove"],
    resistances: ["provoked"], // nobody baits The Dogfather
    threat: 0,
    row: "front",
    stats: st(200, 12, 4, 5, 5),
    skills: ["maul", "junkyardToss"], // phase-1 kit
    traits: ["heavy"],
    xp: 60, // GDD §5: boss XP 60 (floor 6)
    look: { family: "beast", sizeGrade: "boss", tier: 3, props: ["scarf"] },
    boss: {
      poise: 4,
      doubleTurn: true,
      phases: [
        { hpPct: 1.0, skills: ["maul", "junkyardToss"] },
        { hpPct: 0.5, skills: ["maul", "junkyardToss", "theBigBark"] },
      ],
      // telegraphed 2-slot row nuke (combat.md §11.4)
      windup: {
        skillId: "theBigBark",
        telegraph:
          "«BAD TO THE BONE» rears behind The Dogfather, drawing a " +
          "monstrous breath — ranks 1-2 are marked!",
      },
    },
  },

  /* --------------------------- SHOULD-tier alternate floor-3 boss (GDD) -- */
  ratPrince: {
    id: "ratPrince",
    name: "The Rat Prince",
    tier: 2,
    level: baseLevel(2, true),
    description:
      "Crowned by acclaim of roughly forty rats. He will not fight you until " +
      "he has spent every subject he has.",
    tell: "Raises the scepter — either a bonk lands or the walls produce more rats.",
    weaknesses: ["frazzled", "shove"], // interrupt the court, stagger the throne
    resistances: ["provoked"], // he does not take instruction from cats
    threat: 0,
    row: "front",
    stats: st(120, 9, 2, 6, 5),
    skills: ["scepterBonk", "summonVermin"],
    traits: ["heavy"],
    xp: 40,
    look: { family: "vermin", sizeGrade: "boss", tier: 2, props: ["crown"] },
    boss: {
      poise: 3,
      doubleTurn: false,
      phases: [{ hpPct: 1.0, skills: ["scepterBonk", "summonVermin"] }],
      // summons rank-5 rats (sockWraith-style minion), cap 2 alive
      summon: { skillId: "summonVermin", minion: "ratThug", cap: 2 },
    },
  },
};
