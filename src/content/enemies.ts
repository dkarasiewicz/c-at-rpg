/**
 * ENEMIES — canonical roster per dungeon.md §7.1 (stat blocks verbatim),
 * plus events.md's event-only `elderStray`, the Laundromancer-cut summon
 * `sockWraith`, and the bosses per GDD §6 (vacuumKing 140/Poise 3,
 * dogfather 200/Poise 4, ratPrince SHOULD-tier alternate).
 *
 * Looks per ui-art.md §5 (family / sizeGrade / tier / props).
 * `enMax` is unused for enemies (always 0). Bosses and summons cost 0 threat.
 */
import type { EnemyDef, EnemyId } from "../core/types.js";

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  /* ---------------------------------------------------------------- T1 -- */
  ratThug: {
    id: "ratThug",
    name: "Rat Thug",
    tier: 1,
    threat: 1,
    row: "front",
    stats: { hp: 18, atk: 7, def: 1, spd: 5, crt: 5, enMax: 0 },
    skills: ["shiv"], // Shiv, usableFrom [1,2] (dungeon.md §7.1 / combat.md §13)
    traits: [],
    xp: 10,
    look: { family: "vermin", sizeGrade: "standard", tier: 1 },
  },
  sewerBat: {
    id: "sewerBat",
    name: "Sewer Bat",
    tier: 1,
    threat: 1,
    row: "front",
    stats: { hp: 10, atk: 6, def: 0, spd: 8, crt: 10, enMax: 0 },
    skills: ["swoop"], // fast, fragile
    traits: [],
    xp: 10,
    look: { family: "vermin", sizeGrade: "minion", tier: 1 },
  },
  dustBunny: {
    id: "dustBunny",
    name: "Dust Bunny",
    tier: 1,
    threat: 1,
    row: "front",
    stats: { hp: 14, atk: 5, def: 2, spd: 3, crt: 0, enMax: 0 },
    skills: ["nibble"], // slow chaff
    traits: [],
    xp: 10,
    look: { family: "vermin", sizeGrade: "minion", tier: 1 },
  },
  crowShaman: {
    id: "crowShaman",
    name: "Crow Shaman",
    tier: 1,
    threat: 2,
    row: "back",
    stats: { hp: 14, atk: 8, def: 0, spd: 7, crt: 5, enMax: 0 },
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
    threat: 2,
    row: "front",
    // dungeon.md's stat block is canonical (GDD §6 ruling over events.md's 34 HP/heavy)
    stats: { hp: 24, atk: 8, def: 2, spd: 6, crt: 5, enMax: 0 },
    skills: ["ram"], // rams: moveTarget +1 skill (shoves cats)
    traits: [],
    xp: 20,
    look: { family: "construct", sizeGrade: "standard", tier: 2 },
  },
  sprinklerImp: {
    id: "sprinklerImp",
    name: "Sprinkler Imp",
    tier: 2,
    threat: 2,
    row: "back",
    stats: { hp: 20, atk: 9, def: 1, spd: 7, crt: 5, enMax: 0 },
    skills: ["spray", "squirt"], // row-hitting spray (cooldown 2) + filler poke
    traits: [],
    xp: 20,
    look: { family: "construct", sizeGrade: "standard", tier: 2 },
  },
  yarnGolem: {
    id: "yarnGolem",
    name: "Yarn Golem",
    tier: 2,
    threat: 3,
    row: "front",
    stats: { hp: 40, atk: 9, def: 4, spd: 3, crt: 0, enMax: 0 },
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
    threat: 3,
    row: "front",
    stats: { hp: 34, atk: 11, def: 3, spd: 6, crt: 5, enMax: 0 },
    skills: ["bite"], // hits hard, shoves (moveTarget +1)
    traits: [],
    xp: 35,
    look: { family: "beast", sizeGrade: "standard", tier: 3 },
  },
  laserGhost: {
    id: "laserGhost",
    name: "Laser Ghost",
    tier: 3,
    threat: 3,
    row: "back",
    stats: { hp: 22, atk: 12, def: 0, spd: 9, crt: 10, enMax: 0 },
    skills: ["laserZap"], // high spd + crt glass cannon
    traits: [],
    xp: 35,
    look: { family: "construct", sizeGrade: "standard", tier: 3 },
  },
  trashPanda: {
    id: "trashPanda",
    name: "Trash Panda",
    tier: 3,
    threat: 4,
    row: "front",
    stats: { hp: 48, atk: 12, def: 2, spd: 6, crt: 10, enMax: 0 },
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
    threat: 0, // summons cost 0 threat; never appears in floor pools
    row: "back",
    stats: { hp: 12, atk: 6, def: 0, spd: 6, crt: 0, enMax: 0 },
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
    threat: 0, // event-only lone elite; never in pools
    row: "front",
    // events.md: HP 55, ATK 12, DEF 3, SPD 7, no traits (crt unspecified → 0)
    stats: { hp: 55, atk: 12, def: 3, spd: 7, crt: 0, enMax: 0 },
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
    threat: 0,
    row: "front",
    stats: { hp: 140, atk: 10, def: 3, spd: 4, crt: 0, enMax: 0 },
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
    threat: 0,
    row: "front",
    stats: { hp: 200, atk: 12, def: 4, spd: 5, crt: 5, enMax: 0 },
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
    threat: 0,
    row: "front",
    stats: { hp: 120, atk: 9, def: 2, spd: 6, crt: 5, enMax: 0 },
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
