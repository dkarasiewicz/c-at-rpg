/**
 * c(at)rpg — pure shared helpers (ARCHITECTURE.md §1: core/util.ts).
 * Zero pixi, zero DOM, zero self-seeded randomness — every random helper takes
 * an `Rng` argument and consumes exactly the documented number of draws.
 */
import type { Rng } from "./types.js";

/**
 * Round half UP (0.5 always rounds toward +∞), the game-wide `round`:
 * combat.md §3 damage step 6, loot.md §3 value formulas.
 * roundHalfUp(7.5) === 8, roundHalfUp(6.4) === 6.
 */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** Clamp `x` into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Weighted pick, d100-style against cumulative weights (loot.md §5):
 * one `rng.int(1, total)` draw walked over the cumulative weight ranges.
 * With weights summing to 100 this is exactly a d100 roll. Exactly 1 draw.
 * Throws on an empty list or non-positive total (callers guard empty pools).
 */
export function pickWeighted<T>(
  rng: Rng,
  items: readonly T[],
  weightOf: (item: T) => number,
): T {
  const total = items.reduce((sum, it) => sum + weightOf(it), 0);
  if (items.length === 0 || total <= 0) {
    throw new Error("pickWeighted: empty pool or non-positive total weight");
  }
  const roll = rng.int(1, total); // 1..total, inclusive
  let acc = 0;
  for (const it of items) {
    acc += weightOf(it);
    if (roll <= acc) return it;
  }
  return items[items.length - 1]; // unreachable; guards float paranoia
}

/**
 * Weighted pick via one `float()` draw walked against cumulative weights
 * (events.md §2.2 outcome roll). Exactly 1 draw. Same guards as pickWeighted.
 */
export function pickWeightedFloat<T>(
  rng: Rng,
  items: readonly T[],
  weightOf: (item: T) => number,
): T {
  const total = items.reduce((sum, it) => sum + weightOf(it), 0);
  if (items.length === 0 || total <= 0) {
    throw new Error(
      "pickWeightedFloat: empty pool or non-positive total weight",
    );
  }
  const roll = rng.float() * total; // [0, total)
  let acc = 0;
  for (const it of items) {
    acc += weightOf(it);
    if (roll < acc) return it;
  }
  return items[items.length - 1];
}

/**
 * Fisher-Yates shuffle, dungeon.md §5.3 contract: for i = n-1 down to 1,
 * one `rng.int(0, i)` draw per swap (n-1 draws total). Returns a NEW array;
 * the input is not mutated.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i >= 1; i--) {
    const j = rng.int(0, i);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/* -------------------------------------------------------------- */
/* base64 bitset (FloorDelta.explored save shape, gameloop.md §8) */
/* -------------------------------------------------------------- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i;

/**
 * Encode a 0|1 bitset (e.g. `FloorState.explored`) as base64.
 * Bits pack LSB-first into bytes (bit i → byte i>>3, position i&7),
 * then standard base64 with '=' padding. No DOM `btoa` — pure core.
 */
export function encodeBitset(bits: Uint8Array | readonly number[]): string {
  const byteLen = Math.ceil(bits.length / 8);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  let out = "";
  for (let i = 0; i < byteLen; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < byteLen ? bytes[i + 1] : 0;
    const b2 = i + 2 < byteLen ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < byteLen ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < byteLen ? B64[b2 & 0x3f] : "=";
  }
  return out;
}

/**
 * Decode `encodeBitset` output back into a Uint8Array of 0|1 values of
 * exactly `bitLength` bits (trailing pad bits discarded).
 */
export function decodeBitset(encoded: string, bitLength: number): Uint8Array {
  const clean = encoded.replace(/=+$/, "");
  const byteLen = Math.floor((clean.length * 6) / 8);
  const bytes = new Uint8Array(byteLen);
  let buffer = 0;
  let bitsInBuffer = 0;
  let bi = 0;
  for (const ch of clean) {
    const v = B64_REV[ch];
    if (v === undefined)
      throw new Error(`decodeBitset: bad base64 char '${ch}'`);
    buffer = (buffer << 6) | v;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      bytes[bi++] = (buffer >> bitsInBuffer) & 0xff;
    }
  }
  const bits = new Uint8Array(bitLength);
  for (let i = 0; i < bitLength; i++) {
    bits[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  }
  return bits;
}
