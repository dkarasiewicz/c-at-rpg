import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto("http://localhost:5188/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.mouse.click(640, 360); await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__scene() === "explore", null, { timeout: 15000 });
await page.waitForTimeout(900);
// Esc -> pause overlay
await page.keyboard.press("Escape"); await page.waitForTimeout(400);
console.log("esc -> overlay:", await page.evaluate(() => window.__overlay()));
await page.keyboard.press("Escape"); await page.waitForTimeout(400);
console.log("esc again -> overlay:", await page.evaluate(() => window.__overlay()), "scene:", await page.evaluate(() => window.__scene()));
// click-to-path inside the viewport
const before = await page.evaluate(() => JSON.stringify(window.__run().floor.party));
await page.mouse.click(430, 250); await page.waitForTimeout(1800);
const after = await page.evaluate(() => JSON.stringify(window.__run().floor.party));
console.log("click-to-path", before, "->", after, before !== after ? "MOVED" : "no move");
// belt chip hover/tooltip + card click (target pick)
await page.mouse.move(1049, 689); await page.waitForTimeout(300);
await page.mouse.click(1049, 689); await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/explore-pick.png" });
await page.keyboard.press("Escape"); await page.waitForTimeout(300);
console.log("after pick-esc scene:", await page.evaluate(() => window.__scene()), "overlay:", await page.evaluate(() => window.__overlay()));
console.log(errors.length ? errors.join("\n") : "no errors");
await browser.close();
