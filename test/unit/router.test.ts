import { pad, type Address } from "viem";
import { describe, expect, it } from "vitest";
import type { AdapterQuote, VenueAdapter } from "../../src/adapters/adapter.js";
import { NoRouteError, PriceImpactExceededError } from "../../src/errors.js";
import { findBestRoute } from "../../src/router.js";

const TOKEN_IN: Address = pad("0x1", { size: 20 });
const TOKEN_OUT: Address = pad("0x2", { size: 20 });
const CONNECTOR: Address = pad("0x3", { size: 20 });
const POOL: Address = pad("0xaaaa", { size: 20 });

function quote(overrides: Partial<AdapterQuote> & Pick<AdapterQuote, "venue">): AdapterQuote {
  return {
    pool: POOL,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
    expectedOut: 0n,
    priceImpactBps: 10,
    gasEstimate: 100_000n,
    quotedAtBlock: 1n,
    ...overrides,
  };
}

/** Mock adapter driven by a lookup table keyed by "tokenIn>tokenOut". */
function mockAdapter(name: string, table: Record<string, AdapterQuote | null>): VenueAdapter {
  return {
    name,
    quotesNetOfTax: false,
    async getQuote(tokenIn, tokenOut) {
      return table[`${tokenIn}>${tokenOut}`] ?? null;
    },
  };
}

describe("findBestRoute", () => {
  it("picks the higher-out direct route across adapters", async () => {
    const adapterA = mockAdapter("A", {
      [`${TOKEN_IN}>${TOKEN_OUT}`]: quote({ venue: "A", expectedOut: 900n }),
    });
    const adapterB = mockAdapter("B", {
      [`${TOKEN_IN}>${TOKEN_OUT}`]: quote({ venue: "B", expectedOut: 950n }),
    });

    const route = await findBestRoute({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
      adapters: [adapterA, adapterB],
      connectors: [],
      maxPriceImpactBps: 500,
    });

    expect(route.expectedOut).toBe(950n);
    expect(route.hops).toHaveLength(1);
    expect(route.hops[0]!.venue).toBe("B");
  });

  it("considers a 1-hop route via a connector when it beats a worse direct route", async () => {
    const adapter = mockAdapter("only", {
      [`${TOKEN_IN}>${TOKEN_OUT}`]: quote({ venue: "only", expectedOut: 800n }),
      [`${TOKEN_IN}>${CONNECTOR}`]: quote({
        venue: "only",
        tokenOut: CONNECTOR,
        expectedOut: 500n,
      }),
      [`${CONNECTOR}>${TOKEN_OUT}`]: quote({
        venue: "only",
        tokenIn: CONNECTOR,
        expectedOut: 950n,
      }),
    });

    const route = await findBestRoute({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
      adapters: [adapter],
      connectors: [CONNECTOR],
      maxPriceImpactBps: 500,
    });

    expect(route.expectedOut).toBe(950n);
    expect(route.hops).toHaveLength(2);
  });

  it("considers a 1-hop route when no direct route exists at all", async () => {
    const adapter = mockAdapter("only", {
      [`${TOKEN_IN}>${CONNECTOR}`]: quote({
        venue: "only",
        tokenOut: CONNECTOR,
        expectedOut: 500n,
      }),
      [`${CONNECTOR}>${TOKEN_OUT}`]: quote({
        venue: "only",
        tokenIn: CONNECTOR,
        expectedOut: 480n,
      }),
    });

    const route = await findBestRoute({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
      adapters: [adapter],
      connectors: [CONNECTOR],
      maxPriceImpactBps: 500,
    });

    expect(route.expectedOut).toBe(480n);
    expect(route.hops).toHaveLength(2);
  });

  it("throws NoRouteError when no adapter quotes any path", async () => {
    const adapter = mockAdapter("empty", {});

    await expect(
      findBestRoute({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000n,
        adapters: [adapter],
        connectors: [CONNECTOR],
        maxPriceImpactBps: 500,
      }),
    ).rejects.toThrow(NoRouteError);
  });

  it("enforces the price impact ceiling with a typed error instead of returning a bad route", async () => {
    const adapter = mockAdapter("risky", {
      [`${TOKEN_IN}>${TOKEN_OUT}`]: quote({
        venue: "risky",
        expectedOut: 900n,
        priceImpactBps: 900,
      }),
    });

    await expect(
      findBestRoute({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000n,
        adapters: [adapter],
        connectors: [],
        maxPriceImpactBps: 500,
      }),
    ).rejects.toThrow(PriceImpactExceededError);
  });
});
