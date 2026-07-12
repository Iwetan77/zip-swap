import type { Address } from "viem";
import type { AdapterQuote, VenueAdapter } from "./adapters/adapter.js";
import { NoRouteError, PriceImpactExceededError } from "./errors.js";
import type { Route, RouteHop } from "./types.js";

function isSameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toHop(quote: AdapterQuote): RouteHop {
  return {
    venue: quote.venue,
    pool: quote.pool,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    ...(quote.poolMeta ? { poolMeta: quote.poolMeta } : {}),
  };
}

function directToRoute(quote: AdapterQuote): Route {
  return {
    hops: [toHop(quote)],
    expectedOut: quote.expectedOut,
    priceImpactBps: quote.priceImpactBps,
    gasEstimate: quote.gasEstimate,
  };
}

function twoHopToRoute(first: AdapterQuote, second: AdapterQuote): Route {
  return {
    hops: [toHop(first), toHop(second)],
    expectedOut: second.expectedOut,
    // Additive approximation of compounded price impact across hops — a
    // reasonable upper bound, not exact compounding (1-(1-a)(1-b)).
    priceImpactBps: first.priceImpactBps + second.priceImpactBps,
    gasEstimate: first.gasEstimate + second.gasEstimate,
  };
}

function venueKey(route: Route): string {
  return route.hops.map((hop) => hop.venue).join(">");
}

/** Highest expectedOut wins; ties broken by fewer hops, then venue-name ordering — deterministic regardless of adapter iteration order. */
function compareRoutes(a: Route, b: Route): number {
  if (a.expectedOut !== b.expectedOut) return a.expectedOut > b.expectedOut ? -1 : 1;
  if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
  const aKey = venueKey(a);
  const bKey = venueKey(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export interface FindRouteParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  adapters: VenueAdapter[];
  connectors: Address[];
  maxPriceImpactBps: number;
}

/**
 * Best-route search: direct quotes from every adapter, plus one-hop quotes
 * through each connector token (excluding tokenIn/tokenOut themselves).
 * Throws NoRouteError if nothing quotes, PriceImpactExceededError if the
 * best candidate still exceeds the configured ceiling.
 */
export async function findBestRoute(params: FindRouteParams): Promise<Route> {
  const { tokenIn, tokenOut, amountIn, adapters, connectors, maxPriceImpactBps } = params;
  const candidates: Route[] = [];

  const directQuotes = await Promise.all(
    adapters.map((adapter) => adapter.getQuote(tokenIn, tokenOut, amountIn)),
  );
  for (const quote of directQuotes) {
    if (quote) candidates.push(directToRoute(quote));
  }

  const usableConnectors = connectors.filter(
    (connector) => !isSameAddress(connector, tokenIn) && !isSameAddress(connector, tokenOut),
  );

  for (const connector of usableConnectors) {
    const firstHopQuotes = await Promise.all(
      adapters.map((adapter) => adapter.getQuote(tokenIn, connector, amountIn)),
    );
    for (const firstHop of firstHopQuotes) {
      if (!firstHop) continue;
      const secondHopQuotes = await Promise.all(
        adapters.map((adapter) => adapter.getQuote(connector, tokenOut, firstHop.expectedOut)),
      );
      for (const secondHop of secondHopQuotes) {
        if (!secondHop) continue;
        candidates.push(twoHopToRoute(firstHop, secondHop));
      }
    }
  }

  if (candidates.length === 0) {
    throw new NoRouteError(tokenIn, tokenOut);
  }

  candidates.sort(compareRoutes);
  const best = candidates[0]!;

  if (best.priceImpactBps > maxPriceImpactBps) {
    throw new PriceImpactExceededError(best.priceImpactBps, maxPriceImpactBps);
  }

  return best;
}
