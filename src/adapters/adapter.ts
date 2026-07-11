import type { Address } from "viem";

export interface AdapterQuote {
  venue: string;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  expectedOut: bigint;
  priceImpactBps: number;
  gasEstimate: bigint;
  quotedAtBlock: bigint;
  /** Venue-specific pool identifier needed to build a swap tx later (e.g. Uniswap V3 fee tier). */
  poolMeta?: Record<string, unknown>;
}

export interface VenueAdapter {
  name: string;
  /** Returns null (never throws) when this venue has no path for the pair. */
  getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<AdapterQuote | null>;
}
