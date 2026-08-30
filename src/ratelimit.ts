/**
 * Per-endpoint token bucket.
 *
 * The API documents 10 requests/second per endpoint and returns 429 past that.
 * We keep a separate bucket per endpoint path so a burst of quote polling cannot
 * starve a portfolio call.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Resolves once a token is available. */
  async acquire(): Promise<void> {
    // Loop rather than compute a single sleep: other callers may drain the bucket
    // while we are waiting.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil((deficit / this.refillPerSecond) * 1000));
      await sleep(waitMs);
    }
  }
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  async acquire(key: string): Promise<void> {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSecond);
      this.buckets.set(key, bucket);
    }
    await bucket.acquire();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
