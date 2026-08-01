/**
 * downscale-assets — resample the art `audit-assets.mjs` calls oversized down
 * to the size it is actually drawn at, and rewrite the manifests to match.
 *
 * The audit (`npm run audit`) grades every id against `RENDER_BUDGET`: the
 * largest on-screen box that id is ever drawn into, in design px. The stage
 * renders at up to 2× design, so 2× budget is right-sized. This script owns
 * the other half of that contract — the TARGET each namespace is stored at:
 *
 *     namespace      drawn at   stored     target   why
 *     item: equip:      54 px   512²   →    128²    2.4× the 108 px it needs
 *     skill:            44 px   512²   →    128²    ART 44 tiles, 1.5× spare
 *     status:           16 px   256²   →     64²    chip glyphs, 2× spare
 *     bestiary:        148 px   512²   →    320²    the big ??? tile
 *     portrait:         88 px   320²   →    192²    avatar() tops out at 88
 *     node: prop:       84 px   256²   →    192²    medallions + chest emblem
 *     town:             76 px   256²   →    192²    cat-town map marks
 *
 * Everything else already lands inside its budget and is NOT touched: the
 * battle sprites (cat/enemy/boss ≈ 650-900²) draw into 330-510 px frames, the
 * 1600×900 webp backdrops cover a 1280×720 stage, `title:hero` is 1792 wide
 * for a 1280 box, `npc:peddler` is 384² for a 176 px box.
 *
 * Resampling runs inside Playwright's chromium — the same "canvas is the only
 * codec we have without adding a dependency" trick `trim-sprites.mjs` uses.
 * Quality comes from PROGRESSIVE HALVING: one 512→128 `drawImage` is a sparse
 * sample that eats thin strokes and stipple, so we halve (512→256→128) with
 * `imageSmoothingQuality = "high"` at each step, which is a proper box-filter
 * chain. Each file keeps its own container — PNG stays PNG (lossless, alpha
 * intact, no new generation loss); the six `town:*` marks are the only webp
 * in the oversized set and are re-encoded webp at q=0.92, which for a 192²
 * decorative map mark is indistinguishable and still smaller than the 256².
 *
 * IDEMPOTENT: a file already at or below its target is skipped, so re-running
 * after new art lands only touches the new art.
 *
 * Run:  node scripts/downscale-assets.mjs
 *       node scripts/downscale-assets.mjs --dry-run
 *       node scripts/downscale-assets.mjs --backup /tmp/art-before
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEN = path.join(ROOT, "public/assets/gen");
const MANIFEST_DIRS = ["", "env/", "items/", "scenes/"];

/** Longest matching prefix wins. See the table in the header comment. */
const TARGETS = [
  ["item:", 128],
  ["equip:", 128],
  ["skill:", 128],
  ["status:", 64],
  ["bestiary:", 320],
  ["portrait:", 192],
  ["node:", 192],
  ["prop:", 192],
  ["town:", 192],
];

function targetFor(id) {
  let best = null;
  for (const [prefix, px] of TARGETS) {
    if (id.startsWith(prefix) && (!best || prefix.length > best[0].length)) {
      best = [prefix, px];
    }
  }
  return best === null ? null : best[1];
}

/**
 * Runs INSIDE the page. Halves with high-quality smoothing while a half still
 * overshoots, then lands exactly on `target`. Returns base64 PNG + real dims.
 */
const resampleInPage = async ([dataUrl, target, mime]) => {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const step = (dw, dh, from) => {
    const c = new OffscreenCanvas(dw, dh);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(from, 0, 0, dw, dh);
    return c;
  };
  let w = img.width;
  let h = img.height;
  let src = img;
  while (Math.floor(w / 2) >= target && Math.floor(h / 2) >= target) {
    w = Math.floor(w / 2);
    h = Math.floor(h / 2);
    src = step(w, h, src);
  }
  const scale = target / Math.max(w, h);
  const fw = Math.max(1, Math.round(w * scale));
  const fh = Math.max(1, Math.round(h * scale));
  const out = fw === w && fh === h ? src : step(fw, fh, src);
  const blob = await out.convertToBlob({ type: mime, quality: 0.92 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return { png: btoa(s), w: fw, h: fh };
};

/** Pixel dimensions from a PNG or WebP header — same parser as the audit. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (
    buf.length > 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const tag = buf.toString("ascii", 12, 16);
    if (tag === "VP8X") {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (tag === "VP8 ") {
      return {
        w: buf.readUInt16LE(26) & 0x3fff,
        h: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (tag === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

const MIME = { ".png": "image/png", ".webp": "image/webp" };
const mib = (n) => (n / 1048576).toFixed(2);

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry-run");
  const bi = argv.indexOf("--backup");
  const backup = bi >= 0 ? (argv[bi + 1] ?? null) : null;

  const manifests = [];
  for (const dir of MANIFEST_DIRS) {
    const p = path.join(GEN, dir, "manifest.json");
    manifests.push({
      dir,
      path: p,
      text: await readFile(p, "utf8"),
      data: JSON.parse(await readFile(p, "utf8")),
    });
  }

  const jobs = [];
  for (const m of manifests) {
    for (const [id, s] of Object.entries(m.data.sprites)) {
      const target = targetFor(id);
      if (target === null) continue;
      const file = path.join(GEN, m.dir, s.file);
      const mime = MIME[path.extname(file)];
      if (mime === undefined) continue;
      let buf;
      try {
        buf = await readFile(file);
      } catch {
        continue; // the audit reports missing files; this script skips them
      }
      const size = imageSize(buf);
      if (size === null || Math.max(size.w, size.h) <= target) continue;
      jobs.push({
        id,
        s,
        file,
        mime,
        from: `${size.w}×${size.h}`,
        target,
        before: buf.length,
      });
    }
  }

  if (jobs.length === 0) {
    console.log("downscale-assets: nothing to do — every icon is at target.");
    return;
  }

  const beforeBytes = jobs.reduce((n, j) => n + j.before, 0);
  console.log(
    `downscale-assets: ${jobs.length} files, ${mib(beforeBytes)} MiB before`,
  );
  if (dry) {
    for (const j of jobs) {
      console.log(`  ${j.id.padEnd(28)} ${j.from} → ${j.target}²`);
    }
    return;
  }

  if (backup !== null) {
    await mkdir(backup, { recursive: true });
    await cp(GEN, path.join(backup, "gen"), { recursive: true });
    console.log(`  backup: ${path.join(backup, "gen")}`);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let afterBytes = 0;
  for (const j of jobs) {
    const buf = await readFile(j.file);
    const res = await page.evaluate(resampleInPage, [
      `data:${j.mime};base64,${buf.toString("base64")}`,
      j.target,
      j.mime,
    ]);
    const out = Buffer.from(res.png, "base64");
    await writeFile(j.file, out);
    j.s.w = res.w;
    j.s.h = res.h;
    afterBytes += out.length;
    console.log(
      `  ${j.id.padEnd(28)} ${j.from} → ${res.w}×${res.h}  ` +
        `${(j.before / 1024).toFixed(0)} → ${(out.length / 1024).toFixed(0)} KiB`,
    );
  }
  await browser.close();

  for (const m of manifests) {
    // Preserve each manifest's own indentation — items/ ships 1-space, the
    // other three ship 2, and a whole-file reflow would bury the real diff.
    const indent = /^\{\n( +)"/.exec(m.text)?.[1].length ?? 2;
    await writeFile(m.path, JSON.stringify(m.data, null, indent) + "\n");
  }

  const cut = ((beforeBytes - afterBytes) / beforeBytes) * 100;
  console.log(
    `\n  ${mib(beforeBytes)} MiB → ${mib(afterBytes)} MiB  (−${cut.toFixed(1)}%)`,
  );
}

await main();
