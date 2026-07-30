/**
 * WP-09 — title scene (ui-art §11): night backdrop (stars, crescent moon,
 * rooftop skyline), the four cats sitting on the roofline, the c(at)rpg
 * logo, and the menu: New Run / Continue (iff a valid save exists) / Seed…
 * entry (blank = random 8-hex). Records line from MetaFile.
 *
 * Visual randomness here is Math.random() — the ONE place it may feed
 * gameplay is *picking* a fresh runSeed string (ARCHITECTURE.md §4).
 */
import { Container, Graphics, Text } from "pixi.js";
import type { RunState } from "../../core/types";
import { loadRun } from "../../core/run/save";
import { newRun } from "../../core/run/runState";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W, R } from "../layout";
import { display, mono, ui } from "../textStyles";
import { makeButton } from "../widgets";
import { drawCat } from "../draw/cats";
import { layer, type GameCtx, type Scene } from "../sceneManager";

/** Random 8-hex seed (visual RNG picking a gameplay seed — §4 exception). */
export function randomSeed(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s.toUpperCase();
}

const CAT_ORDER = ["bruiser", "trickster", "hexer", "medic"] as const;

export function createTitleScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let savedRun: RunState | null = null;

  // seed entry state
  let entering = false;
  let seedBuffer = "";
  let seedChip: Text | null = null;
  let entryChip: Text | null = null;

  // twinkle + idle animation state
  const stars: { g: Graphics; base: number; phase: number; speed: number }[] =
    [];
  const cats: { c: Container; baseY: number; phase: number }[] = [];
  let t = 0;

  const refreshSeedTexts = (): void => {
    const label = seedBuffer === "" ? "random" : seedBuffer;
    if (seedChip) seedChip.text = `seed ${label}`;
    if (entryChip) {
      entryChip.visible = entering || seedBuffer !== "";
      entryChip.text = entering ? `seed: ${seedBuffer}_` : `seed: ${label}`;
    }
  };

  const startRun = (): void => {
    if (!ctx || entering) return;
    const seed = seedBuffer.trim() === "" ? randomSeed() : seedBuffer.trim();
    ctx.run = newRun(seed);
    ctx.scenes.goto("floorgen");
  };

  const continueRun = (): void => {
    if (!ctx || !savedRun) return;
    ctx.run = savedRun;
    ctx.scenes.goto("explore");
  };

  return {
    mount(root, gameCtx) {
      ctx = gameCtx;
      savedRun = loadRun(); // Continue visible iff a valid save exists

      /* ---- backdrop ------------------------------------------------ */
      const bg = new Graphics().rect(0, 0, DESIGN_W, DESIGN_H).fill(PAL.bgDeep);
      view.addChild(bg);

      for (let i = 0; i < 40; i++) {
        const g = new Graphics().circle(0, 0, 1 + Math.random()).fill(PAL.text);
        g.position.set(Math.random() * DESIGN_W, Math.random() * 440);
        const base = 0.3 + Math.random() * 0.5;
        g.alpha = base;
        stars.push({
          g,
          base,
          phase: Math.random() * Math.PI * 2,
          speed: 1 / (4000 + Math.random() * 2000),
        });
        view.addChild(g);
      }

      // crescent moon: full circle + offset bgDeep crater circle
      const { moon } = R.title;
      view.addChild(
        new Graphics()
          .circle(moon.x, moon.y, moon.r)
          .fill(PAL.text)
          .circle(moon.x + moon.craterDx, moon.y + moon.craterDy, moon.craterR)
          .fill(PAL.bgDeep),
      );

      // rooftop skyline: PAL.void polygon strip with chimney/gable teeth
      const roofY = R.title.rooftopY;
      const teeth = [
        [0, 40, 24],
        [140, 90, -18],
        [260, 70, 30],
        [430, 120, -26],
        [610, 80, 22],
        [760, 110, -14],
        [900, 60, 26],
        [1030, 100, -20],
        [1180, 100, 18],
      ];
      const pts: number[] = [0, DESIGN_H, 0, roofY];
      for (const [x, w, dy] of teeth) {
        pts.push(x, roofY + (dy < 0 ? dy : 0));
        pts.push(x + w, roofY + (dy < 0 ? dy : 0));
        pts.push(x + w, roofY + (dy > 0 ? 0 : 0));
        if (dy > 0) {
          pts[pts.length - 3] = roofY - dy;
          pts[pts.length - 1] = roofY - dy;
        }
      }
      pts.push(DESIGN_W, roofY, DESIGN_W, DESIGN_H);
      view.addChild(new Graphics().poly(pts).fill(PAL.void));

      // the four cats on the roofline (sit pose, feet at rooftop y)
      R.title.catXs.forEach((x, i) => {
        const c = new Container();
        const g = new Graphics();
        drawCat(g, CAT_ORDER[i], "sit");
        c.addChild(g);
        c.position.set(x, roofY);
        cats.push({ c, baseY: roofY, phase: i * 0.9 });
        view.addChild(c);
      });

      /* ---- logo ---------------------------------------------------- */
      const logoParts: { text: string; fill: number }[] = [
        { text: "c", fill: PAL.text },
        { text: "(at)", fill: PAL.gold },
        { text: "rpg", fill: PAL.text },
      ];
      const texts = logoParts.map(
        (p) => new Text({ text: p.text, style: display(72, { fill: p.fill }) }),
      );
      const totalW = texts.reduce((s, x) => s + x.width, 0);
      let lx = R.title.logoCenter.x - totalW / 2;
      for (const txt of texts) {
        txt.anchor.set(0, 0.5);
        txt.position.set(lx, R.title.logoCenter.y);
        lx += txt.width;
        view.addChild(txt);
      }
      // whisker flourish: 3 lines per side, angled off the logo baseline
      const wg = new Graphics();
      const cy = R.title.logoCenter.y;
      for (const side of [-1, 1]) {
        const x0 = R.title.logoCenter.x + side * (totalW / 2 + 16);
        for (const [dy0, dy1] of [
          [-14, -22],
          [0, 0],
          [14, 22],
        ]) {
          wg.moveTo(x0, cy + dy0)
            .lineTo(x0 + side * 56, cy + dy1)
            .stroke({ width: 2, color: PAL.textDim });
        }
      }
      view.addChild(wg);

      const subtitle = new Text({
        text: "a cRPG of considerable fluffiness",
        style: ui(18, { fill: PAL.textDim }),
      });
      subtitle.anchor.set(0.5, 0);
      subtitle.position.set(DESIGN_W / 2, R.title.subtitleY);
      view.addChild(subtitle);

      /* ---- menu ---------------------------------------------------- */
      const rects = R.title.menuButtons;
      const entries: { label: string; onTap: () => void; primary?: boolean }[] =
        [{ label: "[Enter] New Run", onTap: startRun, primary: true }];
      if (savedRun) {
        entries.push({ label: "[C] Continue", onTap: continueRun });
      }
      entries.push({
        label: "[S] Seed…",
        onTap: () => {
          entering = !entering;
          refreshSeedTexts();
        },
      });
      entries.forEach((e, i) => {
        const rect = rects[Math.min(i, rects.length - 1)];
        const b = makeButton(e.label, rect[2], rect[3], e.onTap, {
          primary: e.primary,
        });
        b.view.position.set(rect[0], rect[1]);
        view.addChild(b.view);
      });

      // live seed entry chip under the menu
      entryChip = new Text({ text: "", style: mono(14, { fill: PAL.gold }) });
      entryChip.anchor.set(0.5, 0);
      entryChip.position.set(DESIGN_W / 2, 540);
      entryChip.visible = false;
      view.addChild(entryChip);

      // records line from MetaFile
      const rec = gameCtx.meta;
      const fastest =
        rec.records.fastestVictoryMs === null
          ? "—"
          : formatTime(rec.records.fastestVictoryMs);
      const records = new Text({
        text:
          `best score ${rec.records.bestScore} · fastest victory ${fastest}` +
          ` · victories ${rec.counters.victories} · runs ${rec.counters.runs}`,
        style: ui(14, { fill: PAL.textDim }),
      });
      records.anchor.set(0.5, 0);
      records.position.set(DESIGN_W / 2, 576);
      view.addChild(records);

      // current seed chip bottom-left + version bottom-right
      seedChip = new Text({ text: "", style: mono(11, { fill: PAL.textDim }) });
      seedChip.position.set(R.title.seedChip[0], R.title.seedChip[1]);
      view.addChild(seedChip);
      const version = new Text({
        text: "v1",
        style: mono(11, { fill: PAL.textDim }),
      });
      version.anchor.set(1, 0);
      version.position.set(DESIGN_W - 12, R.title.seedChip[1]);
      view.addChild(version);
      refreshSeedTexts();

      layer(root, "bg").addChild(view);
    },

    unmount() {
      stars.length = 0;
      cats.length = 0;
      view.destroy({ children: true });
    },

    update(dtMs) {
      t += dtMs;
      for (const s of stars) {
        s.g.alpha =
          s.base * (0.7 + 0.3 * Math.sin(t * s.speed * 2 * Math.PI + s.phase));
      }
      for (const cat of cats) {
        cat.c.y =
          cat.baseY + Math.sin((t * 2 * Math.PI) / 1600 + cat.phase) * 2;
      }
    },

    onKey(key) {
      if (entering) {
        if (key === "enter" || key === "esc") {
          entering = false;
        } else if (key === "backspace") {
          seedBuffer = seedBuffer.slice(0, -1);
        } else if (/^[a-z0-9-]$/.test(key) && seedBuffer.length < 16) {
          seedBuffer += key.toUpperCase();
        }
        refreshSeedTexts();
        return true; // capture everything while typing a seed
      }
      if (key === "enter") {
        startRun();
        return true;
      }
      if (key === "c" && savedRun) {
        continueRun();
        return true;
      }
      if (key === "s") {
        entering = true;
        refreshSeedTexts();
        return true;
      }
      return false;
    },
  };
}

/** mm:ss for the records line. */
function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
