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
  /** True iff this adapter's quoted expectedOut already accounts for the input token's transfer tax. A venue flagged supportsFeeOnTransfer whose adapter still quotes false here means routing must refuse taxed tokens through it — see quote.ts's TaxUnawareAdapterError guard. */
  quotesNetOfTax: boolean;
  /** Returns null (never throws) when this venue has no path for the pair. */
  getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<AdapterQuote | null>;
}
