import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { valueFromComps } from "../index";
import {
  TitleFlexError,
  TitleFlexProvider,
  describeResponse,
  extractRecords,
  mapRecord,
  normalizeDate,
  normalizePropertyType,
  titleFlexConfigFromEnv,
} from "./titleflex";

/**
 * These tests pin the mapping BEHAVIOUR (aliases resolve, bad records are
 * dropped, dates and types normalise) rather than any specific vendor field
 * name. When the real API spec arrives, correcting FIELD_ALIASES should leave
 * every test here passing.
 */

const CONFIG = {
  baseUrl: "https://api.example.test",
  apiKey: "test-key",
  authHeader: "Authorization",
  authScheme: "Bearer",
  searchPath: "/property/sales/search",
  timeoutMs: 1000,
};

const SUBJECT = {
  location: { lat: 38.94, lng: -77.161 },
  propertyType: "single_family" as const,
  sqft: 3000,
  zipCode: "22101",
};

function mockFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("normalizeDate", () => {
  it("accepts ISO, US and timestamp formats", () => {
    expect(normalizeDate("2026-05-01")).toBe("2026-05-01");
    expect(normalizeDate("2026-05-01T00:00:00Z")).toBe("2026-05-01");
    expect(normalizeDate("5/1/2026")).toBe("2026-05-01");
    expect(normalizeDate("05/01/2026")).toBe("2026-05-01");
  });

  it("returns undefined for junk", () => {
    expect(normalizeDate("")).toBeUndefined();
    expect(normalizeDate("not a date")).toBeUndefined();
    expect(normalizeDate(null)).toBeUndefined();
  });
});

describe("normalizePropertyType", () => {
  it("maps common public-record use descriptions", () => {
    expect(normalizePropertyType("Single Family Residential")).toBe("single_family");
    expect(normalizePropertyType("SFR")).toBe("single_family");
    expect(normalizePropertyType("Condominium")).toBe("condo");
    expect(normalizePropertyType("Townhouse (Attached)")).toBe("townhouse");
    expect(normalizePropertyType("Duplex")).toBe("multi_family");
    expect(normalizePropertyType("Vacant Land")).toBe("land");
  });

  it("falls back to 'other' for unknown codes, which the engine excludes", () => {
    expect(normalizePropertyType("Use Code 8821")).toBe("other");
    expect(normalizePropertyType(undefined)).toBe("other");

    // "other" must not silently behave like a house.
    const mapped = mapRecord({
      saleAmount: 1_000_000, saleDate: "2026-05-01",
      latitude: 38.9401, longitude: -77.1611, propertyType: "Use Code 8821",
    })!;
    const r = valueFromComps(SUBJECT, [mapped], { minCompCount: 1, asOf: "2026-07-01" });
    expect(r.comps).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/not comparable/);
  });
});

describe("mapRecord", () => {
  const good = {
    propertyId: "P1",
    situsAddress: "1234 Ballantrae Ln",
    saleAmount: 1_250_000,
    saleDate: "2026-05-01",
    latitude: 38.9401,
    longitude: -77.1611,
    livingSquareFeet: 3100,
    lotSquareFeet: 12000,
    bedrooms: 4,
    bathrooms: 3,
    yearBuilt: 1995,
    propertyType: "Single Family Residential",
    subdivisionName: "Ballantrae",
    situsZip: "22101",
  };

  it("maps a well-formed record", () => {
    const c = mapRecord(good)!;
    expect(c).toMatchObject({
      id: "P1",
      address: "1234 Ballantrae Ln",
      soldPrice: 1_250_000,
      soldDate: "2026-05-01",
      propertyType: "single_family",
      sqft: 3100,
      subdivision: "Ballantrae",
    });
    expect(c.location).toEqual({ lat: 38.9401, lng: -77.1611 });
  });

  it("leaves condition undefined — public record has no interior condition", () => {
    expect(mapRecord(good)!.condition).toBeUndefined();
  });

  it("falls through alias lists when the primary name is absent", () => {
    const alt = {
      apn: "A9",
      propertyAddress: "9 Other St",
      lastSalePrice: "$980,000",
      recordingDate: "3/14/2026",
      lat: 38.94,
      lon: -77.16,
      buildingArea: "2,400",
    };
    const c = mapRecord(alt)!;
    expect(c.id).toBe("A9");
    expect(c.soldPrice).toBe(980_000);
    expect(c.soldDate).toBe("2026-03-14");
    expect(c.sqft).toBe(2400);
    expect(c.location.lng).toBe(-77.16);
  });

  it("drops records missing price, date or position", () => {
    expect(mapRecord({ ...good, saleAmount: undefined })).toBeNull();
    expect(mapRecord({ ...good, saleAmount: 0 })).toBeNull();
    expect(mapRecord({ ...good, saleDate: undefined })).toBeNull();
    expect(mapRecord({ ...good, latitude: undefined })).toBeNull();
  });

  it("synthesises an id when none is present", () => {
    const { propertyId, apn, ...rest } = good as Record<string, unknown>;
    void propertyId; void apn;
    expect(mapRecord(rest)!.id).toMatch(/^38\.94010,-77\.16110@2026-05-01$/);
  });
});

describe("extractRecords", () => {
  const rows = [{ a: 1 }];
  it("finds records in each common container shape", () => {
    expect(extractRecords(rows)).toEqual(rows);
    expect(extractRecords({ results: rows })).toEqual(rows);
    expect(extractRecords({ data: rows })).toEqual(rows);
    expect(extractRecords({ data: { results: rows } })).toEqual(rows);
    expect(extractRecords({ sales: rows })).toEqual(rows);
  });

  it("returns empty for unrecognised shapes rather than throwing", () => {
    expect(extractRecords(null)).toEqual([]);
    expect(extractRecords({ unexpected: { nested: rows } })).toEqual([]);
    expect(extractRecords("nope")).toEqual([]);
  });
});

describe("describeResponse", () => {
  it("reports resolved fields and leftover keys for reconciling the mapping", () => {
    const d = describeResponse({
      results: [{ saleAmount: 1, situsAddress: "x", someVendorField: "y" }],
    });
    expect(d.recordCount).toBe(1);
    expect(d.resolved.soldPrice).toBe("saleAmount");
    expect(d.resolved.address).toBe("situsAddress");
    expect(d.resolved.soldDate).toBeNull();
    expect(d.unmappedKeys).toContain("someVendorField");
  });
});

describe("TitleFlexProvider", () => {
  it("sends the configured auth header and scheme", async () => {
    const fetchMock = mockFetch({ results: [] });
    await new TitleFlexProvider(CONFIG).fetchCandidates(SUBJECT, {
      radiusMiles: 1, lookbackMonths: 12,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/property/sales/search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("supports a raw-key header with no scheme", async () => {
    const fetchMock = mockFetch({ results: [] });
    await new TitleFlexProvider({
      ...CONFIG, authHeader: "X-API-Key", authScheme: "",
    }).fetchCandidates(SUBJECT, { radiusMiles: 1, lookbackMonths: 12 });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("derives the lookback window from the requested months", async () => {
    const fetchMock = mockFetch({ results: [] });
    await new TitleFlexProvider(CONFIG).fetchCandidates(SUBJECT, {
      radiusMiles: 1.5, lookbackMonths: 6,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.radiusMiles).toBe(1.5);
    expect(body.latitude).toBe(38.94);
    expect(new Date(body.soldSince).getTime()).toBeLessThan(Date.now());
  });

  it("maps and filters a mixed response", async () => {
    mockFetch({
      results: [
        { propertyId: "ok", saleAmount: 1_100_000, saleDate: "2026-05-01",
          latitude: 38.9401, longitude: -77.1611, propertyType: "SFR" },
        { propertyId: "no-price", saleDate: "2026-05-01", latitude: 38.94, longitude: -77.16 },
      ],
    });

    const comps = await new TitleFlexProvider(CONFIG).fetchCandidates(SUBJECT, {
      radiusMiles: 1, lookbackMonths: 12,
    });
    expect(comps).toHaveLength(1);
    expect(comps[0].id).toBe("ok");
  });

  it("raises a typed error on a non-OK response without echoing the body", async () => {
    mockFetch({ error: "key test-key is invalid" }, { ok: false, status: 401 });
    const provider = new TitleFlexProvider(CONFIG);

    await expect(
      provider.fetchCandidates(SUBJECT, { radiusMiles: 1, lookbackMonths: 12 })
    ).rejects.toSatisfy((e: unknown) => {
      const err = e as TitleFlexError;
      return (
        err instanceof TitleFlexError &&
        err.status === 401 &&
        !err.message.includes("test-key")
      );
    });
  });

  it("raises a typed error on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    ));
    await expect(
      new TitleFlexProvider(CONFIG).fetchCandidates(SUBJECT, { radiusMiles: 1, lookbackMonths: 12 })
    ).rejects.toThrow(/timed out/);
  });
});

describe("titleFlexConfigFromEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when unconfigured, so callers can degrade", () => {
    vi.stubEnv("TITLEFLEX_API_KEY", "");
    vi.stubEnv("TITLEFLEX_API_URL", "");
    expect(titleFlexConfigFromEnv()).toBeNull();
    expect(TitleFlexProvider.fromEnv()).toBeNull();
  });

  it("requires both key and url", () => {
    vi.stubEnv("TITLEFLEX_API_KEY", "k");
    vi.stubEnv("TITLEFLEX_API_URL", "");
    expect(titleFlexConfigFromEnv()).toBeNull();
  });

  it("applies defaults and strips a trailing slash from the base url", () => {
    vi.stubEnv("TITLEFLEX_API_KEY", "k");
    vi.stubEnv("TITLEFLEX_API_URL", "https://api.example.test/");
    const c = titleFlexConfigFromEnv()!;
    expect(c.baseUrl).toBe("https://api.example.test");
    expect(c.authHeader).toBe("Authorization");
    expect(c.authScheme).toBe("Bearer");
  });

  it("allows an explicitly empty auth scheme", () => {
    vi.stubEnv("TITLEFLEX_API_KEY", "k");
    vi.stubEnv("TITLEFLEX_API_URL", "https://api.example.test");
    vi.stubEnv("TITLEFLEX_AUTH_SCHEME", "");
    expect(titleFlexConfigFromEnv()!.authScheme).toBe("");
  });
});

describe("end to end through the engine", () => {
  it("values a subject from a mapped TitleFlex response", async () => {
    mockFetch({
      results: Array.from({ length: 5 }, (_, i) => ({
        propertyId: `P${i}`,
        situsAddress: `${i} Ballantrae Ln`,
        saleAmount: 1_200_000 + i * 10_000,
        saleDate: "2026-05-15",
        latitude: 38.9401 + i * 0.0005,
        longitude: -77.1611,
        livingSquareFeet: 3000,
        propertyType: "Single Family Residential",
        subdivisionName: "Ballantrae",
      })),
    });

    const provider = new TitleFlexProvider(CONFIG);
    const candidates = await provider.fetchCandidates(SUBJECT, {
      radiusMiles: 1.5, lookbackMonths: 12,
    });
    const result = valueFromComps(SUBJECT, candidates, { asOf: "2026-07-01" });

    expect(result.estimate).toBeGreaterThan(1_000_000);
    expect(result.estimate).toBeLessThan(1_400_000);
    expect(result.confidence).not.toBe("none");
    expect(result.comps.length).toBeGreaterThanOrEqual(3);
  });
});
