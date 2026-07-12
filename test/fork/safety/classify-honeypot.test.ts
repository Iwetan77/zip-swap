import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify } from "../../../src/safety.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";
import { deployHoneypotToken } from "../helpers/deployMock.js";
import { createAndSeedPool, fundUsdcFromWhale } from "../helpers/seedPool.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const FACTORY = VENUES.venues[0]!.contracts.factory.address as Address;
const NFPM = VENUES.venues[0]!.contracts.nonfungiblePositionManager.address as Address;
const QUOTER_V2 = VENUES.venues[0]!.contracts.quoterV2.address as Address;
const USDC_WHALE = VENUES.venues[0]!.verifiedPools[0]!.pool as Address;
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

describe("classify() — GATE 2.5(c): honeypot token", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8555);
  }, 60_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("classifies blocked and getQuote-equivalent throws UnsafeTokenError", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    await fundUsdcFromWhale(
      anvil.rpcUrl,
      publicClient,
      USDC_WHALE,
      account.address,
      parseUnits("200000", 6),
      USDC,
    );

    const mockToken = await deployHoneypotToken(
      publicClient as any,
      walletClient,
      account.address,
      parseUnits("1000000", 18),
    );

    const { pool } = await createAndSeedPool({
      rpcUrl: anvil.rpcUrl,
      publicClient: publicClient as any,
      walletClient,
      deployer: account.address,
      mockToken,
      usdc: USDC,
      factory: FACTORY,
      nfpm: NFPM,
    });

    // Arm the honeypot only after liquidity is seeded (owner-seeded liquidity must succeed).
    const setPairHash = await walletClient.writeContract({
      chain: null,
      account: account.address,
      address: mockToken,
      abi: HONEYPOT_ABI,
      functionName: "setPair",
      args: [pool],
    });
    await publicClient.waitForTransactionReceipt({ hash: setPairHash });

    const result = await classify({
      client: publicClient,
      token: mockToken,
      usdc: USDC,
      factory: FACTORY,
      quoterV2: QUOTER_V2,
      connectors: [],
    });

    expect(result.tier).toBe("blocked");
    expect(result.reason).toMatch(/sell reverted/);

    const { assertSafe } = await import("../../../src/safety.js");
    expect(() => assertSafe(mockToken, result)).toThrow(/classified unsafe/);
  }, 60_000);
});
