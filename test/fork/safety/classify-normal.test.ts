import { createPublicClient, http, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, PROBE_AMOUNT } from "../../../src/safety.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";

const FACTORY = VENUES.venues[0]!.contracts.factory.address as Address;
const QUOTER_V2 = VENUES.venues[0]!.contracts.quoterV2.address as Address;
const WMON = VENUES.tokens.WMON.address as Address;
const USDC = VENUES.tokens.USDC.address as Address;

describe("classify() — GATE 2.5(a): normal token", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8553);
  }, 60_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("classifies WMON as non-blocked and its sell-simulation matches the adapter quote within 0.1%", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });

    const { UniV3Adapter } = await import("../../../src/adapters/univ3.js");
    const adapter = new UniV3Adapter(
      publicClient as any,
      "0x204faca1764b154221e35c0d20abb3c525710498",
      "0x661e93cca42afacb172121ef892830ca3b70f08d",
    );
    const quote = await adapter.getQuote(WMON, USDC, PROBE_AMOUNT);
    expect(quote).not.toBeNull();

    const result = await classify({
      client: publicClient,
      token: WMON,
      usdc: USDC,
      factory: FACTORY,
      quoterV2: QUOTER_V2,
      connectors: [],
    });

    expect(result.tier).not.toBe("blocked");
    expect(result.transferTaxBps).toBe(0);
    expect(result.simulatedSellOut).toBeDefined();
    expect(result.simulatedSellOut!).toBeGreaterThan(0n);

    const simulated = result.simulatedSellOut!;
    const claimed = quote!.expectedOut;
    const diff = simulated > claimed ? simulated - claimed : claimed - simulated;
    const diffBps = (diff * 10_000n) / claimed;

    expect(diffBps).toBeLessThanOrEqual(10n); // within 0.1%
  }, 60_000);
});
