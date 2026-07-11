const BPS_DENOMINATOR = 10_000n;

/** Rounds down (floors), per the project's minOut-must-round-DOWN rule. */
export function computeMinOut(expectedOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be within [0, 10000], got ${slippageBps}`);
  }
  const retainedBps = BPS_DENOMINATOR - BigInt(slippageBps);
  return (expectedOut * retainedBps) / BPS_DENOMINATOR;
}

export function computeDeadline(ttlSeconds: number, nowSeconds: bigint): bigint {
  if (ttlSeconds <= 0) {
    throw new RangeError(`ttlSeconds must be positive, got ${ttlSeconds}`);
  }
  return nowSeconds + BigInt(ttlSeconds);
}
