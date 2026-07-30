/**
 * WP-08 — the whole animation budget (ui-art §12): one tween helper with
 * three eases plus a screen-shake helper. Fire-and-forget on the shared
 * ticker; never blocks engine event consumption. Visual randomness is
 * Math.random() by design (never a gameplay Rng — ARCHITECTURE.md §0).
 */
import { Ticker } from "pixi.js";

export type Ease = "linear" | "quadOut" | "backOut";

const EASES: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  quadOut: (t) => 1 - (1 - t) * (1 - t),
  backOut: (t) => {
    const c = 1.7; // overshoot (ui-art §12)
    const u = t - 1;
    return 1 + u * u * ((c + 1) * u + c);
  },
};

interface Active {
  obj: Record<string, number>;
  from: Record<string, number>;
  to: Record<string, number>;
  ms: number;
  t: number;
  ease: (t: number) => number;
  onDone?: () => void;
  dead: boolean;
}

const active: Active[] = [];
let ticking = false;

/**
 * A tween target backed by a destroyed pixi display object must never be
 * written to (its position/scale internals are nulled — writing `y` throws
 * "Cannot set properties of null"). Plain driver objects have no
 * `destroyed` and always pass.
 */
function isDestroyed(obj: object): boolean {
  return (obj as { destroyed?: unknown }).destroyed === true;
}

function ensureTicker(): void {
  if (ticking) return;
  ticking = true;
  Ticker.shared.add((ticker) => {
    const dt = ticker.deltaMS;
    for (const tw of active) {
      if (tw.dead) continue;
      // target destroyed mid-flight (scene unmount, floater cleanup, …):
      // drop the tween silently — onDone would act on a dead object.
      if (isDestroyed(tw.obj)) {
        tw.dead = true;
        continue;
      }
      tw.t += dt;
      const p = tw.t >= tw.ms ? 1 : tw.ease(tw.t / tw.ms);
      try {
        for (const k in tw.to) {
          tw.obj[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * p;
        }
      } catch {
        // e.g. an ObservablePoint whose owner was destroyed — kill the tween
        tw.dead = true;
        continue;
      }
      if (tw.t >= tw.ms) {
        tw.dead = true;
        tw.onDone?.();
      }
    }
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].dead) active.splice(i, 1);
    }
  });
}

/** The numeric, writable properties of T (what tween can animate). */
export type NumericProps<T> = {
  [K in keyof T as T[K] extends number ? K : never]?: number;
};

/**
 * Tween numeric properties of any object (a Container, its `.scale`, its
 * `.position`, a plain object…) over `ms` milliseconds. A new tween on the
 * same object+property replaces the old one.
 */
export function tween<T extends object>(
  obj: T,
  props: NumericProps<T>,
  ms: number,
  ease: Ease = "quadOut",
  onDone?: () => void,
): void {
  ensureTicker();
  if (isDestroyed(obj)) return; // reading props of a destroyed target throws
  const target = obj as unknown as Record<string, number>;
  const from: Record<string, number> = {};
  const to: Record<string, number> = {};
  for (const k in props) {
    const v = props[k];
    if (typeof v !== "number") continue;
    from[k] = target[k];
    to[k] = v;
    // replace any older tween of the same property on the same object
    for (const tw of active) {
      if (tw.obj === target && k in tw.to) delete tw.to[k];
    }
  }
  if (ms <= 0) {
    Object.assign(target, to);
    onDone?.();
    return;
  }
  active.push({
    obj: target,
    from,
    to,
    ms,
    t: 0,
    ease: EASES[ease],
    onDone,
    dead: false,
  });
}

/** Cancel every running tween on `obj` (without firing onDone). */
export function killTweens(obj: object): void {
  for (const tw of active) {
    if (tw.obj === (obj as unknown as Record<string, number>)) tw.dead = true;
  }
}

/**
 * Screen shake (ui-art §12.3): offsets `target.x/y` by a random angle with
 * amplitude decaying to 0 over `ms` (default 250). Amplitudes: 3 Poise chip
 * / KO, 5 crit / phase switch, 8 Cat Pile / boss nuke. Apply to the
 * `world`+`fx` layers only — never the HUD.
 */
export function shake(
  target: { x: number; y: number },
  amplitude: number,
  ms = 250,
): void {
  ensureTicker();
  if (isDestroyed(target)) return;
  const baseX = target.x;
  const baseY = target.y;
  const driver = { t: 0 };
  const apply = () => {
    if (isDestroyed(target)) return; // container died mid-shake (unmount)
    const decay = 1 - driver.t;
    const a = Math.random() * Math.PI * 2; // visual RNG only
    target.x = baseX + Math.cos(a) * amplitude * decay;
    target.y = baseY + Math.sin(a) * amplitude * decay;
  };
  const tick = () => apply();
  Ticker.shared.add(tick);
  tween(driver, { t: 1 }, ms, "linear", () => {
    Ticker.shared.remove(tick);
    if (isDestroyed(target)) return;
    target.x = baseX;
    target.y = baseY;
  });
}
