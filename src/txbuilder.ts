import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { StaleQuoteError } from "./errors.js";
import type { Quote, RouteHop, SwapPrerequisite, SwapTx } from "./types.js";
import VENUES from "./registry/VENUES.json" with { type: "json" };

const MAX_ALLOWANCE_SLOTS = 20;
const OVERRIDE_ALLOWANCE = (2n ** 256n) - 1n;

const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
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
] as const;

const SWAP_ROUTER_ABI = [
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
  {
    name: "exactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

function feeTierOf(hop: RouteHop): number {
  const fee = hop.poolMeta?.["feeTier"];
  if (typeof fee !== "number") {
    throw new Error(`route hop for venue "${hop.venue}" is missing a feeTier in poolMeta`);
  }
  return fee;
}

function encodeV3Path(hops: RouteHop[]): Hex {
  const types: string[] = ["address"];
  const values: unknown[] = [hops[0]!.tokenIn];
  for (const hop of hops) {
    types.push("uint24", "address");
    values.push(feeTierOf(hop), hop.tokenOut);
  }
  return encodePacked(types, values);
}

function buildSwapCalldata(quote: Quote, recipient: Address): Hex {
  const hops = quote.route.hops;
  const swapRouter02 = VENUES.venues[0]!.contracts.swapRouter02.address as Address;

  const innerCalldata =
    hops.length === 1
      ? encodeFunctionData({
          abi: SWAP_ROUTER_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: quote.tokenIn,
              tokenOut: quote.tokenOut,
              fee: feeTierOf(hops[0]!),
              recipient,
              amountIn: quote.amountIn,
              amountOutMinimum: quote.minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      : encodeFunctionData({
          abi: SWAP_ROUTER_ABI,
          functionName: "exactInput",
          args: [
            {
              path: encodeV3Path(hops),
              recipient,
              amountIn: quote.amountIn,
              amountOutMinimum: quote.minOut,
            },
          ],
        });

  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "multicall",
    args: [quote.deadline, [innerCalldata]],
  });
}

function allowanceSlotOverride(owner: Address, spender: Address, slot: number, amount: bigint) {
  const innerKey = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(slot)]),
  );
  const outerKey = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, innerKey]),
  );
  return { [outerKey]: pad(toHex(amount), { size: 32 }) };
}

function toStateDiff(overrides: Record<string, Hex>) {
  return Object.entries(overrides).map(([slot, value]) => ({ slot: slot as Hex, value }));
}

async function findAllowanceSlot(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<number | null> {
  const probeAmount = 123_456_789n;
  for (let slot = 0; slot < MAX_ALLOWANCE_SLOTS; slot++) {
    const result = await client
      .readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, spender],
        stateOverride: [
          { address: token, stateDiff: toStateDiff(allowanceSlotOverride(owner, spender, slot, probeAmount)) },
        ],
      })
      .catch(() => null);
    if (result === probeAmount) return slot;
  }
  return null;
}

/**
 * Builds unsigned swap calldata (SwapRouter02, wrapped in its deadline-checked
 * multicall) with minOut/deadline baked in, plus any approval prerequisite.
 * Mandatory simulate: the swap is eth_call-simulated (with a temporary
 * allowance override, since the real approval is only a *prerequisite* the
 * caller hasn't submitted yet) and must clear minOut or this throws
 * StaleQuoteError rather than returning a tx that could revert or get sandwiched.
 */
export async function buildSwapTx(
  quote: Quote,
  recipient: Address,
  client: PublicClient,
): Promise<SwapTx> {
  const swapRouter02 = VENUES.venues[0]!.contracts.swapRouter02.address as Address;

  const currentAllowance = await client.readContract({
    address: quote.tokenIn,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [recipient, swapRouter02],
  });

  const prerequisites: SwapPrerequisite[] = [];
  if (currentAllowance < quote.amountIn) {
    prerequisites.push({
      to: quote.tokenIn,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [swapRouter02, quote.amountIn],
      }),
      value: 0n,
      description: `approve SwapRouter02 to spend ${quote.amountIn} of ${quote.tokenIn}`,
    });
  }

  const swapCalldata = buildSwapCalldata(quote, recipient);

  let stateOverride: Parameters<PublicClient["call"]>[0]["stateOverride"];
  if (currentAllowance < quote.amountIn) {
    const slot = await findAllowanceSlot(client, quote.tokenIn, recipient, swapRouter02);
    if (slot !== null) {
      stateOverride = [
        {
          address: quote.tokenIn,
          stateDiff: toStateDiff(allowanceSlotOverride(recipient, swapRouter02, slot, OVERRIDE_ALLOWANCE)),
        },
      ];
    }
  }

  const simulated = await client
    .call({
      account: recipient,
      to: swapRouter02,
      data: swapCalldata,
      ...(stateOverride ? { stateOverride } : {}),
    })
    .catch(() => null);

  if (!simulated?.data) {
    throw new StaleQuoteError(quote.minOut, 0n);
  }

  const [results] = decodeAbiParameters([{ type: "bytes[]" }], simulated.data);
  const lastResult = results[results.length - 1] as Hex;
  const [simulatedOut] = decodeAbiParameters([{ type: "uint256" }], lastResult);

  if (simulatedOut < quote.minOut) {
    throw new StaleQuoteError(quote.minOut, simulatedOut);
  }

  return {
    to: swapRouter02,
    data: swapCalldata,
    value: 0n,
    prerequisites,
    minOut: quote.minOut,
    deadline: quote.deadline,
    simulatedOut,
  };
}
