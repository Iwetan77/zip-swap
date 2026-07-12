import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UniV3Adapter } from "../../../src/adapters/univ3.js";
import VENUES from "../../../src/registry/VENUES.json" with { type: "json" };
import { startAnvilFork, type AnvilInstance } from "../helpers/anvil.js";

const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const WMON_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

const SWAP_ROUTER_02_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const FACTORY = VENUES.venues[0]!.contracts.factory.address as Address;
const QUOTER_V2 = VENUES.venues[0]!.contracts.quoterV2.address as Address;
const SWAP_ROUTER_02 = VENUES.venues[0]!.contracts.swapRouter02.address as Address;
const WMON = VENUES.tokens.WMON.address as Address;
const USDC = VENUES.tokens.USDC.address as Address;

describe("UniV3Adapter fork verification (WMON -> USDC)", () => {
  let anvil: AnvilInstance;

  beforeAll(async () => {
    anvil = await startAnvilFork(8552);
  }, 30_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("quoted amount matches actual on-chain swap output within 0.1%", async () => {
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
    const walletClient = createWalletClient({
      account,
      transport: http(anvil.rpcUrl),
    });

    const amountIn = parseEther("10");

    const depositHash = await walletClient.writeContract({
      chain: null,
      address: WMON,
      abi: WMON_ABI,
      functionName: "deposit",
      value: amountIn,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    const adapter = new UniV3Adapter(publicClient as any, FACTORY, QUOTER_V2);
    const quote = await adapter.getQuote(WMON, USDC, amountIn);

    expect(quote).not.toBeNull();
    expect(quote!.expectedOut).toBeGreaterThan(0n);

    const feeTier = (quote!.poolMeta as { feeTier: number }).feeTier;

    const approveHash = await walletClient.writeContract({
      chain: null,
      address: WMON,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [SWAP_ROUTER_02, amountIn],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const usdcBalanceBefore = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    const swapHash = await walletClient.writeContract({
      chain: null,
      address: SWAP_ROUTER_02,
      abi: SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WMON,
          tokenOut: USDC,
          fee: feeTier,
          recipient: account.address,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: swapHash });

    const usdcBalanceAfter = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    const actualOut = usdcBalanceAfter - usdcBalanceBefore;
    expect(actualOut).toBeGreaterThan(0n);

    const diff =
      actualOut > quote!.expectedOut
        ? actualOut - quote!.expectedOut
        : quote!.expectedOut - actualOut;
    const diffBps = (diff * 10_000n) / quote!.expectedOut;

    expect(diffBps).toBeLessThanOrEqual(10n); // within 0.1% (10bps)
  }, 30_000);
});
