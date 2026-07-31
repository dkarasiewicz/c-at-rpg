/**
 * make-logo — turn a raw Masonry emblem into the game's logo and app icons.
 *
 * The generator returns the emblem on a flat dark field. This keys it the same
 * way the sprite pipeline does — estimate the background from the border ring,
 * flood-fill inward from the edges only (so dark pixels INSIDE the emblem
 * survive), then a soft alpha ramp so the edge is not a staircase — trims to
 * the alpha bounding box, and emits every size the game and the PWA need.
 *
 * Uses a headless canvas rather than a native image library, matching
 * scripts/key-node-medallions.mjs, so the repo needs no binary dependency.
 *
 * Run: node scripts/make-logo.mjs <source.png>
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/make-logo.mjs <source.png>");
  process.exit(2);
}

const OUTPUTS = [
  { file: "public/assets/gen/title-logo.png", size: 512 },
  { file: "public/icons/icon-192.png", size: 192 },
  { file: "public/icons/icon-512.png", size: 512 },
  { file: "public/icons/icon-maskable.png", size: 512, padding: 0.18 },
  { file: "public/favicon.png", size: 64 },
];

const dataUrl = `data:image/png;base64,${(await readFile(src)).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const results = await page.evaluate(
  async ({ dataUrl, outputs }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, w, h);
    const px = id.data;

    // --- background estimate: median of the 4px border ring ---------------
    const ring = [[], [], []];
    const sample = (x, y) => {
      const i = (y * w + x) * 4;
      ring[0].push(px[i]);
      ring[1].push(px[i + 1]);
      ring[2].push(px[i + 2]);
    };
    for (let x = 0; x < w; x++) for (let d = 0; d < 4; d++) { sample(x, d); sample(x, h - 1 - d); }
    for (let y = 0; y < h; y++) for (let d = 0; d < 4; d++) { sample(d, y); sample(w - 1 - d, y); }
    const med = ring.map((ch) => ch.sort((a, b) => a - b)[ch.length >> 1]);

    const dist = (i) => {
      const dr = px[i] - med[0], dg = px[i + 1] - med[1], db = px[i + 2] - med[2];
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };

    // --- border-only flood fill (dark pixels inside the art survive) -------
    const TOL = 26, RAMP = 40;
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, x + (h - 1) * w); }
    for (let y = 0; y < h; y++) { stack.push(y * w, w - 1 + y * w); }
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      const i = p * 4;
      if (dist(i) > TOL) continue;
      seen[p] = 1;
      const x = p % w, y = (p / w) | 0;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
    // soft ramp: fully clear in the fill, feathered just outside it
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (seen[p]) px[i + 3] = 0;
      else {
        const d = dist(i);
        if (d < RAMP) px[i + 3] = Math.round(255 * (d / RAMP));
      }
    }
    ctx.putImageData(id, 0, 0);

    // --- trim to the alpha bounding box ------------------------------------
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (px[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    const tw = x1 - x0 + 1, th = y1 - y0 + 1;

    const out = {};
    for (const o of outputs) {
      const pad = o.padding ?? 0;
      const s = o.size;
      const inner = Math.round(s * (1 - pad * 2));
      const scale = Math.min(inner / tw, inner / th);
      const dw = Math.round(tw * scale), dh = Math.round(th * scale);
      const oc = document.createElement("canvas");
      oc.width = s;
      oc.height = s;
      const octx = oc.getContext("2d");
      octx.imageSmoothingQuality = "high";
      octx.drawImage(c, x0, y0, tw, th, (s - dw) >> 1, (s - dh) >> 1, dw, dh);
      out[o.file] = oc.toDataURL("image/png");
    }
    return { out, trimmed: [tw, th] };
  },
  { dataUrl, outputs: OUTPUTS },
);

await browser.close();

for (const [file, url] of Object.entries(results.out)) {
  const abs = path.join(ROOT, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(url.split(",")[1], "base64"));
  console.log("wrote", file);
}
console.log("trimmed source to", results.trimmed.join("x"));

// --- register the logo in the root manifest --------------------------------
const MF = path.join(ROOT, "public/assets/gen/manifest.json");
const mf = JSON.parse(await readFile(MF, "utf8"));
mf.sprites["title:logo"] = { file: "title-logo.png", w: 512, h: 512 };
await writeFile(MF, `${JSON.stringify(mf, null, 2)}\n`);
console.log("registered title:logo in", path.relative(ROOT, MF));
