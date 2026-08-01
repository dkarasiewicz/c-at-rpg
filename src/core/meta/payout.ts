/**
 * CAT TOWN — the payout (balance-and-meta.md §4: "shinies banked at the end
 * of a run, WIN OR LOSE — a losing run must still pay out, or failure feels
 * wasted").
 *
 * One pure function from a RunSummary to a receipt. Every line is something
 * the party actually did, so the receipt doubles as the run's obituary; the
 * outcome only scales the total, it never zeroes a line.
 *
 * Measured shape of the curve (tests/meta.spec.ts pins these):
 *   total wipe on floor 1, nothing cleared ................  20  (the floor)
 *   died on floor 2, one floor cleared, 8 kills, 60 carried   72
 *   died on floor 4, three cleared, 30 kills, 1 boss ....... ~230
 *   clean six-floor victory, 1 boss, 150 carried ..........  757
 * A real six-floor victory carries far more coin than that fixture — a
 * measured DEEP-0 run banked 1013 ✦ on 984 carried and two bosses.
 * The authored unlock catalog totals 2650 ✦ over 13 unlocks
 * (`unlocks.ts` `catalogCost()`, pinned in tests/meta.spec.ts), i.e. ~3
 * victories or ~a dozen failed runs to own the town outright.
 */
import type { Payout, PayoutLine, RunSummary } from "./types.js";

/** Rates, per unit of the thing that happened. */
export const RATE = {
  floorReached: 25,
  floorCleared: 40,
  enemy: 2,
  boss: 60,
  catPile: 5,
  /** shinies still in the wallet convert at 1:CARRY_DIVISOR */
  carryDivisor: 4,
} as const;

/** Flat bonus for finishing the descent. */
export const VICTORY_BONUS = 150;
/** A failed run banks this fraction of what it earned. Losing pays less. */
export const LOSS_RATE = 0.6;
/** Nobody leaves empty-pawed — even a floor-1 wipe funds something. */
export const MIN_PAYOUT = 20;

const line = (
  label: string,
  count: number,
  rate: number,
): PayoutLine | null => {
  const amount = Math.floor(count * rate);
  return amount > 0 ? { label, count, rate, amount } : null;
};

/**
 * The receipt. Pure: same summary in, same payout out, no rng, no clock.
 * `total` is what `bankRun` adds to the wallet.
 */
export function computePayout(summary: RunSummary): Payout {
  const carried = Math.floor(
    Math.max(0, summary.shiniesCarried) / RATE.carryDivisor,
  );
  const lines = [
    line(
      "floors entered",
      Math.max(0, summary.floorsReached),
      RATE.floorReached,
    ),
    line(
      "floors cleared",
      Math.max(0, summary.floorsCleared),
      RATE.floorCleared,
    ),
    line("enemies felled", Math.max(0, summary.enemiesDefeated), RATE.enemy),
    line("bosses toppled", Math.max(0, summary.bossesDefeated), RATE.boss),
    line("cat piles", Math.max(0, summary.catPiles), RATE.catPile),
    line("shinies carried out", carried, 1),
  ].filter((l): l is PayoutLine => l !== null);

  const earned = lines.reduce((s, l) => s + l.amount, 0);
  const bonus = summary.victory ? VICTORY_BONUS : 0;
  const lossRate = summary.victory ? 1 : LOSS_RATE;
  const total = Math.max(MIN_PAYOUT, Math.floor(earned * lossRate) + bonus);

  return { lines, earned, bonus, lossRate, total };
}
