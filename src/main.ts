/**
 * WP-09 — bootstrap (ARCHITECTURE.md §0.4, §3.4): pixi Application.init,
 * the 1280×720 design-resolution root with uniform letterbox scaling and
 * the 7-layer stack (bg·world·fx·hud·floaters·modal·flash), one input
 * listener, SceneManager construction with the full scene/overlay registry,
 * localStorage probe (MetaFile), and the first scene push → 'boot'.
 */
import { Application, Container } from "pixi.js";
import { PAL } from "./ui/palette.js";
import { DESIGN_H, DESIGN_W } from "./ui/layout.js";
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

  /* ---- root + letterbox scaling (ui-art §1) ------------------------ */
  const root = new Container();
  app.stage.addChild(root);
  const layout = (): void => {
    const scale = Math.min(
      app.screen.width / DESIGN_W,
      app.screen.height / DESIGN_H,
    );
    root.scale.set(scale);
    root.position.set(
      (app.screen.width - DESIGN_W * scale) / 2,
      (app.screen.height - DESIGN_H * scale) / 2,
    );
    // Publish it: every touch hit-area asks this to convert 44 CSS px into
    // design px, and it moves on every resize and every rotate.
    setViewScale(scale);
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
