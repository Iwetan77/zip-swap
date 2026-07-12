# Phase 0 Recon — Monad Mainnet Swap Venues

Chain: Monad mainnet, chain ID 143. RPC used for verification: `https://rpc.monad.xyz` (public endpoint, block ~87,068,889 at time of verification).

## Method

Every address below was checked live against Monad RPC before being written to `src/registry/VENUES.json`. Blog posts and docs pages (Uniswap's deployment docs, Circle's contract-address docs) were used only to generate *candidate* addresses — each candidate was then independently confirmed via `eth_getCode` (non-empty bytecode), and for pools, via `factory.getPool(...)` plus `pool.liquidity()` returning non-zero. Raw HTML was scraped directly rather than trusting AI-summarized page content, since a first-pass summary silently corrupted two addresses (dropped/added a hex digit) before the raw-page cross-check caught it.

## Confirmed live

**USDC** — `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`
Confirmed via `eth_getCode` (non-empty) and on-chain `symbol()` → `"USDC"`, `decimals()` → `6`.

**WMON** — `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`
Confirmed via `eth_getCode` and as `token0()` of the verified WMON/USDC pool below.

**Uniswap V3** (official Monad mainnet deployment, per Uniswap's own announcement blog post, addresses independently verified on-chain):
- Factory `0x204faca1764b154221e35c0d20abb3c525710498`
- SwapRouter02 `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900`
- QuoterV2 `0x661e93cca42afacb172121ef892830ca3b70f08d`
- UniversalRouter `0x0d97dc33264bfc1c226207428a79b26757fb9dc3`
- NonfungiblePositionManager `0x7197e214c0b767cfb76fb734ab638e2c192f4e53`
- Multicall `0xd1b797d92d87b688193a2b976efc8d577d204343`
- TickLens `0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f`
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical cross-chain deployment address)

All eight contracts have live, non-empty bytecode on Monad mainnet.

Verified pools (`factory.getPool` recognizes them, and they hold non-zero liquidity):
- WMON/USDC, 0.3% fee tier → pool `0x659bd0bc4167ba25c62e05656f78043e7ed4a9da`, `liquidity()` ≈ 2.6e19
- WMON/USDC, 1% fee tier → pool `0xc33e9e441e6f4e74cdb34f878be51189c9cb00d8`, `liquidity()` ≈ 1.18e17

The 0.05% fee tier (100) pool does not exist for this pair (`getPool` reverts).

**WETH** — `0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242`
**WBTC** — `0x0555E30da8f98308EdB960aa94C0Db47230d2B9c`
**USDT0** — `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` (symbol reads `USDT` on-chain)

All three candidate addresses were sourced from the community token list at `github.com/monad-crypto/token-list` — a lead, not evidence — then independently confirmed via `eth_call symbol()`/`decimals()` and `factory.getPool(...)` + `pool.liquidity()` returning non-zero:
- WETH/USDC, 0.3% fee tier → pool `0x25ef1a210ff55bcee9f8fee979aaff6bd1be5bf1`, `liquidity()` ≈ 2.8e15 (the 0.05% pool exists but has zero liquidity — not used)
- WBTC/USDC, 0.3% fee tier → pool `0xb0b083e0353f7df4d5ee1c812ea8c6960c080373`, `liquidity()` ≈ 3.7e8
- USDT0/USDC, 0.05% fee tier → pool `0xa00d8ec3c0cc20e93cad749695392a0b61fe8ca3`, `liquidity()` ≈ 1.97e11

These three were added during Phase 3 specifically to give the router's fork gate ("3 distinct real tokens → USDC") real, independently-verified tokens to route rather than reusing WMON three times.

**Bug found and fixed while adding these**: `src/registry/verify.ts`'s pool-check loop had hardcoded `VENUES.tokens.WMON` for every `verifiedPools` entry instead of parsing the actual pair from `poolInfo.pair`. It silently passed GATE 0 before because every existing pool happened to be a WMON pair — adding a WETH pair immediately produced mismatched `factory.getPool` results, exposing it. Fixed to look up both token symbols from the pair string.

## Candidates identified but NOT yet verified (do not use until verified)

Search surfaced two other venues repeatedly cited as live on Monad:
- **Kuru Exchange** — AMM/order-book hybrid CLOB. No on-chain address verification performed yet.
- **Bean Exchange** — gamified spot/perp exchange native to Monad. No on-chain address verification performed yet.

These are **not** in `VENUES.json` and **not** implemented in Phase 2 yet. Rule 5 (no trusted constants) means a docs mention is a lead, not evidence — each would need its own bytecode/pool verification pass before an adapter is written against it. Flagging as follow-up work rather than fabricating unverified registry entries.

## What Phase 2 will implement

Given the above, Phase 2 implements exactly one adapter to start: **`univ3.ts`** (UniswapV3-style, via QuoterV2 static-call), backed by the verified Factory/QuoterV2/SwapRouter02 addresses and the verified WMON/USDC pool. Additional adapters (`clob.ts` for Kuru, if it proves out) are deferred until their venues pass the same live-verification bar.

## Connector tokens

Only **WMON** and **USDC** are currently verified as connectors. USDT and WETH (bridged) were in the original architecture sketch as candidate connectors but have not been verified on Monad mainnet — router (Phase 3) will start with a two-token connector set and expand once/if additional connectors are verified.
