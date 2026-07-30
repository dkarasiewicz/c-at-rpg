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
  EnemyId,
  MewHookId,
  Skill,
  StatusId,
} from "../../core/types";
import { hash, mulberry32 } from "../../core/rng";
import type { Rng } from "../../core/types";
import { createBattle } from "../../core/combat/setup";
import { battleResult, isAutoSkip, startRound } from "../../core/combat/turns";
import { resolveAction } from "../../core/combat/resolve";
import { takeEnemyTurn } from "../../core/combat/ai";
import {
  byId,
  hypotheticalDistance,
  itemLegality,
  legalActions,
  lookupSkill,
  nextActor,
  previewDamage,
  wouldMoveDistance,
  type LegalActions,
} from "../../core/combat/state";
import { applyBattleResult } from "../../core/run/runState";
import {
  effectiveStats,
  skillsForLevel,
  traitTier,
} from "../../core/run/party";
import { rollBossLoot, rollChest, rollVictory } from "../../core/loot/roll";
import type { LootCtx } from "../../core/loot/roll";
import { isStack, removeConsumable } from "../../core/loot/inventory";
import { applyFlee } from "../../core/dungeon/step";
import { roundHalfUp } from "../../core/util";
import { CLASSES } from "../../content/classes";
import { CONSUMABLES } from "../../content/consumables";
import { ENEMIES } from "../../content/enemies";
import { FLOORS } from "../../content/floors";
import { PAL, THEMES } from "../palette";
import { DESIGN_H, DESIGN_W, R, RADIUS, rh, rw, rx, ry } from "../layout";
import { MONO_BITMAP, display, mono, ui } from "../textStyles";
import { killTweens, shake, tween } from "../tween";
import { makeBar, makeEnergyPips, makeStatusChip, type Bar } from "../widgets";
import { drawCat } from "../draw/cats";
import { drawEnemy } from "../draw/enemies";
import { catTexture, enemyTexture } from "../sprites";
import { layer, type GameCtx, type Scene } from "../sceneManager";
import type { EventWinContext, LootOverlayParams } from "../overlays/loot";
import {
  drawGhostArrow,
  makeActivePanel,
  makeCatPileBanner,
  makeChargeMark,
  makeNameplate,
  makePoisePips,
  makePreviewChip,
  makeRankFlood,
  makeRibbon,
  makeSkillBar,
  makeStatusPreviewChip,
  makeTargetRing,
  type ChargeMark,
  type SlotSpec,
} from "./battleWidgets";

/* ---------------------------------------------------------------------- */
/* Params — accepted from explore (StepTrigger 'battle') and event scenes  */
/* ---------------------------------------------------------------------- */

export interface BattleSceneParams {
  t?: "battle";
  enemies: EnemyId[];
  /** battleRng stream key: mulberry32(hash(runSeed, floor, encounterIndex)) */
  encounterIndex: number;
  isBoss?: boolean;
  /** roamer pack fights: floor write-back on victory / flee stun. */
  roamerId?: number;
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
  hpBar: Bar;
  hpNow: number;
  hpMax: number;
  energy?: { set(n: number): void };
  energyNow: number;
  statusRow: Container;
  statuses: Map<StatusId, { count: number; value: number }>;
  stars: Container;
  poise?: { set(n: number): void; max: number };
  charge: ChargeMark | null;
  flood: Graphics | null;
  nameplate: Container | null;
  ring: Graphics | null; // targeting underline
  rank: number;
  dead: boolean;
  bobPhase: number;
}

const slotX = (side: "cat" | "enemy", rank: number): number =>
  (side === "cat" ? R.combat.catSlots[rank] : R.combat.enemySlots[rank]) ??
  DESIGN_W / 2;

const HEAD_Y = -104; // status rows / floaters spawn height above the feet
const TILT = (8 * Math.PI) / 180;
const ATTACK_TILT = 0.09; // slight lean into the lunge (rad)
const BREATH_AMP = 0.015; // ±1.5% idle breathing scale

/** Sprite target height (px, feet-aligned), matched to procedural sizes. */
const GRADE_H: Record<string, number> = {
  minion: 78,
  standard: 92,
  elite: 115,
  boss: 147,
};
const spriteHeightFor = (c: Combatant): number => {
  if (c.side === "cat") return c.classId === "bruiser" ? 112 : 100;
  const grade = ENEMIES[c.speciesId ?? ""]?.look.sizeGrade ?? "standard";
  return GRADE_H[grade] ?? 92;
};

/* ---------------------------------------------------------------------- */
/* The scene                                                               */
/* ---------------------------------------------------------------------- */

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
  let roundText: Text | null = null;
  let fleeChip: Container | null = null;
  let logText: BitmapText | null = null;
  let activeSlot: Graphics | null = null;
  let scrollPanel: Container | null = null;
  let scrollOffset = 0;

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
  } | null = null;
  let targetFx: Container | null = null;
  let flyout: Container | null = null;
  let flyoutItems: string[] = [];
  let elapsed = 0;
  let finished = false;

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
      logText.text = text;
      while (logText.width > rw(R.combat.logLine) && logText.text.length > 4) {
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

    // Stand-aura flash (additive, alpha-tweened on hit) behind the body
    const aura = new Graphics()
      .ellipse(0, -h * 0.48, h * 0.44, h * 0.52)
      .fill(0xffffff);
    aura.blendMode = "add";
    aura.alpha = 0;
    body.addChild(aura);

    // generated sprite (visual-v2) with the procedural recipe as fallback
    let gfx: Graphics | Sprite;
    const tex =
      c.side === "cat" && c.classId
        ? catTexture(c.classId)
        : enemyTexture(c.speciesId ?? "");
    if (tex) {
      const sp = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
      sp.scale.set(h / tex.height); // fit slot height, square = aspect kept
      gfx = sp;
    } else {
      const g = new Graphics();
      if (c.side === "cat" && c.classId) {
        drawCat(g, c.classId, "battle");
      } else {
        const def = ENEMIES[c.speciesId ?? ""];
        if (def) drawEnemy(g, def.look);
      }
      gfx = g;
    }
    body.addChild(gfx);
    root.addChild(body);

    // HP bar 64×7 below feet (+ mini energy pips for cats)
    const hpBar = makeBar(64, 7);
    hpBar.view.position.set(-32, 10);
    hpBar.set(c.hp / c.stats.hp, false);
    root.addChild(hpBar.view);
    let energy: { set(n: number): void } | undefined;
    if (c.side === "cat") {
      const pips = makeEnergyPips(c.stats.enMax || 10, 4, 6, 1);
      pips.view.position.set(-24, 20);
      pips.set(c.energy);
      energy = pips;
      root.addChild(pips.view);
    }

    // status chips centered above the head
    const statusRow = new Container();
    statusRow.position.set(0, HEAD_Y - 20);
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
    stars.position.set(0, HEAD_Y - 4);
    stars.visible = false;
    root.addChild(stars);

    const u: UnitView = {
      id: c.id,
      side: c.side,
      root,
      body,
      gfx,
      aura,
      hpBar,
      hpNow: c.hp,
      hpMax: c.stats.hp,
      energy,
      energyNow: c.energy,
      statusRow,
      statuses: new Map(),
      stars,
      charge: null,
      flood: null,
      nameplate: null,
      ring: null,
      rank: c.rank,
      dead: false,
      bobPhase: c.rank * 0.9,
    };

    // boss: always-visible Poise pips above the status row
    if (c.poiseMax !== undefined) {
      const pips = makePoisePips(c.poiseMax);
      pips.view.position.set(0, HEAD_Y - 44);
      pips.view.pivot.x = (c.poiseMax * 18) / 2 - 6;
      pips.set(c.poise ?? c.poiseMax);
      root.addChild(pips.view);
      u.poise = { set: pips.set, max: c.poiseMax };
    }

    // hover nameplate + tap interactions
    root.eventMode = "static";
    root.hitArea = {
      contains: (px: number, py: number) =>
        px >= -44 && px <= 44 && py >= -108 && py <= 16,
    };
    root.cursor = "pointer";
    root.on("pointerover", () => {
      if (u.dead || !bs) return;
      const cc = bs.combatants.find((x) => x.id === u.id);
      if (!cc || u.nameplate) return;
      u.nameplate = makeNameplate(cc);
      u.nameplate.position.set(0, HEAD_Y - 42 - (u.poise ? 24 : 0));
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

  /* ---------------- battlefield build ---------------- */

  const buildBattlefield = (run: { floorNum: number }): void => {
    if (!bgC || !worldC || !bs) return;
    const theme =
      THEMES[Math.min(THEMES.length - 1, Math.floor((run.floorNum - 1) / 2))];

    const back = new Graphics().rect(0, 0, DESIGN_W, DESIGN_H).fill(PAL.bgDeep);
    // moon
    back.circle(640, 150, 70).fill({ color: PAL.text, alpha: 0.12 });
    // ground band
    back.rect(0, R.combat.groundY, DESIGN_W, 64).fill(theme.floorA);
    // alley silhouettes (visual RNG only)
    for (let i = 0; i < 6; i++) {
      const px = 90 + Math.random() * 1100;
      const pw = 40 + Math.random() * 70;
      const ph = 50 + Math.random() * 130;
      back
        .roundRect(px, R.combat.groundY - ph, pw, ph, 8)
        .fill({ color: theme.wallFace, alpha: 0.5 });
    }
    bgC.addChild(back);

    // rank slots: shadow ellipses + numerals
    const slots = new Graphics();
    const numerals = new Container();
    const addSlot = (side: "cat" | "enemy", rank: number): void => {
      const x = slotX(side, rank);
      slots
        .ellipse(x, R.combat.groundY, 34, 9)
        .fill({ color: PAL.void, alpha: 0.5 });
      const n = new Text({
        text: String(rank),
        style: ui(11, { fill: PAL.textDim }),
      });
      n.anchor.set(0.5, 0);
      n.position.set(x, R.combat.groundY + 12);
      numerals.addChild(n);
    };
    for (let r = 1; r <= 4; r++) addSlot("cat", r);
    for (let r = 1; r <= 5; r++) addSlot("enemy", r);
    worldC.addChild(slots, numerals);

    // active-unit slot highlight (gold pulsing ellipse)
    activeSlot = new Graphics()
      .ellipse(0, 0, 34, 9)
      .stroke({ width: 3, color: PAL.gold });
    activeSlot.position.set(slotX("cat", 1), R.combat.groundY);
    activeSlot.visible = false;
    worldC.addChild(activeSlot);

    for (const c of bs.combatants) {
      const u = makeUnit(c);
      units.set(c.id, u);
      worldC.addChild(u.root);
    }
  };

  const buildHud = (): void => {
    if (!hudC || !modalC || !bs) return;
    // round chip
    const rc = new Graphics()
      .roundRect(0, 0, rw(R.combat.roundChip), rh(R.combat.roundChip), 6)
      .fill(PAL.panel)
      .stroke({ width: 2, color: PAL.border });
    rc.position.set(rx(R.combat.roundChip), ry(R.combat.roundChip));
    roundText = new Text({
      text: "ROUND 1",
      style: ui(14, { fontWeight: "bold" }),
    });
    roundText.anchor.set(0.5);
    roundText.position.set(
      rx(R.combat.roundChip) + rw(R.combat.roundChip) / 2,
      ry(R.combat.roundChip) + rh(R.combat.roundChip) / 2,
    );
    hudC.addChild(rc, roundText);

    // ribbon
    ribbon.view.position.set(rx(R.combat.ribbon), ry(R.combat.ribbon));
    hudC.addChild(ribbon.view);

    // flee chip — hidden in boss fights
    if (bs.canFlee) {
      fleeChip = new Container();
      const fg = new Graphics()
        .roundRect(0, 0, rw(R.combat.fleeChip), rh(R.combat.fleeChip), 6)
        .fill(PAL.panel)
        .stroke({ width: 2, color: PAL.danger });
      const ft = new Text({
        text: "R Scatter!",
        style: ui(14, { fill: PAL.danger, fontWeight: "bold" }),
      });
      ft.anchor.set(0.5);
      ft.position.set(rw(R.combat.fleeChip) / 2, rh(R.combat.fleeChip) / 2);
      fleeChip.addChild(fg, ft);
      fleeChip.position.set(rx(R.combat.fleeChip), ry(R.combat.fleeChip));
      fleeChip.eventMode = "static";
      fleeChip.cursor = "pointer";
      fleeChip.on("pointertap", () => tryFlee());
      hudC.addChild(fleeChip);
    }

    // log line
    logText = new BitmapText({
      text: "",
      style: { fontFamily: MONO_BITMAP, fontSize: 14 },
    });
    logText.tint = PAL.textDim;
    logText.position.set(rx(R.combat.logLine), ry(R.combat.logLine) + 4);
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

    // Cat Pile banner lives on the modal layer
    modalC.addChild(banner.view);
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

  const resolvePlayer = (action: BattleAction, itemDefId?: string): void => {
    if (!bs || !rng || !ctx?.run) return;
    clearTargeting();
    closeFlyout();
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
      const bg = new Graphics()
        .roundRect(0, 0, rowW, rowH, RADIUS.button)
        .fill(PAL.panelLite)
        .stroke({ width: 2, color: PAL.border });
      row.addChild(bg);
      const hk = new Text({
        text: String(i + 1),
        style: mono(12, { fill: PAL.textDark }),
      });
      const hkBg = new Graphics()
        .roundRect(6, 10, 16, 16, RADIUS.chip)
        .fill(PAL.gold);
      hk.anchor.set(0.5);
      hk.position.set(14, 18);
      row.addChild(hkBg, hk);
      const label = new Text({
        text: `${def.icon} ${def.name} ×${item.count}`,
        style: ui(14),
      });
      label.position.set(30, 9);
      row.addChild(label);
      row.position.set(0, i * (rowH + 4));
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
    targeting = { skill, action, refId, targetIds, idx: 0 };
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
      // damage / heal preview chip
      if (sk.kind === "damage" && sk.power > 0) {
        const n = previewDamage(bs, sk.id, actorId, tid);
        const chip = makePreviewChip(`≈${n}`, PAL.text);
        chip.position.set(u.root.x, u.root.y + HEAD_Y - 6);
        targetFx.addChild(chip);
      } else if (sk.kind === "heal" && sk.power > 0) {
        // display-only estimate: same "power% of atk" reading as the tooltip
        const n = roundHalfUp((sk.power / 100) * actor.stats.atk);
        const chip = makePreviewChip(`≈+${n}`, PAL.heal);
        chip.position.set(u.root.x, u.root.y + HEAD_Y - 6);
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
            chip.position.set(u.root.x, u.root.y + HEAD_Y - 32);
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

  const onUnitTap = (u: UnitView): void => {
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
        } else if (other.rank === actor.rank + 1 && legal.canMoveBack) {
          resolvePlayer({ type: "move", dir: "back" });
        }
      }
    }
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
        if (roundText) roundText.text = `ROUND ${e.round}`;
        if (bs) ribbon.setRound(bs);
        pushLog(`— round ${e.round} —`);
        return 280;
      }
      case "turnStart": {
        lastActorId = e.id;
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
        u.hpBar.set(u.hpNow / u.hpMax);
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
          u.root.y + HEAD_Y,
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
        u.hpBar.set(u.hpNow / u.hpMax);
        floater(u.root.x, u.root.y + HEAD_Y, `+${e.amount}`, PAL.heal);
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
          floater(u.root.x, u.root.y + HEAD_Y, "OFF-BALANCE!", PAL.offBal, 22);
        } else {
          const label = e.status.replace(/([A-Z])/g, " $1").toUpperCase();
          const colors: Record<StatusId, number> = {
            scratched: PAL.stScratched,
            frazzled: PAL.stFrazzled,
            offBalance: PAL.stOffBal,
            guarded: PAL.stGuarded,
            provoked: PAL.stProvoked,
            mending: PAL.stMending,
          };
          floater(u.root.x, u.root.y + HEAD_Y, label, colors[e.status], 22);
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
              u.root.y + HEAD_Y,
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
          (u?.root.y ?? R.combat.groundY) + HEAD_Y,
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
        return 333;
      }
      case "ko": {
        const u = unitOf(e.id);
        if (u) {
          u.dead = true;
          u.statuses.clear();
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
        return 300;
      }
      case "revive": {
        const u = unitOf(e.id);
        if (u && bs) {
          const c = bs.combatants.find((x) => x.id === e.id);
          u.dead = false;
          u.hpNow = e.hp;
          u.hpBar.set(u.hpNow / u.hpMax, false);
          u.rank = c?.rank ?? u.rank;
          u.root.position.x = slotX(u.side, u.rank);
          u.body.scale.set(1);
          tween(u.root, { alpha: 1 }, 200);
          floater(u.root.x, u.root.y + HEAD_Y, "REVIVED!", PAL.heal, 22);
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
          u.charge.view.position.set(0, HEAD_Y - 40);
          u.root.addChild(u.charge.view);
          u.flood = makeRankFlood(e.ranks);
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
          floater(u.root.x, u.root.y + HEAD_Y, e.trait, PAL.gold, 22);
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
            floater(u.root.x, u.root.y + HEAD_Y, "FAILED!", PAL.danger, 22);
        }
        return 250;
      }
      case "victory": {
        pushLog("Victory! The alley is quiet again.");
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
    const bg = new Graphics()
      .roundRect(0, 0, sw, sh, RADIUS.panel)
      .fill({ color: PAL.panel, alpha: 0.95 })
      .stroke({ width: 2, color: PAL.border });
    scrollPanel.addChild(bg);
    const txt = new Text({
      text: "",
      style: mono(12, { fill: PAL.textDim, lineHeight: 16 }),
    });
    txt.position.set(10, 8);
    scrollPanel.addChild(txt);
    const render = (): void => {
      const perPage = Math.floor((sh - 16) / 16);
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

    if (result.outcome === "fled") {
      if (params.roamerId !== undefined && run.floor) {
        applyFlee(run.floor, params.roamerId);
      }
      ctx.save(); // autosave: successful flee (gameloop §9)
      delay(450, () => ctx?.scenes.goto("explore"));
      return;
    }

    if (result.outcome === "defeat") {
      // 1.5s "the clowder scatters…" beat (gameloop §6)
      if (modalC) {
        const beat = new Text({
          text: "the clowder scatters…",
          style: display(32, { fill: PAL.danger }),
        });
        beat.anchor.set(0.5);
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
    const out = applyBattleResult(run, result, params.roamerId);
    ctx.run = out.run;
    const runWon = result.bossDefeated && out.run.floorNum >= FLOORS.length;
    const after = (): void => {
      if (!ctx) return;
      if (runWon) ctx.scenes.goto("results", { victory: true });
      else ctx.scenes.goto("explore");
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
      for (const item of [cat.weapon, cat.trinket]) {
        if (item?.hook && !item.hookSpent) hooks.push(item.hook);
      }
      cats.push({
        classId,
        name: cls.catName,
        stats,
        hp: Math.min(cat.hp, stats.hp),
        lives: cat.lives,
        skills: skillsForLevel(classId, run.level),
        traits,
        hooks,
        startEnergyBonus: cat.energyNextBattle,
      });
    }
    return {
      cats,
      enemies: params.enemies,
      encounterIndex: params.encounterIndex,
      canFlee: !isBoss,
    };
  };

  /* ---------------- Scene contract ---------------- */

  return {
    mount(root: Container, gameCtx: GameCtx, rawParams?: unknown): void {
      ctx = gameCtx;
      alive = true;
      params = (rawParams ?? null) as BattleSceneParams | null;
      if (!params || !ctx.run) {
        // driver bug — nothing to fight; bail to explore next frame
        delay(0, () => ctx?.scenes.goto("explore"));
        return;
      }
      isBoss = params.isBoss ?? params.encounterIndex === 0;

      const setup = buildSetup();
      if (!setup || setup.cats.length === 0) {
        delay(0, () => ctx?.scenes.goto("explore"));
        return;
      }
      bs = createBattle(setup);
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
      for (const c of [bgC, worldC, fxC, hudC, floatC, modalC]) {
        if (c) {
          c.parent?.removeChild(c);
          c.destroy({ children: true });
        }
      }
      bgC = worldC = fxC = hudC = floatC = modalC = null;
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

      // ambience: idle bob + breathing, star orbits, slot pulse, charge bounce
      const t = elapsed / 1000;
      for (const u of units.values()) {
        if (u.dead) continue;
        u.body.y = Math.sin((t * Math.PI * 2) / 1.6 + u.bobPhase) * 2;
        // slow breathing: ±1.5% vertical scale, slight inverse horizontal
        const br = Math.sin((t * Math.PI * 2) / 2.8 + u.bobPhase) * BREATH_AMP;
        u.body.scale.y = 1 + br;
        u.body.scale.x = 1 - br * 0.5;
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

      if (scrollPanel) {
        if (key === "esc" || key === "l") toggleScrollback();
        return true;
      }
      if (key === "l") {
        toggleScrollback();
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
