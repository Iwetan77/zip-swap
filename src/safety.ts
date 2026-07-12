import {
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { UnsafeTokenError } from "./errors.js";
import type { TokenTier } from "./types.js";
import SIMULATOR_ARTIFACT from "../contracts/out/Simulator.sol/Simulator.json" with { type: "json" };

const SIMULATOR_ADDRESS: Address = pad("0x513131", { size: 20 });
const MAX_PROBE_SLOTS = 20;
export const PROBE_AMOUNT = 1_000_000_000_000_000_000n; // 1e18, decimals-agnostic probe unit
const SELL_DEVIATION_TOLERANCE_BPS = 200n; // 2%, per project spec

const SIMULATOR_ABI = [
  {
    name: "probeBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "expectedAmount", type: "uint256" },
    ],
    outputs: [
      { name: "ok", type: "bool" },
      { name: "balance", type: "uint256" },
    ],
  },
  {
    name: "simulateTransferTax",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "sent", type: "uint256" },
      { name: "received", type: "uint256" },
    ],
  },
  {
    name: "probeTransferToPool",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "received", type: "uint256" }],
  },
] as const;

const ERC20_READ_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
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

const SIMULATOR_CODE = SIMULATOR_ARTIFACT.deployedBytecode.object as `0x${string}`;

function balanceSlotOverride(holder: Address, slot: number, amount: bigint) {
  const key = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, BigInt(slot)],
    ),
  );
  return { [key]: pad(toHex(amount), { size: 32 }) };
}

function toStateDiff(overrides: Record<string, `0x${string}`>) {
  return Object.entries(overrides).map(([slot, value]) => ({ slot: slot as `0x${string}`, value }));
}

async function findBalanceSlot(
  client: PublicClient,
  token: Address,
): Promise<number | null> {
  for (let slot = 0; slot < MAX_PROBE_SLOTS; slot++) {
    const result = await client
      .readContract({
        address: SIMULATOR_ADDRESS,
        abi: SIMULATOR_ABI,
        functionName: "probeBalance",
        args: [token, PROBE_AMOUNT],
        stateOverride: [
          { address: SIMULATOR_ADDRESS, code: SIMULATOR_CODE },
          { address: token, stateDiff: toStateDiff(balanceSlotOverride(SIMULATOR_ADDRESS, slot, PROBE_AMOUNT)) },
        ],
      })
      .catch(() => null);

    if (result?.[0] === true) return slot;
  }
  return null;
}

export interface ClassificationResult {
  tier: TokenTier;
  transferTaxBps: number;
  reason?: string;
  classifiedAtBlock: bigint;
  /** Tax-adjusted balance-delta projection: what selling PROBE_AMOUNT nets after the token's own transfer tax. Undefined if never computed. */
  simulatedSellOut?: bigint;
  probeAmountIn?: bigint;
}

export interface ClassifyParams {
  client: PublicClient;
  token: Address;
  usdc: Address;
  pool: Address;
  quoterV2: Address;
  poolFee: number;
}

/**
 * Classifies sell-side safety for `token` using eth_call state overrides — no
 * real funds or approvals required.
 *
 * A real on-chain swap can't be used as the sell-simulation for taxed tokens:
 * Uniswap V3's mint/swap callbacks require the pool to receive the *exact*
 * declared amount, which a fee-on-transfer token can never deliver (the pool
 * would revert with 'M1'/'IIA' for every seller, not just zip-swap — this is
 * a real V3 limitation, not a bug here). So safety is split into two probes:
 * a direct transfer into the pool address (catches honeypot-style reverts,
 * the same way a real swap's token pull would revert) and a QuoterV2
 * projection over the tax-adjusted net amount (catches output deviation).
 */
export async function classify(params: ClassifyParams): Promise<ClassificationResult> {
  const { client, token, usdc, pool, quoterV2, poolFee } = params;
  const classifiedAtBlock = await client.getBlockNumber();

  const readable = await Promise.all([
    client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "symbol" }),
  ]).catch(() => null);

  if (!readable) {
    return { tier: "blocked", transferTaxBps: 0, reason: "decimals()/symbol() unreadable", classifiedAtBlock };
  }

  const slot = await findBalanceSlot(client, token);
  if (slot === null) {
    return {
      tier: "blocked",
      transferTaxBps: 0,
      reason: "could not locate balance storage slot for state-override simulation",
      classifiedAtBlock,
    };
  }

  const stateOverride = [
    { address: SIMULATOR_ADDRESS, code: SIMULATOR_CODE },
    { address: token, stateDiff: toStateDiff(balanceSlotOverride(SIMULATOR_ADDRESS, slot, PROBE_AMOUNT)) },
  ];

  const dummyRecipient: Address = pad("0xbaadf00d", { size: 20 });
  const taxResult = await client
    .simulateContract({
      address: SIMULATOR_ADDRESS,
      abi: SIMULATOR_ABI,
      functionName: "simulateTransferTax",
      args: [token, dummyRecipient, PROBE_AMOUNT / 2n],
      stateOverride,
    })
    .catch((error: Error) => ({ error }));

  if ("error" in taxResult) {
    return { tier: "blocked", transferTaxBps: 0, reason: "transfer reverted during simulation", classifiedAtBlock };
  }
  const [sent, received] = taxResult.result;
  const transferTaxBps = sent > 0n ? Number(((sent - received) * 10_000n) / sent) : 0;

  const sellProbe = await client
    .simulateContract({
      address: SIMULATOR_ADDRESS,
      abi: SIMULATOR_ABI,
      functionName: "probeTransferToPool",
      args: [token, pool, PROBE_AMOUNT / 2n],
      stateOverride,
    })
    .catch((error: Error) => ({ error }));

  if ("error" in sellProbe) {
    return { tier: "blocked", transferTaxBps, reason: "sell reverted during simulation", classifiedAtBlock };
  }

  const netAmountIn = PROBE_AMOUNT - (PROBE_AMOUNT * BigInt(transferTaxBps)) / 10_000n;
  const quote = await client
    .simulateContract({
      address: quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: token, tokenOut: usdc, amountIn: netAmountIn, fee: poolFee, sqrtPriceLimitX96: 0n }],
    })
    .catch((error: Error) => ({ error }));

  if ("error" in quote) {
    return { tier: "blocked", transferTaxBps, reason: "sell quote unavailable", classifiedAtBlock };
  }

  const amountOut = quote.result[0];
  if (amountOut <= 0n) {
    return { tier: "blocked", transferTaxBps, reason: "sell simulation produced zero output", classifiedAtBlock };
  }

  if (BigInt(transferTaxBps) > SELL_DEVIATION_TOLERANCE_BPS) {
    return {
      tier: "degen",
      transferTaxBps,
      reason: `transfer tax ${transferTaxBps}bps exceeds ${SELL_DEVIATION_TOLERANCE_BPS}bps tolerance`,
      classifiedAtBlock,
      simulatedSellOut: amountOut,
      probeAmountIn: netAmountIn,
    };
  }

  return {
    tier: "standard",
    transferTaxBps,
    classifiedAtBlock,
    simulatedSellOut: amountOut,
    probeAmountIn: netAmountIn,
  };
}

const TIER_TTL_SECONDS: Record<Exclude<TokenTier, "blocked">, number> = {
  stable: 3600,
  major: 900,
  standard: 300,
  degen: 60,
};

interface CacheEntry {
  result: ClassificationResult;
  expiresAtMs: number;
}

export class ClassificationCache {
  private readonly entries = new Map<Address, CacheEntry>();

  get(token: Address): ClassificationResult | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAtMs) {
      this.entries.delete(token);
      return null;
    }
    return entry.result;
  }

  set(token: Address, result: ClassificationResult): void {
    const ttlSeconds = result.tier === "blocked" ? TIER_TTL_SECONDS.degen : TIER_TTL_SECONDS[result.tier];
    this.entries.set(token, { result, expiresAtMs: Date.now() + ttlSeconds * 1000 });
  }
}

export function assertSafe(token: Address, result: ClassificationResult): void {
  if (result.tier === "blocked") {
    throw new UnsafeTokenError(token, result.reason ?? "unknown");
  }
}
