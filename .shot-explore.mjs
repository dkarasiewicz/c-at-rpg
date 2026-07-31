import { chromium } from "playwright";
const url = "http://localhost:5188/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.mouse.click(640, 360);
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__scene && window.__scene() === "explore", null, { timeout: 15000 });
await page.waitForTimeout(800);

// wander: long runs in random cardinal directions, bailing out of any battle
const keys = "wasd";
let steps = 0;
outer: for (let burst = 0; burst < 40; burst++) {
  const k = keys[Math.floor(Math.random() * 4)];
  for (let i = 0; i < 6; i++) {
    if (await page.evaluate(() => window.__scene()) !== "explore") { console.log("left explore"); break outer; }
    await page.keyboard.press(k); steps++;
    await page.waitForTimeout(120);
  }
}
console.log("steps:", steps, "scene:", await page.evaluate(() => window.__scene()));
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/explore-far.png" });
if (await page.evaluate(() => window.__scene()) === "explore") {
  await page.keyboard.press("m"); await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/explore-map.png" });
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  console.log("after Esc on map, scene:", await page.evaluate(() => window.__scene()), "overlay:", await page.evaluate(() => window.__overlay()));
}
// crude fps probe while stepping
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now()-t0)/1000))); };
  requestAnimationFrame(tick);
}));
console.log("fps:", fps);
console.log(errors.length ? errors.join("\n") : "no errors");
await browser.close();
