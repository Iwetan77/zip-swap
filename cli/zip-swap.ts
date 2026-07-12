#!/usr/bin/env node
import type { Address } from "viem";
import { getQuote } from "../src/quote.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args[key] = value;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

function printUsage(): void {
  console.error(
    "Usage: zip-swap quote --in <tokenAddress> --amount <humanAmount> [--decimals <n>] [--slippage <bps>]",
  );
  console.error("Reads MONAD_RPC_URL and MONAD_CHAIN_ID from the environment. Quote only — no signing.");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command !== "quote") {
    printUsage();
    process.exit(1);
  }

  const args = parseArgs(rest);
  if (!args["in"] || !args["amount"]) {
    printUsage();
    process.exit(1);
  }

  const decimals = args["decimals"] ? Number(args["decimals"]) : 18;
  const amountIn = BigInt(Math.round(Number(args["amount"]) * 10 ** decimals));
  const slippageBps = args["slippage"] ? Number(args["slippage"]) : undefined;

  const quote = await getQuote({
    tokenIn: args["in"] as Address,
    amountIn,
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  });

  if ("chunks" in quote) {
    console.log(
      JSON.stringify(
        {
          type: "chunked",
          chunkCount: quote.chunks.length,
          totalAmountIn: quote.totalAmountIn.toString(),
          totalExpectedOut: quote.totalExpectedOut.toString(),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.amountIn.toString(),
        expectedOut: quote.expectedOut.toString(),
        minOut: quote.minOut.toString(),
        priceImpactBps: quote.priceImpactBps,
        slippageBps: quote.slippageBps,
        hops: quote.route.hops.map((hop) => ({ venue: hop.venue, pool: hop.pool })),
        quotedAtBlock: quote.quotedAtBlock.toString(),
        deadline: quote.deadline.toString(),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
