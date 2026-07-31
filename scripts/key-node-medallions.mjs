/**
 * key-node-medallions — turn the raw Masonry emblems in `assets-src/nodes/`
 * into the keyed 256² `node:*` PNGs the run map loads.
 *
 * The generator returns a coloured disc on a flat dark field. Rather than a
 * colour chroma-key (the emblems are deliberately every hue, and BOSS is a
 * dark disc on a dark field), this keys GEOMETRICALLY: it measures the disc's
 * radius by radial scan against the corner colour, then masks to that circle
 * with a 1px feather. The run map draws its own type-coloured rim and caption
 * over the result, so nothing here bakes in a bezel.
 *
 * Also writes the acceptance test: docs/art/node-legibility.png — every emblem
 * at board scale (66 px) and again desaturated. If the greyscale row is not
 * tellable apart, the set is not done (docs/design/run-map-and-dm.md).
 *
 * Run: node scripts/key-node-medallions.mjs
 */
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "assets-src/nodes");
const OUT = path.join(ROOT, "public/assets/gen/env");
const MANIFEST = path.join(OUT, "manifest.json");
const REPORT = path.join(ROOT, "docs/art/node-legibility.png");

const TYPES = ["fight", "elite", "boss", "treasure", "shop", "rest", "event"];
const SIZE = 256;

async function keyInPage(dataUrl, size) {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const W = img.width;
  const H = img.height;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const at = (x, y) => {
    const i = (((y | 0) * W + (x | 0)) | 0) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };

  // background = mean of the four corner patches
  let br = 0,
    bg = 0,
    bb = 0,
    nb = 0;
  for (const [ox, oy] of [
    [0, 0],
    [W - 12, 0],
    [0, H - 12],
    [W - 12, H - 12],
  ]) {
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++) {
        const [r, g, b] = at(ox + x, oy + y);
        br += r;
        bg += g;
        bb += b;
        nb++;
      }
  }
  br /= nb;
  bg /= nb;
  bb /= nb;

  // radial scan: outermost radius per ray whose pixel differs from the field
  const cx = W / 2,
    cy = H / 2,
    rMax = Math.min(W, H) / 2;
  const hits = [];
  for (let k = 0; k < 360; k++) {
    const a = (k * Math.PI) / 180;
    const dx = Math.cos(a),
      dy = Math.sin(a);
    let found = 0;
    for (let r = rMax - 1; r > rMax * 0.55; r -= 1) {
      const [pr, pg, pb] = at(cx + dx * r, cy + dy * r);
      if (Math.abs(pr - br) + Math.abs(pg - bg) + Math.abs(pb - bb) > 40) {
        found = r;
        break;
      }
    }
    if (found) hits.push(found);
  }
  hits.sort((a, b) => a - b);
  // high percentile: robust against a few rays catching an ink flourish that
  // pokes outside the disc, and against rays that find nothing
  const radius =
    hits.length > 0 ? hits[Math.floor(hits.length * 0.88)] : rMax * 0.94;

  const out = new OffscreenCanvas(size, size);
  const octx = out.getContext("2d");
  const s = size / (radius * 2);
  octx.save();
  octx.beginPath();
  octx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  octx.clip();
  octx.drawImage(
    c,
    cx - radius,
    cy - radius,
    radius * 2,
    radius * 2,
    0,
    0,
    size,
    size,
  );
  octx.restore();

  const blob = await out.convertToBlob({ type: "image/png" });
  const u = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return { b64: btoa(bin), radius: Math.round(radius), src: W, scale: +s.toFixed(3) };
}

async function reportInPage(urls, labels) {
  const CELL = 120;
  const c = new OffscreenCanvas(urls.length * CELL, CELL * 2 + 24);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1a1626";
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < urls.length; i++) {
    const bm = await createImageBitmap(await (await fetch(urls[i])).blob());
    ctx.filter = "none";
    ctx.drawImage(bm, i * CELL + 27, 16, 66, 66);
    ctx.filter = "grayscale(100%)";
    ctx.drawImage(bm, i * CELL + 27, CELL + 8, 66, 66);
    ctx.filter = "none";
    ctx.fillStyle = "#8b7fa8";
    ctx.font = "13px monospace";
    ctx.textAlign = "center";
    ctx.fillText(labels[i], i * CELL + 60, CELL * 2 + 12);
  }
  const b = await c.convertToBlob({ type: "image/png" });
  const u = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await page.evaluate(`window.keyInPage = ${keyInPage.toString()}`);
await page.evaluate(`window.reportInPage = ${reportInPage.toString()}`);

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const outUrls = [];
for (const t of TYPES) {
  const buf = await readFile(path.join(SRC, `${t}.png`));
  const res = await page.evaluate(
    ([u, s]) => keyInPage(u, s),
    [`data:image/png;base64,${buf.toString("base64")}`, SIZE],
  );
  const file = `node-${t}.png`;
  await writeFile(path.join(OUT, file), Buffer.from(res.b64, "base64"));
  manifest.sprites[`node:${t}`] = { file, w: SIZE, h: SIZE };
  outUrls.push(`data:image/png;base64,${res.b64}`);
  console.log(`${t.padEnd(10)} disc r=${res.radius}/${res.src / 2} -> ${file}`);
}
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

await writeFile(
  REPORT,
  Buffer.from(
    await page.evaluate(([u, l]) => reportInPage(u, l), [outUrls, TYPES]),
    "base64",
  ),
);
await browser.close();
console.log(`\nlegibility test -> ${REPORT}`);
