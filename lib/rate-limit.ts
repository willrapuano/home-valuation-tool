/**
 * Token-bucket rate limiter.
 *
 * Same caveat as the cache: this is per-instance memory. On Vercel it will
 * blunt a burst from one client hitting one instance, which is the common
 * abuse case, but a distributed flood across many instances gets a share of
 * the budget per instance. Treat it as a speed bump, not a quota system —
 * for a real limit, back it with Vercel KV or Upstash.
 *
 * It is still worth having: /api/avm fans out to paid third-party APIs, so an
 * unthrottled public endpoint is a billing risk as much as a load one.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until at least one token is available. 0 when allowed. */
  retryAfter: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * @param capacity  burst size — tokens available at once
   * @param refillPerSec  sustained rate
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly maxKeys = 10_000
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Unbounded key growth is itself a memory-exhaustion vector.
      if (this.buckets.size >= this.maxKeys) this.evictStale(now);
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfter: 0 };
    }

    const deficit = 1 - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil(deficit / this.refillPerSec)),
    };
  }

  reset(): void {
    this.buckets.clear();
  }

  private evictStale(now: number): void {
    // Anything already refilled to capacity carries no state worth keeping.
    const fullAfterMs = (this.capacity / this.refillPerSec) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill >= fullAfterMs) this.buckets.delete(key);
    }
    // Still full: drop oldest-inserted until there's room.
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}

/**
 * Best-effort client identity. `x-forwarded-for` is client-controllable in
 * general, but on Vercel the platform appends the real peer address, so the
 * LAST entry is the trustworthy one — taking the first would let a caller
 * forge a new identity per request and bypass the limit entirely.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return headers.get("x-real-ip") ?? "unknown";
}
