import type { Address, PublicClient } from "viem";
import type { AdapterQuote, VenueAdapter } from "./adapter.js";

const FACTORY_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

const POOL_ABI = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "liquidity",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;

const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const Q192 = 2n ** 192n;
export const DEFAULT_FEE_TIERS = [500, 3000, 10_000] as const;

function computePriceImpactBps(
  amountIn: bigint,
  actualOut: bigint,
  sqrtPriceX96: bigint,
  tokenIn: Address,
  token0: Address,
): number {
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const spotOut =
    tokenIn.toLowerCase() === token0.toLowerCase()
      ? (amountIn * priceX192) / Q192
      : (amountIn * Q192) / priceX192;
  if (spotOut <= 0n) return 0;
  const impact = ((spotOut - actualOut) * 10_000n) / spotOut;
  return impact > 0n ? Number(impact) : 0;
}

export class UniV3Adapter implements VenueAdapter {
  readonly name = "uniswap-v3";
  /** QuoterV2 quotes the declared amountIn as-is; it has no knowledge of transfer taxes. */
  readonly quotesNetOfTax = false;

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address,
    private readonly quoterV2: Address,
    private readonly feeTiers: readonly number[] = DEFAULT_FEE_TIERS,
  ) {}

  async getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
  ): Promise<AdapterQuote | null> {
    const quotedAtBlock = await this.client.getBlockNumber();
    let best: AdapterQuote | null = null;

    for (const fee of this.feeTiers) {
      const pool = await this.client
        .readContract({
          address: this.factory,
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [tokenIn, tokenOut, fee],
        })
        .catch(() => null);

      if (!pool || pool === "0x0000000000000000000000000000000000000000") continue;

      const [liquidity] = await Promise.all([
        this.client.readContract({
          address: pool,
          abi: POOL_ABI,
          functionName: "liquidity",
        }),
      ]);
      if (liquidity <= 0n) continue;

      const quoteResult = await this.client
        .simulateContract({
          address: this.quoterV2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
        .catch(() => null);

      if (!quoteResult) continue;
      const [amountOut, , , gasEstimate] = quoteResult.result;

      const [slot0, token0] = await Promise.all([
        this.client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
        this.client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      ]);
      const priceImpactBps = computePriceImpactBps(
        amountIn,
        amountOut,
        slot0[0],
        tokenIn,
        token0,
      );

      const candidate: AdapterQuote = {
        venue: this.name,
        pool,
        tokenIn,
        tokenOut,
        amountIn,
        expectedOut: amountOut,
        priceImpactBps,
        gasEstimate,
        quotedAtBlock,
        poolMeta: { feeTier: fee },
      };

      if (!best || candidate.expectedOut > best.expectedOut) {
        best = candidate;
      }
    }

    return best;
  }
}
