import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeChunkedSwap, executeSwap } from "../../../src/execute.js";
import { getQuote } from "../../../src/quote.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";
import { deployFeeOnTransferToken } from "../helpers/deployMock.js";
import { createAndSeedPool } from "../helpers/seedPool.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const FACTORY = VENUES.venues[0]!.contracts.factory.address as Address;
const NFPM = VENUES.venues[0]!.contracts.nonfungiblePositionManager.address as Address;
const WMON = VENUES.tokens.WMON.address as Address;
const USDC = VENUES.tokens.USDC.address as Address;

const WMON_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
] as const;
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Deploys a fresh no-tax mock token and seeds a genuinely-shallow mock/WMON pool, funded from native MON via anvil_setBalance (disposable fork only). */
async function setupAccountAndPool(
  rpcUrl: string,
  publicClient: ReturnType<typeof createPublicClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  walletClient: ReturnType<typeof createWalletClient>,
  poolDepth: bigint,
) {
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "anvil_setBalance",
      params: [account.address, numberToHex(poolDepth * 3n)],
      id: 1,
    }),
  });
  const hash = await walletClient.writeContract({
    chain: null, account: account.address, address: WMON, abi: WMON_ABI, functionName: "deposit", value: poolDepth * 2n,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const mockToken = await deployFeeOnTransferToken(
    publicClient as any, walletClient, account.address, poolDepth * 100n, 0n, account.address,
  );
  await createAndSeedPool({
    rpcUrl,
    publicClient: publicClient as any,
    walletClient,
    deployer: account.address,
    mockToken,
    usdc: WMON,
    usdcAmount: poolDepth,
    mockAmount: poolDepth,
    factory: FACTORY,
    nfpm: NFPM,
  });

  return mockToken;
}

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

describe("full E2E flow — GATE 5", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8563);
  }, 30_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("(a) getQuote -> buildSwapTx -> executeSwap for a direct real token and a 1-hop mock token, USDC delta matches receipt exactly", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    // Fund with enough WMON to both seed a genuinely deep mock/WMON pool and run the direct swap test.
    await fetch(anvil.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_setBalance",
        params: [account.address, numberToHex(parseEther("300000"))],
        id: 1,
      }),
    });
    const wmonAmountIn = parseEther("2");
    let hash = await walletClient.writeContract({
      chain: null, address: WMON, abi: WMON_ABI, functionName: "deposit", value: parseEther("150002"),
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const wmonQuote = await getQuote({ tokenIn: WMON, amountIn: wmonAmountIn, config: forkConfig(anvil.rpcUrl) });
    if ("chunks" in wmonQuote) throw new Error("unexpected ChunkedQuote for a small WMON amount");
    expect(wmonQuote.route.hops).toHaveLength(1);

    const usdcBefore1 = await publicClient.readContract({
      address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address],
    });
    const receipt1 = await executeSwap(wmonQuote, walletClient, publicClient as any);
    const usdcAfter1 = await publicClient.readContract({
      address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address],
    });
    expect(usdcAfter1 - usdcBefore1).toBe(receipt1.amountOut);
    expect(receipt1.amountOut).toBeGreaterThanOrEqual(wmonQuote.minOut);

    // Mock token only paired with WMON -> forces a genuine 1-hop (2-hop Route) path to USDC.
    const mockToken = await deployFeeOnTransferToken(
      publicClient as any, walletClient, account.address, parseEther("10000000"), 0n, account.address,
    );
    await createAndSeedPool({
      rpcUrl: anvil.rpcUrl,
      publicClient: publicClient as any,
      walletClient,
      deployer: account.address,
      mockToken,
      usdc: WMON,
      usdcAmount: parseEther("150000"),
      mockAmount: parseEther("150000"),
      factory: FACTORY,
      nfpm: NFPM,
    });

    const mockAmountIn = parseEther("500");
    const mockQuote = await getQuote({ tokenIn: mockToken, amountIn: mockAmountIn, config: forkConfig(anvil.rpcUrl) });
    if ("chunks" in mockQuote) throw new Error("unexpected ChunkedQuote for a small mock amount");
    expect(mockQuote.route.hops).toHaveLength(2);

    const usdcBefore2 = await publicClient.readContract({
      address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address],
    });
    const receipt2 = await executeSwap(mockQuote, walletClient, publicClient as any);
    const usdcAfter2 = await publicClient.readContract({
      address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address],
    });
    expect(usdcAfter2 - usdcBefore2).toBe(receipt2.amountOut);
    expect(receipt2.amountOut).toBeGreaterThanOrEqual(mockQuote.minOut);
  }, 60_000);

  it("(b) an order exceeding the impact ceiling returns a ChunkedQuote and executes all chunks", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    const poolDepth = parseEther("10000");
    const mockToken = await setupAccountAndPool(anvil.rpcUrl, publicClient, account, walletClient, poolDepth);

    // ~40% of pool depth in one shot blows past the 500bps ceiling.
    const bigAmountIn = parseEther("4000");
    const quote = await getQuote({ tokenIn: mockToken, amountIn: bigAmountIn, config: forkConfig(anvil.rpcUrl) });
    if (!("chunks" in quote)) throw new Error("expected a ChunkedQuote for a large order");
    expect(quote.chunks.length).toBeGreaterThan(1);
    expect(quote.totalAmountIn).toBe(bigAmountIn);

    const usdcBefore = await publicClient.readContract({
      address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address],
    });

    const result = await executeChunkedSwap({
      tokenIn: mockToken,
      chunkedQuote: quote,
      wallet: walletClient,
      publicClient: publicClient as any,
      config: forkConfig(anvil.rpcUrl),
    });

    const usdcAfter = await publicClient.readContract({
      address: USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [account.address],
    });

    expect(result.aborted).toBe(false);
    expect(result.executedChunks).toBe(quote.chunks.length);
    expect(result.remainingIn).toBe(0n);
    expect(usdcAfter - usdcBefore).toBe(result.totalUsdcOut);
    // Each chunk is re-quoted immediately before execution (planning-time
    // quotes all assume the *original* reserves, but earlier chunks deplete
    // the pool for later ones) — so the meaningful guarantee is per-chunk,
    // not "total >= sum of planning-time minOuts". Every receipt clearing
    // buildSwapTx's mandatory simulate already proves each chunk met its own
    // current minOut; this just double-checks the aggregate is sane.
    expect(result.totalUsdcOut).toBeGreaterThan(0n);
    expect(result.receipts).toHaveLength(quote.chunks.length);
  }, 60_000);

  it("(c) sabotaging the pool mid-sequence aborts cleanly with honest partial accounting", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    const poolDepth = parseEther("10000");
    const mockToken = await setupAccountAndPool(anvil.rpcUrl, publicClient, account, walletClient, poolDepth);

    const bigAmountIn = parseEther("4000");
    const quote = await getQuote({ tokenIn: mockToken, amountIn: bigAmountIn, config: forkConfig(anvil.rpcUrl) });
    if (!("chunks" in quote)) throw new Error("expected a ChunkedQuote for a large order");
    expect(quote.chunks.length).toBeGreaterThan(1);

    const result = await executeChunkedSwap({
      tokenIn: mockToken,
      chunkedQuote: quote,
      wallet: walletClient,
      publicClient: publicClient as any,
      config: forkConfig(anvil.rpcUrl),
      onChunkSettled: async (index) => {
        // Crash the mock/WMON pool's price right after the first chunk lands,
        // so every remaining chunk (and its one re-quote retry) goes stale.
        if (index !== 0) return;
        const pool = quote.chunks[0]!.route.hops[0]!.pool;
        const slot0 = (await (
          await fetch(anvil.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getStorageAt", params: [pool, "0x0", "latest"], id: 1 }),
          })
        ).json()) as { result: `0x${string}` };
        const upperBits = (BigInt(slot0.result) >> 160n) << 160n;
        const crashedWord = upperBits | 4_295_128_740n;
        await fetch(anvil.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "anvil_setStorageAt",
            params: [pool, "0x0", numberToHex(crashedWord, { size: 32 })],
            id: 1,
          }),
        });
      },
    });

    expect(result.aborted).toBe(true);
    expect(result.executedChunks).toBeGreaterThanOrEqual(1);
    expect(result.executedChunks).toBeLessThan(quote.chunks.length);
    expect(result.remainingIn).toBeGreaterThan(0n);
    // Every entry in receipts is, by construction, a chunk whose actual
    // on-chain output cleared buildSwapTx's mandatory simulate — no chunk
    // that would have landed below its (re-quoted, current) minOut is ever
    // in this array.
    expect(result.receipts).toHaveLength(result.executedChunks);
  }, 60_000);
});
