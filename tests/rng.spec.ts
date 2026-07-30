/**
 * WP-01 acceptance tests: known-answer RNG vectors, int() bounds property,
 * and core/util helpers (roundHalfUp, clamp, weighted picks, shuffle, bitset).
 */
import { describe, expect, it } from "vitest";
import { fnv1a, hash, mulberry32 } from "../src/core/rng";
import {
  clamp,
  decodeBitset,
  encodeBitset,
  pickWeighted,
  pickWeightedFloat,
  roundHalfUp,
  shuffle,
} from "../src/core/util";
import type { Rng } from "../src/core/types";

/** Scripted Rng for deterministic helper tests. */
function scriptedRng(floats: number[]): Rng {
  let i = 0;
  return {
    float() {
      if (i >= floats.length) throw new Error("scriptedRng exhausted");
      return floats[i++];
    },
    int(lo, hi) {
      return lo + Math.floor(this.float() * (hi - lo + 1));
    },
  };
}

describe("fnv1a / hash", () => {
  it("returns the FNV-1a offset basis for the empty string", () => {
    expect(fnv1a("")).toBe(0x811c9dc5); // 2166136261
  });

  it("hash('MEOW-1987', 1, 'gen') matches the recorded known answer", () => {
    expect(hash("MEOW-1987", 1, "gen")).toBe(503046646);
    // hash() is fnv1a over the '|'-joined parts:
    expect(fnv1a("MEOW-1987|1|gen")).toBe(503046646);
  });

  it("distinguishes the validation-retry stream suffixes", () => {
    const seeds = [
      hash("MEOW-1987", 1, "gen"),
      hash("MEOW-1987", 1, "gen1"),
      hash("MEOW-1987", 1, "gen2"),
      hash("MEOW-1987", 1, "pop"),
    ];
    expect(new Set(seeds).size).toBe(4);
  });
});

describe("mulberry32", () => {
  it("first 10 float() draws of mulberry32(hash('MEOW-1987', 1, 'gen')) match the recorded vectors", () => {
    const rng = mulberry32(hash("MEOW-1987", 1, "gen"));
    const draws = Array.from({ length: 10 }, () => rng.float());
    expect(draws).toEqual([
      0.15223985048942268, 0.1021823778282851, 0.1104258589912206,
      0.03222662000916898, 0.010693268151953816, 0.08720410871319473,
      0.4918888749089092, 0.2603061287663877, 0.020882541313767433,
      0.5696368410717696,
    ]);
  });

  it("same seed produces the identical stream (determinism)", () => {
    const a = mulberry32(503046646);
    const b = mulberry32(503046646);
    for (let i = 0; i < 100; i++) expect(a.float()).toBe(b.float());
  });

  it("float() stays in [0, 1)", () => {
    const rng = mulberry32(0xdeadbeef);
    for (let i = 0; i < 10_000; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("int(lo, hi) is inclusive on both ends and never escapes the bounds", () => {
    const cases: [number, number][] = [
      [0, 2],
      [1, 100],
      [-3, 3],
      [5, 5],
    ];
    for (const [lo, hi] of cases) {
      const rng = mulberry32(hash("bounds", lo, hi));
      const seen = new Set<number>();
      for (let i = 0; i < 5_000; i++) {
        const n = rng.int(lo, hi);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(lo);
        expect(n).toBeLessThanOrEqual(hi);
        seen.add(n);
      }
      // Both endpoints must actually occur (inclusive contract).
      expect(seen.has(lo)).toBe(true);
      expect(seen.has(hi)).toBe(true);
      expect(seen.size).toBe(hi - lo + 1);
    }
  });

  it("int() consumes exactly one float() draw", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    a.int(0, 9);
    b.float();
    expect(a.float()).toBe(b.float());
  });
});

describe("roundHalfUp / clamp", () => {
  it("rounds .5 up, per the combat.md §3 / loot.md §3 rule", () => {
    expect(roundHalfUp(7.5)).toBe(8);
    expect(roundHalfUp(6.4)).toBe(6);
    expect(roundHalfUp(6.5)).toBe(7);
    expect(roundHalfUp(6.6)).toBe(7);
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(2.475)).toBe(2);
  });

  it("clamp pins to the inclusive range", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-4, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
    expect(clamp(1, 1, 10)).toBe(1);
    expect(clamp(10, 1, 10)).toBe(10);
  });
});

describe("pickWeighted (d100 cumulative)", () => {
  const table = [
    { id: "stray", weight: 55 },
    { id: "sleek", weight: 35 },
    { id: "pedigree", weight: 9 },
    { id: "mewthical", weight: 1 },
  ];

  it("maps the d100 roll onto cumulative ranges (1-55 / 56-90 / 91-99 / 100)", () => {
    // int(1,100) = 1 + floor(f*100) → f chosen to force each band edge.
    const w = (x: { weight: number }) => x.weight;
    expect(pickWeighted(scriptedRng([0.0]), table, w).id).toBe("stray"); // roll 1
    expect(pickWeighted(scriptedRng([0.54]), table, w).id).toBe("stray"); // roll 55
    expect(pickWeighted(scriptedRng([0.55]), table, w).id).toBe("sleek"); // roll 56
    expect(pickWeighted(scriptedRng([0.89]), table, w).id).toBe("sleek"); // roll 90
    expect(pickWeighted(scriptedRng([0.9]), table, w).id).toBe("pedigree"); // roll 91
    expect(pickWeighted(scriptedRng([0.98]), table, w).id).toBe("pedigree"); // roll 99
    expect(pickWeighted(scriptedRng([0.99]), table, w).id).toBe("mewthical"); // roll 100
  });

  it("is deterministic for a given seed and consumes exactly one draw", () => {
    const a = mulberry32(hash("pick", 7));
    const b = mulberry32(hash("pick", 7));
    const picks1 = Array.from(
      { length: 20 },
      () => pickWeighted(a, table, (x) => x.weight).id,
    );
    const picks2 = Array.from(
      { length: 20 },
      () => pickWeighted(b, table, (x) => x.weight).id,
    );
    expect(picks1).toEqual(picks2);
    expect(a.float()).toBe(b.float()); // streams still in lockstep → 1 draw per pick
  });

  it("throws on an empty pool", () => {
    expect(() => pickWeighted(mulberry32(1), [], () => 1)).toThrow();
  });
});

describe("pickWeightedFloat (events.md §2.2 outcome roll)", () => {
  const outcomes = [
    { text: "good", weight: 70 },
    { text: "bad", weight: 30 },
  ];

  it("walks one float() draw against cumulative weights", () => {
    const w = (o: { weight: number }) => o.weight;
    expect(pickWeightedFloat(scriptedRng([0.0]), outcomes, w).text).toBe(
      "good",
    );
    expect(pickWeightedFloat(scriptedRng([0.699]), outcomes, w).text).toBe(
      "good",
    );
    expect(pickWeightedFloat(scriptedRng([0.7]), outcomes, w).text).toBe("bad");
    expect(pickWeightedFloat(scriptedRng([0.999]), outcomes, w).text).toBe(
      "bad",
    );
  });

  it("is deterministic and consumes exactly one draw", () => {
    const a = mulberry32(hash("outcome", 3));
    const b = mulberry32(hash("outcome", 3));
    for (let i = 0; i < 10; i++) {
      expect(pickWeightedFloat(a, outcomes, (o) => o.weight).text).toBe(
        pickWeightedFloat(b, outcomes, (o) => o.weight).text,
      );
    }
    expect(a.float()).toBe(b.float());
  });
});

describe("shuffle (Fisher-Yates)", () => {
  it("is deterministic: same seed → same permutation", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const s1 = shuffle(items, mulberry32(hash("MEOW-1987", 1, "gen")));
    const s2 = shuffle(items, mulberry32(hash("MEOW-1987", 1, "gen")));
    expect(s1).toEqual(s2);
    expect([...s1].sort()).toEqual([...items].sort()); // a permutation
  });

  it("does not mutate its input and consumes exactly n-1 int(0, i) draws", () => {
    const items = [1, 2, 3, 4, 5];
    const frozen = [...items];
    const a = mulberry32(99);
    const b = mulberry32(99);
    shuffle(items, a);
    for (let i = items.length - 1; i >= 1; i--) b.int(0, i);
    expect(items).toEqual(frozen);
    expect(a.float()).toBe(b.float()); // draw counts identical
  });

  it("applies swaps per dungeon.md §5.3: j = int(0, i) for i = n-1..1", () => {
    // Scripted draws: i=3 → j=0, i=2 → j=2 (no-op), i=1 → j=1 (no-op)
    const rng = scriptedRng([0.0, 0.99, 0.99]);
    expect(shuffle(["A", "B", "C", "D"], rng)).toEqual(["D", "B", "C", "A"]);
  });
});

describe("base64 bitset", () => {
  it("round-trips arbitrary bitsets at non-multiple-of-8 lengths", () => {
    for (const len of [1, 7, 8, 9, 21 * 31, 100]) {
      const rng = mulberry32(hash("bitset", len));
      const bits = new Uint8Array(len);
      for (let i = 0; i < len; i++) bits[i] = rng.float() < 0.5 ? 1 : 0;
      const enc = encodeBitset(bits);
      expect(enc).toMatch(/^[A-Za-z0-9+/]*={0,2}$/); // valid base64
      expect(Array.from(decodeBitset(enc, len))).toEqual(Array.from(bits));
    }
  });

  it("encodes all-zero and all-one edge cases", () => {
    expect(
      Array.from(decodeBitset(encodeBitset(new Uint8Array(16)), 16)),
    ).toEqual(new Array(16).fill(0));
    const ones = new Uint8Array(16).fill(1);
    expect(Array.from(decodeBitset(encodeBitset(ones), 16))).toEqual(
      new Array(16).fill(1),
    );
    expect(encodeBitset(new Uint8Array(0))).toBe("");
  });

  it("packs LSB-first (bit 0 → byte 0 bit 0)", () => {
    // bits [1,0,0,0,0,0,0,0] → byte 0x01 → base64 'AQ=='
    const bits = new Uint8Array(8);
    bits[0] = 1;
    expect(encodeBitset(bits)).toBe("AQ==");
  });
});
