/**
 * WP-09 — boot scene (ARCHITECTURE.md §1, gameloop.md §1): black screen,
 * procedural paw-print logo, "click to start". Satisfies the browser
 * pointer-unlock requirement; no asset loading — everything is procedural.
 * Any click or key → title.
 */
import { Container, Graphics, Text } from "pixi.js";
import { PAL } from "../palette";
import { ui, mono } from "../textStyles";
import { drawPaw } from "../draw/cats";
import { DESIGN_H, DESIGN_W } from "../layout";
import { layer, type GameCtx, type Scene } from "../sceneManager";

export function createBootScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let started = false;
  let t = 0;
  let prompt: Text | null = null;

  const start = (): void => {
    if (started || !ctx) return;
    started = true;
    ctx.scenes.goto("title");
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;

      const black = new Graphics()
        .rect(0, 0, DESIGN_W, DESIGN_H)
        .fill(PAL.void);
      black.eventMode = "static";
      black.cursor = "pointer";
      black.on("pointerdown", start);
      view.addChild(black);

      // big gold paw logo (drawPaw is a 7×7 glyph at scale 1 → ~12× here)
      const paw = new Graphics();
      drawPaw(paw, 0, 0, 12, true);
      paw.position.set(DESIGN_W / 2, DESIGN_H / 2 - 40);
      view.addChild(paw);

      const title = new Text({
        text: "c(at)rpg",
        style: mono(22, { fill: PAL.textDim }),
      });
      title.anchor.set(0.5);
      title.position.set(DESIGN_W / 2, DESIGN_H / 2 + 52);
      view.addChild(title);

      prompt = new Text({
        text: "click to start",
        style: ui(18, { fill: PAL.text }),
      });
      prompt.anchor.set(0.5);
      prompt.position.set(DESIGN_W / 2, DESIGN_H / 2 + 110);
      view.addChild(prompt);

      layer(root, "hud").addChild(view);
    },

    unmount() {
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
