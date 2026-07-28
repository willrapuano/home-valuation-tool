import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANARY_LOCATION,
  FairfaxCountyProvider,
  FairfaxSchemaError,
  checkFairfaxHealth,
} from "./fairfax";

/**
 * These cover the failure modes that are currently INDISTINGUISHABLE from each
 * other and from success: every one of them ends in a degraded valuation and
 * an HTTP 200. The point of the detection layer is to tell them apart.
 */

const RING = [[[-77.16, 38.94], [-77.159, 38.94], [-77.159, 38.941], [-77.16, 38.941], [-77.16, 38.94]]];
const DAY = 86_400_000;

/** A sale N days old with a given sale-to-assessment ratio. */
function saleRow(pin: string, daysAgo: number, assessed = 1_000_000, ratio = 1.1, luc = "011") {
  return {
    sale: {
      attributes: {
        PIN: pin,
        PRICE: Math.round(assessed * ratio),
        SALEDT: Date.now() - daysAgo * DAY,
        SALEVAL_DESC: "Valid and verified sale",
        NOPAR: 1,
      },
      geometry: { rings: RING },
    },
    assessed: { attributes: { PIN: pin, LUC: luc, APRTOT: assessed, TAXYR: 2026 } },
  };
}

/** Stub fetch: first call is the sales layer, the rest are assessed chunks. */
function stub(sales: unknown[], assessed: unknown[], subject?: unknown) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const payload =
      call++ === 0 ? { features: sales } : { features: call === 2 ? assessed : (subject ?? assessed) };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("schema assertion", () => {
  it("throws a typed error when the sales layer drops a field we depend on", async () => {
    // Simulates PRICE being renamed. Previously these rows were silently
    // dropped by mapRecord and the result was indistinguishable from
    // "no sales nearby".
    stub([{ attributes: { PIN: "A", SALEDT: Date.now(), SALEVAL_DESC: "Valid" }, geometry: { rings: RING } }], []);

    await expect(
      new FairfaxCountyProvider().fetchCandidates(
        { location: CANARY_LOCATION, propertyType: "single_family" },
        { radiusMiles: 1, lookbackMonths: 12 }
      )
    ).rejects.toBeInstanceOf(FairfaxSchemaError);
  });

  it("names the missing and the present fields, so the fix is obvious", async () => {
    stub([{ attributes: { PIN: "A", SALEDT: 1, SALE_PRICE: 900_000, SALEVAL_DESC: "Valid" }, geometry: { rings: RING } }], []);
    try {
      await new FairfaxCountyProvider().fetchCandidates(
        { location: CANARY_LOCATION, propertyType: "single_family" },
        { radiusMiles: 1, lookbackMonths: 12 }
      );
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as FairfaxSchemaError;
      expect(e.missing).toEqual(["PRICE"]);
      expect(e.present).toContain("SALE_PRICE");
    }
  });

  it("treats an empty response as no data, not a schema break", async () => {
    stub([], []);
    const comps = await new FairfaxCountyProvider().fetchCandidates(
      { location: CANARY_LOCATION, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );
    expect(comps).toEqual([]);
  });
});

describe("health canary", () => {
  it("reports healthy on a normal response", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => saleRow(`P${i}`, 10 + i, 1_000_000 + i * 10_000));
    stub(rows.map(r => r.sale), rows.map(r => r.assessed), [rows[0].assessed]);

    const h = await checkFairfaxHealth();
    expect(h.ok).toBe(true);
    expect(h.failures).toEqual([]);
    expect(h.compCount).toBe(12);
    expect(h.landUseCoverage).toBe(1);
    expect(h.medianSaleToAssessedRatio).toBeCloseTo(1.1, 2);
  });

  it("fails when the source returns nothing at the canary location", async () => {
    stub([], []);
    const h = await checkFairfaxHealth();
    expect(h.ok).toBe(false);
    expect(h.failures.join(" ")).toMatch(/should always have some/);
  });

  it("distinguishes a schema break from an outage", async () => {
    stub([{ attributes: { PIN: "A", SALEDT: 1 }, geometry: { rings: RING } }], []);
    const h = await checkFairfaxHealth();
    expect(h.ok).toBe(false);
    expect(h.failures.join(" ")).toMatch(/Schema changed/);
  });

  it("catches a stalled feed, which otherwise looks like a working tool", async () => {
    // Sales still return, they're just all old — no error anywhere.
    const rows = Array.from({ length: 12 }, (_, i) => saleRow(`P${i}`, 200 + i));
    stub(rows.map(r => r.sale), rows.map(r => r.assessed), [rows[0].assessed]);

    const h = await checkFairfaxHealth();
    expect(h.ok).toBe(false);
    expect(h.failures.join(" ")).toMatch(/stopped updating/);
    expect(h.daysSinceNewestSale).toBeGreaterThan(60);
  });

  it("catches a land-use code change, which empties the comp pool silently", async () => {
    // Codes the map doesn't know become "other", the engine rejects them as
    // incomparable, and the user just sees "no comps nearby".
    const rows = Array.from({ length: 12 }, (_, i) => saleRow(`P${i}`, 10 + i, 1_000_000, 1.1, "999"));
    stub(rows.map(r => r.sale), rows.map(r => r.assessed), [rows[0].assessed]);

    const h = await checkFairfaxHealth();
    expect(h.ok).toBe(false);
    expect(h.failures.join(" ")).toMatch(/land use code/);
    expect(h.landUseCoverage).toBe(0);
  });

  it("warns on a ratio shift, which changes every estimate without erroring", async () => {
    // What a reassessment looks like: everything still works, the numbers
    // just move. This must not read as healthy-and-unchanged.
    const rows = Array.from({ length: 12 }, (_, i) => saleRow(`P${i}`, 10 + i, 1_000_000, 1.9));
    stub(rows.map(r => r.sale), rows.map(r => r.assessed), [rows[0].assessed]);

    const h = await checkFairfaxHealth();
    expect(h.warnings.join(" ")).toMatch(/sale-to-assessment ratio/);
    // Still usable — a shift is not an outage.
    expect(h.ok).toBe(true);
  });

  it("surfaces the assessment year so a reassessment is visible as a step", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => saleRow(`P${i}`, 10 + i));
    stub(rows.map(r => r.sale), rows.map(r => r.assessed), [rows[0].assessed]);
    const h = await checkFairfaxHealth();
    expect(h.taxYear).toBe(2026);
  });
});
