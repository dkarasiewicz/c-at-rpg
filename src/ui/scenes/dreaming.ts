/**
 * THE DREAMING, screen side — priming, and the mark.
 *
 * Two jobs, both small, both shared by every scene that can show a dream:
 *
 * 1. **Prime, never wait.** `primeFloorDreams` warms the pool for a floor and
 *    returns immediately. Nothing in the game awaits the network to enter a
 *    floor; a decision taken before the prime lands simply sees an empty pool
 *    and rolls the authored content, which is the same thing it does when the
 *    pool is switched off. That is the offline-first invariant, unchanged.
 *
 * 2. **Say so.** Content that arrived from the shared world must not look like
 *    content that shipped in the box — the pool existing is only a reward if
 *    the player can SEE it. `dreamChip` is that mark: one small gold-outlined
 *    pill, the same one everywhere, reading "dreamed by another stray" when a
 *    DM dreamed it during somebody's run and "from the dreaming" when it came
 *    from the world's first generation.
 *
 * Everything here is chrome and orchestration. The decision of WHETHER a dream
 * is used belongs to the seeded engines (`core/loot/dreamed.ts`), and the
 * decision of whether a row is SAFE belongs to the arrival gate
 * (`services/pool.ts`). This file only shows the result.
 */
import { Container, Graphics } from "pixi.js";
import { RADIUS, SPACE } from "../layout.js";
import { TYPE } from "../textStyles.js";
import { label } from "../widgets.js";
import { dreamedTag, type DreamedOrigin } from "../../core/loot/dreamed.js";
import { primeDreaming } from "../../services/pool.js";
import type { RunState } from "../../core/types.js";

/**
 * Warm the pool for the floor the party is on, and for the one after it, so
 * the descent never races the fetch. Fire and forget by design: the promise is
 * dropped on purpose and every failure inside it is already swallowed.
 */
export function primeFloorDreams(
  run: Pick<RunState, "floorNum">,
): Promise<void> {
  if (run.floorNum < 6) void primeDreaming(run.floorNum + 1);
  // Returned for the ONE caller that wants to repaint when it lands (the run
  // map's floor name). It never rejects, and awaiting it is never required.
  return primeDreaming(run.floorNum);
}

/** The mark's ink. Violet, so it reads as neither gold "active" nor plain. */
export const DREAM_INK = 0xb9a6ff;

/**
 * The mark: `◈ dreamed by another stray`. Anchored top-left, sized to its own
 * text, so a caller can drop it under a name, beside a card or into a row.
 */
export function dreamChip(origin: DreamedOrigin): Container {
  const view = new Container();
  const t = label(`◈ ${dreamedTag(origin)}`, {
    size: TYPE.tiny,
    mono: true,
    fill: DREAM_INK,
  });
  const w = Math.ceil(t.width) + SPACE.md * 2;
  const h = Math.ceil(t.height) + 6;
  t.position.set(SPACE.md, 3);
  view.addChild(
    new Graphics()
      .roundRect(0, 0, w, h, RADIUS.chip)
      .fill({ color: DREAM_INK, alpha: 0.12 })
      .stroke({ width: 1, color: DREAM_INK, alpha: 0.55 }),
    t,
  );
  return view;
}

/** The same sentence as one loot-panel delta line, for `LootOverlayParams`. */
export function dreamLine(
  origin: DreamedOrigin,
  what: string,
): { text: string; tone: "buff" } {
  return { text: `◈ ${what} — ${dreamedTag(origin)}`, tone: "buff" };
}
