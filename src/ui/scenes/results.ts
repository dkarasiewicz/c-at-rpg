/**
 * WP-09 — run-end results scene (ui-art §10, gameloop.md §7): victory or
 * defeat banner + cause line, the score table tallied line by line with a
 * count-up, the clowder roll-call (painted portraits, Lives paw rows, KO
 * state), records line with NEW BEST flair, and Again (same seed) / New
 * Seed / Title.
 *
 * On entry (both outcomes): the autosave is DELETED, and the run is BANKED
 * into the Cat Town profile — `bankRun` folds the payout, the lifetime
 * records and the run history in one write, win or lose (balance-and-meta.md
 * §4: a losing run must still pay out). The banked total is shown as its own
 * line and the primary action carries it home to Cat Town.
 *
 * REFERENCE IMPLEMENTATION for the shared UI chrome kit (widgets.ts): every
 * piece of chrome on this screen comes from the kit — `sceneBackdrop`,
 * `vignette`, `panel`, `heading`, `label`, `avatar`, `button`, `makePawRow`
 * — and nothing here draws its own rectangle, face or type style. Copy this
 * shape when restyling the other screens.
 */
import { Container, Graphics, Text } from "pixi.js";
import {
  computeScore,
  discoveriesOf,
  type ScoreSummary,
} from "../../core/run/score.js";
import { deleteSave, saveMeta } from "../../core/run/save.js";
import {
  applyUnlocks,
  bankRun,
  newlyAffordable,
  startRun,
} from "../../core/meta/index.js";
import type { Payout, UnlockId } from "../../core/meta/types.js";
import { CLASSES } from "../../content/classes.js";
import { PAL } from "../palette.js";
import { DESIGN_H, DESIGN_W, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import {
  avatar,
  button,
  heading,
  label,
  makePawRow,
  panel,
  sceneBackdrop,
  vignette,
} from "../widgets.js";
import { tween } from "../tween.js";
import { randomSeed } from "./title.js";
import { layer, type GameCtx, type Scene } from "../sceneManager.js";

/** Params contract for `scenes.goto('results', params)`. */
export interface ResultsParams {
  victory: boolean;
  /** e.g. "abandoned on floor 3" / "slain by Vacuum King on floor 3". */
  cause?: string;
}

const LINE_MS = 320; // count-up: one score line per beat

/* ---- screen geometry (design px) ------------------------------------- */
const EYEBROW_Y = 58;
const BANNER_Y = 100;
const CAUSE_Y = 142;
const BODY_Y = 184;
const SCORE_X = 120;
const SCORE_W = 580;
const ROLL_X = 740;
const ROLL_W = 420;
const ROW_H = 24; // one score line, minimum
const ROW_H_MAX = 32; // …and how far a short table may spread to fill
const CAT_ROW_H = 72;
/** Height of the TOTAL block (hairline + row) pinned above the time line. */
const TOTAL_BAND = 34;
/** Height of the time line pinned to the panel foot. */
const FOOT_BAND = 28;

export function createResultsScene(): Scene {
  const view = new Container();
  let ctx: GameCtx | null = null;
  let summary: ScoreSummary | null = null;
  let seed = "";
  // banked at mount, carried to Cat Town by the primary action
  let payout: Payout | null = null;
  let highlight: UnlockId[] = [];
  let victory = false;

  // count-up state
  let t = 0;
  let countDone = false;
  const lineTexts: { pts: Text; row: Text; line: number; points: number }[] =
    [];
  let totalText: Text | null = null;
  let newBest: Container | null = null;
  let isNewBest = false;

  const cats: { c: Container; baseY: number; phase: number; dead: boolean }[] =
    [];

  const again = (sameSeed: boolean): void => {
    if (!ctx) return;
    // straight back down, with whatever the town has already unlocked
    ctx.run = startRun(sameSeed ? seed : randomSeed(), applyUnlocks(ctx.meta));
    ctx.scenes.goto("floorgen");
  };

  const toTown = (): void => {
    if (!ctx) return;
    ctx.run = null;
    ctx.scenes.goto("catTown", {
      ...(payout ? { payout } : {}),
      victory,
      highlight,
    });
  };

  const toTitle = (): void => {
    if (!ctx) return;
    ctx.run = null;
    ctx.scenes.goto("title");
  };

  const finishCountUp = (): void => {
    if (countDone || !summary) return;
    countDone = true;
    for (const l of lineTexts) {
      l.pts.text = String(l.points);
      l.pts.visible = true;
      l.row.visible = true;
    }
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
      summary = computeScore(
        run.score,
        p.victory,
        livesRemaining,
        discoveriesOf(run),
      );
      const prevBest = ctx.meta.records.bestScore;
      isNewBest = summary.total > prevBest;
      victory = p.victory;
      // ONE write: payout banked (win or lose), records ticked, run recorded
      const before = ctx.meta;
      const banked = bankRun(before, {
        seed,
        victory: p.victory,
        floorsReached: run.score.floorsReached,
        floorsCleared: run.score.floorsCleared,
        enemiesDefeated: run.score.enemiesDefeated,
        bossesDefeated: run.score.bossesDefeated,
        catPiles: run.score.catPiles,
        shiniesCarried: run.inventory.shinies,
        score: summary.total,
        playTimeMs: run.playTimeMs,
      });
      ctx.meta = banked.meta;
      payout = banked.payout;
      highlight = newlyAffordable(before, banked.meta);
      saveMeta(ctx.meta);
      deleteSave();

      const accent = p.victory ? PAL.gold : PAL.danger;

      /* ---- backdrop: generated outcome art, dimmed + vignetted ------ */
      view.addChild(
        sceneBackdrop(
          p.victory ? "scene:victory" : "scene:defeat",
          DESIGN_W,
          DESIGN_H,
          { dim: 0.62 },
        ),
        vignette(DESIGN_W, DESIGN_H, 0.75),
      );

      /* ---- banner + cause ------------------------------------------ */
      const eyebrow = heading(p.victory ? "RUN COMPLETE" : "RUN ENDED", 3, {
        center: true,
      });
      eyebrow.position.set(DESIGN_W / 2, EYEBROW_Y);

      const banner = heading(
        p.victory ? "NINE LIVES WELL SPENT" : "THE ALLEY REMEMBERS",
        1,
        { center: true, fill: accent },
      );
      banner.position.set(DESIGN_W / 2, BANNER_Y);

      const cause = label(
        p.cause ??
          (p.victory
            ? `seed ${seed}`
            : `the clowder fell on floor ${run.floorNum}`),
        { dim: true, center: true },
      );
      cause.position.set(DESIGN_W / 2, CAUSE_Y);
      view.addChild(eyebrow, banner, cause);

      /* ---- score panel (count-up) ---------------------------------- */
      // The two body panels are the same height (they read as one band), and
      // the score table is ALWAYS the shorter of the two — six lines on a
      // defeat against four cat rows left ~110px of nothing between TOTAL and
      // the footer. Rather than pin TOTAL lower and move the void, the lines
      // SPREAD: `rowH` grows (up to ROW_H_MAX) until the table fills the
      // space it has been given, and TOTAL + the time line stay pinned to the
      // foot where they belong.
      const rows = summary.lines.length;
      const scoreH = 56 + rows * ROW_H + TOTAL_BAND + FOOT_BAND + SPACE.lg;
      const rollH = 56 + run.cats.length * CAT_ROW_H + SPACE.md;
      const bodyH = Math.max(scoreH, rollH);

      const score = panel(SCORE_W, bodyH, { variant: "glass", accent });
      score.position.set(SCORE_X, BODY_Y);
      view.addChild(score);

      const scoreTitle = heading("SCORE", 3);
      scoreTitle.position.set(SPACE.lg, SPACE.md + 4);
      score.addChild(scoreTitle);

      const colL = SPACE.lg;
      const colR = SCORE_W - SPACE.lg;
      const top = 52;
      const footY = bodyH - FOOT_BAND;
      const totalY = footY - TOTAL_BAND + 6;
      const rowH = Math.max(
        ROW_H,
        Math.min(ROW_H_MAX, (totalY - 14 - top) / Math.max(1, rows)),
      );
      summary.lines.forEach((l, i) => {
        const y = top + i * rowH;
        const row = label(
          l.id === "victoryBonus"
            ? l.label
            : `${l.label}  ${l.count} × ${l.mult}`,
          { mono: true, dim: true },
        );
        row.position.set(colL, y);
        row.visible = false;
        const pts = label("0", { mono: true });
        pts.anchor.set(1, 0);
        pts.position.set(colR, y);
        pts.visible = false;
        score.addChild(row, pts);
        lineTexts.push({ pts, row, line: i, points: l.points });
      });

      // hairline above the TOTAL row
      score.addChild(
        new Graphics()
          .moveTo(colL, totalY - 8)
          .lineTo(colR, totalY - 8)
          .stroke({ width: 1, color: PAL.border, alpha: 0.8 }),
      );

      const totalLabel = label("TOTAL", {
        mono: true,
        bold: true,
        fill: PAL.gold,
      });
      totalLabel.position.set(colL, totalY);
      totalText = label("0", { mono: true, fill: PAL.gold });
      totalText.anchor.set(1, 0);
      totalText.position.set(colR, totalY);
      score.addChild(totalLabel, totalText);

      const timeLine = label(
        `time ${formatTime(run.playTimeMs)} — never scored`,
        { mono: true, dim: true, size: TYPE.tiny },
      );
      // pinned to the panel foot so short (defeat) tables don't leave a void
      timeLine.position.set(colL, footY);
      score.addChild(timeLine);

      /* ---- NEW BEST flair: a gold badge straddling the panel edge --- */
      const best = heading("NEW BEST!", 2, { fill: PAL.gold, center: true });
      const chipW = Math.ceil(best.width) + SPACE.lg * 2;
      const chip = panel(chipW, 40, {
        variant: "raised",
        accent: PAL.gold,
        radius: 20,
      });
      best.position.set(chipW / 2, 20);
      chip.addChild(best);
      chip.pivot.set(chipW / 2, 20); // pivot on the badge center, not bounds
      chip.position.set(SCORE_W / 2, bodyH - 4);
      chip.visible = false;
      score.addChild(chip);
      newBest = chip;

      /* ---- the clowder roll-call ----------------------------------- */
      const roll = panel(ROLL_W, bodyH, { variant: "glass" });
      roll.position.set(ROLL_X, BODY_Y);
      view.addChild(roll);

      const rollTitle = heading("THE CLOWDER", 3);
      rollTitle.position.set(SPACE.lg, SPACE.md + 4);
      roll.addChild(rollTitle);

      // A run FIELDS a subset of the four slots (balance-and-meta.md §2), and
      // the roll-call used to render all four identically — so a run that
      // ended "overwhelmed on floor 4" showed two cats at a full nine Lives
      // beside the cats that fell, reading as a flat contradiction. They were
      // never down there. Three states, said out loud:
      //   FELL      0 Lives — grey portrait, "out of lives"
      //   WALKED    fielded and alive — survivor ring, Lives left
      //   BENCHED   alive, never in the marching order — dimmed + tagged
      const fielded = new Set(run.marchingOrder);
      const descended = run.cats.filter(
        (c) => c.lives <= 0 || fielded.has(c.classId),
      ).length;
      const benchedCount = run.cats.length - descended;
      const rollSub = label(
        benchedCount > 0
          ? `${descended} went down · ${benchedCount} stayed in town`
          : `${descended} went down`,
        { dim: true, size: TYPE.tiny, mono: true },
      );
      rollSub.position.set(SPACE.lg, SPACE.md + 24);
      roll.addChild(rollSub);

      run.cats.forEach((cat, i) => {
        const dead = cat.lives <= 0;
        const benched = !dead && !fielded.has(cat.classId);
        const rowY = 52 + i * CAT_ROW_H;
        const row = new Container();
        row.alpha = benched ? 0.5 : 1;
        roll.addChild(row);

        const face = avatar(cat.classId, 56, {
          dead,
          // the survivor ring means "came back up", so a cat that never went
          // down does not get one
          ...(dead || benched ? {} : { ring: PAL.heal }),
        });
        face.position.set(SPACE.lg + 28, rowY + 30);
        row.addChild(face);
        // only the cats that actually walked the floors bob
        cats.push({
          c: face,
          baseY: face.y,
          phase: i * 0.9,
          dead: dead || benched,
        });

        const name = label(CLASSES[cat.classId].catName, {
          bold: true,
          size: TYPE.body,
          fill: dead ? PAL.textDim : PAL.text,
        });
        name.position.set(SPACE.lg + 68, rowY + 8);
        const state = label(
          dead
            ? "out of lives"
            : benched
              ? "never left the bench"
              : `${cat.lives} lives left`,
          { dim: true, size: TYPE.tiny, mono: true },
        );
        state.position.set(SPACE.lg + 68, rowY + 30);
        row.addChild(name, state);

        if (benched) {
          const tag = label("BENCHED", {
            dim: true,
            size: TYPE.tiny,
            bold: true,
          });
          tag.anchor.set(1, 0);
          tag.position.set(ROLL_W - SPACE.lg, rowY + 8);
          row.addChild(tag);
        }

        // the paw row is a record of Lives SPENT; a benched cat spent none,
        // so printing nine full paws next to the fallen is the contradiction
        // itself — it is simply not drawn for them
        if (!benched) {
          const paws = makePawRow(cat.lives);
          paws.view.position.set(SPACE.lg + 68, rowY + 46);
          row.addChild(paws.view);
        }
      });

      /* ---- records line -------------------------------------------- */
      const rec = ctx.meta;
      const records = label(
        `+${payout?.total ?? 0} ✦ banked · ${rec.shinies} ✦ in the tin · ` +
          `best ${rec.records.bestScore} · victories ` +
          `${rec.counters.victories} · runs ${rec.counters.runs}`,
        { dim: true, center: true },
      );
      records.position.set(DESIGN_W / 2, BODY_Y + bodyH + SPACE.lg + SPACE.xs);
      view.addChild(records);

      /* ---- buttons ------------------------------------------------- */
      const defs: {
        label: string;
        hotkey: string;
        onTap: () => void;
        primary?: boolean;
      }[] = [
        {
          // mirrors onKey's Enter: while the tally is still counting, the
          // primary action is "show me the total", not "leave"
          label: "Back to Cat Town",
          hotkey: "Enter",
          onTap: () => {
            if (!countDone) finishCountUp();
            else toTown();
          },
          primary: true,
        },
        { label: "Again", hotkey: "A", onTap: () => again(true) },
        { label: "New Seed", hotkey: "N", onTap: () => again(false) },
        { label: "Title", hotkey: "T", onTap: toTitle },
      ];
      const bwid = 250;
      const gap = SPACE.lg;
      const x0 =
        DESIGN_W / 2 - (bwid * defs.length + gap * (defs.length - 1)) / 2;
      const buttonsY = Math.min(
        DESIGN_H - 88,
        BODY_Y + bodyH + SPACE.xl + SPACE.md,
      );
      defs.forEach((d, i) => {
        const b = button(d.label, bwid, 52, d.onTap, {
          primary: d.primary,
          hotkey: d.hotkey,
        });
        b.view.position.set(x0 + i * (bwid + gap), buttonsY);
        view.addChild(b.view);
      });

      // Tap anywhere to skip the count-up — the tap equivalent of Space
      // (docs/design/mobile.md §1). Behind every button, so it only ever
      // catches the empty parts of the screen.
      const skip = new Graphics()
        .rect(0, 0, DESIGN_W, DESIGN_H)
        .fill({ color: PAL.void, alpha: 0.0001 });
      skip.eventMode = "static";
      skip.on("pointertap", () => {
        if (!countDone) finishCountUp();
      });
      view.addChildAt(skip, 0);

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
        const start = l.line * LINE_MS;
        if (t < start) break;
        l.pts.visible = true;
        l.row.visible = true;
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
        else toTown();
        return true;
      }
      if (key === "a") {
        again(true);
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
