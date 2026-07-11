import { createPublicClient, http, type PublicClient } from "viem";
import { ChainIdMismatchError } from "./errors.js";
import type { ZipSwapConfig } from "./types.js";
import VENUES from "./registry/VENUES.json" with { type: "json" };

const DEFAULT_MAX_PRICE_IMPACT_BPS = 500;

export function loadConfig(overrides: Partial<ZipSwapConfig> = {}): ZipSwapConfig {
  const rpcUrl = overrides.rpcUrl ?? process.env.MONAD_RPC_URL;
  if (!rpcUrl) {
    throw new Error("MONAD_RPC_URL is required (set env var or pass rpcUrl override)");
  }

  const chainIdRaw = overrides.chainId ?? process.env.MONAD_CHAIN_ID;
  if (chainIdRaw === undefined) {
    throw new Error("MONAD_CHAIN_ID is required (set env var or pass chainId override)");
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`MONAD_CHAIN_ID must be a positive integer, got "${chainIdRaw}"`);
  }

  return {
    rpcUrl,
    chainId,
    usdc: overrides.usdc ?? (VENUES.tokens.USDC.address as `0x${string}`),
    connectors: overrides.connectors ?? [VENUES.tokens.WMON.address as `0x${string}`],
    defaultSlippageBps: overrides.defaultSlippageBps ?? {
      stable: 10,
      major: 50,
      standard: 100,
      degen: 300,
    },
    quoteTtlSeconds: overrides.quoteTtlSeconds ?? {
      stable: 60,
      major: 30,
      standard: 15,
      degen: 5,
    },
    maxPriceImpactBps: overrides.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS,
  };
}

export function createClient(config: ZipSwapConfig): PublicClient {
  return createPublicClient({ transport: http(config.rpcUrl) }) as PublicClient;
}

/** Throws ChainIdMismatchError if the live RPC's chain id doesn't match config. Never trust a configured chain id blindly. */
export async function assertChainId(
  client: Pick<PublicClient, "getChainId">,
  config: ZipSwapConfig,
): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== config.chainId) {
    throw new ChainIdMismatchError(config.chainId, actual);
  }
}
