export class ZipSwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class QuoteError extends ZipSwapError {}

export class NoRouteError extends QuoteError {
  constructor(tokenIn: string, tokenOut: string) {
    super(`no route found from ${tokenIn} to ${tokenOut}`);
  }
}

export class PriceImpactExceededError extends QuoteError {
  constructor(priceImpactBps: number, ceilingBps: number) {
    super(`price impact ${priceImpactBps}bps exceeds ceiling ${ceilingBps}bps`);
  }
}

export class StaleQuoteError extends ZipSwapError {
  constructor(expectedMinOut: bigint, simulatedOut: bigint) {
    super(
      `quote is stale: simulated output ${simulatedOut} is below minOut ${expectedMinOut}`,
    );
  }
}

export class SlippageExceededError extends ZipSwapError {
  constructor(minOut: bigint, actualOut: bigint) {
    super(`slippage exceeded: expected at least ${minOut}, got ${actualOut}`);
  }
}

export class UnsafeTokenError extends ZipSwapError {
  constructor(token: string, reason: string) {
    super(`token ${token} classified unsafe: ${reason}`);
  }
}

export class ChainIdMismatchError extends ZipSwapError {
  constructor(expected: number, actual: number) {
    super(`chain id mismatch: configured ${expected}, RPC reports ${actual}`);
  }
}

export class QuoteExpiredError extends ZipSwapError {
  constructor(quotedAtBlock: bigint, ttl: number) {
    super(`quote expired: quoted at block ${quotedAtBlock}, ttl ${ttl}s elapsed`);
  }
}
