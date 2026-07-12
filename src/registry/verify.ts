import { createPublicClient, http, type Address, decodeAbiParameters } from "viem";
import VENUES from "./VENUES.json" with { type: "json" };

const RPC_URL = process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz";
const EXPECTED_CHAIN_ID = Number(process.env.MONAD_CHAIN_ID ?? "143");

const client = createPublicClient({ transport: http(RPC_URL) });

let failed = false;

function fail(msg: string): void {
  failed = true;
  console.error(`RED  ${msg}`);
}

function pass(msg: string): void {
  console.log(`green ${msg}`);
}

async function hasCode(address: Address): Promise<boolean> {
  const code = await client.getCode({ address });
  return !!code && code !== "0x";
}

async function main() {
  const chainId = await client.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    fail(`chain id mismatch: RPC reports ${chainId}, expected ${EXPECTED_CHAIN_ID}`);
  } else {
    pass(`chain id matches: ${chainId}`);
  }

  for (const [symbol, token] of Object.entries(VENUES.tokens)) {
    const addr = token.address as Address;
    if (!(await hasCode(addr))) {
      fail(`${symbol} (${addr}) has no bytecode`);
      continue;
    }
    pass(`${symbol} (${addr}) has bytecode`);

    if (symbol === "USDC") {
      const symbolResult = await client.call({
        to: addr,
        data: "0x95d89b41",
      });
      const decimalsResult = await client.call({
        to: addr,
        data: "0x313ce567",
      });
      const [decodedSymbol] = decodeAbiParameters(
        [{ type: "string" }],
        (symbolResult.data ?? "0x") as `0x${string}`,
      );
      const decodedDecimals = decodedSymbol
        ? BigInt(decimalsResult.data ?? "0x0")
        : 0n;
      if (decodedSymbol !== "USDC") {
        fail(`USDC symbol() returned "${decodedSymbol}", expected "USDC"`);
      } else {
        pass(`USDC symbol() confirmed: "${decodedSymbol}"`);
      }
      if (decodedDecimals !== 6n) {
        fail(`USDC decimals() returned ${decodedDecimals}, expected 6`);
      } else {
        pass(`USDC decimals() confirmed: ${decodedDecimals}`);
      }
    }
  }

  for (const venue of VENUES.venues) {
    for (const [name, contract] of Object.entries(venue.contracts)) {
      const addr = contract.address as Address;
      if (!(await hasCode(addr))) {
        fail(`${venue.name}.${name} (${addr}) has no bytecode`);
      } else {
        pass(`${venue.name}.${name} (${addr}) has bytecode`);
      }
    }

    for (const poolInfo of venue.verifiedPools) {
      const factory = venue.contracts.factory.address as Address;
      const [tokenASymbol, tokenBSymbol] = poolInfo.pair.split("/");
      const tokenA = (VENUES.tokens as Record<string, { address: string }>)[tokenASymbol!]
        ?.address as Address;
      const tokenB = (VENUES.tokens as Record<string, { address: string }>)[tokenBSymbol!]
        ?.address as Address;
      if (!tokenA || !tokenB) {
        fail(`${venue.name} pool entry "${poolInfo.pair}" references an unknown token symbol`);
        continue;
      }
      const feeHex = poolInfo.feeTier.toString(16).padStart(64, "0");
      const data = `0x1698ee82${tokenA.slice(2).padStart(64, "0").toLowerCase()}${tokenB
        .slice(2)
        .padStart(64, "0")
        .toLowerCase()}${feeHex}` as `0x${string}`;
      const result = await client.call({ to: factory, data });
      const returnedPool = `0x${(result.data ?? "0x").slice(-40)}`.toLowerCase();
      if (returnedPool !== poolInfo.pool.toLowerCase()) {
        fail(
          `${venue.name} factory.getPool(${poolInfo.pair}, ${poolInfo.feeTier}) returned ${returnedPool}, expected ${poolInfo.pool}`,
        );
        continue;
      }
      if (!(await hasCode(poolInfo.pool as Address))) {
        fail(`${venue.name} pool ${poolInfo.pool} has no bytecode`);
        continue;
      }
      const liquidityResult = await client.call({
        to: poolInfo.pool as Address,
        data: "0x1a686502",
      });
      const liquidity = BigInt(liquidityResult.data ?? "0x0");
      if (liquidity <= 0n) {
        fail(`${venue.name} pool ${poolInfo.pool} has zero liquidity`);
      } else {
        pass(`${venue.name} pool ${poolInfo.pool} (${poolInfo.pair} ${poolInfo.feeTier}) liquidity=${liquidity}`);
      }
    }
  }

  if (failed) {
    console.error("\nGATE 0: RED");
    process.exit(1);
  }
  console.log("\nGATE 0: GREEN");
}

main().catch((err) => {
  console.error("RED  unexpected error during verification:", err);
  process.exit(1);
});
