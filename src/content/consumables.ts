/**
 * c(at)rpg content — the 10 consumables (loot.md §7).
 *
 * Every consumable carries a battle Skill payload (combat.md §4 shape) with
 * `cost: 0`, `power: 0` and every `applies` at `chance: 1.0` — item use in
 * battle consumes ZERO battle-stream rolls (loot.md §5e; a chance of exactly
 * 1.0 draws no roll, GDD §4 ruling). All items are usable from any rank and
 * consume the whole turn (combat.md §9).
 *
 * Flat-value effects the Skill shape cannot express (power scales off atk):
 *  - tunaSnack / sardineTin direct heals: the engine reads `explore.heal`
 *    (12 / 'full') for the battle heal too — the same locked numbers.
 *  - catnip: `energyGain: 2` is target-directed for item skills (the chosen
 *    ally gains the energy).
 *  - canOpenerRecording: guaranteed flee is engine-special-cased on the item
 *    id / `nonBoss` flag (no flee field exists on Skill).
 * combat.md's four locked numbers stand: Tuna 12, Catnip +2, Feather Wand
 * 25%, Cucumber guaranteed Frazzle once per battle.
 *
 * Data only: imports core/types.ts and nothing else.
 */
import type { ConsumableDef, ItemId } from "../core/types.js";

const ANY_RANK = [1, 2, 3, 4];
const ENEMY_RANKS = [1, 2, 3, 4, 5];

export const CONSUMABLES: Record<ItemId, ConsumableDef> = {
  tunaSnack: {
    id: "tunaSnack",
    name: "Tuna Snack",
    icon: "▸",
    price: 20,
    battleSkill: {
      id: "tunaSnack",
      name: "Tuna Snack",
      desc: "Heal one cat 12 HP.",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "ally", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "heal",
    },
    explore: { heal: 12 },
  },
  sardineTin: {
    id: "sardineTin",
    name: "Sardine Tin",
    icon: "▶",
    price: 45,
    battleSkill: {
      id: "sardineTin",
      name: "Sardine Tin",
      desc: "Heal one cat to full HP.",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "ally", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "heal",
    },
    explore: { heal: "full" },
  },
  warmMilk: {
    id: "warmMilk",
    name: "Warm Milk",
    icon: "∪",
    price: 30,
    battleSkill: {
      id: "warmMilk",
      name: "Warm Milk",
      desc: "One ally gains Mending value 4 for 2 rounds.",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "ally", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "utility",
      applies: [{ status: "mending", chance: 1.0, value: 4 }],
    },
  },
  catnip: {
    id: "catnip",
    name: "Catnip",
    icon: "❋",
    price: 25,
    battleSkill: {
      id: "catnip",
      name: "Catnip",
      desc: "One ally gains +2 Energy (cap = its enMax).",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "ally", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "utility",
      energyGain: 2, // target-directed for item skills
    },
  },
  theCucumber: {
    id: "theCucumber",
    name: "The Cucumber",
    icon: "⌁",
    price: 40,
    battleSkill: {
      id: "theCucumber",
      name: "The Cucumber",
      desc:
        "One enemy, any rank: Frazzled (guaranteed). Cancels a charging " +
        "windup. Once per battle — they wise up.",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "enemy", ranks: ENEMY_RANKS, pattern: "single" },
      power: 0,
      kind: "utility",
      applies: [{ status: "frazzled", chance: 1.0 }],
    },
    oncePerBattle: true,
  },
  squeakyToy: {
    id: "squeakyToy",
    name: "Squeaky Toy",
    icon: "♢",
    price: 25,
    battleSkill: {
      id: "squeakyToy",
      name: "Squeaky Toy",
      desc:
        "Throw at one enemy, ranks 1-3: push back 1 — a forced move, so " +
        "Off-Balance (heavy: chip 1 Poise).",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "enemy", ranks: [1, 2, 3], pattern: "single" },
      power: 0,
      kind: "utility",
      moveTarget: 1,
    },
  },
  bagOfFleas: {
    id: "bagOfFleas",
    name: "Bag of Fleas",
    icon: "⁘",
    price: 25,
    battleSkill: {
      id: "bagOfFleas",
      name: "Bag of Fleas",
      desc: "One enemy, any rank: Scratched value 3 (guaranteed).",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "enemy", ranks: ENEMY_RANKS, pattern: "single" },
      power: 0,
      kind: "utility",
      applies: [{ status: "scratched", chance: 1.0, value: 3 }],
    },
  },
  cardboardBox: {
    id: "cardboardBox",
    name: "Cardboard Box",
    icon: "⩌",
    price: 20,
    battleSkill: {
      id: "cardboardBox",
      name: "Cardboard Box",
      desc:
        "One ally hunkers: Guarded until the start of its next turn " +
        "(no bonus energy).",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "ally", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "utility",
      applies: [{ status: "guarded", chance: 1.0 }],
    },
  },
  canOpenerRecording: {
    id: "canOpenerRecording",
    name: "Can-Opener Recording",
    icon: "≈",
    price: 35,
    battleSkill: {
      id: "canOpenerRecording",
      name: "Can-Opener Recording",
      desc:
        "Non-boss. The party flees: Scatter! succeeds with no roll (all " +
        "normal flee consequences).",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "self", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "utility",
    },
    nonBoss: true,
  },
  featherWand: {
    id: "featherWand",
    name: "Feather Wand",
    icon: "⌒",
    price: 60,
    battleSkill: {
      id: "featherWand",
      name: "Feather Wand",
      desc:
        "Revive one KO'd ally at 25% max HP, placed in rank 4. In-battle " +
        "revival — no Life lost.",
      cost: 0,
      usableFrom: ANY_RANK,
      target: { side: "ally", ranks: ANY_RANK, pattern: "single" },
      power: 0,
      kind: "utility",
      revivePct: 0.25,
    },
  },
};
