/**
 * WP-09 — floorgen interstitial (gameloop.md §1): "Descending… Floor N —
 * <floor name>" for a beat while the floor generates from the seed, then
 * autosave (the first of the five autosave points) and hand off to explore.
 *
 * Entered from title (New Run — floor not yet generated), from the landing
 * (descend() already generated floor n+1) and from results (Again / New
 * Seed). Idempotent: only generates when `run.floor` is null.
 *
 * All chrome from the shared kit (widgets.ts): backdrop + vignette,
 * heading/label type scale, the kit's XP-colored `bar` as the hold meter.
 */
import { Container } from "pixi.js";
import { FLOORS } from "../../content/floors.js";
import { generateCurrentFloor } from "../../core/run/runState.js";
import { maxHp } from "../../core/run/party.js";
import { applyPartyContent } from "./partyCreator.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import { bar, heading, label, sceneBackdrop, vignette } from "../widgets.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** How long the interstitial text holds before the explore handoff. */
const HOLD_MS = 600;

/** Vertical rhythm (design px). */
const EYEBROW_Y = DESIGN_H / 2 - 78;
const BANNER_Y = DESIGN_H / 2 - 42;
const NAME_Y = DESIGN_H / 2 + 16;
const METER_Y = DESIGN_H / 2 + 62;
const METER_W = 320;

export function createFloorgenScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let t = 0;
  let generated = false;
  let done = false;
  let meter: ReturnType<typeof bar> | null = null;

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;
      let run = ctx.run;
      if (!run) throw new Error("floorgen: no run in ctx");

      // Every run start passes through here (title New Run, party creator,
      // results Again/New Seed, landing descend): sync the content tables
      // with THIS run's party — overlay run.customParty, or restore the
      // stock Strays when absent. Re-clamp current HP afterwards in case a
      // previous run's overlay inflated it past this party's max.
      applyPartyContent(run.customParty);
      const level = run.level;
      const before = run.cats;
      const cats = before.map((cat) => {
        const cap = maxHp(cat, level);
        return cat.hp > cap ? { ...cat, hp: cap } : cat;
      });
      if (cats.some((c, i) => c !== before[i])) {
        run = { ...run, cats };
        ctx.run = run;
      }

      const cfg = FLOORS[run.floorNum - 1];
      const name = cfg ? cfg.name : `Floor ${run.floorNum}`;

      view.addChild(
        sceneBackdrop("scene:floorgen", DESIGN_W, DESIGN_H, { dim: 0.5 }),
        vignette(DESIGN_W, DESIGN_H, 0.8),
      );

      const eyebrow = heading("DESCENDING", 3, { center: true });
      eyebrow.position.set(DESIGN_W / 2, EYEBROW_Y);

      const banner = heading(`Floor ${run.floorNum}`, 1, { center: true });
      banner.position.set(DESIGN_W / 2, BANNER_Y);

      const floorName = label(name, {
        center: true,
        fill: PAL.gold,
        bold: true,
      });
      floorName.position.set(DESIGN_W / 2, NAME_Y);

      const seed = label(`seed ${run.runSeed}`, {
        center: true,
        dim: true,
        mono: true,
        size: TYPE.tiny,
      });
      seed.position.set(DESIGN_W / 2, NAME_Y + SPACE.lg + SPACE.xs);

      view.addChild(eyebrow, banner, floorName, seed);

      // hold meter: a plain progress read-out on the shared bar widget
      meter = bar(METER_W, 6, { kind: "xp", ticks: false });
      meter.view.position.set((DESIGN_W - METER_W) / 2, METER_Y);
      meter.set(0, 1, false);
      view.addChild(meter.view);

      layer(root, "hud").addChild(view);
    },

    unmount() {
      meter = null;
      view.destroy({ children: true });
    },

    update(dtMs) {
      if (!ctx || done) return;
      t += dtMs;
      meter?.set(Math.min(t, HOLD_MS), HOLD_MS, false);
      // generate on the second frame so the interstitial text is on screen
      // first (it also masks the generation/GC hitch — gameloop.md §1)
      if (!generated && t > 0) {
        generated = true;
        if (ctx.run && !ctx.run.floor) {
          ctx.run = generateCurrentFloor(ctx.run);
        }
        ctx.save(); // autosave point 1: after FLOORGEN
      }
      if (t >= HOLD_MS) {
        done = true;
        ctx.scenes.goto("explore");
      }
    },
  };
}
