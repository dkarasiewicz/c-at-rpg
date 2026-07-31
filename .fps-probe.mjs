import { chromium } from "playwright";
const url = "http://localhost:5188/";
const cfgs = [{}, {noRock:1}, {noFog:1}, {noTiles:1}, {noWorld:1}, {noRock:1,noFog:1,noTiles:1}];
const browser = await chromium.launch();
for (const cfg of cfgs) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript((c) => { globalThis.__DBG = c; }, cfg);
  await page.goto(url, { waitUntil: "networkidle" });
  const probe = () => page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now()-t0)/1000))); };
    requestAnimationFrame(tick);
  }));
  await page.waitForTimeout(1000);
  await page.mouse.click(640, 360); await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__scene && window.__scene() === "explore", null, { timeout: 15000 });
  await page.waitForTimeout(900);
  console.log(JSON.stringify(cfg), "->", await probe());
  await page.close();
}
await browser.close();
