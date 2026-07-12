import { PriceImpactExceededError } from "./errors.js";
import { findBestRoute, type FindRouteParams } from "./router.js";
import type { Route } from "./types.js";

const MAX_CHUNKS = 16;

export interface PlanChunksParams extends Omit<FindRouteParams, "amountIn"> {
  totalAmountIn: bigint;
}

export interface ChunkPlan {
  amounts: bigint[];
  routes: Route[];
}

/**
 * Splits totalAmountIn into N equal-ish chunks (N = 2, 3, ... up to MAX_CHUNKS)
 * until every chunk's route clears maxPriceImpactBps. Each chunk is routed
 * independently against *current* state — real execution re-quotes between
 * chunks anyway since prior chunks move the pool.
 */
export async function planChunks(params: PlanChunksParams): Promise<ChunkPlan> {
  const { totalAmountIn, tokenIn, tokenOut, adapters, connectors, maxPriceImpactBps } = params;

  for (let n = 2; n <= MAX_CHUNKS; n++) {
    const base = totalAmountIn / BigInt(n);
    const remainder = totalAmountIn - base * BigInt(n);
    const amounts = Array.from({ length: n }, (_, i) => (i === n - 1 ? base + remainder : base));

    try {
      const routes = await Promise.all(
        amounts.map((amountIn) =>
          findBestRoute({ tokenIn, tokenOut, amountIn, adapters, connectors, maxPriceImpactBps }),
        ),
      );
      return { amounts, routes };
    } catch (error) {
      if (error instanceof PriceImpactExceededError && n < MAX_CHUNKS) continue;
      throw error;
    }
  }

  throw new PriceImpactExceededError(Number.POSITIVE_INFINITY, maxPriceImpactBps);
}
