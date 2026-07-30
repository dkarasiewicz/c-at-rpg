/**
 * WP-09 — pause overlay (gameloop.md §6): Esc menu with Resume / Party /
 * Inventory / Help / Abandon Run, plus a footer showing run seed (click to
 * copy), floor and play time. Freeze semantics live in the SceneManager
 * (underlying scene update skipped, interactiveChildren = false); this
 * overlay only renders and routes its own input.
 *
 * Party/Inventory open WP-12's panel (ui/overlays/inventoryPanel.ts);
 * marching-order editing is read-only while a battle scene is beneath.
 * Abandon → RESULTS(defeat, cause 'abandoned') — results deletes the save.
 */
import { Container, Graphics, Text } from "pixi.js";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W, RADIUS } from "../layout";
import { display, mono, ui } from "../textStyles";
import { makeButton, makePanel, type Button } from "../widgets";
import { makeInventoryPanel } from "./inventoryPanel";
import { layer, type GameCtx, type Overlay } from "../sceneManager";
import type { ResultsParams } from "../scenes/results";

const PANEL: [number, number, number, number] = [460, 120, 360, 480];

interface SubPanel {
  view: Container;
  onKey?(key: string): boolean;
  destroy(): void;
}

export function createPauseOverlay(): Overlay {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let sub: SubPanel | null = null;
  const subHost = new Container();
  let timeText: Text | null = null;
  let abandonArmed = false;
  let abandonBtn: Button | null = null;
  let seedText: Text | null = null;
  let elapsedBase = 0;
  let showHelp: () => void = () => undefined;

  const closeSub = (): void => {
    if (!sub) return;
    sub.destroy();
    sub = null;
    subHost.removeChildren();
  };

  /**
   * Party & Inventory both open WP-12's embeddable panel (16-slot grid +
   * per-cat equip cards — the panel covers both tabs' needs). Marching-
   * order edits are a Landing/Tab concern; while a battle scene is beneath
   * the overlay nothing order-related is offered here anyway.
   */
  const openSub = (): void => {
    const c = ctx;
    if (!c || !c.run) return;
    closeSub();
    const panel = makeInventoryPanel({
      mode: "manage",
      getRun: () => {
        if (!c.run) throw new Error("pause: run vanished");
        return c.run;
      },
      setRun: (run) => {
        c.run = run;
      },
    });
    panel.view.position.set(160, 195); // 960×330 default, centered
    sub = panel;
    subHost.addChild(panel.view);
  };

  const resume = (): void => {
    ctx?.scenes.popOverlay();
  };

  const abandon = (): void => {
    if (!ctx || !ctx.run) return;
    if (!abandonArmed) {
      abandonArmed = true;
      abandonBtn?.setLabel("Really abandon?");
      return;
    }
    const params: ResultsParams = {
      victory: false,
      cause: `abandoned on floor ${ctx.run.floorNum}`,
    };
    ctx.scenes.goto("results", params); // pops this overlay first
  };

  const copySeed = (): void => {
    const seed = ctx?.run?.runSeed;
    if (!seed || !seedText) return;
    void navigator.clipboard?.writeText(seed);
    seedText.text = "copied!";
    setTimeout(() => {
      if (seedText && ctx?.run) seedText.text = `seed ${ctx.run.runSeed}`;
    }, 900);
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;
      elapsedBase = ctx.run?.playTimeMs ?? 0;

      const scrim = new Graphics()
        .rect(0, 0, DESIGN_W, DESIGN_H)
        .fill({ color: PAL.scrim, alpha: 0.6 });
      scrim.eventMode = "static"; // swallow clicks beneath the menu
      view.addChild(scrim);

      const [px, py, pw, ph] = PANEL;
      const panel = makePanel(pw, ph);
      panel.position.set(px, py);
      view.addChild(panel);

      const header = new Text({
        text: "PAUSED",
        style: display(32, { fill: PAL.text }),
      });
      header.anchor.set(0.5, 0);
      header.position.set(px + pw / 2, py + 18);
      view.addChild(header);

      const hasRun = !!ctx.run;
      const rows: {
        label: string;
        onTap: () => void;
        enabled?: boolean;
        primary?: boolean;
      }[] = [
        { label: "[1] Resume", onTap: resume, primary: true },
        { label: "[2] Party", onTap: openSub, enabled: hasRun },
        { label: "[3] Inventory", onTap: openSub, enabled: hasRun },
        { label: "[4] Help", onTap: () => showHelp(), enabled: true },
        { label: "[5] Abandon Run", onTap: abandon, enabled: hasRun },
      ];
      rows.forEach((r, i) => {
        const b = makeButton(r.label, pw - 48, 48, r.onTap, {
          primary: r.primary,
          fontSize: 16,
        });
        b.view.position.set(px + 24, py + 76 + i * 60);
        if (r.enabled === false) b.setEnabled(false);
        if (i === 4) abandonBtn = b;
        view.addChild(b.view);
      });

      /* ---- footer: seed (click to copy) · floor · time ------------- */
      const footY = py + ph - 34;
      seedText = new Text({
        text: ctx.run ? `seed ${ctx.run.runSeed}` : "no run",
        style: mono(11, { fill: PAL.textDim }),
      });
      seedText.position.set(px + 24, footY);
      seedText.eventMode = "static";
      seedText.cursor = "pointer";
      seedText.on("pointerdown", copySeed);
      view.addChild(seedText);

      const floorText = new Text({
        text: ctx.run ? `floor ${ctx.run.floorNum}` : "",
        style: mono(11, { fill: PAL.textDim }),
      });
      floorText.anchor.set(0.5, 0);
      floorText.position.set(px + pw / 2, footY);
      view.addChild(floorText);

      timeText = new Text({
        text: "",
        style: mono(11, { fill: PAL.textDim }),
      });
      timeText.anchor.set(1, 0);
      timeText.position.set(px + pw - 24, footY);
      view.addChild(timeText);

      view.addChild(subHost);
      layer(root, "modal").addChild(view);

      /* Help is a one-page static panel (gameloop.md §6.4). */
      showHelp = (): void => {
        closeSub();
        const help = new Container();
        const hp = makePanel(560, 300);
        help.addChild(hp);
        const lines = [
          "WASD/arrows step · E interact · M map · Tab marching order",
          "Battle: 1-6 skills · arrows move-swap · G guard · R Scatter!",
          "Shove enemies with moveTarget skills — a forced move makes",
          "them OFF-BALANCE (+50% damage taken until round end).",
          "When EVERY living enemy is Off-Balance: CAT PILE — pile on",
          "for big typeless damage, or keep the +50% windows. Your call.",
        ].join("\n");
        const txt = new Text({
          text: lines,
          style: ui(14, { fill: PAL.text, lineHeight: 24 }),
        });
        txt.position.set(24, 20);
        help.addChild(txt);
        const back = new Graphics()
          .roundRect(0, 0, 92, 30, RADIUS.button)
          .fill(PAL.panel)
          .stroke({ width: 2, color: PAL.border });
        const backLabel = new Text({
          text: "[Esc] back",
          style: ui(13, { fill: PAL.textDim }),
        });
        backLabel.anchor.set(0.5);
        backLabel.position.set(46, 15);
        back.addChild(backLabel);
        back.position.set(560 - 116, 300 - 46);
        back.eventMode = "static";
        back.cursor = "pointer";
        back.on("pointerdown", closeSub);
        help.addChild(back);
        help.position.set(PANEL[0] - 580, PANEL[1] + 40);
        sub = { view: help, destroy: () => help.destroy({ children: true }) };
        subHost.addChild(help);
      };
    },

    unmount() {
      closeSub();
      timeText = null;
      seedText = null;
      abandonBtn = null;
      view.destroy({ children: true });
    },

    update() {
      // play time is frozen while paused — the run clock stops beneath us
      if (timeText) {
        const s = Math.floor(elapsedBase / 1000);
        const mm = Math.floor(s / 60);
        timeText.text = `${mm}:${String(s % 60).padStart(2, "0")}`;
      }
    },

    onKey(key) {
      if (sub) {
        if (sub.onKey?.(key)) return true;
        if (key === "esc") {
          closeSub();
          return true; // Esc closes the sub-panel first, next Esc resumes
        }
        return true;
      }
      if (key === "enter" || key === "1") {
        resume();
        return true;
      }
      if ((key === "2" || key === "3") && ctx?.run) {
        openSub();
        return true;
      }
      if (key === "4") {
        showHelp();
        return true;
      }
      if (key === "5" && ctx?.run) {
        abandon();
        return true;
      }
      // Esc falls through unconsumed → the SceneManager pops the overlay
      return false;
    },
  };
}
