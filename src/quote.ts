import type { Address, PublicClient } from "viem";
import { UniV3Adapter } from "./adapters/univ3.js";
import type { VenueAdapter } from "./adapters/adapter.js";
import { assertChainId, createClient, loadConfig } from "./config.js";
import { planChunks } from "./chunker.js";
import { PriceImpactExceededError } from "./errors.js";
import { computeDeadline, computeMinOut } from "./math.js";
import { findBestRoute } from "./router.js";
import type { ChunkedQuote, Quote, Route, VenueInfo, ZipSwapConfig } from "./types.js";
import VENUES from "./registry/VENUES.json" with { type: "json" };

const PROBE_AMOUNT = 1_000_000n;

export function buildAdapters(client: PublicClient): VenueAdapter[] {
  const venue = VENUES.venues[0]!;
  return [
    new UniV3Adapter(
      client,
      venue.contracts.factory.address as Address,
      venue.contracts.quoterV2.address as Address,
    ),
  ];
}

function toQuote(
  route: Route,
  tokenIn: Address,
  config: ZipSwapConfig,
  amountIn: bigint,
  slippageBps: number,
  quotedAtBlock: bigint,
): Quote {
  const ttl = config.quoteTtlSeconds.standard;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  return {
    tokenIn,
    tokenOut: config.usdc,
    amountIn,
    route,
    expectedOut: route.expectedOut,
    minOut: computeMinOut(route.expectedOut, slippageBps),
    priceImpactBps: route.priceImpactBps,
    gasEstimate: route.gasEstimate,
    quotedAtBlock,
    ttl,
    slippageBps,
    deadline: computeDeadline(ttl, nowSeconds),
  };
}

export interface GetQuoteParams {
  tokenIn: Address;
  amountIn: bigint;
  slippageBps?: number;
  config?: ZipSwapConfig;
}

/**
 * Read-only: routes tokenIn -> USDC, applies slippage/deadline bounds. No
 * signer required. Tier-aware slippage/TTL defaults (via classify()) land in
 * a later phase — for now this uses the "standard" tier defaults uniformly.
 *
 * Returns a ChunkedQuote instead of throwing when a single-shot route would
 * exceed maxPriceImpactBps but splitting the order into smaller pieces
 * brings each piece back under the ceiling.
 */
export async function getQuote(params: GetQuoteParams): Promise<Quote | ChunkedQuote> {
  const config = params.config ?? loadConfig();
  const client = createClient(config);
  await assertChainId(client, config);

  const adapters = buildAdapters(client);
  const slippageBps = params.slippageBps ?? config.defaultSlippageBps.standard;
  const quotedAtBlock = await client.getBlockNumber();

  const routeParams = {
    tokenIn: params.tokenIn,
    tokenOut: config.usdc,
    adapters,
    connectors: config.connectors,
    maxPriceImpactBps: config.maxPriceImpactBps,
  };

  try {
    const route = await findBestRoute({ ...routeParams, amountIn: params.amountIn });
    return toQuote(route, params.tokenIn, config, params.amountIn, slippageBps, quotedAtBlock);
  } catch (error) {
    if (!(error instanceof PriceImpactExceededError)) throw error;

    const plan = await planChunks({ ...routeParams, totalAmountIn: params.amountIn });
    const chunks = plan.routes.map((route, i) =>
      toQuote(route, params.tokenIn, config, plan.amounts[i]!, slippageBps, quotedAtBlock),
    );
    return {
      chunks,
      totalAmountIn: params.amountIn,
      totalExpectedOut: chunks.reduce((sum, c) => sum + c.expectedOut, 0n),
    };
  }
}

/** Static introspection — every venue this build of zip-swap can route through. */
export function listVenues(): VenueInfo[] {
  return VENUES.venues.map((venue) => ({
    name: venue.name,
    kind: venue.kind as VenueInfo["kind"],
    router: venue.contracts.swapRouter02.address as Address,
  }));
}

export interface IsSupportedParams {
  config?: ZipSwapConfig;
}

/** Whether `token` currently has a live, quotable route to USDC. Never throws. */
export async function isSupported(token: Address, params: IsSupportedParams = {}): Promise<boolean> {
  const config = params.config ?? loadConfig();
  const client = createClient(config);

  try {
    await assertChainId(client, config);
    const adapters = buildAdapters(client);
    await findBestRoute({
      tokenIn: token,
      tokenOut: config.usdc,
      amountIn: PROBE_AMOUNT,
      adapters,
      connectors: config.connectors,
      maxPriceImpactBps: config.maxPriceImpactBps,
    });
    return true;
  } catch (error) {
    if (error instanceof PriceImpactExceededError) return true; // a route exists, just not at this probe size
    return false;
  }
}
