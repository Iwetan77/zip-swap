import { pad, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { QuoteError, StaleQuoteError, ZipSwapError } from "./errors.js";
import { getQuote } from "./quote.js";
import { buildSwapTx } from "./txbuilder.js";
import type { ChunkedQuote, Quote, SwapReceipt, ZipSwapConfig } from "./types.js";
import { defaultSubmitter, type TxSubmitter } from "./submitter.js";

const TRANSFER_TOPIC: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export class QuoteAlreadyExecutedError extends ZipSwapError {
  constructor() {
    super("this quote has already been executed — request a fresh quote instead of re-executing");
  }
}

const executedQuotes = new WeakSet<Quote>();

function parseAmountOutFromReceipt(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  tokenOut: Address,
  recipient: Address,
): bigint {
  const recipientTopic = pad(recipient, { size: 32 }).toLowerCase();
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenOut.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics[2]?.toLowerCase() !== recipientTopic) continue;
    total += BigInt(log.data);
  }
  return total;
}

export interface ExecuteSwapOptions {
  submitter?: TxSubmitter;
}

/**
 * Thin convenience wrapper: builds the tx (mandatory simulate happens inside
 * buildSwapTx), submits any prerequisites, submits the swap, and parses the
 * real amountOut from the recipient's Transfer log rather than trusting the
 * quote. Each Quote object can only be executed once.
 */
export async function executeSwap(
  quote: Quote,
  wallet: WalletClient,
  publicClient: PublicClient,
  options: ExecuteSwapOptions = {},
): Promise<SwapReceipt> {
  if (executedQuotes.has(quote)) {
    throw new QuoteAlreadyExecutedError();
  }
  executedQuotes.add(quote);

  const submitter = options.submitter ?? defaultSubmitter;
  const recipient = wallet.account!.address;

  const tx = await buildSwapTx(quote, recipient, publicClient);

  for (const prerequisite of tx.prerequisites) {
    const prereqHash = await submitter.submit(wallet, {
      to: prerequisite.to,
      data: prerequisite.data,
      value: prerequisite.value,
    });
    await publicClient.waitForTransactionReceipt({ hash: prereqHash });
  }

  const swapHash = await submitter.submit(wallet, { to: tx.to, data: tx.data, value: tx.value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });

  const amountOut = parseAmountOutFromReceipt(receipt.logs, quote.tokenOut, recipient);

  return {
    txHash: swapHash,
    amountIn: quote.amountIn,
    amountOut,
    recipient,
  };
}

export interface ChunkedSwapResult {
  executedChunks: number;
  totalUsdcOut: bigint;
  remainingIn: bigint;
  receipts: SwapReceipt[];
  aborted: boolean;
}

export interface ExecuteChunkedSwapParams {
  tokenIn: Address;
  chunkedQuote: ChunkedQuote;
  wallet: WalletClient;
  publicClient: PublicClient;
  config: ZipSwapConfig;
  options?: ExecuteSwapOptions;
  /** Fired after each chunk settles (success or exhausted retries) — for progress reporting or, in tests, injecting state changes between chunks. */
  onChunkSettled?: (index: number, receipt: SwapReceipt | null) => void | Promise<void>;
}

/**
 * Executes each chunk in sequence, re-quoting fresh immediately before each
 * one — the planning-time chunk quotes assume the *original* reserves for
 * every chunk, but each executed chunk depletes the pool for the next one,
 * so only a just-in-time re-quote reflects what's actually achievable. If a
 * chunk still hits StaleQuoteError (a race between that re-quote and the
 * on-chain state), it re-quotes once more; two consecutive stale failures
 * on the same chunk abort the remaining chunks. No chunk is ever executed
 * below its own (current) minOut, and partial completion is reported honestly.
 */
export async function executeChunkedSwap(params: ExecuteChunkedSwapParams): Promise<ChunkedSwapResult> {
  const { tokenIn, chunkedQuote, wallet, publicClient, config, options, onChunkSettled } = params;
  const receipts: SwapReceipt[] = [];
  let totalUsdcOut = 0n;
  let executedChunks = 0;
  let aborted = false;

  for (const [index, plannedChunk] of chunkedQuote.chunks.entries()) {
    let staleFailures = 0;
    let succeeded = false;
    let lastReceipt: SwapReceipt | null = null;

    while (staleFailures < 2 && !succeeded) {
      try {
        const fresh = await getQuote({
          tokenIn,
          amountIn: plannedChunk.amountIn,
          slippageBps: plannedChunk.slippageBps,
          config,
        });
        if ("chunks" in fresh) {
          // The pool moved enough that this chunk itself now needs splitting — out of scope, abort.
          staleFailures = 2;
          break;
        }

        const receipt = await executeSwap(fresh, wallet, publicClient, options);
        receipts.push(receipt);
        totalUsdcOut += receipt.amountOut;
        executedChunks += 1;
        succeeded = true;
        lastReceipt = receipt;
      } catch (error) {
        // Both StaleQuoteError (build-time simulate mismatch) and QuoteError
        // (e.g. NoRouteError when the pool is in too disrupted a state to
        // quote at all) mean "this chunk isn't executable right now" — worth
        // one retry before giving up on it.
        if (!(error instanceof StaleQuoteError) && !(error instanceof QuoteError)) throw error;
        staleFailures += 1;
      }
    }

    await onChunkSettled?.(index, lastReceipt);

    if (!succeeded) {
      aborted = true;
      break;
    }
  }

  const executedAmountIn = chunkedQuote.chunks
    .slice(0, executedChunks)
    .reduce((sum, c) => sum + c.amountIn, 0n);

  return {
    executedChunks,
    totalUsdcOut,
    remainingIn: chunkedQuote.totalAmountIn - executedAmountIn,
    receipts,
    aborted,
  };
}
