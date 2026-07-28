/**
 * Small TTL cache with an LRU bound.
 *
 * IMPORTANT — this is per-instance, in-process memory. On Vercel each lambda
 * instance keeps its own copy, and instances are recycled freely, so the hit
 * rate is best-effort: it collapses bursts and repeat lookups of the same
 * address, but it is not a shared cache and must not be relied on for
 * correctness or for rate-limit enforcement across instances.
 *
 * If this needs to be authoritative (shared quota, dedup across instances),
 * move it to Vercel KV or Upstash Redis — the interface below is deliberately
 * small enough to swap.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh recency for the LRU bound.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /** @param ttlMs overrides the default TTL for this entry only. */
  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
    this.evict();
  }

  /** Number of live (non-expired) entries. */
  get size(): number {
    this.purgeExpired();
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  private evict(): void {
    if (this.store.size <= this.maxEntries) return;
    this.purgeExpired();
    // Map preserves insertion order, so the front is the least recently used.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}

/**
 * Normalise an address into a stable cache key. Valuations do not change
 * minute to minute, so trivial formatting differences ("St" vs "Street",
 * stray commas, casing) should not each get their own upstream call.
 */
export function addressCacheKey(parts: {
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}): string {
  const normalise = (s?: string) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[.,#]/g, " ")
      .replace(/\b(street|str)\b/g, "st")
      .replace(/\b(avenue|ave)\b/g, "av")
      .replace(/\b(road)\b/g, "rd")
      .replace(/\b(drive)\b/g, "dr")
      .replace(/\b(lane)\b/g, "ln")
      .replace(/\b(court)\b/g, "ct")
      .replace(/\b(boulevard|blvd)\b/g, "bl")
      .replace(/\b(place)\b/g, "pl")
      .replace(/\b(terrace)\b/g, "ter")
      .replace(/\b(north|south|east|west)\b/g, m => m[0])
      .replace(/\s+/g, " ")
      .trim();

  return [normalise(parts.address), normalise(parts.city), normalise(parts.state), (parts.zipCode ?? "").trim()]
    .filter(Boolean)
    .join("|");
}
