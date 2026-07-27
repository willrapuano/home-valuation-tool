import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache, addressCacheKey } from "./cache";
import { RateLimiter, clientKey } from "./rate-limit";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TtlCache", () => {
  it("returns a stored value before expiry and drops it after", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");

    vi.advanceTimersByTime(1001);
    expect(cache.get("k")).toBeUndefined();
  });

  it("honours a per-entry TTL override", () => {
    const cache = new TtlCache<string>(60_000);
    cache.set("short", "v", 500);
    cache.set("long", "v");

    vi.advanceTimersByTime(600);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("v");
  });

  it("evicts least-recently-used entries past the bound", () => {
    const cache = new TtlCache<number>(60_000, 3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // Touching "a" makes "b" the least recently used.
    cache.get("a");
    cache.set("d", 4);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("d")).toBe(4);
  });

  it("does not report expired entries in size", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(cache.size).toBe(0);
  });
});

describe("addressCacheKey", () => {
  it("collapses formatting variants of the same address", () => {
    const a = addressCacheKey({ address: "1234 Ballantrae Lane", city: "McLean", state: "VA", zipCode: "22101" });
    const b = addressCacheKey({ address: "1234 ballantrae ln.", city: "mclean", state: "va", zipCode: "22101" });
    expect(a).toBe(b);
  });

  it("normalises common street-type and direction abbreviations", () => {
    expect(addressCacheKey({ address: "5 North Main Street" }))
      .toBe(addressCacheKey({ address: "5 N Main St" }));
  });

  it("keeps genuinely different addresses distinct", () => {
    const a = addressCacheKey({ address: "1234 Ballantrae Ln", zipCode: "22101" });
    const b = addressCacheKey({ address: "1235 Ballantrae Ln", zipCode: "22101" });
    const c = addressCacheKey({ address: "1234 Ballantrae Ln", zipCode: "22102" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("RateLimiter", () => {
  it("allows a burst up to capacity then blocks", () => {
    const limiter = new RateLimiter(3, 1);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);

    const blocked = limiter.check("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const limiter = new RateLimiter(2, 1);
    limiter.check("ip");
    limiter.check("ip");
    expect(limiter.check("ip").allowed).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("never refills beyond capacity", () => {
    const limiter = new RateLimiter(2, 1);
    vi.advanceTimersByTime(60_000);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(false);
  });

  it("tracks callers independently", () => {
    const limiter = new RateLimiter(1, 1);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("takes the last x-forwarded-for entry, not the first", () => {
    // The platform appends the real peer; the first entry is caller-supplied
    // and could be forged to mint a fresh bucket on every request.
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" });
    expect(clientKey(headers)).toBe("9.9.9.9");
  });

  it("cannot be bypassed by spoofing the leading entry", () => {
    const limiter = new RateLimiter(1, 0.001);
    const forge = (spoof: string) =>
      clientKey(new Headers({ "x-forwarded-for": `${spoof}, 9.9.9.9` }));

    expect(limiter.check(forge("1.1.1.1")).allowed).toBe(true);
    expect(limiter.check(forge("2.2.2.2")).allowed).toBe(false);
  });

  it("falls back to x-real-ip then unknown", () => {
    expect(clientKey(new Headers({ "x-real-ip": "4.4.4.4" }))).toBe("4.4.4.4");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});
