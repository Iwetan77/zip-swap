import { describe, expect, it } from "vitest";
import { assertChainId, loadConfig } from "../../src/config.js";
import { ChainIdMismatchError } from "../../src/errors.js";

describe("loadConfig", () => {
  it("loads from explicit overrides without touching env", () => {
    const config = loadConfig({ rpcUrl: "https://example.invalid", chainId: 143 });
    expect(config.rpcUrl).toBe("https://example.invalid");
    expect(config.chainId).toBe(143);
    expect(config.maxPriceImpactBps).toBe(500);
    expect(config.defaultSlippageBps.major).toBe(50);
    expect(config.quoteTtlSeconds.degen).toBe(5);
  });

  it("throws when rpcUrl is missing", () => {
    const prevRpc = process.env.MONAD_RPC_URL;
    delete process.env.MONAD_RPC_URL;
    expect(() => loadConfig({ chainId: 143 })).toThrow(/MONAD_RPC_URL/);
    if (prevRpc !== undefined) process.env.MONAD_RPC_URL = prevRpc;
  });

  it("throws when chainId is missing", () => {
    const prevChainId = process.env.MONAD_CHAIN_ID;
    delete process.env.MONAD_CHAIN_ID;
    expect(() => loadConfig({ rpcUrl: "https://example.invalid" })).toThrow(
      /MONAD_CHAIN_ID/,
    );
    if (prevChainId !== undefined) process.env.MONAD_CHAIN_ID = prevChainId;
  });
});

describe("assertChainId", () => {
  const config = loadConfig({ rpcUrl: "https://example.invalid", chainId: 143 });

  it("resolves silently when RPC chain id matches config", async () => {
    const mockClient = { getChainId: async () => 143 };
    await expect(assertChainId(mockClient, config)).resolves.toBeUndefined();
  });

  it("throws ChainIdMismatchError when RPC chain id differs from config", async () => {
    const mockClient = { getChainId: async () => 1 };
    await expect(assertChainId(mockClient, config)).rejects.toThrow(
      ChainIdMismatchError,
    );
  });

  it("includes both chain ids in the error message", async () => {
    const mockClient = { getChainId: async () => 999 };
    await expect(assertChainId(mockClient, config)).rejects.toThrow(
      /configured 143.*RPC reports 999/,
    );
  });
});
