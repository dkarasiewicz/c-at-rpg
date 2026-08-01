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
 * one home — so this script is only the runner and the report.
 *
 * What lands, all idempotent upserts (safe to re-run after every batch):
 *
 *  - `content` — the authored `GameEvent`s (each in its own floor band), every
 *    `EquipDef` and `ConsumableDef`, every `EnemyDef` (floor-banded by the
 *    floors that actually field it), one background per floor, and the shipped
 *    Power Scripts (budget-linted first).
 *
 * THE PICTURES ARE A SEPARATE SCRIPT. `scripts/seed-art.ts` uploads every
 * shipped asset under `public/assets/gen/**` into the `catrpg-art` bucket and
 * writes the `catrpg.art` rows. This script used to write those rows itself
 * with `url: "/assets/gen/…"` — an ORIGIN-RELATIVE PATH, which is not a
 * durable location at all: it only resolves for a browser already on the
 * game's own deployment, and it is exactly the "remembered wrong" failure the
 * `art` table exists to prevent. Run both:
 *
 *   npx tsx scripts/seed-pool.ts && npx tsx scripts/seed-art.ts
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
import { getPool, type PoolKind } from "../agent/lib/pool.js";
import { buildGenerationZero } from "../agent/lib/generationZero.js";
import { ART_STYLE } from "../src/content/artStyle.js";

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
  console.log("  art          → scripts/seed-art.ts (bucket + catrpg.art)");
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
