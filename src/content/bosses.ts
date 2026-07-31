/**
 * BOSS_ENCOUNTERS — boss placement data per GDD §6.
 *
 * Boss EnemyDefs (with their BossData) live in content/enemies.ts; this file
 * exports only the encounter arrays (front-to-back) keyed by boss id:
 *   - vacuumKing (floor 3): fights alone.
 *   - dogfather (floor 6): one porcelainHound escort (GDD overrides
 *     dungeon.md's two-hound floor-9 version).
 *   - ratPrince (SHOULD-tier alternate floor-3 boss): fights alone;
 *     seeded pick vs the Vacuum King for run variety.
 */
import type { EnemyId } from "../core/types.js";

export const BOSS_ENCOUNTERS: Record<EnemyId, EnemyId[]> = {
  vacuumKing: ["vacuumKing"],
  dogfather: ["dogfather", "porcelainHound"],
  ratPrince: ["ratPrince"],
};
