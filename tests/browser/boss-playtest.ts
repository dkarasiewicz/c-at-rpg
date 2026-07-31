/**
 * THE FLOOR-6 PLAYTEST — the one nobody had ever run.
 *
 * Every automated gate in this repo stopped at floor 4 or shallower, so the
 * back half of the game (floors 5-6, the tier-3 roster, a level-8 party, the
 * Dogfather's lair) had never been on a screen. This drives a REAL browser
 * against the REAL bundle all the way into that lair.
 *
 * Playing five floors through the keyboard would take minutes and depend on
 * a hundred combat decisions, so the run is fast-forwarded the same way a
 * player's own Continue works: the headless driver
 * (tests/support/scriptedRun.ts) walks floors 1-5 with the real engines,
 * stops one route short of the floor-6 lair, and the resulting RunState is
 * written into `localStorage` as an ordinary v3 autosave. From there the
 * browser does everything: Continue → the floor-6 board → walk into the
 * lair → fight the Dogfather.
 *
 *   npx tsx tests/browser/boss-playtest.ts [--headed] [--keep]
 *
 * Screenshots land in docs/screenshots/. `boss-final.png` is the deliverable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page } from "playwright";
import { scriptedRun } from "../support/scriptedRun.js";
import { serializeRun } from "../../src/core/run/save.js";
import { FLOOR_COUNT } from "../../src/core/run/runState.js";
import { emptyProfile } from "../../src/core/meta/profile.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/screenshots");
const SEED = "DEEP-0";
const HEADED = process.argv.includes("--headed");

/** localStorage keys, mirrored from core/run/save.ts. */
const SAVE_KEY = "catrpg.save.v1";
const META_KEY = "catrpg.meta.v1";

/* ------------------------------------------------------------------ */
/* 1. the injected save                                                */
/* ------------------------------------------------------------------ */

/**
 * A floor-6 run standing one route from the lair.
 *
 * `resolvedNodes` is the run-map scene's own additive field (see the module
 * augmentation in ui/scenes/runMap.ts): without it the scene would re-fire
 * the encounter on the node the party is already standing on. Every node the
 * driver walked was resolved by the driver, so the visited list IS the
 * resolved list.
 */
function parkedSave(opts: Parameters<typeof scriptedRun>[1]): {
  save: unknown;
  meta: unknown;
  route: number;
  summary: string;
} {
  const out = scriptedRun(SEED, opts);
  const run = out.run;
  const file = serializeRun(run) as unknown as {
    run: Record<string, unknown>;
  };
  file.run.resolvedNodes = {
    floor: run.floorNum,
    ids: [...run.visitedNodeIds],
  };
  const lives = run.cats.map((c) => c.lives).join("/");
  return {
    save: file,
    // a profile with a run already banked, so the floor-1 novice grace is
    // not in play — this is a veteran's screen
    meta: { ...emptyProfile(), counters: { runs: 1, victories: 0 } },
    route: out.stoppedBeforeRoute,
    summary:
      `floor ${run.floorNum} · level ${run.level} · lives ${lives} · ` +
      `${run.inventory.shinies} ✦ · ${out.fights} fights · ` +
      `${run.score.enemiesDefeated} felled`,
  };
}

/** Load the game with a specific save already in localStorage. */
async function openWithSave(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
  save: unknown,
  meta: unknown,
  onProblem: (s: string) => void,
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  page.on("pageerror", (e) => onProblem(`pageerror: ${e.message}`));
  await page.addInitScript(
    ([k1, v1, k2, v2]: string[]) => {
      localStorage.setItem(k1, v1);
      localStorage.setItem(k2, v2);
    },
    [SAVE_KEY, JSON.stringify(save), META_KEY, JSON.stringify(meta)],
  );
  await page.goto(url);
  await waitForScene(page, "boot");
  await page.mouse.click(640, 360);
  await waitForScene(page, "title");
  await key(page, "o", 1200); // Continue
  await waitForScene(page, "runMap");
  await page.waitForTimeout(900);
  return page;
}

/* ------------------------------------------------------------------ */
/* 2. dev server                                                       */
/* ------------------------------------------------------------------ */

const PORT = 5199;
const URL_ = `http://localhost:${PORT}`;
/**
 * The DM is OPT-IN here (`DM_URL=… npx tsx …`), and off by default.
 *
 * Measured: the deployed DM's `/eve/v1/info` — the right probe, and the only
 * one that carries a CORS header a browser can read — answers 200 to curl but
 * sends no `Access-Control-Allow-Origin` for `http://localhost:5199`, because
 * its CORS allow-list is the deployed GAME origin. So from a local dev server
 * the probe can only ever fail, and pointing at it by default would bury a
 * guaranteed CORS error in every playtest report. Run the playtest from the
 * deployed origin if you want the tabletop layer exercised for real.
 */
const DM_URL = process.env.DM_URL ?? "";

/**
 * Start vite and wait for it to actually SERVE. Deliberately not by scraping
 * its banner — vite bolds the port number with an ANSI escape right in the
 * middle of the URL, so "localhost:\e[1m5199" does not match any sane regex.
 * Polling the port is both simpler and honest about what we need.
 */
async function startServer(): Promise<{ url: string; proc: ChildProcess }> {
  const proc = spawn(
    "npx",
    ["vite", "--config", resolve(HERE, "vite.playtest.config.ts")],
    {
      cwd: resolve(HERE, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
      // Empty by default (see DM_URL above): `probeDm` then short-circuits
      // without a request, and the game falls back to the stateless
      // `/api/gm` seam, which a dev server does not serve — a 404 the
      // reporter below files as a NOTE, because that is the documented
      // offline path rather than a defect.
      env: { ...process.env, VITE_DM_URL: DM_URL },
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
      if (res.ok) return { url: URL_, proc };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ------------------------------------------------------------------ */
/* 3. driving                                                          */
/* ------------------------------------------------------------------ */

/**
 * The dev hook main.ts installs. Absent until `app.init()` has resolved, and
 * the whole execution context can vanish under a dev-server reload, so both
 * are reported as "<booting>" rather than thrown at the caller.
 */
async function scene(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as { __scene?: () => string };
      return typeof w.__scene === "function" ? w.__scene() : "<booting>";
    });
  } catch {
    return "<booting>";
  }
}

async function waitForScene(
  page: Page,
  id: string,
  ms = 20_000,
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
  console.log(`  📸 ${name}`);
}

const key = async (page: Page, k: string, settle = 320): Promise<void> => {
  await page.keyboard.press(k);
  await page.waitForTimeout(settle);
};

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const { save, meta, summary } = parkedSave({
    throughFloor: FLOOR_COUNT,
    stopBeforeTerminal: true,
  });
  console.log(`injected save: ${summary}`);

  const { url, proc } = await startServer();
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const problems: string[] = [];
  const notes: string[] = [];
  // A dev server serves no `/api`, so the stateless GM fallback 404s by
  // design the moment the persistent DM probe comes back empty — that is the
  // documented offline path, not a defect. Everything else is a problem, and
  // is named with its URL rather than reported as a bare status code.
  const expected = (url: string): boolean =>
    url.includes("/api/gm/") || (DM_URL !== "" && url.startsWith(DM_URL));
  const record = (line: string, url: string): void => {
    (expected(url) ? notes : problems).push(line);
  };
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // the browser's own bare echo of the request failures classified above
    if (t.includes("Failed to load resource") || t.includes("ERR_FAILED")) {
      notes.push(`console: ${t}`);
      return;
    }
    problems.push(`console: ${t}`);
  });
  page.on("requestfailed", (r) =>
    record(`request failed: ${r.url()}`, r.url()),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) record(`HTTP ${r.status()}: ${r.url()}`, r.url());
  });

  try {
    // seed localStorage BEFORE the bundle boots (main.ts probes it on load)
    await page.addInitScript(
      ([k1, v1, k2, v2]: string[]) => {
        localStorage.setItem(k1, v1);
        localStorage.setItem(k2, v2);
      },
      [SAVE_KEY, JSON.stringify(save), META_KEY, JSON.stringify(meta)],
    );
    await page.goto(url);

    // BOOT is a click-to-start gate (browsers will not start audio or lock
    // the pointer without a gesture), so the playtest makes the gesture.
    await waitForScene(page, "boot");
    await page.mouse.click(640, 360);
    await waitForScene(page, "title");
    await page.waitForTimeout(500);
    await shot(page, "playtest-01-title.png");

    // Continue is [O] on the title menu, and it skips floorgen — the save
    // already carries the floor the party is standing on.
    await key(page, "o", 1200);
    await waitForScene(page, "runMap");
    await page.waitForTimeout(900);

    // THE BOARD, on floor 6, with the medallion captions on their ink
    // plates. This one is a RESUME, so the way in is already behind the
    // party — the fresh-floor hold is checked in phase 2 below.
    await shot(page, "playtest-02-floor6-map.png");

    const state = await page.evaluate(
      () => (window as unknown as { __run: () => unknown }).__run() as unknown,
    );
    const r = state as { floorNum: number; level: number };
    console.log(`  on the board: floor ${r.floorNum}, party level ${r.level}`);
    if (r.floorNum !== FLOOR_COUNT) {
      problems.push(`expected floor ${FLOOR_COUNT}, got ${r.floorNum}`);
    }

    // walk into the lair: route 1 is the terminal (the driver stopped there)
    await key(page, "1", 1400);
    await waitForScene(page, "battle");
    await page.waitForTimeout(1600); // the Stand announcement plays
    await shot(page, "boss-final.png");
    console.log("  🐕 the Dogfather is on screen");

    // …and let real rounds resolve, so the screenshot is not the only thing
    // ever proved about this fight.
    //
    // NOT by hammering "1": slot 1 is Claw Swipe, which is rank-gated, so a
    // cat standing in rank 3 has it greyed out and the key is a legal no-op.
    // (That is the rank system working, and it is exactly how the first pass
    // of this playtest sat on round 1 for forty keypresses.) Slot 5 is Guard,
    // which is always legal, so it is in the rotation as the guarantee that
    // the turn always advances.
    const rotation = ["2", "3", "4", "5"];
    for (let i = 0; i < 48 && (await scene(page)) === "battle"; i++) {
      await key(page, rotation[i % rotation.length], 240);
      await key(page, "Enter", 240);
    }
    await shot(page, "playtest-03-boss-rounds.png");
    console.log(`  after 48 inputs: scene '${await scene(page)}'`);

    /* -- phase 2: a FRESH floor 1, to see the way-in hold -------------- */
    //
    // `runMap.mount` used to call `resolveArrival()` synchronously, and every
    // floor's entry node carries content, so a player was dropped into a
    // fight before the board had ever been on screen. The board is now the
    // floor's first frame, with one confirm to walk in.
    const fresh = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    fresh.on("pageerror", (e) =>
      problems.push(`pageerror(fresh): ${e.message}`),
    );
    await fresh.goto(url); // no addInitScript ⇒ no save, no meta
    await waitForScene(fresh, "boot");
    await fresh.mouse.click(640, 360);
    await waitForScene(fresh, "title");
    await key(fresh, "Enter", 900); // New Run → Cat Town
    await waitForScene(fresh, "catTown");
    await key(fresh, "Enter", 900); // Begin the descent
    await waitForScene(fresh, "runMap", 30_000);
    await fresh.waitForTimeout(1200);
    const heldScene = await scene(fresh);
    await shot(fresh, "playtest-04-floor1-entry.png");
    console.log(`  fresh floor 1 settles on '${heldScene}' (want 'runMap')`);
    if (heldScene !== "runMap") {
      problems.push(
        `floor 1 did not settle on the board — landed on '${heldScene}'`,
      );
    }
    // …and the confirm really does walk into it
    await key(fresh, "Enter", 1800);
    const afterEnter = await scene(fresh);
    console.log(`  one confirm later: '${afterEnter}'`);
    if (afterEnter === "runMap") {
      problems.push("the way in did not resolve on Enter");
    }
    await fresh.close();

    /* -- phase 3: the EVENT modal (a card that fits its content) -------- */
    const ev = parkedSave({
      throughFloor: FLOOR_COUNT,
      stopBeforeType: "event",
    });
    if (ev.route === 0) {
      problems.push("no event node found to park in front of");
    } else {
      const p3 = await openWithSave(browser, url, ev.save, ev.meta, (s) =>
        problems.push(`(event) ${s}`),
      );
      await key(p3, String(ev.route), 1600);
      await waitForScene(p3, "event");
      await p3.waitForTimeout(900);
      await shot(p3, "playtest-05-event.png");
      // pick the last option (always the requirement-free walk-away) and
      // make sure the RESULT state lays out too
      await key(p3, "1", 1200);
      await shot(p3, "playtest-06-event-result.png");
      console.log(`  event modal → '${await scene(p3)}'`);
      await p3.close();
    }

    /* -- phase 4: pause hotkeys → abandon → RESULTS --------------------- */
    const p4 = await openWithSave(browser, url, save, meta, (s) =>
      problems.push(`(results) ${s}`),
    );
    await key(p4, "Escape", 700);
    await shot(p4, "playtest-07-pause.png");
    // 2 is THE DEN's row number (it used to print "P" and look like the menu
    // had skipped a number); Esc backs out, 5 twice abandons.
    await key(p4, "2", 800);
    const den = await p4.evaluate(() =>
      (window as unknown as { __overlay: () => string | null }).__overlay(),
    );
    if (den !== "pause") problems.push(`pause overlay lost on '2' (${den})`);
    await key(p4, "Escape", 500);
    await key(p4, "5", 500);
    await key(p4, "5", 1400);
    await waitForScene(p4, "results");
    // the tally is ~320ms per line and there are up to ten of them; Space is
    // the shipped "show me the whole table now" key
    await p4.waitForTimeout(1200);
    await key(p4, "Space", 900);
    await shot(p4, "playtest-08-results.png");
    console.log("  results screen reached via pause → abandon");
    await p4.close();
  } finally {
    if (!process.argv.includes("--keep")) await browser.close();
    proc.kill("SIGTERM");
  }

  if (problems.length > 0) {
    console.error("\nPROBLEMS:");
    for (const p of problems) console.error("  · " + p);
    writeFileSync(
      resolve(SHOTS, "playtest-problems.txt"),
      problems.join("\n") + "\n",
    );
    process.exitCode = 1;
  } else {
    console.log("\nno page errors, no console errors.");
  }
}

void main();
