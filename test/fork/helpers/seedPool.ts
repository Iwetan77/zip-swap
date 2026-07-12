import {
  type Address,
  type PublicClient,
  type WalletClient,
  parseUnits,
} from "viem";

export const ERC20_ABI = [
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
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
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

const FACTORY_ABI = [
  {
    name: "createPool",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
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
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "sqrtPriceX96", type: "uint160" }],
    outputs: [],
  },
  {
    name: "liquidity",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;

const NFPM_ABI = [
  {
    name: "createAndInitializePoolIfNecessary",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;

const FEE_TIER = 3000;
const TICK_SPACING = 60;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
export const FULL_RANGE_TICK_LOWER = Math.ceil(MIN_TICK / TICK_SPACING) * TICK_SPACING;
export const FULL_RANGE_TICK_UPPER = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;

/** Raw 1:1 price (ignores the 18-vs-6 decimals gap) — fine for a disposable test pool. */
function sqrtPriceX96For18Vs6Decimals(_mockIsToken0: boolean): bigint {
  return 2n ** 96n;
}

async function anvilRpc(rpcUrl: string, method: string, params: unknown[]) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
}

/** Impersonates a known USDC-holding pool on the fork to fund `recipient` — disposable fork only. */
export async function fundUsdcFromWhale(
  rpcUrl: string,
  publicClient: PublicClient,
  whale: Address,
  recipient: Address,
  amount: bigint,
  usdc: Address,
): Promise<void> {
  await anvilRpc(rpcUrl, "anvil_impersonateAccount", [whale]);
  await anvilRpc(rpcUrl, "anvil_setBalance", [whale, "0x56BC75E2D63100000"]); // 100 ETH for gas

  const { createWalletClient, http } = await import("viem");
  const whaleClient = createWalletClient({ account: whale, transport: http(rpcUrl) });

  const hash = await whaleClient.writeContract({
    chain: null,
    address: usdc,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [recipient, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  await anvilRpc(rpcUrl, "anvil_stopImpersonatingAccount", [whale]);
}

export interface SeedPoolParams {
  rpcUrl: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: Address;
  mockToken: Address;
  usdc: Address;
  factory: Address;
  nfpm: Address;
  mockAmount?: bigint;
  usdcAmount?: bigint;
}

export interface SeededPool {
  pool: Address;
  feeTier: number;
}

export async function createAndSeedPool(params: SeedPoolParams): Promise<SeededPool> {
  const {
    publicClient,
    walletClient,
    deployer,
    mockToken,
    usdc,
    factory,
    nfpm,
    mockAmount = parseUnits("100000", 18),
    usdcAmount = parseUnits("100000", 6),
  } = params;

  const mockIsToken0 = BigInt(mockToken) < BigInt(usdc);
  const token0 = mockIsToken0 ? mockToken : usdc;
  const token1 = mockIsToken0 ? usdc : mockToken;

  const sqrtPriceX96 = sqrtPriceX96For18Vs6Decimals(mockIsToken0);
  const createHash = await walletClient.writeContract({
    chain: null,
    account: deployer,
    address: nfpm,
    abi: NFPM_ABI,
    functionName: "createAndInitializePoolIfNecessary",
    args: [token0, token1, FEE_TIER, sqrtPriceX96],
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });

  const pool = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "getPool",
    args: [mockToken, usdc, FEE_TIER],
  });

  for (const [token, amount] of [
    [mockToken, mockAmount],
    [usdc, usdcAmount],
  ] as const) {
    const approveHash = await walletClient.writeContract({
      chain: null,
      account: deployer,
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [nfpm, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mintArgs = [
    {
      token0,
      token1,
      fee: FEE_TIER,
      tickLower: FULL_RANGE_TICK_LOWER,
      tickUpper: FULL_RANGE_TICK_UPPER,
      amount0Desired: mockIsToken0 ? mockAmount : usdcAmount,
      amount1Desired: mockIsToken0 ? usdcAmount : mockAmount,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: deployer,
      deadline,
    },
  ] as const;

  // Pre-flight via eth_call before spending gas — also empirically avoids an
  // intermittent revert seen when the mint tx is sent without a preceding
  // simulate on this fork/RPC combination.
  await publicClient.simulateContract({
    account: deployer,
    address: nfpm,
    abi: NFPM_ABI,
    functionName: "mint",
    args: mintArgs,
  });

  const mintHash = await walletClient.writeContract({
    chain: null,
    account: deployer,
    address: nfpm,
    abi: NFPM_ABI,
    functionName: "mint",
    args: mintArgs,
  });
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  if (mintReceipt.status !== "success") {
    throw new Error("pool seeding failed: mint transaction reverted");
  }

  let liquidity = 0n;
  for (let attempt = 0; attempt < 5; attempt++) {
    liquidity = await publicClient.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "liquidity",
      blockNumber: mintReceipt.blockNumber,
    });
    if (liquidity > 0n) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (liquidity <= 0n) {
    throw new Error("pool seeding failed: liquidity is zero after mint");
  }

  return { pool, feeTier: FEE_TIER };
}
