/**
 * c(at)rpg — score table (gameloop.md §7, restated in ARCHITECTURE.md §2.9)
 * and the results-screen summary struct.
 *
 * floorsCleared×100, floorsReached×50, enemiesDefeated×10, bossesDefeated
 * ×300, shinies×5, catPiles×20, livesRemaining×25 (victory only), victory
 * bonus 1000. Time is shown, never scored.
 */
import type { ScoreCounters } from "../types";

export const SCORE_MULT = {
  floorsCleared: 100,
  floorsReached: 50,
  enemiesDefeated: 10,
  bossesDefeated: 300,
  shiniesCollected: 5,
  catPiles: 20,
  livesRemaining: 25, // victory only; max 36 → up to 900
} as const;

export const VICTORY_BONUS = 1000;

/** One tallied line of the results table (UI counts these up in order). */
export interface ScoreLine {
  id: keyof typeof SCORE_MULT | "victoryBonus";
  label: string;
  count: number;
  mult: number;
  points: number;
}

export interface ScoreSummary {
  victory: boolean;
  lines: ScoreLine[];
  total: number;
}

const LABELS: Record<keyof typeof SCORE_MULT, string> = {
  floorsCleared: "floors fully cleared",
  floorsReached: "floors reached",
  enemiesDefeated: "enemies defeated",
  bossesDefeated: "bosses defeated",
  shiniesCollected: "shinies collected",
  catPiles: "Cat Piles triggered",
  livesRemaining: "lives remaining",
};

/**
 * Compute the full score breakdown, lines in gameloop.md §7 table order.
 * `livesRemaining` = sum of Lives across all cats (dead cats contribute 0);
 * it and the flat victory bonus appear on victory only.
 */
export function computeScore(
  counters: ScoreCounters,
  victory: boolean,
  livesRemaining: number,
): ScoreSummary {
  const lines: ScoreLine[] = [];
  const push = (id: keyof typeof SCORE_MULT, count: number): void => {
    const mult = SCORE_MULT[id];
    lines.push({ id, label: LABELS[id], count, mult, points: count * mult });
  };
  push("floorsCleared", counters.floorsCleared);
  push("floorsReached", counters.floorsReached);
  push("enemiesDefeated", counters.enemiesDefeated);
  push("bossesDefeated", counters.bossesDefeated);
  push("shiniesCollected", counters.shiniesCollected);
  push("catPiles", counters.catPiles);
  if (victory) {
    push("livesRemaining", livesRemaining);
    lines.push({
      id: "victoryBonus",
      label: "VICTORY BONUS",
      count: 1,
      mult: VICTORY_BONUS,
      points: VICTORY_BONUS,
    });
  }
  const total = lines.reduce((sum, l) => sum + l.points, 0);
  return { victory, lines, total };
}
