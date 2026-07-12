import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UniV3Adapter } from "../../../src/adapters/univ3.js";
import { UnsafeTokenError } from "../../../src/errors.js";
import { classificationCache, getQuote, isSupported, type Registry } from "../../../src/quote.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";
import { deployFeeOnTransferToken, deployHoneypotToken } from "../helpers/deployMock.js";
import { createAndSeedPool, fundUsdcFromWhale } from "../helpers/seedPool.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FEE_SINK_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const FACTORY = VENUES.venues[0]!.contracts.factory.address as Address;
const NFPM = VENUES.venues[0]!.contracts.nonfungiblePositionManager.address as Address;
const USDC_WHALE = VENUES.venues[0]!.verifiedPools[0]!.pool as Address;
const WMON = VENUES.tokens.WMON.address as Address;
const USDC = VENUES.tokens.USDC.address as Address;

const HONEYPOT_ABI = [
  {
    name: "setPair",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "_pair", type: "address" }],
    outputs: [],
  },
] as const;

function forkConfig(rpcUrl: string) {
  return {
    rpcUrl,
    chainId: 143,
    usdc: USDC,
    connectors: [WMON],
    defaultSlippageBps: { stable: 10, major: 50, standard: 100, degen: 300 },
    quoteTtlSeconds: { stable: 60, major: 30, standard: 15, degen: 5 },
    maxPriceImpactBps: 500,
  };
}

/** Clones the real registry with the UniswapV3 venue's FOT capability flipped — same addresses, only the flag differs. */
function withFotCapability(supportsFeeOnTransfer: boolean): Registry {
  const clone = structuredClone(VENUES) as Registry;
  (clone.venues[0] as { capabilities: { supportsFeeOnTransfer: boolean } }).capabilities.supportsFeeOnTransfer =
    supportsFeeOnTransfer;
  return clone;
}

describe("getQuote() safety gate — honeypot/FOT rejection at quote time", () => {
  let anvil: AnvilInstance;
  let honeypotToken: Address;
  let fot5PctToken: Address;
  let fot0_5PctToken: Address;

  beforeAll(async () => {
    anvil = await startAnvilFork(8562);

    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    await fundUsdcFromWhale(
      anvil.rpcUrl,
      publicClient,
      USDC_WHALE,
      account.address,
      parseUnits("350000", 6),
      USDC,
    );

    const feeSink = privateKeyToAccount(FEE_SINK_PRIVATE_KEY).address;

    // Honeypot: deploy, seed, then arm the pair.
    honeypotToken = await deployHoneypotToken(
      publicClient as any,
      walletClient,
      account.address,
      parseUnits("1000000", 18),
    );
    const { pool: honeypotPool } = await createAndSeedPool({
      rpcUrl: anvil.rpcUrl,
      publicClient: publicClient as any,
      walletClient,
      deployer: account.address,
      mockToken: honeypotToken,
      usdc: USDC,
      factory: FACTORY,
      nfpm: NFPM,
    });
    const setPairHash = await walletClient.writeContract({
      chain: null,
      account: account.address,
      address: honeypotToken,
      abi: HONEYPOT_ABI,
      functionName: "setPair",
      args: [honeypotPool],
    });
    await publicClient.waitForTransactionReceipt({ hash: setPairHash });

    // 5% tax token — well above the 2% tolerance.
    fot5PctToken = await deployFeeOnTransferToken(
      publicClient as any,
      walletClient,
      account.address,
      parseUnits("1000000", 18),
      500n,
      feeSink,
    );
    await createAndSeedPool({
      rpcUrl: anvil.rpcUrl,
      publicClient: publicClient as any,
      walletClient,
      deployer: account.address,
      mockToken: fot5PctToken,
      usdc: USDC,
      factory: FACTORY,
      nfpm: NFPM,
    });

    // 0.5% tax token — the regression case: below the old 2% tolerance, but
    // still unfillable on a V3-only registry, so it must be rejected too.
    fot0_5PctToken = await deployFeeOnTransferToken(
      publicClient as any,
      walletClient,
      account.address,
      parseUnits("1000000", 18),
      50n,
      feeSink,
    );
    await createAndSeedPool({
      rpcUrl: anvil.rpcUrl,
      publicClient: publicClient as any,
      walletClient,
      deployer: account.address,
      mockToken: fot0_5PctToken,
      usdc: USDC,
      factory: FACTORY,
      nfpm: NFPM,
    });
  }, 120_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("(1) rejects a honeypot at quote time with zero adapter quote calls", async () => {
    classificationCache.get(honeypotToken); // no-op, just documents cache key shape
    const spy = vi.spyOn(UniV3Adapter.prototype, "getQuote");
    spy.mockClear();

    await expect(
      getQuote({
        tokenIn: honeypotToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
      }),
    ).rejects.toThrow(UnsafeTokenError);

    await expect(
      getQuote({
        tokenIn: honeypotToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
      }),
    ).rejects.toThrow(/sell reverted/);

    // classify() itself calls the adapter internally to find a sell target —
    // what must be zero is calls from *routing* (findBestRoute), which never
    // runs because the safety gate throws first. Since classify() already
    // ran (and cached) during the first getQuote() above, the second call's
    // classify() result comes straight from cache — no further adapter calls
    // for it either, confirming no routing was attempted this call.
    const callsAfterSecondThrow = spy.mock.calls.length;
    await expect(
      getQuote({
        tokenIn: honeypotToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
      }),
    ).rejects.toThrow(UnsafeTokenError);
    expect(spy.mock.calls.length).toBe(callsAfterSecondThrow);

    spy.mockRestore();

    // GATE (6): the cache actually holds the blocked result (short TTL, per
    // TIER_TTL_SECONDS.degen) rather than re-probing every call.
    const cached = classificationCache.get(honeypotToken);
    expect(cached).not.toBeNull();
    expect(cached!.tier).toBe("blocked");
  }, 60_000);

  it("(2) rejects a 5% fee-on-transfer token with a venue-capability reason", async () => {
    await expect(
      getQuote({
        tokenIn: fot5PctToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
      }),
    ).rejects.toThrow(UnsafeTokenError);

    try {
      await getQuote({
        tokenIn: fot5PctToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
      });
      expect.unreachable("expected getQuote to throw");
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/fee-on-transfer/);
      expect(String((error as Error).message)).toMatch(/venue/);
    }
  }, 60_000);

  it("(2b) regression: rejects a 0.5% fee-on-transfer token too (below the old 2% tolerance)", async () => {
    await expect(
      getQuote({
        tokenIn: fot0_5PctToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
      }),
    ).rejects.toThrow(UnsafeTokenError);
  }, 60_000);

  it("(3) capability flag is live: flipping supportsFeeOnTransfer changes the outcome for the same 0.5%-tax token", async () => {
    const enabledRegistry = withFotCapability(true);
    const quote = await getQuote({
      tokenIn: fot0_5PctToken,
      amountIn: parseUnits("0.0001", 18),
      config: forkConfig(anvil.rpcUrl),
      registry: enabledRegistry,
    });
    if ("chunks" in quote) throw new Error("expected a single Quote");
    expect(quote.expectedOut).toBeGreaterThan(0n);

    const disabledRegistry = withFotCapability(false);
    await expect(
      getQuote({
        tokenIn: fot0_5PctToken,
        amountIn: parseUnits("0.0001", 18),
        config: forkConfig(anvil.rpcUrl),
        registry: disabledRegistry,
      }),
    ).rejects.toThrow(UnsafeTokenError);
  }, 60_000);

  it("(5) isSupported agrees with getQuote for normal/honeypot/FOT tokens", async () => {
    const cases: Array<{ label: string; token: Address }> = [
      { label: "normal (WMON)", token: WMON },
      { label: "honeypot", token: honeypotToken },
      { label: "5%-FOT", token: fot5PctToken },
    ];

    for (const { token } of cases) {
      const config = forkConfig(anvil.rpcUrl);
      let threw = false;
      try {
        await getQuote({ tokenIn: token, amountIn: parseUnits("0.0001", 18), config });
      } catch {
        threw = true;
      }
      const supported = await isSupported(token, { config });
      expect(supported).toBe(!threw);
    }
  }, 60_000);
});
