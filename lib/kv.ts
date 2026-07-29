import { TtlCache } from "./cache";

/**
 * Two-tier cache: per-instance memory in front of an optional shared store.
 *
 * WHY THIS EXISTS
 *
 * The valuation cache was a plain in-process `TtlCache`, which dies with the
 * serverless instance holding it. Measured against production
 * (`scripts/latency-probe.ts`), the same address returned 511ms and flagged
 * `cached: true` on one run and 4,371ms and uncached on the next — the second
 * request had simply landed on a different lambda. Under real traffic, spread
 * across instances, most repeat lookups miss a cache we believe is working.
 *
 * WHAT THIS DOES AND DOES NOT FIX
 *
 * It fixes repeat lookups: refreshes, back-navigation, an agent re-opening a
 * report, two people asking about the same house. Those become fast and stay
 * fast regardless of which instance answers.
 *
 * It does NOT meaningfully move first-visit latency, and it would be dishonest
 * to claim otherwise. A homeowner typing their address for the first time is a
 * cache miss by definition, and that request still costs two to four upstream
 * ArcGIS round trips. Fixing that means holding the sales data ourselves —
 * see docs/datastore.md.
 *
 * CONFIGURATION
 *
 * With no environment variables set this behaves exactly as before: in-process
 * memory only, no network calls, no failures. Setting Vercel KV or Upstash
 * credentials upgrades it in place with no code change:
 *
 *   KV_REST_API_URL + KV_REST_API_TOKEN              (Vercel KV)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash)
 */

export interface KvStore {
  readonly name: string;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /**
   * Atomic increment, returning the new value, or null if this store cannot
   * count meaningfully. Per-instance memory returns null on purpose: a counter
   * that only sees one lambda's traffic is not a smaller number, it is a wrong
   * one, and reporting it as a total would be worse than reporting nothing.
   */
  incr(key: string): Promise<number | null>;
}

const REMOTE_TIMEOUT_MS = 1_500;

/** Per-instance memory. Always present, always first. */
class MemoryKv implements KvStore {
  readonly name = "memory";
  // Generous TTL here; per-entry expiry is enforced by the wrapper.
  private readonly store = new TtlCache<{ value: unknown; expiresAt: number }>(
    24 * 60 * 60 * 1000,
    1000
  );

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) return null;
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /** See the interface: a per-instance total is a wrong total. */
  async incr(): Promise<number | null> {
    return null;
  }
}

/**
 * Upstash-compatible REST store, which Vercel KV also speaks.
 *
 * Deliberately no SDK: the protocol is a JSON command array posted to one
 * endpoint, and a dependency for that is not worth the supply-chain surface.
 */
export class RestKv implements KvStore {
  readonly name = "rest";

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`KV returned HTTP ${res.status}`);
      const data = (await res.json()) as { result?: unknown; error?: string };
      if (data?.error) throw new Error(`KV error: ${data.error}`);
      return data?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.command(["GET", key]);
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.command(["SET", key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds))]);
  }

  async incr(key: string): Promise<number | null> {
    const result = await this.command(["INCR", key]);
    return typeof result === "number" ? result : null;
  }

  /** Read many counters in one round trip. */
  async mget(keys: string[]): Promise<Record<string, number>> {
    if (!keys.length) return {};
    const raw = await this.command(["MGET", ...keys]);
    const values = Array.isArray(raw) ? raw : [];
    const out: Record<string, number> = {};
    keys.forEach((k, i) => {
      const n = Number(values[i]);
      if (Number.isFinite(n)) out[k] = n;
    });
    return out;
  }
}

/**
 * Memory first, then the shared store. A write populates both.
 *
 * Every remote call is wrapped so a cache problem can never fail a valuation:
 * the cache is an optimisation, and a homeowner should get a slow answer
 * rather than an error because Redis is unreachable.
 */
export class TieredKv implements KvStore {
  readonly name: string;

  constructor(
    private readonly local: KvStore,
    private readonly remote?: KvStore
  ) {
    this.name = remote ? `${local.name}+${remote.name}` : local.name;
  }

  async get<T>(key: string): Promise<T | null> {
    const local = await this.local.get<T>(key);
    if (local !== null) return local;
    if (!this.remote) return null;

    try {
      const remote = await this.remote.get<T>(key);
      if (remote !== null) {
        // Promote so the next request on this instance skips the network.
        await this.local.set(key, remote, 300);
      }
      return remote;
    } catch (err) {
      console.warn(`[kv] remote read failed, serving uncached: ${(err as Error)?.message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.local.set(key, value, ttlSeconds);
    if (!this.remote) return;
    try {
      await this.remote.set(key, value, ttlSeconds);
    } catch (err) {
      console.warn(`[kv] remote write failed, memory only: ${(err as Error)?.message}`);
    }
  }

  /** Only the shared store can count; memory returns null by design. */
  async incr(key: string): Promise<number | null> {
    if (!this.remote) return null;
    try {
      return await this.remote.incr(key);
    } catch (err) {
      console.warn(`[kv] counter increment failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /** The shared store, when configured, for bulk counter reads. */
  get shared(): KvStore | undefined {
    return this.remote;
  }
}

function remoteFromEnv(): KvStore | undefined {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;
  return new RestKv(url.replace(/\/+$/, ""), token);
}

let singleton: TieredKv | undefined;

/** Process-wide cache. Safe to call on every request. */
export function getKv(): TieredKv {
  if (!singleton) singleton = new TieredKv(new MemoryKv(), remoteFromEnv());
  return singleton;
}

/** Whether a shared store is configured, for /api/health to report honestly. */
export function hasSharedCache(): boolean {
  return Boolean(remoteFromEnv());
}

/** Test seam. */
export function __setKvForTests(kv: TieredKv | undefined): void {
  singleton = kv;
}
