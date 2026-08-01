/**
 * CAT TOWN — the meta layer's public surface (balance-and-meta.md §4).
 *
 *   types.ts     the contracts + the unlock-id namespace convention
 *   unlocks.ts   the authored catalog, the places, the OPEN registry
 *   payout.ts    computePayout — a run's receipt, win or lose
 *   profile.ts   the persistent profile: bank, buy, migrate, recordBattle
 *   bestiary.ts  THE BESTIARY: earned per-enemy knowledge + knownIntel
 *   overlay.ts   applyUnlocks — the one object a run starts from
 *   startRun.ts  newRun + the overlay, folded
 *
 * Pure throughout: no pixi, no Math.random, no localStorage (core/run/save.ts
 * owns the storage adapter and calls in here to migrate).
 */
export * from "./types.js";
export * from "./bestiary.js";
export * from "./unlocks.js";
export * from "./payout.js";
export * from "./profile.js";
export * from "./overlay.js";
export * from "./roster.js";
export * from "./startRun.js";
