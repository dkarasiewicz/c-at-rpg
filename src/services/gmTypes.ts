/**
 * GM service protocol — request/response shapes shared between the browser
 * client (src/services/gm.ts) and the Vercel functions under api/gm/*.
 *
 * Pure types only (no runtime code): the api handlers import these with
 * `import type`, so nothing from src is ever bundled into the functions and
 * nothing from api is ever bundled into the game.
 *
 * All payload shapes are composed from the frozen core contracts in
 * src/core/types.ts — the GM authors content in the exact shapes the engines
 * already consume (docs/design/gm-system.md).
 */
import type { EquipDef, GameEvent, Rarity, Skill, Stats } from "../core/types";

/* ------------------------------------------------------------------------ */
/* Stand powers (stand-powers.md — canonical DSL from core/combat)           */
/* ------------------------------------------------------------------------ */
//
// The Power Script DSL is owned by src/core/combat/powerTypes.ts (types-only,
// zero runtime code — safe for the api package to import). The GM protocol
// re-exports it so both sides of the wire speak the interpreter's exact
// shapes; the service layer adds only the transport envelopes below.

export type {
  EffectSpec,
  InteractionRule,
  PowerPredicate,
  PowerScript,
  PowerTargetSel,
  PowerTrigger,
} from "../core/combat/powerTypes";
import type { InteractionRule, PowerScript } from "../core/combat/powerTypes";

/* ------------------------------------------------------------------------ */
/* Resonance (stand-powers.md Layer 3 — memoized interaction compilation)    */
/* ------------------------------------------------------------------------ */

export interface GmResonanceRequest {
  /** sortedPair(A.id, B.id) + framework version — see resonancePairKey(). */
  pairKey: string;
  powers: [PowerScript, PowerScript];
  /** credited as "first discovered by <session>" on a fresh compile */
  sessionId?: string;
}

/**
 * The memoized `interactions` row (stand-powers.md §DB additions). `json` is
 * the FULL core InteractionRule (which itself carries pairKey/version/flavor/
 * announce/budget) or null; flavor/announce are duplicated at row level so
 * null rows still carry their one-liner.
 */
export interface StoredInteraction {
  pairKey: string;
  version: number;
  /** null = compiled, no resonance (a valid, memoized outcome) */
  json: InteractionRule | null;
  flavor: string;
  announce: string;
  first_discovered_by?: string;
}

export interface GmResonanceResponse {
  pairKey: string;
  /** null = no resonance for this pair (still a definitive answer) */
  rule: InteractionRule | null;
  flavor: string;
  announce: string;
  firstDiscoveredBy?: string;
  source: "generated" | "pool";
}

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
  /** L1 stats; hard budget per role, see api/_lib/constraints.ts. */
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

export interface GmPartyRequest {
  /** 1–4 free-text cat descriptions, each <= 500 chars. */
  descriptions: string[];
}

export interface GmPartyResponse {
  /** Always exactly 4 kits covering all four roles. */
  kits: GeneratedCatKit[];
  source: "generated" | "pool";
}

/* ------------------------------------------------------------------------ */
/* Narrative events                                                          */
/* ------------------------------------------------------------------------ */

export interface GmEventRequest {
  /** 1..6 */
  floor: number;
  /** Current HP per living cat, front-to-back. */
  partyHp?: number[];
  partyLives?: number[];
  shinies?: number;
  /** Event ids already fired this run (avoid repeats). */
  recentEventIds?: string[];
  /** Free theme tags, e.g. ["laundromat", "ominous"]. */
  themeTags?: string[];
}

export interface GmEventResponse {
  /** Passes core/events/validate + the per-floor effect caps. */
  event: GameEvent;
  source: "generated" | "pool";
}

/* ------------------------------------------------------------------------ */
/* Items                                                                     */
/* ------------------------------------------------------------------------ */

export interface GmItemRequest {
  /** 1..6 */
  floor: number;
  rarity: Rarity;
  /** Class ids / names of the current party, for themed drops. */
  partyClasses?: string[];
}

/** loot.md EquipDef plus an icon prompt for the Masonry job. */
export interface GeneratedEquip extends EquipDef {
  iconPrompt: string;
}

export interface GmItemResponse {
  equip: GeneratedEquip;
  source: "generated" | "pool";
}

/* ------------------------------------------------------------------------ */
/* Director steering                                                         */
/* ------------------------------------------------------------------------ */

export interface GmSteerRequest {
  /** Floor being entered, 1..6. */
  floor: number;
  summary: {
    /** 0..1 mean party HP fraction. */
    hpPct: number;
    livesLost: number;
    shinies: number;
    enemiesDefeated: number;
    catPiles: number;
  };
}

/** Bounded nudge set — the director never invents mechanics. */
export interface GmSteerNudges {
  encounterBudgetDelta: -1 | 0 | 1;
  shopBias: "consumables" | "equipment" | "none";
  /** <= 60 chars; fed to the next /api/gm/event call as a theme tag. */
  nextEventTheme: string;
  /** <= 200 chars; one-line floor intro shown on floor transition. */
  floorIntro: string;
}

export interface GmSteerResponse {
  nudges: GmSteerNudges;
}
