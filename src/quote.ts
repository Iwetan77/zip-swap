import type { Address } from "viem";
import { UniV3Adapter } from "./adapters/univ3.js";
import type { VenueAdapter } from "./adapters/adapter.js";
import { assertChainId, createClient, loadConfig } from "./config.js";
import { computeDeadline, computeMinOut } from "./math.js";
import { findBestRoute } from "./router.js";
import type { Quote, ZipSwapConfig } from "./types.js";
import VENUES from "./registry/VENUES.json" with { type: "json" };

function buildAdapters(client: ReturnType<typeof createClient>): VenueAdapter[] {
  const venue = VENUES.venues[0]!;
  return [
    new UniV3Adapter(
      client,
      venue.contracts.factory.address as Address,
      venue.contracts.quoterV2.address as Address,
    ),
  ];
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
 */
export async function getQuote(params: GetQuoteParams): Promise<Quote> {
  const config = params.config ?? loadConfig();
  const client = createClient(config);
  await assertChainId(client, config);

  const adapters = buildAdapters(client);
  const route = await findBestRoute({
    tokenIn: params.tokenIn,
    tokenOut: config.usdc,
    amountIn: params.amountIn,
    adapters,
    connectors: config.connectors,
    maxPriceImpactBps: config.maxPriceImpactBps,
  });

  const slippageBps = params.slippageBps ?? config.defaultSlippageBps.standard;
  const ttl = config.quoteTtlSeconds.standard;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  return {
    tokenIn: params.tokenIn,
    tokenOut: config.usdc,
    amountIn: params.amountIn,
    route,
    expectedOut: route.expectedOut,
    minOut: computeMinOut(route.expectedOut, slippageBps),
    priceImpactBps: route.priceImpactBps,
    gasEstimate: route.gasEstimate,
    quotedAtBlock: await client.getBlockNumber(),
    ttl,
    slippageBps,
    deadline: computeDeadline(ttl, nowSeconds),
  };
}
