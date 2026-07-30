// phase 5: full floor-1 playthrough (seed CAT1) — patched ticker, persistent profile
import { chromium } from "playwright";

const SHOTS = "/Users/dkarasiewicz/.claude/jobs/ea3bc38d/tmp";
const PROFILE = "/Users/dkarasiewicz/.claude/jobs/ea3bc38d/tmp/pw-profile";
let marker = "start";
const errors = [];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1280, height: 720 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("pageerror", (e) => {
  errors.push({ at: marker, msg: e.message });
  console.log(`PAGEERROR @${marker}: ${e.message}`);
});
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("PT-")) console.log(`@${marker} ${t}`);
  else if (m.type() === "error") console.log(`CONSOLE-ERR @${marker}: ${t.slice(0, 200)}`);
});

const shot = (n) => page.screenshot({ path: `${SHOTS}/pt-battle-${n}.png` });
const key = async (k, ms = 140) => { await page.keyboard.press(k); await page.waitForTimeout(ms); };

await page.goto("http://localhost:5301");
await page.waitForTimeout(1000);
await page.evaluate(() => localStorage.clear()); // fresh start this session
await page.reload();
await page.waitForTimeout(1200);

// K1 workaround patch: swallow writes to destroyed containers (log once per site)
await page.evaluate(async () => {
  const src = await (await fetch("/src/ui/tween.ts")).text();
  const m = src.match(/from "(\/node_modules\/\.vite\/deps\/pixi__js\.js[^"]*)"/);
  const pixi = await import(m[1]);
  const C = pixi.Container.prototype;
  window.__ptSeen = new Set();
  for (const prop of ["x", "y", "alpha", "rotation"]) {
    const desc = Object.getOwnPropertyDescriptor(C, prop);
    if (!desc?.set) continue;
    Object.defineProperty(C, prop, {
      get: desc.get,
      set(v) {
        if (this.destroyed || !this._position) {
          const sig = `${prop}:${this.constructor.name}`;
          if (!window.__ptSeen.has(sig)) {
            window.__ptSeen.add(sig);
            console.log(`PT-DESTROYED-SET ${prop} on ${this.constructor.name} text=${this.text ?? ""}`);
          }
          return;
        }
        desc.set.call(this, v);
      },
    });
  }
});

async function probe() {
  const buf = await page.screenshot();
  return await page.evaluate(async (b64) => {
    const { PAL, THEMES } = await import("/src/ui/palette.ts");
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = new OffscreenCanvas(img.width, img.height);
    const c2 = cv.getContext("2d", { willReadFrequently: true });
    c2.drawImage(img, 0, 0);
    const px = (x, y) => {
      const d = c2.getImageData(x, y, 1, 1).data;
      return (d[0] << 16) | (d[1] << 8) | d[2];
    };
    const near = (a, b, tol = 14) =>
      Math.abs((a >> 16) - (b >> 16)) <= tol &&
      Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= tol &&
      Math.abs((a & 255) - (b & 255)) <= tol;
    const inBattle = THEMES.some((t) => near(px(620, 472), t.floorA));
    // guard-slot hotkey chip: sample two corner points inside the 16x16 chip
    const chipGold = near(px(579, 595), PAL.gold) || near(px(589, 605), PAL.gold);
    return { inBattle, inputPhase: chipGold };
  }, buf.toString("base64"));
}

async function playBattle(name, opts = {}) {
  const { fleeAfterGuards = -1, guardPhases = 0, escTest = false, shotEvery = 10, drainKey = "Enter" } = opts;
  let inputs = 0;
  let stuck = 0;
  for (let iter = 0; iter < 150; iter++) {
    marker = `${name}-i${iter}`;
    const st = await probe();
    if (!st.inBattle) {
      await page.waitForTimeout(400);
      if (!(await probe()).inBattle) break;
      continue;
    }
    if (iter % shotEvery === 0) await shot(`${name}-i${String(iter).padStart(3, "0")}`);
    if (st.inputPhase) {
      inputs++;
      stuck = 0;
      if (escTest && inputs === 2) {
        await key("Escape", 500);
        await shot(`${name}-esc-pause-in-battle`);
        await key("Escape", 500);
        await shot(`${name}-esc-resumed`);
        continue;
      }
      if (fleeAfterGuards >= 0 && inputs > fleeAfterGuards) {
        await key("r", 700);
        continue;
      }
      if (inputs <= guardPhases) {
        await key("5", 400);
        continue;
      }
      await key("1", 250);
      await key("Enter", 250);
      await key("5", 250);
    } else {
      stuck++;
      if (stuck >= 7) {
        await shot(`${name}-stuck`);
        await key("Enter", 300);
        stuck = 0;
      }
      await page.waitForTimeout(400);
    }
  }
  marker = `${name}-post`;
  await shot(`${name}-post0`);
  for (let i = 0; i < 4; i++) await key(drainKey, 600);
  await page.waitForTimeout(500);
  await shot(`${name}-post1`);
}

const walk = async (dirs, ms = 320) => {
  const map = { N: "ArrowUp", E: "ArrowRight", S: "ArrowDown", W: "ArrowLeft" };
  for (const d of dirs) await key(map[d], ms);
};

// ---- title -> seeded run ----
marker = "title";
await key("Enter", 500);
await key("s", 150);
for (const ch of "cat1") await key(ch, 60);
await key("Enter", 250);
await key("Enter", 400);
await page.waitForTimeout(2200);

marker = "S1-walk";
await walk("NNEEENNEEEEEEEEEEEESS");
await page.waitForTimeout(1800);
await shot("50-battleA-open");
await playBattle("51-battleA", { escTest: true, shotEvery: 8 });

marker = "S2-walk";
await walk("ESSSSSSSSEEESS");
await page.waitForTimeout(1800);
await shot("52-battleB-open");
await playBattle("53-battleB", { fleeAfterGuards: 4 });

marker = "S3-walk-chest";
await walk("NNEEEENNNNWWNNNNNNNNEESSS");
await page.waitForTimeout(900);
await shot("54-chest-overlay");
await key("Enter", 700);
await shot("55-after-chest");

marker = "S4-walk-event";
await walk("NNWWSSSSSSWWW");
await page.waitForTimeout(900);
await shot("56-event-modal");
await key("1", 800);
await shot("57-event-after-1");
await key("Enter", 800);
await shot("58-event-after-continue");
// if the event chained into a fight, play it out
if ((await probe()).inBattle) {
  await playBattle("59-eventfight", {});
}
await shot("60-after-event");

marker = "S5-walk";
await walk("SSSSWWSSWWWWWWWSSSW");
await page.waitForTimeout(1800);
await shot("61-battleC-open");
await playBattle("62-battleC", {});

marker = "S6-walk";
await walk("WWWWW");
await page.waitForTimeout(1800);
await shot("63-battleD-open");
await playBattle("64-battleD", {});

marker = "S7-walk";
await walk("EEEEEENNNEEEEEEEEEESS");
await page.waitForTimeout(1800);
await shot("65-battleE-open");
await playBattle("66-battleE", { guardPhases: 8, shotEvery: 6, drainKey: "Escape" });

marker = "S8-stairs";
await walk("SSWWW");
await page.waitForTimeout(600);
await shot("67-stairs-toast");
await key("Enter", 1200);
await shot("68-landing");

console.log("ERRORS:", JSON.stringify(errors, null, 1));
await ctx.close();
