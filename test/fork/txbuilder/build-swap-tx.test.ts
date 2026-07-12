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
import { StaleQuoteError } from "../../../src/errors.js";
import { getQuote } from "../../../src/quote.js";
import { buildSwapTx } from "../../../src/txbuilder.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const WMON = VENUES.tokens.WMON.address as Address;
const USDC = VENUES.tokens.USDC.address as Address;
const SWAP_ROUTER_02 = VENUES.venues[0]!.contracts.swapRouter02.address as Address;

const WMON_ABI = [{ name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] }] as const;

const forkConfig = {
  chainId: 143,
  usdc: USDC,
  connectors: [WMON],
  defaultSlippageBps: { stable: 10, major: 50, standard: 100, degen: 300 },
  quoteTtlSeconds: { stable: 60, major: 30, standard: 15, degen: 5 },
  maxPriceImpactBps: 500,
};

describe("buildSwapTx() — GATE 4", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8559);
  }, 30_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("(a) builds a WMON->USDC tx that simulates successfully with output >= minOut", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    const amountIn = parseEther("5");
    const depositHash = await walletClient.writeContract({
      chain: null, address: WMON, abi: WMON_ABI, functionName: "deposit", value: amountIn,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    const quote = await getQuote({
      tokenIn: WMON,
      amountIn,
      config: { ...forkConfig, rpcUrl: anvil.rpcUrl },
    });

    const tx = await buildSwapTx(quote, account.address, publicClient as any);

    expect(tx.simulatedOut).toBeGreaterThanOrEqual(tx.minOut);
    expect(tx.prerequisites).toHaveLength(1);
    expect(tx.prerequisites[0]!.to).toBe(WMON);
    expect(tx.to).toBe(SWAP_ROUTER_02);
    expect(tx.deadline).toBe(quote.deadline);
  }, 30_000);

  it("(b) throws StaleQuoteError when the pool price moves after the quote was taken", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, transport: http(anvil.rpcUrl) });

    const amountIn = parseEther("1");
    const depositHash = await walletClient.writeContract({
      chain: null, address: WMON, abi: WMON_ABI, functionName: "deposit", value: amountIn,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    // Tight slippage so even a modest price move breaks minOut.
    const staleQuote = await getQuote({
      tokenIn: WMON,
      amountIn,
      slippageBps: 5, // 0.05%
      config: { ...forkConfig, rpcUrl: anvil.rpcUrl },
    });

    // This pool is deep enough that even an 8-figure real swap times out
    // computing gas (huge tick range to traverse) rather than moving the
    // price meaningfully. Directly overwrite slot0's packed sqrtPriceX96
    // (the low 160 bits of storage slot 0, confirmed by cross-checking
    // eth_getStorageAt against slot0()'s decoded return) to force a stale
    // price instantly and deterministically. Crash whichever pool the
    // router actually picked for this quote's hop.
    const quotedPool = staleQuote.route.hops[0]!.pool;
    const slot0Before = (await (
      await fetch(anvil.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getStorageAt",
          params: [quotedPool, "0x0", "latest"],
          id: 1,
        }),
      })
    ).json()) as { result: `0x${string}` };
    const originalWord = BigInt(slot0Before.result);
    const upperBits = (originalWord >> 160n) << 160n;
    const crashedSqrtPriceX96 = 4_295_128_740n; // just above MIN_SQRT_RATIO
    const crashedWord = upperBits | crashedSqrtPriceX96;

    await fetch(anvil.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_setStorageAt",
        params: [quotedPool, "0x0", numberToHex(crashedWord, { size: 32 })],
        id: 1,
      }),
    });

    await expect(buildSwapTx(staleQuote, account.address, publicClient as any)).rejects.toThrow(
      StaleQuoteError,
    );
  }, 30_000);
});
