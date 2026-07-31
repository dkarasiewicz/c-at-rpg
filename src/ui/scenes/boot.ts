/**
 * WP-09 — boot scene (ARCHITECTURE.md §1, gameloop.md §1): the pointer-
 * unlock gate. Palette wash + vignette from the shared chrome kit, the gold
 * paw mark, the wordmark and a pulsing "click to start" prompt. No asset
 * loading; any click or key → title.
 *
 * Chrome comes entirely from the kit (widgets.ts): `sceneBackdrop`,
 * `vignette`, `heading`, `label`. Nothing here draws its own rectangle or
 * invents a type style — see scenes/results.ts for the reference shape.
 */
import { Container, Graphics } from "pixi.js";
import { PAL } from "../palette.js";
import { drawPaw } from "../draw/cats.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import { heading, label, sceneBackdrop, vignette } from "../widgets.js";
import { isTouch } from "../touch.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** Vertical rhythm (design px) — the paw mark is the optical center. */
const PAW_Y = DESIGN_H / 2 - 56;
const WORDMARK_Y = DESIGN_H / 2 + 44;
const PROMPT_Y = DESIGN_H / 2 + 116;

export function createBootScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let started = false;
  let t = 0;
  let prompt: Container | null = null;

  const start = (): void => {
    if (started || !ctx) return;
    started = true;
    ctx.scenes.goto("title");
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;

      // 'scene:boot' is intentionally unpublished: the kit falls back to the
      // palette wash, which IS the boot look (fail-soft by design).
      const backdrop = sceneBackdrop("scene:boot", DESIGN_W, DESIGN_H);
      view.addChild(backdrop, vignette(DESIGN_W, DESIGN_H, 0.9));

      // the whole screen is the click target (browser pointer unlock)
      const hit = new Graphics()
        .rect(0, 0, DESIGN_W, DESIGN_H)
        .fill({ color: PAL.void, alpha: 0.001 });
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.on("pointerdown", start);
      view.addChild(hit);

      // gold paw mark (drawPaw is a 7×7 glyph at scale 1 → ~12× here)
      const paw = new Graphics();
      drawPaw(paw, 0, 0, 12, true);
      paw.position.set(DESIGN_W / 2, PAW_Y);
      view.addChild(paw);

      const wordmark = heading("c(at)rpg", 2, {
        center: true,
        fill: PAL.textDim,
      });
      wordmark.position.set(DESIGN_W / 2, WORDMARK_Y);

      const eyebrow = heading("A CRPG OF CONSIDERABLE FLUFFINESS", 3, {
        center: true,
      });
      eyebrow.position.set(DESIGN_W / 2, WORDMARK_Y + SPACE.xl);

      prompt = label(isTouch() ? "tap to start" : "click to start", {
        center: true,
        size: TYPE.body,
      });
      prompt.position.set(DESIGN_W / 2, PROMPT_Y);
      view.addChild(wordmark, eyebrow, prompt);

      layer(root, "hud").addChild(view);
    },

    unmount() {
      prompt = null;
      view.destroy({ children: true });
    },

    update(dtMs) {
      t += dtMs;
      if (prompt) prompt.alpha = 0.55 + 0.45 * Math.sin(t / 400);
    },

    onKey() {
      start();
      return true;
    },
  };
}
