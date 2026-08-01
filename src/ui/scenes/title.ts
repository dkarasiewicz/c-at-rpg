/**
 * WP-09 — title scene (ui-art §11): the painted hero illustration (or the
 * procedural night sky when the art pack is absent), the c(at)rpg wordmark,
 * and the menu panel: New Run / Continue (iff a valid save exists) / Create
 * your party / Seed… entry (blank = random 8-hex). Records line from
 * MetaFile.
 *
 * Chrome is the shared kit (widgets.ts): `sceneBackdrop` + `vignette` for
 * atmosphere, one glass `panel` behind the menu column, `button` with
 * hotkey chips for every action, `heading`/`label` for all type. The only
 * bespoke piece is the wordmark itself (2× the h1 size — it is brand art,
 * not UI copy) and the assetless night sky, whose cats go through the
 * painted-first `catSprite` helper so no flat-vector cat can appear while a
 * painted one exists.
 *
 * Visual randomness here is Math.random() — the ONE place it may feed
 * gameplay is *picking* a fresh runSeed string (ARCHITECTURE.md §4).
 */
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { ClassId, RunState } from "../../core/types.js";
import { loadRun } from "../../core/run/save.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, R, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  button,
  emblem,
  heading,
  label,
  panel,
  sceneBackdrop,
  scrim,
  vignette,
  wordmark,
} from "../widgets.js";
import { createDomInput, type DomInput } from "../domInput.js";
import { isTouch } from "../touch.js";
import { drawCat } from "../draw/cats.js";
import { catTexture, spriteTextureFor } from "../sprites.js";
import { applyPartyContent } from "./partyCreator.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** Random 8-hex seed (visual RNG picking a gameplay seed — §4 exception). */
export function randomSeed(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s.toUpperCase();
}

const CAT_ORDER: readonly ClassId[] = [
  "bruiser",
  "trickster",
  "hexer",
  "medic",
];

/* ---- screen geometry (design px) ------------------------------------- */
const EMBLEM_Y = 82;
const EMBLEM_H = 116;
const LOGO_Y = 186;
const SUBTITLE_Y = 234;
const MENU_X = 460;
const MENU_W = 360;
const MENU_TOP = 288;
const BTN_W = 300;
const BTN_H = 52;
const BTN_GAP = SPACE.md;

export function createTitleScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let savedRun: RunState | null = null;

  // seed entry state
  let entering = false;
  let seedBuffer = "";
  let seedChip: Text | null = null;
  let entryChip: Text | null = null;
  /**
   * Seed entry is the one place on the title screen that asks you to TYPE,
   * and a phone has no keyboard until something focuses a real field. So on
   * touch the chip is backed by a DOM `<input>` (docs/design/mobile.md §5) —
   * the same keyboard-aware component the tabletop card uses.
   */
  let seedField: DomInput | null = null;
  let seedRect = { x: MENU_X + 30, y: MENU_TOP + 200, w: MENU_W - 60, h: 34 };

  // twinkle + idle animation state
  const stars: { g: Graphics; base: number; phase: number; speed: number }[] =
    [];
  const cats: { c: Container; baseY: number; phase: number }[] = [];
  let t = 0;

  const refreshSeedTexts = (): void => {
    const seedLabel = seedBuffer === "" ? "random" : seedBuffer;
    if (seedChip) seedChip.text = `seed ${seedLabel}`;
    if (entryChip) {
      entryChip.visible = entering || seedBuffer !== "";
      entryChip.text = entering ? `seed: ${seedBuffer}_` : `seed: ${seedLabel}`;
    }
  };

  const closeSeedEntry = (): void => {
    entering = false;
    seedField?.destroy();
    seedField = null;
    refreshSeedTexts();
  };

  const openSeedEntry = (): void => {
    entering = true;
    refreshSeedTexts();
    if (!isTouch() || seedField) return;
    seedField = createDomInput({
      rect: seedRect,
      placeholder: "SEED",
      maxLength: 16,
      enterKeyHint: "done",
      // the keyboard path accepts [a-z0-9-] and upper-cases it; the field
      // must not quietly widen the alphabet a run seed is hashed from
      filter: (raw) => raw.toUpperCase().replace(/[^A-Z0-9-]/g, ""),
      onInput: (text) => {
        seedBuffer = text;
        refreshSeedTexts();
      },
      onSubmit: () => closeSeedEntry(),
      onCancel: () => closeSeedEntry(),
    });
    seedField.setValue(seedBuffer);
    seedField.focus();
  };

  /**
   * A run no longer starts on the title: it starts in CAT TOWN, which owns
   * the clowder, the tin and the unlocks a fresh run is built from
   * (balance-and-meta.md §4). The typed seed rides along in the params.
   */
  const goToTown = (): void => {
    if (!ctx || entering) return;
    const seed = seedBuffer.trim();
    ctx.scenes.goto("catTown", seed === "" ? {} : { seed });
  };

  const continueRun = (): void => {
    if (!ctx || !savedRun) return;
    // a saved custom-party run re-applies its kit overlay after reload
    // (Continue skips floorgen, the usual sync point)
    applyPartyContent(savedRun.customParty);
    ctx.run = savedRun;
    ctx.scenes.goto("runMap");
  };

  const openPartyCreator = (): void => {
    if (!ctx || entering) return;
    ctx.scenes.goto("partyCreator");
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;
      savedRun = loadRun(); // Continue visible iff a valid save exists

      /* ---- backdrop ------------------------------------------------ */
      // palette wash under everything ('scene:title' is unpublished — the
      // hero art below is the real backdrop when the pack is present)
      view.addChild(sceneBackdrop("scene:title", DESIGN_W, DESIGN_H));

      const heroTex = spriteTextureFor("title:hero");
      if (heroTex && heroTex.height > 0) {
        // ONE crisp copy, cover-fitted across the whole device.
        //
        // This used to be two copies — a blurred bled copy with a crisp
        // contain-fitted one on top — deliberately, as "a poster hanging in a
        // room". It was a nice idea and it read to the player as black bars:
        // on a 19.5:9 phone the poster is only the middle ~75%, and the join
        // is a hard vertical edge down both sides no matter how the two
        // copies are exposed, because they show different parts of the image.
        // A player does not see an intent, they see a letterbox.
        //
        // Cover-fitting one copy removes the join by construction. The crop
        // it costs is vertical, so it is anchored high: the cast sits in the
        // upper half of this painting and centring the crop cut their heads.
        view.addChild(
          sceneBackdrop("title:hero", DESIGN_W, DESIGN_H, {
            dim: 0.42,
            anchorY: 0.3,
          }),
        );
        // Readability wash over the SCREEN, bleed included — drawn at
        // DESIGN_W×DESIGN_H it would dim only the safe box.
        view.addChild(scrim(DESIGN_W, DESIGN_H, 0.3, PAL.bgDeep));
      } else {
        buildProceduralSky();
      }
      view.addChild(vignette(DESIGN_W, DESIGN_H, 0.85));

      /* ---- wordmark + menu ----------------------------------------- */
      buildLogoAndMenu(gameCtx);
      layer(root, "bg").addChild(view);
    },

    unmount() {
      // the seed field is a DOM element: it must go before its pixi host, or
      // it floats over the next scene
      seedField?.destroy();
      seedField = null;
      entering = false;
      stars.length = 0;
      cats.length = 0;
      view.destroy({ children: true });
    },

    update(dtMs) {
      t += dtMs;
      for (const s of stars) {
        s.g.alpha =
          s.base * (0.7 + 0.3 * Math.sin(t * s.speed * 2 * Math.PI + s.phase));
      }
      for (const cat of cats) {
        cat.c.y =
          cat.baseY + Math.sin((t * 2 * Math.PI) / 1600 + cat.phase) * 2;
      }
    },

    onKey(key) {
      if (entering) {
        if (key === "enter" || key === "esc") {
          closeSeedEntry();
          return true;
        } else if (key === "backspace") {
          seedBuffer = seedBuffer.slice(0, -1);
        } else if (/^[a-z0-9-]$/.test(key) && seedBuffer.length < 16) {
          seedBuffer += key.toUpperCase();
        }
        refreshSeedTexts();
        return true; // capture everything while typing a seed
      }
      if (key === "enter") {
        goToTown();
        return true;
      }
      // [C] = Create your party (always available; the creator itself falls
      // back to the Strays when the GM is offline). Continue moved to [O].
      if (key === "c") {
        openPartyCreator();
        return true;
      }
      if (key === "o" && savedRun) {
        continueRun();
        return true;
      }
      if (key === "s") {
        openSeedEntry();
        return true;
      }
      // K2: consume Esc — pause is a run-context overlay (gameloop.md §1
      // FSM); on the title there is no run, so it must never open here.
      if (key === "esc") return true;
      return false;
    },
  };

  /* ---- painted-first rooftop cat ----------------------------------- */
  /**
   * A full-body cat for the skyline: the painted `cat:*` sprite when the
   * art pack has it, the procedural `drawCat` recipe only as the fallback
   * (same painted-first contract as the kit's `avatar()`). Feet land on the
   * container origin.
   */
  function catSprite(classId: ClassId, height: number): Container {
    const c = new Container();
    const tex = catTexture(classId);
    if (tex && tex.height > 0) {
      const sp = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
      sp.scale.set(height / tex.height);
      c.addChild(sp);
    } else {
      const g = new Graphics();
      drawCat(g, classId, "sit");
      c.addChild(g);
    }
    return c;
  }

  /* ---- procedural night sky (fallback when no title:hero asset) ---- */
  function buildProceduralSky(): void {
    for (let i = 0; i < 40; i++) {
      const g = new Graphics().circle(0, 0, 1 + Math.random()).fill(PAL.text);
      g.position.set(Math.random() * DESIGN_W, Math.random() * 440);
      const base = 0.3 + Math.random() * 0.5;
      g.alpha = base;
      stars.push({
        g,
        base,
        phase: Math.random() * Math.PI * 2,
        speed: 1 / (4000 + Math.random() * 2000),
      });
      view.addChild(g);
    }

    // crescent moon: full circle + offset bgDeep crater circle
    const { moon } = R.title;
    view.addChild(
      new Graphics()
        .circle(moon.x, moon.y, moon.r)
        .fill(PAL.text)
        .circle(moon.x + moon.craterDx, moon.y + moon.craterDy, moon.craterR)
        .fill(PAL.bgDeep),
    );

    // rooftop skyline: PAL.void polygon strip with chimney/gable teeth
    const roofY = R.title.rooftopY;
    const teeth = [
      [0, 40, 24],
      [140, 90, -18],
      [260, 70, 30],
      [430, 120, -26],
      [610, 80, 22],
      [760, 110, -14],
      [900, 60, 26],
      [1030, 100, -20],
      [1180, 100, 18],
    ];
    const pts: number[] = [0, DESIGN_H, 0, roofY];
    for (const [x, w, dy] of teeth) {
      pts.push(x, roofY + (dy < 0 ? dy : 0));
      pts.push(x + w, roofY + (dy < 0 ? dy : 0));
      pts.push(x + w, roofY + (dy > 0 ? 0 : 0));
      if (dy > 0) {
        pts[pts.length - 3] = roofY - dy;
        pts[pts.length - 1] = roofY - dy;
      }
    }
    pts.push(DESIGN_W, roofY, DESIGN_W, DESIGN_H);
    view.addChild(new Graphics().poly(pts).fill(PAL.void));

    // the four cats on the roofline (feet at rooftop y)
    R.title.catXs.forEach((x, i) => {
      const c = catSprite(CAT_ORDER[i], 108);
      c.position.set(x, roofY);
      cats.push({ c, baseY: roofY, phase: i * 0.9 });
      view.addChild(c);
    });
  }

  /* ---- wordmark, menu, records (over hero or procedural sky) -------- */
  function buildLogoAndMenu(gameCtx: GameCtx): void {
    // The crest: the keyed `title:logo` emblem over the wordmark, the pair
    // reading as one mark. The kit's `emblem()` is painted-first and falls
    // back to the procedural gold paw, so a missing texture costs the screen
    // nothing (widgets.ts).
    const crest = emblem(EMBLEM_H);
    crest.position.set(DESIGN_W / 2, EMBLEM_Y);
    view.addChild(crest);

    // The wordmark is the one bespoke type on the shared scale: 1.75 × h1.
    const mark = wordmark(TYPE.h1 * 1.75);
    mark.position.set(DESIGN_W / 2, LOGO_Y);
    view.addChild(mark);
    const totalW = mark.width;
    // whisker flourish: 3 lines per side, angled off the logo baseline
    const wg = new Graphics();
    for (const side of [-1, 1]) {
      const x0 = DESIGN_W / 2 + side * (totalW / 2 + SPACE.md);
      for (const [dy0, dy1] of [
        [-14, -22],
        [0, 0],
        [14, 22],
      ]) {
        wg.moveTo(x0, LOGO_Y + dy0)
          .lineTo(x0 + side * 56, LOGO_Y + dy1)
          .stroke({ width: 2, color: PAL.textDim });
      }
    }
    view.addChild(wg);

    const subtitle = heading("A CRPG OF CONSIDERABLE FLUFFINESS", 3, {
      center: true,
    });
    subtitle.position.set(DESIGN_W / 2, SUBTITLE_Y);
    view.addChild(subtitle);

    /* ---- menu ---------------------------------------------------- */
    const entries: {
      label: string;
      hotkey: string;
      onTap: () => void;
      primary?: boolean;
    }[] = [
      {
        label: "To Cat Town",
        hotkey: "Enter",
        onTap: goToTown,
        primary: true,
      },
    ];
    if (savedRun) {
      entries.push({ label: "Continue", hotkey: "O", onTap: continueRun });
    }
    entries.push({
      label: "Create your party",
      hotkey: "C",
      onTap: openPartyCreator,
    });
    entries.push({
      label: "Seed…",
      hotkey: "S",
      onTap: () => {
        if (entering) closeSeedEntry();
        else openSeedEntry();
      },
    });

    const rowsH = entries.length * BTN_H + (entries.length - 1) * BTN_GAP;
    const menuH = rowsH + SPACE.lg * 2 + SPACE.lg;
    const menu = panel(MENU_W, menuH, { variant: "glass" });
    menu.position.set(MENU_X, MENU_TOP);
    view.addChild(menu);

    entries.forEach((e, i) => {
      const b = button(e.label, BTN_W, BTN_H, e.onTap, {
        primary: e.primary,
        hotkey: e.hotkey,
      });
      b.view.position.set(
        (MENU_W - BTN_W) / 2,
        SPACE.lg + i * (BTN_H + BTN_GAP),
      );
      menu.addChild(b.view);
    });

    // live seed entry chip inside the menu foot
    entryChip = label("", { mono: true, fill: PAL.gold, center: true });
    entryChip.position.set(MENU_W / 2, menuH - SPACE.lg - SPACE.xs);
    // where the DOM field lands when a finger opens seed entry
    seedRect = {
      x: MENU_X + 40,
      y: MENU_TOP + menuH - SPACE.lg - SPACE.sm - 30,
      w: MENU_W - 80,
      h: 32,
    };
    entryChip.visible = false;
    menu.addChild(entryChip);

    // records line from MetaFile
    const rec = gameCtx.meta;
    const fastest =
      rec.records.fastestVictoryMs === null
        ? "—"
        : formatTime(rec.records.fastestVictoryMs);
    const records = label(
      `best score ${rec.records.bestScore} · fastest victory ${fastest}` +
        ` · victories ${rec.counters.victories} · runs ${rec.counters.runs}`,
      { dim: true, center: true },
    );
    records.position.set(DESIGN_W / 2, MENU_TOP + menuH + SPACE.lg);
    view.addChild(records);

    // current seed chip bottom-left + version bottom-right
    seedChip = label("", { mono: true, dim: true, size: TYPE.tiny });
    seedChip.position.set(SPACE.md, DESIGN_H - SPACE.lg - SPACE.xs);
    view.addChild(seedChip);
    const version = label("v1", { mono: true, dim: true, size: TYPE.tiny });
    version.anchor.set(1, 0);
    version.position.set(DESIGN_W - SPACE.md, DESIGN_H - SPACE.lg - SPACE.xs);
    view.addChild(version);
    refreshSeedTexts();
  }
}

/** mm:ss for the records line. */
function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
