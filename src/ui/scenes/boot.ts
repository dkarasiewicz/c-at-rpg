/**
 * WP-09 — boot scene (ARCHITECTURE.md §1, gameloop.md §1): the pointer-
 * unlock gate, dressed as the FRONT OF THE GAME rather than a loading stub.
 * Painted backdrop, the `title:logo` emblem over its warm pool, the c(at)rpg
 * wordmark under a gold rule, the eyebrow and a pulsing "tap to start". No
 * asset loading happens here; any tap or key → title.
 *
 * Chrome comes entirely from the kit (widgets.ts): `sceneBackdrop`,
 * `vignette`, `emblem`, `wordmark`, `heading`, `label`. Nothing here draws
 * its own rectangle or invents a type style — see scenes/results.ts for the
 * reference shape.
 *
 * Fail-soft twice over, because this is the screen that must never be blank:
 * the emblem falls back to the procedural gold paw when `title:logo` is
 * missing, and the backdrop falls back to the palette wash when neither
 * `scene:boot` nor the title hero has been generated.
 */
import { Container, Graphics } from "pixi.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  emblem,
  heading,
  label,
  sceneBackdrop,
  vignette,
  wordmark,
} from "../widgets.js";
import { hasSprite } from "../sprites.js";
import { isTouch } from "../touch.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";
import { hydrateDreamedDefs } from "../../services/pool.js";

/* ---- vertical rhythm (design px) ------------------------------------- */
const EMBLEM_Y = 268;
const EMBLEM_H = 256;
const RULE_Y = 432;
const WORDMARK_Y = 484;
const EYEBROW_Y = 534;
const PROMPT_Y = 606;

export function createBootScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let started = false;
  let t = 0;
  let prompt: Container | null = null;
  let mark: Container | null = null;

  const start = (): void => {
    if (started || !ctx) return;
    started = true;
    ctx.scenes.goto("title");
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;

      // Re-register anything this browser ever dreamed, from localStorage,
      // SYNCHRONOUSLY and with no request. A saved town holding a dreamed
      // item must open even with the pool switched off — the def has to be
      // back in the table before any panel looks it up by id.
      hydrateDreamedDefs();

      // 'scene:boot' is the screen's own art when it exists; the title hero
      // is the stand-in, pushed well back so the emblem stays the subject.
      // With neither, the kit paints its palette wash — which IS the old
      // boot look, so the screen can never come up empty.
      const own = hasSprite("scene:boot");
      const id = own ? "scene:boot" : "title:hero";
      view.addChild(
        // Blurred + dimmed: the emblem is the subject of this screen, and the
        // art behind it is depth of field, not a second illustration.
        //
        // Two dims, because they are two different pictures. `title:hero` is
        // the cast poster — bright, busy, and it has to be knocked most of the
        // way back or it fights the crest. `scene:boot` was painted FOR this
        // screen (a stairway going down, one lantern, almost no incident), so
        // the same 0.66 just erases it; at 0.44 the lantern still glows behind
        // the wordmark and the screen has somewhere to be.
        sceneBackdrop(id, DESIGN_W, DESIGN_H, {
          dim: own ? 0.44 : 0.66,
          blur: true,
        }),
        vignette(DESIGN_W, DESIGN_H, 0.9),
      );

      // the whole screen is the click target (browser pointer unlock)
      const hit = new Graphics()
        .rect(0, 0, DESIGN_W, DESIGN_H)
        .fill({ color: PAL.void, alpha: 0.001 });
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.on("pointerdown", start);
      view.addChild(hit);

      // the keyed emblem (procedural paw when the art pack is absent)
      mark = emblem(EMBLEM_H);
      mark.position.set(DESIGN_W / 2, EMBLEM_Y);
      view.addChild(mark);

      // gold rule: the hairline that turns a splash into a title card
      const rule = new Graphics();
      rule
        .moveTo(DESIGN_W / 2 - 150, RULE_Y)
        .lineTo(DESIGN_W / 2 + 150, RULE_Y)
        .stroke({ width: 1, color: PAL.goldDark, alpha: 0.7 });
      view.addChild(rule);

      const mark2 = wordmark(TYPE.h1 * 1.6);
      mark2.position.set(DESIGN_W / 2, WORDMARK_Y);
      view.addChild(mark2);

      const eyebrow = heading("A CRPG OF CONSIDERABLE FLUFFINESS", 3, {
        center: true,
      });
      eyebrow.position.set(DESIGN_W / 2, EYEBROW_Y);

      prompt = label(isTouch() ? "tap to start" : "click to start", {
        center: true,
        size: TYPE.body,
      });
      prompt.position.set(DESIGN_W / 2, PROMPT_Y);
      view.addChild(eyebrow, prompt);

      layer(root, "hud").addChild(view);
    },

    unmount() {
      prompt = null;
      mark = null;
      view.destroy({ children: true });
    },

    update(dtMs) {
      t += dtMs;
      if (prompt) prompt.alpha = 0.55 + 0.45 * Math.sin(t / 400);
      // the emblem breathes — a still image reads as a frozen loader
      if (mark) {
        const s = 1 + 0.012 * Math.sin((t * 2 * Math.PI) / 3600);
        mark.scale.set(s);
        mark.y = EMBLEM_Y + Math.sin((t * 2 * Math.PI) / 5200) * SPACE.xs;
      }
    },

    onKey() {
      start();
      return true;
    },
  };
}
