import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getQuote } from "../../../src/quote.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";

const WMON = VENUES.tokens.WMON.address as Address;
const WETH = VENUES.tokens.WETH.address as Address;
const WBTC = VENUES.tokens.WBTC.address as Address;
const USDC = VENUES.tokens.USDC.address as Address;

describe("getQuote() — GATE 3: 3 distinct real tokens -> USDC", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8558);
  }, 90_000);

  afterAll(() => {
    anvil?.stop();
  });

  it.each([
    { symbol: "WMON", token: WMON, amountIn: 10n ** 18n },
    { symbol: "WETH", token: WETH, amountIn: 10n ** 15n },
    { symbol: "WBTC", token: WBTC, amountIn: 10n ** 5n },
  ])("returns a valid route for $symbol -> USDC", async ({ token, amountIn }) => {
    const quote = await getQuote({
      tokenIn: token,
      amountIn,
      config: {
        rpcUrl: anvil.rpcUrl,
        chainId: 143,
        usdc: USDC,
        connectors: [WMON],
        defaultSlippageBps: { stable: 10, major: 50, standard: 100, degen: 300 },
        quoteTtlSeconds: { stable: 60, major: 30, standard: 15, degen: 5 },
        maxPriceImpactBps: 500,
      },
    });

    if ("chunks" in quote) throw new Error("expected a single Quote, got a ChunkedQuote");
    expect(quote.tokenOut).toBe(USDC);
    expect(quote.expectedOut).toBeGreaterThan(0n);
    expect(quote.minOut).toBeLessThanOrEqual(quote.expectedOut);
    expect(quote.minOut).toBeGreaterThan(0n);
    expect(quote.route.hops.length).toBeGreaterThanOrEqual(1);
    expect(quote.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
    expect(quote.tier).toBeDefined();
    expect(quote.tier).not.toBe("blocked");
  }, 90_000);
});
