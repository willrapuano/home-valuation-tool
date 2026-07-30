import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The subject must be the house the homeowner typed in — not a neighbour.
 *
 * THE BUG THIS GUARDS, because it was invisible from every angle we had.
 *
 * DC and Maryland both looked the subject up with a single radius query at 0.1
 * miles, `resultRecordCount: 40`, no ordering, then picked the nearest of
 * whatever came back. DC packs 159–340 parcels into that radius, so ArcGIS
 * returned an arbitrary page of 40 and the parcel the point actually sits in
 * was usually not in it. Measured on Capitol Hill: 9 of 10 properties resolved
 * to a DIFFERENT house.
 *
 * Nothing errored. Every lookup returned a complete, plausible subject — with
 * a neighbour's living area, bedrooms, year built and assessment. Against real
 * sale prices this cost DC 12.9 points of accuracy, 23.0% median error against
 * 10.1% with the correct subject, while the confidence LABEL barely moved. So
 * homeowners were shown confident estimates for someone else's house.
 *
 * No backtest could catch it: they all build the subject from the sales record
 * and never call lookupSubject. Only a live comparison of the two does.
 *
 * The fix is to make containment the query rather than a radius sweep —
 * omitting `distance` asks ArcGIS for the polygon containing the point. These
 * tests assert the FIRST query does that, which is the property that matters;
 * a widened rung afterwards is a legitimate fallback for a geocode that lands
 * on the street centreline.
 */

const calls: { url: string; params: Record<string, string> }[] = [];

vi.mock("./esri", () => ({
  esriQuery: async (opts: { url: string; params: Record<string, string> }) => {
    calls.push({ url: opts.url, params: opts.params });
    // Empty results push the provider onto the next rung of the ladder, which
    // is what lets these tests observe the whole sequence in one call.
    return [];
  },
}));

const { DcProvider } = await import("./dc");
const { MarylandProvider } = await import("./maryland");

afterEach(() => {
  calls.length = 0;
});

const AT = { lat: 38.887, lng: -76.993 };

describe.each([
  ["DC", () => new DcProvider()],
  ["Maryland", () => new MarylandProvider()],
])("%s subject lookup", (_name, make) => {
  it("asks for the containing parcel before widening", async () => {
    await make().lookupSubject(AT);

    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0].params;
    // No `distance` makes this a point-in-polygon test rather than a radius
    // sweep — the whole point of the fix.
    expect(first.distance).toBeUndefined();
    expect(first.spatialRel).toBe("esriSpatialRelIntersects");
    expect(first.geometryType).toBe("esriGeometryPoint");
  });

  it("widens only after containment finds nothing, and never starts wide", async () => {
    await make().lookupSubject(AT);

    const radii = calls
      .map(c => (c.params.distance === undefined ? 0 : Number(c.params.distance)))
      // Later queries join CAMA/characteristics by key rather than geometry.
      .filter((_, i) => calls[i].params.geometryType === "esriGeometryPoint");

    expect(radii[0]).toBe(0);
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
  });

  it("requests enough records on a WIDENED rung that 'nearest' is genuinely the nearest", async () => {
    // The old value was 40, against 159-340 parcels within 0.1 miles in DC. A
    // widened rung that pages arbitrarily reintroduces exactly the bug the
    // containment step was added to fix.
    //
    // Containment is exempt and deliberately small: it returns only the one or
    // two parcels under the point, and asking a slow service for a large page
    // costs time for nothing.
    await make().lookupSubject(AT);

    const widened = calls.filter(
      c => c.params.geometryType === "esriGeometryPoint" && Number(c.params.distance ?? 0) > 0
    );
    expect(widened.length).toBeGreaterThan(0);
    for (const c of widened) {
      expect(Number(c.params.resultRecordCount)).toBeGreaterThanOrEqual(500);
    }
  });

  it("bounds the ladder at two round trips", async () => {
    // Each rung is sequential against a service that is occasionally slow, and
    // the route's entire budget is 20s. A four-rung ladder measured 12.1s in
    // Frederick and timed out outright in Silver Spring — which trades a wrong
    // answer for no answer, a worse deal than the bug it was fixing.
    await make().lookupSubject(AT);

    const spatial = calls.filter(c => c.params.geometryType === "esriGeometryPoint");
    expect(spatial.length).toBeLessThanOrEqual(2);
  });

  it("gives up rather than widening without limit", async () => {
    // An unbounded search would eventually find *a* house and describe the
    // subject with it. Returning null lets the route fall through to another
    // source, or tell the homeowner honestly that it has nothing.
    const out = await make().lookupSubject(AT);
    expect(out).toBeNull();

    const spatial = calls.filter(c => c.params.geometryType === "esriGeometryPoint");
    const widest = Math.max(...spatial.map(c => Number(c.params.distance ?? 0)));
    expect(widest).toBeLessThanOrEqual(0.1);
  });
});

describe("exactParcel — the flag that decides what may be SHOWN", () => {
  /**
   * Resolving a neighbour is acceptable for CHOOSING comparable sales; it is
   * not acceptable for printing "your home has 4 bedrooms". Those two uses were
   * indistinguishable to the caller, which is how DC spent weeks describing the
   * house next door. `exactParcel` is what separates them, so it must be false
   * on every path that did not find the containing parcel.
   */
  it("is false on the Postgres provider, which can only ever find a neighbour", async () => {
    // That table holds properties that have SOLD. A home that has not changed
    // hands is simply not in it, so this is never the subject itself.
    vi.resetModules();
    vi.doMock("../../db", () => ({
      query: async () => [
        {
          parcel_id: "X", address: "1 Test St", lat: 38.9, lng: -77.1,
          sold_price: "850000", sold_date: "2026-03-15", property_type: "single_family",
          assessed_value: "820000", sqft: 2100, lot_sqft: 8000, year_built: 1985,
          beds: 4, baths: 2.5, condition: 3, subdivision: null, zip_code: "20003",
          arms_length: true,
        },
      ],
      hasDatabase: () => true,
    }));
    const { PostgresProvider } = await import("./postgres");

    const got = await new PostgresProvider().lookupSubject({ lat: 38.9, lng: -77.1 });
    expect(got).not.toBeNull();
    // It still describes something — that is useful for comp selection.
    expect(got!.sqft).toBe(2100);
    // But it must never claim to be the home the visitor asked about.
    expect(got!.exactParcel).toBe(false);
  });
});
