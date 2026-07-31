/**
 * WP-08 — small procedural pictograms (ui-art §§7, 9): the four event
 * glyphs (yarnBall / fishBones / pawShrine / strangeBox), the stairs-down
 * swirl, the chest, plus the WP-08 dev gallery behind the `?gallery=1` URL
 * flag (renders every cat/enemy/widget variant for eyeballing).
 */
import { Container, Graphics, Text } from "pixi.js";
import type { ClassId, EnemyLook, StatusId } from "../../core/types.js";
import { PAL, THEMES, CHEST_WOOD } from "../palette.js";
import { display, ui } from "../textStyles.js";
import { drawCat, drawCatPortrait, drawPaw } from "./cats.js";
import { drawEnemy, makeTierChevrons, makeHeavyGlyph } from "./enemies.js";
import {
  makeBar,
  makeButton,
  makeEnergyPips,
  makeHotkeyChip,
  makePanel,
  makePawRow,
  makeStatusChip,
} from "../widgets.js";

export type EventGlyphId =
  "yarnBall" | "fishBones" | "pawShrine" | "strangeBox";

/**
 * Build a 96×96 event glyph (ui-art §9), origin at the glyph center.
 * `themeIndex` (0..2) tints yarnBall with the floor theme's accent.
 */
export function makeEventGlyph(id: EventGlyphId, themeIndex = 0): Container {
  const view = new Container();
  const g = new Graphics();
  view.addChild(g);
  const accent = THEMES[themeIndex].accent;

  if (id === "yarnBall") {
    // circle r 34 + 3 crossing bezier strands
    g.circle(0, 0, 34).fill(accent).stroke({ width: 3, color: PAL.void });
    const strand = { width: 3, color: PAL.void, alpha: 0.45 };
    g.moveTo(-30, -14).bezierCurveTo(-6, 6, 10, -26, 32, -8).stroke(strand);
    g.moveTo(-32, 8).bezierCurveTo(-4, 26, 8, -4, 30, 14).stroke(strand);
    g.moveTo(-20, 26).bezierCurveTo(2, 10, -12, -16, 24, -24).stroke(strand);
    // trailing thread
    g.moveTo(30, 16).bezierCurveTo(44, 24, 36, 38, 48, 42).stroke({
      width: 3,
      color: accent,
    });
  } else if (id === "fishBones") {
    const bone = { width: 3, color: PAL.text };
    // oval head with an eye socket
    g.ellipse(-28, 0, 14, 11).fill(PAL.text);
    g.circle(-31, -2, 2.5).fill(PAL.bgDeep);
    // spine
    g.moveTo(-14, 0).lineTo(28, 0).stroke(bone);
    // 5 rib lines
    for (let i = 0; i < 5; i++) {
      const x = -8 + i * 8;
      g.moveTo(x, -11).lineTo(x, 11).stroke(bone);
    }
    // tail triangles
    g.poly([28, 0, 44, -12, 44, 12]).fill(PAL.text);
    g.poly([32, 0, 44, 0, 38, 6]).fill(PAL.bgDeep);
  } else if (id === "pawShrine") {
    // rounded stone + §4 paw glyph at 4× scale in gold
    g.roundRect(-32, -36, 64, 72, 10)
      .fill(PAL.panelLite)
      .stroke({ width: 3, color: PAL.void });
    drawPaw(g, 0, -4, 4, true, PAL.gold);
  } else {
    // strangeBox: cardboard + "?" DISPLAY-32
    g.roundRect(-34, -28, 68, 56, 6)
      .fill(CHEST_WOOD)
      .stroke({ width: 3, color: PAL.void });
    g.moveTo(-34, -14).lineTo(34, -14).stroke({ width: 2, color: PAL.void });
    const q = new Text({
      text: "?",
      style: display(32, { fill: PAL.text }),
    });
    q.anchor.set(0.5);
    q.position.set(0, 6);
    view.addChild(q);
  }
  return view;
}

/**
 * Stairs-down swirl (ui-art §7 tile recipe): PAL.void circle r 16 + three
 * shrinking gold arcs. Centered on (cx, cy).
 */
export function drawStairs(g: Graphics, cx: number, cy: number): void {
  g.circle(cx, cy, 16).fill(PAL.void);
  for (const [r, start] of [
    [12, 0],
    [8, 2.2],
    [4, 4.4],
  ] as const) {
    g.moveTo(cx + r * Math.cos(start), cy + r * Math.sin(start))
      .arc(cx, cy, r, start, start + Math.PI * 1.4)
      .stroke({ width: 2, color: PAL.gold });
  }
}

/**
 * Chest pictogram (ui-art §7): 20×14 rounded-rect wood, gold lid strip,
 * void keyhole dot. (cx, cy) is the chest center.
 */
export function drawChest(g: Graphics, cx: number, cy: number): void {
  g.roundRect(cx - 10, cy - 7, 20, 14, 3)
    .fill(CHEST_WOOD)
    .stroke({ width: 2, color: PAL.void });
  g.rect(cx - 10, cy - 4, 20, 3).fill(PAL.gold);
  g.circle(cx, cy + 2, 1.5).fill(PAL.void);
}

/* ---------------------------------------------------------------------- */
/* Dev gallery (?gallery=1)                                                */
/* ---------------------------------------------------------------------- */

const CLASSES: ClassId[] = ["bruiser", "trickster", "hexer", "medic"];
const FAMILIES: EnemyLook["family"][] = [
  "vermin",
  "bird",
  "beast",
  "construct",
];
const GRADES: EnemyLook["sizeGrade"][] = [
  "minion",
  "standard",
  "elite",
  "boss",
];
const STATUSES: StatusId[] = [
  "scratched",
  "frazzled",
  "offBalance",
  "guarded",
  "provoked",
  "mending",
  "braced",
];

function label(text: string, x: number, y: number): Text {
  const t = new Text({ text, style: ui(11, { fill: PAL.textDim }) });
  t.position.set(x, y);
  return t;
}

/** Build the full WP-08 gallery: every cat/enemy variant + core widgets. */
export function buildGallery(): Container {
  const root = new Container();
  root.addChild(new Graphics().rect(0, 0, 1280, 1500).fill(PAL.bgDeep));

  // -- cats: sit / battle / KO + mini portraits ------------------------
  root.addChild(
    label("cats — sit · battle · KO · portrait (per class)", 16, 8),
  );
  CLASSES.forEach((cls, i) => {
    const x = 90 + i * 180;
    for (const [j, variant] of (["sit", "battle", "ko"] as const).entries()) {
      const g = new Graphics();
      drawCat(
        g,
        cls,
        variant === "battle" ? "battle" : "sit",
        1,
        variant === "ko",
      );
      g.position.set(x + (j % 2) * 90, 130 + Math.floor(j / 2) * 110);
      root.addChild(g);
    }
    const mini = new Graphics();
    drawCatPortrait(mini, cls);
    mini.position.set(x + 90, 220);
    root.addChild(mini);
    root.addChild(label(cls, x - 20, 140));
  });

  // -- Lives paw rows ---------------------------------------------------
  const paws = makePawRow(6);
  paws.view.position.set(830, 40);
  root.addChild(label("lives 6/9", 830, 20), paws.view);

  // -- enemies: 4 families × 4 size grades ------------------------------
  root.addChild(label("enemies — family × size grade", 16, 300));
  FAMILIES.forEach((family, row) => {
    GRADES.forEach((sizeGrade, col) => {
      const g = new Graphics();
      drawEnemy(g, {
        family,
        sizeGrade,
        tier: ((row % 3) + 1) as 1 | 2 | 3,
      });
      g.position.set(100 + col * 170, 480 + row * 170);
      root.addChild(g);
    });
    root.addChild(label(family, 16, 440 + row * 170));
  });

  // -- props + tier chevrons + heavy glyph ------------------------------
  root.addChild(
    label("props: crown · shamanStaff · scarf · patchEye", 800, 300),
  );
  const propLooks: EnemyLook[] = [
    { family: "construct", sizeGrade: "boss", tier: 1, props: ["crown"] },
    {
      family: "vermin",
      sizeGrade: "standard",
      tier: 2,
      props: ["shamanStaff"],
    },
    { family: "beast", sizeGrade: "standard", tier: 2, props: ["scarf"] },
    { family: "bird", sizeGrade: "standard", tier: 3, props: ["patchEye"] },
  ];
  propLooks.forEach((look, i) => {
    const g = new Graphics();
    drawEnemy(g, look);
    g.position.set(880 + (i % 2) * 190, 480 + Math.floor(i / 2) * 170);
    root.addChild(g);
  });
  for (const tier of [1, 2, 3] as const) {
    const c = makeTierChevrons(tier);
    c.position.set(800 + (tier - 1) * 40, 330);
    root.addChild(c);
  }
  const heavy = makeHeavyGlyph();
  heavy.position.set(930, 330);
  root.addChild(heavy);

  // -- event glyphs + tiles ---------------------------------------------
  root.addChild(label("event glyphs · stairs · chest", 16, 1160));
  (["yarnBall", "fishBones", "pawShrine", "strangeBox"] as const).forEach(
    (id, i) => {
      const glyph = makeEventGlyph(id, i % 3);
      glyph.position.set(80 + i * 130, 1240);
      root.addChild(glyph);
    },
  );
  const tileG = new Graphics();
  drawStairs(tileG, 600, 1240);
  drawChest(tileG, 660, 1240);
  root.addChild(tileG);

  // -- widgets ----------------------------------------------------------
  root.addChild(label("widgets", 800, 1160));
  const hp = makeBar(120, 10);
  hp.view.position.set(800, 1190);
  hp.set(0.35, false);
  const xp = makeBar(120, 10, { color: PAL.energy });
  xp.view.position.set(800, 1210);
  xp.set(0.7, false);
  const pips = makeEnergyPips();
  pips.view.position.set(800, 1230);
  pips.set(6);
  root.addChild(hp.view, xp.view, pips.view);
  STATUSES.forEach((st, i) => {
    const chip = makeStatusChip(st, st === "scratched" ? 2 : undefined);
    chip.position.set(800 + i * 22, 1252);
    root.addChild(chip);
  });
  const hk = makeHotkeyChip("1");
  hk.view.position.set(800, 1276);
  const hkOff = makeHotkeyChip("6", false);
  hkOff.view.position.set(822, 1276);
  root.addChild(hk.view, hkOff.view);
  const panel = makePanel(180, 60);
  panel.position.set(1000, 1190);
  root.addChild(panel);
  const btn = makeButton("[Enter] New Run", 200, 40, () => {}, {
    primary: true,
  });
  btn.view.position.set(800, 1310);
  const btn2 = makeButton("Records", 140, 40, () => {});
  btn2.view.position.set(1020, 1310);
  root.addChild(btn.view, btn2.view);

  return root;
}

/**
 * Dev helper: when the page URL carries `?gallery=1`, mount the gallery
 * onto `stage` (wheel-scrollable) and return true; otherwise no-op. main.ts
 * calls this right after boot and skips normal scene start when it fires.
 */
export function mountGalleryIfRequested(stage: Container): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("gallery") !== "1") return false;
  const gallery = buildGallery();
  stage.addChild(gallery);
  window.addEventListener("wheel", (e) => {
    gallery.y = Math.min(0, Math.max(-900, gallery.y - e.deltaY));
  });
  return true;
}
