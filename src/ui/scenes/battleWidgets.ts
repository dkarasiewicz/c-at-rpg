/**
 * WP-11 — battle HUD widgets (ui-art §8): initiative ribbon, skill bar with
 * range strips + move glyphs + disabled reasons, active-cat panel, Cat Pile
 * banner, boss Poise pips, charge telegraph, nameplates, targeting preview
 * chips and the ghost shove arrow. Pure presentation: every widget is fed
 * engine state / values and never computes gameplay outcomes.
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { BattleState, Combatant, Skill, StatusId } from "../../core/types";
import { ENEMIES } from "../../content/enemies";
import { PAL, darken } from "../palette";
import { R, RADIUS, rh, rw } from "../layout";
import { display, mono, ui } from "../textStyles";
import { tween } from "../tween";
import {
  makeButton,
  makeEnergyPips,
  makePawRow,
  makeStatusChip,
  STATUS_STYLE,
  type PipRow,
} from "../widgets";
import { drawCat, drawCatPortrait } from "../draw/cats";
import { drawEnemy, makeHeavyGlyph, makeTierChevrons } from "../draw/enemies";
import { catTexture, enemyTexture, portraitTexture } from "../sprites";

/** Greyed tint for KO'd sprite portraits (procedural uses KO_GREY fills). */
const KO_TINT = 0x777788;

/* ---------------------------------------------------------------------- */
/* Initiative ribbon (ui-art §8)                                           */
/* ---------------------------------------------------------------------- */

const CHIP = 44;
const CHIP_GAP = 8;

interface RibbonChip {
  entryIndex: number;
  combatantId: string;
  box: Container;
  bg: Graphics;
  frazzle: Container;
  collapsed: boolean;
}

export interface Ribbon {
  view: Container;
  /** Rebuild all chips from the frozen round queue. */
  setRound(state: BattleState): void;
  /** Re-style: acted-dim, current-actor pop, frazzle glyphs, death collapse. */
  refresh(state: BattleState): void;
}

/** Small portrait for a combatant (cat head / enemy silhouette), ~36px. */
export function makeMiniPortrait(c: Combatant, size = 36): Container {
  const holder = new Container();
  // generated portrait/sprite when available (visual-v2), procedural else
  const tex =
    c.side === "cat" && c.classId
      ? portraitTexture(c.classId)
      : enemyTexture(c.speciesId ?? "");
  if (tex) {
    const sp = new Sprite({ texture: tex, anchor: 0.5 });
    sp.scale.set(size / Math.max(tex.width, tex.height));
    if (c.ko) sp.tint = KO_TINT;
    holder.addChild(sp);
    return holder;
  }
  const g = new Graphics();
  if (c.side === "cat" && c.classId) {
    drawCatPortrait(g, c.classId, c.ko);
    g.scale.set(size / 52);
  } else {
    const def = ENEMIES[c.speciesId ?? ""];
    if (def) {
      drawEnemy(g, def.look);
      const grade =
        def.look.sizeGrade === "boss"
          ? 1.6
          : def.look.sizeGrade === "elite"
            ? 1.25
            : def.look.sizeGrade === "minion"
              ? 0.85
              : 1;
      g.scale.set(size / (104 * grade));
      g.position.y = size / 2;
    }
  }
  holder.addChild(g);
  return holder;
}

export function makeRibbon(): Ribbon {
  const view = new Container();
  const h = rh(R.combat.ribbon);
  let chips: RibbonChip[] = [];
  let tail: Container | null = null;

  const layout = (animate: boolean): void => {
    let x = 0;
    for (const chip of chips) {
      if (chip.collapsed) continue;
      const cx = x + CHIP / 2; // chips pivot on their center
      if (animate) tween(chip.box, { x: cx }, 150);
      else chip.box.x = cx;
      x += CHIP + CHIP_GAP;
    }
    if (tail) tail.x = x;
  };

  const ribbon: Ribbon = {
    view,

    setRound(state: BattleState): void {
      view.removeChildren().forEach((c) => c.destroy({ children: true }));
      chips = [];
      tail = null;
      const perId: Record<string, number> = {};
      for (const e of state.queue) {
        perId[e.combatantId] = (perId[e.combatantId] ?? 0) + 1;
      }
      state.queue.forEach((entry, entryIndex) => {
        const c = state.combatants.find((x) => x.id === entry.combatantId);
        if (!c) return;
        const box = new Container();
        box.y = (h - CHIP) / 2;
        const bg = new Graphics();
        box.addChild(bg);
        const face = makeMiniPortrait(c);
        face.position.set(CHIP / 2, CHIP / 2);
        box.addChild(face);
        if ((perId[c.id] ?? 0) >= 2) {
          const tag = new Text({ text: "×2", style: mono(11) });
          tag.anchor.set(1, 1);
          tag.position.set(CHIP - 2, CHIP - 1);
          box.addChild(tag);
        }
        const frazzle = new Container();
        const fz = new Text({
          text: STATUS_STYLE.frazzled.glyph,
          style: mono(16, { fill: PAL.stFrazzled }),
        });
        fz.anchor.set(0.5);
        fz.position.set(CHIP / 2, CHIP / 2);
        frazzle.addChild(fz);
        frazzle.visible = false;
        box.addChild(frazzle);
        box.pivot.set(CHIP / 2, CHIP / 2);
        box.position.x += CHIP / 2;
        box.position.y += CHIP / 2;
        view.addChild(box);
        chips.push({
          entryIndex,
          combatantId: c.id,
          box,
          bg,
          frazzle,
          collapsed: false,
        });
      });
      // end-of-round divider + "next round…" (order never shown, only implied)
      tail = new Container();
      const div = new Graphics()
        .rect(0, (h - CHIP) / 2, 2, CHIP)
        .fill(PAL.border);
      tail.addChild(div);
      const next = new Text({
        text: "next round…",
        style: ui(11, { fill: PAL.textDim }),
      });
      next.anchor.set(0, 0.5);
      next.position.set(10, h / 2);
      tail.addChild(next);
      view.addChild(tail);
      ribbon.refresh(state);
      layout(false);
    },

    refresh(state: BattleState): void {
      // current = first unacted entry whose combatant is alive
      let currentIndex = -1;
      for (let i = 0; i < state.queue.length; i++) {
        const entry = state.queue[i];
        const c = state.combatants.find((x) => x.id === entry.combatantId);
        if (!entry.acted && c && !c.ko && c.hp > 0) {
          currentIndex = i;
          break;
        }
      }
      let anyCollapsed = false;
      for (const chip of chips) {
        const entry = state.queue[chip.entryIndex];
        const c = state.combatants.find((x) => x.id === chip.combatantId);
        if (!entry || !c) continue;
        const dead = c.ko || c.hp <= 0;
        if (dead && !chip.collapsed) {
          chip.collapsed = true;
          anyCollapsed = true;
          tween(chip.box.scale, { x: 0 }, 150);
        }
        if (chip.collapsed) continue;
        const current = chip.entryIndex === currentIndex;
        chip.box.alpha = entry.acted ? 0.35 : 1;
        chip.frazzle.visible = c.statuses.some((s) => s.id === "frazzled");
        const scale = current ? 56 / CHIP : 1;
        tween(chip.box.scale, { x: scale, y: scale }, 120);
        tween(
          chip.box,
          { y: (h - CHIP) / 2 + CHIP / 2 - (current ? 4 : 0) },
          120,
        );
        chip.bg
          .clear()
          .roundRect(0, 0, CHIP, CHIP, RADIUS.button)
          .fill(c.side === "cat" ? PAL.panelLite : PAL.panel)
          .stroke({
            width: current ? 2 : 1,
            color: current ? PAL.gold : PAL.border,
          });
      }
      if (anyCollapsed) layout(true);
    },
  };
  return ribbon;
}

/* ---------------------------------------------------------------------- */
/* Range strip (ui-art §8 skill bar): nine 8×8 squares + move glyphs       */
/* ---------------------------------------------------------------------- */

/**
 * Cat ranks 4..1 (gold when in `usableFrom`), a 4px gap, enemy/ally ranks
 * 1..5 (danger for enemy targets, heal for ally/self); `row` pattern
 * underlines the target half 2px. Move glyphs: `moveTarget` "→N"/"←N" in
 * PAL.offBal, `moveSelf` in PAL.energy.
 */
export function makeRangeStrip(skill: Skill): Container {
  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  const sq = 8;
  const gap = 2;
  let x = 0;
  for (let rank = 4; rank >= 1; rank--) {
    g.rect(x, 0, sq, sq).fill(
      skill.usableFrom.includes(rank) ? PAL.gold : PAL.hpBack,
    );
    x += sq + gap;
  }
  x += 4; // the gap glyph
  const targetColor = skill.target.side === "enemy" ? PAL.danger : PAL.heal;
  const targetX = x;
  for (let rank = 1; rank <= 5; rank++) {
    g.rect(x, 0, sq, sq).fill(
      skill.target.ranks.includes(rank) ? targetColor : PAL.hpBack,
    );
    x += sq + gap;
  }
  if (skill.target.pattern === "row") {
    g.rect(targetX, sq + 2, 5 * sq + 4 * gap, 2).fill(targetColor);
  }
  const arrow = (n: number, self: boolean): string => {
    // enemy-side push (+) moves right; a cat retreating (+) moves left
    const dir = self ? (n > 0 ? "←" : "→") : n > 0 ? "→" : "←";
    return `${dir}${Math.abs(n)}`;
  };
  const parts: { text: string; color: number }[] = [];
  if (skill.moveTarget) {
    parts.push({ text: arrow(skill.moveTarget, false), color: PAL.offBal });
  }
  if (skill.moveSelf) {
    parts.push({ text: arrow(skill.moveSelf, true), color: PAL.energy });
  }
  let tx = x + 4;
  for (const p of parts) {
    const t = new Text({ text: p.text, style: mono(11, { fill: p.color }) });
    t.position.set(tx, -1);
    view.addChild(t);
    tx += t.width + 4;
  }
  return view;
}

/* ---------------------------------------------------------------------- */
/* Skill bar (6 slots, hotkeys 1-6)                                        */
/* ---------------------------------------------------------------------- */

export interface SlotSpec {
  kind: "skill" | "guard" | "item";
  label: string;
  /** skill data drives cost pips + the range strip (guard/item: none). */
  skill?: Skill;
  cost?: number;
  ok: boolean;
  /** shown in the tooltip when disabled ("Needs rank 3–4 — …"). */
  reason?: string;
}

export interface SkillBar {
  view: Container;
  /** 6 entries, index = hotkey-1; null = empty slot. */
  set(slots: (SlotSpec | null)[]): void;
  setSelected(i: number | null): void;
  /** Wire before use; fired on slot click (enabled slots only). */
  onSlot: ((i: number) => void) | null;
  /** Design-space top-center of slot i (for the item flyout anchor). */
  slotTop(i: number): { x: number; y: number };
}

export function makeSkillBar(): SkillBar {
  const view = new Container();
  const barBg = makeSlotPanel(rw(R.combat.skillBar), rh(R.combat.skillBar));
  barBg.position.set(R.combat.skillBar[0], R.combat.skillBar[1]);
  view.addChild(barBg);
  const slotViews: Container[] = [];
  let specs: (SlotSpec | null)[] = [];
  let selected: number | null = null;

  const bar: SkillBar = {
    view,
    onSlot: null,

    slotTop(i: number) {
      const r = R.combat.slotRects[i] ?? R.combat.slotRects[0];
      return { x: r[0] + r[2] / 2, y: r[1] };
    },

    set(next: (SlotSpec | null)[]): void {
      specs = next;
      for (const v of slotViews) v.destroy({ children: true });
      slotViews.length = 0;
      next.forEach((spec, i) => {
        const rect = R.combat.slotRects[i];
        if (!rect) return;
        const slot = buildSlot(spec, i, selected === i, () => {
          if (spec?.ok) bar.onSlot?.(i);
        });
        slot.position.set(rect[0], rect[1]);
        view.addChild(slot);
        slotViews.push(slot);
      });
    },

    setSelected(i: number | null): void {
      selected = i;
      bar.set(specs);
    },
  };
  return bar;
}

function makeSlotPanel(w: number, h: number): Graphics {
  return new Graphics()
    .roundRect(0, 0, w, h, RADIUS.panel)
    .fill({ color: PAL.panel, alpha: 0.92 })
    .stroke({ width: 2, color: PAL.border });
}

function buildSlot(
  spec: SlotSpec | null,
  index: number,
  selected: boolean,
  onTap: () => void,
): Container {
  const w = 128;
  const h = 112;
  const slot = new Container();
  const bg = new Graphics()
    .roundRect(0, 0, w, h, RADIUS.button)
    .fill(spec ? (spec.ok ? PAL.panelLite : PAL.panel) : PAL.panel)
    .stroke({
      width: 2,
      color: selected ? PAL.gold : PAL.border,
    });
  if (!spec) bg.alpha = 0.4;
  slot.addChild(bg);
  if (!spec) return slot;

  // hotkey chip
  const chipBg = new Graphics()
    .roundRect(0, 0, 16, 16, RADIUS.chip)
    .fill(spec.ok ? PAL.gold : PAL.panel)
    .stroke({ width: 1, color: spec.ok ? PAL.goldDark : PAL.border });
  chipBg.position.set(8, 8);
  const chipNum = new Text({
    text: String(index + 1),
    style: mono(12, { fill: spec.ok ? PAL.textDark : PAL.textDim }),
  });
  chipNum.anchor.set(0.5);
  chipNum.position.set(16, 16);
  slot.addChild(chipBg, chipNum);

  // name (wraps to 2 lines)
  const name = new Text({
    text: spec.label,
    style: ui(14, {
      fontWeight: "bold",
      fill: spec.ok ? PAL.text : PAL.textDim,
      wordWrap: true,
      wordWrapWidth: w - 40,
    }),
  });
  name.position.set(30, 7);
  slot.addChild(name);

  // cost row
  const costY = 56;
  const cost = spec.kind === "skill" ? (spec.cost ?? 0) : 0;
  if (spec.kind === "guard") {
    const t = new Text({
      text: "+2 energy",
      style: ui(11, { fill: PAL.energy }),
    });
    t.position.set(8, costY);
    slot.addChild(t);
  } else if (spec.kind === "item") {
    const t = new Text({
      text: "consumables",
      style: ui(11, { fill: spec.ok ? PAL.text : PAL.textDim }),
    });
    t.position.set(8, costY);
    slot.addChild(t);
  } else if (cost <= 0) {
    const t = new Text({ text: "FREE", style: ui(11, { fill: PAL.textDim }) });
    t.position.set(8, costY);
    slot.addChild(t);
  } else {
    const g = new Graphics();
    for (let i = 0; i < cost; i++) {
      g.roundRect(8 + i * 8, costY, 6, 8, 2).fill(PAL.energy);
    }
    slot.addChild(g);
  }

  // range strip
  if (spec.skill) {
    const strip = makeRangeStrip(spec.skill);
    strip.position.set(8, 86);
    if (!spec.ok) strip.alpha = 0.5;
    slot.addChild(strip);
  }

  // interaction + tooltip (reason for disabled slots, desc otherwise)
  slot.eventMode = "static";
  slot.cursor = spec.ok ? "pointer" : "default";
  slot.on("pointertap", onTap);
  const tipText = spec.ok
    ? (spec.skill?.desc ?? "")
    : (spec.reason ?? "unavailable");
  if (tipText) {
    let tip: Container | null = null;
    slot.on("pointerover", () => {
      if (tip) return;
      tip = makeSlotTooltip(tipText);
      tip.position.set(0, -tip.height - 6);
      slot.addChild(tip);
    });
    slot.on("pointerout", () => {
      tip?.destroy({ children: true });
      tip = null;
    });
  }
  return slot;
}

function makeSlotTooltip(text: string): Container {
  const view = new Container();
  const txt = new Text({
    text,
    style: ui(14, { wordWrap: true, wordWrapWidth: 260 }),
  });
  txt.position.set(8, 6);
  view.addChild(
    new Graphics()
      .roundRect(0, 0, Math.ceil(txt.width) + 16, Math.ceil(txt.height) + 12, 6)
      .fill(PAL.panelLite)
      .stroke({ width: 2, color: PAL.border }),
    txt,
  );
  return view;
}

/* ---------------------------------------------------------------------- */
/* Active panel (408×128)                                                  */
/* ---------------------------------------------------------------------- */

export interface ActivePanel {
  view: Container;
  set(c: Combatant | null): void;
}

export function makeActivePanel(): ActivePanel {
  const view = new Container();
  const w = rw(R.combat.activePanel);
  const h = rh(R.combat.activePanel);
  view.addChild(makeSlotPanel(w, h));
  const content = new Container();
  view.addChild(content);

  return {
    view,
    set(c: Combatant | null): void {
      content.removeChildren().forEach((x) => x.destroy({ children: true }));
      view.visible = c !== null;
      if (!c || c.side !== "cat" || !c.classId) return;

      const tex = catTexture(c.classId);
      if (tex) {
        const sp = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
        sp.scale.set((h - 20) / tex.height);
        sp.position.set(58, h - 10);
        if (c.ko) sp.tint = KO_TINT;
        content.addChild(sp);
      } else {
        const portrait = new Graphics();
        drawCat(portrait, c.classId, "battle", 0.95, c.ko);
        portrait.position.set(58, h - 10);
        content.addChild(portrait);
      }

      const name = new Text({
        text: `${c.name} — ${c.classId}`,
        style: ui(14, { fontWeight: "bold" }),
      });
      name.position.set(118, 10);
      content.addChild(name);

      // big energy readout: 10 pips 10×14 + "6/10"
      const pips: PipRow = makeEnergyPips(c.stats.enMax || 10, 10, 14, 2);
      pips.view.position.set(118, 36);
      pips.set(c.energy);
      content.addChild(pips.view);
      const en = new Text({
        text: `${c.energy}/${c.stats.enMax}`,
        style: mono(14, { fill: PAL.energy }),
      });
      en.position.set(118 + (c.stats.enMax || 10) * 12 + 6, 36);
      content.addChild(en);

      // Lives paw row
      const paws = makePawRow(c.lives ?? 0);
      paws.view.position.set(118, 62);
      content.addChild(paws.view);

      // current statuses with durations
      let sx = 118;
      for (const st of c.statuses) {
        const chip = makeStatusChip(st.id, st.value || undefined);
        chip.position.set(sx, 84);
        content.addChild(chip);
        if (st.id === "scratched" || st.id === "mending") {
          const d = new Text({
            text: `${st.duration}r`,
            style: mono(11, { fill: PAL.textDim }),
          });
          d.position.set(sx + 2, 102);
          content.addChild(d);
        }
        sx += 26;
      }
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Cat Pile banner                                                         */
/* ---------------------------------------------------------------------- */

export interface CatPileBanner {
  view: Container;
  shown: boolean;
  show(damageEach: number, onAccept: () => void, onDecline: () => void): void;
  /** Collapses in 150ms. */
  hide(): void;
}

export function makeCatPileBanner(): CatPileBanner {
  const [bx, by, bw, bh] = R.combat.catPileBanner;
  const view = new Container();
  view.visible = false;

  const banner: CatPileBanner = {
    view,
    shown: false,

    show(damageEach, onAccept, onDecline): void {
      view.removeChildren().forEach((c) => c.destroy({ children: true }));
      banner.shown = true;
      view.visible = true;
      const panel = new Graphics()
        .roundRect(0, 0, bw, bh, RADIUS.panel)
        .fill({ color: PAL.panel, alpha: 0.96 })
        .stroke({ width: 3, color: PAL.gold });
      view.addChild(panel);
      const title = new Text({
        text: "CAT PILE?!",
        style: display(40, { fill: PAL.gold }),
      });
      title.anchor.set(0.5, 0);
      title.position.set(bw / 2, 8);
      view.addChild(title);
      const sub = new Text({
        text: `each enemy takes ${damageEach} — or keep them Off-Balance…`,
        style: ui(14, { fill: PAL.textDim }),
      });
      sub.anchor.set(0.5, 0);
      sub.position.set(bw / 2, 60);
      view.addChild(sub);
      const pile = makeButton("[Enter] PILE ON", 220, 40, onAccept, {
        primary: true,
        fontSize: 16,
      });
      pile.view.position.set(bw / 2 - 240, bh - 52);
      view.addChild(pile.view);
      const hold = makeButton("[Esc] hold", 160, 40, onDecline, {
        fontSize: 16,
      });
      hold.view.position.set(bw / 2 + 40, bh - 52);
      view.addChild(hold.view);
      // slide down into place
      view.position.set(bx, by - 80);
      view.alpha = 0;
      tween(view, { y: by, alpha: 1 }, 180, "backOut");
    },

    hide(): void {
      if (!banner.shown) return;
      banner.shown = false;
      tween(view, { y: by - 40, alpha: 0 }, 150, "quadOut", () => {
        view.visible = false;
      });
    },
  };
  return banner;
}

/* ---------------------------------------------------------------------- */
/* Poise pips (boss)                                                       */
/* ---------------------------------------------------------------------- */

export interface PoisePips {
  view: Container;
  set(left: number): void;
}

/** N diamonds 12×12 (rotated squares); spent = track fill + gold outline. */
export function makePoisePips(max: number): PoisePips {
  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  const paint = (left: number): void => {
    g.clear();
    for (let i = 0; i < max; i++) {
      const cx = i * 18 + 6;
      const full = i < left;
      g.poly([cx, -6, cx + 6, 0, cx, 6, cx - 6, 0])
        .fill(full ? PAL.gold : PAL.hpBack)
        .stroke({ width: 1.5, color: full ? PAL.goldDark : PAL.gold });
    }
  };
  paint(max);
  return { view, set: paint };
}

/* ---------------------------------------------------------------------- */
/* Charge telegraph (boss windup)                                          */
/* ---------------------------------------------------------------------- */

export interface ChargeMark {
  view: Container;
  /** Bounce ±6px at 2Hz — call from the scene's update. */
  update(elapsedMs: number): void;
}

/** "!" DISPLAY-32 PAL.gold bouncing over the charging boss's head. */
export function makeChargeMark(): ChargeMark {
  const view = new Container();
  const t = new Text({ text: "!", style: display(32, { fill: PAL.gold }) });
  t.anchor.set(0.5, 1);
  view.addChild(t);
  return {
    view,
    update(elapsedMs: number): void {
      t.y = -Math.abs(Math.sin((elapsedMs / 1000) * Math.PI * 2)) * 6;
    },
  };
}

/**
 * Threatened cat-rank slots flooded PAL.danger alpha 0.25 (ui-art §8).
 * `ranks` are CAT ranks; drawn in battlefield/world coordinates.
 */
export function makeRankFlood(ranks: number[]): Graphics {
  const g = new Graphics();
  const groundY = R.combat.groundY;
  for (const r of ranks) {
    const x = R.combat.catSlots[r];
    if (x === undefined) continue;
    g.roundRect(x - 44, groundY - 108, 88, 116, 10).fill({
      color: PAL.danger,
      alpha: 0.25,
    });
    g.ellipse(x, groundY, 44, 12).fill({ color: PAL.danger, alpha: 0.25 });
  }
  return g;
}

/* ---------------------------------------------------------------------- */
/* Nameplate (hover)                                                       */
/* ---------------------------------------------------------------------- */

/** Name UI-13 bold + tier chevrons + `heavy` anchor glyph, on a dark chip. */
export function makeNameplate(c: Combatant): Container {
  const view = new Container();
  const row = new Container();
  const name = new Text({
    text: c.name,
    style: ui(13, { fontWeight: "bold" }),
  });
  row.addChild(name);
  let x = name.width + 4;
  if (c.side === "enemy") {
    const def = ENEMIES[c.speciesId ?? ""];
    if (def) {
      const chev = makeTierChevrons(def.look.tier);
      chev.position.set(x, 1);
      row.addChild(chev);
      x += chev.width + 4;
    }
    if (c.traits.includes("heavy")) {
      const anchor = makeHeavyGlyph();
      anchor.position.set(x, 1);
      row.addChild(anchor);
      x += anchor.width;
    }
  }
  const bg = new Graphics()
    .roundRect(-6, -4, x + 12, 22, RADIUS.chip)
    .fill({ color: PAL.panel, alpha: 0.92 })
    .stroke({ width: 1, color: PAL.border });
  view.addChild(bg, row);
  view.pivot.set((x + 6) / 2, 0);
  return view;
}

/* ---------------------------------------------------------------------- */
/* Targeting previews                                                      */
/* ---------------------------------------------------------------------- */

/** "≈12" / "≈+11" MONO-14 preview chip above a prospective target. */
export function makePreviewChip(text: string, color: number): Container {
  const view = new Container();
  const t = new Text({ text, style: mono(14, { fill: color }) });
  t.anchor.set(0.5);
  const w = Math.ceil(t.width) + 12;
  const bg = new Graphics()
    .roundRect(-w / 2, -11, w, 22, RADIUS.chip)
    .fill({ color: PAL.hpBack, alpha: 0.9 })
    .stroke({ width: 1, color: darken(color) });
  view.addChild(bg, t);
  return view;
}

/** Small status-glyph chip used for shove-destination previews. */
export function makeStatusPreviewChip(id: StatusId): Container {
  const chip = makeStatusChip(id);
  chip.alpha = 0.85;
  chip.pivot.set(8, 8);
  return chip;
}

/**
 * Ghost shove arrow (ui-art §8 targeting step 2): dashed 6/4 line, 3px,
 * with an arrowhead at the destination. Cleared/redrawn by the scene.
 */
export function drawGhostArrow(
  g: Graphics,
  fromX: number,
  toX: number,
  y: number,
  color: number,
): void {
  const dir = Math.sign(toX - fromX) || 1;
  const len = Math.abs(toX - fromX);
  for (let d = 0; d + 1 < len; d += 10) {
    const seg = Math.min(6, len - d);
    g.moveTo(fromX + dir * d, y).lineTo(fromX + dir * (d + seg), y);
  }
  g.stroke({ width: 3, color });
  g.poly([toX, y, toX - dir * 8, y - 5, toX - dir * 8, y + 5]).fill(color);
}

/** Pulsing gold underline ellipse marking a legal target. */
export function makeTargetRing(): Graphics {
  return new Graphics()
    .ellipse(0, 0, 40, 11)
    .stroke({ width: 3, color: PAL.gold });
}
