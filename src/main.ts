/**
 * WP-09 — bootstrap (ARCHITECTURE.md §0.4, §3.4): pixi Application.init,
 * the 1280×720 design-resolution root with uniform letterbox scaling and
 * the 7-layer stack (bg·world·fx·hud·floaters·modal·flash), one input
 * listener, SceneManager construction with the full scene/overlay registry,
 * localStorage probe (MetaFile), and the first scene push → 'boot'.
 */
import { Application, Container } from "pixi.js";
import { PAL } from "./ui/palette";
import { DESIGN_H, DESIGN_W } from "./ui/layout";
import { installFonts } from "./ui/textStyles";
import { initInput, setSceneKeyHandler } from "./ui/input";
import { loadMeta, saveRun } from "./core/run/save";
import {
  createSceneManager,
  LAYER_NAMES,
  type GameCtx,
  type OverlayFactories,
  type SceneFactories,
  type SceneId,
} from "./ui/sceneManager";
import { createBootScene } from "./ui/scenes/boot";
import { createTitleScene } from "./ui/scenes/title";
import { createFloorgenScene } from "./ui/scenes/floorgen";
import { createResultsScene } from "./ui/scenes/results";
import { createExploreScene } from "./ui/scenes/explore";
import { createBattleScene } from "./ui/scenes/battle";
import { EventScene } from "./ui/scenes/event";
import { LandingScene } from "./ui/scenes/landing";
import { LootOverlay } from "./ui/overlays/loot";
import { createPauseOverlay } from "./ui/overlays/pause";
import { mountGalleryIfRequested } from "./ui/draw/glyphs";

/** Scenes whose on-screen time counts as run play time. */
const RUN_SCENES: readonly SceneId[] = [
  "floorgen",
  "explore",
  "battle",
  "event",
  "landing",
];

(async () => {
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
    floorgen: createFloorgenScene,
    explore: createExploreScene,
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
      if (ctx.run?.floor) saveRun(ctx.run);
    },
  };
  manager.bind(ctx);

  /* ---- input + shared ticker --------------------------------------- */
  initInput();
  setSceneKeyHandler((key) => manager.handleKey(key));

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

  manager.goto("boot");
})();
