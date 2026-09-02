/** Per-client token bucket. Small, in-process; the API is private-LAN only. */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.perMinute, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsed = nowMs - bucket.lastRefillMs;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.perMinute, bucket.tokens + (elapsed / 60_000) * this.perMinute);
      bucket.lastRefillMs = nowMs;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drop idle buckets so long-running processes do not grow unbounded. */
  sweep(idleMs = 10 * 60_000): void {
    const cutoff = this.now() - idleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefillMs < cutoff) this.buckets.delete(key);
    }
  }
}
