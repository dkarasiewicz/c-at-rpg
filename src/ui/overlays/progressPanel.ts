/**
 * THE DEN — the player-facing progression screen (docs/design/progression.md).
 *
 * One embeddable panel (like `inventoryPanel.ts`, so no new overlay id is
 * needed) that surfaces the four systems the engine gained but nothing could
 * reach: Whisker Points, milestone skill unlocks, the 4-slot battle loadout
 * and the third `collar` gear slot.
 *
 *   ┌ THE DEN ─────────────────────────────────────────────────────────┐
 *   │ [Bruno] [Pixel] [Mora] [Baguette]         ← cat tabs (+ badges)   │
 *   │ ┌ portrait ─────────┐ ┌ WHISKER POINTS · SKILLS · GEAR ────────┐ │
 *   │ │ name / Stand / Lv │ │ the active section                     │ │
 *   │ │ XP bar to next    │ │                                        │ │
 *   │ │ stat breakdown    │ │                                        │ │
 *   │ └───────────────────┘ └────────────────────────────────────────┘ │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Hosts: `scenes/landing.ts` (action bar, hotkey P) and `overlays/pause.ts`
 * (menu row 2, hotkey P). The level-up flourish (`makeLevelUpCard`) is hosted
 * by the loot overlay, where `applyBattleResult`'s output is displayed.
 *
 * EVERY mutation goes through a core API and is written back with `setRun`;
 * this file computes no gameplay numbers. All chrome comes from the shared
 * kit (widgets.ts) — nothing here paints its own rectangle, face or type.
 *
 * The pure view-model half (everything above the "pixi" divider) is exported
 * and unit-tested headless in `tests/progress-ui.spec.ts`.
 */
import { Container, Graphics } from "pixi.js";
import type {
  CatRunState,
  ClassId,
  EquipInstance,
  EquipSlot,
  MewHookId,
  RunState,
  SkillId,
  StatKey,
  Stats,
} from "../../core/types.js";
import { EQUIP_SLOTS } from "../../core/types.js";
import { CLASSES } from "../../content/classes.js";
import { SKILLS } from "../../content/skills.js";
import { EQUIP_DEFS } from "../../content/equipment.js";
import { LEVEL_CAP, XP_TO_LEVEL } from "../../content/floors.js";
import {
  addEquip,
  canEquip,
  equipItem,
  isEquip,
  removeSlot,
  unequipItem,
} from "../../core/loot/inventory.js";
import {
  BASIC_SKILL_ID,
  LOADOUT_SIZE,
  POINT_MENU,
  activeSkills,
  canSpendPoint,
  effectiveStats,
  growthStats,
  knownSkills,
  maxHp,
  pointStats,
  setLoadout,
  spendPoint,
  unspentPoints,
} from "../../core/run/party.js";
import { PAL } from "../palette.js";
import { DESIGN_W, RADIUS, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import { tween } from "../tween.js";
import {
  avatar,
  bar,
  button,
  heading,
  label,
  makePawRow,
  makeSpriteIcon,
  makeTooltip,
  panel,
} from "../widgets.js";
import {
  RARITY_COLOR,
  catNameColor,
  equipName,
  equipStatsText,
  itemSpriteId,
  statDeltaText,
} from "./inventoryPanel.js";

/* ====================================================================== */
/* ==  PURE VIEW MODEL (no pixi below this line until the divider)     == */
/* ====================================================================== */

const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  atk: "ATK",
  def: "DEF",
  spd: "SPD",
  crt: "CRT",
  enMax: "EN",
};

/** Display order of the stat table — the POINT_MENU order (= StatKey order). */
export const STAT_ORDER: readonly StatKey[] = [
  "hp",
  "atk",
  "def",
  "spd",
  "crt",
  "enMax",
];

/** Human copy for the 8 Mewthical hooks (loot.md §4), condensed for a chip. */
export const HOOK_TEXT: Record<MewHookId, string> = {
  poiseChip2: "Forced moves chip 2 Poise on heavy targets.",
  critOffBalance: "Crits also inflict Off-Balance.",
  appliesAlwaysHit: "This cat's status chances are treated as 1.0.",
  healsGrantMending: "Heals also grant Mending 2 for 2 rounds.",
  moverOffBalance: "An enemy that shoves this cat becomes Off-Balance.",
  ninthBell: "Once per run: a Life loss is prevented. The bell cracks.",
  catPileDouble: "Cat Pile counts this cat's ATK twice.",
  startEnergy6: "Starts every battle at 6 Energy.",
};

/**
 * The cat's Stand name, lifted out of the class bio's «guillemets» (the
 * content tables have no dedicated field). Falls back to the epithet.
 */
export function standName(classId: ClassId): string {
  const cls = CLASSES[classId];
  const m = /«([^»]+)»/.exec(cls.flavor.bio);
  return m ? m[1] : cls.epithet;
}

/**
 * Collapse to a single clamped line — dense table rows must not wrap into
 * their neighbour (the full text is one hover away in a tooltip).
 */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Display name of a skill id (custom GM kits may not be in SKILLS). */
export function skillName(id: SkillId): string {
  return SKILLS[id]?.name ?? id;
}

/* ---- stat breakdown --------------------------------------------------- */

export interface StatRow {
  stat: StatKey;
  label: string;
  /** Class base + every growth row up to `level`. */
  base: number;
  /** What spent Whisker Points add. */
  points: number;
  /** What weapon + trinket + collar add. */
  gear: number;
  /** What event tempMods add (hpMax folds onto hp). */
  temp: number;
  /** The authoritative effective value (post-clamp) — never a hand sum. */
  total: number;
}

function gearStats(cat: CatRunState): Partial<Stats> {
  const out: Partial<Stats> = {};
  for (const slot of EQUIP_SLOTS) {
    const item = cat[slot];
    if (!item) continue;
    for (const [k, v] of Object.entries(item.stats) as [StatKey, number][]) {
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

function tempStats(cat: CatRunState): Partial<Stats> {
  const out: Partial<Stats> = {};
  for (const mod of cat.tempMods) {
    const k: StatKey = mod.stat === "hpMax" ? "hp" : mod.stat;
    out[k] = (out[k] ?? 0) + mod.amount;
  }
  return out;
}

/**
 * The WHY behind every number: base+growth / points / equipment / temp mods,
 * and the effective total straight from the engine.
 */
export function buildStatRows(cat: CatRunState, level: number): StatRow[] {
  const base = growthStats(cat.classId, level);
  const pts = pointStats(cat);
  const gear = gearStats(cat);
  const temp = tempStats(cat);
  const eff = effectiveStats(cat, level);
  return STAT_ORDER.map((stat) => ({
    stat,
    label: STAT_LABEL[stat],
    base: base[stat],
    points: pts[stat] ?? 0,
    gear: gear[stat] ?? 0,
    temp: temp[stat] ?? 0,
    total: eff[stat],
  }));
}

/* ---- XP ---------------------------------------------------------------- */

export interface XpProgress {
  /** XP earned inside the current level band. */
  inLevel: number;
  /** Size of the current band (0 at the cap). */
  span: number;
  frac: number;
  /** XP still owed to the next level (0 at the cap). */
  toNext: number;
  capped: boolean;
}

/** Party XP position inside its level band (the Den's XP bar). */
export function xpProgress(xp: number, level: number): XpProgress {
  const lo = XP_TO_LEVEL[level - 1] ?? 0;
  const hi = XP_TO_LEVEL[level];
  if (level >= LEVEL_CAP || hi === undefined || hi <= lo) {
    return { inLevel: 0, span: 0, frac: 1, toNext: 0, capped: true };
  }
  const inLevel = Math.max(0, xp - lo);
  const span = hi - lo;
  return {
    inLevel,
    span,
    frac: Math.max(0, Math.min(1, inLevel / span)),
    toNext: Math.max(0, hi - xp),
    capped: false,
  };
}

/* ---- Whisker Points ---------------------------------------------------- */

export interface PointRow {
  stat: StatKey;
  label: string;
  /** What ONE point buys. */
  amount: number;
  cap: number;
  spent: number;
  desc: string;
  /** Engine verdict — the UI never decides this itself. */
  canSpend: boolean;
  /** Why the row is disabled ('' when it is not). */
  blockedBy: "" | "capped" | "no-points";
}

/** The POINT_MENU as rows, with this cat's spend state folded in. */
export function buildPointRows(cat: CatRunState, level: number): PointRow[] {
  const left = unspentPoints(cat, level);
  return POINT_MENU.map((e) => {
    const spent = cat.points?.[e.stat] ?? 0;
    return {
      stat: e.stat,
      label: e.label,
      amount: e.amount,
      cap: e.cap,
      spent,
      desc: e.desc,
      canSpend: canSpendPoint(cat, e.stat, level),
      blockedBy: spent >= e.cap ? "capped" : left <= 0 ? "no-points" : "",
    };
  });
}

/** Every cat index that still has an unspent Whisker Point. */
export function catsNeedingPoints(run: RunState): number[] {
  const out: number[] = [];
  run.cats.forEach((cat, i) => {
    if (cat.lives > 0 && unspentPoints(cat, run.level) > 0) out.push(i);
  });
  return out;
}

/** Party-wide unspent Whisker Points (the badge number). */
export function totalUnspentPoints(run: RunState): number {
  return run.cats.reduce(
    (n, cat) => n + (cat.lives > 0 ? unspentPoints(cat, run.level) : 0),
    0,
  );
}

/* ---- loadout ----------------------------------------------------------- */

/** The 3 non-basic skills this cat currently takes to battle (0..3 of them). */
export function loadoutPicks(cat: CatRunState, level: number): SkillId[] {
  return activeSkills(cat, level).filter((id) => id !== BASIC_SKILL_ID);
}

/**
 * The 4 battle slots, `null`-padded. Slot 0 is always Claw Swipe; a cat that
 * knows fewer than 3 other skills simply has empty slots (no crash, no
 * pretend content).
 */
export function loadoutSlots(
  cat: CatRunState,
  level: number,
): (SkillId | null)[] {
  const active = activeSkills(cat, level);
  const slots: (SkillId | null)[] = [];
  for (let i = 0; i < LOADOUT_SIZE; i++) slots.push(active[i] ?? null);
  return slots;
}

/**
 * Can the loadout be edited at all? `setLoadout` only accepts a full set of
 * 3 picks, so a cat that knows fewer than 3 non-basic skills has nothing to
 * choose between (L1..L3 for the stock classes).
 */
export function canEditLoadout(cat: CatRunState, level: number): boolean {
  return (
    knownSkills(cat.classId, level).filter((id) => id !== BASIC_SKILL_ID)
      .length >=
    LOADOUT_SIZE - 1
  );
}

/**
 * Put `skillId` in battle slot `slotIndex` (1..3 — slot 0 is Claw Swipe and
 * is not for sale). If the skill already sits in another slot the two SWAP,
 * so the picks stay a set of 3 and no skill is ever silently dropped.
 *
 * Pure and total: an illegal request returns the SAME cat (the engine's
 * `setLoadout` validates again on top of this).
 */
export function assignToSlot(
  cat: CatRunState,
  level: number,
  slotIndex: number,
  skillId: SkillId,
): CatRunState {
  if (slotIndex < 1 || slotIndex >= LOADOUT_SIZE) return cat;
  if (skillId === BASIC_SKILL_ID) return cat;
  if (!knownSkills(cat.classId, level).includes(skillId)) return cat;
  const picks = loadoutPicks(cat, level);
  if (picks.length !== LOADOUT_SIZE - 1) return cat; // nothing to choose yet
  const i = slotIndex - 1;
  if (picks[i] === skillId) return cat;
  const j = picks.indexOf(skillId);
  const next = picks.slice();
  if (j >= 0) {
    next[j] = picks[i];
    next[i] = skillId;
  } else {
    next[i] = skillId;
  }
  return setLoadout(cat, level, next);
}

export interface SkillRow {
  skillId: SkillId;
  name: string;
  desc: string;
  cost: number;
  /** Cats ignore cooldowns; shown when the data carries one. */
  cooldown: number | undefined;
  unlockLevel: number;
  known: boolean;
  /** Battle slot 0..3, or null when the skill is benched / not yet known. */
  slot: number | null;
  /** Slot 1's unremovable Claw Swipe. */
  basic: boolean;
}

/**
 * Every skill the class will ever have, ordered by unlock level (table order
 * within a level). Locked entries stay visible with their unlock level — the
 * player should see what is coming.
 */
export function buildSkillRows(cat: CatRunState, level: number): SkillRow[] {
  const active = activeSkills(cat, level);
  return CLASSES[cat.classId].skills
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.unlockLevel - b.unlockLevel || a.i - b.i)
    .map((s) => {
      const def = SKILLS[s.skillId];
      const slot = active.indexOf(s.skillId);
      return {
        skillId: s.skillId,
        name: skillName(s.skillId),
        desc: def?.desc ?? "",
        cost: def?.cost ?? 0,
        cooldown: def?.cooldown,
        unlockLevel: s.unlockLevel,
        known: s.unlockLevel <= level,
        slot: slot >= 0 ? slot : null,
        basic: s.skillId === BASIC_SKILL_ID,
      };
    });
}

/* ---- gear -------------------------------------------------------------- */

export interface GearRow {
  slot: EquipSlot;
  item: EquipInstance | null;
}

/** The three worn slots, always all three (an empty collar is a row too). */
export function buildGearRows(cat: CatRunState): GearRow[] {
  return EQUIP_SLOTS.map((slot) => ({ slot, item: cat[slot] ?? null }));
}

export interface BackpackRow {
  /** Index into `run.inventory.slots`. */
  index: number;
  item: EquipInstance;
  slot: EquipSlot;
  /** vs whatever this cat wears in that slot right now. */
  delta: string;
}

/** Backpack equipment this cat may actually wear (weapons are class-locked). */
export function buildBackpackRows(
  run: RunState,
  catIndex: number,
): BackpackRow[] {
  const cat = run.cats[catIndex];
  if (!cat || cat.lives <= 0) return [];
  const out: BackpackRow[] = [];
  run.inventory.slots.forEach((slot, index) => {
    if (slot === null || !isEquip(slot)) return;
    if (!canEquip(cat, slot)) return;
    const s = EQUIP_DEFS[slot.defId].slot;
    out.push({
      index,
      item: slot,
      slot: s,
      delta: statDeltaText(slot, cat[s] ?? null),
    });
  });
  return out;
}

/* ---- focus model (keyboard navigation) --------------------------------- */

export type DenSection = "points" | "skills" | "gear";

export const DEN_SECTIONS: readonly DenSection[] = ["points", "skills", "gear"];

export interface DenFocus {
  section: DenSection;
  index: number;
}

/** Move the row cursor inside the active section (wraps; clamps to 0 empty). */
export function moveFocus(
  focus: DenFocus,
  count: number,
  delta: number,
): DenFocus {
  if (count <= 0) return { section: focus.section, index: 0 };
  const i = focus.index >= count ? count - 1 : focus.index;
  return {
    section: focus.section,
    index: (((i + delta) % count) + count) % count,
  };
}

/**
 * Switch section (`dir` ±1), skipping any that has no rows, and park the
 * cursor on its first row.
 */
export function cycleSection(
  focus: DenFocus,
  counts: Record<DenSection, number>,
  dir: number,
): DenFocus {
  const n = DEN_SECTIONS.length;
  const from = DEN_SECTIONS.indexOf(focus.section);
  const step = dir < 0 ? -1 : 1;
  for (let k = 1; k <= n; k++) {
    const section = DEN_SECTIONS[(((from + step * k) % n) + n) % n];
    if (counts[section] > 0) return { section, index: 0 };
  }
  return { section: focus.section, index: 0 };
}

/* ---- level-up summary --------------------------------------------------- */

export interface LevelUpCatSummary {
  classId: ClassId;
  /** Growth-row gains between the two levels ('hp +8  ATK +2'). */
  gains: { stat: StatKey; label: string; amount: number }[];
  /** Skills unlocked by crossing the levels (usually 0 or 1). */
  newSkills: SkillId[];
}

export interface LevelUpSummary {
  fromLevel: number;
  toLevel: number;
  /** Whisker Points each living cat just earned. */
  pointsEach: number;
  cats: LevelUpCatSummary[];
}

/**
 * What a level-up actually gave the party: per living cat, its growth-row
 * stat gains and any milestone skill unlocked on the way. Pure — the loot
 * overlay renders it, the results screen could too.
 */
export function buildLevelUpSummary(
  cats: readonly CatRunState[],
  fromLevel: number,
  toLevel: number,
): LevelUpSummary {
  const to = Math.min(toLevel, LEVEL_CAP);
  const from = Math.min(fromLevel, to);
  const rows: LevelUpCatSummary[] = [];
  for (const cat of cats) {
    if (cat.lives <= 0) continue;
    const growth = CLASSES[cat.classId].growth;
    const acc: Partial<Record<StatKey, number>> = {};
    for (let l = from + 1; l <= to; l++) {
      const row = growth[l - 2];
      if (!row) continue;
      for (const [k, v] of Object.entries(row) as [StatKey, number][]) {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
    const before = knownSkills(cat.classId, from);
    const newSkills = knownSkills(cat.classId, to).filter(
      (id) => !before.includes(id),
    );
    rows.push({
      classId: cat.classId,
      gains: STAT_ORDER.filter((s) => (acc[s] ?? 0) !== 0).map((stat) => ({
        stat,
        label: STAT_LABEL[stat],
        amount: acc[stat] ?? 0,
      })),
      newSkills,
    });
  }
  return { fromLevel: from, toLevel: to, pointsEach: to - from, cats: rows };
}

/* ====================================================================== */
/* ==  PIXI                                                            == */
/* ====================================================================== */

/** Default panel box — hosts lay their own chrome out against these. */
export const PROGRESS_PANEL_W = 1200;
export const PROGRESS_PANEL_H = 628;

const PAD = SPACE.lg;
const TAB_Y = 70;
const TAB_H = 64;
const TAB_GAP = 16;
const BODY_Y = TAB_Y + TAB_H + SPACE.lg;
const FOOT_H = 48;
const LEFT_W = 380;
const RIGHT_X = PAD + LEFT_W + SPACE.lg;
const SECTION_TAB_H = 32;
const ROW_R = RADIUS.button;

const SECTION_TITLE: Record<DenSection, string> = {
  points: "WHISKER POINTS",
  skills: "SKILLS",
  gear: "GEAR",
};

/** Gold notification pill — "unspent points here" (landing / pause / tabs). */
export function makePointBadge(count: number, pulse = true): Container {
  const view = new Container();
  const txt = label(`✦ ${count}`, {
    mono: true,
    size: TYPE.tiny,
    fill: PAL.textDark,
    bold: true,
  });
  const w = Math.ceil(txt.width) + 14;
  const h = 18;
  txt.position.set(7, (h - txt.height) / 2);
  view.addChild(
    new Graphics()
      .roundRect(0, 0, w, h, h / 2)
      .fill(PAL.gold)
      .stroke({ width: 1, color: PAL.goldDark }),
    txt,
  );
  if (pulse) {
    view.pivot.set(w / 2, h / 2);
    view.position.set(w / 2, h / 2);
    const beat = (): void => {
      if (view.destroyed) return;
      tween(view.scale, { x: 1.12, y: 1.12 }, 520, "quadOut", () => {
        if (view.destroyed) return;
        tween(view.scale, { x: 1, y: 1 }, 520, "quadOut", beat);
      });
    };
    beat();
  }
  return view;
}

/**
 * Wrap a badge so hosts can position it by its top-left corner regardless of
 * the pulse pivot. Returns null when there is nothing to announce.
 */
export function makePointBadgeAt(
  count: number,
  x: number,
  y: number,
): Container | null {
  if (count <= 0) return null;
  const holder = new Container();
  holder.position.set(x, y);
  holder.addChild(makePointBadge(count));
  return holder;
}

export interface ProgressPanelOpts {
  getRun(): RunState;
  setRun(run: RunState): void;
  /** Fired after every successful mutation (HUD counters, autosave, …). */
  onChanged?(): void;
  /** Esc / the Close button. */
  onClose?(): void;
  toast?(text: string): void;
  /** Cat to open on (defaults to the first with unspent points, else 0). */
  catIndex?: number;
  width?: number;
  height?: number;
}

export interface ProgressPanelApi {
  view: Container;
  refresh(): void;
  /** true = consumed. */
  onKey(key: string): boolean;
  destroy(): void;
}

/**
 * Build the Den. Keyboard: Tab / ← → switch cat, ↑ ↓ move the row cursor,
 * Q E switch section, Enter act, number keys are the section's quick action
 * (spend stat N · assign the focused skill to battle slot N · act on row N).
 * Everything is equally clickable.
 */
export function makeProgressPanel(opts: ProgressPanelOpts): ProgressPanelApi {
  const W = opts.width ?? PROGRESS_PANEL_W;
  const H = opts.height ?? PROGRESS_PANEL_H;
  const RIGHT_W = W - PAD - RIGHT_X;
  const BODY_H = H - BODY_Y - FOOT_H - SPACE.md;
  const SECTION_H = BODY_H - SECTION_TAB_H - SPACE.md;

  const view = new Container();
  view.addChild(panel(W, H, { variant: "raised", accent: PAL.gold }));

  const run0 = opts.getRun();
  let catIndex = opts.catIndex ?? catsNeedingPoints(run0)[0] ?? 0;
  let focus: DenFocus = { section: "points", index: 0 };
  /** Skill selected by click, waiting for a slot (the click-click flow). */
  let pickedSkill: SkillId | null = null;
  /** Stat whose total should pop on the next repaint (the "tick up"). */
  let flashStat: StatKey | null = null;
  let destroyed = false;

  /* ---- static chrome --------------------------------------------------- */
  const eyebrow = heading("PARTY · POINTS · SKILLS · GEAR", 3);
  eyebrow.position.set(PAD, SPACE.md);
  const title = heading("THE DEN", 2, { fill: PAL.gold });
  title.position.set(PAD, SPACE.md + 18);
  view.addChild(eyebrow, title);

  const unspentText = label("", {
    mono: true,
    bold: true,
    fill: PAL.gold,
    size: TYPE.body,
  });
  unspentText.anchor.set(1, 0);
  unspentText.position.set(W - PAD, SPACE.md + 4);
  view.addChild(unspentText);

  const tabLayer = new Container();
  tabLayer.position.set(PAD, TAB_Y);
  const leftLayer = new Container();
  leftLayer.position.set(PAD, BODY_Y);
  const sectionTabLayer = new Container();
  sectionTabLayer.position.set(RIGHT_X, BODY_Y);
  const sectionLayer = new Container();
  sectionLayer.position.set(RIGHT_X, BODY_Y + SECTION_TAB_H + SPACE.md);
  const tipLayer = new Container();
  view.addChild(tabLayer, leftLayer, sectionTabLayer, sectionLayer, tipLayer);

  const hint = label(
    "Tab / ← → cat   ·   ↑ ↓ row   ·   Q E section   ·   Enter act   ·   1-9 quick   ·   Esc close",
    { dim: true, size: TYPE.tiny, mono: true },
  );
  hint.position.set(PAD, H - FOOT_H + 14);
  view.addChild(hint);

  const closeBtn = button("Close", 160, 36, () => opts.onClose?.(), {
    hotkey: "Esc",
    fontSize: TYPE.small,
  });
  closeBtn.view.position.set(W - PAD - 160, H - FOOT_H + 2);
  view.addChild(closeBtn.view);

  /* ---- helpers --------------------------------------------------------- */

  const sectionCounts = (): Record<DenSection, number> => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    return {
      points: POINT_MENU.length,
      skills: buildSkillRows(cat, run.level).length,
      gear: EQUIP_SLOTS.length + buildBackpackRows(run, catIndex).length,
    };
  };

  const clearTips = (): void => {
    for (const c of tipLayer.removeChildren()) c.destroy({ children: true });
  };

  const showTip = (text: string, x: number, y: number): void => {
    clearTips();
    const tip = makeTooltip(text);
    tip.position.set(Math.min(x, W - 300), Math.min(y, H - 90));
    tipLayer.addChild(tip);
  };

  /* ---- mutations (all through core APIs) -------------------------------- */

  const writeCat = (next: CatRunState): boolean => {
    const run = opts.getRun();
    const cur = run.cats[catIndex];
    if (next === cur) return false; // engine rejected it — fire and forget
    const cats = run.cats.slice();
    cats[catIndex] = next;
    opts.setRun({ ...run, cats });
    opts.onChanged?.();
    return true;
  };

  const doSpend = (stat: StatKey): void => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    if (cat.lives <= 0) return;
    if (writeCat(spendPoint(cat, stat, run.level))) {
      flashStat = stat;
      refresh();
    }
  };

  const doAssign = (slotIndex: number, skillId: SkillId): void => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    if (!canEditLoadout(cat, run.level)) {
      opts.toast?.("Not enough skills known to rearrange yet.");
      return;
    }
    if (writeCat(assignToSlot(cat, run.level, slotIndex, skillId))) {
      pickedSkill = null;
      refresh();
    }
  };

  const doUnequip = (slot: EquipSlot): void => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    if (!cat[slot]) return;
    if (!run.inventory.slots.includes(null)) {
      opts.toast?.("Backpack full — no room to take that off.");
      return;
    }
    const r = unequipItem(cat, slot);
    if (!r.removed) return;
    const cats = run.cats.slice();
    cats[catIndex] = r.cat;
    opts.setRun({
      ...run,
      cats,
      inventory: addEquip(run.inventory, r.removed).inv,
    });
    opts.onChanged?.();
    refresh();
  };

  const doEquip = (invIndex: number): void => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    const item = run.inventory.slots[invIndex];
    if (item === null || !isEquip(item)) return;
    if (cat.lives <= 0 || !canEquip(cat, item)) return;
    const { inv } = removeSlot(run.inventory, invIndex);
    const r = equipItem(cat, item);
    let inv2 = inv;
    if (r.replaced) inv2 = addEquip(inv2, r.replaced).inv; // freed slot takes it
    const cats = run.cats.slice();
    cats[catIndex] = r.cat;
    opts.setRun({ ...run, cats, inventory: inv2 });
    opts.onChanged?.();
    refresh();
  };

  /* ---- cat tabs --------------------------------------------------------- */

  function paintTabs(run: RunState): void {
    for (const c of tabLayer.removeChildren()) c.destroy({ children: true });
    const n = run.cats.length;
    const tabW = (W - PAD * 2 - TAB_GAP * (n - 1)) / n;
    run.cats.forEach((cat, i) => {
      const dead = cat.lives <= 0;
      const selected = i === catIndex;
      const tab = new Container();
      tab.position.set(i * (tabW + TAB_GAP), 0);
      tab.addChild(
        panel(tabW, TAB_H, {
          variant: selected ? "raised" : "glass",
          radius: ROW_R,
          ...(selected ? { accent: PAL.gold } : {}),
        }),
      );
      const face = avatar(cat.classId, 40, {
        dead,
        ...(selected ? { ring: PAL.gold } : {}),
      });
      face.position.set(SPACE.md + 20, TAB_H / 2);
      tab.addChild(face);
      const name = label(CLASSES[cat.classId].catName, {
        bold: true,
        fill: dead ? PAL.textDim : catNameColor(cat.classId),
      });
      name.position.set(SPACE.md + 48, 12);
      const sub = label(
        dead
          ? "gone for good"
          : `${CLASSES[cat.classId].className} · Lv ${run.level}`,
        { dim: true, size: TYPE.tiny },
      );
      sub.position.set(SPACE.md + 48, 34);
      tab.addChild(name, sub);

      const badge = makePointBadgeAt(
        dead ? 0 : unspentPoints(cat, run.level),
        tabW - 46,
        8,
      );
      if (badge) tab.addChild(badge);

      if (dead) tab.alpha = 0.45;
      tab.eventMode = "static";
      tab.cursor = "pointer";
      tab.on("pointertap", () => {
        catIndex = i;
        pickedSkill = null;
        focus = { section: focus.section, index: 0 };
        refresh();
      });
      tabLayer.addChild(tab);
    });
  }

  /* ---- left column: portrait + XP + stat breakdown ---------------------- */

  function paintLeft(run: RunState): void {
    for (const c of leftLayer.removeChildren()) c.destroy({ children: true });
    const cat = run.cats[catIndex];
    const cls = CLASSES[cat.classId];
    const dead = cat.lives <= 0;
    const card = panel(LEFT_W, BODY_H, { variant: "glass" });
    leftLayer.addChild(card);

    const face = avatar(cat.classId, 76, { dead });
    face.position.set(SPACE.lg + 38, 68);
    card.addChild(face);

    const name = heading(cls.catName, 2, {
      fill: dead ? PAL.textDim : catNameColor(cat.classId),
    });
    name.position.set(110, 32);
    const cls2 = label(`${cls.className} · Level ${run.level}`, {
      dim: true,
      size: TYPE.small,
    });
    cls2.position.set(110, 62);
    const stand = label(`«${standName(cat.classId)}»`, {
      size: TYPE.tiny,
      fill: PAL.gold,
      bold: true,
    });
    stand.position.set(110, 82);
    card.addChild(name, cls2, stand);

    const paws = makePawRow(cat.lives);
    paws.view.position.set(110, 102);
    card.addChild(paws.view);

    const hpNow = label(`${cat.hp}/${maxHp(cat, run.level)} HP`, {
      mono: true,
      size: TYPE.tiny,
      dim: true,
    });
    hpNow.anchor.set(1, 0);
    hpNow.position.set(LEFT_W - SPACE.lg, 102);
    card.addChild(hpNow);

    // XP band
    const xp = xpProgress(run.xp, run.level);
    const xpLabel = label("XP", { mono: true, size: TYPE.tiny, dim: true });
    xpLabel.position.set(SPACE.lg, 126);
    const xpNums = label(
      xp.capped
        ? "level cap"
        : `${xp.inLevel}/${xp.span}  ·  ${xp.toNext} to Lv ${run.level + 1}`,
      { mono: true, size: TYPE.tiny, dim: true },
    );
    xpNums.anchor.set(1, 0);
    xpNums.position.set(LEFT_W - SPACE.lg, 126);
    const xpBar = bar(LEFT_W - SPACE.lg * 2, 10, { kind: "xp" });
    xpBar.view.position.set(SPACE.lg, 144);
    xpBar.set(xp.frac, 1, false);
    card.addChild(xpLabel, xpNums, xpBar.view);

    // stat breakdown table
    const head = heading("WHERE THE NUMBERS COME FROM", 3);
    head.position.set(SPACE.lg, 170);
    card.addChild(head);

    const COL = {
      stat: SPACE.lg,
      base: 132,
      pts: 186,
      gear: 240,
      tmp: 288,
      total: LEFT_W - SPACE.lg,
    };
    const headers: [string, number][] = [
      ["GROW", COL.base],
      ["PTS", COL.pts],
      ["GEAR", COL.gear],
      ["TMP", COL.tmp],
      ["TOTAL", COL.total],
    ];
    const hy = 194;
    for (const [text, x] of headers) {
      const t = label(text, { mono: true, size: TYPE.tiny, dim: true });
      t.anchor.set(1, 0);
      t.position.set(x, hy);
      card.addChild(t);
    }
    card.addChild(
      new Graphics()
        .moveTo(SPACE.lg, hy + 16)
        .lineTo(LEFT_W - SPACE.lg, hy + 16)
        .stroke({ width: 1, color: PAL.border, alpha: 0.8 }),
    );

    const rows = buildStatRows(cat, run.level);
    rows.forEach((row, i) => {
      const y = hy + 26 + i * 28;
      const name2 = label(row.label, {
        mono: true,
        bold: true,
        size: TYPE.small,
      });
      name2.position.set(COL.stat, y);
      card.addChild(name2);
      // GROW is an absolute (base + growth rows); the rest are deltas on top
      const grow = label(String(row.base), {
        mono: true,
        size: TYPE.tiny,
        dim: true,
      });
      grow.anchor.set(1, 0);
      grow.position.set(COL.base, y + 2);
      card.addChild(grow);
      const parts: [number, number, number][] = [
        [row.points, COL.pts, PAL.gold],
        [row.gear, COL.gear, PAL.energy],
        [row.temp, COL.tmp, PAL.hexer.body],
      ];
      for (const [value, x, fill] of parts) {
        const t = label(value === 0 ? "·" : `${value > 0 ? "+" : ""}${value}`, {
          mono: true,
          size: TYPE.tiny,
          fill: value === 0 ? PAL.textDim : fill,
        });
        t.anchor.set(1, 0);
        t.position.set(x, y + 2);
        t.alpha = value === 0 ? 0.4 : 1;
        card.addChild(t);
      }
      const total = label(String(row.total), {
        mono: true,
        bold: true,
        size: TYPE.body,
        fill: PAL.text,
      });
      total.anchor.set(1, 0);
      total.position.set(COL.total, y - 2);
      card.addChild(total);
      if (flashStat === row.stat) {
        total.style.fill = PAL.gold;
        total.scale.set(1.5);
        tween(total.scale, { x: 1, y: 1 }, 300, "backOut");
      }
    });
    flashStat = null;

    const legend = label(
      "GROW base + growth rows   ·   PTS Whisker Points   ·   GEAR worn   ·   TMP event buffs",
      { dim: true, size: TYPE.tiny, wrap: LEFT_W - SPACE.lg * 2 },
    );
    legend.style.lineHeight = 15;
    legend.position.set(SPACE.lg, hy + 26 + rows.length * 28 + SPACE.sm);
    card.addChild(legend);
  }

  /* ---- section tab strip ------------------------------------------------ */

  function paintSectionTabs(run: RunState): void {
    for (const c of sectionTabLayer.removeChildren()) {
      c.destroy({ children: true });
    }
    const cat = run.cats[catIndex];
    const w = (RIGHT_W - SPACE.sm * 2) / DEN_SECTIONS.length;
    DEN_SECTIONS.forEach((section, i) => {
      const on = focus.section === section;
      const left = section === "points" ? unspentPoints(cat, run.level) : 0;
      const b = button(
        left > 0
          ? `${SECTION_TITLE[section]}  (${left})`
          : SECTION_TITLE[section],
        w,
        SECTION_TAB_H,
        () => {
          focus = { section, index: 0 };
          refresh();
        },
        { primary: on, fontSize: TYPE.small },
      );
      b.view.position.set(i * (w + SPACE.sm), 0);
      sectionTabLayer.addChild(b.view);
    });
  }

  /* ---- row shell -------------------------------------------------------- */

  function rowShell(
    w: number,
    h: number,
    focused: boolean,
    accent: number | null,
    onTap: () => void,
    onHover?: () => void,
  ): Container {
    const row = new Container();
    row.addChild(
      panel(w, h, {
        variant: focused ? "raised" : "solid",
        radius: ROW_R,
        ...(focused ? { accent: PAL.gold } : accent !== null ? { accent } : {}),
      }),
    );
    row.eventMode = "static";
    row.cursor = "pointer";
    row.on("pointertap", onTap);
    row.on("pointerover", () => onHover?.());
    row.on("pointerout", clearTips);
    return row;
  }

  /* ---- section: WHISKER POINTS ------------------------------------------ */

  function paintPoints(host: Container, run: RunState): void {
    const cat = run.cats[catIndex];
    const left = unspentPoints(cat, run.level);
    const head = heading("SPEND A WHISKER POINT", 3);
    head.position.set(SPACE.md, SPACE.md);
    const count = label(left > 0 ? `${left} UNSPENT` : "all spent", {
      mono: true,
      bold: true,
      fill: left > 0 ? PAL.gold : PAL.textDim,
    });
    count.anchor.set(1, 0);
    count.position.set(RIGHT_W - SPACE.md, SPACE.md - 2);
    const sub = label(
      "One point per level, per cat. Caps are per stat — a maxed line costs " +
        "more than half a run's points.",
      { dim: true, size: TYPE.tiny, wrap: RIGHT_W - SPACE.md * 2 },
    );
    sub.position.set(SPACE.md, SPACE.md + 20);
    host.addChild(head, count, sub);

    const rows = buildPointRows(cat, run.level);
    const w = RIGHT_W - SPACE.md * 2;
    const rh = 50;
    rows.forEach((r, i) => {
      const focused = focus.section === "points" && focus.index === i;
      const row = rowShell(w, rh - 6, focused, null, () => {
        focus = { section: "points", index: i };
        doSpend(r.stat);
      });
      row.position.set(SPACE.md, 56 + i * rh);
      if (!r.canSpend) row.alpha = 0.55;

      const key = label(`${i + 1}`, {
        mono: true,
        size: TYPE.tiny,
        fill: PAL.textDim,
      });
      key.position.set(SPACE.sm, 6);
      const name = label(r.label, { bold: true, size: TYPE.body });
      name.position.set(28, 5);
      const gain = label(`+${r.amount} ${STAT_LABEL[r.stat]}`, {
        mono: true,
        bold: true,
        fill: PAL.gold,
        size: TYPE.small,
      });
      gain.position.set(120, 7);
      const desc = label(r.desc, { dim: true, size: TYPE.tiny });
      desc.position.set(28, 26);
      row.addChild(key, name, gain, desc);

      // cap pips: spent / cap
      const pips = new Graphics();
      for (let p = 0; p < r.cap; p++) {
        pips
          .roundRect(p * 12, 0, 8, 8, 2)
          .fill(p < r.spent ? PAL.gold : PAL.hpBack)
          .stroke({ width: 1, color: PAL.border });
      }
      pips.position.set(w - 200, 16);
      row.addChild(pips);

      const state =
        r.blockedBy === "capped"
          ? "MAXED"
          : r.blockedBy === "no-points"
            ? "no points"
            : "Spend";
      const b = button(state, 84, 26, () => doSpend(r.stat), {
        fontSize: TYPE.tiny,
        disabled: !r.canSpend,
        primary: r.canSpend,
      });
      b.view.position.set(w - 84 - SPACE.sm, (rh - 6 - 26) / 2);
      row.addChild(b.view);
      host.addChild(row);
    });
  }

  /* ---- section: SKILLS --------------------------------------------------- */

  function paintSkills(host: Container, run: RunState): void {
    const cat = run.cats[catIndex];
    const editable = canEditLoadout(cat, run.level);
    const head = heading("BATTLE LOADOUT — 4 GO TO WAR", 3);
    head.position.set(SPACE.md, SPACE.md - 2);
    const tip = label(
      editable
        ? "Pick a skill below, then a slot — or press 2 / 3 / 4."
        : "Learn more skills to start choosing.",
      { dim: true, size: TYPE.tiny },
    );
    tip.anchor.set(1, 0);
    tip.position.set(RIGHT_W - SPACE.md, SPACE.md);
    host.addChild(head, tip);

    const slots = loadoutSlots(cat, run.level);
    const sw = (RIGHT_W - SPACE.md * 2 - SPACE.md * 3) / LOADOUT_SIZE;
    slots.forEach((skillId, i) => {
      const locked = i === 0;
      const chip = new Container();
      chip.position.set(SPACE.md + i * (sw + SPACE.md), 30);
      const armed = pickedSkill !== null && !locked && editable;
      chip.addChild(
        panel(sw, 62, {
          variant: armed ? "raised" : "solid",
          radius: ROW_R,
          ...(armed
            ? { accent: PAL.gold }
            : locked
              ? { accent: PAL.border }
              : {}),
        }),
      );
      const num = label(locked ? "1 ⌧" : `${i + 1}`, {
        mono: true,
        size: TYPE.tiny,
        fill: locked ? PAL.textDim : PAL.gold,
      });
      num.position.set(SPACE.sm, 6);
      const nm = label(skillId ? skillName(skillId) : "— empty —", {
        bold: true,
        size: TYPE.small,
        center: true,
        fill: skillId ? PAL.text : PAL.textDim,
        wrap: sw - SPACE.sm * 2,
        align: "center",
      });
      nm.position.set(sw / 2, 24);
      chip.addChild(num, nm);
      if (skillId) {
        const def = SKILLS[skillId];
        const cost = label(locked ? "free · +1 EN" : `${def?.cost ?? 0} EN`, {
          mono: true,
          size: TYPE.tiny,
          dim: true,
          center: true,
        });
        cost.position.set(sw / 2, 46);
        chip.addChild(cost);
      }
      if (!locked && editable) {
        chip.eventMode = "static";
        chip.cursor = "pointer";
        chip.on("pointertap", () => {
          if (pickedSkill) doAssign(i, pickedSkill);
        });
      } else if (locked) {
        chip.eventMode = "static";
        chip.cursor = "help";
        chip.on("pointerover", () =>
          showTip(
            "Claw Swipe is bolted to slot 1 — it is the party's energy battery.",
            RIGHT_X + SPACE.md,
            BODY_Y + 120,
          ),
        );
        chip.on("pointerout", clearTips);
      }
      host.addChild(chip);
    });

    const listHead = heading("KNOWN SKILLS", 3);
    listHead.position.set(SPACE.md, 102);
    host.addChild(listHead);

    const rows = buildSkillRows(cat, run.level);
    const w = RIGHT_W - SPACE.md * 2;
    const rh = 34;
    rows.forEach((r, i) => {
      const focused = focus.section === "skills" && focus.index === i;
      const picked = pickedSkill === r.skillId;
      const row = rowShell(
        w,
        rh - 4,
        focused,
        picked ? PAL.gold : null,
        () => {
          focus = { section: "skills", index: i };
          onSkillActivate(r);
        },
        () =>
          showTip(
            `${r.name}\n${r.desc}`,
            RIGHT_X + SPACE.md + 60,
            BODY_Y + SECTION_TAB_H + 124 + i * rh + 24,
          ),
      );
      row.position.set(SPACE.md, 122 + i * rh);
      if (!r.known) row.alpha = 0.42;

      const stateText = !r.known
        ? `Lv ${r.unlockLevel}`
        : r.slot !== null
          ? `SLOT ${r.slot + 1}`
          : "BENCH";
      const stateFill = !r.known
        ? PAL.textDim
        : r.slot !== null
          ? PAL.gold
          : PAL.textDim;
      const state = label(stateText, {
        mono: true,
        size: TYPE.tiny,
        bold: true,
        fill: stateFill,
        center: true,
      });
      state.position.set(40, 9);
      const nm = label(r.name, {
        bold: true,
        size: TYPE.small,
        fill: r.known ? PAL.text : PAL.textDim,
      });
      nm.position.set(76, 7);
      const cost = label(
        r.cooldown !== undefined
          ? `${r.cost} EN · CD ${r.cooldown}`
          : `${r.cost} EN`,
        { mono: true, size: TYPE.tiny, fill: PAL.energy },
      );
      cost.anchor.set(1, 0);
      cost.position.set(w - SPACE.sm, 9);
      const desc = label(oneLine(r.desc, 70), { dim: true, size: TYPE.tiny });
      desc.position.set(250, 8);
      row.addChild(state, nm, cost, desc);
      host.addChild(row);
    });

    if (pickedSkill !== null) {
      const armedTip = label(
        `${skillName(pickedSkill)} selected — click a slot or press 2 / 3 / 4.`,
        { fill: PAL.gold, size: TYPE.tiny, bold: true },
      );
      armedTip.position.set(SPACE.md, 102);
      armedTip.anchor.set(0, 0);
      armedTip.x = SPACE.md + 130;
      host.addChild(armedTip);
    }
  }

  function onSkillActivate(r: SkillRow): void {
    if (!r.known) {
      opts.toast?.(`${r.name} unlocks at level ${r.unlockLevel}.`);
      return;
    }
    if (r.basic) {
      opts.toast?.("Claw Swipe never leaves slot 1.");
      return;
    }
    pickedSkill = pickedSkill === r.skillId ? null : r.skillId;
    refresh();
  }

  /* ---- section: GEAR ----------------------------------------------------- */

  function paintGear(host: Container, run: RunState): void {
    const cat = run.cats[catIndex];
    const worn = buildGearRows(cat);
    const cw = (RIGHT_W - SPACE.md * 2 - SPACE.md * 2) / worn.length;

    worn.forEach((g, i) => {
      const focused = focus.section === "gear" && focus.index === i;
      const card = rowShell(
        cw,
        98,
        focused,
        g.item ? RARITY_COLOR[g.item.rarity] : null,
        () => {
          focus = { section: "gear", index: i };
          if (g.item) doUnequip(g.slot);
        },
      );
      card.position.set(SPACE.md + i * (cw + SPACE.md), SPACE.sm);
      const slotName = heading(g.slot.toUpperCase(), 3);
      slotName.position.set(SPACE.sm, 6);
      card.addChild(slotName);
      if (!g.item) {
        const empty = label("empty", { dim: true, size: TYPE.small });
        empty.position.set(SPACE.sm, 40);
        card.addChild(empty);
      } else {
        const item = g.item;
        const art = makeSpriteIcon(itemSpriteId(item), 30);
        if (art) {
          art.position.set(SPACE.sm + 15, 44);
          card.addChild(art);
        } else {
          const icon = label(EQUIP_DEFS[item.defId].icon, {
            mono: true,
            size: TYPE.h3,
            center: true,
            fill: RARITY_COLOR[item.rarity],
          });
          icon.position.set(SPACE.sm + 15, 44);
          card.addChild(icon);
        }
        const nm = label(equipName(item), {
          bold: true,
          size: TYPE.small,
          fill: RARITY_COLOR[item.rarity],
          wrap: cw - 44,
        });
        nm.position.set(SPACE.sm + 32, 28);
        const stats = label(
          `${equipStatsText(item)}   (${item.rarity} L${item.itemLevel})`,
          { mono: true, dim: true, size: TYPE.tiny, wrap: cw - 44 },
        );
        stats.position.set(SPACE.sm + 32, 58);
        card.addChild(nm, stats);
        if (item.hook) {
          const hook = label(
            `✦ ${HOOK_TEXT[item.hook]}${item.hookSpent === true ? " (spent)" : ""}`,
            {
              size: TYPE.tiny,
              fill: item.hookSpent === true ? PAL.textDim : PAL.stFrazzled,
              wrap: cw - SPACE.sm * 2,
            },
          );
          hook.style.lineHeight = 13;
          hook.position.set(SPACE.sm, 74);
          card.addChild(hook);
        }
        const off = label("click / Enter to take off", {
          dim: true,
          size: TYPE.tiny,
        });
        off.anchor.set(1, 0);
        off.position.set(cw - SPACE.sm, 6);
        card.addChild(off);
      }
      host.addChild(card);
    });

    const listHead = heading("IN THE BACKPACK", 3);
    listHead.position.set(SPACE.md, 116);
    host.addChild(listHead);

    const rows = buildBackpackRows(run, catIndex);
    const w = RIGHT_W - SPACE.md * 2;
    const rh = 40;
    const VISIBLE = 5;
    if (rows.length === 0) {
      const empty = label(
        "Nothing in the backpack fits this cat. Weapons are class-locked; " +
          "trinkets and collars are universal.",
        { dim: true, size: TYPE.tiny, wrap: w },
      );
      empty.position.set(SPACE.md, 142);
      host.addChild(empty);
      return;
    }
    const cursor = Math.max(0, focus.index - EQUIP_SLOTS.length);
    const start =
      focus.section === "gear"
        ? Math.max(0, Math.min(rows.length - VISIBLE, cursor - VISIBLE + 1))
        : 0;
    rows.slice(start, start + VISIBLE).forEach((r, k) => {
      const i = start + k;
      const focused =
        focus.section === "gear" && focus.index === EQUIP_SLOTS.length + i;
      const row = rowShell(
        w,
        rh - 4,
        focused,
        RARITY_COLOR[r.item.rarity],
        () => {
          focus = { section: "gear", index: EQUIP_SLOTS.length + i };
          doEquip(r.index);
        },
      );
      row.position.set(SPACE.md, 138 + k * rh);
      const art = makeSpriteIcon(itemSpriteId(r.item), 26);
      if (art) {
        art.position.set(SPACE.sm + 13, (rh - 4) / 2);
        row.addChild(art);
      } else {
        const icon = label(EQUIP_DEFS[r.item.defId].icon, {
          mono: true,
          size: TYPE.h3,
          center: true,
          fill: RARITY_COLOR[r.item.rarity],
        });
        icon.position.set(SPACE.sm + 13, (rh - 4) / 2);
        row.addChild(icon);
      }
      const nm = label(equipName(r.item), {
        bold: true,
        size: TYPE.small,
        fill: RARITY_COLOR[r.item.rarity],
      });
      nm.position.set(38, 4);
      const sub = label(
        `${r.slot} · ${r.item.rarity} L${r.item.itemLevel} · ${equipStatsText(r.item)}`,
        { mono: true, dim: true, size: TYPE.tiny },
      );
      sub.position.set(38, 20);
      const delta = label(r.delta, {
        mono: true,
        size: TYPE.tiny,
        fill: r.delta === "no change" ? PAL.textDim : PAL.energy,
      });
      delta.anchor.set(1, 0);
      delta.position.set(w - SPACE.sm, 12);
      row.addChild(nm, sub, delta);
      host.addChild(row);
    });
    if (rows.length > VISIBLE) {
      const more = label(`${rows.length} pieces fit — ↑ ↓ to scroll`, {
        dim: true,
        size: TYPE.tiny,
        mono: true,
      });
      more.anchor.set(1, 0);
      more.position.set(RIGHT_W - SPACE.md, 118);
      host.addChild(more);
    }
  }

  /* ---- repaint ----------------------------------------------------------- */

  function refresh(): void {
    if (destroyed) return;
    const run = opts.getRun();
    if (catIndex >= run.cats.length) catIndex = 0;
    clearTips();
    const counts = sectionCounts();
    if (focus.index >= counts[focus.section]) {
      focus = { section: focus.section, index: 0 };
    }
    const total = totalUnspentPoints(run);
    unspentText.text =
      total > 0
        ? `${total} WHISKER POINT${total === 1 ? "" : "S"} UNSPENT`
        : "every point spent";
    unspentText.style.fill = total > 0 ? PAL.gold : PAL.textDim;

    paintTabs(run);
    paintLeft(run);
    paintSectionTabs(run);

    for (const c of sectionLayer.removeChildren())
      c.destroy({ children: true });
    const body = panel(RIGHT_W, SECTION_H, { variant: "glass" });
    sectionLayer.addChild(body);
    const dead = run.cats[catIndex].lives <= 0;
    if (dead) {
      const gone = label(
        `${CLASSES[run.cats[catIndex].classId].catName} is out of Lives — ` +
          "nothing left to plan.",
        { dim: true, size: TYPE.body, wrap: RIGHT_W - SPACE.lg * 2 },
      );
      gone.position.set(SPACE.lg, SPACE.lg);
      body.addChild(gone);
      return;
    }
    if (focus.section === "points") paintPoints(body, run);
    else if (focus.section === "skills") paintSkills(body, run);
    else paintGear(body, run);
  }

  refresh();

  /* ---- keys --------------------------------------------------------------- */

  const selectCat = (delta: number): void => {
    const run = opts.getRun();
    const n = run.cats.length;
    catIndex = (((catIndex + delta) % n) + n) % n;
    pickedSkill = null;
    focus = { section: focus.section, index: 0 };
    refresh();
  };

  const activateFocused = (): void => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    if (cat.lives <= 0) return;
    if (focus.section === "points") {
      const row = buildPointRows(cat, run.level)[focus.index];
      if (row) doSpend(row.stat);
      return;
    }
    if (focus.section === "skills") {
      const row = buildSkillRows(cat, run.level)[focus.index];
      if (row) onSkillActivate(row);
      return;
    }
    if (focus.index < EQUIP_SLOTS.length) {
      const g = buildGearRows(cat)[focus.index];
      if (g?.item) doUnequip(g.slot);
      return;
    }
    const b = buildBackpackRows(run, catIndex)[
      focus.index - EQUIP_SLOTS.length
    ];
    if (b) doEquip(b.index);
  };

  const quickKey = (n: number): void => {
    const run = opts.getRun();
    const cat = run.cats[catIndex];
    if (cat.lives <= 0) return;
    if (focus.section === "points") {
      const row = buildPointRows(cat, run.level)[n - 1];
      if (row) doSpend(row.stat);
      return;
    }
    if (focus.section === "skills") {
      const rows = buildSkillRows(cat, run.level);
      const source = pickedSkill ?? rows[focus.index]?.skillId ?? null;
      if (n === 1) {
        opts.toast?.("Claw Swipe never leaves slot 1.");
        return;
      }
      if (n <= LOADOUT_SIZE && source) doAssign(n - 1, source);
      return;
    }
    const counts = sectionCounts();
    if (n <= counts.gear) {
      focus = { section: "gear", index: n - 1 };
      activateFocused();
    }
  };

  return {
    view,
    refresh,
    onKey(key: string): boolean {
      if (key === "esc" || key === "p") {
        opts.onClose?.();
        return true;
      }
      if (key === "tab" || key === "right" || key === "d") {
        selectCat(1);
        return true;
      }
      if (key === "left" || key === "a") {
        selectCat(-1);
        return true;
      }
      if (key === "up" || key === "w") {
        focus = moveFocus(focus, sectionCounts()[focus.section], -1);
        refresh();
        return true;
      }
      if (key === "down" || key === "s") {
        focus = moveFocus(focus, sectionCounts()[focus.section], 1);
        refresh();
        return true;
      }
      if (key === "q" || key === "e") {
        focus = cycleSection(focus, sectionCounts(), key === "q" ? -1 : 1);
        refresh();
        return true;
      }
      if (key === "enter" || key === "space") {
        activateFocused();
        return true;
      }
      const n = "123456789".indexOf(key);
      if (n >= 0) {
        quickKey(n + 1);
        return true;
      }
      return false;
    },
    destroy(): void {
      destroyed = true;
      view.destroy({ children: true });
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Level-up flourish (hosted by the loot overlay)                          */
/* ---------------------------------------------------------------------- */

const LEVELUP_TITLE_H = 30;
const LEVELUP_SUB_H = 20;
const LEVELUP_CAT_H = 20;
const LEVELUP_SKILL_H = 22;
const LEVELUP_FOOT_H = 22;

/**
 * Exact height `makeLevelUpCard` will occupy — hosts that measure their panel
 * before building it (the loot overlay does) call this first.
 */
export function levelUpCardHeight(
  cats: readonly CatRunState[],
  fromLevel: number,
  toLevel: number,
): number {
  const s = buildLevelUpSummary(cats, fromLevel, toLevel);
  if (s.toLevel <= s.fromLevel) return 0;
  const skills = s.cats.reduce((n, c) => n + c.newSkills.length, 0);
  return (
    LEVELUP_TITLE_H +
    LEVELUP_SUB_H +
    s.cats.length * LEVELUP_CAT_H +
    skills * LEVELUP_SKILL_H +
    LEVELUP_FOOT_H
  );
}

/**
 * THE level-up moment: the new level, what each cat's growth row gave it, any
 * milestone skill it just learned (with the Stand that throws it), and the
 * standing invitation to go spend the Whisker Points it earned.
 */
export function makeLevelUpCard(
  cats: readonly CatRunState[],
  fromLevel: number,
  toLevel: number,
  width: number,
): { view: Container; height: number } {
  const s = buildLevelUpSummary(cats, fromLevel, toLevel);
  const view = new Container();
  let y = 0;

  const title = heading(`LEVEL UP!  Lv ${s.toLevel}`, 2, { fill: PAL.gold });
  title.position.set(0, 0);
  view.addChild(title);
  // gold flash: 3 alpha pulses, the same beat the old toast used
  const pulse = (n: number): void => {
    if (n <= 0 || title.destroyed) return;
    tween(title, { alpha: 0.3 }, 140, "linear", () => {
      if (title.destroyed) return;
      tween(title, { alpha: 1 }, 140, "linear", () => pulse(n - 1));
    });
  };
  pulse(3);
  y += LEVELUP_TITLE_H;

  const sub = label(
    s.pointsEach === 1
      ? "Every cat earns a Whisker Point."
      : `Every cat earns ${s.pointsEach} Whisker Points.`,
    { size: TYPE.small, fill: PAL.gold },
  );
  sub.position.set(0, y);
  view.addChild(sub);
  y += LEVELUP_SUB_H;

  for (const c of s.cats) {
    const cls = CLASSES[c.classId];
    const line = label(cls.catName, {
      bold: true,
      size: TYPE.small,
      fill: catNameColor(c.classId),
    });
    line.position.set(0, y);
    const gains = label(
      c.gains.length > 0
        ? c.gains
            .map((g) => `${g.label} ${g.amount > 0 ? "+" : ""}${g.amount}`)
            .join("   ")
        : "—",
      { mono: true, size: TYPE.tiny, dim: true },
    );
    gains.position.set(110, y + 3);
    view.addChild(line, gains);
    y += LEVELUP_CAT_H;

    for (const id of c.newSkills) {
      const learn = label(
        `«${standName(c.classId)}» learns ${skillName(id).toUpperCase()}`,
        { size: TYPE.small, bold: true, fill: PAL.stFrazzled, wrap: width },
      );
      learn.position.set(SPACE.md, y);
      view.addChild(learn);
      y += LEVELUP_SKILL_H;
    }
  }

  const foot = label(
    "Open THE DEN (P — the Landing or the pause menu) to spend them.",
    { dim: true, size: TYPE.tiny, wrap: width },
  );
  foot.position.set(0, y + 4);
  view.addChild(foot);
  y += LEVELUP_FOOT_H;

  return { view, height: y };
}

/* ---------------------------------------------------------------------- */
/* Host helper: the Den as a full-screen modal box                         */
/* ---------------------------------------------------------------------- */

/**
 * The Den centered on screen with its own panel geometry — used by both
 * hosts (landing scene, pause overlay) so the screen looks identical from
 * either entry point. The caller supplies the scrim.
 */
export function makeDenBox(opts: ProgressPanelOpts): ProgressPanelApi {
  const api = makeProgressPanel(opts);
  api.view.position.set((DESIGN_W - PROGRESS_PANEL_W) / 2, 46);
  return api;
}

/** Kept next to both Den entry points so the hotkey never drifts apart. */
export const DEN_HOTKEY = "P";
export const DEN_LABEL = "The Den";
