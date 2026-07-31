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
import { createPartyCreatorScene } from "./ui/scenes/partyCreator.js";
import { createFloorgenScene } from "./ui/scenes/floorgen.js";
import { createResultsScene } from "./ui/scenes/results.js";
import { createExploreScene } from "./ui/scenes/explore.js";
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
    partyCreator: createPartyCreatorScene,
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

  // ?smoke=battle — dev/CI hook (like ?gallery=1): skip boot/title, start a
  // fresh run and drop straight into a non-boss battle so automated UI
  // smokes can exercise combat deterministically. Follows the FSM legally:
  // boot → title → floorgen → explore → battle.
  const smoke = new URLSearchParams(window.location.search).get("smoke");
  if (smoke === "battle") {
    manager.goto("boot");
    manager.goto("title");
    ctx.run = newRun("SMOKE1");
    manager.goto("floorgen");
    const poll = setInterval(() => {
      if (manager.current === "explore") {
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
})();
