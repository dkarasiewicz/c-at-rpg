/**
 * gen-node-medallions — regenerate the run-map `node:*` emblem set.
 *
 * Why (docs/design/run-map-and-dm.md — "a route is a legible gamble"): the
 * first `node:*` batch was generated as ONE pewter/purple family, so at board
 * scale FIGHT, TREASURE, ELITE and BOSS were near-identical discs and the
 * type-coloured rim + caption were carrying all of the meaning. The
 * ILLUSTRATION has to carry it.
 *
 * So this batch is prompted as a deliberately CONTRASTING family, on three
 * axes at once:
 *   · SILHOUETTE — one unmistakable shape per type, filling the disc.
 *   · HUE        — a different dominant colour per type, none of them pewter.
 *   · VALUE      — some emblems are light-on-dark, some dark-on-light, so the
 *                  set survives desaturation (the acceptance test is: greyscale
 *                  them, shrink to 66 px, and they must still be tellable
 *                  apart — see scripts/check-node-legibility.mjs).
 *
 * Prompts are composed from src/content/artStyle.ts so the set stays inside
 * the style bible. Emblems are generated WITHOUT a metal bezel: the run map
 * draws its own type-coloured rim and caption on top as reinforcement.
 *
 * Run:  node scripts/gen-node-medallions.mjs            (generate + wait)
 *       node scripts/gen-node-medallions.mjs --prompts  (print prompts only)
 * Downloads land in assets-src/nodes/; scripts/key-node-medallions.mjs turns
 * them into the keyed, masked 256² PNGs under public/assets/gen/env/.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets-src/nodes");
const MASONRY = `${process.env.HOME}/.local/bin/masonry`;
const MODEL = "gemini-3-pro-image-preview";

/** Mirrors ART_STYLE.basePrompt / .negative (src/content/artStyle.ts v1). */
const BASE =
  "Anime cel-shading with bold ink outlines, dramatic rim light, gritty " +
  "90s OVA flavor. Rich saturated color.";
const NEGATIVE =
  "chibi, pixel art, flat vector art, photorealism, 3D render, soft " +
  "airbrush shading, gradient background, watermark, signature, text, " +
  "caption, letters, numbers, frame, border, blurry, pewter, metal bezel, " +
  "ornate filigree ring, small fussy details, busy background, multiple " +
  "panels, grid of images";

/** Every emblem shares this framing so the set is one family of shapes. */
const FRAMING =
  "A single circular game-map emblem, filling 96% of a square image, centred, " +
  "on a flat #1a1626 background outside the circle. The emblem is ONE bold " +
  "graphic silhouette, poster-like, drawn thick and simple so it stays " +
  "instantly readable when shrunk to 64 pixels wide. No metal bezel, no " +
  "decorative ring, no border, no text of any kind. Extreme contrast between " +
  "the shape and the disc behind it.";

/**
 * Per type: subject silhouette, dominant hue, and the VALUE polarity that
 * keeps the set separable in greyscale.
 */
export const NODE_PROMPTS = {
  fight:
    "The disc is deep blood crimson. On it, three bone-pale slashing claw " +
    "marks tearing diagonally across the whole disc, plus two crossed cat " +
    "claws. Very light shape on a dark red disc.",
  elite:
    "The disc is bright molten gold, almost glowing. On it, a heavy black " +
    "spiked crown in stark silhouette, wide and squat, filling the disc. " +
    "Dark shape on a LIGHT disc — inverted against the rest of the set.",
  boss:
    "The disc is near-black charcoal with a faint violet ember glow. On it, " +
    "a huge chalk-white snarling dog skull, front-on, jaws wide, filling the " +
    "entire disc. Maximum black-and-white contrast, the darkest emblem of " +
    "the set.",
  treasure:
    "The disc is deep teal. On it, a heaped pile of bright warm-yellow gold " +
    "coins and a spilled jewel, a broad low triangular mound of round shapes " +
    "along the bottom two thirds. Bright warm clutter on a cool dark disc.",
  rest:
    "The disc is pale sage green, soft and light. On it, a dark navy " +
    "silhouette of a cat curled into a perfect sleeping circle on a cushion, " +
    "one closed crescent eye. Dark rounded shape on a LIGHT disc, calm and " +
    "simple.",
  shop:
    "A PERFECT CIRCLE, not a square: the round disc is dark umber brown and " +
    "everything outside its circular edge is flat #1a1626. On the disc, a " +
    "tall pale cyan hooded merchant figure seen front-on, face in shadow " +
    "under a deep pointed hood, arms spread holding out wares — a tall " +
    "narrow vertical silhouette unlike any other emblem in the set.",
  event:
    "The disc is deep indigo. On it, one enormous hot-magenta question-mark " +
    "hook shape, hand-painted and slightly crooked, filling the whole disc, " +
    "trailing a few sparks. A single bright curling stroke on a dark disc.",
};

export const promptFor = (type) =>
  `${FRAMING} ${NODE_PROMPTS[type]} ${BASE} Avoid: ${NEGATIVE}.`;

if (process.argv.includes("--prompts")) {
  for (const t of Object.keys(NODE_PROMPTS))
    console.log(`\n## ${t}\n${promptFor(t)}`);
  process.exit(0);
}

await mkdir(OUT, { recursive: true });
const types = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = types.length > 0 ? types : Object.keys(NODE_PROMPTS);
const ids = [];
for (const t of wanted) {
  const { stdout } = await exec(MASONRY, [
    "image",
    promptFor(t),
    "--model",
    MODEL,
    "--aspect",
    "1:1",
    "--title",
    `node ${t} emblem`,
  ]);
  const id = JSON.parse(stdout).job_id;
  console.log(`${t.padEnd(10)} -> ${id}`);
  ids.push([t, id]);
}

// one file per job, named by job id — download each to its type name instead
for (const [t, id] of ids) {
  await exec(
    MASONRY,
    ["job", "wait", id, "--timeout", "10m", "--download", "-o",
     path.join(OUT, `${t}.png`)],
    { maxBuffer: 1 << 26 },
  );
  console.log(`downloaded ${t}.png`);
}
console.log(`\nall emblems in ${OUT}`);
