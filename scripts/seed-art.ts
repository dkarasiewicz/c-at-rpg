/**
 * seed-art — put GENERATION ZERO'S PICTURES somewhere durable.
 *
 * `scripts/seed-pool.ts` seeds the WORDS: 66 rows in `catrpg.content`
 * describing every shipped item, enemy, event, power and background. It cannot
 * seed the pictures, because the pictures are files on this machine that get
 * served from the game's own origin — and the `catrpg.art` table was therefore
 * empty and the `catrpg-art` bucket held nothing at all.
 *
 * That gap matters the moment anything reads the pool from somewhere that is
 * not the game's own deployment: a dreamed row's picture must resolve for a
 * player who has never met the machine that made it. So this script uploads
 * every shipped asset under `public/assets/gen/**` into the PUBLIC
 * `catrpg-art` bucket and writes one `catrpg.art` row per asset —
 * `key` (the manifest asset id), `url` (the public bucket URL), `prompt`
 * (where it is actually recorded), `style_version`.
 *
 * IDEMPOTENT AND CHEAP TO RE-RUN. Objects already in the bucket at the same
 * byte length are not re-uploaded, and the rows are one merge-duplicates
 * upsert. Run it after every art batch.
 *
 * OFFLINE-FIRST IS UNTOUCHED. Nothing the game does at runtime reads these
 * objects: `public/assets/gen` is still served from the game's own origin and
 * the game still plays with the bucket unreachable. This is the pool's copy —
 * enrichment, and a durable home for pictures that only existed in one place.
 *
 * Run (docs/DM-DEPLOY.md):
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/seed-art.ts
 *
 * Without those two it DRY-RUNS against the in-memory pool: it reports exactly
 * what it would upload without touching the shared world.
 *
 * Flags:
 *   --stale     list the art whose `style_version` is BEHIND
 *               `ART_STYLE.version` and exit. That question is the entire
 *               reason the column exists: after a style bump the answer is the
 *               regeneration queue. Add `--version=N` to ask it one style
 *               ahead — "what would bumping to N put in the queue?" — which
 *               is how you cost a style change before making it.
 *   --limit=N   cap the upload (a quick smoke test of the path).
 *   --force     re-upload even when the bucket already holds the same bytes.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool, type ArtRow, type ContentPool } from "../agent/lib/pool.js";
import { ART_STYLE } from "../src/content/artStyle.js";
import { GENERATION_ZERO_PROVENANCE } from "../agent/lib/generationZero.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEN_DIR = path.join(ROOT, "public/assets/gen");

/** Where shipped art lives in the bucket. `dreamed/` is the runtime path. */
const BUCKET_PREFIX = "gen";

/** The bucket's `allowed_mime_types` (supabase/001_init.sql §storage). */
const CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

interface Manifest {
  version?: number;
  sprites?: Record<
    string,
    { file?: string; w?: number; h?: number; prompt?: string }
  >;
}

/** Manifest dirs, relative to `public/assets/gen`. "" is the root manifest. */
const MANIFEST_DIRS = ["", "env", "items", "scenes"];

interface Asset {
  /** Path relative to `public/assets/gen`, POSIX-separated. */
  rel: string;
  /** `catrpg.art.key` — the manifest asset id where there is one. */
  key: string;
  /** The prompt the picture was drawn from, where it is recorded. */
  prompt: string | null;
  bytes: number;
  contentType: string;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const file = path.join(GEN_DIR, dir, "manifest.json");
    return JSON.parse(await readFile(file, "utf8")) as Manifest;
  } catch {
    return null; // absent or mid-generation — tolerated
  }
}

/** Every image file under `public/assets/gen`, recursively. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), rel)));
    } else if (CONTENT_TYPE[path.extname(entry.name).toLowerCase()]) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Pair every image on disk with its manifest identity.
 *
 * The manifest key (`cat:bruno`, `scene:map:3`) is the id the GAME uses, so it
 * is the id the `art` table is keyed by — an asset that gets redrawn keeps its
 * key and its row is updated rather than duplicated. Files with no manifest
 * entry (nothing is currently in that state, but a mid-batch run could be) get
 * a path-derived key so they are still persisted rather than silently dropped.
 */
async function collect(): Promise<{ assets: Asset[]; unkeyed: number }> {
  const byFile = new Map<string, { key: string; prompt: string | null }>();
  for (const dir of MANIFEST_DIRS) {
    const manifest = await readManifest(dir);
    if (!manifest?.sprites) continue;
    for (const [key, meta] of Object.entries(manifest.sprites)) {
      if (typeof meta?.file !== "string") continue;
      const rel = dir ? `${dir}/${meta.file}` : meta.file;
      byFile.set(rel, {
        key,
        // Prompts are only present when the batch pipeline recorded them.
        // Inventing one would be worse than a null: it would claim these bytes
        // came from words they did not come from.
        prompt: typeof meta.prompt === "string" ? meta.prompt : null,
      });
    }
  }

  const assets: Asset[] = [];
  let unkeyed = 0;
  for (const rel of await walk(GEN_DIR)) {
    const known = byFile.get(rel);
    if (!known) unkeyed++;
    const info = await stat(path.join(GEN_DIR, rel));
    assets.push({
      rel,
      key: known?.key ?? `file:${rel.replace(/\.[^.]+$/, "")}`,
      prompt: known?.prompt ?? null,
      bytes: info.size,
      contentType: CONTENT_TYPE[path.extname(rel).toLowerCase()],
    });
  }
  return { assets, unkeyed };
}

/* ------------------------------------------------------------------------ */
/* What is already in the bucket                                             */
/* ------------------------------------------------------------------------ */

interface BucketObject {
  name: string;
  size: number;
}

/**
 * List one bucket prefix. Storage's list endpoint is not recursive and pages
 * at 100 by default, so this walks folders and pages explicitly.
 *
 * Failure is an empty list, which only ever costs a re-upload.
 */
async function listBucket(
  url: string,
  key: string,
  bucket: string,
  prefix: string,
): Promise<BucketObject[]> {
  const out: BucketObject[] = [];
  const folders: string[] = [prefix];
  while (folders.length > 0) {
    const at = folders.pop() ?? "";
    let offset = 0;
    for (;;) {
      let body: unknown;
      try {
        const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
          method: "POST",
          headers: {
            apikey: key,
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prefix: at, limit: 1000, offset }),
        });
        if (!res.ok) break;
        body = await res.json();
      } catch {
        break;
      }
      if (!Array.isArray(body) || body.length === 0) break;
      for (const raw of body as Record<string, unknown>[]) {
        const name = typeof raw.name === "string" ? raw.name : null;
        if (!name) continue;
        const meta = raw.metadata as { size?: unknown } | null;
        if (meta && typeof meta.size === "number") {
          out.push({ name: at ? `${at}/${name}` : name, size: meta.size });
        } else if (raw.id === null) {
          folders.push(at ? `${at}/${name}` : name); // a folder placeholder
        }
      }
      offset += body.length;
      if (body.length < 1000) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* --stale: the question `style_version` exists to answer                    */
/* ------------------------------------------------------------------------ */

async function reportStale(pool: ContentPool, version: number): Promise<void> {
  const [art, content] = await Promise.all([
    pool.staleArt(version, 500),
    pool.staleContentArt(version, 500),
  ]);
  console.log(
    `art behind style v${version}` +
      `${version === ART_STYLE.version ? " (ART_STYLE.version)" : " (hypothetical bump)"} ` +
      `— ${pool.durable ? "Supabase" : "in-memory DRY RUN"}:`,
  );
  console.log(`  catrpg.art      ${String(art.length).padStart(4)} rows`);
  for (const row of art.slice(0, 40)) {
    console.log(`    v${row.styleVersion}  ${row.key}`);
  }
  if (art.length > 40) console.log(`    … ${art.length - 40} more`);
  console.log(`  catrpg.content  ${String(content.length).padStart(4)} rows`);
  for (const row of content.slice(0, 40)) {
    console.log(`    v${row.styleVersion}  ${row.id}`);
  }
  if (content.length > 40) console.log(`    … ${content.length - 40} more`);
  if (art.length === 0 && content.length === 0) {
    console.log("  nothing to redraw — every picture is at the current style.");
  }
}

/* ------------------------------------------------------------------------ */

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Six at a time: fast enough to finish, gentle enough not to be throttled. */
const CONCURRENCY = 6;

async function inParallel<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    }),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pool = getPool();

  if (argv.includes("--stale")) {
    // `--version=N` answers "what would a bump to N put in the queue?" before
    // the bump is made — the same query, asked one style ahead.
    const versionArg = argv.find((a) => a.startsWith("--version="));
    const asked = versionArg
      ? Number.parseInt(versionArg.slice(10), 10)
      : ART_STYLE.version;
    await reportStale(
      pool,
      Number.isFinite(asked) && asked > 0 ? asked : ART_STYLE.version,
    );
    return;
  }

  const force = argv.includes("--force");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.slice(8), 10) : Infinity;

  const { assets: all, unkeyed } = await collect();
  const assets = Number.isFinite(limit) ? all.slice(0, limit) : all;
  const onDisk = assets.reduce((n, a) => n + a.bytes, 0);

  console.log(
    `seed-art → ${
      pool.durable
        ? "Supabase (shared)"
        : "in-memory — DRY RUN, set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
    }`,
  );
  console.log(
    `  ${assets.length} assets under public/assets/gen (${human(onDisk)} on ` +
      `disk), ${unkeyed} with no manifest key`,
  );

  // The bucket's public origin. `putArt` returns it per object, but the report
  // wants it before anything is uploaded.
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const bucket = process.env.SUPABASE_ART_BUCKET || "catrpg-art";

  const existing = new Map<string, number>();
  if (pool.durable) {
    for (const obj of await listBucket(url, key, bucket, BUCKET_PREFIX)) {
      existing.set(obj.name, obj.size);
    }
    console.log(`  bucket already holds ${existing.size} objects under gen/`);
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const rows: ArtRow[] = [];
  const failures: string[] = [];

  await inParallel(assets, async (asset) => {
    const objectPath = `${BUCKET_PREFIX}/${asset.rel}`;
    const publicUrl = `${url}/storage/v1/object/public/${bucket}/${objectPath}`;

    if (!force && existing.get(objectPath) === asset.bytes) {
      skipped++;
      rows.push({
        key: asset.key,
        url: publicUrl,
        prompt: asset.prompt,
        styleVersion: ART_STYLE.version,
      });
      return;
    }

    if (!pool.durable) {
      // A dry run still exercises the row shapes, which is the half that can
      // be wrong without a database to tell you.
      rows.push({
        key: asset.key,
        url: `«bucket»/${objectPath}`,
        prompt: asset.prompt,
        styleVersion: ART_STYLE.version,
      });
      return;
    }

    const bytes = await readFile(path.join(GEN_DIR, asset.rel));
    const hosted = await pool.putArt(objectPath, bytes, asset.contentType);
    if (!hosted) {
      failed++;
      if (failures.length < 10) failures.push(asset.rel);
      return;
    }
    uploaded++;
    rows.push({
      key: asset.key,
      url: hosted,
      prompt: asset.prompt,
      styleVersion: ART_STYLE.version,
    });
  });

  // One request for every row: `art` is keyed by `key`, merge-duplicates.
  const written = await pool.putArtRows(rows);

  console.log(
    `  uploaded ${uploaded}, unchanged ${skipped}, failed ${failed}` +
      `${failures.length > 0 ? ` (${failures.join(", ")}…)` : ""}`,
  );
  console.log(`  catrpg.art rows upserted: ${written} / ${rows.length}`);
  console.log(
    `  provenance ${GENERATION_ZERO_PROVENANCE}, styleVersion ${ART_STYLE.version}`,
  );

  if (pool.durable) {
    // Read it back, so the number reported is the number that is THERE and not
    // the number we thought we sent.
    const seeded = await listBucket(url, key, bucket, BUCKET_PREFIX);
    const whole = await listBucket(url, key, bucket, "");
    const sum = (objects: BucketObject[]): number =>
      objects.reduce((n, o) => n + o.size, 0);
    console.log("  verified by reading Supabase back:");
    console.log(
      `    ${bucket}/${BUCKET_PREFIX}  ${seeded.length} objects, ` +
        `${human(sum(seeded))}`,
    );
    console.log(
      `    ${bucket} (whole)   ${whole.length} objects, ${human(sum(whole))}`,
    );
    const stale = await pool.staleArt(ART_STYLE.version, 1);
    console.log(
      `    catrpg.art rows behind style v${ART_STYLE.version}: ` +
        `${stale.length === 0 ? "none" : `${stale.length}+ (run --stale)`}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error("seed-art failed:", err);
  process.exitCode = 1;
});
