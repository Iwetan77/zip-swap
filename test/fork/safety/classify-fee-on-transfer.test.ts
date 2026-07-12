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
import { deployFeeOnTransferToken } from "../helpers/deployMock.js";
import { createAndSeedPool, fundUsdcFromWhale } from "../helpers/seedPool.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const FACTORY = VENUES.venues[0]!.contracts.factory.address as Address;
const NFPM = VENUES.venues[0]!.contracts.nonfungiblePositionManager.address as Address;
const QUOTER_V2 = VENUES.venues[0]!.contracts.quoterV2.address as Address;
const USDC_WHALE = VENUES.venues[0]!.verifiedPools[0]!.pool as Address;
const USDC = VENUES.tokens.USDC.address as Address;

describe("classify() — GATE 2.5(b): fee-on-transfer token", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8554);
  }, 30_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("detects ~500bps transfer tax and classifies non-blocked", async () => {
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

    const feeSink = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    ).address;

    const mockToken = await deployFeeOnTransferToken(
      publicClient as any,
      walletClient,
      account.address,
      parseUnits("1000000", 18),
      500n, // 5%
      feeSink,
    );

    const { pool, feeTier } = await createAndSeedPool({
      rpcUrl: anvil.rpcUrl,
      publicClient: publicClient as any,
      walletClient,
      deployer: account.address,
      mockToken,
      usdc: USDC,
      factory: FACTORY,
      nfpm: NFPM,
    });

    const result = await classify({
      client: publicClient,
      token: mockToken,
      usdc: USDC,
      pool,
      quoterV2: QUOTER_V2,
      poolFee: feeTier,
    });

    expect(result.tier).not.toBe("blocked");
    expect(result.transferTaxBps).toBeGreaterThanOrEqual(490);
    expect(result.transferTaxBps).toBeLessThanOrEqual(510);
    expect(result.simulatedSellOut).toBeDefined();
    expect(result.simulatedSellOut!).toBeGreaterThan(0n);
  }, 60_000);
});
