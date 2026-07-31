/**
 * WP-09 — pause overlay (gameloop.md §6): Esc menu with Resume / The Den /
 * Inventory / Help / Abandon Run, plus a footer showing run seed (click to
 * copy), floor and play time. Freeze semantics live in the SceneManager
 * (underlying scene update skipped, interactiveChildren = false); this
 * overlay only renders and routes its own input.
 *
 * THE DEN (row 2, hotkey P — ui/overlays/progressPanel.ts) is the
 * progression screen: Whisker Points, the battle loadout, the three gear
 * slots. Its row carries a gold badge whenever a cat has a point unspent,
 * so a level-up cannot be missed. Inventory opens WP-12's 16-slot panel
 * (ui/overlays/inventoryPanel.ts); marching-order editing is read-only
 * while a battle scene is beneath.
 * Abandon → RESULTS(defeat, cause 'abandoned') — results deletes the save.
 *
 * Chrome is the shared kit (widgets.ts): `scrim`, one raised `panel`, the
 * `button` language with hotkey chips, `heading`/`label` type. Opening a
 * sub-panel hides the menu column instead of stacking two panels on top of
 * each other.
 */
import { Container, Text } from "pixi.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  button,
  heading,
  label,
  panel,
  scrim,
  type Button,
} from "../widgets.js";
import {
  INVENTORY_PANEL_H,
  INVENTORY_PANEL_W,
  makeInventoryPanel,
} from "./inventoryPanel.js";
import {
  DEN_HOTKEY,
  DEN_LABEL,
  makeDenBox,
  makePointBadgeAt,
  totalUnspentPoints,
} from "./progressPanel.js";
import { isTouch } from "../touch.js";
import { layer, type GameCtx, type Overlay } from "../sceneManager.js";
import type { ResultsParams } from "../scenes/results.js";

/* ---- geometry (design px) -------------------------------------------- */
const MENU_W = 340;
const BTN_W = MENU_W - SPACE.lg * 2;
const BTN_H = 52;
const BTN_GAP = SPACE.md;
const ROWS = 5;
const HEADER_H = 76;
const FOOTER_H = 40;
const MENU_H =
  HEADER_H + ROWS * BTN_H + (ROWS - 1) * BTN_GAP + FOOTER_H + SPACE.lg;
const MENU_X = (DESIGN_W - MENU_W) / 2;
const MENU_Y = (DESIGN_H - MENU_H) / 2;

/** Help card geometry. */
const HELP_W = 640;
const HELP_H = 320;

interface SubPanel {
  view: Container;
  onKey?(key: string): boolean;
  destroy(): void;
}

export function createPauseOverlay(): Overlay {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let sub: SubPanel | null = null;
  const menuLayer = new Container();
  const subHost = new Container();
  let timeText: Text | null = null;
  let abandonArmed = false;
  let abandonBtn: Button | null = null;
  let seedText: Text | null = null;
  let elapsedBase = 0;
  let showHelp: () => void = () => undefined;
  let denBadgeHost: Container | null = null;

  /** Unspent Whisker Points pill on the Den row — level-ups are unmissable. */
  const paintBadge = (): void => {
    if (!denBadgeHost) return;
    for (const c of denBadgeHost.removeChildren())
      c.destroy({ children: true });
    const run = ctx?.run;
    if (!run) return;
    const badge = makePointBadgeAt(totalUnspentPoints(run), 0, 0);
    if (badge) denBadgeHost.addChild(badge);
  };

  const closeSub = (): void => {
    if (!sub) return;
    sub.destroy();
    sub = null;
    subHost.removeChildren();
    menuLayer.visible = true;
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
    const inv = makeInventoryPanel({
      mode: "manage",
      getRun: () => {
        if (!c.run) throw new Error("pause: run vanished");
        return c.run;
      },
      setRun: (run) => {
        c.run = run;
      },
    });
    const box = new Container();
    const invX = (DESIGN_W - INVENTORY_PANEL_W) / 2;
    const invY = 176;
    inv.view.position.set(invX, invY);
    box.addChild(inv.view);
    const back = button("Back", 200, 44, closeSub, { hotkey: "Esc" });
    back.view.position.set(
      (DESIGN_W - 200) / 2,
      invY + INVENTORY_PANEL_H + SPACE.lg,
    );
    box.addChild(back.view);
    sub = {
      view: box,
      onKey: (key) => inv.onKey(key),
      destroy: () => {
        inv.destroy();
        box.destroy({ children: true });
      },
    };
    menuLayer.visible = false;
    subHost.addChild(box);
  };

  /**
   * THE DEN (progression.md): Whisker Points, the battle loadout and the
   * three gear slots, per cat. Same panel the Landing opens, so the screen
   * is identical from either entry point.
   */
  const openDen = (): void => {
    const c = ctx;
    if (!c || !c.run) return;
    closeSub();
    const box = new Container();
    const den = makeDenBox({
      getRun: () => {
        if (!c.run) throw new Error("pause: run vanished");
        return c.run;
      },
      setRun: (run) => {
        c.run = run;
      },
      onChanged: () => paintBadge(),
      onClose: closeSub,
    });
    box.addChild(den.view);
    sub = {
      view: box,
      onKey: (key) => den.onKey(key),
      destroy: () => {
        den.destroy();
        box.destroy({ children: true });
      },
    };
    menuLayer.visible = false;
    subHost.addChild(box);
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
      // the overlay can be popped inside the 900 ms — never write to a
      // destroyed Text (its internals are nulled)
      if (seedText && !seedText.destroyed && ctx?.run) {
        seedText.text = `seed ${ctx.run.runSeed}`;
      }
    }, 900);
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;
      elapsedBase = ctx.run?.playTimeMs ?? 0;

      const back = scrim(DESIGN_W, DESIGN_H, 0.72);
      back.eventMode = "static"; // swallow clicks beneath the menu
      view.addChild(back);

      const card = panel(MENU_W, MENU_H, { variant: "raised" });
      card.position.set(MENU_X, MENU_Y);
      menuLayer.addChild(card);

      const header = heading("PAUSED", 1, { center: true });
      header.position.set(MENU_W / 2, SPACE.lg + 4);
      card.addChild(header);

      const hasRun = !!ctx.run;
      // The number chips are the MENU's own 1..5, in row order. Row 2 used to
      // print `DEN_HOTKEY` ("P") instead, so the column read 1 · P · 3 · 4 · 5
      // and looked like the menu had simply lost its number 2. P still opens
      // the Den (it does from the Landing too, and `onKey` below keeps it) —
      // it is a global shortcut, not this row's index, so it goes in the
      // label where a second key belongs.
      const rows: {
        label: string;
        hotkey: string;
        onTap: () => void;
        enabled?: boolean;
        primary?: boolean;
      }[] = [
        { label: "Resume", hotkey: "1", onTap: resume, primary: true },
        {
          // The "(P)" is a KEY name baked into the label, so unlike the row
          // chips it survives `button()`'s touch rule — and on a phone it is
          // a shortcut nobody can press. Drop it there; the row still opens
          // the Den by tap, which is the only way in on touch anyway.
          label: isTouch() ? DEN_LABEL : `${DEN_LABEL}  (${DEN_HOTKEY})`,
          hotkey: "2",
          onTap: openDen,
          enabled: hasRun,
        },
        { label: "Inventory", hotkey: "3", onTap: openSub, enabled: hasRun },
        { label: "Help", hotkey: "4", onTap: () => showHelp(), enabled: true },
        {
          label: "Abandon Run",
          hotkey: "5",
          onTap: abandon,
          enabled: hasRun,
        },
      ];
      rows.forEach((r, i) => {
        const b = button(r.label, BTN_W, BTN_H, r.onTap, {
          primary: r.primary,
          hotkey: r.hotkey,
          disabled: r.enabled === false,
        });
        b.view.position.set(SPACE.lg, HEADER_H + i * (BTN_H + BTN_GAP));
        if (i === 1) {
          denBadgeHost = new Container();
          denBadgeHost.position.set(BTN_W - 52, -8);
          b.view.addChild(denBadgeHost);
        }
        if (i === 4) abandonBtn = b;
        card.addChild(b.view);
      });
      paintBadge();

      /* ---- footer: seed (click to copy) · floor · time ------------- */
      const footY = MENU_H - FOOTER_H + SPACE.xs;
      seedText = label(ctx.run ? `seed ${ctx.run.runSeed}` : "no run", {
        mono: true,
        dim: true,
        size: TYPE.tiny,
      });
      seedText.position.set(SPACE.lg, footY);
      seedText.eventMode = "static";
      seedText.cursor = "pointer";
      seedText.on("pointerdown", copySeed);
      card.addChild(seedText);

      const floorText = label(ctx.run ? `floor ${ctx.run.floorNum}` : "", {
        mono: true,
        dim: true,
        size: TYPE.tiny,
        center: true,
      });
      floorText.position.set(MENU_W / 2, footY + 6);
      card.addChild(floorText);

      timeText = label("", { mono: true, dim: true, size: TYPE.tiny });
      timeText.anchor.set(1, 0);
      timeText.position.set(MENU_W - SPACE.lg, footY);
      card.addChild(timeText);

      view.addChild(menuLayer, subHost);
      layer(root, "modal").addChild(view);

      /* Help is a one-page static card (gameloop.md §6.4). */
      showHelp = (): void => {
        closeSub();
        const help = new Container();
        help.addChild(panel(HELP_W, HELP_H, { variant: "raised" }));
        const title = heading("HOW TO PLAY", 2, { fill: PAL.gold });
        title.position.set(SPACE.lg, SPACE.lg);
        help.addChild(title);
        const lines = [
          "Run map: 1-3 / arrows pick a route · Enter takes it",
          "Battle: 1-6 skills · arrows move-swap · G guard · R Scatter!",
          "Shove enemies with moveTarget skills — a forced move makes",
          "them OFF-BALANCE (+50% damage taken until round end).",
          "When EVERY living enemy is Off-Balance: CAT PILE — pile on",
          "for big typeless damage, or keep the +50% windows. Your call.",
          "P opens THE DEN: spend Whisker Points, pick the 4 skills each",
          "cat takes to battle, and fit weapon / trinket / collar.",
        ].join("\n");
        const txt = label(lines, { size: TYPE.small });
        txt.style.lineHeight = 24;
        txt.position.set(SPACE.lg, SPACE.lg + 44);
        help.addChild(txt);
        const backBtn = button("Back", 160, 44, closeSub, { hotkey: "Esc" });
        backBtn.view.position.set(
          HELP_W - 160 - SPACE.lg,
          HELP_H - 44 - SPACE.lg,
        );
        help.addChild(backBtn.view);
        help.position.set((DESIGN_W - HELP_W) / 2, (DESIGN_H - HELP_H) / 2);
        sub = { view: help, destroy: () => help.destroy({ children: true }) };
        menuLayer.visible = false;
        subHost.addChild(help);
      };
    },

    unmount() {
      closeSub();
      timeText = null;
      seedText = null;
      abandonBtn = null;
      denBadgeHost = null;
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
      if ((key === "2" || key === "p") && ctx?.run) {
        openDen();
        return true;
      }
      if (key === "3" && ctx?.run) {
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
