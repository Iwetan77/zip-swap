import { pad, type Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN_IN: Address = pad("0x1", { size: 20 });
const USDC: Address = pad("0x2", { size: 20 });
const POOL: Address = pad("0xaaaa", { size: 20 });

const mockClassify = vi.fn();

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/config.js")>("../../src/config.js");
  return {
    ...actual,
    createClient: () => ({ getBlockNumber: async () => 1n }),
    assertChainId: async () => undefined,
  };
});

vi.mock("../../src/safety.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/safety.js")>("../../src/safety.js");
  return {
    ...actual,
    classify: mockClassify,
  };
});

vi.mock("../../src/router.js", () => ({
  findBestRoute: vi.fn(async () => ({
    hops: [{ venue: "mock", pool: POOL, tokenIn: TOKEN_IN, tokenOut: USDC }],
    expectedOut: 1_000_000n,
    priceImpactBps: 10,
    gasEstimate: 100_000n,
  })),
}));

const baseConfig = {
  rpcUrl: "https://example.invalid",
  chainId: 143,
  usdc: USDC,
  connectors: [] as Address[],
  defaultSlippageBps: { stable: 10, major: 50, standard: 100, degen: 300 },
  quoteTtlSeconds: { stable: 60, major: 30, standard: 15, degen: 5 },
  maxPriceImpactBps: 500,
};

describe("getQuote tier defaults (mocked classification)", () => {
  beforeEach(() => {
    mockClassify.mockReset();
    mockClassify.mockResolvedValue({
      tier: "standard",
      transferTaxBps: 0,
      classifiedAtBlock: 1n,
    });
  });

  it("applies the classified tier's slippage/TTL defaults when the caller passes none", async () => {
    const { getQuote } = await import("../../src/quote.js");

    const quote = await getQuote({
      tokenIn: TOKEN_IN,
      amountIn: 10_000n,
      config: baseConfig,
    });

    if ("chunks" in quote) throw new Error("expected a single Quote");
    expect(quote.tier).toBe("standard");
    expect(quote.slippageBps).toBe(baseConfig.defaultSlippageBps.standard);
    expect(quote.ttl).toBe(baseConfig.quoteTtlSeconds.standard);
  });

  it("still honors a caller-supplied slippageBps over the tier default", async () => {
    const { getQuote } = await import("../../src/quote.js");

    const quote = await getQuote({
      tokenIn: TOKEN_IN,
      amountIn: 10_000n,
      slippageBps: 25,
      config: baseConfig,
    });

    if ("chunks" in quote) throw new Error("expected a single Quote");
    expect(quote.slippageBps).toBe(25);
    expect(quote.tier).toBe("standard");
  });

  it("applies degen-tier defaults for a degen-classified token", async () => {
    // transferTaxBps: 0 here — this test is isolating getQuote's tier-default
    // selection, not classify()'s own tax-vs-capability gate (covered separately
    // by the fork tests in test/fork/quote-safety/gate.test.ts).
    mockClassify.mockResolvedValue({
      tier: "degen",
      transferTaxBps: 0,
      classifiedAtBlock: 1n,
    });

    // A distinct address from TOKEN_IN — the classificationCache is a
    // module-level singleton, so reusing TOKEN_IN here would just replay the
    // "standard" result already cached by the earlier tests in this file.
    const degenToken: Address = pad("0x9", { size: 20 });
    const { getQuote } = await import("../../src/quote.js");

    const quote = await getQuote({
      tokenIn: degenToken,
      amountIn: 10_000n,
      config: baseConfig,
    });

    if ("chunks" in quote) throw new Error("expected a single Quote");
    expect(quote.tier).toBe("degen");
    expect(quote.slippageBps).toBe(baseConfig.defaultSlippageBps.degen);
    expect(quote.ttl).toBe(baseConfig.quoteTtlSeconds.degen);
  });
});
