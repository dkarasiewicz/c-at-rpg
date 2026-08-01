/**
 * c(at)rpg — score table (gameloop.md §7, restated in ARCHITECTURE.md §2.9)
 * and the results-screen summary struct.
 *
 * ── WHY THESE NUMBERS (the 2nd-pass rebalance) ──────────────────────────
 * The first table paid shinies ×5. A measured six-floor descent
 * (tests/support/scriptedRun.ts, 400 seeds) collects ~950-1000 shinies and
 * fells ~50 enemies, so that one line was 56-71% of every total: the results
 * screen counted up nine rows of which one mattered, and the fastest way to
 * "score" was to hoover up coins rather than to go deep, fight well or find
 * anything. Every other line was decoration.
 *
 * So the table now pays for what the run DID:
 *   DEPTH      floors cleared ×250 and reached ×100 — the run's spine.
 *   DEEDS      enemies ×15, bosses ×500, Cat Piles ×75.
 *   DISCOVERY  events survived ×80 and Mewthical relics ×250 — the run map's
 *              other half. Both are read straight off the RunState
 *              (`firedEventIds`, `uniquesDropped`), so nothing new has to be
 *              counted anywhere for them to exist.
 *   SPOILS     shinies ×1 — still worth having, no longer the whole score.
 *   SURVIVAL   lives remaining ×25 (victory only) and a 2000 victory bonus.
 * On the measured victory above that is ~1500/600/720/1000/300/400/250/980/
 * 875/2000 ≈ 8600, with no line over ~23% and shinies at ~11%.
 *
 * Time is shown, never scored.
 */
import type { RunState, ScoreCounters } from "../types.js";

export const SCORE_MULT = {
  floorsCleared: 250,
  floorsReached: 100,
  enemiesDefeated: 15,
  bossesDefeated: 500,
  catPiles: 75,
  /** one per event the run resolved (`RunState.firedEventIds`) */
  eventsSurvived: 80,
  /** one per Mewthical unique the run turned up (`RunState.uniquesDropped`) */
  relicsFound: 250,
  shiniesCollected: 1,
  // victory only, and only for the cats that were FIELDED (`survivingLives`).
  // A default party of 3 tops out at 27 Lives → 675; a Cat-Town-widened party
  // of 4 at 36 → 900.
  livesRemaining: 25,
} as const;

export const VICTORY_BONUS = 2000;

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
  catPiles: "Cat Piles triggered",
  eventsSurvived: "events survived",
  relicsFound: "Mewthical relics found",
  shiniesCollected: "shinies collected",
  livesRemaining: "lives remaining",
};

/**
 * The two DISCOVERY counts, read off the run rather than tallied into
 * `ScoreCounters`. They are already exact: `firedEventIds` is the run-scoped
 * `once` ledger every resolved event writes to, and `uniquesDropped` is the
 * Mewthical downgrade ledger. Absent (a hand-built RunState) reads as zero.
 */
export interface Discoveries {
  eventsSurvived: number;
  relicsFound: number;
}

export function discoveriesOf(run: RunState): Discoveries {
  return {
    eventsSurvived: run.firedEventIds.length,
    relicsFound: run.uniquesDropped.length,
  };
}

/**
 * The SURVIVAL count: Lives still held by the cats who actually walked the
 * floors — `run.marchingOrder`, which is exactly the roll-call's PARTY half
 * (roster.ts `splitRoster`; a cat that fell is still in the party list with
 * 0 Lives, so it contributes nothing either way).
 *
 * `RunState.cats` used to carry all four class slots whether or not the run
 * fielded them, so summing THAT paid 25 points per Life of a cat who never
 * left Cat Town — a benched cat was worth a free 225, and benching scored
 * higher than fighting. Since roster-and-persistence.md §1 `cats` IS the
 * descent, so the two agree; walking the marching order keeps it honest
 * anyway, because a cat that fell is still in `cats` with 0 Lives.
 */
export function survivingLives(run: RunState): number {
  let lives = 0;
  for (const id of run.marchingOrder) {
    const cat = run.cats.find((c) => c.id === id);
    if (cat) lives += Math.max(0, cat.lives);
  }
  return lives;
}

/**
 * Compute the full score breakdown, lines in gameloop.md §7 table order.
 * `livesRemaining` is the SURVIVAL count — pass `survivingLives(run)`, which
 * counts only the cats that were fielded (dead cats contribute 0); it and the
 * flat victory bonus appear on victory only. `discoveries` is optional so a
 * caller with only counters in hand still gets a valid table.
 */
export function computeScore(
  counters: ScoreCounters,
  victory: boolean,
  livesRemaining: number,
  discoveries: Discoveries = { eventsSurvived: 0, relicsFound: 0 },
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
  push("catPiles", counters.catPiles);
  push("eventsSurvived", discoveries.eventsSurvived);
  push("relicsFound", discoveries.relicsFound);
  push("shiniesCollected", counters.shiniesCollected);
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
