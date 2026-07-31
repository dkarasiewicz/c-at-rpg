import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch();
const out = [];
for (let r = 0; r < 3; r++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.mouse.click(640, 360); await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  out.push(await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now()-t0)/1000))); };
    requestAnimationFrame(tick);
  })));
  await page.close();
}
console.log(url, out.join(","));
await browser.close();
