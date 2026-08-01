/**
 * trim-sprites — normalise every battle sprite so the CHARACTER, not its
 * Stand aura, decides how big the unit reads on screen.
 *
 * Why this exists (docs/design/visual-v2.md "Pipeline" step 2): the generated
 * battle sprites are 640² frames in which the cat/enemy occupies only 46-93%
 * of the height — the rest is Stand aura. Scaling by TEXTURE height therefore
 * renders a 0.46-tall roomba at half the apparent size of a 0.88-tall crow at
 * the same nominal slot height. Normalising on the SUBJECT box makes apparent
 * size a rule instead of per-sprite luck, and makes every character bigger for
 * free (no regeneration, no resample of the subject).
 *
 * What it does, per sprite:
 *   1. Classifies pixels: `aura` = translucent Stand energy (purple hue band),
 *      `subject` = everything else opaque. The classifier is validated by the
 *      contact sheet this script writes to docs/art/trim-contact.png.
 *   2. Finds the SUBJECT box: largest connected component of the cleaned
 *      subject mask, merged with any nearby component >=6% of its area
 *      (tails, staves, thrown props) — sparks and stray aura specks dropped.
 *   3. Attenuates aura alpha by AURA_ALPHA so the cat wins the silhouette and
 *      the Stand supports it ("the Stand effects are a bit toooo much").
 *   4. Re-frames (crop + transparent pad, NEVER a resample of the subject) so
 *      that in EVERY output texture:
 *          subject top    = SUBJECT_TOP  * frameH
 *          subject bottom = SUBJECT_FOOT * frameH   (the feet / pivot line)
 *          subject centre = 0.5          * frameW
 *      Consumers therefore need no per-sprite metadata: see SPRITE_FRAME in
 *      src/ui/draw/spriteFrame.ts for the two constants and the helper that
 *      turns a desired on-screen character height into scale + feet offset.
 *
 * Source of truth is `assets-src/gen/` — on first run the untrimmed originals
 * are MOVED there and `public/assets/gen/` becomes generated output, so the
 * script is idempotent and re-runnable with different constants.
 *
 * Run:  node scripts/trim-sprites.mjs            (all battle sprites)
 *       node scripts/trim-sprites.mjs cat-bruno  (subset, substring match)
 *
 * Pixel work runs inside Playwright's chromium (already a devDependency) —
 * canvas is the only PNG codec available to us without adding a dependency.
 */
import { chromium } from "playwright";
import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "assets-src/gen");
const PORTRAIT_SRC_DIR = path.join(ROOT, "assets-src/portraits");
const OUT_DIR = path.join(ROOT, "public/assets/gen");
const MANIFEST = path.join(OUT_DIR, "manifest.json");
const CONTACT = path.join(ROOT, "docs/art/trim-contact.png");

/* ---------------------------------------------------------------------- */
/* The framing contract — mirrored by src/ui/draw/spriteFrame.ts           */
/* ---------------------------------------------------------------------- */

/** Subject crown sits this far down the output frame. */
const SUBJECT_TOP = 0.3;
/** Subject feet (the ground pivot) sit this far down the output frame. */
const SUBJECT_FOOT = 0.9;
/** Aura alpha multiplier — the Stand supports the cat, it does not eat it. */
const AURA_ALPHA = 0.5;
/** Widest an output frame may be, as a multiple of the subject width. */
const MAX_W_RATIO = 1.9;
/** A subject wider than this multiple of its height is framed as if taller. */
const ASPECT_CAP = 1.1;
/** Cap on output frame height; larger frames are downscaled to fit. */
const MAX_FRAME_H = 900;

/** Portrait crop: extra margin around the face box, and output side length. */
const PORTRAIT_PAD = 0.14;
/**
 * 192, not 320: `avatar()` never draws a portrait into a box bigger than
 * 88 design px (ui/scenes/battleWidgets.ts), and the stage renders at up to
 * 2× design — see the `portrait:` row in `scripts/audit-assets.mjs`. Raising
 * this without raising that budget makes `npm run audit` fail, by design.
 */
const PORTRAIT_SIZE = 192;

/** Which files are battle sprites (title/hero art is left alone). */
const isBattleSprite = (f) => /^(cat|enemy|boss)-.+\.png$/.test(f);
const isPortrait = (f) => /^portrait-.+\.png$/.test(f);

/* ---------------------------------------------------------------------- */

/**
 * Runs inside the browser. Takes a data URL, returns
 * `{ png: dataURL, frame: {w,h}, subject: {x,y,w,h}, source: {w,h}, debug }`.
 */
async function processInPage(dataUrl, cfg) {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const W = img.width;
  const H = img.height;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, W, H);
  const px = id.data;
  const n = W * H;

  // --- 1. classify -----------------------------------------------------
  const aura = new Uint8Array(n);
  const subject = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3];
    if (a <= 128) continue;
    const r = px[i * 4] / 255,
      g = px[i * 4 + 1] / 255,
      b = px[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b),
      d = mx - mn;
    const s = mx > 0 ? d / mx : 0;
    let h = 0;
    if (d > 1e-6) {
      if (mx === r) h = ((g - b) / d + 6) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    if (h >= cfg.hueLo && h <= cfg.hueHi && s > cfg.satMin) aura[i] = 1;
    else subject[i] = 1;
  }

  // --- 2. subject box: morphological open, then connected components ----
  const morph = (src, grow) => {
    const out = new Uint8Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let acc = grow ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx && dy) continue;
            const ny = y + dy,
              nx = x + dx;
            const v =
              ny < 0 || ny >= H || nx < 0 || nx >= W ? 0 : src[ny * W + nx];
            if (grow) acc |= v;
            else acc &= v;
          }
        }
        out[i] = acc;
      }
    }
    return out;
  };
  let clean = subject;
  for (let k = 0; k < 2; k++) clean = morph(clean, false);
  for (let k = 0; k < 2; k++) clean = morph(clean, true);

  const lab = new Int32Array(n);
  const boxes = []; // [area,x0,y0,x1,y1] per label (1-based)
  const stack = new Int32Array(n);
  let cur = 0;
  for (let start = 0; start < n; start++) {
    if (!clean[start] || lab[start]) continue;
    cur++;
    let sp = 0;
    stack[sp++] = start;
    lab[start] = cur;
    let area = 0,
      x0 = W,
      y0 = H,
      x1 = -1,
      y1 = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W,
        y = (i / W) | 0;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && clean[i - 1] && !lab[i - 1]) {
        lab[i - 1] = cur;
        stack[sp++] = i - 1;
      }
      if (x < W - 1 && clean[i + 1] && !lab[i + 1]) {
        lab[i + 1] = cur;
        stack[sp++] = i + 1;
      }
      if (y > 0 && clean[i - W] && !lab[i - W]) {
        lab[i - W] = cur;
        stack[sp++] = i - W;
      }
      if (y < H - 1 && clean[i + W] && !lab[i + W]) {
        lab[i + W] = cur;
        stack[sp++] = i + W;
      }
    }
    boxes.push([area, x0, y0, x1, y1]);
  }

  let sx0, sy0, sx1, sy1;
  if (boxes.length === 0) {
    // No subject at all (a wholly purple creature) — fall back to the alpha
    // box and skip attenuation entirely.
    sx0 = 0;
    sy0 = 0;
    sx1 = W - 1;
    sy1 = H - 1;
    aura.fill(0);
  } else {
    boxes.sort((a, b) => b[0] - a[0]);
    const [ba, bx0, by0, bx1, by1] = boxes[0];
    sx0 = bx0;
    sy0 = by0;
    sx1 = bx1;
    sy1 = by1;
    const padx = (bx1 - bx0) * 0.06,
      pady = (by1 - by0) * 0.06;
    for (let k = 1; k < boxes.length; k++) {
      const [a2, x0b, y0b, x1b, y1b] = boxes[k];
      if (a2 < ba * 0.06) continue;
      if (x0b > bx1 + padx || x1b < bx0 - padx) continue;
      if (y0b > by1 + pady || y1b < by0 - pady) continue;
      sx0 = Math.min(sx0, x0b);
      sy0 = Math.min(sy0, y0b);
      sx1 = Math.max(sx1, x1b);
      sy1 = Math.max(sy1, y1b);
    }
  }
  const subW = sx1 - sx0 + 1;
  const subH = sy1 - sy0 + 1;

  // --- 3. attenuate the aura (soft factor map, no hard seam) -----------
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = aura[i] ? cfg.auraAlpha : 1;
  const blur = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0,
        w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy,
            nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          s += f[ny * W + nx];
          w++;
        }
      }
      blur[y * W + x] = s / w;
    }
  }
  for (let i = 0; i < n; i++) px[i * 4 + 3] = Math.round(px[i * 4 + 3] * blur[i]);
  ctx.putImageData(id, 0, 0);

  // --- 4a. portraits: a HUD avatar is 40-48px, so the face has to own the
  // frame. Same classifier, different framing: square crop hugging the
  // subject (head + shoulders), aura only as a margin.
  if (cfg.mode === "portrait") {
    const cx = sx0 + subW / 2;
    const cy = sy0 + subH / 2;
    const side = Math.max(subW, subH) * (1 + cfg.portraitPad);
    const size = cfg.portraitSize;
    const p = new OffscreenCanvas(size, size);
    const pctx = p.getContext("2d");
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(c, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
    const pb = await p.convertToBlob({ type: "image/png" });
    const pu = new Uint8Array(await pb.arrayBuffer());
    let ps = "";
    for (let i = 0; i < pu.length; i += 0x8000)
      ps += String.fromCharCode.apply(null, pu.subarray(i, i + 0x8000));
    return {
      b64: btoa(ps),
      frame: { w: size, h: size },
      source: { w: W, h: H },
      subject: { x: 0, y: 0, w: size, h: size },
      srcSubjectFrac: +(subH / H).toFixed(3),
      aspect: +(subW / subH).toFixed(2),
    };
  }

  // --- 4. re-frame -----------------------------------------------------
  const span = cfg.foot - cfg.top; // subject height as a fraction of the frame
  // Normalising on raw height alone makes a WIDE, FLAT subject enormous: the
  // roomba scout is 407×293, so matching its height to a rat's makes it 1.4x
  // wider than anything else on the field. Frame such subjects as if they were
  // `subW / aspectCap` tall, which shrinks them back into their size grade
  // while still planting their feet on the pivot line.
  const nominalH = Math.max(subH, subW / cfg.aspectCap);
  const frameH = Math.round(nominalH / span);
  // frame is symmetric about the subject centre so anchor.x = 0.5 lands on the
  // character; wide enough for the aura, capped so a stray wisp cannot double
  // the texture.
  const cxS = sx0 + subW / 2;
  const auraReach = Math.max(cxS, W - cxS) * 2;
  const frameW = Math.round(
    Math.min(subW * cfg.maxWRatio, Math.max(subW * 1.2, auraReach)),
  );

  // anchor on the FEET, not the crown, so a subject shrunk by the aspect clamp
  // still stands on the pivot line
  const topY = sy1 + 1 - cfg.foot * frameH; // source y that maps to output y=0
  const leftX = cxS - frameW / 2;

  const out = new OffscreenCanvas(frameW, frameH);
  const octx = out.getContext("2d");
  octx.drawImage(c, -leftX, -topY);

  let final = out;
  let scaleDown = 1;
  if (frameH > cfg.maxFrameH) {
    scaleDown = cfg.maxFrameH / frameH;
    const fw = Math.round(frameW * scaleDown),
      fh = Math.round(frameH * scaleDown);
    final = new OffscreenCanvas(fw, fh);
    const fctx = final.getContext("2d");
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(out, 0, 0, fw, fh);
  }

  const blob = await final.convertToBlob({ type: "image/png" });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));

  return {
    b64: btoa(bin),
    frame: { w: final.width, h: final.height },
    source: { w: W, h: H },
    subject: {
      x: Math.round((sx0 - leftX) * scaleDown),
      y: Math.round((sy0 - topY) * scaleDown),
      w: Math.round(subW * scaleDown),
      h: Math.round(subH * scaleDown),
    },
    srcSubjectFrac: +(subH / H).toFixed(3),
    aspect: +(subW / subH).toFixed(2),
  };
}

/* ---------------------------------------------------------------------- */

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

// First run: the untrimmed originals become the source of truth.
if (!existsSync(SRC_DIR)) {
  await mkdir(SRC_DIR, { recursive: true });
  const files = (await readdir(OUT_DIR)).filter(isBattleSprite);
  for (const f of files)
    await rename(path.join(OUT_DIR, f), path.join(SRC_DIR, f));
  console.log(`seeded ${SRC_DIR} with ${files.length} originals`);
}

// Portraits get the same treatment on a different frame: seeded once, then
// re-cropped square around the face so a 40px HUD avatar is a CAT, not a
// purple smudge with a cat somewhere in the middle.
if (!existsSync(PORTRAIT_SRC_DIR)) {
  await mkdir(PORTRAIT_SRC_DIR, { recursive: true });
  const p = (await readdir(OUT_DIR)).filter(isPortrait);
  for (const f of p)
    await rename(path.join(OUT_DIR, f), path.join(PORTRAIT_SRC_DIR, f));
  console.log(`seeded ${PORTRAIT_SRC_DIR} with ${p.length} portraits`);
}

const match = (f) => only.length === 0 || only.some((o) => f.includes(o));
const files = (await readdir(SRC_DIR)).filter(isBattleSprite).filter(match).sort();
const portraits = (await readdir(PORTRAIT_SRC_DIR))
  .filter(isPortrait)
  .filter(match)
  .sort();

const cfg = {
  hueLo: 245,
  hueHi: 330,
  satMin: 0.18,
  auraAlpha: AURA_ALPHA,
  top: SUBJECT_TOP,
  foot: SUBJECT_FOOT,
  maxWRatio: MAX_W_RATIO,
  maxFrameH: MAX_FRAME_H,
  aspectCap: ASPECT_CAP,
  portraitPad: PORTRAIT_PAD,
  portraitSize: PORTRAIT_SIZE,
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
// the pixel kernel above is written as a Node function purely so it reads as
// normal source; it only ever runs inside the page.
await page.evaluate(`window.processInPage = ${processInPage.toString()}`);

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const rows = [];

for (const file of files) {
  const buf = await readFile(path.join(SRC_DIR, file));
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const res = await page.evaluate(
    ([u, c]) => processInPage(u, c),
    [dataUrl, cfg],
  );
  await writeFile(path.join(OUT_DIR, file), Buffer.from(res.b64, "base64"));

  const id = file.replace(/\.png$/, "").replace(/^(cat|enemy|boss)-/, "$1:");
  const entry = manifest.sprites[id];
  if (entry) {
    entry.w = res.frame.w;
    entry.h = res.frame.h;
    entry.subject = res.subject;
  }
  rows.push({ file, ...res.frame, srcFrac: res.srcSubjectFrac, id });
  console.log(
    `${file.padEnd(26)} src ${res.source.w}x${res.source.h} subj/H ${res.srcSubjectFrac} -> frame ${res.frame.w}x${res.frame.h}`,
  );
}

for (const file of portraits) {
  const buf = await readFile(path.join(PORTRAIT_SRC_DIR, file));
  const res = await page.evaluate(
    ([u, c]) => processInPage(u, c),
    [
      `data:image/png;base64,${buf.toString("base64")}`,
      { ...cfg, mode: "portrait" },
    ],
  );
  await writeFile(path.join(OUT_DIR, file), Buffer.from(res.b64, "base64"));
  const id = file.replace(/\.png$/, "").replace(/^portrait-/, "portrait:");
  const entry = manifest.sprites[id];
  if (entry) {
    entry.w = res.frame.w;
    entry.h = res.frame.h;
  }
  console.log(
    `${file.padEnd(26)} face crop -> ${res.frame.w}x${res.frame.h} (was ${res.source.w}x${res.source.h})`,
  );
}

manifest.spriteFrame = {
  subjectTop: SUBJECT_TOP,
  subjectFoot: SUBJECT_FOOT,
  note: "battle sprites are normalised so the SUBJECT (not the aura) spans [subjectTop, subjectFoot] of the frame height, centred horizontally; see src/ui/draw/spriteFrame.ts",
};
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

// contact sheet so the classifier stays auditable by eye
const cols = 7;
const rowsN = Math.ceil(files.length / cols);
const sheet = await page.evaluate(
  async ([urls, cols, rowsN]) => {
    const CELL = 200;
    const c = new OffscreenCanvas(cols * CELL, rowsN * CELL);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1a1626";
    ctx.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < urls.length; i++) {
      const bm = await createImageBitmap(await (await fetch(urls[i])).blob());
      const s = Math.min(CELL / bm.width, CELL / bm.height);
      const w = bm.width * s,
        h = bm.height * s;
      ctx.drawImage(
        bm,
        (i % cols) * CELL + (CELL - w) / 2,
        ((i / cols) | 0) * CELL + (CELL - h),
        w,
        h,
      );
    }
    const b = await c.convertToBlob({ type: "image/png" });
    const u = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  },
  [
    await Promise.all(
      files.map(async (f) => {
        const b = await readFile(path.join(OUT_DIR, f));
        return `data:image/png;base64,${b.toString("base64")}`;
      }),
    ),
    cols,
    rowsN,
  ],
);
await writeFile(CONTACT, Buffer.from(sheet, "base64"));

await browser.close();
console.log(`\n${rows.length} sprites trimmed; contact sheet -> ${CONTACT}`);
