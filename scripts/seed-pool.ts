/**
 * seed-pool — upsert GENERATION-ZERO rows into the shared GM content pool.
 *
 * Reads:
 *  - public/assets/gen/manifest.json + the env/items/scenes sub-manifests
 *    (any may be absent while a batch is mid-generation — tolerated), and
 *  - src/content/powers.ts stock Power Scripts (module may not exist yet —
 *    tolerated; it is being built in a parallel workstream), plus the
 *    hand-authored STOCK_POWERS shipped with the api package.
 *
 * Writes through the PoolStore interface (api/_lib/pool.ts):
 *  - keyed `art` rows   { assetId, file, w, h, styleVersion, provenance }
 *  - keyed `powers` rows{ id, version, json, budget, flavor, provenance }
 * Keyed writes are idempotent upserts — safe to re-run after every batch.
 *
 * Run (documented in docs/GM-DEPLOY.md — `npx tsx` is the runner; plain
 * node's type-stripping cannot resolve the repo's extensionless imports):
 *   npx tsx scripts/seed-pool.ts
 * With UPSTASH_REDIS_REST_URL/TOKEN set it seeds the shared Redis pool;
 * without them it dry-runs against the in-memory pool and reports counts.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "../api/_lib/pool";
import {
  BUDGET_CAPS,
  lintPowerScript,
  normalizePower,
  STOCK_POWERS,
} from "../api/_lib/powers";
import { ART_STYLE } from "../src/content/artStyle";
import type { PowerScript } from "../src/services/gmTypes";

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

function looksLikePower(v: unknown): v is PowerScript {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PowerScript).id === "string" &&
    (v as PowerScript).id.startsWith("power:") &&
    typeof (v as PowerScript).trigger === "string" &&
    Array.isArray((v as PowerScript).effects)
  );
}

/** src/content/powers.ts may not exist yet; probe its exports tolerantly. */
async function loadContentPowers(): Promise<PowerScript[]> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("../src/content/powers.ts")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const found: PowerScript[] = [];
  for (const value of Object.values(mod)) {
    const candidates = Array.isArray(value)
      ? value
      : typeof value === "object" && value !== null
        ? Object.values(value)
        : [];
    for (const c of candidates) if (looksLikePower(c)) found.push(c);
  }
  return found;
}

async function main(): Promise<void> {
  const pool = getPool();
  const shared = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );

  // ── art: generation-zero asset rows, styleVersion-stamped ──────────────
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
          file: `/assets/gen/${dir}${meta.file}`,
          w: meta.w,
          h: meta.h,
          styleVersion: ART_STYLE.version,
          provenance: "generation-zero",
        }),
      );
      artRows++;
    }
  }

  // ── powers: stock scripts. src/content/powers.ts is probed dynamically
  // (tolerated absent while the parallel workstream lands); the api-side
  // STOCK_POWERS fallbacks are seeded too and de-duped by the keyed upsert.
  const contentPowers = await loadContentPowers();
  const candidates: { power: PowerScript; provenance: string }[] = [
    ...Object.values(STOCK_POWERS).map((power) => ({
      power,
      provenance: "stock:api",
    })),
    ...contentPowers.map((power) => ({
      power,
      provenance: "stock:content",
    })),
  ];
  let powerRows = 0;
  let powerRejects = 0;
  const seedCap = Math.max(BUDGET_CAPS.cat, BUDGET_CAPS.enemyByTier[3]);
  for (const { power, provenance } of candidates) {
    const normalized = normalizePower(power);
    const errors = lintPowerScript(normalized, seedCap);
    if (errors.length > 0) {
      powerRejects++;
      console.warn(`skip ${normalized.id}: ${errors[0]}`);
      continue;
    }
    await pool.setEntry(
      "powers",
      normalized.id,
      JSON.stringify({
        id: normalized.id,
        version: normalized.version,
        json: normalized,
        budget: normalized.budget,
        flavor: normalized.flavor,
        provenance,
      }),
    );
    powerRows++;
  }

  console.log(
    `seed-pool: ${artRows} art rows (${manifestsSeen} manifests), ` +
      `${powerRows} power rows (${powerRejects} rejected by lint), ` +
      `styleVersion ${ART_STYLE.version}, target: ` +
      (shared
        ? "Upstash (shared)"
        : "in-memory pool — DRY RUN, set UPSTASH_REDIS_REST_URL/TOKEN to seed the shared pool"),
  );
}

main().catch((err: unknown) => {
  console.error("seed-pool failed:", err);
  process.exitCode = 1;
});
