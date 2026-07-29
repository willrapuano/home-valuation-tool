import { afterEach, describe, expect, it, vi } from "vitest";
import { FairfaxCountyProvider } from "./fairfax";
import { ComparableSale } from "../types";

/**
 * Fairfax publishes no situs address with its sales, so comps are labelled by
 * reverse-geocoding the parcel centroid against the county's own locator.
 *
 * The behaviour that matters is the PIN check. Measured against live data, 4
 * of 18 lookups came back with an ADJACENT parcel's address — the locator
 * simply has no address point for some parcels and returns the nearest one it
 * does have. Publishing those would tell a homeowner that a specific
 * neighbour's house sold when it did not.
 */

const comp = (id: string): ComparableSale => ({
  id,
  address: "",
  location: { lat: 38.94, lng: -77.161 },
  soldPrice: 2_300_000,
  soldDate: "2026-06-22",
  propertyType: "single_family",
});

/** Minimal stand-in for the locator's reverseGeocode response. */
const locatorReturns = (address: Record<string, unknown> | null) =>
  vi.fn(async () => ({
    ok: true,
    json: async () => (address ? { address } : {}),
  })) as unknown as typeof fetch;

afterEach(() => vi.unstubAllGlobals());

describe("FairfaxCountyProvider.resolveAddresses", () => {
  it("labels a comp when the locator matches its own parcel", async () => {
    vi.stubGlobal("fetch", locatorReturns({ ShortLabel: "1205 SUFFIELD DR", PIN: "0311 17 0027" }));

    const got = await new FairfaxCountyProvider().resolveAddresses([comp("0311 17 0027@2026-06-22")]);
    expect(got.get("0311 17 0027@2026-06-22")).toBe("1205 SUFFIELD DR");
  });

  it("tolerates the two services spacing a PIN differently", async () => {
    vi.stubGlobal("fetch", locatorReturns({ ShortLabel: "1205 SUFFIELD DR", PIN: "0311170027" }));

    const got = await new FairfaxCountyProvider().resolveAddresses([comp("0311 17 0027@2026-06-22")]);
    expect(got.size).toBe(1);
  });

  it("REJECTS an address belonging to the adjacent parcel", async () => {
    // Real case: PIN 0804 02030013 resolved to 0804 02030012, next door.
    vi.stubGlobal("fetch", locatorReturns({ ShortLabel: "5922 CAMBERLY AVE", PIN: "0804 02030012" }));

    const got = await new FairfaxCountyProvider().resolveAddresses([comp("0804 02030013@2026-06-02")]);
    expect(got.size).toBe(0);
  });

  it("omits a comp the locator knows nothing about", async () => {
    vi.stubGlobal("fetch", locatorReturns(null));

    const got = await new FairfaxCountyProvider().resolveAddresses([comp("0311 17 0027@2026-06-22")]);
    expect(got.size).toBe(0);
  });

  it("resolves what it can when one lookup fails", async () => {
    // This runs after the valuation is computed, so a partial or failed
    // result must cost labels and nothing else.
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (call++ === 0) throw new Error("locator unreachable");
      return { ok: true, json: async () => ({ address: { ShortLabel: "7207 ESSEX AVE", PIN: "B" } }) };
    }) as unknown as typeof fetch);

    const got = await new FairfaxCountyProvider().resolveAddresses([comp("A@2026-01-01"), comp("B@2026-01-01")]);
    expect(got.get("B@2026-01-01")).toBe("7207 ESSEX AVE");
    expect(got.has("A@2026-01-01")).toBe(false);
  });

  it("does not reject the whole batch when the service errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch);

    await expect(
      new FairfaxCountyProvider().resolveAddresses([comp("0311 17 0027@2026-06-22")])
    ).resolves.toEqual(new Map());
  });

  it("issues the lookups concurrently, one per comp", async () => {
    // Six sequential lookups against a cold locator measured ~1s each. Run in
    // parallel they cost one round trip; run in series they would exceed the
    // API route's whole budget, on the request path of every Fairfax
    // valuation. So concurrency is a requirement, not an implementation
    // detail — asserted by holding every call open until all have started.
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>(resolve => { release = resolve; });

    const fetchMock = vi.fn(async () => {
      if (++started === 3) release();
      await allStarted;
      return { ok: true, json: async () => ({ address: { ShortLabel: "X ST", PIN: "nope" } }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const comps = ["a", "b", "c"].map(id => comp(`${id}@2026-01-01`));
    // Sequential lookups would deadlock here: call 1 would await a promise
    // only call 3 can release, and call 3 would never be made.
    await new FairfaxCountyProvider().resolveAddresses(comps);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
