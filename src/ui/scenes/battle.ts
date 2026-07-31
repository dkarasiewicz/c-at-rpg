/**
 * WP-11 — the battle scene (ui-art §8, ARCHITECTURE.md §3.2's canonical
 * drive-engine-then-animate pattern). The scene drives ONLY core/combat's
 * public API (createBattle / startRound / nextActor / legalActions /
 * resolveAction / takeEnemyTurn / previewDamage / battleResult) and animates
 * the returned BattleEvent log through a queue that drains at ≥3 events/s —
 * the engine itself is never blocked by animation. Zero rule logic lives
 * here: every outcome, legality check and preview number comes from core.
 */
import { BitmapText, Container, Graphics, Sprite, Text } from "pixi.js";
import type {
  BattleAction,
  BattleEvent,
  BattleSetup,
  BattleState,
  ClassId,
  Combatant,
  DeclaredIntent,
  EnemyId,
  MewHookId,
  Skill,
  StatusId,
} from "../../core/types.js";
import { hash, mulberry32 } from "../../core/rng.js";
import type { Rng } from "../../core/types.js";
import type {
  AttachedInteraction,
  PoweredBattleSetup,
  PowerScript,
} from "../../core/combat/powerTypes.js";
import {
  getCachedResonance,
  prefetchResonance,
  resonancePairKey,
} from "../../services/oneshot.js";
import {
  ensureDmSession,
  isDmAvailable,
  markDmUnreachable,
  planInterjection,
  presenceOf,
  probeDm,
  requestCombatVerdict,
  requestInterjection,
  withBeatSpent,
  withInterjectionRecorded,
  withQueuedInterjection,
  type DmBeat,
  type Interjection,
  type PresenceRun,
} from "../../services/dm.js";
import {
  canAffordImprovisation,
  improviseActionFor,
  isLiveTarget,
  validateCombatVerdict,
  withAdjudication,
  withDmSession,
  type TabletopRun,
} from "../../services/tabletop.js";
import {
  createTabletopBar,
  createTabletopChip,
  type TabletopBar,
} from "../overlays/tabletopBar.js";
import { createBattle } from "../../core/combat/setup.js";
import {
  battleResult,
  isAutoSkip,
  startRound,
} from "../../core/combat/turns.js";
import {
  resolveAction,
  type ImproviseAction,
} from "../../core/combat/resolve.js";
import { takeEnemyTurn } from "../../core/combat/ai.js";
import { intentFor } from "../../core/combat/intent.js";
import {
  byId,
  hypotheticalDistance,
  itemLegality,
  legalActions,
  lookupSkill,
  nextActor,
  previewDamage,
  shoveDamageMult,
  wouldMoveDistance,
  type LegalActions,
} from "../../core/combat/state.js";
import {
  intentsVisibleFor,
  knownIntel,
  maskIntent,
  recordBattle,
  KILLS_TO_COMPLETE,
  type EnemyKnowledge,
} from "../../core/meta/index.js";
import { saveMeta } from "../../core/run/save.js";
import { applyBattleResult } from "../../core/run/runState.js";
import {
  effectiveStats,
  activeSkills,
  traitTier,
} from "../../core/run/party.js";
import { rollBossLoot, rollChest, rollVictory } from "../../core/loot/roll.js";
import type { LootCtx } from "../../core/loot/roll.js";
import { isStack, removeConsumable } from "../../core/loot/inventory.js";
import { roundHalfUp } from "../../core/util.js";
import { CLASSES } from "../../content/classes.js";
import { CONSUMABLES } from "../../content/consumables.js";
import { ENEMIES } from "../../content/enemies.js";
import { CAT_POWERS, ENEMY_POWERS } from "../../content/powers.js";
import { FLOORS } from "../../content/floors.js";
import { PAL, mix } from "../palette.js";
import { DESIGN_H, DESIGN_W, R, SPACE, rh, rw, rx, ry } from "../layout.js";
import { MONO_BITMAP, TYPE, mono } from "../textStyles.js";
import { killTweens, shake, tween } from "../tween.js";
import {
  bar,
  heading,
  label,
  makeEnergyPips,
  makeHotkeyChip,
  makeSpriteIcon,
  makeStatusChip,
  panel,
  type ValueBar,
} from "../widgets.js";
import { drawCat } from "../draw/cats.js";
import { drawEnemy } from "../draw/enemies.js";
import {
  CAT_BRUISER_HEIGHT,
  CAT_HEIGHT,
  gradeForLook,
  subjectFeetOffset,
  subjectScale,
  UNIT_HEIGHT,
  type SizeGrade,
} from "../draw/spriteFrame.js";
import { catTexture, enemyTexture } from "../sprites.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";
import { isTouch, padHit, padHitBox } from "../touch.js";
import type { EventWinContext, LootOverlayParams } from "../overlays/loot.js";
import { makeIntentBadge, type IntentBadge } from "../draw/intel.js";
import {
  drawGhostArrow,
  makeActivePanel,
  makeBattleStage,
  makeCatPileBanner,
  makeChargeMark,
  makeContactShadow,
  makeDamagePreview,
  makeFieldZones,
  makeFleeButton,
  makeInspectPanel,
  makeLogStrip,
  makeNameplate,
  makePoisePips,
  makePresenceAura,
  makePreviewChip,
  makeRankFlood,
  makeRibbon,
  makeRim,
  makeRoundChip,
  makeSkillBar,
  makeStatusPreviewChip,
  makeTargetRing,
  makeThreatLayer,
  makeUnitGlow,
  type BattleStage,
  type ChargeMark,
  type FieldZones,
  type PresenceAura,
  type RoundChip,
  type SlotSpec,
  type ThreatLayer,
  type ThreatLink,
} from "./battleWidgets.js";

/* ---------------------------------------------------------------------- */
/* Params — accepted from the run map (a node fight) and the event scene   */
/* ---------------------------------------------------------------------- */

export interface BattleSceneParams {
  t?: "battle";
  enemies: EnemyId[];
  /** battleRng stream key: mulberry32(hash(runSeed, floor, encounterIndex)) */
  encounterIndex: number;
  isBoss?: boolean;
  /**
   * Elite node fight. Purely presentational: the stage swaps the floor's own
   * backdrop for the `scene:elite` ambush chokepoint so an elite reads as an
   * ambush the moment the screen paints, before a single intent is declared.
   */
  isElite?: boolean;
  /**
   * Run-map node this fight belongs to. Passed to `applyBattleResult`, which
   * ticks `floorsCleared` only on a victory at the floor's terminal node.
   * Event fights own no node and leave it out.
   */
  nodeId?: number;
  /** event fights (events.md §2.3): victory loot mode. */
  lootMode?: "none" | "normal" | "bonus";
  /** event fights: onWinEffects context, passed to the loot overlay. */
  eventWin?: EventWinContext;
}

/* ---------------------------------------------------------------------- */
/* Per-combatant view model                                                */
/* ---------------------------------------------------------------------- */

interface UnitView {
  id: string;
  side: "cat" | "enemy";
  root: Container; // at (slotX, groundY); feet origin
  body: Container; // idle bob + breathing + Off-Balance tilt
  gfx: Graphics | Sprite; // generated sprite when available, procedural else
  aura: Graphics; // additive Stand-aura flash behind the body
  shadow: Graphics; // soft contact shadow on the floor plane
  presence: PresenceAura | null; // elite/boss gold ring + halo
  hpBar: ValueBar;
  hpNow: number;
  hpMax: number;
  energy?: { set(n: number): void };
  energyNow: number;
  statusRow: Container;
  statuses: Map<StatusId, { count: number; value: number }>;
  stars: Container;
  /** the over-head telegraph (enemies only) — enemy-intel.md §2 */
  intent: IntentBadge | null;
  poise?: { set(n: number): void; max: number };
  charge: ChargeMark | null;
  flood: Graphics | null;
  nameplate: Container | null;
  ring: Graphics | null; // targeting underline
  rank: number;
  dead: boolean;
  bobPhase: number;
  /** y of this unit's crown, relative to its feet — anchors chips/floaters. */
  headY: number;
}

/**
 * ── STAGE COMPOSITION ────────────────────────────────────────────────────
 * Where rank 1 of each side stands, plus the pitch between ranks and the
 * no-man's-land between the two formations — all recomputed per battle from
 * the actual headcounts and the biggest enemy on the field.
 *
 * The previous pass scaled characters up (draw/spriteFrame.ts), which was
 * right, but it left every fight huddled in the middle of the frame with dead
 * margins on both sides and NO visible line between your cats and theirs: the
 * whole board read as one crowd. Three rules fix that, and they hold at 2v1
 * and at 4v5 alike:
 *
 *  1. **Each side owns a share of the stage** proportional to `(n + 1)`, so a
 *     2-cat party is not asked to fill the same width as a 5-enemy pack and
 *     the outer margins come out even on both sides.
 *  2. **The two shares are separated by a real gap** — `divide.half` on each
 *     side of `divide.x`, widened for a big enemy so a boss never shares
 *     pixels with the front cat. `battleWidgets.makeFieldZones` paints that
 *     band as unlit ground with a dashed centre line.
 *  3. **Formations lean toward the line** (`LEAN`) rather than sitting dead
 *     centre in their share, so slack goes to the OUTSIDE of the frame where
 *     it costs nothing and the fight still reads as a confrontation.
 *
 * Module-scope because `slotX` is called from a dozen animation callbacks;
 * `layOutFormation` is the only writer and runs once, at mount.
 */
const front = { cat: 556, enemy: 722 };
const pitch: { cat: number; enemy: number } = {
  cat: R.combat.formation.catPitch,
  enemy: R.combat.formation.enemyPitch,
};
/** Centre of the no-man's-land, and half its width. */
const divide = { x: DESIGN_W / 2, half: 100 };

/** The formation never crosses this outer margin. */
const STAGE_PAD = 86;
/** Neutral band: a floor, plus room bought by the biggest enemy present. */
const GAP_BASE = 70;
const GAP_PER_HEIGHT = 0.16;
/** Rank pitch bounds — under the min ranks fuse, over the max they float. */
const PITCH = { catMin: 104, catMax: 180, foeMin: 96, foeMax: 168 };
/** 0 = centre the formation in its share, 1 = jam it against the centre line. */
const LEAN = 0.72;

const slotX = (side: "cat" | "enemy", rank: number): number =>
  side === "cat"
    ? front.cat - (rank - 1) * pitch.cat
    : front.enemy + (rank - 1) * pitch.enemy;

const clampN = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

const HEAD_Y = -104; // status rows / floaters spawn height above the feet
/**
 * World y the over-head stack may not rise above — clear of the turn-order
 * strip (R.combat.ribbon runs y 8-68). A boss is 306px tall and used to wear
 * its Poise pips level with the ribbon.
 */
const OVERHEAD_MIN_Y = 96;
/** The stage's warm key colour — the bounce light behind every unit. */
const KEY_LIGHT = mix(PAL.gold, PAL.text, 0.55);
const TILT = (8 * Math.PI) / 180;
const ATTACK_TILT = 0.09; // slight lean into the lunge (rad)
const BREATH_AMP = 0.015; // ±1.5% idle breathing scale

/**
 * Presentation size grade — cats read as one consistent tier a notch above a
 * standard enemy; everyone else is graded by content (`look.sizeGrade`).
 */
const gradeOf = (c: Combatant): SizeGrade | "cat" =>
  c.side === "cat"
    ? "cat"
    : gradeForLook(ENEMIES[c.speciesId ?? ""]?.look.sizeGrade ?? "standard");

/**
 * Apparent CHARACTER height every unit of a grade is normalised to, whatever
 * the art source (painted sprite or procedural recipe) and whatever fraction
 * of its frame that source's Stand aura happens to occupy. This is what stops
 * a rat reading the same height as a cat (draw/spriteFrame.ts).
 */
const spriteHeightFor = (c: Combatant): number => {
  if (c.side === "cat")
    return c.classId === "bruiser" ? CAT_BRUISER_HEIGHT : CAT_HEIGHT;
  const g = gradeOf(c);
  return g === "cat" ? CAT_HEIGHT : UNIT_HEIGHT[g];
};

/**
 * Lay the board out for THIS battle's headcounts (see the STAGE COMPOSITION
 * note above). Writes `front`, `pitch` and `divide`; everything else on the
 * stage — the ground zones, the centre line, the rank plates — is derived
 * from those four numbers.
 */
const layOutFormation = (combatants: readonly Combatant[]): void => {
  const cats = combatants.filter((c) => c.side === "cat");
  const foes = combatants.filter((c) => c.side === "enemy");
  const nc = Math.max(1, cats.length);
  const ne = Math.max(1, foes.length);
  const biggest =
    foes.reduce((m, c) => Math.max(m, spriteHeightFor(c)), 0) ||
    UNIT_HEIGHT.medium;

  divide.half = GAP_BASE + biggest * GAP_PER_HEIGHT;
  // width left over once both margins and the neutral band are taken out
  const usable = DESIGN_W - STAGE_PAD * 2 - divide.half * 2;
  // `n + 1` rather than `n`: a lone boss still gets a presentable slice, and
  // a 2-cat party is not stretched across the same width as a 5-enemy pack
  const catShare = (usable * (nc + 1)) / (nc + ne + 2);
  const foeShare = usable - catShare;

  pitch.cat = clampN(catShare / nc, PITCH.catMin, PITCH.catMax);
  pitch.enemy = clampN(foeShare / ne, PITCH.foeMin, PITCH.foeMax);
  const spanC = (nc - 1) * pitch.cat;
  const spanF = (ne - 1) * pitch.enemy;

  divide.x = STAGE_PAD + catShare + divide.half;
  front.cat = divide.x - divide.half - (catShare - spanC) * (1 - LEAN);
  front.enemy = divide.x + divide.half + (foeShare - spanF) * (1 - LEAN);
};

/** World-x extents of a side's occupied ranks — what the zone wash hugs. */
const sideExtent = (
  combatants: readonly Combatant[],
  side: "cat" | "enemy",
): [number, number] => {
  const ranks = combatants.filter((c) => c.side === side).map((c) => c.rank);
  const maxRank = ranks.length > 0 ? Math.max(...ranks) : 1;
  const a = slotX(side, 1);
  const b = slotX(side, maxRank);
  return a < b ? [a, b] : [b, a];
};

/* ---------------------------------------------------------------------- */
/* The scene                                                               */
/* ---------------------------------------------------------------------- */

/**
 * Resonance discoveries already shown as a banner this session (the banner
 * fires ONCE per pair — stand-powers.md L3 "surfaced as a discovery").
 */
const announcedResonances = new Set<string>();

export function createBattleScene(): Scene {
  let ctx: GameCtx | null = null;
  let params: BattleSceneParams | null = null;
  let alive = false;

  // engine state
  let bs: BattleState | null = null;
  let rng: Rng | null = null;
  const log: BattleEvent[] = [];
  let isBoss = false;

  // layers (scene-owned containers inside the shared layer stack)
  let bgC: Container | null = null;
  let worldC: Container | null = null;
  let fxC: Container | null = null;
  let hudC: Container | null = null;
  let floatC: Container | null = null;
  let modalC: Container | null = null;

  // widgets
  const ribbon = makeRibbon();
  const skillBar = makeSkillBar();
  const activePanel = makeActivePanel();
  const banner = makeCatPileBanner();
  let stage: BattleStage | null = null;
  let zones: FieldZones | null = null;
  let threat: ThreatLayer | null = null;
  const inspect = makeInspectPanel(() => closeInspect());
  let roundChip: RoundChip | null = null;
  let logText: BitmapText | null = null;
  let activeSlot: Graphics | null = null;
  let scrollPanel: Container | null = null;
  let scrollOffset = 0;

  // intel (enemy-intel.md): species that have moved in THIS battle — rule §5's
  // "a first-timer shows ? until it acts once".
  const actedSpecies = new Set<EnemyId>();
  /** last rendered telegraph signature, so the board only rebuilds on change */
  let intentSig = "";

  // units
  const units = new Map<string, UnitView>();

  // animation queue (≥3 events/s: every hold is capped at 333ms)
  const anim: BattleEvent[] = [];
  let holdMs = 0;
  let onDrained: (() => void) | null = null;
  let lastActorId: string | null = null;
  let pileDamageEach = 0;

  // interaction state
  type Phase = "anim" | "input" | "targeting" | "pile" | "done";
  let phase: Phase = "anim";
  let legal: LegalActions | null = null;
  let targeting: {
    skill: Skill;
    action: "skill" | "item";
    refId: string;
    targetIds: string[];
    idx: number;
    /** which skill-bar slot opened it — tapping it again backs out. */
    slot: number;
  } | null = null;
  let targetFx: Container | null = null;
  let flyout: Container | null = null;
  let flyoutItems: string[] = [];

  // the tabletop layer (run-map-and-dm.md §3) — built ONLY when a DM answers
  // the probe; offline these three stay null and the scene is unchanged
  let tabletop: TabletopBar | null = null;
  let tabletopChip: Container | null = null;
  let improvising = false;
  let elapsed = 0;
  let finished = false;
  /** §4b: was the last damage event a crit? (the fight-ending-crit beat) */
  let lastHitWasCrit = false;

  const logLines: string[] = [];

  /* ---------------- small helpers ---------------- */

  const delay = (ms: number, fn: () => void): void => {
    const o = { t: 0 };
    tween(o, { t: 1 }, ms, "linear", () => {
      if (alive) fn();
    });
  };

  const nameOf = (id: string): string => {
    if (!bs) return id;
    const c = bs.combatants.find((x) => x.id === id);
    return c?.name ?? id;
  };

  const skillName = (id: string): string => {
    try {
      return lookupSkill(id).name;
    } catch {
      return id;
    }
  };

  /**
   * Stand name for a combatant, read defensively from content flavor (the
   * theme pivot adds Stand names to content as optional fields; the UI must
   * work with or without them and never modifies content).
   */
  const standNameOf = (id: string): string | null => {
    const c = bs?.combatants.find((x) => x.id === id);
    if (!c) return null;
    // Stand Powers carry the canonical Stand name (「THE DUMPSTER KING」)
    const power =
      c.side === "cat" && c.classId
        ? CAT_POWERS[c.classId]
        : c.speciesId
          ? ENEMY_POWERS[c.speciesId]
          : undefined;
    if (power !== undefined && power.name.length > 0) return power.name;
    const src: unknown =
      c.side === "cat" && c.classId
        ? CLASSES[c.classId]
        : ENEMIES[c.speciesId ?? ""];
    if (typeof src !== "object" || src === null) return null;
    const o = src as Record<string, unknown>;
    const flavor =
      typeof o.flavor === "object" && o.flavor !== null
        ? (o.flavor as Record<string, unknown>)
        : {};
    const v = o.stand ?? o.standName ?? flavor.stand ?? flavor.standName;
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  /** "「THE DUMPSTER KING」 Body Slam" when a Stand is known, else the skill. */
  const announceSkill = (actorId: string, skillId: string): string => {
    const stand = standNameOf(actorId);
    const name = skillName(skillId);
    return stand ? `「${stand.toUpperCase()}」 ${name}` : name;
  };

  const pushLog = (text: string): void => {
    logLines.push(text);
    if (logLines.length > 40) logLines.shift();
    if (logText) {
      // the strip reserves its right edge for the "L log" hint chip
      const room = rw(R.combat.logLine) - SPACE.md * 2 - 72;
      logText.text = text;
      while (logText.width > room && logText.text.length > 4) {
        logText.text = logText.text.slice(0, -2) + "…";
      }
    }
  };

  /* ---------------- floaters (ui-art §8) ---------------- */

  const floater = (
    x: number,
    y: number,
    text: string,
    tint: number,
    size = 26,
    pop = false,
  ): void => {
    if (!floatC) return;
    const t = new BitmapText({
      text,
      style: { fontFamily: MONO_BITMAP, fontSize: size },
    });
    t.tint = tint;
    t.anchor.set(0.5);
    t.position.set(x + (Math.random() * 12 - 6), y + (Math.random() * 12 - 6));
    floatC.addChild(t);
    if (pop) {
      t.scale.set(1.3);
      tween(t.scale, { x: 1, y: 1 }, 150, "backOut");
    }
    tween(t, { y: t.y - 44 }, 600, "quadOut");
    delay(400, () => {
      tween(t, { alpha: 0 }, 200, "linear", () => {
        t.destroy();
      });
    });
  };

  /* ---------------- unit views ---------------- */

  const rebuildStatusRow = (u: UnitView): void => {
    u.statusRow.removeChildren().forEach((c) => c.destroy({ children: true }));
    let x = 0;
    for (const [id, info] of u.statuses) {
      const chip = makeStatusChip(
        id,
        id === "scratched" || id === "mending" ? info.value : undefined,
      );
      chip.position.set(x, 0);
      u.statusRow.addChild(chip);
      x += 18;
    }
    u.statusRow.pivot.x = Math.max(0, x - 2) / 2;
  };

  const setTilt = (u: UnitView, on: boolean): void => {
    const dir = u.side === "cat" ? -1 : 1;
    tween(u.body, { rotation: on ? dir * TILT : 0 }, on ? 400 : 150);
    u.stars.visible = on;
  };

  const makeUnit = (c: Combatant): UnitView => {
    const root = new Container();
    root.position.set(slotX(c.side, c.rank), R.combat.groundY);
    const body = new Container();
    const h = spriteHeightFor(c);
    const grade = gradeOf(c);
    // anchors scale WITH the art: a 292px boss must not wear its status
    // chips across its chest the way a 146px minion's sit above its ears
    const headY = -(h + 12);
    const isBossUnit = grade === "boss";
    const isBig = isBossUnit || grade === "large";

    /* -- grounding: soft contact shadow on the floor plane -------------- */
    const shadow = makeContactShadow(h * 0.92, isBossUnit ? 1.5 : 1);
    root.addChild(shadow);

    /* -- elite / boss presence: gold ground ring + halo ------------------ */
    let presence: PresenceAura | null = null;
    if (isBig) {
      presence = makePresenceAura(h, isBossUnit);
      root.addChild(presence.view);
    }

    // Stand-aura flash (additive, alpha-tweened on hit) behind the body
    const aura = new Graphics()
      .ellipse(0, -h * 0.48, h * 0.44, h * 0.52)
      .fill(0xffffff);
    aura.blendMode = "add";
    aura.alpha = 0;
    body.addChild(aura);

    /* -- bounce light: lifts dark art off a dark backdrop ---------------- */
    // one warm key colour for everyone so it reads as stage lighting rather
    // than a per-unit magic aura. Kept deliberately weak: the painted Stand
    // aura is already the widest, softest shape on the unit, and the CAT is
    // what has to read first.
    body.addChild(
      makeUnitGlow(
        h,
        KEY_LIGHT,
        isBossUnit ? 1.1 : isBig ? 0.8 : c.side === "cat" ? 0.45 : 0.65,
      ),
    );

    /* -- the art itself: painted sprite first, procedural recipe else ---- */
    const tex =
      c.side === "cat" && c.classId
        ? catTexture(c.classId)
        : enemyTexture(c.speciesId ?? "");
    // ONE factory: the rim is literally the same art, offset and blacked out,
    // so dark enemies keep a readable silhouette on any backdrop.
    const makeArt = (): Graphics | Sprite => {
      if (tex && tex.height > 0) {
        const sp = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
        // scale on the CHARACTER, not the frame — the frame is mostly aura —
        // then drop the sprite so the character's feet, not the bottom of its
        // aura, sit on the ground line (draw/spriteFrame.ts).
        sp.scale.set(subjectScale(tex.height, h));
        sp.position.y = subjectFeetOffset(h);
        return sp;
      }
      const g = new Graphics();
      if (c.side === "cat" && c.classId) {
        drawCat(g, c.classId, "battle");
      } else {
        const def = ENEMIES[c.speciesId ?? ""];
        if (def) drawEnemy(g, def.look);
      }
      // the procedural recipes draw at their own scale — normalise them to
      // the same apparent height the painted art gets, feet on the origin
      const b = g.getLocalBounds();
      if (b.height > 1) {
        const s = h / b.height;
        g.scale.set(s);
        g.position.y = -(b.y + b.height) * s;
      }
      return g;
    };

    // the rim thickness tracks the art size, or a boss would wear a hairline
    body.addChild(makeRim(makeArt, Math.max(2.5, h / 46), 0.42));
    const gfx = makeArt();
    body.addChild(gfx);
    root.addChild(body);

    // HP bar below the feet, widened with the unit so a boss's bar is not a
    // stub under a 292px silhouette
    const barW = isBossUnit ? 112 : isBig ? 92 : 76;
    const hpBar = bar(barW, 8, { kind: "hp" });
    hpBar.view.position.set(-barW / 2, 9);
    hpBar.set(c.hp, c.stats.hp, false);
    root.addChild(hpBar.view);
    let energy: { set(n: number): void } | undefined;
    if (c.side === "cat") {
      const pips = makeEnergyPips(c.stats.enMax || 10, 4, 6, 1);
      pips.view.position.set(-24, 21);
      pips.set(c.energy);
      energy = pips;
      root.addChild(pips.view);
    }

    /* -- the over-head stack --------------------------------------------
     * Built top-down and CLAMPED under the turn-order strip: a 306px boss
     * used to put its own chips level with the ribbon. Enemies carry the
     * intent badge closest to the crown (Slay the Spire's placement — the
     * telegraph is the thing you look at), status chips above it, and the
     * hover nameplate above those.
     */
    const badgeY = headY - 28;
    let statusY = c.side === "enemy" ? badgeY - 30 : headY - 20;
    const lift = Math.max(
      0,
      OVERHEAD_MIN_Y - (R.combat.groundY + statusY - 10),
    );
    statusY += lift;
    const plateY = statusY - 26;

    let intent: IntentBadge | null = null;
    if (c.side === "enemy") {
      intent = makeIntentBadge(1);
      intent.view.position.set(0, badgeY + lift);
      root.addChild(intent.view);
    }

    // status chips centered above the head
    const statusRow = new Container();
    statusRow.position.set(0, statusY);
    root.addChild(statusRow);

    // Off-Balance orbit stars
    const stars = new Container();
    for (let i = 0; i < 3; i++) {
      const star = new Text({
        text: "✶",
        style: mono(12, { fill: PAL.offBal }),
      });
      star.anchor.set(0.5);
      stars.addChild(star);
    }
    stars.position.set(0, headY - 4);
    stars.visible = false;
    root.addChild(stars);

    const u: UnitView = {
      id: c.id,
      side: c.side,
      root,
      body,
      gfx,
      aura,
      shadow,
      presence,
      hpBar,
      hpNow: c.hp,
      hpMax: c.stats.hp,
      energy,
      energyNow: c.energy,
      statusRow,
      statuses: new Map(),
      stars,
      intent,
      charge: null,
      flood: null,
      nameplate: null,
      ring: null,
      rank: c.rank,
      dead: false,
      bobPhase: c.rank * 0.9 + (c.side === "cat" ? 0 : 1.7),
      headY,
    };

    // Boss Poise: a SECOND RESOURCE, so it now reads under the HP bar next to
    // it instead of competing for the crowded airspace over the boss's head.
    if (c.poiseMax !== undefined) {
      const pips = makePoisePips(c.poiseMax);
      pips.view.position.set(0, 30);
      pips.view.pivot.x = (c.poiseMax * 18) / 2 - 6;
      pips.set(c.poise ?? c.poiseMax);
      root.addChild(pips.view);
      u.poise = { set: pips.set, max: c.poiseMax };
    }

    // hover nameplate + tap interactions. The hit box tracks the ART now that
    // sizes are graded: a 306px boss with a 108px-tall hit box was unclickable
    // above its knees, and phone-scale taps need the whole silhouette
    // (docs/design/mobile.md §3).
    root.eventMode = "static";
    const halfW = Math.max(46, h * 0.34);
    // The silhouette IS the target, grown to 44 CSS px under a finger — a
    // rat is 146px tall at design scale, which is 79 CSS px on a phone, but
    // only 31 px WIDE (docs/design/mobile.md §3).
    padHitBox(root, -halfW, -(h + 18), halfW * 2, h + 38);
    root.cursor = "pointer";
    root.on("pointerover", () => {
      if (isTouch()) return; // the tap path owns inspection on touch
      if (u.dead || !bs) return;
      const cc = bs.combatants.find((x) => x.id === u.id);
      if (!cc || u.nameplate) return;
      u.nameplate = makeNameplate(cc);
      u.nameplate.position.set(0, plateY);
      root.addChild(u.nameplate);
      if (targeting && targeting.targetIds.includes(u.id)) {
        targeting.idx = targeting.targetIds.indexOf(u.id);
        refreshTargeting();
      }
    });
    root.on("pointerout", () => {
      u.nameplate?.destroy({ children: true });
      u.nameplate = null;
    });
    root.on("pointertap", () => onUnitTap(u));
    return u;
  };

  const unitOf = (id: string): UnitView | undefined => units.get(id);

  /* ---------------- intel: telegraphs, threat, inspection ---------------- */

  /**
   * What the player is ALLOWED to see about one enemy's declaration
   * (enemy-intel.md §2 "learning is the reward"). The engine is never masked —
   * `maskIntent` only trims the view, so an unmet species reads `?` while the
   * AI still does exactly what it committed to.
   */
  const visibleIntent = (c: Combatant): DeclaredIntent | null => {
    if (!bs || !ctx || c.side !== "enemy" || !c.speciesId) return null;
    const raw = intentFor(bs, c.id);
    if (!raw) return null;
    // the floor is what the first-run grace keys on (bestiary.hasIntelGrace):
    // a brand-new player reads tier-1 telegraphs on floor 1 without earning
    // them first, so their first fight is a lesson rather than a wall of `?`
    return maskIntent(
      raw,
      intentsVisibleFor(
        ctx.meta,
        c.speciesId,
        actedSpecies.has(c.speciesId),
        ctx.run?.floorNum,
      ),
    );
  };

  /** Every living enemy's masked telegraph, keyed by combatant id. */
  const currentIntents = (): Map<string, DeclaredIntent | null> => {
    const out = new Map<string, DeclaredIntent | null>();
    if (!bs) return out;
    for (const c of bs.combatants) {
      if (c.side !== "enemy" || c.ko || c.hp <= 0) continue;
      out.set(c.id, visibleIntent(c));
    }
    return out;
  };

  /**
   * Repaint every telegraph surface — over-head badges, the turn-order strip
   * and the threat links — from the engine's own declarations. Cheap and
   * idempotent: it diffs a signature first, so calling it every frame costs a
   * string compare per enemy.
   */
  const syncIntents = (): void => {
    if (!bs) return;
    const intents = currentIntents();
    // the round is part of the signature so a fresh queue always repaints,
    // even in the rare case where every enemy re-declares an identical action
    let sig = `r${bs.round}/${bs.queueIndex}|`;
    for (const [id, i] of intents) {
      sig += `${id}:${i ? `${i.kind}/${i.value}/${i.targetId ?? ""}/${i.status ?? ""}` : "-"}|`;
    }
    if (sig === intentSig) return;
    intentSig = sig;

    for (const u of units.values()) {
      if (!u.intent) continue;
      u.intent.set(u.dead ? null : (intents.get(u.id) ?? null));
    }
    ribbon.refresh(bs, intents);

    /* -- threat: connect each declaration to the cat it lands on --------- */
    const links: ThreatLink[] = [];
    for (const [id, intent] of intents) {
      if (!intent) continue;
      if (
        intent.kind !== "strike" &&
        intent.kind !== "shove" &&
        intent.kind !== "status"
      ) {
        continue;
      }
      const from = unitOf(id);
      if (!from || from.dead) continue;
      const targets: UnitView[] = [];
      if (intent.ranks) {
        // a row skill sweeps ranks, not a combatant — highlight all of them
        for (const u of units.values()) {
          if (u.side === "cat" && !u.dead && intent.ranks.includes(u.rank)) {
            targets.push(u);
          }
        }
      } else if (intent.targetId) {
        const t = unitOf(intent.targetId);
        if (t && t.side === "cat" && !t.dead) targets.push(t);
      }
      for (const t of targets) {
        links.push({
          fromX: from.root.x,
          fromY: from.root.y + from.headY - 14,
          toX: t.root.x,
          toY: t.root.y,
          // above the cat's own status-chip row (which sits at headY − 20),
          // so a threatened, Scratched cat does not wear two overlapping chips
          headY: t.root.y + t.headY - 26,
          color:
            intent.kind === "shove"
              ? PAL.offBal
              : intent.kind === "status"
                ? PAL.stFrazzled
                : PAL.danger,
          incoming: intent.value,
          kind: intent.kind,
          ...(intent.status ? { status: intent.status } : {}),
        });
      }
    }
    threat?.set(links);
    // the open inspect card must not go stale behind a new declaration
    if (inspect.openId !== null) showInspect(inspect.openId);
  };

  /** Open (or re-render) the inspect card for an enemy — enemy-intel.md §3. */
  const showInspect = (id: string): void => {
    if (!bs || !ctx?.run) return;
    const c = bs.combatants.find((x) => x.id === id);
    if (!c || c.side !== "enemy" || !c.speciesId) return;
    const intel = knownIntel(ctx.meta, c.speciesId, ctx.run.floorNum);
    const intent = visibleIntent(c);
    const targetName =
      intent?.targetId !== undefined ? nameOf(intent.targetId) : null;
    inspect.show({
      combatant: c,
      intel,
      stand: standNameOf(c.id),
      intent,
      intentTargetName: targetName,
      targetable:
        targeting !== null &&
        targeting.targetIds.includes(id) &&
        phase === "targeting",
    });
  };

  const closeInspect = (): void => {
    inspect.show(null);
  };

  /* ---------------- battlefield build ---------------- */

  /**
   * The stage (visual-v3): a painted `scene:battle:<floor>` backdrop when
   * the art pack has one, a layered procedural stage when it doesn't, then
   * the grounded floor plane, the rank marks and the units. The old grey
   * placeholder moon + random silhouettes are gone for good.
   */
  const buildBattlefield = (run: { floorNum: number }): void => {
    if (!bgC || !worldC || !bs) return;

    stage = makeBattleStage(run.floorNum, {
      elite: params?.isElite === true,
    });
    bgC.addChild(stage.back);
    worldC.addChild(stage.ground);

    layOutFormation(bs.combatants);

    // YOUR HALF / THEIR HALF — the ground washes and the no-man's-land line.
    // Under everything else on the world layer so it never fights a sprite.
    const [catA, catB] = sideExtent(bs.combatants, "cat");
    const [foeA, foeB] = sideExtent(bs.combatants, "enemy");
    zones = makeFieldZones(catA, catB, foeA, foeB);
    worldC.addChild(zones.view);

    // rank marks: a recessed floor plate + numeral per slot
    const slots = new Graphics();
    const numerals = new Container();
    const addSlot = (side: "cat" | "enemy", rank: number): void => {
      const x = slotX(side, rank);
      const tint = side === "cat" ? PAL.energy : PAL.danger;
      slots
        .ellipse(x, R.combat.groundY, 38, 10)
        .fill({ color: PAL.void, alpha: 0.32 });
      slots
        .ellipse(x, R.combat.groundY, 38, 10)
        .stroke({ width: 1, color: tint, alpha: 0.16 });
      const n = label(String(rank), { size: TYPE.tiny, mono: true, dim: true });
      n.anchor.set(0.5, 0);
      n.alpha = 0.5;
      n.position.set(x, R.combat.groundY + 30);
      numerals.addChild(n);
    };
    // only OCCUPIED ranks get a plate — an empty "5" numeral on the floor of a
    // two-enemy fight reads as a missing unit
    const ranksOn = (side: "cat" | "enemy"): number =>
      bs?.combatants.reduce(
        (m, c) => (c.side === side ? Math.max(m, c.rank) : m),
        0,
      ) ?? 0;
    for (let r = 1; r <= ranksOn("cat"); r++) addSlot("cat", r);
    for (let r = 1; r <= ranksOn("enemy"); r++) addSlot("enemy", r);
    worldC.addChild(slots, numerals);

    // active-unit slot highlight (gold pulsing ellipse)
    activeSlot = new Graphics()
      .ellipse(0, 0, 38, 10)
      .stroke({ width: 3, color: PAL.gold });
    activeSlot.position.set(slotX("cat", 1), R.combat.groundY);
    activeSlot.visible = false;
    worldC.addChild(activeSlot);

    for (const c of bs.combatants) {
      const u = makeUnit(c);
      units.set(c.id, u);
      worldC.addChild(u.root);
    }

    // threat links ride above the units but below the HUD
    if (fxC) {
      threat = makeThreatLayer();
      fxC.addChild(threat.view);
    }
  };

  const buildHud = (): void => {
    if (!hudC || !modalC || !bs) return;
    // round chip
    roundChip = makeRoundChip();
    roundChip.view.position.set(rx(R.combat.roundChip), ry(R.combat.roundChip));
    hudC.addChild(roundChip.view);

    // turn-order strip
    ribbon.view.position.set(rx(R.combat.ribbon), ry(R.combat.ribbon));
    hudC.addChild(ribbon.view);

    // flee button — hidden in boss fights
    if (bs.canFlee) {
      const flee = makeFleeButton(() => tryFlee());
      flee.view.position.set(rx(R.combat.fleeChip), ry(R.combat.fleeChip));
      hudC.addChild(flee.view);
    }

    // log strip + line
    const strip = makeLogStrip();
    strip.position.set(rx(R.combat.logLine), ry(R.combat.logLine));
    strip.eventMode = "static";
    strip.cursor = "pointer";
    // the 26px-tall log strip is the tap equivalent of [L]
    padHit(strip, rw(R.combat.logLine), rh(R.combat.logLine));
    strip.on("pointertap", () => toggleScrollback());
    hudC.addChild(strip);
    logText = new BitmapText({
      text: "",
      style: { fontFamily: MONO_BITMAP, fontSize: 14 },
    });
    logText.tint = PAL.text;
    logText.position.set(
      rx(R.combat.logLine) + SPACE.md,
      ry(R.combat.logLine) + 5,
    );
    logText.eventMode = "static";
    logText.cursor = "pointer";
    logText.on("pointertap", () => toggleScrollback());
    hudC.addChild(logText);

    // skill bar + active panel
    skillBar.onSlot = (i) => onSlotPressed(i);
    hudC.addChild(skillBar.view);
    activePanel.view.position.set(
      rx(R.combat.activePanel),
      ry(R.combat.activePanel),
    );
    activePanel.set(null);
    hudC.addChild(activePanel.view);

    // the enemy inspect card (enemy-intel.md §3) — modal layer so it is never
    // painted over by a floater, but it lives in the LEFT gutter so the enemy
    // you tapped stays visible and tappable underneath
    modalC.addChild(inspect.view);

    // Cat Pile banner lives on the modal layer
    modalC.addChild(banner.view);

    // Tabletop layer: probe once per session, fire-and-forget. Reachable ⇒
    // the "[T] say what you do" chip and the card appear; unreachable ⇒ this
    // callback never fires and the battle screen is byte-identical to today.
    void probeDm().then((ok) => {
      if (!ok || !alive || !hudC || !modalC || tabletop) return;
      const chip = createTabletopChip(() => openTabletop());
      chip.view.position.set(rx(R.combat.roundChip), 54);
      hudC.addChild(chip.view);
      tabletopChip = chip.view;
      tabletop = createTabletopBar({
        // The default rect is vertically centred, which in a BATTLE lands the
        // card squarely across every combatant's head — you are asked what
        // you do while unable to see the board. Ride it up under the [T] chip
        // instead: the vault ceiling above the units is empty, so the typing
        // beat now leaves the whole field visible.
        rect: [(DESIGN_W - 760) / 2, 96, 760, 212],
        // The context, not the copy (run-map-and-dm.md §4b): the eyebrow,
        // placeholder and guidance are the shared component's `fight` mode.
        mode: "fight",
        onSubmit: (text) => submitImprovisation(text),
        onCancel: () => returnTurn(),
        onDismiss: () => returnTurn(),
        // Answering an interjection is an ordinary improvised turn: the card
        // reopens its own field and `submitImprovisation` takes it from there.
        // The callback's presence is what puts the Answer button on the card.
        onAnswer: () => clearTargeting(),
      });
      modalC.addChild(tabletop.view);
    });
  };

  /* ---------------- engine driving loop (§3.2) ---------------- */

  const enqueue = (events: BattleEvent[]): void => {
    anim.push(...events);
  };

  const afterDrain = (fn: () => void): void => {
    if (anim.length === 0 && holdMs <= 0) fn();
    else onDrained = fn;
  };

  const pump = (): void => {
    if (!alive || !bs || !rng || finished) return;
    if (bs.outcome !== "ongoing") {
      finish();
      return;
    }
    if (bs.catPilePrompt) {
      openPileBanner();
      return;
    }
    const actor = nextActor(bs);
    if (!actor) {
      const r = startRound(bs, rng);
      bs = r.state;
      log.push(...r.events);
      enqueue(r.events);
      afterDrain(pump);
      return;
    }
    if (actor.side === "enemy") {
      const action = takeEnemyTurn(actor, bs, rng);
      const r = resolveAction(bs, action, rng);
      bs = r.state;
      log.push(...r.events);
      enqueue(r.events);
      afterDrain(pump);
      return;
    }
    if (isAutoSkip(bs)) {
      // frazzled cat: the engine skips the slot whatever action is passed
      const r = resolveAction(bs, { type: "guard" }, rng);
      bs = r.state;
      log.push(...r.events);
      enqueue(r.events);
      afterDrain(pump);
      return;
    }
    enterInput(actor);
  };

  const resolvePlayer = (
    action: BattleAction | ImproviseAction,
    itemDefId?: string,
  ): void => {
    if (!bs || !rng || !ctx?.run) return;
    clearTargeting();
    closeFlyout();
    // The player acted instead of answering: the DM's unprompted line has had
    // its moment and must not hang over the animation.
    if (tabletop?.isInterjecting()) tabletop.close();
    phase = "anim";
    skillBar.set([null, null, null, null, null, null]);
    activePanel.set(null);
    let r: { state: BattleState; events: BattleEvent[] };
    try {
      r = resolveAction(bs, action, rng);
    } catch {
      // illegal per engine — bounce back to input
      const actor = nextActor(bs);
      if (actor) enterInput(actor);
      return;
    }
    bs = r.state;
    log.push(...r.events);
    if (itemDefId) {
      ctx.run.inventory = removeConsumable(ctx.run.inventory, itemDefId, 1).inv;
    }
    enqueue(r.events);
    afterDrain(pump);
  };

  /* ---------------- input phase ---------------- */

  const enterInput = (actor: Combatant): void => {
    if (!bs) return;
    phase = "input";
    legal = legalActions(bs);
    activePanel.set(actor);

    // Slots 1-4 ARE the progression engine's loadout: the combatant's
    // `skills` came from `activeSkills(cat, level)` at setup (buildSetup),
    // and `legalActions` walks that same list in order. The scene only
    // renders it — it never picks or reorders skills.
    const stand = standNameOf(actor.id);
    const slots: (SlotSpec | null)[] = [null, null, null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const opt = legal.skills[i];
      if (!opt) continue;
      let skill: Skill | undefined;
      try {
        skill = lookupSkill(opt.skillId);
      } catch {
        skill = undefined;
      }
      if (!skill) continue;
      const reason =
        opt.reason === "wrong rank"
          ? `Needs rank ${skill.usableFrom.join("–")} — ${actor.name} is at rank ${actor.rank}`
          : opt.reason;
      slots[i] = {
        kind: "skill",
        label: skill.name,
        skill,
        cost: skill.cost,
        ok: opt.ok,
        reason,
        ...(stand !== null ? { stand } : {}),
      };
    }
    slots[4] = { kind: "guard", label: "Guard", ok: legal.canGuard };
    const anyItem = listUsableItems().length > 0;
    slots[5] = {
      kind: "item",
      label: "Item",
      ok: anyItem,
      reason: "no usable items",
    };
    skillBar.set(slots);
    skillBar.setSelected(null);
  };

  /* ---------------- the tabletop layer (run-map-and-dm.md §3) ---------- */

  /**
   * Record one adjudication into the run log and autosave it. Every beat is
   * recorded — told, refused, and dropped-by-the-lint alike — so the run's
   * transcript is complete and survives a reload (§3 "Determinism & replay").
   */
  const recordBeat = (
    prompt: string,
    narration: string,
    allowed: boolean,
    effects: ImproviseAction["effects"],
    applied: boolean,
    problems: string[],
    energyCost: number,
    target: string | null,
  ): void => {
    if (!ctx?.run) return;
    ctx.run = withAdjudication(ctx.run as TabletopRun, {
      where: "combat",
      floor: ctx.run.floorNum,
      nodeId: ctx.run.currentNodeId,
      prompt,
      narration,
      allowed,
      effects,
      applied,
      problems,
      energyCost,
      target,
    });
    ctx.save();
  };

  /** Back to the skill bar with the turn untouched (nothing was spent). */
  const returnTurn = (): void => {
    improvising = false;
    if (!bs || finished) return;
    const actor = nextActor(bs);
    if (actor) enterInput(actor);
  };

  /**
   * One improvised turn. The DM's verdict is re-linted here before the engine
   * sees it (defence in depth, §3): a verdict that fails, or one the actor
   * cannot pay for, degrades to PURE NARRATION and costs nothing — only an
   * applied verdict spends the turn.
   */
  const submitImprovisation = (text: string): void => {
    if (!bs || !rng || !ctx?.run || !tabletop || improvising) return;
    const actorId = legal?.actorId;
    if (!actorId) return;
    improvising = true;
    phase = "anim"; // the skill bar goes quiet while the DM thinks
    skillBar.set([null, null, null, null, null, null]);
    tabletop.waiting(text);
    const floor = ctx.run.floorNum;

    void (async () => {
      const ensured = await ensureDmSession(ctx!.run as TabletopRun);
      if (!alive || !bs || !tabletop) return;
      if (!ensured) {
        dmWentQuiet(text);
        return;
      }
      ctx!.run = ensured.run;
      const res = await requestCombatVerdict(ensured.session, {
        state: bs,
        actorId,
        floor,
        prompt: text,
        onDelta: (_delta, soFar) => tabletop?.stream(soFar),
      });
      if (!alive || !bs || !tabletop || finished) return;
      if (!res) {
        dmWentQuiet(text);
        return;
      }
      ctx!.run = withDmSession(ctx!.run as TabletopRun, res.session);

      const check = validateCombatVerdict(res.data, floor);
      const verdict = check.verdict;
      if (!verdict) {
        dmWentQuiet(text);
        return;
      }
      const target = isLiveTarget(bs, verdict.target) ? verdict.target : null;
      const affordable = canAffordImprovisation(bs, actorId, verdict);
      const problems = [...check.problems];
      if (check.applied && !affordable) problems.push("not enough energy");
      const applied = check.applied && affordable && verdict.effects.length > 0;

      recordBeat(
        text,
        verdict.narration,
        verdict.allowed,
        verdict.effects,
        applied,
        problems,
        applied ? verdict.energyCost : 0,
        target,
      );

      if (!applied) {
        // A refusal is the DM saying no, in character — never an error. A
        // dropped verdict reads the same way from the player's chair: the
        // beat is narrated and the turn is handed straight back.
        tabletop.reply(verdict.narration, verdict.allowed ? "told" : "refused");
        return;
      }
      const action = improviseActionFor({ ...verdict, target }, floor);
      tabletop.close();
      improvising = false;
      resolvePlayer(action);
    })();
  };

  /** The DM did not answer. The moment passes; the turn is handed back. */
  const dmWentQuiet = (prompt: string): void => {
    const line = "The DM is elsewhere for a moment. Nothing comes of it.";
    markDmUnreachable();
    recordBeat(prompt, line, false, [], false, ["dm unreachable"], 0, null);
    tabletop?.reply(line, "quiet");
    if (tabletopChip) tabletopChip.visible = false;
  };

  const openTabletop = (): void => {
    if (phase !== "input" || improvising || !tabletop) return;
    clearTargeting();
    closeFlyout();
    // The inspect card lives in the LEFT gutter and the tabletop card is
    // centred over it, so leaving one open behind the other stacks two
    // panels with a hard overlap and the enemy's description running under
    // the DM's. Typing a line is a full-attention beat, like targeting and
    // the flyout above — clear the board for it.
    closeInspect();
    tabletop.open();
  };

  /* ------- presence: the DM interjects on its own (§4b) --------------- */

  /**
   * Is the board quiet enough to be interrupted? Only on the player's own
   * turn, with nothing else on the card — an interjection must never land
   * mid-animation, mid-targeting or over the Cat Pile banner.
   */
  const canShowInterjection = (): boolean =>
    alive &&
    !finished &&
    phase === "input" &&
    !improvising &&
    tabletop !== null &&
    !tabletop.isOpen();

  /** Where the fight is, in a line. Short: this is a spike, not a briefing. */
  const battleSituation = (): string => {
    if (!bs) return "A fight is in progress.";
    const side = (s: "cat" | "enemy"): string =>
      bs!.combatants
        .filter((c) => c.side === s && !c.ko)
        .map((c) => `${c.name} ${c.hp}/${c.stats.hp}`)
        .join(", ") || "nobody left standing";
    return (
      `Mid-fight, round ${bs.round}. Cats: ${side("cat")}. ` +
      `Against them: ${side("enemy")}.`
    );
  };

  /**
   * In a fight the DM narrates and nothing more: an interjection's effect
   * vocabulary is the OUT-OF-COMBAT one (`Effect`, not `EffectSpec`), and the
   * only thing allowed to touch a battle's numbers is the encounter subagent's
   * verdict going through `resolveAction`. So the twist is stripped here,
   * honestly, and the reason is recorded.
   */
  const narrationOnly = (i: Interjection): Interjection => ({
    ...i,
    effects: [],
    applied: false,
    problems:
      i.effects.length > 0
        ? [...i.problems, "in-combat interjections are narration only"]
        : i.problems,
  });

  /**
   * One authored spike. NEVER blocking: the budget is spent synchronously so
   * two spikes in one round cannot both slip through, the ask is fired and
   * forgotten, and the line renders if and when it lands — or is queued for
   * the run map, or is simply never seen. Offline, `planInterjection` refuses
   * before a single request is made.
   */
  const fireBeat = (beat: DmBeat): void => {
    if (!ctx?.run || !tabletop || finished) return;
    const plan = planInterjection(presenceOf(ctx.run as PresenceRun), [beat], {
      nowMs: Date.now(),
      floor: ctx.run.floorNum,
      available: isDmAvailable(),
    });
    if (!plan.beat) return;
    ctx.run = withBeatSpent(ctx.run as PresenceRun, plan.beat, Date.now());
    ctx.save();

    void (async () => {
      const res = await requestInterjection(ctx!.run as PresenceRun, {
        beat,
        situation: battleSituation(),
      });
      if (!res || !alive || !ctx?.run) return;
      ctx.run = withDmSession(ctx.run as TabletopRun, res.session);
      const flat = narrationOnly(res.interjection);
      const shown = canShowInterjection();
      ctx.run = withInterjectionRecorded(ctx.run as PresenceRun, {
        ...flat,
        floor: ctx.run.floorNum,
        nodeId: ctx.run.currentNodeId,
        delivered: shown,
      });
      // the board was busy; the run map delivers it when the party is out
      if (!shown)
        ctx.run = withQueuedInterjection(ctx.run as PresenceRun, flat);
      ctx.save();
      if (shown) tabletop?.interject(flat.narration, flat.invite);
    })();
  };

  const listUsableItems = (): { defId: string; count: number }[] => {
    if (!ctx?.run || !bs) return [];
    const counts = new Map<string, number>();
    for (const slot of ctx.run.inventory.slots) {
      if (isStack(slot)) {
        counts.set(slot.defId, (counts.get(slot.defId) ?? 0) + slot.count);
      }
    }
    const out: { defId: string; count: number }[] = [];
    for (const [defId, count] of counts) {
      if (!CONSUMABLES[defId]) continue;
      if (itemLegality(bs, defId).ok) out.push({ defId, count });
    }
    return out.slice(0, 3); // 3-row flyout (ui-art §8)
  };

  const onSlotPressed = (i: number): void => {
    if (phase !== "input" && phase !== "targeting") return;
    if (!bs || !legal) return;
    // Tapping the LIT slot backs out of targeting. Right-click and Esc both
    // cancel already, and neither exists on a phone; the selected card is the
    // control the finger is nearest (docs/design/mobile.md §1).
    if (phase === "targeting" && targeting?.slot === i) {
      clearTargeting();
      return;
    }
    clearTargeting();
    if (i === 4) {
      resolvePlayer({ type: "guard" });
      return;
    }
    if (i === 5) {
      toggleFlyout();
      return;
    }
    const opt = legal.skills[i];
    if (!opt?.ok) return;
    let skill: Skill;
    try {
      skill = lookupSkill(opt.skillId);
    } catch {
      return;
    }
    closeFlyout();
    // self / row skills fire immediately on confirm (ui-art §8 step 3)
    if (skill.target.side === "self") {
      resolvePlayer({ type: "skill", skillId: skill.id });
      return;
    }
    if (skill.target.pattern === "row") {
      startTargeting(skill, "skill", skill.id, opt.targetIds, i);
      return;
    }
    startTargeting(skill, "skill", skill.id, opt.targetIds, i);
  };

  /* ---------------- item flyout ---------------- */

  const toggleFlyout = (): void => {
    if (flyout) {
      closeFlyout();
      return;
    }
    if (!hudC) return;
    const items = listUsableItems();
    if (items.length === 0) return;
    flyoutItems = items.map((x) => x.defId);
    flyout = new Container();
    const top = skillBar.slotTop(5);
    const rowW = 240;
    const rowH = 36;
    items.forEach((item, i) => {
      const def = CONSUMABLES[item.defId];
      if (!def) return;
      const row = new Container();
      row.addChild(panel(rowW, rowH, { variant: "raised" }));
      const hk = makeHotkeyChip(String(i + 1), true);
      hk.view.position.set(SPACE.sm, (rowH - 16) / 2);
      row.addChild(hk.view);
      const icon = makeSpriteIcon(`item:${item.defId}`, 22);
      if (icon) {
        icon.position.set(38, rowH / 2);
        row.addChild(icon);
      } else {
        const glyph = label(def.icon, { size: TYPE.body, center: true });
        glyph.position.set(38, rowH / 2);
        row.addChild(glyph);
      }
      const name = label(`${def.name} ×${item.count}`, { size: TYPE.small });
      name.position.set(54, (rowH - 17) / 2);
      row.addChild(name);
      row.position.set(0, i * (rowH + 4));
      // 36 design px is 19 CSS px on a phone — the item rows are the smallest
      // committing control in the fight (docs/design/mobile.md §3).
      padHit(row, rowW, rowH);
      row.eventMode = "static";
      row.cursor = "pointer";
      row.on("pointertap", () => pickItem(item.defId));
      flyout?.addChild(row);
    });
    flyout.position.set(
      top.x - rowW / 2,
      top.y - items.length * (rowH + 4) - 8,
    );
    hudC.addChild(flyout);
  };

  const closeFlyout = (): void => {
    flyout?.destroy({ children: true });
    flyout = null;
    flyoutItems = [];
  };

  const pickItem = (defId: string): void => {
    if (!bs) return;
    const def = CONSUMABLES[defId];
    if (!def) return;
    const legality = itemLegality(bs, defId);
    if (!legality.ok) return;
    closeFlyout();
    const skill = def.battleSkill;
    if (skill.target.side === "self" || skill.target.pattern === "row") {
      resolvePlayer({ type: "item", itemId: defId }, defId);
      return;
    }
    startTargeting(skill, "item", defId, legality.targetIds, 5);
  };

  /* ---------------- targeting flow (ui-art §8) ---------------- */

  const startTargeting = (
    skill: Skill,
    action: "skill" | "item",
    refId: string,
    targetIds: string[],
    slotIndex: number,
  ): void => {
    if (targetIds.length === 0) return;
    phase = "targeting";
    skillBar.setSelected(slotIndex);
    targeting = { skill, action, refId, targetIds, idx: 0, slot: slotIndex };
    refreshTargeting();
  };

  const clearTargeting = (): void => {
    targeting = null;
    targetFx?.destroy({ children: true });
    targetFx = null;
    for (const u of units.values()) {
      u.root.alpha = u.dead ? 0 : 1;
      if (u.ring) {
        u.ring.destroy();
        u.ring = null;
      }
    }
    if (phase === "targeting") phase = "input";
    skillBar.setSelected(null);
  };

  const refreshTargeting = (): void => {
    if (!targeting || !bs || !fxC) return;
    targetFx?.destroy({ children: true });
    targetFx = new Container();
    fxC.addChild(targetFx);
    const actorId = legal?.actorId ?? null;
    const isRow = targeting.skill.target.pattern === "row";

    for (const u of units.values()) {
      const isTarget = targeting.targetIds.includes(u.id);
      // KO'd allies become visible ghosts while a revive skill targets them
      if (u.dead && !isTarget) continue;
      u.root.alpha = u.dead ? 0.5 : isTarget || u.id === actorId ? 1 : 0.6;
      if (isTarget && !u.ring) {
        u.ring = makeTargetRing();
        u.ring.position.set(0, 2);
        u.root.addChild(u.ring);
      } else if (!isTarget && u.ring) {
        u.ring.destroy();
        u.ring = null;
      }
    }

    const previewFor = (tid: string): void => {
      const u = unitOf(tid);
      if (!u || !bs || !actorId) return;
      const actor = byId(bs, actorId);
      const target = byId(bs, tid);
      const sk = targeting?.skill;
      if (!sk || !targetFx) return;
      // DAMAGE PREVIEW (enemy-intel.md §5): expected number, the ±10% roll
      // band around it, and the HP it would leave — so a shove combo can be
      // planned instead of discovered. Every number comes from the engine's
      // own `previewDamage`; the scene only formats it.
      if (sk.kind === "damage" && sk.power > 0) {
        const n = previewDamage(bs, sk.id, actorId, tid);
        const lo = Math.max(1, Math.round(n * 0.9));
        const hi = Math.max(lo, Math.round(n * 1.1));
        const chip = makeDamagePreview(n, lo, hi, {
          hpLeft: Math.max(0, target.hp - n),
          hpMax: target.stats.hp,
          lethal: n >= target.hp,
          ...(sk.moveTarget && shoveDamageMult(target, sk) !== 1
            ? {
                note:
                  shoveDamageMult(target, sk) > 1
                    ? "weak to shoves ×1.25"
                    : "shrugs off shoves ×0.8",
              }
            : {}),
        });
        chip.position.set(u.root.x, u.root.y + u.headY - 26);
        targetFx.addChild(chip);
      } else if (sk.kind === "heal" && sk.power > 0) {
        // display-only estimate: same "power% of atk" reading as the tooltip
        const n = roundHalfUp((sk.power / 100) * actor.stats.atk);
        const chip = makePreviewChip(`≈+${n}`, PAL.heal);
        chip.position.set(u.root.x, u.root.y + u.headY - 6);
        targetFx.addChild(chip);
      }
      // ghost shove arrow + destination Off-Balance / Poise preview
      if (sk.moveTarget) {
        const heavy = target.traits.includes("heavy");
        if (heavy) {
          if (
            target.poiseMax !== undefined &&
            hypotheticalDistance(target, sk.moveTarget) >= 1
          ) {
            const chip = makePreviewChip("◆-1", PAL.gold);
            chip.position.set(u.root.x, u.root.y + u.headY - 32);
            targetFx.addChild(chip);
          }
        } else {
          const dist = wouldMoveDistance(bs, target, sk.moveTarget);
          if (dist >= 1) {
            const destRank = target.rank + Math.sign(sk.moveTarget) * dist;
            const fromX = u.root.x;
            const toX = slotX(target.side, destRank);
            const g = new Graphics();
            drawGhostArrow(g, fromX, toX, R.combat.groundY - 64, PAL.offBal);
            targetFx.addChild(g);
            const ob = makeStatusPreviewChip("offBalance");
            ob.position.set(toX, R.combat.groundY - 80);
            targetFx.addChild(ob);
          }
        }
      }
    };

    if (isRow) {
      for (const tid of targeting.targetIds) previewFor(tid);
    } else {
      const tid = targeting.targetIds[targeting.idx];
      if (tid) previewFor(tid);
    }
  };

  const confirmTargeting = (): void => {
    if (!targeting) return;
    const t = targeting;
    if (t.skill.target.pattern === "row") {
      if (t.action === "skill") {
        resolvePlayer({ type: "skill", skillId: t.refId });
      } else {
        resolvePlayer({ type: "item", itemId: t.refId }, t.refId);
      }
      return;
    }
    const tid = t.targetIds[t.idx];
    if (!tid) return;
    if (t.action === "skill") {
      resolvePlayer({ type: "skill", skillId: t.refId, targetId: tid });
    } else {
      resolvePlayer({ type: "item", itemId: t.refId, targetId: tid }, t.refId);
    }
  };

  const cycleTarget = (dir: 1 | -1): void => {
    if (!targeting) return;
    const n = targeting.targetIds.length;
    targeting.idx = (targeting.idx + dir + n) % n;
    refreshTargeting();
  };

  /**
   * TAP TO INSPECT, TAP AGAIN TO TARGET (docs/design/mobile.md §2 — touch has
   * no hover, so every hover-only affordance needs a two-tap equivalent).
   *
   * First tap on an enemy opens its inspect card and, while targeting, makes
   * it the previewed target — you see the damage numbers and what you know
   * about it BEFORE committing. The second tap on the same enemy commits.
   * Away from targeting the second tap just closes the card.
   */
  const onUnitTap = (u: UnitView): void => {
    if (u.side === "enemy" && !u.dead) {
      const already = inspect.openId === u.id;
      if (phase === "targeting" && targeting?.targetIds.includes(u.id)) {
        if (already) {
          closeInspect();
          targeting.idx = targeting.targetIds.indexOf(u.id);
          confirmTargeting();
          return;
        }
        targeting.idx = targeting.targetIds.indexOf(u.id);
        refreshTargeting();
        showInspect(u.id);
        return;
      }
      if (already) closeInspect();
      else showInspect(u.id);
      return;
    }
    closeInspect();
    if (phase === "targeting" && targeting) {
      if (targeting.targetIds.includes(u.id)) {
        targeting.idx = targeting.targetIds.indexOf(u.id);
        confirmTargeting();
      }
      return;
    }
    if (phase === "input" && legal?.actorId && bs) {
      // clicking an adjacent cat = move-swap (ui-art §8)
      const actor = byId(bs, legal.actorId);
      if (u.side === "cat" && !u.dead && u.id !== actor.id) {
        const other = bs.combatants.find((x) => x.id === u.id);
        if (!other) return;
        if (other.rank === actor.rank - 1 && legal.canMoveForward) {
          resolvePlayer({ type: "move", dir: "forward" });
          return;
        }
        if (other.rank === actor.rank + 1 && legal.canMoveBack) {
          resolvePlayer({ type: "move", dir: "back" });
          return;
        }
      }
    }
    // A cat's nameplate is hover-only, and a cat has no inspect card, so on
    // touch a tap that could not move anybody toggles the plate instead —
    // otherwise the party's own names and levels are unreachable by finger
    // (docs/design/mobile.md §2).
    if (isTouch() && u.side === "cat" && !u.dead) toggleNameplate(u);
  };

  /** Show/hide a unit's hover nameplate. The touch path for §2. */
  const toggleNameplate = (u: UnitView): void => {
    if (u.nameplate) {
      u.nameplate.destroy({ children: true });
      u.nameplate = null;
      return;
    }
    if (!bs) return;
    const cc = bs.combatants.find((x) => x.id === u.id);
    if (!cc) return;
    for (const other of units.values()) {
      if (other.nameplate) {
        other.nameplate.destroy({ children: true });
        other.nameplate = null;
      }
    }
    u.nameplate = makeNameplate(cc);
    u.nameplate.position.set(0, u.headY - 46);
    u.root.addChild(u.nameplate);
  };

  const tryFlee = (): void => {
    if (phase !== "input" || !legal?.canFlee) return;
    resolvePlayer({ type: "flee" });
  };

  /* ---------------- Cat Pile ---------------- */

  const openPileBanner = (): void => {
    phase = "pile";
    banner.show(
      pileDamageEach,
      () => answerPile(true),
      () => answerPile(false),
    );
  };

  const answerPile = (accept: boolean): void => {
    if (phase !== "pile" || !bs || !rng) return;
    banner.hide();
    phase = "anim";
    const r = resolveAction(bs, { type: "catPile", accept }, rng);
    bs = r.state;
    log.push(...r.events);
    enqueue(r.events);
    afterDrain(pump);
  };

  /* ---------------- event animation ---------------- */

  const handleEvent = (e: BattleEvent): number => {
    switch (e.t) {
      case "roundStart": {
        roundChip?.set(e.round);
        if (bs) ribbon.setRound(bs);
        pushLog(`— round ${e.round} —`);
        return 280;
      }
      /* -- intel plumbing: state changes, not beats -----------------------
       * These three carry NO animation of their own — the badge, the strip
       * and the threat links repaint from `syncIntents`. Returning 0 keeps
       * them out of the pacing budget; the animator's `default: 80` would
       * otherwise cost ~240 ms of dead air per round with three enemies.
       */
      case "intent":
      case "intentBroken":
      case "intel":
        return 0;
      case "turnStart": {
        lastActorId = e.id;
        // rule §5: an enemy the party has never met telegraphs `?` — until it
        // acts once, at which point its whole species reads for this fight
        if (bs) {
          const c = bs.combatants.find((x) => x.id === e.id);
          if (c?.side === "enemy" && c.speciesId) actedSpecies.add(c.speciesId);
        }
        const u = unitOf(e.id);
        if (u && activeSlot) {
          activeSlot.visible = true;
          activeSlot.position.set(u.root.x, R.combat.groundY);
        }
        if (u && e.energyAfterRegen !== undefined) {
          u.energyNow = e.energyAfterRegen;
          u.energy?.set(e.energyAfterRegen);
        }
        if (bs) ribbon.refresh(bs);
        return 140;
      }
      case "damage": {
        const u = unitOf(e.id);
        lastHitWasCrit = e.crit;
        if (!u) return 100;
        // attack lunge (90ms out, 180ms back)
        const a = e.source !== "scratched" ? unitOf(lastActorId ?? "") : null;
        if (a && a.id !== u.id && !a.dead && e.source !== "catPile") {
          const dir = a.root.x < u.root.x ? 1 : -1;
          const homeX = slotX(a.side, a.rank);
          tween(a.root, { x: homeX + dir * 28 }, 90, "quadOut", () => {
            tween(a.root, { x: homeX }, 180, "quadOut");
          });
          // slight tilt into the attack, returning to any Off-Balance lean
          const baseRot = a.statuses.has("offBalance")
            ? (a.side === "cat" ? -1 : 1) * TILT
            : 0;
          tween(
            a.body,
            { rotation: baseRot + dir * ATTACK_TILT },
            90,
            "quadOut",
            () => {
              tween(a.body, { rotation: baseRot }, 180, "quadOut");
            },
          );
        }
        u.hpNow = Math.max(0, u.hpNow - e.amount);
        u.hpBar.set(u.hpNow, u.hpMax);
        // §4b beat: a cat one hit from going down. Rate-limited upstream.
        if (u.side === "cat" && u.hpNow > 0 && u.hpNow <= u.hpMax * 0.2) {
          fireBeat("nearDeath");
        }
        // hit flash + jitter + Stand-aura flash
        u.gfx.tint = 0xff9a9a;
        delay(90, () => {
          if (!u.gfx.destroyed) u.gfx.tint = 0xffffff;
        });
        u.aura.tint = e.crit ? PAL.gold : PAL.stFrazzled; // gold crit / spectral purple
        killTweens(u.aura);
        u.aura.alpha = e.crit ? 0.6 : 0.4;
        tween(u.aura, { alpha: 0 }, 280, "quadOut");
        tween(
          u.body,
          { x: (Math.random() < 0.5 ? -1 : 1) * 5 },
          60,
          "linear",
          () => {
            tween(u.body, { x: 0 }, 120);
          },
        );
        const txt = `${e.amount}${e.crit ? "!" : ""}${e.offBal ? "✶" : ""}`;
        floater(
          u.root.x,
          u.root.y + u.headY,
          txt,
          e.crit
            ? PAL.crit
            : e.source === "scratched"
              ? PAL.stScratched
              : PAL.text,
          e.crit ? 34 : e.source === "scratched" ? 22 : 26,
          e.crit,
        );
        if (e.crit && worldC && fxC) {
          shake(worldC, 5);
          shake(fxC, 5);
        }
        pushLog(
          e.source === "catPile"
            ? `Cat Pile! ${nameOf(e.id)} takes ${e.amount}.`
            : e.source === "scratched"
              ? `${nameOf(e.id)} bleeds for ${e.amount} (Scratched).`
              : `${announceSkill(lastActorId ?? "", e.source)} hits ${nameOf(
                  e.id,
                )} for ${e.amount}${
                  e.crit ? " — CRIT!" : ""
                }${e.offBal ? " (Off-Balance ✶)" : ""}`,
        );
        return 260;
      }
      case "heal": {
        const u = unitOf(e.id);
        if (!u) return 100;
        u.hpNow = Math.min(u.hpMax, u.hpNow + e.amount);
        u.hpBar.set(u.hpNow, u.hpMax);
        floater(u.root.x, u.root.y + u.headY, `+${e.amount}`, PAL.heal);
        const healStand =
          e.source !== "mending" ? standNameOf(lastActorId ?? "") : null;
        pushLog(
          healStand
            ? `「${healStand.toUpperCase()}」 mends ${nameOf(e.id)} for ${e.amount} HP.`
            : `${nameOf(e.id)} recovers ${e.amount} HP.`,
        );
        return 220;
      }
      case "moved": {
        const u = unitOf(e.id);
        if (!u) return 80;
        u.rank = e.to;
        tween(u.root, { x: slotX(u.side, e.to) }, 200, "quadOut");
        if (e.forced) {
          pushLog(`${nameOf(e.id)} is shoved to rank ${e.to}!`);
        }
        return 200; // corpse-slide exclusivity: nothing else plays during it
      }
      case "statusApplied": {
        const u = unitOf(e.id);
        if (!u) return 80;
        const prev = u.statuses.get(e.status) ?? { count: 0, value: 0 };
        u.statuses.set(e.status, {
          count: prev.count + 1,
          value:
            e.status === "mending"
              ? Math.max(prev.value, e.value)
              : prev.value + e.value,
        });
        rebuildStatusRow(u);
        if (e.status === "offBalance") {
          setTilt(u, true);
          floater(u.root.x, u.root.y + u.headY, "OFF-BALANCE!", PAL.offBal, 22);
        } else {
          const tag = e.status.replace(/([A-Z])/g, " $1").toUpperCase();
          const colors: Record<StatusId, number> = {
            scratched: PAL.stScratched,
            frazzled: PAL.stFrazzled,
            offBalance: PAL.stOffBal,
            guarded: PAL.stGuarded,
            provoked: PAL.stProvoked,
            mending: PAL.stMending,
            braced: PAL.stGuarded,
          };
          floater(u.root.x, u.root.y + u.headY, tag, colors[e.status], 22);
        }
        pushLog(`${nameOf(e.id)} is ${e.status}.`);
        return 220;
      }
      case "statusExpired":
      case "cleansed": {
        const u = unitOf(e.id);
        if (!u) return 60;
        const prev = u.statuses.get(e.status);
        if (prev && prev.count > 1) {
          u.statuses.set(e.status, {
            count: prev.count - 1,
            value: prev.value,
          });
        } else {
          u.statuses.delete(e.status);
        }
        rebuildStatusRow(u);
        if (e.status === "offBalance" && !u.statuses.has("offBalance")) {
          setTilt(u, false);
        }
        return 90;
      }
      case "energy": {
        const u = unitOf(e.id);
        if (u) {
          u.energyNow = Math.max(0, u.energyNow + e.delta);
          u.energy?.set(u.energyNow);
          if (e.delta > 0) {
            floater(
              u.root.x,
              u.root.y + u.headY,
              `+${e.delta}⚡`,
              PAL.energy,
              22,
            );
          }
        }
        return 70;
      }
      case "guard": {
        pushLog(`${nameOf(e.id)} guards (+2 energy).`);
        return 90;
      }
      case "poiseChip": {
        const u = unitOf(e.id);
        u?.poise?.set(e.left);
        if (worldC) shake(worldC, 3);
        floater(
          u?.root.x ?? DESIGN_W / 2,
          (u?.root.y ?? R.combat.groundY) + (u?.headY ?? HEAD_Y),
          "POISE",
          PAL.gold,
          22,
        );
        pushLog(`${nameOf(e.id)} is staggered — Poise ${e.left} left.`);
        return 200;
      }
      case "poiseBreak": {
        const u = unitOf(e.id);
        if (u && fxC) {
          // shockwave: expanding gold circle
          const wave = new Graphics();
          wave.position.set(u.root.x, u.root.y - 40);
          fxC.addChild(wave);
          const drv = { r: 20, w: 6, a: 1 };
          const redraw = (): void => {
            wave
              .clear()
              .circle(0, 0, drv.r)
              .stroke({ width: Math.max(1, drv.w), color: PAL.gold });
            wave.alpha = drv.a;
          };
          redraw();
          const tick = { t: 0 };
          tween(tick, { t: 1 }, 400, "quadOut", () => {
            wave.destroy();
          });
          const step = (): void => {
            if (wave.destroyed) return;
            drv.r = 20 + 70 * tick.t;
            drv.w = 6 - 5 * tick.t;
            drv.a = 1 - tick.t;
            redraw();
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          u.poise?.set(u.poise.max); // engine resets Poise after the break
        }
        if (worldC && fxC) {
          shake(worldC, 5);
          shake(fxC, 5);
        }
        pushLog(`POISE BREAK! ${nameOf(e.id)} is wide open!`);
        return 333;
      }
      case "catPilePrompt": {
        pileDamageEach = e.damageEach;
        pushLog(`Every enemy is Off-Balance — CAT PILE for ${e.damageEach}?`);
        return 0;
      }
      case "catPile": {
        // dust cloud with paws sticking out; cats blink out/in
        if (fxC) {
          const cloud = new Container();
          const cxs = e.targets
            .map((id) => unitOf(id)?.root.x ?? 0)
            .filter((x) => x > 0);
          const cx =
            cxs.length > 0 ? cxs.reduce((a, b) => a + b, 0) / cxs.length : 944;
          cloud.position.set(cx, R.combat.groundY - 40);
          for (let i = 0; i < 5; i++) {
            const r = 24 + Math.random() * 16;
            const c = new Graphics()
              .circle((Math.random() - 0.5) * 90, (Math.random() - 0.5) * 40, r)
              .fill({ color: PAL.textDim, alpha: 0.5 });
            cloud.addChild(c);
          }
          for (let i = 0; i < 2; i++) {
            const s = new Text({
              text: "✶",
              style: mono(20, { fill: PAL.offBal }),
            });
            s.anchor.set(0.5);
            s.position.set(
              (Math.random() - 0.5) * 100,
              (Math.random() - 0.5) * 60,
            );
            cloud.addChild(s);
          }
          fxC.addChild(cloud);
          for (const u of units.values()) {
            if (u.side === "cat" && !u.dead) {
              u.root.alpha = 0;
              delay(650, () => {
                if (!u.dead) tween(u.root, { alpha: 1 }, 120);
              });
            }
          }
          delay(700, () => {
            tween(cloud, { alpha: 0 }, 150, "linear", () => {
              cloud.destroy({ children: true });
            });
            if (worldC && fxC) {
              shake(worldC, 8);
              shake(fxC, 8);
            }
          });
        }
        pushLog(`CAT PILE! Everyone piles on for ${e.damageEach} each!`);
        fireBeat("catPile"); // §4b beat
        return 333;
      }
      case "ko": {
        const u = unitOf(e.id);
        if (u) {
          u.dead = true;
          u.statuses.clear();
          u.intent?.set(null);
          if (inspect.openId === e.id) closeInspect();
          rebuildStatusRow(u);
          setTilt(u, false);
          killTweens(u.body.scale);
          tween(u.body.scale, { y: 0.15 }, 120, "quadOut", () => {
            tween(u.root, { alpha: 0 }, 150);
          });
          if (fxC) {
            for (let i = 0; i < 4; i++) {
              const p = new Graphics()
                .circle(0, 0, 8)
                .fill({ color: PAL.textDim, alpha: 0.8 });
              p.position.set(u.root.x, u.root.y - 20);
              fxC.addChild(p);
              const a = (i / 4) * Math.PI * 2;
              tween(
                p,
                {
                  x: u.root.x + Math.cos(a) * 34,
                  y: u.root.y - 20 + Math.sin(a) * 24,
                  alpha: 0,
                },
                250,
                "quadOut",
                () => p.destroy(),
              );
            }
          }
          if (worldC) shake(worldC, 3);
        }
        if (bs) ribbon.refresh(bs);
        pushLog(`${nameOf(e.id)} is knocked out!`);
        // §4b beat: a cat going down is a spike; an enemy going down is Tuesday
        if (u?.side === "cat") fireBeat("ko");
        return 300;
      }
      case "revive": {
        const u = unitOf(e.id);
        if (u && bs) {
          const c = bs.combatants.find((x) => x.id === e.id);
          u.dead = false;
          u.hpNow = e.hp;
          u.hpBar.set(u.hpNow, u.hpMax, false);
          u.rank = c?.rank ?? u.rank;
          u.root.position.x = slotX(u.side, u.rank);
          u.body.scale.set(1);
          tween(u.root, { alpha: 1 }, 200);
          floater(u.root.x, u.root.y + u.headY, "REVIVED!", PAL.heal, 22);
        }
        pushLog(`${nameOf(e.id)} is back on their paws!`);
        return 250;
      }
      case "lifeLost": {
        pushLog(`${nameOf(e.id)} loses a Life (${e.livesLeft} left)…`);
        return 150;
      }
      case "lifeSaved": {
        pushLog(`The Ninth Bell cracks — ${nameOf(e.id)}'s Life is saved!`);
        return 150;
      }
      case "phaseChange": {
        const u = unitOf(e.id);
        if (u) {
          u.gfx.tint = 0xffd2a0; // phase-2 accent recolor
          if (worldC && fxC) {
            shake(worldC, 5);
            shake(fxC, 5);
          }
        }
        return 300;
      }
      case "charging": {
        const u = unitOf(e.id);
        if (u && worldC) {
          u.charge = makeChargeMark();
          u.charge.view.position.set(0, u.headY - 40);
          u.root.addChild(u.charge.view);
          u.flood = makeRankFlood(e.ranks.map((r) => slotX("cat", r)));
          worldC.addChild(u.flood);
        }
        pushLog(e.text);
        return 300;
      }
      case "chargeCancelled": {
        const u = unitOf(e.id);
        if (u) {
          u.charge?.view.destroy({ children: true });
          u.charge = null;
          u.flood?.destroy();
          u.flood = null;
        }
        pushLog(`${nameOf(e.id)}'s charge fizzles!`);
        return 150;
      }
      case "summon": {
        if (bs && worldC) {
          const c = bs.combatants.find((x) => x.id === e.id);
          if (c && !units.has(c.id)) {
            const u = makeUnit(c);
            u.rank = e.rank;
            u.root.position.x = slotX("enemy", e.rank);
            u.root.alpha = 0;
            tween(u.root, { alpha: 1 }, 200);
            units.set(c.id, u);
            worldC.addChild(u.root);
          }
        }
        pushLog(`${nameOf(e.id)} joins the fight at rank ${e.rank}!`);
        return 250;
      }
      case "traitTriggered": {
        const u = unitOf(e.id);
        if (u) {
          floater(u.root.x, u.root.y + u.headY, e.trait, PAL.gold, 22);
        }
        return 150;
      }
      case "fleeAttempt": {
        pushLog(
          e.ok
            ? "Scatter! The clowder slips away…"
            : `Scatter fails (${Math.round(e.chance * 100)}%) — turn wasted!`,
        );
        if (!e.ok) {
          const u = unitOf(lastActorId ?? "");
          if (u)
            floater(u.root.x, u.root.y + u.headY, "FAILED!", PAL.danger, 22);
        }
        return 250;
      }
      case "victory": {
        pushLog("Victory! The alley is quiet again.");
        // §4b beat: "a crit that ends a fight". The card is almost certainly
        // gone by the time this lands, so it queues for the run map.
        if (lastHitWasCrit) fireBeat("finishingCrit");
        return 300;
      }
      case "defeat": {
        pushLog("The clowder falls…");
        return 300;
      }
      case "fled": {
        pushLog("Fled — no loot, no shame.");
        return 250;
      }
      case "log": {
        pushLog(e.text);
        return 150;
      }
      default:
        return 80;
    }
  };

  /* ---------------- scrollback ---------------- */

  const toggleScrollback = (): void => {
    if (scrollPanel) {
      scrollPanel.destroy({ children: true });
      scrollPanel = null;
      return;
    }
    if (!modalC) return;
    scrollOffset = 0;
    scrollPanel = new Container();
    const [sx, sy, sw, sh] = R.combat.logScrollback;
    scrollPanel.addChild(panel(sw, sh, { variant: "raised" }));
    const title = heading("BATTLE LOG", 3);
    title.position.set(SPACE.md, SPACE.sm);
    scrollPanel.addChild(title);
    const txt = new Text({
      text: "",
      style: mono(12, { fill: PAL.textDim, lineHeight: 16 }),
    });
    txt.position.set(SPACE.md, 30);
    scrollPanel.addChild(txt);
    const render = (): void => {
      const perPage = Math.floor((sh - 38) / 16);
      const start = Math.max(0, logLines.length - perPage - scrollOffset);
      txt.text = logLines.slice(start, start + perPage).join("\n");
    };
    render();
    scrollPanel.eventMode = "static";
    scrollPanel.on("wheel", (ev) => {
      scrollOffset = Math.max(
        0,
        Math.min(logLines.length, scrollOffset + (ev.deltaY > 0 ? -2 : 2)),
      );
      render();
    });
    scrollPanel.position.set(sx, sy);
    modalC.addChild(scrollPanel);
  };

  /* ---------------- battle end ---------------- */

  const finish = (): void => {
    if (finished || !ctx?.run || !bs || !params) return;
    finished = true;
    phase = "done";
    if (activeSlot) activeSlot.visible = false;
    const run = ctx.run;
    const result = battleResult(bs, log);

    // THE BESTIARY WRITE (enemy-intel.md §4). Knowledge is earned by fighting,
    // not by surviving, so this runs before the win/lose/flee branches: a
    // battle you ran from still taught you what hit you. `recordBattle` reads
    // the log only — the scene never decides what was learned.
    ctx.meta = recordBattle(ctx.meta, bs, log);
    saveMeta(ctx.meta);

    if (result.outcome === "fled") {
      // A fled node fight simply hands the route back: the node is already
      // marked resolved by the run map, so the party walks on without loot
      // (and the stairs guard, if that is what they ran from, stays put).
      ctx.save(); // autosave: successful flee (gameloop §9)
      delay(450, () => ctx?.scenes.goto("runMap"));
      return;
    }

    if (result.outcome === "defeat") {
      // 1.5s "the clowder scatters…" beat (gameloop §6)
      if (modalC) {
        const veil = new Graphics()
          .rect(0, 0, DESIGN_W, DESIGN_H)
          .fill({ color: PAL.void, alpha: 0.5 });
        veil.alpha = 0;
        modalC.addChild(veil);
        tween(veil, { alpha: 1 }, 600);
        const beat = heading("the clowder scatters…", 1, {
          fill: PAL.danger,
          center: true,
        });
        beat.position.set(DESIGN_W / 2, DESIGN_H / 2 - 60);
        beat.alpha = 0;
        modalC.addChild(beat);
        tween(beat, { alpha: 1 }, 400);
      }
      const bossName = isBoss ? ENEMIES[params.enemies[0] ?? ""]?.name : null;
      const cause = bossName
        ? `slain by ${bossName} on floor ${run.floorNum}`
        : `overwhelmed on floor ${run.floorNum}`;
      delay(1500, () => ctx?.scenes.goto("results", { victory: false, cause }));
      return;
    }

    // ---- victory ----
    const xpBefore = run.xp;
    const levelBefore = run.level;
    const livesLost = log
      .filter(
        (e): e is Extract<BattleEvent, { t: "lifeLost" }> => e.t === "lifeLost",
      )
      .map((e) => {
        const c = bs?.combatants.find((x) => x.id === e.id);
        return {
          classId: (c?.classId ?? "bruiser") as ClassId,
          livesLeft: e.livesLeft,
        };
      });
    const out = applyBattleResult(run, result, params.nodeId);
    ctx.run = out.run;
    const runWon = result.bossDefeated && out.run.floorNum >= FLOORS.length;
    const after = (): void => {
      if (!ctx) return;
      if (runWon) ctx.scenes.goto("results", { victory: true });
      else ctx.scenes.goto("runMap");
    };

    if (params.lootMode === "none" && !params.eventWin) {
      ctx.save();
      delay(600, after);
      return;
    }

    // victory loot stream (§4): hash(runSeed, floor, 'loot', 100+encounterIdx)
    const vrng = mulberry32(
      hash(run.runSeed, run.floorNum, "loot", 100 + params.encounterIndex),
    );
    const lctx: LootCtx = {
      floor: run.floorNum,
      livingClasses: out.run.cats
        .filter((c) => c.lives > 0)
        .map((c) => c.classId),
      uniquesDropped: out.run.uniquesDropped,
      nextUid: out.run.inventory.nextUid,
      currentShinies: out.run.inventory.shinies,
    };
    const grant =
      params.lootMode === "none"
        ? { shinies: 0, equips: [], consumables: [] }
        : isBoss
          ? rollBossLoot(vrng, lctx)
          : params.lootMode === "bonus"
            ? rollChest(vrng, lctx) // 'bonus' = chest-table roll (events.md §1)
            : rollVictory(vrng, lctx);
    const lootParams: LootOverlayParams = {
      variant: isBoss ? "boss" : "victory",
      grant,
      xpBefore,
      levelBefore,
      livesLost,
      eventWin: params.eventWin,
      extraLines: out.died.map((id) => ({
        text: `${CLASSES[id].catName} is out of Lives — gone for good.`,
        tone: "loss" as const,
      })),
      onClosed: after,
    };
    delay(600, () => ctx?.scenes.pushOverlay("loot", lootParams));
  };

  /* ---------------- setup from run (gameloop §1: BATTLE reads RunState) -- */

  const buildSetup = (): BattleSetup | null => {
    if (!ctx?.run || !params) return null;
    const run = ctx.run;
    const cats: BattleSetup["cats"] = [];
    for (const classId of run.marchingOrder) {
      const cat = run.cats.find((c) => c.classId === classId);
      if (!cat || cat.lives <= 0) continue;
      const stats = effectiveStats(cat, run.level);
      const cls = CLASSES[classId];
      const tier = traitTier(classId, run.level);
      const traits = tier >= 2 ? [cls.trait.id, cls.trait.id] : [cls.trait.id];
      const hooks: MewHookId[] = [];
      for (const item of [cat.weapon, cat.trinket, cat.collar]) {
        if (item?.hook && !item.hookSpent) hooks.push(item.hook);
      }
      cats.push({
        classId,
        name: cls.catName,
        stats,
        hp: Math.min(cat.hp, stats.hp),
        lives: cat.lives,
        skills: activeSkills(cat, run.level),
        traits,
        hooks,
        startEnergyBonus: cat.energyNextBattle,
      });
    }
    // Stand Powers (stand-powers.md, opt-in per battle): attach the stock
    // scripts for every cat and any enemy that has one, keyed by the
    // combatant ids createBattle will mint. The engine's budget lint
    // re-validates at setup; power triggers announce themselves through
    // the existing 「STAND」 log-line pattern — no extra UI handling.
    const powers: Record<string, PowerScript> = {};
    for (const cat of cats) {
      const p = CAT_POWERS[cat.classId];
      if (p) powers[`cat:${cat.classId}`] = p;
    }
    params.enemies.forEach((enemyId, i) => {
      const p = ENEMY_POWERS[enemyId];
      if (p) powers[`e${i}:${enemyId}`] = p;
    });
    const setup: PoweredBattleSetup = {
      cats,
      enemies: params.enemies,
      encounterIndex: params.encounterIndex,
      canFlee: !isBoss,
    };
    if (Object.keys(powers).length > 0) setup.powers = powers;

    // Stand resonance (stand-powers.md Layer 3): for every cross-side power
    // pair, an already-cached compiled rule attaches to THIS battle as an
    // extra power of the cat in the pair; uncached pairs kick a
    // fire-and-forget compile whose rule applies from the NEXT battle.
    // Nothing is awaited — zero latency, and offline nothing happens.
    const interactions: AttachedInteraction[] = [];
    const attached = new Set<string>();
    for (const [catId, catPower] of Object.entries(powers)) {
      if (!catId.startsWith("cat:")) continue;
      for (const [enemyCid, enemyPower] of Object.entries(powers)) {
        if (enemyCid.startsWith("cat:")) continue;
        const key = resonancePairKey(
          catPower.id,
          enemyPower.id,
          catPower.version,
        );
        const cached = getCachedResonance(key);
        if (cached === undefined) {
          prefetchResonance(catPower, enemyPower);
          continue;
        }
        if (!cached.rule) continue; // definitive "no resonance"
        const dedupe = `${catId}|${key}`; // two same-species enemies = one rule
        if (attached.has(dedupe)) continue;
        attached.add(dedupe);
        interactions.push({ ownerId: catId, rule: cached.rule });
        if (!announcedResonances.has(key) && cached.announce) {
          announcedResonances.add(key);
          pendingAnnounce.push(cached.announce);
        }
      }
    }
    if (interactions.length > 0) setup.interactions = interactions;
    return setup;
  };

  /* ---------------- resonance discovery banner ---------------- */

  /** Announce lines queued by buildSetup for this battle's banner. */
  const pendingAnnounce: string[] = [];

  /**
   * One-time "STAND RESONANCE DISCOVERED" banner (Cat Pile banner pattern:
   * gold-stroked panel on the modal layer). Purely visual and non-blocking:
   * it slides in over the opening round and fades out by itself — the
   * engine pump is never held up.
   */
  const showResonanceBanner = (lines: string[]): void => {
    if (!modalC || lines.length === 0) return;
    const [bx, by, bw] = R.combat.catPileBanner;
    const bh = 64 + lines.length * 26;
    const view = new Container();
    view.addChild(panel(bw, bh, { variant: "raised", accent: PAL.gold }));
    const title = heading("STAND RESONANCE DISCOVERED", 2, {
      fill: PAL.gold,
      center: true,
    });
    title.anchor.set(0.5, 0);
    title.position.set(bw / 2, 12);
    view.addChild(title);
    lines.forEach((line, i) => {
      const t = label(line.replace(/^STAND RESONANCE DISCOVERED:\s*/, ""), {
        size: TYPE.small,
        dim: true,
        wrap: bw - 40,
        align: "center",
        center: true,
      });
      t.anchor.set(0.5, 0);
      t.position.set(bw / 2, 50 + i * 26);
      view.addChild(t);
    });
    view.position.set(bx, by - 60);
    view.alpha = 0;
    modalC.addChild(view);
    tween(view, { y: by, alpha: 1 }, 200, "backOut");
    delay(3000, () => {
      tween(view, { y: by - 30, alpha: 0 }, 220, "quadOut", () => {
        view.destroy({ children: true });
      });
    });
  };

  /* ---------------- Scene contract ---------------- */

  return {
    mount(root: Container, gameCtx: GameCtx, rawParams?: unknown): void {
      ctx = gameCtx;
      alive = true;
      params = (rawParams ?? null) as BattleSceneParams | null;
      if (!params || !ctx.run) {
        // driver bug — nothing to fight; bail to explore next frame
        delay(0, () => ctx?.scenes.goto("runMap"));
        return;
      }
      // DEV-only staging hook (sibling of main.ts's `?smoke=battle`): let a
      // screenshot harness dictate the enemy line-up, so stage composition can
      // be checked at 1 boss and at 5 minions without playing a whole floor.
      // Stripped from production builds by the import.meta.env.DEV guard.
      if (import.meta.env?.DEV === true) {
        const q = new URLSearchParams(window.location.search);
        const foes = q.get("foes");
        if (foes !== null && foes !== "") {
          params = { ...params, enemies: foes.split(",") as EnemyId[] };
        }
        // `?party=4` fields a full clowder even though a run now STARTS with
        // two (balance-and-meta.md §2), so the widest formation is testable.
        const n = Number(q.get("party"));
        if (Number.isFinite(n) && n >= 1) {
          ctx.run.marchingOrder = ctx.run.cats
            .map((c) => c.classId)
            .slice(0, n);
        }
        // `?known=met|complete` fakes Bestiary progress so the intel UI can be
        // screenshotted at every knowledge level without grinding five kills
        // per species. Writes only the IN-MEMORY profile — never saved.
        const known = q.get("known");
        if (known === "met" || known === "complete") {
          const bestiary: Record<string, EnemyKnowledge> = {
            ...(ctx.meta.bestiary ?? {}),
          };
          for (const id of params.enemies) {
            bestiary[id] = {
              met: 3,
              kills: known === "complete" ? KILLS_TO_COMPLETE : 1,
              skills: [],
              weak: [],
              resist: [],
            };
          }
          ctx.meta = { ...ctx.meta, bestiary };
        }
      }
      isBoss = params.isBoss ?? params.encounterIndex === 0;

      pendingAnnounce.length = 0;
      const setup = buildSetup();
      if (!setup || setup.cats.length === 0) {
        delay(0, () => ctx?.scenes.goto("runMap"));
        return;
      }
      bs = createBattle(setup);
      // Dev/CI observability hook, read-only and DEV-only (sibling of
      // main.ts's `__scene`/`__run`): lets a screenshot harness wait until
      // the telegraphs are actually readable instead of guessing from
      // pixels. Never shipped — stripped by the import.meta.env.DEV guard.
      if (import.meta.env?.DEV === true) {
        (window as unknown as { __battle?: () => unknown }).__battle = () => bs;
        // Where each unit actually STANDS, in design px. The formation is
        // computed per battle from the headcounts (see STAGE COMPOSITION), so
        // a touch smoke cannot guess an enemy's x from a constant — and
        // "tap the enemy" is the interaction docs/design/mobile.md §2 exists
        // to prove. DEV-only, like `__battle` itself.
        (window as unknown as { __units?: () => unknown }).__units = () =>
          [...units.values()].map((u) => ({
            id: u.id,
            side: u.side,
            x: u.root.x,
            y: u.root.y,
            headY: u.headY,
            dead: u.dead,
          }));
      }
      // battleRng stream (§4): re-engaging a fled pack restarts the stream
      rng = mulberry32(
        hash(ctx.run.runSeed, ctx.run.floorNum, params.encounterIndex),
      );

      bgC = new Container();
      worldC = new Container();
      fxC = new Container();
      hudC = new Container();
      floatC = new Container();
      modalC = new Container();
      layer(root, "bg").addChild(bgC);
      layer(root, "world").addChild(worldC);
      layer(root, "fx").addChild(fxC);
      layer(root, "hud").addChild(hudC);
      layer(root, "floaters").addChild(floatC);
      layer(root, "modal").addChild(modalC);

      buildBattlefield(ctx.run);
      buildHud();
      showResonanceBanner(pendingAnnounce);

      // right-click anywhere cancels targeting
      const catcher = new Graphics()
        .rect(0, 0, DESIGN_W, DESIGN_H)
        .fill({ color: 0x000000, alpha: 0.0001 });
      catcher.eventMode = "static";
      catcher.on("rightdown", () => {
        if (phase === "targeting") clearTargeting();
      });
      bgC.addChild(catcher);

      phase = "anim";
      pump();
    },

    unmount(): void {
      alive = false;
      finished = true;
      anim.length = 0;
      onDrained = null;
      if (import.meta.env?.DEV === true) {
        delete (window as unknown as { __battle?: () => unknown }).__battle;
        delete (window as unknown as { __units?: () => unknown }).__units;
      }
      // the tabletop card owns a DOM <input>: it must go before the pixi
      // layers below it are destroyed (and before the element is orphaned)
      tabletop?.destroy();
      tabletop = null;
      for (const c of [bgC, worldC, fxC, hudC, floatC, modalC]) {
        if (c) {
          c.parent?.removeChild(c);
          c.destroy({ children: true });
        }
      }
      tabletopChip = null;
      improvising = false;
      bgC = worldC = fxC = hudC = floatC = modalC = null;
      stage = null;
      zones = null;
      threat = null;
      actedSpecies.clear();
      intentSig = "";
      roundChip = null;
      logText = null;
      activeSlot = null;
      units.clear();
      logLines.length = 0;
      log.length = 0;
      scrollPanel = null;
      flyout = null;
      targetFx = null;
      targeting = null;
      bs = null;
      rng = null;
    },

    update(dtMs: number): void {
      if (!alive) return;
      elapsed += dtMs;
      tabletop?.update(dtMs);

      // drain the animation queue at ≥3 events/s (hold cap 333ms)
      holdMs -= dtMs;
      while (holdMs <= 0 && anim.length > 0) {
        const e = anim.shift();
        if (!e) break;
        holdMs = Math.min(333, handleEvent(e));
      }
      if (anim.length === 0 && holdMs <= 0 && onDrained) {
        const fn = onDrained;
        onDrained = null;
        fn();
      }

      // stage: backdrop parallax drift + stage-light breathing (the backdrop
      // is NOT shaken with the world layer — that difference IS the parallax)
      stage?.update(elapsed);
      zones?.update(elapsed);

      // telegraphs repaint from the engine's own declarations; the call diffs
      // a signature first, so a frame with nothing new costs a string compare
      syncIntents();
      threat?.update(elapsed);
      ribbon.update(elapsed);
      for (const u of units.values()) u.intent?.update(elapsed);

      // ambience: idle bob + breathing, star orbits, slot pulse, charge bounce
      const t = elapsed / 1000;
      for (const u of units.values()) {
        if (u.dead) continue;
        const bob = Math.sin((t * Math.PI * 2) / 1.6 + u.bobPhase);
        u.body.y = bob * 2;
        // slow breathing: ±1.5% vertical scale, slight inverse horizontal
        const br = Math.sin((t * Math.PI * 2) / 2.8 + u.bobPhase) * BREATH_AMP;
        u.body.scale.y = 1 + br;
        u.body.scale.x = 1 - br * 0.5;
        // the contact shadow tightens as the unit rises: the tell that the
        // sprite is standing ON the floor plane rather than floating over it
        const lift = 1 - bob * 0.05;
        u.shadow.scale.set(lift, lift);
        u.shadow.alpha = 0.75 + 0.25 * lift;
        u.presence?.update(elapsed);
        if (u.stars.visible) {
          u.stars.children.forEach((star, i) => {
            const a = t * 0.8 * Math.PI * 2 + (i * Math.PI * 2) / 3;
            star.position.set(Math.cos(a) * 22, Math.sin(a) * 8);
          });
        }
        u.charge?.update(elapsed);
        if (u.ring) u.ring.alpha = 0.6 + 0.4 * Math.sin(t * Math.PI * 4);
      }
      if (activeSlot?.visible) {
        activeSlot.alpha = 0.5 + 0.5 * Math.abs(Math.sin((t * Math.PI) / 0.8));
      }
    },

    onKey(key: string): boolean {
      if (!alive || !bs) return false;

      // The tabletop card owns the keyboard while it is up. While typing the
      // DOM field swallows everything itself; what reaches here is the reply
      // beat, where any confirm key dismisses it and hands the turn back —
      // or an unprompted beat, where [T] answers it instead of ignoring it
      // (run-map-and-dm.md §4b: an interjection is never a cutscene).
      if (tabletop?.isOpen()) {
        if (key === "t" && tabletop.isInterjecting()) {
          tabletop.open();
          return true;
        }
        if (
          key === "e" ||
          key === "enter" ||
          key === "space" ||
          key === "esc"
        ) {
          tabletop.close();
          returnTurn();
        }
        return true;
      }

      if (scrollPanel) {
        if (key === "esc" || key === "l") toggleScrollback();
        return true;
      }
      if (key === "l") {
        toggleScrollback();
        return true;
      }

      // [I] inspect: opens the card for the enemy you are aiming at, or for
      // the front-rank enemy when nothing is selected. Esc closes it first,
      // before it would cancel targeting or reach the pause menu.
      if (key === "i") {
        if (inspect.openId !== null) closeInspect();
        else {
          const aimed =
            targeting?.targetIds[targeting.idx] ??
            (bs
              ? bs.combatants
                  .filter((c) => c.side === "enemy" && !c.ko && c.hp > 0)
                  .sort((a, b) => a.rank - b.rank)[0]?.id
              : undefined);
          if (aimed !== undefined) showInspect(aimed);
        }
        return true;
      }
      if (key === "esc" && inspect.openId !== null) {
        closeInspect();
        return true;
      }

      if (phase === "pile") {
        if (key === "enter") answerPile(true);
        else if (key === "esc") answerPile(false);
        return true;
      }

      if (phase === "targeting") {
        if (key === "esc") {
          clearTargeting();
          return true;
        }
        if (key === "left") {
          cycleTarget(-1);
          return true;
        }
        if (key === "right") {
          cycleTarget(1);
          return true;
        }
        if (key === "enter" || key === "space") {
          confirmTargeting();
          return true;
        }
        if (/^[1-6]$/.test(key)) {
          onSlotPressed(Number(key) - 1);
          return true;
        }
        return true;
      }

      if (phase === "input") {
        if (flyout) {
          if (key === "esc") {
            closeFlyout();
            return true;
          }
          if (/^[1-3]$/.test(key)) {
            const defId = flyoutItems[Number(key) - 1];
            if (defId) pickItem(defId);
            return true;
          }
        }
        if (/^[1-6]$/.test(key)) {
          onSlotPressed(Number(key) - 1);
          return true;
        }
        if (key === "r") {
          tryFlee();
          return true;
        }
        if (key === "t" && tabletop) {
          openTabletop();
          return true;
        }
        if (key === "right" && legal?.canMoveForward) {
          resolvePlayer({ type: "move", dir: "forward" });
          return true;
        }
        if (key === "left" && legal?.canMoveBack) {
          resolvePlayer({ type: "move", dir: "back" });
          return true;
        }
        // Esc falls through → pause is allowed ONLY in the input phase
        return false;
      }

      // anim/done: swallow everything (incl. Esc — no pause mid-resolution)
      return true;
    },
  };
}
