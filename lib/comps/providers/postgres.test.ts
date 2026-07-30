import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The SQL cannot be executed here — there is no database in CI — so these pin
 * the two things that are wrong-able without one: the shape the rows are
 * mapped into, and the query semantics that decide which sales are eligible.
 *
 * The real validation is the backtest against ingested data, which must match
 * the live-source numbers (DC 4.5%, Fairfax 5.3%, Maryland 8.7%) before this
 * provider serves anyone.
 */

const captured: { sql: string; params: unknown[] }[] = [];
let nextRows: Record<string, unknown>[] | null = [];

vi.mock("../../db", () => ({
  query: async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return nextRows;
  },
  hasDatabase: () => true,
}));

const { PostgresProvider } = await import("./postgres");

const row = (over: Record<string, unknown> = {}) => ({
  parcel_id: "0402 03  0006",
  address: "1 Test St",
  lat: 38.9,
  lng: -77.1,
  // pg returns BIGINT as a string; mapping must survive that.
  sold_price: "850000",
  sold_date: new Date("2026-03-15T00:00:00Z"),
  property_type: "single_family",
  assessed_value: "820000",
  sqft: 2100,
  lot_sqft: 8000,
  year_built: 1985,
  beds: 4,
  baths: 2.5,
  condition: 3,
  subdivision: "TESTVILLE",
  zip_code: "22101",
  arms_length: true,
  ...over,
});

afterEach(() => {
  captured.length = 0;
  nextRows = [];
});

describe("PostgresProvider.fetchCandidates", () => {
  it("maps a row into a ComparableSale, coping with bigints as strings", async () => {
    nextRows = [row()];
    const [c] = await new PostgresProvider().fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1.5, lookbackMonths: 12 }
    );

    expect(c.soldPrice).toBe(850_000);
    expect(c.assessedValue).toBe(820_000);
    expect(c.soldDate).toBe("2026-03-15");
    // Parcel id keeps its internal padding so it joins back to the source.
    expect(c.id).toBe("0402 03  0006@2026-03-15");
    expect(c.location).toEqual({ lat: 38.9, lng: -77.1 });
    expect(c.beds).toBe(4);
    expect(c.baths).toBe(2.5);
  });

  it("converts the radius from miles to metres for geography", async () => {
    await new PostgresProvider().fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1.5, lookbackMonths: 12 }
    );
    // geography(Point) takes metres; passing miles would search 1.5m.
    expect(captured[0].params[2]).toBeCloseTo(1.5 * 1609.344, 3);
  });

  it("passes longitude before latitude to ST_MakePoint", async () => {
    await new PostgresProvider().fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );
    // ST_MakePoint(x, y) is (lng, lat). Reversing it silently searches the
    // wrong hemisphere and returns nothing, which reads as "no comps".
    expect(captured[0].params[0]).toBe(-77.1);
    expect(captured[0].params[1]).toBe(38.9);
  });

  it("keeps sales whose arm's-length status is unstated", async () => {
    await new PostgresProvider({ qualifiedOnly: true }).fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );
    // IS NOT FALSE, not IS TRUE: only DC publishes the flag, so IS TRUE would
    // empty the pool everywhere else.
    expect(captured[0].sql).toContain("arms_length IS NOT FALSE");
    expect(captured[0].sql).not.toContain("arms_length IS TRUE");
  });

  it("can include non-arm's-length sales when asked", async () => {
    await new PostgresProvider({ qualifiedOnly: false }).fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );
    // The column is always selected; what must disappear is the filter.
    expect(captured[0].sql).not.toContain("arms_length IS NOT FALSE");
  });

  it("returns an empty array when no database is configured", async () => {
    nextRows = null;
    const out = await new PostgresProvider().fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );
    // No rows, no crash — the route then falls through to a live provider.
    expect(out).toEqual([]);
  });

  it("caps the limit at the service maximum", async () => {
    await new PostgresProvider().fetchCandidates(
      { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12, limit: 999_999 }
    );
    // By value, not by position: a new predicate shifts every index after it,
    // and this assertion has already been broken once that way.
    expect(captured[0].params).toContain(2000);
  });
});

describe("PostgresProvider.lookupSubject", () => {
  it("excludes commercial and vacant parcels", async () => {
    nextRows = [row()];
    await new PostgresProvider().lookupSubject({ lat: 38.9, lng: -77.1 });
    expect(captured[0].sql).toContain("property_type NOT IN ('other', 'land')");
  });

  it("returns null when nothing is nearby", async () => {
    nextRows = [];
    expect(await new PostgresProvider().lookupSubject({ lat: 38.9, lng: -77.1 })).toBeNull();
  });

  it("carries the assessment through, since it is worth 3.1pp", async () => {
    nextRows = [row()];
    const s = await new PostgresProvider().lookupSubject({ lat: 38.9, lng: -77.1 });
    expect(s?.assessedValue).toBe(820_000);
    expect(s?.lastSalePrice).toBe(850_000);
  });
});

describe("jurisdiction allow-list", () => {
  /**
   * `sales` is a shared bucket with more than one writer: `scripts/ingest.ts`
   * fills it from county public records, `scripts/ingest-titlepro.ts` from
   * TitlePro247 farm-list exports.
   *
   * The query originally had no jurisdiction predicate, so loading ANY new
   * source would publish it on the next request — no code change, no decision,
   * no way to stage an ingest and check it first. These tests exist so that
   * hole cannot silently reopen.
   */
  const subject = { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" as const };
  const opts = { radiusMiles: 1.5, lookbackMonths: 12 };

  it("restricts the comp search to the listed jurisdictions", async () => {
    await new PostgresProvider().fetchCandidates(subject, opts);

    const { sql, params } = captured[0];
    expect(sql).toContain("jurisdiction = ANY(");
    expect(params).toContainEqual(["dc", "fairfax", "maryland"]);
  });

  it("restricts the subject lookup too", async () => {
    // This path publishes as well: the subject's living area and assessment
    // are shown on the results screen.
    await new PostgresProvider().lookupSubject({ lat: 38.9, lng: -77.1 });

    const { sql, params } = captured[0];
    expect(sql).toContain("jurisdiction = ANY(");
    expect(params).toContainEqual(["dc", "fairfax", "maryland"]);
  });

  it("serves only what the list names", async () => {
    // The list is what publishes a source. A new ingest target, a scratch
    // load, or a partially validated county stays unserved until it is added
    // here deliberately.
    await new PostgresProvider().fetchCandidates(subject, opts);

    const allowed = captured[0].params.find(Array.isArray) as string[];
    // Commercially licensed sources stay unserved until the licence is read.
    for (const j of ["arlington", "loudoun", "alexandria", "titlepro247"]) {
      expect(allowed).not.toContain(j);
    }
  });

  it("publishes a source only when explicitly asked", async () => {
    // The deliberate act, once someone has established it is permitted.
    await new PostgresProvider({ jurisdictions: ["dc", "arlington"] }).fetchCandidates(subject, opts);
    expect(captured[0].params).toContainEqual(["dc", "arlington"]);
  });
});
