/**
 * Generated-content contracts — the shapes the DM authors and the game
 * consumes.
 *
 * Pure types only (no runtime code), which is why all three packages can
 * share them: the browser (`services/oneshot.ts` re-lints them), the eve
 * agent (`agent/lib/oneshot.ts` asserts its zod schemas against them at
 * compile time) and `scripts/`. They used to be the wire protocol between the
 * browser and the `api/gm/*` functions; those functions are gone and the
 * transport envelopes went with them, but the CONTENT shapes are the same
 * ones the engines already consume (docs/design/gm-system.md).
 */
import type { EquipDef, Skill, Stats } from "../core/types.js";

/* ------------------------------------------------------------------------ */
/* Stand powers (stand-powers.md — canonical DSL from core/combat)           */
/* ------------------------------------------------------------------------ */
//
// The Power Script DSL is owned by src/core/combat/powerTypes.ts (types-only,
// zero runtime code). This module re-exports it so the browser, the agent and
// the seeding scripts all speak the interpreter's exact shapes.

export type {
  EffectSpec,
  InteractionRule,
  PowerPredicate,
  PowerScript,
  PowerTargetSel,
  PowerTrigger,
} from "../core/combat/powerTypes.js";
import type { PowerScript } from "../core/combat/powerTypes.js";

/* ------------------------------------------------------------------------ */
/* Party generation                                                          */
/* ------------------------------------------------------------------------ */

/** Party role coverage required by gm-system.md ("tank/striker/control/support"). */
export type GmRole = "tank" | "striker" | "control" | "support";

export interface GeneratedStand {
  /** Dramatic ALL-CAPS Stand name, e.g. "TESLA PURR". */
  name: string;
  /** Masonry image prompt for the cat+Stand battle sprite. */
  visualPrompt: string;
}

/**
 * A CatClass-shaped kit for a player-described cat. Mirrors core `CatClass`
 * except: no fixed `ClassId` (custom cats), skills are full `Skill` defs
 * (their ids do not exist in content/skills.ts), and the trait is prose-only
 * (custom trait hooks are not executable in v1 — UI shows the text).
 */
export interface GeneratedCatKit {
  role: GmRole;
  catName: string;
  className: string;
  epithet: string;
  /** L1 stats; hard budget per role, see services/caps.ts. */
  base: Stats;
  /** 7 rows, applied at L2..L8. */
  growth: Partial<Stats>[];
  /** Exactly 4, incl. one cost-0 basic with energyGain 1. */
  skills: Skill[];
  trait: { name: string; desc: string };
  stand: GeneratedStand;
  /** One Power Script per cat (stand-powers.md Layer 2), budget-linted. */
  power: PowerScript;
  flavor: { bio: string; barks: { crit: string; ko: string; catPile: string } };
}

/* ------------------------------------------------------------------------ */
/* Items                                                                     */
/* ------------------------------------------------------------------------ */

/** loot.md EquipDef plus an icon prompt for the Masonry job. */
export interface GeneratedEquip extends EquipDef {
  iconPrompt: string;
}
