import { describe, expect, it } from "vitest";
import { computeDeadline, computeMinOut } from "../../src/math.js";

describe("computeMinOut", () => {
  it("applies default 50bps slippage exactly", () => {
    expect(computeMinOut(1_000_000n, 50)).toBe(995_000n);
  });

  it("returns expectedOut unchanged at 0bps slippage", () => {
    expect(computeMinOut(1_234_567n, 0)).toBe(1_234_567n);
  });

  it("returns 0 at 10000bps (100%) slippage", () => {
    expect(computeMinOut(1_234_567n, 10_000)).toBe(0n);
  });

  it("rounds DOWN when the division isn't exact", () => {
    // 1_000_000_007 * 9999 / 10000 = 999_900_006.2993 -> must floor to 999_900_006, never round up to ...07
    const result = computeMinOut(1_000_000_007n, 1);
    expect(result).toBe(999_900_006n);
  });

  it("rounds DOWN for a second non-exact case", () => {
    // 7n * 9950 / 10000 = 6.965 -> floor to 6
    const result = computeMinOut(7n, 50);
    expect(result).toBe(6n);
  });

  it("never returns more than expectedOut", () => {
    const result = computeMinOut(3n, 1);
    expect(result).toBeLessThanOrEqual(3n);
  });

  it("throws RangeError for out-of-range slippageBps", () => {
    expect(() => computeMinOut(100n, -1)).toThrow(RangeError);
    expect(() => computeMinOut(100n, 10_001)).toThrow(RangeError);
  });
});

describe("computeDeadline", () => {
  it("adds ttlSeconds to nowSeconds", () => {
    expect(computeDeadline(60, 1_000_000n)).toBe(1_000_060n);
  });

  it("throws RangeError for non-positive ttlSeconds", () => {
    expect(() => computeDeadline(0, 1_000_000n)).toThrow(RangeError);
    expect(() => computeDeadline(-5, 1_000_000n)).toThrow(RangeError);
  });
});
