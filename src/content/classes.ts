/**
 * WP-02a — CLASSES: the 4 CatClass definitions, verbatim from classes.md
 * ("The Four Strays"). Bases, growth rows, skill unlocks, traits, flavor,
 * and procedural palettes. The level-1 party built from this table is
 * byte-for-byte the combat.md §13 worked-example party (asserted in
 * tests/content-classes.spec.ts).
 *
 * Growth rows are applied at L2..L8 in order (classes.md §8): max HP rises
 * and current HP rises by the same delta; capstone unlocks at L4; trait
 * tier 2 at L7.
 */
import type { CatClass, ClassId } from "../core/types";

export const CLASSES: Record<ClassId, CatClass> = {
  /* ---------------------------------------------------------------------- */
  /* Bruiser — Bruno, "The Doorstop of Dumpster Court" (classes.md §4)       */
  /* ---------------------------------------------------------------------- */
  bruiser: {
    id: "bruiser",
    className: "Bruiser",
    catName: "Bruno",
    epithet: "The Doorstop of Dumpster Court",
    base: { hp: 40, atk: 10, def: 3, spd: 4, crt: 5, enMax: 10 },
    growth: [
      { hp: 4, atk: 1 },
      { hp: 4, def: 1 },
      { hp: 4, atk: 1 },
      { hp: 4, spd: 1 },
      { hp: 4, atk: 1 },
      { hp: 4, def: 1 },
      { hp: 4, atk: 1 },
    ],
    skills: [
      { skillId: "clawSwipe", unlockLevel: 1 },
      { skillId: "bodySlam", unlockLevel: 1 },
      { skillId: "hiss", unlockLevel: 1 },
      { skillId: "dumpsterDunk", unlockLevel: 4 },
    ],
    trait: {
      id: "immovableLoaf",
      name: "Immovable Loaf",
      desc:
        "Once per battle, when Bruno would be forced-moved, he does not move " +
        "and does not become Off-Balance. Bruno simply declines to be moved.",
      tier2Level: 7,
      tier2Desc:
        "When Immovable Loaf triggers, Bruno also gains Guarded until the " +
        "start of his next turn.",
    },
    flavor: {
      bio:
        "Ten years guarding a bodega door. Nothing got in. Nothing gets past " +
        "him now. His Stand, «THE DUMPSTER KING», looms behind him — a " +
        "crowned colossus of alley trash and yarn. Neither of them would " +
        "prefer to get up.",
      barks: {
        crit: "«THE DUMPSTER KING» descends! Filed under: trash.",
        ko: "...five minutes...",
        catPile: "PILE ON.",
      },
    },
    palette: { body: 0xe08a2e, ears: 0xb5661c, eyes: 0xf2c14e },
  },

  /* ---------------------------------------------------------------------- */
  /* Trickster — Pixel, "Warranty Voider" (classes.md §5)                    */
  /* ---------------------------------------------------------------------- */
  trickster: {
    id: "trickster",
    className: "Trickster",
    catName: "Pixel",
    epithet: "Warranty Voider",
    base: { hp: 28, atk: 12, def: 1, spd: 8, crt: 15, enMax: 10 },
    growth: [
      { hp: 2, atk: 1 },
      { hp: 2, crt: 2 },
      { hp: 2, spd: 1 },
      { hp: 2, atk: 1 },
      { hp: 2, crt: 2 },
      { hp: 2, atk: 1 },
      { hp: 2, atk: 1, spd: 1 },
    ],
    skills: [
      { skillId: "clawSwipe", unlockLevel: 1 },
      { skillId: "pounce", unlockLevel: 1 },
      { skillId: "tripWire", unlockLevel: 1 },
      { skillId: "boxAmbush", unlockLevel: 4 },
    ],
    trait: {
      id: "opportunist",
      name: "Opportunist",
      desc: "Staggered prey. +10% crit chance against Off-Balance enemies.",
      tier2Level: 7,
      tier2Desc:
        "Staggered prey. +20% crit chance against Off-Balance enemies.",
    },
    flavor: {
      bio:
        "Every object on every shelf is a to-do list. Her Stand, " +
        "«BOX AMBUSH», is a cardboard phantom that waits inside any box, " +
        "anywhere, including boxes that do not exist yet. Every enemy is an " +
        "object on a shelf.",
      barks: {
        crit: "«BOX AMBUSH»! YEET.",
        ko: "rude.",
        catPile: "DOGPILE! ...cat-pile!",
      },
    },
    palette: { body: 0x9aa7b0, ears: 0x6e7b85, eyes: 0x7ce577 },
  },

  /* ---------------------------------------------------------------------- */
  /* Hexer — Mora, "The Void That Stares Back" (classes.md §6)               */
  /* ---------------------------------------------------------------------- */
  hexer: {
    id: "hexer",
    className: "Hexer",
    catName: "Mora",
    epithet: "The Void That Stares Back",
    base: { hp: 24, atk: 11, def: 0, spd: 6, crt: 5, enMax: 10 },
    growth: [
      { hp: 2, atk: 1 },
      { hp: 2, spd: 1 },
      { hp: 2, atk: 1 },
      { hp: 2, def: 1 },
      { hp: 2, atk: 1 },
      { hp: 2, spd: 1 },
      { hp: 2, atk: 1 },
    ],
    skills: [
      { skillId: "clawSwipe", unlockLevel: 1 },
      { skillId: "yankOfYarn", unlockLevel: 1 },
      { skillId: "hairballHex", unlockLevel: 1 },
      { skillId: "phantomCucumber", unlockLevel: 4 },
    ],
    trait: {
      id: "stringTheory",
      name: "String Theory",
      desc:
        "When a skill Mora uses forced-moves an enemy at least 1 rank or " +
        "chips boss Poise, she gains +1 Energy. Pulling strings is its own " +
        "reward.",
      tier2Level: 7,
      tier2Desc:
        "When a skill Mora uses forced-moves an enemy at least 1 rank or " +
        "chips boss Poise, she gains +2 Energy.",
    },
    flavor: {
      bio:
        "She was somebody's familiar once. Her Stand, «STRING THEORY», " +
        "hums through every thread in the dungeon; the yarn obeys her. The " +
        "corners of rooms know her name. Please stop asking about the witch.",
      barks: {
        crit: "«STRING THEORY». As foretold.",
        ko: "I have been here before.",
        catPile: "The stars align.",
      },
    },
    palette: { body: 0x2b2333, ears: 0x1c1626, eyes: 0xffd447 },
  },

  /* ---------------------------------------------------------------------- */
  /* Medic — Baguette, "Fresh from the Oven" (classes.md §7)                 */
  /* ---------------------------------------------------------------------- */
  medic: {
    id: "medic",
    className: "Medic",
    catName: "Baguette",
    epithet: "Fresh from the Oven",
    base: { hp: 26, atk: 9, def: 1, spd: 5, crt: 5, enMax: 10 },
    growth: [
      { hp: 3 },
      { hp: 3, atk: 1 },
      { hp: 3, def: 1 },
      { hp: 3, atk: 1 },
      { hp: 3, spd: 1 },
      { hp: 3, atk: 1 },
      { hp: 3, def: 1 },
    ],
    skills: [
      { skillId: "clawSwipe", unlockLevel: 1 },
      { skillId: "soothingPurr", unlockLevel: 1 },
      { skillId: "nineLivesNudge", unlockLevel: 1 },
      { skillId: "purrquake", unlockLevel: 4 },
    ],
    trait: {
      id: "purrEngine",
      name: "Purr Engine",
      desc:
        "When Baguette takes the Guard action, every other living cat gains " +
        "+1 Energy. An idling engine still charges the battery.",
      tier2Level: 7,
      tier2Desc:
        "When Baguette takes the Guard action, every other living cat gains " +
        "+2 Energy.",
    },
    flavor: {
      bio:
        "Baked to perfection in a shop window, now applying warmth as a " +
        "combat discipline. Her Stand, «PURR ENGINE», idles at healing " +
        "frequency and redlines at group-hug. Carries the snacks. Guards " +
        "the snacks.",
      barks: {
        crit: "«PURR ENGINE», full throttle!",
        ko: "Mind the snacks.",
        catPile: "Group hug!",
      },
    },
    palette: { body: 0xeed9b7, ears: 0xd9b98c, eyes: 0x8a5a2b },
  },
};
