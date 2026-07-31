/**
 * STOCK POWERS — hand-authored PowerScripts (stand-powers.md, scope ladder
 * step 1): one per default cat and one per boss. These prove the Layer-1
 * substrate and double as the fallback pool when a GM-compiled power fails
 * the budget lint.
 *
 * Every `budget` value below is hand-computed with the powers.ts pricing
 * (trigger freq × Σ effect costs × Π condition discounts × charge discount)
 * and asserted equal to `powerBudget(script)` in tests/powers.spec.ts —
 * all under their caps (cat 12; enemy tier 2 → 9, tier 3 → 12).
 */
import type { ClassId, EnemyId } from "../core/types.js";
import type { PowerScript } from "../core/combat/powerTypes.js";

/** Stock cat powers, keyed by ClassId (attach as 'cat:<classId>'). */
export const CAT_POWERS: Partial<Record<ClassId, PowerScript>> = {
  // Bruno — THE DUMPSTER KING: a guard-ish shove counter. When something
  // dares to hit Bruno, the crowned colossus sometimes files the attacker
  // at the back of the alley and settles deeper into the loaf (Guarded).
  // budget = onTakeHit 3 × (move 3 + guarded 4 = 7) × chance 0.35 × perRound1 0.7
  bruiser: {
    id: "power:dumpsterKing",
    version: 1,
    name: "THE DUMPSTER KING",
    flavor: "The lid slams down — RETURN TO SENDER, filed under: trash.",
    budget: 5.145,
    trigger: "onTakeHit",
    conditions: [{ kind: "chance", pct: 35 }],
    effects: [
      { kind: "move", target: "other", delta: 1 },
      { kind: "status", target: "self", status: "guarded" },
    ],
    charges: { perRound: 1 },
  },

  // Pixel — BOX AMBUSH: on a crit, the box was ALREADY behind them; a
  // second cardboard phantom strikes the same victim for a bonus hit.
  // budget = onCrit 1.5 × (damage 60/10 = 6) × perRound1 0.7
  trickster: {
    id: "power:boxAmbush",
    version: 1,
    name: "BOX AMBUSH",
    flavor: "The box was ALREADY behind them. A second strike from nowhere!",
    budget: 6.3,
    trigger: "onCrit",
    conditions: [],
    effects: [{ kind: "damage", target: "other", pct: 60 }],
    charges: { perRound: 1 },
  },

  // Mora — STRING THEORY: every yanked thread of fate echoes. A skill that
  // force-moves (or staggers a boss) refunds energy and snaps a thread
  // across the moved one.
  // budget = onForcedMove 2 × (energy 2·1 = 2 + damage 30/10 = 3) × perRound1 0.7
  hexer: {
    id: "power:stringTheory",
    version: 1,
    name: "STRING THEORY",
    flavor: "The threads snap taut — fate refunds the pull.",
    budget: 7,
    trigger: "onForcedMove",
    conditions: [],
    effects: [
      { kind: "energy", target: "self", amount: 1 },
      { kind: "damage", target: "other", pct: 30 },
    ],
    charges: { perRound: 1 },
  },

  // Baguette — PURR ENGINE: when a clowder-mate falls, the engine redlines
  // in grief; a healing frequency floods every cat still standing (heal +
  // Mending 2). Once per battle.
  // budget = onAllyKO 1 × (heal 60/10·2 = 12 + mending (4+2)·2 = 12) × perBattle1 0.4
  medic: {
    id: "power:purrEngine",
    version: 1,
    name: "PURR ENGINE",
    flavor:
      "The engine redlines in grief — a healing frequency floods the alley.",
    budget: 9.6,
    trigger: "onAllyKO",
    conditions: [],
    effects: [
      { kind: "heal", target: "allies", pct: 60 },
      { kind: "status", target: "allies", status: "mending", value: 2 },
    ],
    charges: { perBattle: 1 },
  },
};

/** Stock boss powers, keyed by EnemyId (attach as 'e<i>:<enemyId>'). */
export const ENEMY_POWERS: Partial<Record<EnemyId, PowerScript>> = {
  // The Vacuum King — ABSOLUTE VOID: sometimes a landed hit is answered by
  // every hatch gasping open, vacuuming the attacker's very momentum
  // (energy drain).
  // budget = onTakeHit 3 × (energy 2·|−2| = 4) × chance 0.25 × perRound1 0.7
  // = 2.1 (tier 2 cap 9)
  vacuumKing: {
    id: "power:absoluteVoid",
    version: 1,
    name: "ABSOLUTE VOID",
    flavor: "Every hatch gasps open — your momentum is simply… gone.",
    budget: 2.1,
    trigger: "onTakeHit",
    conditions: [{ kind: "chance", pct: 25 }],
    effects: [{ kind: "energy", target: "other", amount: -2 }],
    charges: { perRound: 1 },
  },

  // The Dogfather — BAD TO THE BONE: a crit collects interest — the victim
  // is filed at the back with the other problems and left bleeding.
  // budget = onCrit 1.5 × (move 3 + scratched (5+2) = 10) × perRound1 0.7
  // = 10.5 (tier 3 cap 12)
  dogfather: {
    id: "power:badToTheBone",
    version: 1,
    name: "BAD TO THE BONE",
    flavor: "It collects interest on every wound. Strictly business.",
    budget: 10.5,
    trigger: "onCrit",
    conditions: [],
    effects: [
      { kind: "move", target: "other", delta: 1 },
      { kind: "status", target: "other", status: "scratched", value: 2 },
    ],
    charges: { perRound: 1 },
  },

  // The Rat Prince — PURPLE REIGN: when a subject falls, the crown demands
  // tribute from every cat on the field. Twice per battle.
  // budget = onAllyKO 1 × (damage 40/10·2 = 8) × perBattle2 0.6 = 4.8 (tier 2 cap 9)
  ratPrince: {
    id: "power:purpleReign",
    version: 1,
    name: "PURPLE REIGN",
    flavor: "A subject has fallen! The crown demands tribute.",
    budget: 4.8,
    trigger: "onAllyKO",
    conditions: [],
    effects: [{ kind: "damage", target: "enemies", pct: 40 }],
    charges: { perBattle: 2 },
  },
};
