/**
 * WP-09 — bootstrap (ARCHITECTURE.md §0.4, §3.4): pixi Application.init,
 * the 1280×720 design-resolution root — a contain-scaled SAFE AREA that the
 * painted backdrop bleeds past to the real screen edges — and
 * the 7-layer stack (bg·world·fx·hud·floaters·modal·flash), one input
 * listener, SceneManager construction with the full scene/overlay registry,
 * localStorage probe (MetaFile), and the first scene push → 'boot'.
 */
import { Application, Container } from "pixi.js";
import { PAL } from "./ui/palette.js";
import { DESIGN_H, DESIGN_W, setViewBleed } from "./ui/layout.js";
import { installFonts } from "./ui/textStyles.js";
import { initInput, setSceneKeyHandler } from "./ui/input.js";
import { initTouch, isTouch, setViewScale } from "./ui/touch.js";
import { loadMeta, saveRun } from "./core/run/save.js";
import { newRun } from "./core/run/runState.js";
import {
  createSceneManager,
  LAYER_NAMES,
  type GameCtx,
  type OverlayFactories,
  type SceneFactories,
  type SceneId,
} from "./ui/sceneManager.js";
import { createBootScene } from "./ui/scenes/boot.js";
import { createTitleScene } from "./ui/scenes/title.js";
import { createCatTownScene } from "./ui/scenes/catTown.js";
import { createPartyCreatorScene } from "./ui/scenes/partyCreator.js";
import { createFloorgenScene } from "./ui/scenes/floorgen.js";
import { createResultsScene } from "./ui/scenes/results.js";
import { createRunMapScene } from "./ui/scenes/runMap.js";
import { createBattleScene } from "./ui/scenes/battle.js";
import { createCampScene } from "./ui/scenes/camp.js";
import { EventScene } from "./ui/scenes/event.js";
import { LandingScene } from "./ui/scenes/landing.js";
import { LootOverlay } from "./ui/overlays/loot.js";
import { createPauseOverlay } from "./ui/overlays/pause.js";
import { mountGalleryIfRequested } from "./ui/draw/glyphs.js";
import { initSprites } from "./ui/sprites.js";

/** Scenes whose on-screen time counts as run play time. */
const RUN_SCENES: readonly SceneId[] = [
  "floorgen",
  "runMap",
  "battle",
  "event",
  "landing",
  "camp",
];

(async () => {
  // Pointer kind first: it stamps `<html data-touch>`, which is what
  // public/style.css keys the landscape gate and the system button off, and
  // what every widget's hit-area padding asks (docs/design/mobile.md §§1-3).
  initTouch();

  const app = new Application();
  await app.init({
    background: PAL.void,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    roundPixels: true,
  });
  document.getElementById("pixi-container")!.appendChild(app.canvas);
  installFonts();
  // visual-v2 generated sprites: manifest + textures, fail-soft (a missing
  // manifest just leaves the procedural renderers in charge). Never throws.
  await initSprites();

  /* ---- root + frame (ui-art §1, docs/design/mobile.md §6) ---------- */
  //
  // 1280×720 is the SAFE AREA, not the screen. The box is CONTAIN-scaled, so
  // every interactive rect is on screen at any aspect from 4:3 to 21:9 — but
  // on a 19.5:9 phone that leaves ~76 CSS px per side, which used to be black
  // letterbox and is now painted: `setViewBleed` tells the backdrop widgets
  // how far past the safe area they must reach (see ui/layout.ts).
  //
  // The box is centred inside the SAFE-INSET part of the window rather than
  // the raw window, so a notch never lands on a corner of the HUD and the
  // DOM chrome docked to the real edge (the menu button) keeps its lane.
  const root = new Container();
  app.stage.addChild(root);

  // env(safe-area-inset-*) is only readable through a resolved property:
  // reading the custom property back hands you the literal `env(...)` token.
  // A 0×0 probe whose padding is those four vars resolves them for pixi —
  // and lets a desktop test rehearse a notch by overriding the vars.
  const probe = document.createElement("div");
  probe.id = "safe-probe";
  document.body.appendChild(probe);
  const px = (v: string): number => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const setVar = (name: string, value: number): void =>
    document.documentElement.style.setProperty(name, `${value}px`);
  /**
   * The band beside the safe box that #sys-menu parks in: a 44 CSS px target
   * (docs/design/mobile.md §1) plus 2px of air on each side.
   */
  const MENU_LANE = 48;

  const layout = (): void => {
    const vw = app.screen.width;
    const vh = app.screen.height;
    const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
    const boxW = DESIGN_W * scale;
    const boxH = DESIGN_H * scale;

    const s = getComputedStyle(probe);
    const insT = px(s.paddingTop);
    const insR = px(s.paddingRight);
    const insB = px(s.paddingBottom);
    const insL = px(s.paddingLeft);
    // Centre in the inset-free window, but NEVER outside the window itself:
    // the box already fills one axis exactly (contain fit), so on that axis
    // an inset would otherwise push a HUD row off the top of the screen.
    // The clamp turns that into "as far from the inset as the axis allows".
    const clamp = (v: number, hi: number): number =>
      Math.min(Math.max(v, 0), Math.max(0, hi));
    let x = clamp(insL + (vw - insL - insR - boxW) / 2, vw - boxW);
    const y = clamp(insT + (vh - insT - insB - boxH) / 2, vh - boxH);
    // …then give #sys-menu its lane. On a notched iPhone the notch eats most
    // of the right-hand slack and the button ends up ON the Scatter! chip
    // (the reported bug). Sliding the box a few px LEFT — never past the
    // left inset, never right — buys the lane back, and with the backdrop
    // bleeding to both edges the shift is invisible.
    const need = MENU_LANE - (vw - insR - (x + boxW));
    if (need > 0) x -= Math.min(need, Math.max(0, x - insL));

    root.scale.set(scale);
    root.position.set(x, y);
    // Publish it: every touch hit-area asks this to convert 44 CSS px into
    // design px, and it moves on every resize and every rotate.
    setViewScale(scale);
    // The overhang the painted backdrop must cover, design px per side. The
    // WIDER side wins on both axes — an off-centre box would otherwise leave
    // the far edge unpainted; overshoot on the near side is off screen.
    setViewBleed(
      Math.max(x, vw - x - boxW) / scale,
      Math.max(y, vh - y - boxH) / scale,
    );

    // Hand the page chrome the real geometry of the box. #sys-menu parks in
    // whichever gutter can actually hold a 44px target (public/style.css).
    setVar("--box-left", x);
    setVar("--box-top", y);
    setVar("--box-right", vw - x - boxW);
    setVar("--box-bottom", vh - y - boxH);
    const freeRight = vw - x - boxW - insR;
    const freeTop = y - insT;
    document.documentElement.dataset.menuDock =
      freeRight >= MENU_LANE ? "right" : freeTop >= MENU_LANE ? "top" : "inset";
  };
  layout();
  app.renderer.on("resize", layout);

  // ?gallery=1 — WP-08 dev glyph gallery instead of the game (ui-art §12)
  if (mountGalleryIfRequested(root)) return;

  for (const name of LAYER_NAMES) {
    const c = new Container();
    c.label = name;
    root.addChild(c);
  }

  /* ---- scene manager + shared GameCtx ------------------------------ */
  const scenes: SceneFactories = {
    boot: createBootScene,
    title: createTitleScene,
    catTown: createCatTownScene,
    partyCreator: createPartyCreatorScene,
    floorgen: createFloorgenScene,
    runMap: createRunMapScene,
    battle: createBattleScene,
    camp: createCampScene,
    event: () => new EventScene(),
    landing: () => new LandingScene(),
    results: createResultsScene,
  };
  const overlays: OverlayFactories = {
    loot: () => new LootOverlay(),
    pause: createPauseOverlay,
  };
  const manager = createSceneManager(root, scenes, overlays);

  const ctx: GameCtx = {
    run: null,
    scenes: manager,
    meta: loadMeta(), // localStorage probe — records shown on title
    save() {
      // the 5 autosave points call this; a run mid-floor is always present
      if (ctx.run?.floorMap) saveRun(ctx.run);
    },
  };
  manager.bind(ctx);

  /* ---- input + shared ticker --------------------------------------- */
  initInput();
  setSceneKeyHandler((key) => manager.handleKey(key));

  /* ---- touch chrome (docs/design/mobile.md §1) ----------------------- */
  // Esc is the busiest key in the game — it pauses, closes the active
  // overlay, backs out of the Den and the sell panel, cancels targeting and
  // shuts the inspect card — and the scene manager already routes every one
  // of those. So touch parity for all of it is ONE control feeding the same
  // router, rather than an Esc button bolted onto eight scenes.
  const sysMenu = document.getElementById("sys-menu");
  sysMenu?.addEventListener("click", (e) => {
    e.preventDefault();
    manager.handleKey("esc");
  });
  // The button is a real <button>, so a stray Enter/Space on it would fire
  // twice (once as a click, once through the game's key listener).
  sysMenu?.addEventListener("keydown", (e) => e.stopPropagation());
  if (isTouch()) {
    // A rotate is a resize plus a new letterbox; pixi's `resizeTo: window`
    // handles the canvas, `layout` handles the root, and this settles the
    // case where the two fire before the browser has finished rotating.
    window.addEventListener("orientationchange", () => {
      setTimeout(
        () => app.renderer.resize(window.innerWidth, window.innerHeight),
        120,
      );
    });
  }

  app.ticker.add((t) => {
    manager.update(t.deltaMS);
    // play time accrues only while actually playing (never on title/
    // results, never under a pause/loot overlay)
    if (
      ctx.run &&
      manager.overlay === null &&
      RUN_SCENES.includes(manager.current)
    ) {
      ctx.run.playTimeMs += t.deltaMS;
    }
  });

  // Dev/CI observability hook (read-only, like ?gallery=1): lets automated
  // smokes poll the active scene id instead of guessing from pixels.
  (window as unknown as { __scene?: () => string }).__scene = () =>
    manager.current;
  // Same idea for the active overlay (null when none) and the live run —
  // lets smokes wait for the loot overlay / read party position instead of
  // guessing from pixels.
  (window as unknown as { __overlay?: () => string | null }).__overlay = () =>
    manager.overlay;
  (window as unknown as { __run?: () => unknown }).__run = () => ctx.run;

  // Read-only hit-area census, same family as the hooks above. A TAP-ONLY
  // smoke has no keyboard to fall back on, so it must aim at whatever is
  // actually interactive right now — guessing coordinates from a mockup is
  // how a touch test passes while the shipped button sits 20px away.
  //
  // Walks the live stage for containers with a real `eventMode` and reports
  // each one's bounds together with the text found inside it, so a caller can
  // aim at "To Cat Town" by name instead of by pixel.
  //
  // The rectangles come from `getBounds()`, i.e. GLOBAL/stage space — the
  // letterbox scale and offset are already baked in — so they are canvas CSS
  // pixels and a caller taps their centre directly, no conversion. (They are
  // the ART bounds, not the padded touch hit area; touch.ts grows `contains`
  // without growing the box, which is the point of it.)
  (
    window as unknown as {
      __hits?: () => {
        text: string;
        x: number;
        y: number;
        w: number;
        h: number;
      }[];
    }
  ).__hits = () => {
    const out: { text: string; x: number; y: number; w: number; h: number }[] =
      [];
    const words = (c: Container): string => {
      const acc: string[] = [];
      const walk = (n: Container): void => {
        const t = (n as unknown as { text?: unknown }).text;
        if (typeof t === "string" && t.trim() !== "") acc.push(t.trim());
        for (const k of n.children) walk(k as Container);
      };
      walk(c);
      return acc.join(" ").slice(0, 80);
    };
    const walk = (n: Container): void => {
      // `visible` is what pixi hides AND what its hit test skips, and it is a
      // SEPARATE flag from `renderable` — a closed card keeps `renderable`
      // true and still answers `getBounds()`. Descending into one lists
      // buttons nobody can see or press, which reads to a caller as a button
      // that ignores taps. So an invisible subtree is not walked at all.
      if (!n.visible || n.alpha <= 0.01) return;
      const mode = (n as unknown as { eventMode?: string }).eventMode;
      if ((mode === "static" || mode === "dynamic") && n.renderable) {
        const b = n.getBounds();
        if (b.width > 0 && b.height > 0) {
          out.push({
            text: words(n),
            x: b.x,
            y: b.y,
            w: b.width,
            h: b.height,
          });
        }
      }
      for (const k of n.children) walk(k as Container);
    };
    walk(root);
    return out;
  };

  // Read-only census of every VISIBLE line of text on the stage, in reading
  // order — the sibling `__hits` cannot answer, because it only ever lists
  // INTERACTIVE nodes and most of what the game says to the player is not
  // interactive: the DM's narration, a verdict beat, a tooltip, a score row.
  //
  // A gate that has to prove "a real narration came back and a refusal reads
  // as the DM saying no" otherwise has to infer it from pixels or from the
  // network, and neither of those is what the player is looking at.
  //
  // Bounds are `getBounds()`, i.e. GLOBAL/stage space, exactly like `__hits`.
  (
    window as unknown as {
      __text?: () => { text: string; x: number; y: number }[];
    }
  ).__text = () => {
    const out: { text: string; x: number; y: number }[] = [];
    const walk = (n: Container): void => {
      if (!n.visible || n.alpha <= 0.01) return;
      const t = (n as unknown as { text?: unknown }).text;
      if (typeof t === "string" && t.trim() !== "" && n.renderable) {
        const b = n.getBounds();
        out.push({ text: t.trim(), x: b.x, y: b.y });
      }
      for (const k of n.children) walk(k as Container);
    };
    walk(root);
    return out.sort((a, b) => a.y - b.y || a.x - b.x);
  };

  // ?smoke=battle — dev/CI hook (like ?gallery=1): skip boot/title, start a
  // fresh run and drop straight into a non-boss battle so automated UI
  // smokes can exercise combat deterministically. Follows the FSM legally:
  // boot → title → floorgen → runMap → battle.
  const smoke = new URLSearchParams(window.location.search).get("smoke");
  if (smoke === "battle") {
    manager.goto("boot");
    manager.goto("title");
    ctx.run = newRun("SMOKE1");
    manager.goto("floorgen");
    const poll = setInterval(() => {
      if (manager.current === "runMap") {
        clearInterval(poll);
        manager.goto("battle", {
          enemies: ["ratThug", "ratThug", "sewerBat"],
          encounterIndex: 1,
        });
      }
    }, 100);
    return;
  }

  manager.goto("boot");

  /* ---- PWA (docs/design/mobile.md §5) -------------------------------- */
  // The game already runs without the network, so the worker is packaging:
  // it makes c(at)rpg installable and makes the second launch instant. It is
  // registered LAST and fire-and-forget — a browser without service workers,
  // an insecure origin, or a rejected registration must never cost a frame.
  if ("serviceWorker" in navigator && import.meta.env?.DEV !== true) {
    const register = (): void => {
      void navigator.serviceWorker
        .register("/sw.js")
        .then(async () => {
          await navigator.serviceWorker.ready;
          // Hand the worker the real dependency set. The very first visit
          // fetches the bundle BEFORE the worker exists, and the renderer
          // chunk, the fonts and the first screen's art all arrive through
          // dynamic imports that no static precache list can name — so the
          // page reports what it actually loaded and the worker caches that.
          const urls = performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((n) => n.startsWith(window.location.origin));
          navigator.serviceWorker.controller?.postMessage({
            type: "warm",
            urls,
          });
        })
        .catch(() => {
          /* offline-first is a bonus here, never a requirement */
        });
    };
    // This bootstrap awaits `app.init()` and `initSprites()`, so by the time
    // we get here `load` has usually ALREADY fired and a bare
    // addEventListener('load') would never run. Check first, listen second.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }
})();
