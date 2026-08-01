/**
 * seed-pool — write GENERATION ZERO of the Dreaming into the shared pool.
 *
 * The pool-first read (`agent/tools/recall_content.ts`) rolls
 * `p = min(0.7, size/200)`, so an empty pool reuses nothing and the world only
 * starts growing after somebody has played for a very long time. This script
 * fixes that on day one: everything the game already ships is written into
 * `catrpg.content` with provenance `generation-zero`, so the very first run has
 * a world to draw from and every later dream lands beside peers instead of in
 * an empty table.
 *
 * The ROWS are built by `agent/lib/generationZero.ts` — pure, deterministic,
 * one home — so this script is only the runner: it adds the keyed `art` table,
 * which needs the on-disk manifests, and it reports.
 *
 * What lands, all idempotent upserts (safe to re-run after every batch):
 *
 *  - `content` — the authored `GameEvent`s (each in its own floor band), every
 *    `EquipDef` and `ConsumableDef`, every `EnemyDef` (floor-banded by the
 *    floors that actually field it), one background per floor, and the shipped
 *    Power Scripts (budget-linted first);
 *  - `art`     — the keyed generation-zero asset rows from the
 *    `public/assets/gen` manifests, styleVersion-stamped, so a style bump can
 *    find the pictures that went stale.
 *
 * Everything goes through the `ContentPool` interface in `agent/lib/pool.ts`,
 * so this script does not know or care that the store is Supabase.
 *
 * Run (docs/DM-DEPLOY.md — `npx tsx` is the runner; plain node's type-stripping
 * cannot resolve the repo's extensionless imports):
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/seed-pool.ts
 *
 * With those two set it seeds the shared Supabase pool and then READS THE
 * COUNTS BACK, so the number it prints is the number that is actually there.
 * Without them it DRY-RUNS against the in-memory pool and reports the same
 * shapes, which is how you check a change without touching the shared world.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool, type PoolKind } from "../agent/lib/pool.js";
import {
  buildGenerationZero,
  GENERATION_ZERO_PROVENANCE,
} from "../agent/lib/generationZero.js";
import { ART_STYLE } from "../src/content/artStyle.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  version?: number;
  sprites?: Record<string, { file?: string; w?: number; h?: number }>;
}

const MANIFESTS: { dir: string; file: string }[] = [
  { dir: "", file: "public/assets/gen/manifest.json" },
  { dir: "env/", file: "public/assets/gen/env/manifest.json" },
  { dir: "items/", file: "public/assets/gen/items/manifest.json" },
  { dir: "scenes/", file: "public/assets/gen/scenes/manifest.json" },
];

async function readManifest(file: string): Promise<Manifest | null> {
  try {
    return JSON.parse(
      await readFile(path.join(ROOT, file), "utf8"),
    ) as Manifest;
  } catch {
    return null; // absent or mid-generation — tolerated
  }
}

async function main(): Promise<void> {
  const pool = getPool();
  const { rows, powerRejects } = buildGenerationZero();

  // ── content: one upsert per kind — six requests, not two hundred ───────
  const written: Partial<Record<PoolKind, number>> = {};
  const seeded: PoolKind[] = [];
  for (const [kind, list] of Object.entries(rows) as [
    PoolKind,
    (typeof rows)[PoolKind],
  ][]) {
    if (list.length === 0) continue;
    seeded.push(kind);
    written[kind] = await pool.addContentBatch(list);
  }

  // ── art: keyed rows from the on-disk manifests ─────────────────────────
  let artRows = 0;
  let manifestsSeen = 0;
  for (const { dir, file } of MANIFESTS) {
    const manifest = await readManifest(file);
    if (!manifest?.sprites) continue;
    manifestsSeen++;
    for (const [assetId, meta] of Object.entries(manifest.sprites)) {
      if (typeof meta?.file !== "string") continue;
      await pool.setEntry(
        "art",
        assetId,
        JSON.stringify({
          assetId,
          // Shipped art is served from the game's own origin; only DREAMED art
          // is uploaded to the bucket (`SupabasePool.rehostArt`).
          url: `/assets/gen/${dir}${meta.file}`,
          w: meta.w,
          h: meta.h,
          styleVersion: ART_STYLE.version,
          prompt: null,
          provenance: GENERATION_ZERO_PROVENANCE,
        }),
      );
      artRows++;
    }
  }

  // ── report ─────────────────────────────────────────────────────────────
  console.log(
    `seed-pool → ${
      pool.durable
        ? "Supabase (shared)"
        : "in-memory — DRY RUN, set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY"
    }`,
  );
  for (const kind of seeded) {
    console.log(
      `  ${kind.padEnd(12)} ${String(written[kind] ?? 0).padStart(4)} / ${
        rows[kind].length
      } upserted`,
    );
  }
  console.log(
    `  ${"art".padEnd(12)} ${String(artRows).padStart(4)} keyed rows ` +
      `(${manifestsSeen} manifests)`,
  );
  for (const r of powerRejects) console.log(`  REJECTED ${r.id}: ${r.problem}`);
  console.log(`  styleVersion ${ART_STYLE.version}`);

  // Read the pool back, so the number reported is the number that is THERE and
  // not the number we thought we sent.
  if (pool.durable) {
    console.log("  verified by reading Supabase back:");
    for (const kind of seeded) {
      console.log(
        `    ${kind.padEnd(12)} ${String(await pool.size(kind)).padStart(4)} rows`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error("seed-pool failed:", err);
  process.exitCode = 1;
});
