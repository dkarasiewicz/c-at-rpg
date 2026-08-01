/**
 * THE FINAL GATE — the same journey twice, once with a mouse and a keyboard
 * at 1280×720, once with nothing but a fingertip at 844×390.
 *
 *   town → route → fight → inspect an enemy → typed action → results
 *
 * and then, separately, the two DEGRADATION paths: a DM that was never
 * configured, and a DM that is configured but dead. Both must reach the
 * results screen without a page error.
 *
 * The mobile leg is FINGER ONLY — taps and one long press, never a game
 * hotkey — and every coordinate it touches is read back off the live stage
 * through `window.__hits()` rather than guessed from a mockup, so a button
 * that moved 20px fails the gate instead of silently passing it. The one
 * keyboard event in the whole leg is text going INTO the typed-action
 * `<input>`, which is what a virtual keyboard is.
 *
 * The gestures are the shipped ones (docs/design/mobile.md §2): a TAP ACTS —
 * one tap takes a route, one tap commits an attack — and a LONG PRESS READS,
 * which is how the leg opens the enemy intel card.
 *
 *   npx tsx tests/browser/final-gate.ts [--headed] [--keep]
 *
 * Screenshots land in docs/screenshots/ as gate-*.png.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, devices, type Browser, type Page } from "playwright";
import { startStubDm, type StubDm } from "./stubDm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../../docs/screenshots");
const HEADED = process.argv.includes("--headed");
/** `--debug` narrates every tap, which is the only way to debug a finger. */
const DEBUG = process.argv.includes("--debug");
const PORT = 5199;
const URL_ = `http://localhost:${PORT}`;

const DESKTOP = { width: 1280, height: 720 };
/** 390×844 held sideways — the gate's phone. */
const PHONE = { width: 844, height: 390 };
/**
 * Both legs pin this through the title's own Seed… field. A new run rolls a
 * random seed, which means a different floor layout every time — fine for a
 * player, useless for a gate whose screenshots are meant to be compared.
 */
const GATE_SEED = "GATE-1";

/* ------------------------------------------------------------------ */
/* plumbing                                                            */
/* ------------------------------------------------------------------ */

const problems: string[] = [];
const notes: string[] = [];

function startServer(dmUrl: string): Promise<{ proc: ChildProcess }> {
  const proc = spawn(
    "npx",
    ["vite", "--config", resolve(HERE, "vite.playtest.config.ts")],
    {
      cwd: resolve(HERE, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VITE_DM_URL: dmUrl },
    },
  );
  proc.stderr?.on("data", (b: Buffer) => process.stderr.write(b));
  return (async () => {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 60_000) {
        proc.kill("SIGTERM");
        throw new Error("vite never started serving");
      }
      try {
        if ((await fetch(URL_ + "/")).ok) return { proc };
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
}

/** Watch a page for anything that should never happen. */
function watch(page: Page, tag: string, allow: (u: string) => boolean): void {
  page.on("pageerror", (e) =>
    problems.push(`[${tag}] pageerror: ${e.message}`),
  );
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (t.includes("Failed to load resource") || t.includes("ERR_")) {
      notes.push(`[${tag}] console: ${t}`);
      return;
    }
    problems.push(`[${tag}] console: ${t}`);
  });
  page.on("requestfailed", (r) => {
    const line = `[${tag}] request failed: ${r.url()}`;
    (allow(r.url()) ? notes : problems).push(line);
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const line = `[${tag}] HTTP ${r.status()}: ${r.url()}`;
    (allow(r.url()) ? notes : problems).push(line);
  });
}

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

async function waitScene(page: Page, id: string, ms = 25_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if ((await scene(page)) === id) return;
    if (Date.now() - t0 > ms) {
      throw new Error(
        `timed out waiting for '${id}' (still on '${await scene(page)}')`,
      );
    }
    await page.waitForTimeout(120);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(SHOTS, name) });
  console.log(`    📸 ${name}`);
}

const key = async (page: Page, k: string, settle = 320): Promise<void> => {
  await page.keyboard.press(k);
  await page.waitForTimeout(settle);
};

/* ------------------------------------------------------------------ */
/* tapping                                                             */
/* ------------------------------------------------------------------ */

interface Hit {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The enemy standing furthest from the party, on the live battle screen.
 *
 * Combatants are the only unit-sized interactive boxes on the board (the kit
 * buttons and skill cards are far smaller, the backdrop is far larger), and
 * the enemy line is always to the RIGHT of the cats — so the rightmost unit
 * is an enemy on every roster and every party size. Matching on label text
 * does not work: a unit's only text is its paw row and its intent number.
 */
async function rightmostEnemy(page: Page): Promise<Hit | undefined> {
  const units = (await hits(page)).filter(
    (h) => h.w > 80 && h.w < 320 && h.h > 100 && h.h < 300,
  );
  return units.sort((a, b) => b.x - a.x)[0];
}

async function hits(page: Page): Promise<Hit[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __hits?: () => Hit[] };
    return typeof w.__hits === "function" ? w.__hits() : [];
  }) as Promise<Hit[]>;
}

/**
 * A real finger: `touchscreen.tap`, never `mouse.click`. On a `hasTouch`
 * context these are different code paths in pixi's event system, and only
 * one of them is what a phone does.
 */
async function tapAt(page: Page, x: number, y: number): Promise<void> {
  await page.touchscreen.tap(Math.round(x), Math.round(y));
  await page.waitForTimeout(420);
}

/**
 * A finger that STAYS DOWN — the details gesture (docs/design/mobile.md §2:
 * tap acts, long press reads). Playwright's touchscreen only knows how to
 * tap, so the press is driven straight through CDP: touchStart, wait past
 * `LONG_PRESS_MS`, touchEnd.
 */
async function holdAt(
  page: Page,
  x: number,
  y: number,
  ms = 650,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const pt = [
    { x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: pt,
  });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  await page.waitForTimeout(420);
}

/** Tap the centre of the first interactive thing whose text matches. */
async function tap(page: Page, want: string | RegExp): Promise<Hit> {
  const all = await hits(page);
  const re = typeof want === "string" ? null : want;
  const found = all.find((h) =>
    re ? re.test(h.text) : h.text.toLowerCase().includes(want.toLowerCase()),
  );
  if (!found) {
    throw new Error(
      `no tappable "${String(want)}" — saw: ` +
        all.map((h) => JSON.stringify(h.text)).join(", "),
    );
  }
  await tapAt(page, found.x + found.w / 2, found.y + found.h / 2);
  return found;
}

/* ------------------------------------------------------------------ */
/* the journey                                                         */
/* ------------------------------------------------------------------ */

/** Boot gate → title. Same on both, because it is one gesture either way. */
async function throughBoot(page: Page, touch: boolean): Promise<void> {
  await waitScene(page, "boot");
  const c = page.viewportSize()!;
  if (touch) await tapAt(page, c.width / 2, c.height / 2);
  else await page.mouse.click(c.width / 2, c.height / 2);
  await waitScene(page, "title");
  await page.waitForTimeout(600);
}

/**
 * Walk the board with a keyboard until a fight starts.
 *
 * Deliberately written as "poke, then look" rather than "one key per step":
 * the DM's unprompted card, the way-in hold, a landing and an event all sit
 * in the way, and every one of them eats a confirm. Counting keys is how a
 * driver ends up asserting on the wrong screen.
 */
async function walkToBattle(page: Page): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const s = await scene(page);
    if (s === "battle") return;
    if (s === "event") {
      // an event is TWO beats: pick an option, then dismiss the result. "1"
      // is inert on the result card and Enter is inert on the prompt, so
      // sending both is idempotent from either state.
      await key(page, "1", 1100);
      await key(page, "Enter", 1100);
    } else if (s === "landing") {
      // the landing (rest/shop) descends on Enter — Esc does nothing there
      await key(page, "Enter", 1100);
    } else if (s === "results") throw new Error("run ended before any fight");
    else if (s === "runMap") {
      // Enter takes the held way-in; once that is gone it confirms the
      // selected route. Either way the board is what we came back to.
      await key(page, "Enter", 1500);
    } else await page.waitForTimeout(500);
  }
  throw new Error(`never reached a battle (stuck on '${await scene(page)}')`);
}

/**
 * The DESKTOP leg — keyboard and mouse, the way the game has always been
 * played.
 */
async function desktopJourney(page: Page): Promise<void> {
  await throughBoot(page, false);
  await shot(page, "gate-desktop-01-title.png");

  // Pin the run seed so this leg walks the same floor every time and a
  // re-shot screenshot is comparable to the last one. On a FINE pointer the
  // seed entry is a keyboard buffer, not a DOM field — the `<input>` is
  // built only on touch (title.ts: `if (!isTouch() || seedField) return`) —
  // so this types it key by key, exactly as a player would.
  await key(page, "s", 600);
  for (const ch of GATE_SEED.toLowerCase()) await key(page, ch, 90);
  await key(page, "Enter", 700); // closes seed entry

  await key(page, "Enter", 900); // New Run → Cat Town
  await waitScene(page, "catTown");
  await page.waitForTimeout(700);
  await shot(page, "gate-desktop-02-cattown.png");

  await key(page, "Enter", 900); // Begin the descent
  await waitScene(page, "runMap", 30_000);
  await page.waitForTimeout(1400);
  await shot(page, "gate-desktop-03-runmap.png");

  // THE MENU MUST WORK ON A FLOOR'S FIRST FRAME. The way-in hold swallows
  // the route keys on purpose, and it used to swallow Esc with them — which
  // made the pause menu unreachable until the party had walked in, while the
  // header sat there promising "Esc menu". The scene manager only opens
  // pause when the scene DECLINES the key, so this is a one-key regression
  // away at all times.
  // Esc is a STACK — it closes the topmost thing first — and the DM's
  // unprompted card can be sitting on the board, so the assertion is "the
  // menu is reachable in a couple of presses", not "in exactly one". The bug
  // this guards made it reachable in NO number of presses.
  let heldOverlay: string | null = null;
  for (let i = 0; i < 3 && heldOverlay !== "pause"; i++) {
    await key(page, "Escape", 700);
    heldOverlay = await page.evaluate(() =>
      (window as unknown as { __overlay: () => string | null }).__overlay(),
    );
  }
  if (heldOverlay !== "pause") {
    problems.push(
      "[desktop] Esc never opened the menu during the way-in hold " +
        `(overlay: ${String(heldOverlay)})`,
    );
  } else {
    console.log("    menu opens during the way-in hold");
  }
  await key(page, "Escape", 700); // back out, and carry on

  // The floor's way-in is HELD (the board is the floor's first frame) and
  // one confirm walks in — but the DM's unprompted beat can be sitting on
  // top of it, and Enter spends itself dismissing that card first. So this
  // presses until the scene actually changes rather than assuming one key
  // is one step, which is also what a player does.
  await walkToBattle(page);
  await page.waitForTimeout(1500);
  await shot(page, "gate-desktop-04-battle.png");

  /* ---- inspect an enemy ------------------------------------------- */
  // On a mouse the enemy card is a HOVER. Park the pointer on an enemy and
  // let the card come up — no keyboard fallback, because a fallback would
  // hide exactly the regression this step exists to catch.
  const enemy = await rightmostEnemy(page);
  if (!enemy) {
    problems.push("[desktop] no enemy unit on the battle screen to inspect");
  } else {
    await page.mouse.move(enemy.x + enemy.w / 2, enemy.y + enemy.h / 2);
    await page.waitForTimeout(1000);
    await shot(page, "gate-desktop-05-inspect.png");
    console.log("    enemy inspected on hover");
  }
  await page.mouse.move(640, 700);
  await page.waitForTimeout(400);

  /* ---- the typed action ------------------------------------------- */
  await key(page, "t", 1000);
  const field = page.locator("input");
  if ((await field.count()) === 0) {
    problems.push("[desktop] [T] never opened a typed-action field");
  } else {
    await field.fill("I kick the hanging lantern at the nearest shape");
    await page.waitForTimeout(300);
    await shot(page, "gate-desktop-06-typed.png");
    await key(page, "Enter", 2600);
    await shot(page, "gate-desktop-07-verdict.png");
    console.log("    typed action adjudicated");
  }

  /* ---- fight it out to a conclusion -------------------------------- */
  const rotation = ["2", "3", "4", "5"];
  for (let i = 0; i < 60 && (await scene(page)) === "battle"; i++) {
    await key(page, rotation[i % rotation.length], 200);
    await key(page, "Enter", 200);
  }
  console.log(`    after the fight: '${await scene(page)}'`);

  /* ---- results ----------------------------------------------------- */
  await toResults(page, false);
  await shot(page, "gate-desktop-08-results.png");
}

/**
 * The finger's version of `walkToBattle`.
 *
 * Preference order matters and is the whole test: the DM's Continue chip
 * first (it is modal and covers the board), then the way-in prompt, then a
 * route medallion. If any one of those three has no reachable touch target,
 * this loop runs out of turns and the gate fails — which is exactly the
 * failure a tap-only player would hit.
 */
async function tapToBattle(page: Page): Promise<void> {
  // Which board node to try next. Only the ringed nodes are legal routes and
  // nothing in the census says which those are, so the driver does what a
  // player does: try one, and if the board is still there, try the next.
  let nodeCursor = 0;
  for (let i = 0; i < 30; i++) {
    const s = await scene(page);
    if (s === "battle") return;
    if (s === "results") throw new Error("run ended before any fight");
    const all = await hits(page);
    // A modal card first (it covers the board), then the way-in prompt, then
    // an event's last option, then a route medallion. "THE WAY DOWN" is a
    // NODE CAPTION, not a button — matching it here is how this loop spent
    // thirty taps on a node the entry hold had deliberately shut.
    //
    // An event's AUTHORED options are its rows MINUS the typed-action row
    // ("Do something else…") and the controls that back out of it. A naive
    // "take the last row" bounces between those two forever without ever
    // resolving the event. Matching on the 1-4 hotkey chip would work on a
    // desktop and fail on a phone, where the chips are not drawn at all.
    const numbered = all.filter(
      (h) =>
        h.w > 80 &&
        h.text.length > 3 &&
        !/Do something else|Never mind|Say it|log$/i.test(h.text),
    );
    const nodes = all.filter((h) => h.w > 35 && h.h > 45 && h.text.length > 0);
    const pick =
      all.find((h) => /Continue|Close/i.test(h.text)) ??
      all.find((h) => /Into the/i.test(h.text)) ??
      (s === "event" ? numbered[numbered.length - 1] : undefined) ??
      (nodes.length > 0 ? nodes[nodeCursor % nodes.length] : undefined);
    if (pick && nodes.includes(pick)) nodeCursor += 1;
    if (!pick) {
      throw new Error(
        `nothing tappable on '${s}' — saw: ` +
          all.map((h) => JSON.stringify(h.text)).join(", "),
      );
    }
    // ONE TAP GOES (docs/design/mobile.md §2). A node used to want two — tap
    // to read, tap again to walk — and this loop dutifully sent both. It now
    // sends one, because a second tap would land on whatever the first one
    // opened.
    if (DEBUG) {
      console.log(
        `      tap#${i} on '${s}' → ${JSON.stringify(pick.text)} ` +
          `@${Math.round(pick.x)},${Math.round(pick.y)} ` +
          `${Math.round(pick.w)}×${Math.round(pick.h)}`,
      );
    }
    await tapAt(page, pick.x + pick.w / 2, pick.y + pick.h / 2);
    await page.waitForTimeout(900);
  }
  throw new Error(`never reached a battle (stuck on '${await scene(page)}')`);
}

/**
 * The MOBILE leg — `touchscreen.tap` and nothing else. Every target is
 * looked up by its own text on the live stage first.
 */
async function mobileJourney(page: Page): Promise<void> {
  await throughBoot(page, true);
  await shot(page, "gate-mobile-01-title.png");

  // Same pinned seed as the desktop leg, reached by TAPPING the Seed… row —
  // which is also the mobile check on the title's DOM field and the virtual
  // keyboard that comes with it.
  await tap(page, /Seed/i);
  await page.waitForTimeout(600);
  const seed = page.locator("input");
  if ((await seed.count()) === 0) {
    problems.push("[mobile] tapping Seed… never opened a field");
  } else {
    await seed.fill(GATE_SEED);
    await page.waitForTimeout(300);
    await shot(page, "gate-mobile-01b-seed.png");
    await seed.press("Enter");
    await page.waitForTimeout(700);
  }

  await tap(page, /Cat Town/i);
  await waitScene(page, "catTown");
  await page.waitForTimeout(800);
  await shot(page, "gate-mobile-02-cattown.png");

  await tap(page, /descent|Begin/i);
  await waitScene(page, "runMap", 30_000);
  await page.waitForTimeout(1400);
  await shot(page, "gate-mobile-03-runmap.png");

  // The same first-frame check as the desktop leg, through the ONE control a
  // phone has for all of it: the gutter menu button feeds the identical
  // `handleKey("esc")`, so a scene that swallows Esc strands a touch player
  // exactly as hard as a keyboard one.
  let heldOverlay: string | null = null;
  for (let i = 0; i < 3 && heldOverlay !== "pause"; i++) {
    await page.click("#sys-menu");
    await page.waitForTimeout(800);
    heldOverlay = await page.evaluate(() =>
      (window as unknown as { __overlay: () => string | null }).__overlay(),
    );
  }
  if (heldOverlay !== "pause") {
    problems.push(
      "[mobile] the menu button never opened the menu during the way-in " +
        `hold (overlay: ${String(heldOverlay)})`,
    );
  } else {
    console.log("    menu button works during the way-in hold");
    await shot(page, "gate-mobile-03b-pause.png");
  }
  await page.click("#sys-menu");
  await page.waitForTimeout(700);

  // the held way-in and everything after it, taken with a finger
  await tapToBattle(page);
  await page.waitForTimeout(1600);
  await shot(page, "gate-mobile-04-battle.png");

  /* ---- inspect an enemy, by HOLDING it ----------------------------- */
  // A tap is the attack now (docs/design/mobile.md §2). Reading an enemy is
  // the long press, and this leg is the one that proves it under a finger.
  const enemy = await rightmostEnemy(page);
  if (!enemy) {
    problems.push("[mobile] no enemy unit on the battle screen to press");
  } else {
    await holdAt(page, enemy.x + enemy.w / 2, enemy.y + enemy.h / 2);
    await page.waitForTimeout(800);
    const card = (await hits(page)).some((h) => /Close/i.test(h.text));
    await shot(page, "gate-mobile-05-inspect.png");
    if (!card) {
      problems.push("[mobile] a long press on an enemy opened no inspect card");
    } else {
      console.log("    enemy inspected by long press");
      // and it closes by its own Close chip — a phone has no Esc
      await tap(page, /Close/i);
    }
  }

  /* ---- the typed action, by tapping [T] ---------------------------- */
  try {
    await tap(page, /^T$|say what you do/i);
  } catch {
    // the chip's text may be just the glyph; fall back to the top-right chip
    const chip = (await hits(page)).find((h) => h.y < 90 && h.w < 200);
    if (chip) await tapAt(page, chip.x + chip.w / 2, chip.y + chip.h / 2);
  }
  await page.waitForTimeout(900);
  const field = page.locator("input");
  if ((await field.count()) === 0) {
    problems.push("[mobile] tapping [T] never opened a typed-action field");
  } else {
    // a virtual keyboard: text into the field, then TAP "Say it"
    await field.fill("I kick the hanging lantern at the nearest shape");
    await page.waitForTimeout(400);
    await shot(page, "gate-mobile-06-typed.png");
    await tap(page, /Say it/i);
    await page.waitForTimeout(2600);
    await shot(page, "gate-mobile-07-verdict.png");
    console.log("    typed action adjudicated by tap");
  }

  /* ---- fight on, tapping skill cards ------------------------------- */
  // Skill cards are the small boxes on the bottom shelf — bounded ABOVE as
  // well as below, or the full-width log bar sitting among them gets tapped
  // instead and the turn never advances.
  for (let i = 0; i < 30 && (await scene(page)) === "battle"; i++) {
    const cards = (await hits(page)).filter(
      (h) => h.y > 300 && h.w > 60 && h.w < 200,
    );
    if (cards.length === 0) break;
    const card = cards[i % cards.length];
    await tapAt(page, card.x + card.w / 2, card.y + card.h / 2);
    // a targeted skill then wants a target: tap an enemy
    const en = await rightmostEnemy(page);
    if (en) await tapAt(page, en.x + en.w / 2, en.y + en.h / 2);
  }
  console.log(`    after the fight: '${await scene(page)}'`);

  await toResults(page, true);
  await shot(page, "gate-mobile-08-results.png");
}

/**
 * Get to the results screen from wherever we are. Abandoning through the
 * pause menu is the honest route that always exists — and on touch it is the
 * gutter menu button, which is the whole of Esc parity.
 */
async function toResults(page: Page, touch: boolean): Promise<void> {
  if ((await scene(page)) !== "results") {
    const overlay = (): Promise<string | null> =>
      page.evaluate(() =>
        (window as unknown as { __overlay: () => string | null }).__overlay(),
      );
    // Open the pause menu from WHEREVER we are — the fight may have been won
    // (so we are back on the board) or still running. Esc on a keyboard, the
    // gutter menu button on a phone: the same one control, which is the
    // whole of Esc parity on touch.
    for (let i = 0; i < 6 && (await overlay()) !== "pause"; i++) {
      if (touch) await page.click("#sys-menu");
      else await key(page, "Escape", 500);
      await page.waitForTimeout(700);
    }
    if ((await overlay()) !== "pause") {
      problems.push(
        `[${touch ? "mobile" : "desktop"}] could not open the pause menu ` +
          `from '${await scene(page)}'`,
      );
    }
    // Abandon is row 5 and arms on the first press ("Really abandon?"), so
    // it always takes two.
    if (touch) {
      await tap(page, /Abandon Run/i);
      await tap(page, /Really abandon/i);
    } else {
      await key(page, "5", 600);
      await key(page, "5", 1400);
    }
    await waitScene(page, "results", 30_000);
  }
  await page.waitForTimeout(1500);
  // the tally types itself in; Space is the shipped "show me all of it"
  if (!touch) await key(page, "Space", 900);
  else await tapAt(page, 60, 30);
  await page.waitForTimeout(700);
}

/* ------------------------------------------------------------------ */
/* degradation                                                         */
/* ------------------------------------------------------------------ */

/**
 * ZERO GENERATED ASSETS. Every painted sprite, backdrop and item icon in this
 * game is AI-generated and shipped under `public/assets/gen/`. `initSprites`
 * is documented as fail-soft — a missing manifest just leaves the procedural
 * renderers in charge — but "documented" and "true" are different claims, and
 * the failure mode (a blank battlefield, or a throw inside the bootstrap
 * before any scene mounts) is invisible to every test that runs with the art
 * present.
 *
 * So this serves the real bundle with the whole art pack 404'd and plays to a
 * fight. No page error, no console error, and a battle on screen.
 */
async function noAssetsLeg(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: DESKTOP });
  watch(page, "noArt", (u) => u.includes("/assets/gen/"));
  let blocked = 0;
  await page.route("**/assets/gen/**", (route) => {
    blocked += 1;
    void route.fulfill({ status: 404, body: "gone" });
  });
  try {
    await page.goto(URL_);
    await throughBoot(page, false);
    await key(page, "Enter", 900);
    await waitScene(page, "catTown");
    await key(page, "Enter", 900);
    await waitScene(page, "runMap", 30_000);
    await page.waitForTimeout(1400);
    await walkToBattle(page);
    await page.waitForTimeout(1500);
    await shot(page, "gate-noart-battle.png");
    console.log(`    played to a fight with ${blocked} art request(s) 404'd`);
    if (blocked === 0) {
      problems.push("[noArt] nothing was actually blocked — check the route");
    }
  } finally {
    await page.close();
  }
}

/**
 * A whole run with no DM at all — the offline-first path. Nothing may be
 * requested, the `[T]` chip must never be built, and the run must still end
 * on the results screen.
 */
async function degradationLeg(
  browser: Browser,
  tag: string,
  expectProbe: boolean,
): Promise<void> {
  const page = await browser.newPage({ viewport: DESKTOP });
  const offOrigin: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (
      !u.startsWith(URL_) &&
      !u.startsWith("data:") &&
      !u.startsWith("blob:")
    ) {
      offOrigin.push(u);
    }
  });
  watch(page, tag, (u) => !u.startsWith(URL_));
  try {
    await page.goto(URL_);
    await throughBoot(page, false);
    await key(page, "Enter", 900);
    await waitScene(page, "catTown");
    await key(page, "Enter", 900);
    await waitScene(page, "runMap", 30_000);
    await page.waitForTimeout(1400);
    await walkToBattle(page);
    await page.waitForTimeout(1200);

    // the typed-action chip must NOT exist on this path
    await key(page, "t", 800);
    if ((await page.locator("input").count()) > 0) {
      problems.push(`[${tag}] a typed-action field opened with no DM`);
    }
    await shot(page, `gate-${tag}-battle.png`);

    const rotation = ["2", "3", "4", "5"];
    for (let i = 0; i < 60 && (await scene(page)) === "battle"; i++) {
      await key(page, rotation[i % rotation.length], 180);
      await key(page, "Enter", 180);
    }
    await toResults(page, false);
    await shot(page, `gate-${tag}-results.png`);
    console.log(
      `    ${tag}: reached results; off-origin requests: ` +
        `${offOrigin.length}`,
    );
    if (!expectProbe && offOrigin.length > 0) {
      problems.push(
        `[${tag}] made ${offOrigin.length} off-origin request(s): ` +
          offOrigin.slice(0, 3).join(", "),
      );
    }
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });

  /* ===== part 1: the two journeys, with a DM that answers ============ */
  const dm: StubDm = await startStubDm();
  console.log(`stub DM on ${dm.url}`);
  let server = await startServer(dm.url);
  const browser = await chromium.launch({ headless: !HEADED });
  const allowDm = (u: string): boolean => u.startsWith(dm.url);

  try {
    console.log("\n── DESKTOP 1280×720 ───────────────────────────────");
    const d = await browser.newPage({ viewport: DESKTOP });
    watch(d, "desktop", allowDm);
    await d.goto(URL_);
    await desktopJourney(d);
    await d.close();

    console.log("\n── MOBILE 844×390, hasTouch, TAP ONLY ─────────────");
    const ctx = await browser.newContext({
      ...devices["iPhone 13"],
      viewport: PHONE,
      screen: PHONE,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const m = await ctx.newPage();
    watch(m, "mobile", allowDm);
    await m.goto(URL_);
    await mobileJourney(m);
    await m.close();
    await ctx.close();

    console.log(`\n  stub DM handled ${dm.turns.length} turn(s)`);
    if (dm.turns.length === 0) {
      problems.push("the DM was never actually asked anything");
    }

    /* ===== part 2: degradation ====================================== */
    console.log("\n── DEGRADATION A: no DM configured ────────────────");
    server.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    server = await startServer(""); // VITE_DM_URL unset
    await degradationLeg(browser, "offline", false);

    console.log("\n── DEGRADATION B: DM configured but dead ──────────");
    server.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    server = await startServer("http://127.0.0.1:5599"); // nothing listens
    await degradationLeg(browser, "deadDm", true);

    console.log("\n── DEGRADATION C: zero generated assets ───────────");
    // Restart with NO DM first: this leg is about the art pack, and leaving
    // the dead-DM origin configured mixes a guaranteed probe failure into a
    // run whose whole point is that the only failures are the 404s we caused.
    server.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    server = await startServer("");
    await noAssetsLeg(browser);
  } finally {
    if (!process.argv.includes("--keep")) await browser.close();
    server.proc.kill("SIGTERM");
    await dm.close();
  }

  if (notes.length > 0) {
    console.log("\nNOTES (expected, not failures):");
    for (const n of [...new Set(notes)].slice(0, 20)) console.log("  · " + n);
  }
  if (problems.length > 0) {
    console.error("\nPROBLEMS:");
    for (const p of problems) console.error("  · " + p);
    process.exitCode = 1;
  } else {
    console.log("\n✅ both journeys and both degradation paths, no errors.");
  }
}

void main();
