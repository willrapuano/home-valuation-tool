import { afterEach, describe, expect, it, vi } from "vitest";
import { KvStore, RestKv, TieredKv } from "./kv";

/**
 * The cache must never be able to break a valuation. A homeowner should get a
 * slow answer when Redis is unreachable, not an error — so the failure paths
 * matter more here than the happy one.
 */

class FakeKv implements KvStore {
  readonly name = "fake";
  readonly store = new Map<string, unknown>();
  reads = 0;
  writes = 0;

  async get<T>(key: string): Promise<T | null> {
    this.reads++;
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.writes++;
    this.store.set(key, value);
  }
}

class BrokenKv implements KvStore {
  readonly name = "broken";
  async get<T>(): Promise<T | null> {
    throw new Error("connection refused");
  }
  async set<T>(): Promise<void> {
    throw new Error("connection refused");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TieredKv", () => {
  it("serves from memory without touching the shared store", async () => {
    const local = new FakeKv();
    const remote = new FakeKv();
    const kv = new TieredKv(local, remote);

    await kv.set("k", { v: 1 }, 60);
    remote.reads = 0;

    expect(await kv.get("k")).toEqual({ v: 1 });
    // The point of the local tier: no network on a warm instance.
    expect(remote.reads).toBe(0);
  });

  it("writes through to the shared store", async () => {
    const local = new FakeKv();
    const remote = new FakeKv();
    await new TieredKv(local, remote).set("k", { v: 1 }, 60);

    expect(remote.store.get("k")).toEqual({ v: 1 });
  });

  it("falls back to the shared store on a cold instance, and promotes the hit", async () => {
    const local = new FakeKv();
    const remote = new FakeKv();
    await remote.set("k", { v: 2 });

    const kv = new TieredKv(local, remote);
    expect(await kv.get("k")).toEqual({ v: 2 });

    // This is the whole reason for the change: a new lambda instance should
    // still get the cached answer, and should not pay for it twice.
    expect(local.store.get("k")).toBeDefined();
  });

  it("serves uncached rather than throwing when the shared store is down", async () => {
    const kv = new TieredKv(new FakeKv(), new BrokenKv());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(kv.get("k")).resolves.toBeNull();
  });

  it("still caches locally when the shared write fails", async () => {
    const local = new FakeKv();
    const kv = new TieredKv(local, new BrokenKv());
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(kv.set("k", { v: 3 }, 60)).resolves.toBeUndefined();
    expect(local.store.get("k")).toEqual({ v: 3 });
  });

  it("works with no shared store configured", async () => {
    const kv = new TieredKv(new FakeKv());
    await kv.set("k", { v: 4 }, 60);
    expect(await kv.get("k")).toEqual({ v: 4 });
    expect(kv.name).toBe("fake");
  });

  it("returns null for a key that was never written", async () => {
    expect(await new TieredKv(new FakeKv(), new FakeKv()).get("nope")).toBeNull();
  });
});

describe("RestKv", () => {
  it("speaks the Upstash command-array protocol", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(String(init.body));
        return new Response(JSON.stringify({ result: JSON.stringify({ v: 5 }) }), { status: 200 });
      })
    );

    const kv = new RestKv("https://kv.test", "tok");
    expect(await kv.get("k")).toEqual({ v: 5 });
    expect(calls[0]).toBe(JSON.stringify(["GET", "k"]));

    await kv.set("k", { v: 5 }, 90);
    expect(calls[1]).toBe(JSON.stringify(["SET", "k", JSON.stringify({ v: 5 }), "EX", 90]));
  });

  it("treats a missing key as a miss, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 }))
    );
    expect(await new RestKv("https://kv.test", "tok").get("absent")).toBeNull();
  });

  it("treats unparseable stored data as a miss rather than crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: "not json{" }), { status: 200 }))
    );
    expect(await new RestKv("https://kv.test", "tok").get("k")).toBeNull();
  });

  it("throws on an HTTP error so the tier above can fall back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(new RestKv("https://kv.test", "tok").get("k")).rejects.toThrow(/HTTP 500/);
  });
});
