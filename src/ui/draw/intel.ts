/**
 * INTENT & INTEL VISUAL LANGUAGE (docs/design/enemy-intel.md §§2, 3, 5).
 *
 * Everything an enemy tells you about itself, drawn once and reused by the
 * over-head badges, the turn-order strip, the inspect panel and Cat Town's
 * Bestiary — so a glyph means the same thing everywhere it appears.
 *
 * ── Why the shapes are what they are ──────────────────────────────────────
 * Slay the Spire's intents work because they are read, not decoded: a symbol
 * over a head, with the damage number ON it. Into the Breach's designers put
 * the rule bluntly — "sacrifice cool ideas for the sake of clarity every
 * time". Two consequences that this module enforces:
 *
 *  1. **The PLATE SILHOUETTE carries the meaning, not the colour.** Every
 *     kind gets its own outline: strike a downward blade-point, shove a
 *     stretched arrow-hex, status the same rounded chip the status system
 *     already uses, buff/heal an upward point, summon a circle, windup a
 *     diamond, unknown a circle with a `?`. Convert the screen to greyscale
 *     and the badges are still all different — the accessibility literature's
 *     "double-code with shape, not colour alone" applied to a HUD.
 *  2. **The number lives on the badge**, like StS's attack intents, because a
 *     telegraph without a magnitude is a mood, not information.
 *
 * Darkest Dungeon supplies the other half: information is EARNED. Anything the
 * Bestiary has not unlocked renders as `???` rather than vanishing, so the
 * panel doubles as a checklist (`core/meta/bestiary.ts` decides; this file
 * only draws what it is handed).
 *
 * Pure presentation. No engine calls beyond reading content tables for names.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { DeclaredIntent, IntelTag, IntentKind } from "../../core/types.js";
import type { KnownIntel } from "../../core/meta/bestiary.js";
import { SKILLS } from "../../content/skills.js";
import { PAL, darken, mix } from "../palette.js";
import { RADIUS, SPACE } from "../layout.js";
import { TYPE, mono } from "../textStyles.js";
import { STATUS_STYLE, label, makeTooltip } from "../widgets.js";

/* ---------------------------------------------------------------------- */
/* The vocabulary                                                          */
/* ---------------------------------------------------------------------- */

/** Badge outline family — the greyscale-safe half of the encoding. */
export type PlateShape =
  | "blade" // point down: it is coming for you
  | "wedge" // stretched, arrow-headed: force movement
  | "chip" // rounded square: the status family's own shape
  | "shield" // point up: it is protecting/helping itself
  | "circle" // summon / unknown
  | "diamond"; // windup — the "wait for it" shape

export interface IntentVisual {
  /** Shown on the inspect panel and the badge tooltip. */
  label: string;
  color: number;
  plate: PlateShape;
  /** true ⇒ the badge prints its `value` as a big numeral. */
  showsValue: boolean;
}

/**
 * One row per `IntentKind`. Colour is the SECOND cue; the plate is the first.
 */
export const INTENT_VISUAL: Record<IntentKind, IntentVisual> = {
  strike: {
    label: "Attack",
    color: PAL.danger,
    plate: "blade",
    showsValue: true,
  },
  shove: {
    label: "Shove",
    color: PAL.offBal,
    plate: "wedge",
    showsValue: true,
  },
  status: {
    label: "Status",
    color: PAL.stFrazzled,
    plate: "chip",
    showsValue: false,
  },
  heal: { label: "Heal", color: PAL.heal, plate: "shield", showsValue: true },
  buff: {
    label: "Guard / buff",
    color: PAL.stGuarded,
    plate: "shield",
    showsValue: false,
  },
  summon: {
    label: "Summon",
    color: PAL.xp,
    plate: "circle",
    showsValue: false,
  },
  windup: {
    label: "Winding up",
    color: PAL.gold,
    plate: "diamond",
    showsValue: false,
  },
  // NOT a wedge: in greyscale an "it shuffles forward" badge and a "it shoves
  // YOU" badge that share a silhouette are the same badge. Advance keeps the
  // neutral chip plate and a single stepping chevron.
  advance: {
    label: "Reposition",
    color: PAL.textDim,
    plate: "chip",
    showsValue: false,
  },
  unknown: {
    label: "Unknown",
    color: PAL.textDim,
    plate: "circle",
    showsValue: false,
  },
};

/** Plain-English intel tags — the inspect panel never shows a raw id. */
export const TAG_INFO: Record<IntelTag, { name: string; effect: string }> = {
  shove: {
    name: "Shoving",
    effect: "hits that force-move it land ×1.25 (weak) or ×0.80 (resistant)",
  },
  offBalance: {
    name: "Off-Paw",
    effect: "whether Off-Balance can be knocked into it at all",
  },
  scratched: { name: "Scratched", effect: "bleed always lands, or never does" },
  frazzled: {
    name: "Frazzled",
    effect: "the stun always lands, or never does",
  },
  provoked: { name: "Provoked", effect: "taunts always land, or never do" },
};

/* ---------------------------------------------------------------------- */
/* Plates & glyphs                                                         */
/* ---------------------------------------------------------------------- */

/** Outline path for a plate shape, centred on (0,0), `r` = half-height. */
function platePath(g: Graphics, shape: PlateShape, w: number, h: number): void {
  const hw = w / 2;
  const hh = h / 2;
  switch (shape) {
    case "blade":
      // a shield pointing DOWN — the badge aims at the thing it will hit
      g.poly([-hw, -hh, hw, -hh, hw, hh * 0.34, 0, hh, -hw, hh * 0.34]);
      break;
    case "shield":
      g.poly([0, -hh, hw, -hh * 0.34, hw, hh, -hw, hh, -hw, -hh * 0.34]);
      break;
    case "wedge":
      // stretched hex with a point on the leading edge
      g.poly([
        -hw,
        -hh * 0.62,
        hw * 0.52,
        -hh * 0.62,
        hw,
        0,
        hw * 0.52,
        hh * 0.62,
        -hw,
        hh * 0.62,
      ]);
      break;
    case "diamond":
      g.poly([0, -hh, hw, 0, 0, hh, -hw, 0]);
      break;
    case "circle":
      g.ellipse(0, 0, hw, hh);
      break;
    case "chip":
    default:
      g.roundRect(-hw, -hh, w, h, RADIUS.chip + 2);
      break;
  }
}

/**
 * The inner mark: a second, smaller silhouette so the badge still reads when
 * it is 18px wide in the turn-order strip and carries no number at all.
 */
export function drawIntentMark(
  g: Graphics,
  kind: IntentKind,
  r: number,
  color: number,
): void {
  const s = r;
  switch (kind) {
    case "strike":
      // THREE PARALLEL CLAW RAKES. Crossed slashes were the first draft and
      // they read as a ✗ — "cancelled", the opposite of the message. Parallel
      // rakes are unmistakably a swipe, and they are this game's own verb.
      for (let i = -1; i <= 1; i++) {
        const dx = i * s * 0.62;
        const len = i === 0 ? 1 : 0.82;
        g.moveTo(dx - s * 0.24, -s * len)
          .lineTo(dx + s * 0.24, s * len)
          .stroke({ width: Math.max(1.4, s * 0.26), color, cap: "round" });
      }
      break;
    case "shove":
      // double chevron — the universal "pushed that way"
      for (const dx of [-s * 0.55, s * 0.15]) {
        g.moveTo(dx, -s * 0.8)
          .lineTo(dx + s * 0.7, 0)
          .lineTo(dx, s * 0.8);
      }
      g.stroke({
        width: Math.max(1.5, s * 0.3),
        color,
        cap: "round",
        join: "round",
      });
      break;
    case "advance":
      // ONE chevron with a dotted trail: a step it takes, not a push it gives
      g.moveTo(-s * 0.05, -s * 0.7)
        .lineTo(s * 0.6, 0)
        .lineTo(-s * 0.05, s * 0.7)
        .stroke({
          width: Math.max(1.4, s * 0.26),
          color,
          cap: "round",
          join: "round",
        });
      for (let i = 0; i < 2; i++) {
        g.circle(-s * 0.45 - i * s * 0.4, 0, Math.max(1, s * 0.13)).fill(color);
      }
      break;
    case "status":
      // a droplet: round below, pointed above
      g.moveTo(0, -s)
        .lineTo(s * 0.8, s * 0.25)
        .arc(0, s * 0.25, s * 0.8, 0, Math.PI)
        .closePath()
        .fill(color);
      break;
    case "heal":
      g.rect(-s * 0.28, -s, s * 0.56, s * 2)
        .rect(-s, -s * 0.28, s * 2, s * 0.56)
        .fill(color);
      break;
    case "buff":
      // upward arrow inside its shield plate
      g.poly([
        0,
        -s,
        s * 0.85,
        s * 0.05,
        s * 0.34,
        s * 0.05,
        s * 0.34,
        s,
        -s * 0.34,
        s,
        -s * 0.34,
        s * 0.05,
        -s * 0.85,
        s * 0.05,
      ]).fill(color);
      break;
    case "summon":
      g.circle(0, -s * 0.2, s * 0.5).fill(color);
      g.circle(-s * 0.72, s * 0.55, s * 0.32).fill(color);
      g.circle(s * 0.72, s * 0.55, s * 0.32).fill(color);
      break;
    case "windup":
      g.rect(-s * 0.2, -s, s * 0.4, s * 1.2)
        .rect(-s * 0.2, s * 0.5, s * 0.4, s * 0.42)
        .fill(color);
      break;
    case "unknown":
    default: {
      // '?' drawn as geometry so it needs no font metrics at 12px
      g.arc(0, -s * 0.35, s * 0.55, Math.PI, Math.PI * 0.15).stroke({
        width: Math.max(1.5, s * 0.32),
        color,
        cap: "round",
      });
      g.moveTo(s * 0.1, -s * 0.05)
        .lineTo(0, s * 0.35)
        .stroke({ width: Math.max(1.5, s * 0.32), color, cap: "round" });
      g.circle(0, s * 0.8, Math.max(1, s * 0.2)).fill(color);
      break;
    }
  }
}

/* ---------------------------------------------------------------------- */
/* The over-head badge                                                     */
/* ---------------------------------------------------------------------- */

export interface IntentBadge {
  view: Container;
  /** Rebuilds only when the rendered signature actually changed. */
  set(intent: DeclaredIntent | null): void;
  /** 1.4s breathing so a live telegraph never reads as a static decal. */
  update(elapsedMs: number): void;
}

/**
 * How the badge is described in one line, for the log / tooltip / inspect
 * panel. Truthful about `unknown`: it says so rather than inventing a verb.
 */
export function intentSentence(
  intent: DeclaredIntent,
  targetName: string | null,
): string {
  const v = INTENT_VISUAL[intent.kind];
  const skill = intent.skillId ? SKILLS[intent.skillId]?.name : undefined;
  const at = targetName === null ? "" : ` → ${targetName}`;
  switch (intent.kind) {
    case "strike":
      return `${skill ?? v.label} for ~${intent.value}${at}`;
    case "shove":
      return `${skill ?? v.label} — shove${intent.value > 0 ? ` + ~${intent.value}` : ""}${at}`;
    case "status":
      return `${skill ?? v.label} — ${intent.status ?? "a status"}${at}`;
    case "heal":
      return `${skill ?? v.label} — heals ~${intent.value}`;
    case "windup":
      return `${skill ?? v.label} — winding up`;
    case "summon":
      return `${skill ?? v.label} — calling help`;
    case "unknown":
      return "Unknown — you have not seen this one move";
    default:
      return skill ?? v.label;
  }
}

/**
 * THE intent badge: plate + mark + (for strikes and shoves) the expected
 * damage, sized so it reads from across the room.
 *
 * `scale` 1 = the over-head badge (≈46px); the turn-order strip passes ~0.42.
 */
export function makeIntentBadge(scale = 1): IntentBadge {
  const view = new Container();
  const plate = new Graphics();
  const mark = new Graphics();
  const statusPip = new Container();
  const num = new Text({ text: "", style: mono(Math.round(19 * scale)) });
  num.anchor.set(0.5);
  view.addChild(plate, mark, statusPip, num);
  view.visible = false;

  let sig = " ";
  let pulse = false;

  const badge: IntentBadge = {
    view,
    set(intent: DeclaredIntent | null): void {
      const next =
        intent === null
          ? ""
          : `${intent.kind}|${intent.value}|${intent.status ?? ""}|${intent.skillId ?? ""}`;
      if (next === sig) return;
      sig = next;
      if (intent === null) {
        view.visible = false;
        return;
      }
      view.visible = true;
      const v = INTENT_VISUAL[intent.kind];
      const shows = v.showsValue && intent.value > 0;
      const w = (shows ? 62 : 44) * scale;
      const h = 44 * scale;

      plate.clear();
      // drop shadow first: the badge floats over painted art of any value
      platePath(plate, v.plate, w + 5 * scale, h + 5 * scale);
      plate.fill({ color: PAL.void, alpha: 0.5 });
      platePath(plate, v.plate, w, h);
      plate.fill({ color: mix(PAL.bgDeep, v.color, 0.24), alpha: 0.97 });
      platePath(plate, v.plate, w, h);
      plate.stroke({
        width: Math.max(1.5, 2.4 * scale),
        color: v.color,
        alignment: 0.5,
      });

      mark.clear();
      statusPip.removeChildren().forEach((c) => c.destroy({ children: true }));
      num.text = "";
      if (shows) {
        // mark on the left, number on the right — StS's "symbol + damage"
        mark.position.set(-w / 2 + 15 * scale, 0);
        drawIntentMark(mark, intent.kind, 8.5 * scale, v.color);
        num.text = String(intent.value);
        num.style.fontSize = Math.round(21 * scale);
        num.style.fill = PAL.text;
        num.position.set(w / 2 - 18 * scale, -1);
      } else if (intent.kind === "status" && intent.status) {
        // WHICH status, in the status system's own colour + glyph
        mark.position.set(0, 0);
        const st = STATUS_STYLE[intent.status];
        const gl = new Text({
          text: st.glyph,
          style: mono(Math.round(22 * scale), { fill: st.color }),
        });
        gl.anchor.set(0.5);
        statusPip.addChild(gl);
        // the droplet outline keeps the "a status is coming" silhouette
        drawIntentMark(mark, "status", 13 * scale, darken(st.color, 0.45));
      } else {
        mark.position.set(0, 0);
        drawIntentMark(mark, intent.kind, 11 * scale, v.color);
      }
      pulse = intent.kind === "windup" || intent.kind === "strike";
    },
    update(elapsedMs: number): void {
      if (!view.visible) return;
      const p = pulse
        ? 1 + 0.06 * Math.sin(((elapsedMs / 1000) * Math.PI * 2) / 1.4)
        : 1;
      view.scale.set(p);
    },
  };
  return badge;
}

/* ---------------------------------------------------------------------- */
/* "WHAT YOU KNOW" — shared by the battle inspect panel and the Bestiary   */
/* ---------------------------------------------------------------------- */

const UNKNOWN = "???";

/**
 * A discovered / undiscovered tag pill. A KNOWN pill explains its mechanical
 * effect on hover/tap — a weakness the player cannot act on is decoration,
 * and enemy-intel.md §1 is explicit that weaknesses must be mechanical.
 */
export function makeTagPill(
  tag: IntelTag,
  known: boolean,
  weak: boolean,
): Container {
  const view = new Container();
  const color = weak ? PAL.danger : PAL.stGuarded;
  const text = known ? TAG_INFO[tag].name : UNKNOWN;
  const t = label(text, {
    size: TYPE.tiny,
    bold: true,
    mono: !known,
    fill: known ? PAL.text : PAL.textDim,
  });
  const w = Math.ceil(t.width) + 26;
  const g = new Graphics()
    .roundRect(0, 0, w, 20, RADIUS.chip)
    .fill({
      color: known ? mix(PAL.panel, color, 0.34) : PAL.hpBack,
      alpha: 0.95,
    })
    .stroke({ width: 1, color: known ? color : PAL.border });
  // ▲ weakness / ▼ resistance — the greyscale cue on top of the colour
  g.poly(weak ? [7, 13, 12, 5, 17, 13] : [7, 7, 17, 7, 12, 15]).fill({
    color: known ? color : PAL.textDim,
  });
  t.position.set(21, 3);
  view.addChild(g, t);
  if (known) {
    let tip: Container | null = null;
    const drop = (): void => {
      tip?.destroy({ children: true });
      tip = null;
    };
    const raise = (): void => {
      if (tip) return;
      const built = makeTooltip(
        `${TAG_INFO[tag].name.toUpperCase()} — ${weak ? "WEAK" : "RESISTS"}: ${TAG_INFO[tag].effect}`,
      );
      built.position.set(0, 24);
      view.addChild(built);
      tip = built;
    };
    view.eventMode = "static";
    view.cursor = "help";
    view.on("pointerover", raise);
    view.on("pointerout", drop);
    view.on("pointertap", () => (tip ? drop() : raise()));
  }
  return view;
}

export interface IntelBlock {
  view: Container;
  height: number;
}

/**
 * The earned-knowledge block: description, tell, weaknesses, resistances and
 * the skill list — with `???` standing in for everything not yet learned, so
 * the reader can count what is left. Returns its own measured height so the
 * caller can size the panel around it.
 */
export function makeIntelBlock(intel: KnownIntel, w: number): IntelBlock {
  const view = new Container();
  let y = 0;

  const section = (title: string): void => {
    const t = label(title, {
      size: TYPE.tiny,
      bold: true,
      dim: true,
      mono: true,
    });
    t.position.set(0, y);
    view.addChild(t);
    y += 16;
  };

  const desc = label(intel.description.value ?? UNKNOWN, {
    size: TYPE.small,
    dim: !intel.description.known,
    wrap: w,
  });
  desc.position.set(0, y);
  view.addChild(desc);
  y += Math.ceil(desc.height) + SPACE.sm;

  if (intel.tell.known) {
    const tell = label(`“${intel.tell.value ?? ""}”`, {
      size: TYPE.small,
      fill: PAL.gold,
      wrap: w,
    });
    tell.position.set(0, y);
    view.addChild(tell);
    y += Math.ceil(tell.height) + SPACE.md;
  } else {
    const tell = label(`TELL  ${UNKNOWN}`, {
      size: TYPE.tiny,
      dim: true,
      mono: true,
    });
    tell.position.set(0, y);
    view.addChild(tell);
    y += 20;
  }

  const pillRow = (
    title: string,
    facts: readonly { tag: IntelTag; known: boolean }[],
    weak: boolean,
  ): void => {
    section(title);
    if (facts.length === 0) {
      const none = label("none", { size: TYPE.tiny, dim: true, mono: true });
      none.position.set(0, y);
      view.addChild(none);
      y += 20;
      return;
    }
    let x = 0;
    let rowH = 0;
    for (const f of facts) {
      const pill = makeTagPill(f.tag, f.known, weak);
      const pw = Math.ceil(pill.width);
      if (x > 0 && x + pw > w) {
        x = 0;
        y += 24;
      }
      pill.position.set(x, y);
      view.addChild(pill);
      x += pw + 6;
      rowH = 24;
    }
    y += rowH + SPACE.xs;
  };

  pillRow("WEAK TO", intel.weaknesses, true);
  pillRow("SHRUGS OFF", intel.resistances, false);

  section("SKILLS SEEN");
  let sx = 0;
  for (const s of intel.skills) {
    const name = s.known ? (SKILLS[s.id]?.name ?? s.id) : UNKNOWN;
    const t = label(name, {
      size: TYPE.tiny,
      mono: !s.known,
      fill: s.known ? PAL.text : PAL.textDim,
    });
    const tw = Math.ceil(t.width) + 16;
    if (sx > 0 && sx + tw > w) {
      sx = 0;
      y += 20;
    }
    const g = new Graphics()
      .roundRect(0, 0, tw, 18, RADIUS.chip)
      .fill({ color: PAL.hpBack, alpha: 0.9 })
      .stroke({ width: 1, color: s.known ? PAL.border : darken(PAL.border) });
    t.position.set(8, 2);
    const chip = new Container();
    chip.addChild(g, t);
    chip.position.set(sx, y);
    if (!s.known) chip.alpha = 0.7;
    view.addChild(chip);
    sx += tw + 6;
  }
  y += 22 + SPACE.xs;

  // the checklist line — Darkest Dungeon's "what is left to learn"
  const progress = intel.complete
    ? "ENTRY COMPLETE — everything is known"
    : `${intel.unknownCount} facts still unknown · ${intel.killsToComplete} more kills completes the entry`;
  const p = label(progress, {
    size: TYPE.tiny,
    mono: true,
    fill: intel.complete ? PAL.heal : PAL.textDim,
    wrap: w,
  });
  p.position.set(0, y);
  view.addChild(p);
  y += Math.ceil(p.height);

  return { view, height: y };
}

/** `TIER 2 ‹‹` pill — the tier as a WORD, in its own tier colour. */
export function makeTierPill(tier: 1 | 2 | 3 | null): Container {
  const view = new Container();
  const known = tier !== null;
  const t = tier ?? 1;
  const color = [PAL.tier1, PAL.tier2, PAL.tier3][t - 1];
  const txt = label(known ? `TIER ${t} ${"‹".repeat(t)}` : `TIER ${UNKNOWN}`, {
    size: TYPE.tiny,
    bold: true,
    mono: true,
    fill: known ? color : PAL.textDim,
  });
  const w = Math.ceil(txt.width) + 14;
  view.addChild(
    new Graphics()
      .roundRect(0, 0, w, 18, RADIUS.chip)
      .fill({ color: PAL.hpBack, alpha: 0.95 })
      .stroke({ width: 1, color: known ? color : PAL.border }),
    txt,
  );
  txt.position.set(7, 2);
  return view;
}

/** `LVL 4` chip, or `LVL ???` when the species has never been met. */
export function makeLevelChip(level: number | null): Container {
  const view = new Container();
  const known = level !== null;
  const t = label(known ? `LVL ${level}` : `LVL ${UNKNOWN}`, {
    size: TYPE.tiny,
    bold: true,
    mono: true,
    fill: known ? PAL.textDark : PAL.textDim,
  });
  const w = Math.ceil(t.width) + 14;
  view.addChild(
    new Graphics()
      .roundRect(0, 0, w, 18, RADIUS.chip)
      .fill({ color: known ? PAL.gold : PAL.hpBack, alpha: 0.95 })
      .stroke({ width: 1, color: known ? PAL.goldDark : PAL.border }),
    t,
  );
  t.position.set(7, 2);
  return view;
}
