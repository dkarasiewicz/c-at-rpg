/**
 * audit-assets — the reproducible generated-art audit.  `npm run audit`
 *
 * Cross-references the FOUR sprite manifests
 * (`public/assets/gen/{,env/,items/,scenes/}manifest.json`) against every
 * reference in `src/` and `agent/`, and reports five classes of rot:
 *
 *   1. UNREFERENCED   a declared id no code path can ever ask for
 *   2. MISSING        a declared id whose file is not on disk (or whose
 *                     declared w/h disagrees with the actual pixels)
 *   3. ORPHAN         a file under public/assets/gen/** no manifest declares
 *   4. DUPLICATE      an id declared twice, or two ids sharing one file
 *   5. OVERSIZED      art stored far larger than the biggest box it is ever
 *                     drawn into
 *
 * ── WHY THE NAIVE VERSION IS WRONG ──────────────────────────────────────
 * Most sprite ids are NEVER written out in full. They are built from a
 * prefix at the call site:
 *
 *     spriteTextureFor(`enemy:${speciesId}`)      ui/sprites.ts
 *     makeSpriteIcon(`item:${item.defId}`, 22)    scenes/battle.ts
 *     sceneBackdrop(`scene:map:${floorNum}`, …)   scenes/runMap.ts
 *     iconTile(`skill:${skillId}`, ART)           overlays/progressPanel.ts
 *     spriteTextureFor(`equip:${art}`)            overlays/inventoryPanel.ts
 *
 * A grep for the literal id `"scene:map:3"` finds nothing, and an audit that
 * stops there condemns live art — an earlier pass over this repo declared 32
 * shipping assets dead exactly that way. So this script extracts the STATIC
 * HEAD of every template literal (`` `scene:map:${n}` `` → `scene:map:`) and
 * treats it as a wildcard that covers every declared id beneath it. Plain
 * `"cat:"`-style literals count too, because `id.startsWith("cat:")` and
 * `"item:" + defId` are the same construction with different syntax.
 *
 * Consequence, stated plainly: this audit CANNOT prove an individual
 * `skill:*` id dead, because `skill:${id}` covers the whole namespace. It
 * can only prove a whole NAMESPACE dead. That is the honest limit, and it
 * is the right one — an id under a live prefix is reachable the moment the
 * content table names it.
 *
 * ── THE OVERSIZE RULE ───────────────────────────────────────────────────
 * `RENDER_BUDGET` records, per id prefix, the largest on-screen box the art
 * is ever drawn into, in design px on the 1280×720 stage, WITH the call site
 * that sets it. The canvas renders at up to 2× design, so 2× budget is
 * "right-sized" and anything past 3× is waste. Those call-site numbers are
 * not taken on faith: `SOURCE_CHECKS` re-reads each constant out of the
 * source and fails the audit if one moved without this table moving with it.
 *
 * Node-only, zero dependencies (PNG/WebP headers are parsed inline).
 *
 * Usage:
 *   node scripts/audit-assets.mjs           human report, exit 1 on findings
 *   node scripts/audit-assets.mjs --json    machine-readable
 *   node scripts/audit-assets.mjs --quiet   findings only, no OK sections
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GEN = join(ROOT, "public/assets/gen");
/** Manifest directories, relative to `assets/gen/` — mirrors ui/sprites.ts. */
const MANIFEST_DIRS = ["", "env/", "items/", "scenes/"];
/** Everything that may reference a sprite id. */
const CODE_ROOTS = ["src", "agent"];

/** Device-pixel headroom: the stage is rendered at up to 2× design px. */
const DPR_CAP = 2;
/** Stored/budget ratio past which an asset is waste, not headroom. */
const OVERSIZE_FACTOR = 3;
/**
 * The rule stops here. Below 64² a PNG icon is a handful of KiB — shrinking
 * further buys noise and costs real risk, because the smallest boxes in the
 * game are also the ones most likely to grow (`makeStatusChip` takes an
 * `opts.size`, and today's 16 px chip is one design pass from 24). So 64² is
 * a floor, not an exemption: anything ABOVE it is still graded normally.
 */
const MIN_STORED = 64;

/* ---------------------------------------------------------------------- */
/* Render budgets — the biggest box each id is ever drawn into (design px) */
/* ---------------------------------------------------------------------- */

/**
 * Longest-prefix wins, so `title:hero` beats `title:`. Every entry cites the
 * call site that sets it; `SOURCE_CHECKS` below keeps the citations honest.
 */
const RENDER_BUDGET = [
  // Battle sprites: the FRAME is bigger than the character, because the
  // subject only spans SUBJECT_SPAN (0.6) of it — ui/draw/spriteFrame.ts.
  ["cat:", 330, "CAT_HEIGHT 198 ÷ SUBJECT_SPAN 0.6 — ui/draw/spriteFrame.ts"],
  ["enemy:", 387, "UNIT_HEIGHT.large 232 ÷ 0.6 — ui/draw/spriteFrame.ts"],
  ["boss:", 510, "UNIT_HEIGHT.boss 306 ÷ 0.6 — ui/draw/spriteFrame.ts"],
  ["portrait:", 88, "avatar(c.classId, 88) — ui/scenes/battleWidgets.ts"],
  ["title:hero", 1280, "full-bleed sceneBackdrop on DESIGN_W — scenes/title.ts"],
  ["title:logo", 256, "emblem(EMBLEM_H=256) — ui/scenes/boot.ts"],
  ["node:", 84, "R_BOSS 42 × 2 — ui/scenes/runMap.ts"],
  ["prop:", 84, "EMBLEM_SIZE 84 — ui/overlays/loot.ts"],
  ["item:", 54, "CELL 64 − 10 — ui/overlays/inventoryPanel.ts"],
  ["equip:", 54, "CELL 64 − 10 — ui/overlays/inventoryPanel.ts"],
  ["skill:", 44, "ART 44 iconTile — ui/scenes/battleWidgets.ts"],
  ["status:", 16, "makeStatusChip default s=16 — ui/widgets.ts"],
  ["bestiary:", 148, "enemyAvatar(id, 148) bestiary tile — scenes/catTown.ts"],
  ["npc:", 176, 'makeSpriteIcon("npc:peddler", 176) — scenes/landing.ts'],
  ["town:", 76, "MARK_ART 76 — ui/scenes/catTown.ts"],
  // Backdrops cover the 1280×720 design stage; the event set covers the
  // 800-wide event panel (R.event.panel) and is bounded by the stage anyway.
  ["scene:", 1280, "full-bleed sceneBackdrop on DESIGN_W 1280 — ui/widgets.ts"],
];

/**
 * The constants the budgets are quoted from. If one of these moves and the
 * table above does not, the audit fails loudly instead of silently grading
 * against a stale number.
 */
const SOURCE_CHECKS = [
  ["src/ui/draw/spriteFrame.ts", /SUBJECT_TOP\s*=\s*([\d.]+)/, "0.3"],
  ["src/ui/draw/spriteFrame.ts", /SUBJECT_FOOT\s*=\s*([\d.]+)/, "0.9"],
  ["src/ui/draw/spriteFrame.ts", /CAT_HEIGHT\s*=\s*(\d+)/, "198"],
  ["src/ui/draw/spriteFrame.ts", /large:\s*(\d+)/, "232"],
  ["src/ui/draw/spriteFrame.ts", /boss:\s*(\d+)/, "306"],
  ["src/ui/scenes/runMap.ts", /R_BOSS\s*=\s*(\d+)/, "42"],
  ["src/ui/overlays/loot.ts", /EMBLEM_SIZE\s*=\s*(\d+)/, "84"],
  ["src/ui/overlays/inventoryPanel.ts", /const CELL\s*=\s*(\d+)/, "64"],
  ["src/ui/scenes/catTown.ts", /MARK_ART\s*=\s*(\d+)/, "76"],
  ["src/ui/scenes/boot.ts", /EMBLEM_H\s*=\s*(\d+)/, "256"],
  ["src/ui/layout.ts", /DESIGN_W\s*=\s*(\d+)/, "1280"],
];

/* ---------------------------------------------------------------------- */
/* Image headers (no dependencies)                                        */
/* ---------------------------------------------------------------------- */

/** Pixel dimensions of a PNG or WebP, or null for anything else. */
function imageSize(file) {
  const b = readFileSync(file);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (
    b.length > 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    const tag = b.toString("ascii", 12, 16);
    if (tag === "VP8X") {
      return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    }
    if (tag === "VP8 ") {
      return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (tag === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* Inputs                                                                 */
/* ---------------------------------------------------------------------- */

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every declared sprite, flattened across the four manifests. */
function readManifests() {
  const declared = [];
  const problems = [];
  for (const dir of MANIFEST_DIRS) {
    const mf = join(GEN, dir, "manifest.json");
    let data;
    try {
      data = JSON.parse(readFileSync(mf, "utf8"));
    } catch (err) {
      problems.push(`${relative(ROOT, mf)}: unreadable (${err.message})`);
      continue;
    }
    if (data.version !== 1 || typeof data.sprites !== "object") {
      problems.push(`${relative(ROOT, mf)}: not a version-1 sprite manifest`);
      continue;
    }
    for (const [id, s] of Object.entries(data.sprites)) {
      declared.push({
        id,
        dir,
        manifest: `${dir}manifest.json`,
        file: typeof s?.file === "string" ? s.file : "",
        declW: typeof s?.w === "number" ? s.w : null,
        declH: typeof s?.h === "number" ? s.h : null,
        path: join(GEN, dir, typeof s?.file === "string" ? s.file : ""),
      });
    }
  }
  return { declared, problems };
}

/* ---------------------------------------------------------------------- */
/* Reference extraction — literals AND template prefixes                  */
/* ---------------------------------------------------------------------- */

/** `foo:` or `foo:bar:` — the shape a manifest-id prefix can legally take. */
const PREFIX_RE = /^[a-z][A-Za-z0-9]*:(?:[A-Za-z0-9]+:)*$/;
/** A complete id: `foo:bar` / `foo:bar:1`. */
const ID_RE = /^[a-z][A-Za-z0-9]*(?::[A-Za-z0-9]+)+$/;

/**
 * Pull every sprite-id LITERAL and every template-literal PREFIX out of one
 * source file.
 *
 * Quoted strings give literals. Backtick strings give a literal when they
 * hold no `${}` and a PREFIX when they do — the static head up to the first
 * interpolation. A quoted literal that itself ends in `:` is also a prefix
 * (`id.startsWith("cat:")`, `"item:" + defId`).
 */
function extractRefs(src, file, literals, prefixes) {
  const note = (map, key) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(file);
  };

  // Quoted strings — no escapes worth worrying about in these ids.
  for (const m of src.matchAll(/(['"])([^'"\n\\]*)\1/g)) {
    const s = m[2];
    if (ID_RE.test(s)) note(literals, s);
    if (PREFIX_RE.test(s)) note(prefixes, s);
  }

  // Template literals. Non-greedy to the closing backtick; nested templates
  // inside `${}` are rare here and only ever cost us an extra candidate.
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const body = m[1];
    const cut = body.indexOf("${");
    if (cut < 0) {
      if (ID_RE.test(body)) note(literals, body);
      if (PREFIX_RE.test(body)) note(prefixes, body);
      continue;
    }
    const head = body.slice(0, cut);
    if (PREFIX_RE.test(head)) note(prefixes, head);
  }
}

function scanCode() {
  const literals = new Map();
  const prefixes = new Map();
  const files = [];
  for (const root of CODE_ROOTS) {
    for (const f of walk(join(ROOT, root))) {
      if (![".ts", ".tsx", ".mts", ".js", ".mjs"].includes(extname(f))) continue;
      files.push(f);
      extractRefs(readFileSync(f, "utf8"), relative(ROOT, f), literals, prefixes);
    }
  }
  return { literals, prefixes, fileCount: files.length };
}

/* ---------------------------------------------------------------------- */
/* The audit                                                              */
/* ---------------------------------------------------------------------- */

function budgetFor(id) {
  let best = null;
  for (const [prefix, px, source] of RENDER_BUDGET) {
    if (!id.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) {
      best = { prefix, px, source };
    }
  }
  return best;
}

function checkSources() {
  const drift = [];
  for (const [file, re, expected] of SOURCE_CHECKS) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      drift.push(`${file}: gone — RENDER_BUDGET cites it`);
      continue;
    }
    const m = re.exec(text);
    if (!m) drift.push(`${file}: ${re} no longer matches`);
    else if (m[1] !== expected) {
      drift.push(`${file}: ${re.source} is ${m[1]}, RENDER_BUDGET assumes ${expected}`);
    }
  }
  return drift;
}

function audit() {
  const { declared, problems } = readManifests();
  const { literals, prefixes, fileCount } = scanCode();

  const byId = new Map();
  const duplicates = [];
  for (const d of declared) {
    if (byId.has(d.id)) {
      duplicates.push({
        kind: "id",
        id: d.id,
        where: [byId.get(d.id).manifest, d.manifest],
      });
    } else byId.set(d.id, d);
  }
  const byPath = new Map();
  for (const d of declared) {
    const key = relative(ROOT, d.path);
    if (byPath.has(key)) {
      duplicates.push({ kind: "file", file: key, ids: [byPath.get(key), d.id] });
    } else byPath.set(key, d.id);
  }

  // --- reachability -----------------------------------------------------
  const prefixList = [...prefixes.keys()];
  const unreferenced = [];
  const reachedBy = new Map();
  for (const d of declared) {
    if (literals.has(d.id)) {
      reachedBy.set(d.id, { how: "literal", by: d.id, at: [...literals.get(d.id)] });
      continue;
    }
    const hit = prefixList
      .filter((p) => d.id.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) {
      reachedBy.set(d.id, { how: "prefix", by: hit, at: [...prefixes.get(hit)] });
      continue;
    }
    unreferenced.push(d);
  }

  // --- files ------------------------------------------------------------
  const missing = [];
  const wrongSize = [];
  const oversized = [];
  let bytes = 0;
  for (const d of declared) {
    let st;
    try {
      st = statSync(d.path);
    } catch {
      missing.push({ id: d.id, file: relative(ROOT, d.path) });
      continue;
    }
    d.bytes = st.size;
    bytes += st.size;
    const px = imageSize(d.path);
    d.px = px;
    if (!px) continue;
    if (
      (d.declW !== null && d.declW !== px.w) ||
      (d.declH !== null && d.declH !== px.h)
    ) {
      wrongSize.push({
        id: d.id,
        declared: `${d.declW}×${d.declH}`,
        actual: `${px.w}×${px.h}`,
      });
    }
    const b = budgetFor(d.id);
    if (!b) continue;
    const stored = Math.max(px.w, px.h);
    const ratio = stored / b.px;
    if (ratio > OVERSIZE_FACTOR && stored > MIN_STORED) {
      oversized.push({
        id: d.id,
        file: relative(ROOT, d.path),
        stored,
        px: `${px.w}×${px.h}`,
        budget: b.px,
        ratio: Number(ratio.toFixed(1)),
        rightSized: b.px * DPR_CAP,
        bytes: st.size,
        source: b.source,
      });
    }
  }

  // --- orphans ----------------------------------------------------------
  const declaredPaths = new Set(declared.map((d) => relative(ROOT, d.path)));
  const orphans = [];
  let orphanBytes = 0;
  for (const f of walk(GEN)) {
    if (basename(f) === "manifest.json") continue;
    const rel = relative(ROOT, f);
    if (declaredPaths.has(rel)) continue;
    const st = statSync(f);
    orphanBytes += st.size;
    orphans.push({ file: rel, bytes: st.size });
  }

  // --- ids the code asks for that nothing declares ----------------------
  const undeclared = [];
  for (const [id, at] of literals) {
    if (byId.has(id)) continue;
    if (!budgetFor(id)) continue; // not a sprite namespace at all
    undeclared.push({ id, at: [...at] });
  }

  oversized.sort((a, b) => b.bytes - a.bytes);
  orphans.sort((a, b) => b.bytes - a.bytes);

  return {
    declared,
    counts: {
      ids: declared.length,
      files: walk(GEN).filter((f) => basename(f) !== "manifest.json").length,
      sourceFiles: fileCount,
      literals: literals.size,
      prefixes: prefixList.length,
      bytes,
    },
    prefixes: prefixList.sort(),
    manifestProblems: problems,
    sourceDrift: checkSources(),
    unreferenced,
    missing,
    wrongSize,
    duplicates,
    orphans,
    orphanBytes,
    oversized,
    undeclared,
    reachedBy,
  };
}

/* ---------------------------------------------------------------------- */
/* Report                                                                 */
/* ---------------------------------------------------------------------- */

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
const mib = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

function report(a, { quiet }) {
  const out = [];
  const say = (s = "") => out.push(s);
  const section = (title, rows, ok) => {
    if (rows.length === 0) {
      if (!quiet) say(`  OK   ${title} — ${ok}`);
      return;
    }
    say(`  FAIL ${title} — ${rows.length}`);
    for (const r of rows) say(`         ${r}`);
  };

  say("ASSET AUDIT  public/assets/gen/**");
  say(
    `  ${a.counts.ids} ids in ${MANIFEST_DIRS.length} manifests · ` +
      `${a.counts.files} files · ${mib(a.counts.bytes)}`,
  );
  say(
    `  scanned ${a.counts.sourceFiles} source files in ${CODE_ROOTS.join("/")}: ` +
      `${a.counts.literals} id literals, ${a.counts.prefixes} id prefixes`,
  );
  say();

  section(
    "manifests parse",
    a.manifestProblems,
    `all ${MANIFEST_DIRS.length} are version-1 sprite manifests`,
  );
  section(
    "budget citations current",
    a.sourceDrift,
    `${SOURCE_CHECKS.length} cited constants still hold`,
  );
  section(
    "duplicate ids",
    a.duplicates.map((d) =>
      d.kind === "id"
        ? `${d.id} declared in ${d.where.join(" and ")}`
        : `${d.file} claimed by ${d.ids.join(" and ")}`,
    ),
    "every id and every file is claimed exactly once",
  );
  section(
    "declared files present",
    a.missing.map((m) => `${m.id} → ${m.file} (not on disk)`),
    "every declared id resolves to a file",
  );
  section(
    "declared sizes true",
    a.wrongSize.map((w) => `${w.id}: manifest says ${w.declared}, pixels are ${w.actual}`),
    "every w/h matches the pixels",
  );
  section(
    "orphan files",
    a.orphans.map((o) => `${o.file} (${kib(o.bytes)}) — no manifest declares it`),
    "no undeclared file under public/assets/gen/**",
  );
  section(
    "unreferenced ids",
    a.unreferenced.map(
      (d) => `${d.id} (${d.manifest}) — no literal and no prefix reaches it`,
    ),
    "every declared id is reachable from src/ or agent/",
  );
  section(
    "oversized art",
    a.oversized.map(
      (o) =>
        `${o.id.padEnd(28)} ${String(o.px).padStart(9)} stored, drawn at ` +
        `${o.budget}px (${o.ratio}×, right-sized ≈${o.rightSized}px, ` +
        `${kib(o.bytes)})  [${o.source}]`,
    ),
    `nothing above ${MIN_STORED}² is stored past ${OVERSIZE_FACTOR}× its box`,
  );

  if (a.undeclared.length > 0) {
    say(`  NOTE undeclared ids referenced by code — ${a.undeclared.length}`);
    for (const u of a.undeclared) {
      say(`         ${u.id} — asked for in ${u.at.join(", ")} (fail-soft miss)`);
    }
  }

  if (!quiet) {
    say();
    say("  prefixes that keep whole namespaces alive:");
    say(`    ${a.prefixes.join("  ")}`);
  }

  if (a.oversized.length > 0) {
    const waste = a.oversized.reduce((n, o) => n + o.bytes, 0);
    say();
    say(`  ${mib(waste)} sits in oversized art; ${mib(a.orphanBytes)} in orphans.`);
  }
  return out.join("\n");
}

/* ---------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const a = audit();
if (argv.includes("--json")) {
  const { reachedBy, declared, ...rest } = a;
  process.stdout.write(JSON.stringify(rest, null, 2) + "\n");
} else {
  process.stdout.write(report(a, { quiet: argv.includes("--quiet") }) + "\n");
}

const findings =
  a.manifestProblems.length +
  a.sourceDrift.length +
  a.duplicates.length +
  a.missing.length +
  a.wrongSize.length +
  a.orphans.length +
  a.unreferenced.length +
  a.oversized.length;
process.exit(findings > 0 ? 1 : 0);
