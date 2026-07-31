/**
 * WP-09 — floorgen interstitial (gameloop.md §1): "Descending… Floor N —
 * <floor name>" for a beat while the floor generates from the seed, then
 * autosave (the first of the five autosave points) and hand off to explore.
 *
 * Entered from title (New Run — floor not yet generated), from the landing
 * (descend() already generated floor n+1) and from results (Again / New
 * Seed). Idempotent: only generates when `run.floor` is null.
 */
import { Container, Graphics, Text } from "pixi.js";
import { FLOORS } from "../../content/floors";
import { generateCurrentFloor } from "../../core/run/runState";
import { maxHp } from "../../core/run/party";
import { applyPartyContent } from "./partyCreator";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W } from "../layout";
import { display, ui } from "../textStyles";
import { layer, type GameCtx, type Scene } from "../sceneManager";

/** How long the interstitial text holds before the explore handoff. */
const HOLD_MS = 600;

export function createFloorgenScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let t = 0;
  let generated = false;
  let done = false;

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
        new Graphics().rect(0, 0, DESIGN_W, DESIGN_H).fill(PAL.bgDeep),
      );
      const header = new Text({
        text: "Descending…",
        style: display(32, { fill: PAL.text }),
      });
      header.anchor.set(0.5);
      header.position.set(DESIGN_W / 2, DESIGN_H / 2 - 28);
      view.addChild(header);
      const sub = new Text({
        text: `Floor ${run.floorNum} — ${name}`,
        style: ui(18, { fill: PAL.gold }),
      });
      sub.anchor.set(0.5);
      sub.position.set(DESIGN_W / 2, DESIGN_H / 2 + 20);
      view.addChild(sub);

      layer(root, "hud").addChild(view);
    },

    unmount() {
      view.destroy({ children: true });
    },

    update(dtMs) {
      if (!ctx || done) return;
      t += dtMs;
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
