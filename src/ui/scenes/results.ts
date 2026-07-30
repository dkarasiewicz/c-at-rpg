/**
 * WP-09 — run-end results scene (ui-art §10, gameloop.md §7): victory or
 * defeat banner + cause line, the four cats (dead ones in KO greyscale),
 * the full score table tallied line by line with a count-up, records line
 * with NEW BEST flair, and Again (same seed) / New Seed / Title.
 *
 * On entry (both outcomes): the autosave is DELETED, and MetaFile records
 * update + persist (gameloop.md §9).
 */
import { Container, Graphics, Text } from "pixi.js";
import { computeScore, type ScoreSummary } from "../../core/run/score";
import { deleteSave, recordRunEnd, saveMeta } from "../../core/run/save";
import { newRun } from "../../core/run/runState";
import { PAL } from "../palette";
import { DESIGN_H, DESIGN_W, R } from "../layout";
import { display, mono, ui } from "../textStyles";
import { makeButton } from "../widgets";
import { drawCat } from "../draw/cats";
import { tween } from "../tween";
import { randomSeed } from "./title";
import { layer, type GameCtx, type Scene } from "../sceneManager";

/** Params contract for `scenes.goto('results', params)`. */
export interface ResultsParams {
  victory: boolean;
  /** e.g. "abandoned on floor 3" / "slain by Vacuum King on floor 3". */
  cause?: string;
}

const CAT_ORDER = ["bruiser", "trickster", "hexer", "medic"] as const;
const LINE_MS = 320; // count-up: one score line per beat

export function createResultsScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let summary: ScoreSummary | null = null;
  let seed = "";

  // count-up state
  let t = 0;
  let countDone = false;
  const lineTexts: { pts: Text; line: number; points: number }[] = [];
  let totalText: Text | null = null;
  let newBest: Text | null = null;
  let isNewBest = false;

  const cats: { c: Container; baseY: number; phase: number; dead: boolean }[] =
    [];

  const again = (sameSeed: boolean): void => {
    if (!ctx) return;
    ctx.run = newRun(sameSeed ? seed : randomSeed());
    ctx.scenes.goto("floorgen");
  };

  const toTitle = (): void => {
    if (!ctx) return;
    ctx.run = null;
    ctx.scenes.goto("title");
  };

  const finishCountUp = (): void => {
    if (countDone || !summary) return;
    countDone = true;
    for (const l of lineTexts) l.pts.text = String(l.points);
    if (totalText) totalText.text = String(summary.total);
    if (newBest && isNewBest) {
      newBest.visible = true;
      newBest.scale.set(1.6);
      tween(newBest.scale, { x: 1, y: 1 }, 250, "backOut");
    }
  };

  return {
    mount(root, gameCtx, params) {
      ctx = gameCtx;
      const run = ctx.run;
      if (!run) throw new Error("results: no run in ctx");
      const p = (params ?? { victory: false }) as ResultsParams;
      seed = run.runSeed;

      // -- bookkeeping first: save deleted on entry, meta updated ------
      const livesRemaining = run.cats.reduce((s, c) => s + c.lives, 0);
      summary = computeScore(run.score, p.victory, livesRemaining);
      const prevBest = ctx.meta.records.bestScore;
      isNewBest = summary.total > prevBest;
      ctx.meta = recordRunEnd(ctx.meta, {
        victory: p.victory,
        score: summary.total,
        playTimeMs: run.playTimeMs,
      });
      saveMeta(ctx.meta);
      deleteSave();

      /* ---- banner + cause ------------------------------------------ */
      view.addChild(
        new Graphics().rect(0, 0, DESIGN_W, DESIGN_H).fill(PAL.bgDeep),
      );
      const banner = new Text({
        text: p.victory ? "NINE LIVES WELL SPENT" : "THE ALLEY REMEMBERS",
        style: display(40, { fill: p.victory ? PAL.gold : PAL.danger }),
      });
      banner.anchor.set(0.5);
      banner.position.set(DESIGN_W / 2, R.results.headerY);
      view.addChild(banner);

      const cause = new Text({
        text:
          p.cause ??
          (p.victory
            ? `seed ${seed}`
            : `the clowder fell on floor ${run.floorNum}`),
        style: ui(14, { fill: PAL.textDim }),
      });
      cause.anchor.set(0.5);
      cause.position.set(DESIGN_W / 2, R.results.headerY + 36);
      view.addChild(cause);

      /* ---- score table (count-up) ---------------------------------- */
      const [bx, by, bw] = R.results.statsBlock;
      const lineH = 24;
      summary.lines.forEach((l, i) => {
        const label = new Text({
          text:
            l.id === "victoryBonus"
              ? l.label
              : `${l.label}  ${l.count} × ${l.mult}`,
          style: mono(14, { fill: PAL.textDim }),
        });
        label.position.set(bx, by + i * lineH);
        label.visible = false;
        const pts = new Text({
          text: "0",
          style: mono(14, { fill: PAL.text }),
        });
        pts.anchor.set(1, 0);
        pts.position.set(bx + bw, by + i * lineH);
        pts.visible = false;
        view.addChild(label, pts);
        lineTexts.push({ pts, line: i, points: l.points });
        // reveal label + points together during the count-up
        (pts as Text & { partner?: Text }).partner = label;
      });
      const totalY = by + summary.lines.length * lineH + 10;
      const totalLabel = new Text({
        text: "TOTAL",
        style: mono(14, { fill: PAL.gold }),
      });
      totalLabel.position.set(bx, totalY);
      totalText = new Text({ text: "0", style: mono(14, { fill: PAL.gold }) });
      totalText.anchor.set(1, 0);
      totalText.position.set(bx + bw, totalY);
      view.addChild(totalLabel, totalText);

      const timeLine = new Text({
        text: `time ${formatTime(run.playTimeMs)} — never scored`,
        style: mono(11, { fill: PAL.textDim }),
      });
      timeLine.position.set(bx, totalY + 26);
      view.addChild(timeLine);

      /* ---- records line + NEW BEST flair --------------------------- */
      const rec = ctx.meta;
      const records = new Text({
        text:
          `best ${rec.records.bestScore} · victories ` +
          `${rec.counters.victories} · runs ${rec.counters.runs}`,
        style: ui(14, { fill: PAL.textDim }),
      });
      records.anchor.set(0.5);
      records.position.set(DESIGN_W / 2, totalY + 56);
      view.addChild(records);

      newBest = new Text({
        text: "NEW BEST!",
        style: display(22, { fill: PAL.gold }),
      });
      newBest.anchor.set(0.5);
      newBest.position.set(bx + bw + 90, totalY + 8);
      newBest.visible = false;
      view.addChild(newBest);

      /* ---- the cats (survivors bob, dead cats greyscale ghosts) ---- */
      run.cats.forEach((cat, i) => {
        const c = new Container();
        const g = new Graphics();
        const dead = cat.lives <= 0;
        drawCat(g, CAT_ORDER[i], "sit", 1, dead);
        if (dead) c.alpha = 0.6;
        c.addChild(g);
        const x = DESIGN_W / 2 + (i - 1.5) * R.results.catSpacing;
        c.position.set(x, R.results.catsY);
        cats.push({ c, baseY: R.results.catsY, phase: i * 0.9, dead });
        view.addChild(c);
      });

      /* ---- buttons ------------------------------------------------- */
      const defs: { label: string; onTap: () => void; primary?: boolean }[] = [
        {
          label: "[Enter] Again",
          onTap: () => again(true),
          primary: true,
        },
        { label: "[N] New Seed", onTap: () => again(false) },
        { label: "[T] Title", onTap: toTitle },
      ];
      const bwid = 200;
      const gap = 20;
      const x0 = DESIGN_W / 2 - (bwid * 3 + gap * 2) / 2;
      defs.forEach((d, i) => {
        const b = makeButton(d.label, bwid, 48, d.onTap, {
          primary: d.primary,
          fontSize: 16,
        });
        b.view.position.set(x0 + i * (bwid + gap), R.results.buttonsY);
        view.addChild(b.view);
      });

      layer(root, "hud").addChild(view);
    },

    unmount() {
      if (newBest) tween(newBest.scale, { x: 1, y: 1 }, 0);
      lineTexts.length = 0;
      cats.length = 0;
      totalText = null;
      newBest = null;
      view.destroy({ children: true });
    },

    update(dtMs) {
      t += dtMs;
      for (const cat of cats) {
        if (!cat.dead) {
          cat.c.y =
            cat.baseY + Math.sin((t * 2 * Math.PI) / 1600 + cat.phase) * 2;
        }
      }
      if (countDone || !summary) return;
      // tally line by line: line i counts up during its LINE_MS window
      let running = 0;
      for (const l of lineTexts) {
        const partner = (l.pts as Text & { partner?: Text }).partner;
        const start = l.line * LINE_MS;
        if (t < start) break;
        l.pts.visible = true;
        if (partner) partner.visible = true;
        const frac = Math.min(1, (t - start) / LINE_MS);
        l.pts.text = String(Math.round(l.points * frac));
        running += Math.round(l.points * frac);
      }
      if (totalText) totalText.text = String(running);
      if (t >= (lineTexts.length + 1) * LINE_MS) finishCountUp();
    },

    onKey(key) {
      if (key === "enter") {
        if (!countDone) finishCountUp();
        else again(true);
        return true;
      }
      if (key === "n") {
        again(false);
        return true;
      }
      if (key === "t") {
        toTitle();
        return true;
      }
      if (key === "space" && !countDone) {
        finishCountUp();
        return true;
      }
      return false;
    },
  };
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
