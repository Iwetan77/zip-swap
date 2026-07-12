import type { Address, PublicClient } from "viem";
import { UniV3Adapter } from "./adapters/univ3.js";
import type { VenueAdapter } from "./adapters/adapter.js";
import { assertChainId, createClient, loadConfig } from "./config.js";
import { planChunks } from "./chunker.js";
import { PriceImpactExceededError, TaxUnawareAdapterError, UnsafeTokenError } from "./errors.js";
import { computeDeadline, computeMinOut } from "./math.js";
import { findBestRoute } from "./router.js";
import { assertSafe, classify, ClassificationCache, type ClassificationResult } from "./safety.js";
import type { ChunkedQuote, Quote, Route, TokenTier, VenueInfo, ZipSwapConfig } from "./types.js";
import DEFAULT_VENUES from "./registry/VENUES.json" with { type: "json" };

export type Registry = typeof DEFAULT_VENUES;

const PROBE_AMOUNT = 1_000_000n;

/** Shared across calls so a tier's TTL (per ClassificationCache) is actually load-bearing — a fresh cache per call would defeat it. Exported read-only for test inspection. */
export const classificationCache = new ClassificationCache();

function isSameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function buildAdapters(client: PublicClient, registry: Registry = DEFAULT_VENUES): VenueAdapter[] {
  const venue = registry.venues[0]!;
  return [
    new UniV3Adapter(
      client,
      venue.contracts.factory.address as Address,
      venue.contracts.quoterV2.address as Address,
    ),
  ];
}

function registrySupportsFeeOnTransfer(registry: Registry): boolean {
  return registry.venues.some((venue) => venue.capabilities?.supportsFeeOnTransfer === true);
}

async function getClassification(
  client: PublicClient,
  token: Address,
  config: ZipSwapConfig,
  registry: Registry,
): Promise<ClassificationResult> {
  const cached = classificationCache.get(token);
  if (cached) return cached;

  const venue = registry.venues[0]!;
  const result = await classify({
    client,
    token,
    usdc: config.usdc,
    factory: venue.contracts.factory.address as Address,
    quoterV2: venue.contracts.quoterV2.address as Address,
    connectors: config.connectors,
  });
  classificationCache.set(token, result);
  return result;
}

/**
 * Gates a token before it's allowed anywhere near routing:
 * - `blocked` tokens (honeypots, unreadable ERC20s, etc.) throw UnsafeTokenError.
 * - fee-on-transfer tokens throw UnsafeTokenError unless some registered venue
 *   actually supports taxed transfers (none do while UniswapV3 is the only
 *   verified venue — see VENUES.json's capabilities block). The 2% tolerance
 *   in classify() is untouched and becomes load-bearing again automatically
 *   the day a FOT-capable venue is verified; this gate does not weaken it.
 */
async function assertQuotable(
  client: PublicClient,
  token: Address,
  config: ZipSwapConfig,
  registry: Registry,
): Promise<ClassificationResult> {
  const classification = await getClassification(client, token, config, registry);
  assertSafe(token, classification);

  if (classification.transferTaxBps > 0 && !registrySupportsFeeOnTransfer(registry)) {
    throw new UnsafeTokenError(
      token,
      "fee-on-transfer token: no verified venue can execute taxed transfers (UniswapV3 architectural limitation)",
    );
  }

  return classification;
}

/**
 * Guards the FOT-allowed branch: a venue can declare supportsFeeOnTransfer,
 * but that only means *some* adapter for it might quote net of tax — it
 * doesn't mean the one that actually won this route does. Flipping the
 * capability flag without a tax-aware adapter must fail loudly here rather
 * than silently overstating expectedOut for a taxed token. No-op for
 * zero-tax tokens.
 */
function assertTaxAwareRoute(route: Route, adapters: VenueAdapter[], transferTaxBps: number): void {
  if (transferTaxBps <= 0) return;
  for (const hop of route.hops) {
    const adapter = adapters.find((a) => a.name === hop.venue);
    if (adapter && !adapter.quotesNetOfTax) {
      throw new TaxUnawareAdapterError(adapter.name, transferTaxBps);
    }
  }
}

function toQuote(
  route: Route,
  tokenIn: Address,
  config: ZipSwapConfig,
  amountIn: bigint,
  slippageBps: number,
  quotedAtBlock: bigint,
  tier: Exclude<TokenTier, "blocked">,
): Quote {
  const ttl = config.quoteTtlSeconds[tier];
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
    tier,
  };
}

export interface GetQuoteParams {
  tokenIn: Address;
  amountIn: bigint;
  slippageBps?: number;
  config?: ZipSwapConfig;
  /** Test-only: inject a registry fixture instead of the real VENUES.json. */
  registry?: Registry;
}

/**
 * Read-only: routes tokenIn -> USDC, applies slippage/deadline bounds. No
 * signer required. Every non-USDC tokenIn is classified on-chain first —
 * blocked and unfillable fee-on-transfer tokens throw UnsafeTokenError
 * before any adapter is ever called.
 *
 * Returns a ChunkedQuote instead of throwing when a single-shot route would
 * exceed maxPriceImpactBps but splitting the order into smaller pieces
 * brings each piece back under the ceiling.
 */
export async function getQuote(params: GetQuoteParams): Promise<Quote | ChunkedQuote> {
  const config = params.config ?? loadConfig();
  const registry = params.registry ?? DEFAULT_VENUES;
  const client = createClient(config);
  await assertChainId(client, config);

  const isUsdcItself = isSameAddress(params.tokenIn, config.usdc);
  let tier: Exclude<TokenTier, "blocked"> = "stable";
  let transferTaxBps = 0;

  if (!isUsdcItself) {
    const classification = await assertQuotable(client, params.tokenIn, config, registry);
    tier = classification.tier as Exclude<TokenTier, "blocked">;
    transferTaxBps = classification.transferTaxBps;
  }

  const adapters = buildAdapters(client, registry);
  const slippageBps = params.slippageBps ?? config.defaultSlippageBps[tier];
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
    assertTaxAwareRoute(route, adapters, transferTaxBps);
    return toQuote(route, params.tokenIn, config, params.amountIn, slippageBps, quotedAtBlock, tier);
  } catch (error) {
    if (!(error instanceof PriceImpactExceededError)) throw error;

    const plan = await planChunks({ ...routeParams, totalAmountIn: params.amountIn });
    for (const chunkRoute of plan.routes) {
      assertTaxAwareRoute(chunkRoute, adapters, transferTaxBps);
    }
    const chunks = plan.routes.map((route, i) =>
      toQuote(route, params.tokenIn, config, plan.amounts[i]!, slippageBps, quotedAtBlock, tier),
    );
    return {
      chunks,
      totalAmountIn: params.amountIn,
      totalExpectedOut: chunks.reduce((sum, c) => sum + c.expectedOut, 0n),
    };
  }
}

/** Static introspection — every venue this build of zip-swap can route through. */
export function listVenues(registry: Registry = DEFAULT_VENUES): VenueInfo[] {
  return registry.venues.map((venue) => ({
    name: venue.name,
    kind: venue.kind as VenueInfo["kind"],
    router: venue.contracts.swapRouter02.address as Address,
  }));
}

export interface IsSupportedParams {
  config?: ZipSwapConfig;
  registry?: Registry;
}

/**
 * Whether `token` currently has a live, quotable route to USDC. Answers
 * through the exact same gate as getQuote (classification + FOT-capability
 * check, then routing) so the two can never silently drift — this is
 * literally `!throws(getQuote)`, never a separate check. Never throws.
 */
export async function isSupported(token: Address, params: IsSupportedParams = {}): Promise<boolean> {
  const config = params.config ?? loadConfig();
  const registry = params.registry ?? DEFAULT_VENUES;
  const client = createClient(config);

  try {
    await assertChainId(client, config);
    let transferTaxBps = 0;
    if (!isSameAddress(token, config.usdc)) {
      const classification = await assertQuotable(client, token, config, registry);
      transferTaxBps = classification.transferTaxBps;
    }
    const adapters = buildAdapters(client, registry);
    const route = await findBestRoute({
      tokenIn: token,
      tokenOut: config.usdc,
      amountIn: PROBE_AMOUNT,
      adapters,
      connectors: config.connectors,
      maxPriceImpactBps: config.maxPriceImpactBps,
    });
    assertTaxAwareRoute(route, adapters, transferTaxBps);
    return true;
  } catch (error) {
    if (error instanceof PriceImpactExceededError) return true; // a route exists, just not at this probe size
    return false;
  }
}
