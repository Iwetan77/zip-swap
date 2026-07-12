import type { Address, Hex } from "viem";

export type TokenTier = "stable" | "major" | "standard" | "degen" | "blocked";

export interface Token {
  address: Address;
  symbol: string;
  decimals: number;
  tier: TokenTier;
  transferTaxBps?: number;
}

export interface RouteHop {
  venue: string;
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
  poolMeta?: Record<string, unknown>;
}

export interface Route {
  hops: RouteHop[];
  expectedOut: bigint;
  priceImpactBps: number;
  gasEstimate: bigint;
}

export interface Quote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  route: Route;
  expectedOut: bigint;
  minOut: bigint;
  priceImpactBps: number;
  gasEstimate: bigint;
  quotedAtBlock: bigint;
  ttl: number;
  slippageBps: number;
  deadline: bigint;
  /** Tier tokenIn was classified as — drives the default slippageBps/ttl above. Excludes "blocked": a blocked token never reaches a Quote. */
  tier: Exclude<TokenTier, "blocked">;
}

export interface ChunkedQuote {
  chunks: Quote[];
  totalAmountIn: bigint;
  totalExpectedOut: bigint;
}

export interface SwapPrerequisite {
  to: Address;
  data: Hex;
  value: bigint;
  description: string;
}

export interface SwapTx {
  to: Address;
  data: Hex;
  value: bigint;
  prerequisites: SwapPrerequisite[];
  minOut: bigint;
  deadline: bigint;
  simulatedOut: bigint;
}

export interface SwapReceipt {
  txHash: Hex;
  amountIn: bigint;
  amountOut: bigint;
  recipient: Address;
}

export interface VenueInfo {
  name: string;
  kind: "univ2" | "univ3" | "stable" | "clob";
  router: Address;
}

export interface ZipSwapConfig {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
  connectors: Address[];
  defaultSlippageBps: Record<Exclude<TokenTier, "blocked">, number>;
  quoteTtlSeconds: Record<Exclude<TokenTier, "blocked">, number>;
  maxPriceImpactBps: number;
}
