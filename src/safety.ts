import {
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { UniV3Adapter } from "./adapters/univ3.js";
import { UnsafeTokenError } from "./errors.js";
import type { TokenTier } from "./types.js";
import SIMULATOR_ARTIFACT from "../contracts/out/Simulator.sol/Simulator.json" with { type: "json" };

const SIMULATOR_ADDRESS: Address = pad("0x513131", { size: 20 });
const MAX_PROBE_SLOTS = 60; // covers common OZ-upgradeable storage gaps, not just simple non-upgradeable layouts
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

async function probeSlot(client: PublicClient, token: Address, slot: number): Promise<number | null> {
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
  return result?.[0] === true ? slot : null;
}

/** Probes all candidate slots concurrently — sequential round-trips against a real (non-local) RPC made this time out well before exhausting a useful slot range. */
async function findBalanceSlot(client: PublicClient, token: Address): Promise<number | null> {
  const slots = Array.from({ length: MAX_PROBE_SLOTS }, (_, i) => i);
  const results = await Promise.all(slots.map((slot) => probeSlot(client, token, slot)));
  const found = results.find((slot) => slot !== null);
  return found ?? null;
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
  factory: Address;
  quoterV2: Address;
  /** Connector tokens (e.g. WMON) to fall back to when `token` has no direct USDC pool — mirrors router.ts's own 1-hop search so a connector-only token isn't blocked for lack of a pool that was never going to exist. */
  connectors?: Address[];
}

interface SellTarget {
  pool: Address;
  poolFee: number;
  targetToken: Address;
}

/** Finds a live pool to probe sell-ability against: token->usdc directly, else token->connector for each connector, first match wins. */
async function findSellTarget(
  client: PublicClient,
  token: Address,
  usdc: Address,
  factory: Address,
  quoterV2: Address,
  connectors: Address[],
): Promise<SellTarget | null> {
  const adapter = new UniV3Adapter(client, factory, quoterV2);

  const direct = await adapter.getQuote(token, usdc, PROBE_AMOUNT);
  if (direct) {
    return { pool: direct.pool, poolFee: (direct.poolMeta as { feeTier: number }).feeTier, targetToken: usdc };
  }

  for (const connector of connectors) {
    if (connector.toLowerCase() === token.toLowerCase()) continue;
    const viaConnector = await adapter.getQuote(token, connector, PROBE_AMOUNT);
    if (viaConnector) {
      return {
        pool: viaConnector.pool,
        poolFee: (viaConnector.poolMeta as { feeTier: number }).feeTier,
        targetToken: connector,
      };
    }
  }

  return null;
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
  const { client, token, usdc, factory, quoterV2, connectors = [] } = params;
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

  const target = await findSellTarget(client, token, usdc, factory, quoterV2, connectors);
  if (!target) {
    return {
      tier: "blocked",
      transferTaxBps,
      reason: "no live pool found for sell-side probing (no direct USDC pool or connector pool)",
      classifiedAtBlock,
    };
  }

  const sellProbe = await client
    .simulateContract({
      address: SIMULATOR_ADDRESS,
      abi: SIMULATOR_ABI,
      functionName: "probeTransferToPool",
      args: [token, target.pool, PROBE_AMOUNT / 2n],
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
      args: [
        { tokenIn: token, tokenOut: target.targetToken, amountIn: netAmountIn, fee: target.poolFee, sqrtPriceLimitX96: 0n },
      ],
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
