# zip-swap

Headless swap-routing SDK for [Monad](https://monad.xyz). Give it any ERC-20 on Monad and an amount; it answers exactly one question: what's the best route to end up holding USDC, and what transaction do you sign to do it.

- **Headless.** No UI, no database, no server. Pure functions and RPC calls.
- **Never touches private keys.** Quote and tx-building work with zero signer. Execution accepts an injected [viem](https://viem.sh) `WalletClient`.
- **Quote ≠ execution.** `getQuote` is read-only. `buildSwapTx` returns unsigned calldata. `executeSwap` is a thin, optional wrapper.
- **Every swap has a deadline and a minimum-out bound.** No unbounded swaps, ever.
- **No trusted constants.** Every router/pool/token address is verified live against Monad RPC before use — see [`RECON.md`](./RECON.md).
- **Balance-delta safety.** Sell-side token safety (fee-on-transfer, honeypots) is checked via `eth_call` state-override simulation, not just a claimed quote.

## Install

```bash
npm install zip-swap
```

## Quickstart

```ts
import { getQuote, buildSwapTx, executeSwap } from "zip-swap";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

process.env.MONAD_RPC_URL = "https://rpc.monad.xyz";
process.env.MONAD_CHAIN_ID = "143";

// 1. Quote — read-only, no signer needed.
const quote = await getQuote({
  tokenIn: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", // WMON
  amountIn: 10n ** 18n, // 1 WMON
  slippageBps: 50, // 0.5%
});

if ("chunks" in quote) {
  console.log(`Order split into ${quote.chunks.length} chunks`);
} else {
  console.log(`Expect ~${quote.expectedOut} USDC, min ${quote.minOut}`);
}
```

The 3-call flow for a full swap:

```ts
if (!("chunks" in quote)) {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, transport: http(process.env.MONAD_RPC_URL) });
  const publicClient = createPublicClient({ transport: http(process.env.MONAD_RPC_URL) });

  // 2. Build — unsigned calldata, mandatory eth_call simulation before it's returned.
  const tx = await buildSwapTx(quote, account.address, publicClient);
  // tx.prerequisites may include an ERC-20 approve — submit those first if present.

  // 3. Execute — thin wrapper around signing/submitting; parses the real amountOut from logs.
  const receipt = await executeSwap(quote, wallet, publicClient);
  console.log(`Swapped for ${receipt.amountOut} USDC, tx ${receipt.txHash}`);
}
```

## API reference

| Function | Description |
| --- | --- |
| `getQuote({ tokenIn, amountIn, slippageBps? })` | Read-only. Returns a `Quote`, or a `ChunkedQuote` if the order is large enough to need splitting to stay under the price-impact ceiling. |
| `buildSwapTx(quote, recipient, publicClient)` | Builds unsigned calldata for `SwapRouter02`, with `minOut`/`deadline` baked in. Simulates via `eth_call` before returning; throws `StaleQuoteError` if the simulated output no longer clears `minOut`. |
| `executeSwap(quote, wallet, publicClient)` | Submits any prerequisites (e.g. approval), then the swap, then parses the actual `amountOut` from the recipient's `Transfer` log. Each `Quote` can only be executed once. |
| `executeChunkedSwap({ tokenIn, chunkedQuote, wallet, publicClient, config })` | Executes a `ChunkedQuote`'s pieces in sequence, re-quoting immediately before each one. Aborts with honest partial accounting (`executedChunks`, `totalUsdcOut`, `remainingIn`) if a chunk fails twice in a row. |
| `classify({ client, token, usdc, pool, quoterV2, poolFee })` | Sell-side safety check via state-override simulation. Returns a tier (`stable`/`major`/`standard`/`degen`/`blocked`) plus detected transfer tax. |
| `listVenues()` / `isSupported(token)` | Introspection helpers. |

All monetary amounts are `bigint` in the token's native decimals. All errors are typed subclasses of `ZipSwapError` (see `src/errors.ts`): `NoRouteError`, `PriceImpactExceededError`, `StaleQuoteError`, `SlippageExceededError`, `UnsafeTokenError`, `ChainIdMismatchError`.

### Configuration

Reads `MONAD_RPC_URL` (required) and `MONAD_CHAIN_ID` (required, verified against the live RPC — a mismatch throws `ChainIdMismatchError`) from the environment by default. Pass an explicit `config` object to any call to override:

```ts
import { loadConfig } from "zip-swap";

const config = loadConfig({ rpcUrl: "https://rpc.monad.xyz", chainId: 143 });
const quote = await getQuote({ tokenIn, amountIn, config });
```

## Architecture

```
src/
  types.ts, errors.ts, config.ts   — public types, error taxonomy, config/chain-id loading
  registry/VENUES.json             — every venue/token address, with its on-chain verification evidence
  adapters/univ3.ts                — Uniswap V3 adapter (QuoterV2 static calls)
  safety.ts                        — sell-side token classification via eth_call state overrides
  router.ts                        — direct + 1-hop-via-connector best-route search
  txbuilder.ts                     — unsigned calldata + mandatory pre-return simulation
  chunker.ts                       — splits large orders under the price-impact ceiling
  execute.ts, submitter.ts         — signer wrapper, receipt parsing, pluggable tx submission
  quote.ts                         — getQuote, wiring the above together
```

Every address in `VENUES.json` carries its verification method and evidence — see [`RECON.md`](./RECON.md) for the full recon writeup, including venues that were considered and rejected for lack of on-chain proof.

### Integrating zip-swap into a larger platform

zip-swap is designed to be a dependency, not a service:

1. **Install and instantiate.** `npm install zip-swap`, set `MONAD_RPC_URL`/`MONAD_CHAIN_ID` (or pass `config` explicitly per-call — safe for multi-tenant use where different callers might use different RPC endpoints).
2. **Quote on your platform's read path.** `getQuote` has no side effects and no signer dependency — call it from API routes, background jobs, or anywhere you need a live price.
3. **Build and execute on your platform's write path**, where you already hold (or can request) a `WalletClient` for the user's key. zip-swap never generates, stores, or requests private keys itself.
4. **Handle `ChunkedQuote` explicitly.** Large orders don't throw — they come back as a plan your platform can show the user before committing to `executeChunkedSwap`.
5. **Swap in a protected submission lane later** by implementing the `TxSubmitter` interface and passing it to `executeSwap`/`executeChunkedSwap` — no router or builder code changes required.

## CLI (quote only — no signing)

```bash
npx zip-swap quote --in 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A --amount 1 --slippage 50
```

```bash
export MONAD_RPC_URL=https://rpc.monad.xyz
export MONAD_CHAIN_ID=143
npx zip-swap quote --in <tokenAddress> --amount <humanAmount> [--decimals 18] [--slippage 50]
```

Prints the quote (or chunk plan) as JSON. The CLI never accepts a private key and never submits a transaction.

## Development

```bash
npm install
npm run typecheck
npm run test:unit          # pure logic, no network
npm run verify:registry    # re-verifies every VENUES.json entry against live RPC
npm run test:fork          # anvil-fork integration tests against real Monad state (requires foundry)
npm run build              # tsup — ESM + CJS + CLI
```

## Non-goals

Bridging, fiat/off-ramp logic, user accounts, fee collection, or buy-side honeypot checks (users arrive already holding the token — sell-side safety is what matters). These belong to whatever platform consumes zip-swap, not to zip-swap itself.

## License

MIT
