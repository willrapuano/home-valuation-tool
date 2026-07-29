import { afterEach, describe, expect, it, vi } from "vitest";
import { EsriPermanentError, esriQuery, isPermanent } from "./esri";

/**
 * Hedging exists to cut tail latency, and it is concurrency code that fails
 * quietly if it is wrong — a broken hedge either never fires (no benefit) or
 * doubles every request (real cost against a public service). These pin the
 * behaviour that matters.
 */

const ok = (features: unknown[]) =>
  new Response(JSON.stringify({ features }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const feature = (id: string) => ({ attributes: { ID: id } });

function stubFetch(impl: (call: number, signal?: AbortSignal) => Promise<Response>) {
  let calls = 0;
  const spy = vi.fn((_url: string, init?: RequestInit) => impl(++calls, init?.signal ?? undefined));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A delay that aborts like a real fetch does. Without honouring the signal the
 * stub would happily resolve after the caller had already given up, so the
 * timeout path would never be exercised.
 */
function delayUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    });
  });
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

const BASE = { url: "https://example.test/query", params: {}, label: "Test GIS" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("esriQuery hedging", () => {
  it("does not fire a second request when the first is fast", async () => {
    const spy = stubFetch(async () => ok([feature("a")]));

    const out = await esriQuery({ ...BASE, timeoutMs: 5000, hedgeAfterMs: 100 });

    expect(out).toEqual([feature("a")]);
    // The whole point: the hedge must not double traffic on the common path.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fires a hedge when the first request stalls, and takes whichever answers", async () => {
    const spy = stubFetch(async (call, signal) => {
      if (call === 1) {
        await delayUnlessAborted(5_000, signal); // stalled
        return ok([feature("slow")]);
      }
      return ok([feature("hedge")]);
    });

    const started = Date.now();
    const out = await esriQuery({ ...BASE, timeoutMs: 9000, hedgeAfterMs: 50 });
    const elapsed = Date.now() - started;

    expect(out).toEqual([feature("hedge")]);
    expect(spy).toHaveBeenCalledTimes(2);
    // Previously this cost the full timeout before a retry even began.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("still returns the original request's answer if it wins the race", async () => {
    const spy = stubFetch(async (call, signal) => {
      if (call === 1) {
        await delay(120);
        return ok([feature("original")]);
      }
      await delayUnlessAborted(5_000, signal);
      return ok([feature("hedge")]);
    });

    // A slow-but-succeeding query must not be abandoned just because it was
    // slow enough to trigger a hedge.
    const out = await esriQuery({ ...BASE, timeoutMs: 9000, hedgeAfterMs: 50 });

    expect(out).toEqual([feature("original")]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent service error", async () => {
    const spy = stubFetch(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid field: NOPE" } }), { status: 200 })
    );

    await expect(esriQuery({ ...BASE, timeoutMs: 5000, hedgeAfterMs: 100 })).rejects.toThrow(
      /Invalid field/
    );
    // A malformed query fails identically on retry; retrying wastes a request
    // and delays the error the caller needs to see.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first request fails quickly for a transient reason", async () => {
    const spy = stubFetch(async call => {
      if (call === 1) throw new Error("socket hang up");
      return ok([feature("recovered")]);
    });

    const out = await esriQuery({ ...BASE, timeoutMs: 5000, hedgeAfterMs: 100 });

    expect(out).toEqual([feature("recovered")]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("surfaces a useful message when every attempt fails", async () => {
    stubFetch(async () => {
      await delay(80);
      throw new Error("upstream exploded");
    });

    // Promise.any rejects with an AggregateError whose message is useless;
    // the underlying cause has to survive.
    await expect(esriQuery({ ...BASE, timeoutMs: 5000, hedgeAfterMs: 20 })).rejects.toThrow(
      /upstream exploded/
    );
  });

  it("treats an HTML error page as a failure rather than empty results", async () => {
    stubFetch(async () => new Response("<html>Request-URI Too Long</html>", { status: 200 }));

    // Returning [] here would look like "no comps nearby" instead of a broken
    // query — the exact failure that made the ZIP-average fallback look normal.
    await expect(esriQuery({ ...BASE, timeoutMs: 5000 })).rejects.toThrow(/non-JSON/);
  });

  it("labels timeouts with the service name", async () => {
    stubFetch(async (_call, signal) => {
      await delayUnlessAborted(2_000, signal);
      return ok([]);
    });

    await expect(esriQuery({ ...BASE, timeoutMs: 50 })).rejects.toThrow(/Test GIS request timed out/);
  });

  it("runs unhedged when no hedge delay is configured", async () => {
    const spy = stubFetch(async () => ok([feature("a")]));
    await esriQuery({ ...BASE, timeoutMs: 5000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("isPermanent", () => {
  it("recognises a permanent error and nothing else", () => {
    expect(isPermanent(new EsriPermanentError("bad field"))).toBe(true);
    expect(isPermanent(new Error("socket hang up"))).toBe(false);
    expect(isPermanent(null)).toBe(false);
    expect(isPermanent(undefined)).toBe(false);
  });
});
