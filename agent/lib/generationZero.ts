/**
 * GENERATION ZERO — the rows the world starts with.
 *
 * The pool-first read (`agent/tools/recall_content.ts`) rolls
 * `p = min(0.7, size/200)`, so an EMPTY pool reuses nothing: the Dreaming would
 * do literally nothing until somebody had played for a very long time. This
 * module is the fix — everything the game already ships, expressed as
 * `ContentRow`s with provenance `generation-zero`, so the very first run has a
 * world to draw from and every later dream lands beside peers.
 *
 * PURE: it imports the shipped content tables and returns rows. No I/O, no
 * env, no clock. That is why it can have exactly ONE home and two callers —
 * `scripts/seed-pool.ts` (which also seeds the keyed `art` table from the
 * on-disk manifests) and any server-side path that already holds the write
 * credential. Neither gets to disagree with the other about what generation
 * zero is.
 */
import type { ContentRow, PoolKind } from "./pool.js";
import { ART_STYLE } from "../../src/content/artStyle.js";
import { EVENTS } from "../../src/content/events.js";
import { EQUIP_DEFS } from "../../src/content/equipment.js";
import { CONSUMABLES } from "../../src/content/consumables.js";
import { ENEMIES } from "../../src/content/enemies.js";
import { FLOORS } from "../../src/content/floors.js";
import { CAT_POWERS, ENEMY_POWERS } from "../../src/content/powers.js";
import {
  BUDGET_CAPS,
  lintPowerScript,
  normalizePower,
  STOCK_POWERS,
} from "../../src/services/powerLint.js";
import type { EnemyId } from "../../src/core/types.js";
import type { PowerScript } from "../../src/services/gmTypes.js";

export const GENERATION_ZERO_PROVENANCE = "generation-zero";

/**
 * The floors an enemy actually appears on, read off the authored `FLOORS`
 * table rather than guessed from its tier — so a boss is banded to its own
 * floor and nothing else, and a floor-3 recall never offers a floor-6 monster.
 */
export function enemyFloorBand(id: EnemyId): [number, number] {
  const floors: number[] = [];
  FLOORS.forEach((floor, i) => {
    const n = i + 1;
    if (floor.pool.includes(id)) floors.push(n);
    if (floor.boss?.encounter.includes(id) || floor.boss?.bossId === id) {
      floors.push(n);
    }
  });
  if (floors.length === 0) return [1, 6];
  return [Math.min(...floors), Math.max(...floors)];
}

function stamp(payload: object): Record<string, unknown> {
  return {
    ...payload,
    styleVersion: ART_STYLE.version,
    provenance: GENERATION_ZERO_PROVENANCE,
  };
}

function base(
  kind: PoolKind,
): Pick<ContentRow, "kind" | "styleVersion" | "provenance" | "frameworkVer"> {
  return {
    kind,
    styleVersion: ART_STYLE.version,
    provenance: GENERATION_ZERO_PROVENANCE,
    frameworkVer: 1,
  };
}

/** Rejected candidates, so a caller can report what did not make the cut. */
export interface GenerationZero {
  rows: Record<PoolKind, ContentRow[]>;
  /** `id: firstProblem` for every shipped power that failed the budget lint. */
  powerRejects: { id: string; problem: string }[];
}

/**
 * Build every generation-zero row. Deterministic: same content tables in, same
 * rows out, same ids — which is what makes re-seeding an idempotent upsert
 * rather than a duplication.
 */
export function buildGenerationZero(): GenerationZero {
  const rows: Record<PoolKind, ContentRow[]> = {
    stands: [],
    items: [],
    events: [],
    enemies: [],
    encounters: [],
    cats: [],
    powers: [],
    backgrounds: [],
  };
  const powerRejects: { id: string; problem: string }[] = [];

  // events — each keeps the floor band it was authored with
  for (const event of EVENTS) {
    rows.events.push({
      ...base("events"),
      id: `event:${event.id}`,
      payload: stamp(event),
      floorMin: event.floors[0],
      floorMax: event.floors[1],
    });
  }

  // items — equipment and consumables, legal anywhere
  for (const equip of Object.values(EQUIP_DEFS)) {
    rows.items.push({
      ...base("items"),
      id: `item:${equip.id}`,
      payload: stamp({ equip }),
      floorMin: 1,
      floorMax: 6,
    });
  }
  for (const item of Object.values(CONSUMABLES)) {
    rows.items.push({
      ...base("items"),
      id: `item:${item.id}`,
      payload: stamp({ equip: item }),
      floorMin: 1,
      floorMax: 6,
    });
  }

  // enemies — banded by the floors that actually field them
  for (const enemy of Object.values(ENEMIES)) {
    const [lo, hi] = enemyFloorBand(enemy.id);
    rows.enemies.push({
      ...base("enemies"),
      id: `enemy:${enemy.id}`,
      payload: stamp(enemy),
      floorMin: lo,
      floorMax: hi,
      tier: enemy.tier,
    });
  }

  // backgrounds — one per floor: its name and its authored map budget
  FLOORS.forEach((floor, i) => {
    const n = i + 1;
    rows.backgrounds.push({
      ...base("backgrounds"),
      id: `background:floor${n}`,
      payload: stamp({
        id: `floor${n}`,
        name: floor.name,
        floor: n,
        map: floor.map,
      }),
      floorMin: n,
      floorMax: n,
    });
  });

  // powers — the shipped Power Scripts, priced by the ENGINE'S own lint at the
  // most generous shipped cap. A power that fails here is a bug in the content,
  // not something to seed around.
  const seedCap = Math.max(BUDGET_CAPS.cat, BUDGET_CAPS.enemyByTier[3]);
  // `CAT_POWERS` / `ENEMY_POWERS` are Partial records — a class or enemy with
  // no authored power yields `undefined`, which is a legal gap, not a reject.
  const candidates: { power: PowerScript; provenance: string }[] = [
    ...Object.values(STOCK_POWERS).map((power) => ({
      power,
      provenance: "stock:api",
    })),
    ...Object.values(CAT_POWERS).map((power) => ({
      power,
      provenance: "stock:content",
    })),
    ...Object.values(ENEMY_POWERS).map((power) => ({
      power,
      provenance: "stock:content",
    })),
  ].filter((c): c is { power: PowerScript; provenance: string } =>
    Boolean(c.power),
  );
  for (const { power, provenance } of candidates) {
    const normalized = normalizePower(power);
    const errors = lintPowerScript(normalized, seedCap);
    if (errors.length > 0) {
      powerRejects.push({ id: normalized.id, problem: errors[0] });
      continue;
    }
    rows.powers.push({
      ...base("powers"),
      id: normalized.id, // already `power:*`
      payload: {
        id: normalized.id,
        version: normalized.version,
        json: normalized,
        budget: normalized.budget,
        flavor: normalized.flavor,
        styleVersion: ART_STYLE.version,
        provenance,
      },
      floorMin: 1,
      floorMax: 6,
      provenance,
      frameworkVer: normalized.version,
    });
  }

  return { rows, powerRejects };
}
