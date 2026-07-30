/**
 * c(at)rpg — seeded RNG. The ONLY randomness code in the repo
 * (ARCHITECTURE.md §4; dungeon.md §2 is the canonical spec).
 *
 * Single algorithm everywhere: FNV-1a string hash + mulberry32 PRNG.
 * Streams are seeded via `mulberry32(hash(...parts))` per the §4 stream table;
 * an Rng instance is created at the boundary and passed DOWN into core
 * functions — core never seeds itself. `Math.random()` is legal only in
 * `src/ui` for visuals and must never touch a gameplay Rng.
 *
 * Frozen implementation — tests/rng.spec.ts carries known-answer vectors.
 */
import type { Rng } from "./types";

/** 32-bit FNV-1a hash of a string (offset basis 0x811c9dc5, prime 0x01000193). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stream seed derivation: FNV-1a over the `'|'`-joined parts. */
export const hash = (...parts: (string | number)[]): number =>
  fnv1a(parts.join("|"));

/** mulberry32 PRNG wrapped in the shared `Rng` interface. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    /** Uniform draw in [0, 1). */
    float() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** Uniform integer draw, inclusive on BOTH ends. Consumes one float(). */
    int(lo, hi) {
      return lo + Math.floor(this.float() * (hi - lo + 1));
    },
  };
}
