/**
 * THE WHOLE GAME — the run nobody had ever finished in a browser.
 *
 * Every browser gate in this repo stopped short of the ending: the floor-6
 * playtest walks INTO the Dogfather's lair and hammers forty keys at him,
 * and the final gate abandons on floor 1. Nothing had ever played floors 5
 * and 6 continuously, put the Dogfather down, watched the victory results
 * tally, and carried the payout home to Cat Town. That is the last third of
 * the game, and it was covered by unit tests only.
 *
 * This drives it, twice:
 *
 *   VICTORY  a save parked at the MOUTH of floor 5 (floors 1-4 fast-forwarded
 *            by tests/support/scriptedRun.ts, exactly as a Continue would
 *            restore them) → floor 5 played node by node in the browser →
 *            the stairwell → floor 6 → the lair → the Dogfather → the boss
 *            loot → the results screen → Cat Town, with the payout banked.
 *
 *   DEFEAT   the same party, sent down floor 6 with one Life each and a
 *            sliver of HP, so the clowder actually falls → the defeat
 *            results screen → Cat Town, with a scaled (never zero) payout.
 *
 * The player is a BOT, not a keystroke script: it reads the live scene id,
 * the overlay, and the battle scene's own `__ui()` phase, and answers each
 * one the way a person would (first legal skill on its first target, guard
 * when nothing else is legal). It never presses a key it has not confirmed
 * is meaningful, so "the run got stuck" fails the gate instead of being
 * absorbed by a rotation of hopeful hotkeys.
 *
 *   npx tsx tests/browser/full-run.ts [--headed] [--keep] [--debug]
 *
 * Screenshots land in docs/screenshots/: final-boss.png, final-victory.png,
 * final-defeat.png.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { scriptedRun } from "../support/scriptedRun.js";
import { serializeRun } from "../../src/core/run/save.js";
import { FLOOR_COUNT } from "../../src/core/run/runState.js";
import { emptyProfile } from "../../src/core/meta/profile.js";
import type { RunState } from "../../src/core/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/screenshots");
const HEADED = process.argv.includes("--headed");
const DEBUG = process.argv.includes("--debug");
const PORT = 5197;
const URL_ = `http://localhost:${PORT}`;

/** The pinned seed. Floors 1-4 are fast-forwarded on it, 5-6 are played. */
const SEED = "DEEP-0";

/** localStorage keys, mirrored from core/run/save.ts. */
const SAVE_KEY = "catrpg.save.v1";
const META_KEY = "catrpg.meta.v1";

const log = (s: string): void => console.log(s);
const dbg = (s: string): void => {
  if (DEBUG) console.log(`      · ${s}`);
};

/* ------------------------------------------------------------------ */
/* the injected save: standing at the mouth of floor 5                 */
/* ------------------------------------------------------------------ */

/**
 * Floors 1-4 walked by the headless driver, then `descend`d — so the run
 * sits on floor 5's ENTRY node with nothing on the floor resolved yet. No
 * `resolvedNodes` record is written on purpose: the run map must hold the
 * entry node and ask for a confirm, which is the first thing the bot proves.
 */
function parkedAtFloor5(): { save: unknown; run: RunState; summary: string } {
  const out = scriptedRun(SEED, { throughFloor: FLOOR_COUNT - 2 });
  const run = out.run;
  if (run.floorNum !== FLOOR_COUNT - 1) {
    throw new Error(`expected to be parked on floor 5, got ${run.floorNum}`);
  }
  const lives = run.cats.map((c) => c.lives).join("/");
  return {
    save: serializeRun(run),
    run,
    summary:
      `floor ${run.floorNum} · level ${run.level} · lives ${lives} · ` +
      `${run.inventory.shinies} ✦ · ${out.fights} fights behind them`,
  };
}

/** The same party, but on floor 6 and one bad round from the end. */
function doomedOnFloor6(): { save: unknown; run: RunState } {
  const out = scriptedRun(SEED, { throughFloor: FLOOR_COUNT - 1 });
  const run: RunState = {
    ...out.run,
    // one Life each and a sliver of HP: the next pack ends them. The floors
    // themselves are untouched, so this is a real floor-6 defeat and not a
    // synthetic "hp = 0" write.
    cats: out.run.cats.map((c) => ({ ...c, lives: 1, hp: 1 })),
  };
  if (run.floorNum !== FLOOR_COUNT) {
    throw new Error(`expected floor 6 for the defeat leg, got ${run.floorNum}`);
  }
  return { save: serializeRun(run), run };
}

/** A veteran's profile: one run already banked, so no first-run grace. */
function vetMeta(): unknown {
  return { ...emptyProfile(), counters: { runs: 1, victories: 0 } };
}

/* ------------------------------------------------------------------ */
/* dev server                                                          */
/* ------------------------------------------------------------------ */

/**
 * The DM stays OFF (see boss-playtest.ts): from a local dev server the
 * deployed DM's probe can only ever fail CORS, and the stateless `/api/gm`
 * fallback 404s because a dev server serves no functions. Both are the
 * documented offline path, and the reporter files them as NOTES.
 */
async function startServer(): Promise<ChildProcess> {
  const proc = spawn(
    "npx",
    [
      "vite",
      "--config",
      resolve(HERE, "vite.playtest.config.ts"),
      "--port",
      String(PORT),
    ],
    {
      cwd: resolve(HERE, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VITE_DM_URL: "" },
    },
  );
  proc.stderr?.on("data", (b: Buffer) => process.stderr.write(b));
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 60_000) {
      proc.kill("SIGTERM");
      throw new Error("vite never started serving");
    }
    try {
      const res = await fetch(URL_ + "/");
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ------------------------------------------------------------------ */
/* the watcher — every console line, all the way through               */
/* ------------------------------------------------------------------ */

interface Watch {
  problems: string[];
  notes: string[];
}

function watch(page: Page, w: Watch, tag: string): void {
  // A mid-run navigation is never the game's idea — the app never calls
  // `location.reload()` — so it is either the dev server force-reloading (a
  // harness fault worth knowing about) or a renderer that fell over. Either
  // way the run it was in the middle of is gone, and that must be reported
  // rather than silently absorbed by the bot's recovery path.
  let loads = 0;
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    if (++loads > 1) w.problems.push(`[${tag}] the page RELOADED mid-run`);
  });
  // a dev server serves no `/api`, so the stateless GM fallback 404s by
  // design; everything else is a problem.
  const expected = (u: string): boolean => u.includes("/api/gm");
  page.on("pageerror", (e) =>
    w.problems.push(`[${tag}] pageerror: ${e.message}`),
  );
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "warning") {
      // The headless GL driver narrates its own performance ("GPU stall due
      // to ReadPixels") every time this harness takes a screenshot. That is
      // the CAMERA talking, not the game, and filing it as a defect buries
      // the warnings this gate exists to catch.
      if (/GL Driver Message|ReadPixels|SwiftShader/i.test(t)) {
        w.notes.push(`[${tag}] gl: ${t}`);
        return;
      }
      // pixi warnings are the ones this gate is here to catch
      if (/pixi|PixiJS|deprecat|WebGL|texture/i.test(t)) {
        w.problems.push(`[${tag}] warn: ${t}`);
      }
      return;
    }
    if (m.type() !== "error") return;
    if (t.includes("Failed to load resource") || t.includes("ERR_FAILED")) {
      w.notes.push(`[${tag}] console: ${t}`);
      return;
    }
    w.problems.push(`[${tag}] console: ${t}`);
  });
  page.on("requestfailed", (r) => {
    const line = `[${tag}] request failed: ${r.url()}`;
    (expected(r.url()) ? w.notes : w.problems).push(line);
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const line = `[${tag}] HTTP ${r.status()}: ${r.url()}`;
    (expected(r.url()) ? w.notes : w.problems).push(line);
  });
}

/* ------------------------------------------------------------------ */
/* live-state hooks                                                    */
/* ------------------------------------------------------------------ */

interface UiState {
  phase: string;
  actor: string | null;
  targets: string[] | null;
  targetIdx: number | null;
}

interface BattleSnapshot {
  outcome: string;
  round: number;
  species: string[];
  boss: { id: string; poise: number; poiseMax: number; phase: number } | null;
  catsAlive: number;
}

const hook = async <T>(page: Page, fn: () => T, fallback: T): Promise<T> => {
  try {
    return await page.evaluate(fn);
  } catch {
    return fallback; // context torn down mid-navigation
  }
};

const scene = (page: Page): Promise<string> =>
  hook(
    page,
    () => {
      const w = window as unknown as { __scene?: () => string };
      return typeof w.__scene === "function" ? w.__scene() : "<booting>";
    },
    "<booting>",
  );

const runOf = (page: Page): Promise<RunState | null> =>
  hook(
    page,
    () => {
      const w = window as unknown as { __run?: () => unknown };
      return (typeof w.__run === "function" ? w.__run() : null) as never;
    },
    null,
  );

const uiOf = (page: Page): Promise<UiState | null> =>
  hook(
    page,
    () => {
      const w = window as unknown as { __ui?: () => unknown };
      return (typeof w.__ui === "function" ? w.__ui() : null) as never;
    },
    null,
  );

const battleOf = (page: Page): Promise<BattleSnapshot | null> =>
  hook(
    page,
    () => {
      const w = window as unknown as { __battle?: () => unknown };
      if (typeof w.__battle !== "function") return null as never;
      const bs = w.__battle() as {
        outcome: string;
        round: number;
        combatants: {
          id: string;
          side: string;
          speciesId?: string;
          ko: boolean;
          hp: number;
          poise?: number;
          poiseMax?: number;
          phase?: number;
        }[];
      } | null;
      if (!bs) return null as never;
      const boss = bs.combatants.find((c) => c.poiseMax !== undefined);
      return {
        outcome: bs.outcome,
        round: bs.round,
        species: bs.combatants
          .filter((c) => c.side === "enemy")
          .map((c) => c.speciesId ?? "?"),
        boss: boss
          ? {
              id: boss.speciesId ?? boss.id,
              poise: boss.poise ?? 0,
              poiseMax: boss.poiseMax ?? 0,
              phase: boss.phase ?? 0,
            }
          : null,
        catsAlive: bs.combatants.filter((c) => c.side === "cat" && !c.ko)
          .length,
      } as never;
    },
    null,
  );

/**
 * Everything the bot needs, in ONE round trip.
 *
 * Reading scene / overlay / run / battle as four separate `evaluate` calls
 * cost about a second per decision, which turns a six-floor playthrough into
 * a coffee break; the driver spent most of its wall clock in IPC rather than
 * in the game.
 */
interface Snap {
  scene: string;
  overlay: string | null;
  floor: number | null;
  node: number | null;
  level: number | null;
  battle: BattleSnapshot | null;
}

const snap = (page: Page): Promise<Snap> =>
  hook(
    page,
    () => {
      const w = window as unknown as {
        __scene?: () => string;
        __overlay?: () => string | null;
        __run?: () => unknown;
        __battle?: () => unknown;
      };
      const run = (typeof w.__run === "function" ? w.__run() : null) as {
        floorNum: number;
        level: number;
        currentNodeId: number | null;
      } | null;
      const bs = (typeof w.__battle === "function" ? w.__battle() : null) as {
        outcome: string;
        round: number;
        combatants: {
          id: string;
          side: string;
          speciesId?: string;
          ko: boolean;
          poise?: number;
          poiseMax?: number;
          phase?: number;
        }[];
      } | null;
      const boss = bs?.combatants.find((c) => c.poiseMax !== undefined);
      return {
        scene: typeof w.__scene === "function" ? w.__scene() : "<booting>",
        overlay: typeof w.__overlay === "function" ? w.__overlay() : null,
        floor: run?.floorNum ?? null,
        node: run?.currentNodeId ?? null,
        level: run?.level ?? null,
        battle: bs
          ? {
              outcome: bs.outcome,
              round: bs.round,
              species: bs.combatants
                .filter((c) => c.side === "enemy")
                .map((c) => c.speciesId ?? "?"),
              boss: boss
                ? {
                    id: boss.speciesId ?? boss.id,
                    poise: boss.poise ?? 0,
                    poiseMax: boss.poiseMax ?? 0,
                    phase: boss.phase ?? 0,
                  }
                : null,
              catsAlive: bs.combatants.filter((c) => c.side === "cat" && !c.ko)
                .length,
            }
          : null,
      } as never;
    },
    {
      scene: "<booting>",
      overlay: null,
      floor: null,
      node: null,
      level: null,
      battle: null,
    },
  );

async function waitForScene(
  page: Page,
  id: string,
  ms = 30_000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if ((await scene(page)) === id) return;
    if (Date.now() - t0 > ms) {
      throw new Error(
        `timed out waiting for scene '${id}' (at '${await scene(page)}')`,
      );
    }
    await page.waitForTimeout(120);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, name) });
  log(`  📸 ${name}`);
}

const key = async (page: Page, k: string, settle = 140): Promise<void> => {
  await page.keyboard.press(k);
  await page.waitForTimeout(settle);
};

/* ------------------------------------------------------------------ */
/* THE BOT                                                             */
/* ------------------------------------------------------------------ */

/**
 * One decision, taken from whatever is actually on screen. Returns the
 * scene/overlay it acted on so the caller can notice a stall.
 *
 * The battle policy mirrors tests/support/scriptedRun.ts on purpose: first
 * legal skill in slot order on its first offered target, guard when nothing
 * else is legal. Legality is not guessed — a slot that is not legal leaves
 * the scene in the `input` phase, and the bot moves to the next slot.
 */
async function step(page: Page, s: Snap): Promise<string> {
  if (s.overlay === "loot") {
    await key(page, "Enter", 260);
    return "overlay:loot";
  }
  if (s.overlay === "pause") {
    await key(page, "Escape", 200);
    return "overlay:pause";
  }
  const sc = s.scene;
  switch (sc) {
    case "runMap":
      // Enter is the one key the board needs: it walks in through the entry
      // hold, closes the catnap panel, takes the highlighted route, and
      // opens the way down once the terminal has fallen.
      await key(page, "Enter", 420);
      return "runMap";
    case "battle":
      await battleStep(page);
      return "battle";
    case "event": {
      // take the first AVAILABLE option (an unavailable hotkey is a no-op),
      // then confirm through the result card
      for (const k of ["1", "2", "3", "4"]) {
        await key(page, k, 220);
        if ((await scene(page)) !== "event") return "event";
      }
      await key(page, "e", 260);
      return "event";
    }
    case "landing":
      // the stairwell (Enter descends) and the Peddler node (Enter leaves)
      await key(page, "Enter", 500);
      return "landing";
    case "floorgen":
      await page.waitForTimeout(300);
      return "floorgen";
    case "boot":
      // only reachable if the page reloaded under us (see `watch`): take the
      // click gate and Continue from the autosave so the leg can go on
      await page.mouse.click(640, 360);
      await page.waitForTimeout(400);
      if ((await scene(page)) === "title") await key(page, "o", 1200);
      return "boot";
    default:
      await page.waitForTimeout(200);
      return sc;
  }
}

async function battleStep(page: Page): Promise<void> {
  const ui = await uiOf(page);
  if (!ui) {
    await page.waitForTimeout(150);
    return;
  }
  switch (ui.phase) {
    case "input": {
      for (const slot of ["1", "2", "3", "4"]) {
        await key(page, slot, 110);
        const now = await uiOf(page);
        if (!now || now.phase !== "input") {
          dbg(`slot ${slot} → ${now?.phase ?? "gone"}`);
          return;
        }
      }
      await key(page, "5", 140); // Guard is always legal
      dbg("guarded");
      return;
    }
    case "targeting":
      await key(page, "Enter", 160);
      return;
    case "pile":
      await key(page, "Enter", 220); // pile on — free damage
      return;
    default:
      await page.waitForTimeout(120);
      return;
  }
}

interface PlayReport {
  steps: number;
  floorsSeen: number[];
  bossFight: BattleSnapshot | null;
}

/**
 * Play until `done(scene)` answers true. Everything interesting that happens
 * on the way is recorded: the floors walked, the boss's Poise as it breaks,
 * and any stall (the same scene, the same run position, for too long).
 */
async function playUntil(
  page: Page,
  done: (scene: string) => boolean,
  w: Watch,
  opts: { maxSteps?: number; onBoss?: (page: Page) => Promise<void> } = {},
): Promise<PlayReport> {
  const maxSteps = opts.maxSteps ?? 1400;
  const floorsSeen: number[] = [];
  let bossFight: BattleSnapshot | null = null;
  let bossShotDone = false;
  let last = "";
  let lastChangeStep = 0;
  let steps = 0;

  for (; steps < maxSteps; steps++) {
    const s = await snap(page);
    if (done(s.scene)) return { steps, floorsSeen, bossFight };

    if (s.floor !== null && !floorsSeen.includes(s.floor)) {
      floorsSeen.push(s.floor);
      log(`  ▸ floor ${s.floor} (level ${s.level})`);
    }

    if (s.battle?.boss) {
      bossFight = s.battle;
      if (!bossShotDone && opts.onBoss) {
        bossShotDone = true;
        await opts.onBoss(page);
      }
    }

    const fingerprint =
      `${s.scene}:${s.overlay ?? "-"}:${s.node ?? "-"}:${s.floor ?? "-"}:` +
      `${s.battle?.round ?? "-"}`;
    // a heartbeat, so a long descent is visibly alive rather than
    // indistinguishable from a hang
    if (steps % 25 === 0) log(`    [${steps}] ${fingerprint}`);
    if (fingerprint !== last) {
      last = fingerprint;
      lastChangeStep = steps;
    } else if (steps - lastChangeStep > 120) {
      w.problems.push(`STUCK: no progress for 120 steps at ${fingerprint}`);
      throw new Error(`stuck at ${fingerprint}`);
    }

    await step(page, s);
  }
  w.problems.push(`ran out of steps (${maxSteps}) before reaching the end`);
  throw new Error("step budget exhausted");
}

/* ------------------------------------------------------------------ */
/* legs                                                                */
/* ------------------------------------------------------------------ */

async function openWithSave(
  browser: Browser,
  save: unknown,
  meta: unknown,
  w: Watch,
  tag: string,
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  watch(page, w, tag);
  await page.addInitScript(
    ([k1, v1, k2, v2]: string[]) => {
      localStorage.setItem(k1, v1);
      localStorage.setItem(k2, v2);
    },
    [SAVE_KEY, JSON.stringify(save), META_KEY, JSON.stringify(meta)],
  );
  await page.goto(URL_);
  await waitForScene(page, "boot");
  await page.mouse.click(640, 360); // boot is a click-to-start gate
  await waitForScene(page, "title");
  await key(page, "o", 1200); // Continue
  await waitForScene(page, "runMap");
  await page.waitForTimeout(700);
  return page;
}

interface MetaSnapshot {
  /** The unlock currency Cat Town spends. */
  shinies: number;
  lifetimeShinies: number;
  counters: { runs: number; victories: number };
  bestScore: number;
  /** Enemy ids the run actually learned — the bestiary's own keys. */
  bestiary: string[];
  /** Most recent run first — `history[0]` is the run that just ended. */
  history: { victory: boolean; floor: number; score: number; payout: number }[];
}

const metaOf = (page: Page): Promise<MetaSnapshot | null> =>
  hook(
    page,
    () => {
      const raw = localStorage.getItem("catrpg.meta.v1");
      if (!raw) return null as never;
      const m = JSON.parse(raw) as {
        meta?: Record<string, unknown>;
      } & Record<string, unknown>;
      const p = (m.meta ?? m) as {
        shinies?: number;
        lifetimeShinies?: number;
        counters?: { runs: number; victories: number };
        records?: { bestScore: number };
        bestiary?: Record<string, unknown>;
        history?: {
          victory: boolean;
          floor: number;
          score: number;
          payout: number;
        }[];
      };
      return {
        shinies: p.shinies ?? 0,
        lifetimeShinies: p.lifetimeShinies ?? 0,
        counters: p.counters ?? { runs: 0, victories: 0 },
        bestScore: p.records?.bestScore ?? 0,
        bestiary: Object.keys(p.bestiary ?? {}),
        history: p.history ?? [],
      } as never;
    },
    null,
  );

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const w: Watch = { problems: [], notes: [] };
  // `--only=win` / `--only=loss` drives one leg. The gate runs both; the flag
  // is for the half-hour of iteration that follows a failure in one of them.
  const only =
    process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "both";
  const doWin = only === "both" || only === "win";
  const doLoss = only === "both" || only === "loss";

  const parked = parkedAtFloor5();
  log(`victory leg — injected save: ${parked.summary}`);
  const doomed = doomedOnFloor6();

  const proc = await startServer();
  const browser = await chromium.launch({ headless: !HEADED });
  // A killed driver must not leave a vite and a headless chromium behind
  // holding port 5197 and a stale log fd — the next run then reports the
  // ghost's screen instead of its own.
  const reap = (): void => {
    proc.kill("SIGKILL");
    void browser.close();
  };
  process.on("SIGINT", () => {
    reap();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    reap();
    process.exit(143);
  });

  try {
    /* ---- LEG 1: the whole ending ---------------------------------- */
    if (doWin) {
      const page = await openWithSave(
        browser,
        parked.save,
        vetMeta(),
        w,
        "win",
      );
      const before = await metaOf(page);
      const startFloor = (await runOf(page))?.floorNum;
      if (startFloor !== FLOOR_COUNT - 1) {
        w.problems.push(`victory leg started on floor ${startFloor}, want 5`);
      }
      await shot(page, "final-01-floor5.png");

      const report = await playUntil(page, (s) => s === "results", w, {
        onBoss: async (p) => {
          await p.waitForTimeout(1400); // the Stand announcement plays out
          await shot(p, "final-boss.png");
          const bs = await battleOf(p);
          log(
            `  🐕 the lair: ${bs?.species.join(" + ")} · ` +
              `poise ${bs?.boss?.poise}/${bs?.boss?.poiseMax}`,
          );
        },
      });
      log(`  played to the results screen in ${report.steps} decisions`);

      if (!report.floorsSeen.includes(5) || !report.floorsSeen.includes(6)) {
        w.problems.push(
          `did not play both late floors — saw ${report.floorsSeen.join(",")}`,
        );
      }
      if (!report.bossFight) {
        w.problems.push("never met a boss with Poise on the way down");
      } else if (report.bossFight.species[0] !== "dogfather") {
        w.problems.push(
          `the lair held '${report.bossFight.species[0]}', not the Dogfather`,
        );
      } else if (report.bossFight.species.length < 2) {
        w.problems.push("the Dogfather had no escort");
      }

      // the results screen, victorious
      await page.waitForTimeout(900);
      await key(page, "Space", 700); // skip the tally
      await shot(page, "final-victory.png");

      const afterRun = await runOf(page);
      if (afterRun && afterRun.score.bossesDefeated < 2) {
        w.problems.push(
          `results reached with only ${afterRun.score.bossesDefeated} bosses down`,
        );
      }
      const carried = afterRun?.inventory.shinies ?? 0;

      // …and home to Cat Town with the payout
      await key(page, "Enter", 1400);
      await waitForScene(page, "catTown");
      await page.waitForTimeout(900);
      await shot(page, "final-02-town-after-victory.png");

      const after = await metaOf(page);
      log(
        `  banked: ${before?.shinies ?? 0} ✦ → ${after?.shinies ?? 0} ✦ ` +
          `(carried ${carried} out of the dungeon)`,
      );
      if (!after) {
        w.problems.push("no meta profile in localStorage after the run");
      } else {
        if (after.counters.victories !== 1) {
          w.problems.push(
            `victories counter is ${after.counters.victories}, want 1`,
          );
        }
        if (after.counters.runs !== 2) {
          w.problems.push(`runs counter is ${after.counters.runs}, want 2`);
        }
        if (after.shinies <= (before?.shinies ?? 0)) {
          w.problems.push("the victory paid out nothing");
        }
        if (after.lifetimeShinies !== after.shinies) {
          w.problems.push(
            `lifetime ${after.lifetimeShinies} ✦ ≠ banked ${after.shinies} ✦ ` +
              "on a town that has never spent anything",
          );
        }
        if (after.bestScore <= 0) w.problems.push("bestScore never updated");
        if (after.bestiary.length <= (before?.bestiary.length ?? 0)) {
          w.problems.push("the bestiary learned nothing on floors 5-6");
        }
        // the ending's own entry: you cannot fight the Dogfather and not
        // know what a Dogfather is
        if (!after.bestiary.includes("dogfather")) {
          w.problems.push(
            `the Dogfather never made the bestiary (${after.bestiary.join(",")})`,
          );
        }
        if (!after.bestiary.includes("porcelainHound")) {
          w.problems.push("the boss escort never made the bestiary");
        }
        const rec = after.history[0];
        if (!rec) {
          w.problems.push("the run was not written into the town's history");
        } else {
          if (!rec.victory)
            w.problems.push("history recorded the win as a loss");
          if (rec.floor !== FLOOR_COUNT) {
            w.problems.push(
              `history says floor ${rec.floor}, want ${FLOOR_COUNT}`,
            );
          }
          if (rec.payout <= 0)
            w.problems.push("history recorded a zero payout");
        }
        log(
          `  meta: bestiary [${after.bestiary.join(", ")}] · ` +
            `best ${after.bestScore} · history ${JSON.stringify(rec ?? null)}`,
        );
      }
      await page.close();
    }

    /* ---- LEG 2: the loss ------------------------------------------- */
    if (doLoss) {
      log("defeat leg — the same party, one Life each, on floor 6");
      const p2 = await openWithSave(browser, doomed.save, vetMeta(), w, "loss");
      const beforeLoss = await metaOf(p2);
      const lossReport = await playUntil(p2, (s) => s === "results", w, {
        maxSteps: 800,
      });
      log(`  fell after ${lossReport.steps} decisions`);
      await p2.waitForTimeout(900);
      await key(p2, "Space", 700);
      await shot(p2, "final-defeat.png");
      // THE WIPE MUST HAVE REACHED THE RUN the results screen is reading.
      // A defeat ends the battle without the Nine Lives standup (combat.md
      // §12), so the fielded cats keep their Life count and come out at 0 HP
      // — that zero is the signal, and every cat that WALKED must carry it.
      // (The cats who never left town keep their HP and are not counted.)
      const lossRun = await runOf(p2);
      const walked =
        lossRun?.cats.filter((c) =>
          lossRun.marchingOrder.includes(c.classId),
        ) ?? [];
      const standing = walked.filter((c) => c.hp > 0 && c.lives > 0);
      log(
        `  the clowder: ${walked
          .map((c) => `${c.classId} ${c.hp}hp/${c.lives}♥`)
          .join(", ")}`,
      );
      if (walked.length === 0) {
        w.problems.push("defeat leg: nobody was fielded — nothing was proved");
      }
      if (standing.length > 0) {
        w.problems.push(
          `defeat results reads ${standing.length} cats still standing ` +
            `(${standing.map((c) => c.classId).join(",")}) after a wipe`,
        );
      }
      await key(p2, "Enter", 1400);
      await waitForScene(p2, "catTown");
      await p2.waitForTimeout(600);
      await shot(p2, "final-03-town-after-defeat.png");
      const afterLoss = await metaOf(p2);
      if (!afterLoss) {
        w.problems.push("no meta profile after the defeat");
      } else {
        if (afterLoss.shinies <= (beforeLoss?.shinies ?? 0)) {
          w.problems.push(
            "a losing run paid out nothing (balance-and-meta §4)",
          );
        }
        if (afterLoss.counters.victories !== 0) {
          w.problems.push("a defeat counted as a victory");
        }
        log(
          `  defeat payout: ${beforeLoss?.shinies ?? 0} ✦ → ${afterLoss.shinies} ✦`,
        );
      }
      await p2.close();
    }
  } finally {
    if (!process.argv.includes("--keep")) await browser.close();
    proc.kill("SIGTERM");
  }

  if (w.notes.length > 0) {
    log("\nNOTES (expected offline paths):");
    const seen = new Set<string>();
    for (const n of w.notes) {
      if (seen.has(n)) continue;
      seen.add(n);
      log("  · " + n);
    }
  }
  if (w.problems.length > 0) {
    console.error("\nPROBLEMS:");
    for (const p of w.problems) console.error("  · " + p);
    writeFileSync(
      resolve(SHOTS, "full-run-problems.txt"),
      w.problems.join("\n") + "\n",
    );
    process.exitCode = 1;
  } else {
    log("\nthe whole game, twice: no page errors, no stalls, no dead ends.");
  }
}

void main();
