import { describe, expect, it } from "vitest";
import {
  geocodeKeyFor,
  parseLotSqft,
  parseSaleDate,
  toComparableSales,
  toPropertyType,
  TP247Property,
} from "./titlepro247";
import { LatLng } from "../types";

/**
 * A TitlePro247 farm list is a list of CURRENT OWNERS in a radius, each
 * carrying whatever their last transaction was — most of them decades old, many
 * of them not sales at all. Turning that into comps is almost entirely
 * knockouts, and every one of them is load-bearing: a $10 family transfer or a
 * 1994 sale that survives into the comp set moves a homeowner's number.
 */

const HERE: LatLng = { lat: 38.88, lng: -77.1 };

const prop = (over: Partial<TP247Property> = {}): TP247Property => ({
  siteAddressLine1: "2100 N Quincy St",
  siteCity: "Arlington",
  siteState: "VA",
  siteZip: "22207",
  lastSaleAmount: 1_150_000,
  lastSaleDate: "05/14/2026",
  assessedValue: 1_090_000,
  propertyType: "Single Family Residential",
  sqft: 2400,
  beds: 4,
  baths: 3,
  yearBuilt: 1962,
  lotSize: "0.25 Acres",
  ...over,
});

const coordsFor = (...ps: TP247Property[]) =>
  new Map(ps.map(p => [geocodeKeyFor(p), HERE] as [string, LatLng]));

const SINCE = "2025-01-01";

describe("toComparableSales", () => {
  it("maps a clean row", () => {
    const p = prop();
    const { sales } = toComparableSales([p], coordsFor(p), SINCE);

    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      address: "2100 N Quincy St",
      soldPrice: 1_150_000,
      soldDate: "2026-05-14",
      propertyType: "single_family",
      assessedValue: 1_090_000,
      sqft: 2400,
      zipCode: "22207",
    });
  });

  it("uses the SITE address, never the owner's mailing address", () => {
    // The export carries both. Publishing the mailing address would name a
    // different building entirely — often another state, for absentee owners —
    // and is the same class of bug as Fairfax's parcel IDs.
    const p = { ...prop(), mailingAddressLine1: "PO Box 4001", mailingCity: "Naples" } as TP247Property;
    const { sales } = toComparableSales([p], coordsFor(p), SINCE);
    expect(sales[0].address).toBe("2100 N Quincy St");
  });

  it("drops sales older than the window", () => {
    // The single most important filter: most rows in a farm list are old.
    const p = prop({ lastSaleDate: "06/02/1994" });
    const { sales, skipped } = toComparableSales([p], coordsFor(p), SINCE);
    expect(sales).toHaveLength(0);
    expect(skipped.sale_too_old).toBe(1);
  });

  it("drops nominal transfers", () => {
    // Quitclaims, deeds into trust, $1 conveyances. Real date, real address,
    // nothing else screens them out, and one drags an estimate down hard.
    for (const amount of [0, 1, 10, 14_999]) {
      const p = prop({ lastSaleAmount: amount });
      const { sales, skipped } = toComparableSales([p], coordsFor(p), SINCE);
      expect(sales, `$${amount} should not be a comp`).toHaveLength(0);
      expect(skipped.nominal_or_no_price).toBe(1);
    }
  });

  it("keeps a genuinely cheap but real sale", () => {
    const p = prop({ lastSaleAmount: 185_000 });
    expect(toComparableSales([p], coordsFor(p), SINCE).sales).toHaveLength(1);
  });

  it("drops rows it could not geocode", () => {
    // No coordinates means no distance, and distance is most of the score.
    const p = prop();
    const { sales, skipped } = toComparableSales([p], new Map(), SINCE);
    expect(sales).toHaveLength(0);
    expect(skipped.not_geocoded).toBe(1);
  });

  it("prefers the assessment over the vendor's own market value", () => {
    // marketValue is TitlePro247's AVM. Feeding another model's output in as
    // ground truth would make our estimate partly a copy of theirs.
    const p = prop({ assessedValue: 1_090_000, marketValue: 1_400_000 });
    expect(toComparableSales([p], coordsFor(p), SINCE).sales[0].assessedValue).toBe(1_090_000);
  });

  it("reports unrecognised property types instead of guessing", () => {
    // A type this mapper does not know must be dropped AND named, because the
    // alternative is discarding a whole county's sales silently — TitlePro247's
    // type strings vary by the county data source behind them.
    const odd = prop({ propertyType: "Grain Silo", detailedPropertyType: "" });
    const { sales, skipped, unmappedTypes } = toComparableSales([odd], coordsFor(odd), SINCE);

    expect(sales).toHaveLength(0);
    expect(skipped.unmapped_property_type).toBe(1);
    expect(unmappedTypes).toEqual({ "Grain Silo": 1 });
  });

  it("counts each unrecognised type so the biggest gap is obvious", () => {
    const rows = [
      prop({ propertyType: "Grain Silo" }),
      prop({ propertyType: "Grain Silo", siteAddressLine1: "3 Other St" }),
      prop({ propertyType: "Lighthouse", siteAddressLine1: "5 Third St" }),
    ];
    const { unmappedTypes } = toComparableSales(rows, coordsFor(...rows), SINCE);
    expect(unmappedTypes).toEqual({ "Grain Silo": 2, Lighthouse: 1 });
  });

  it("falls back to the detailed type when the coarse one is blank", () => {
    const p = prop({ propertyType: "", detailedPropertyType: "Townhouse (Interior)" });
    expect(toComparableSales([p], coordsFor(p), SINCE).sales[0].propertyType).toBe("townhouse");
  });

  it("keys rows so re-ingesting the same export does not duplicate", () => {
    const p = prop();
    const a = toComparableSales([p], coordsFor(p), SINCE).sales[0];
    const b = toComparableSales([p], coordsFor(p), SINCE).sales[0];
    expect(a.id).toBe(b.id);
    // Same property, two different sale dates, must be two distinct rows.
    const later = prop({ lastSaleDate: "01/09/2026" });
    expect(toComparableSales([later], coordsFor(later), SINCE).sales[0].id).not.toBe(a.id);
  });

  it("does not invent values from blanks", () => {
    const p = prop({ sqft: 0, beds: 0, baths: 0, yearBuilt: 0, assessedValue: 0, lotSize: "" });
    const [s] = toComparableSales([p], coordsFor(p), SINCE).sales;
    expect(s.sqft).toBeUndefined();
    expect(s.beds).toBeUndefined();
    expect(s.yearBuilt).toBeUndefined();
    expect(s.assessedValue).toBeUndefined();
    expect(s.lotSqft).toBeUndefined();
  });
});

describe("toPropertyType", () => {
  it("recognises the common forms", () => {
    expect(toPropertyType("Single Family Residential")).toBe("single_family");
    expect(toPropertyType("SFR")).toBe("single_family");
    expect(toPropertyType("Townhouse")).toBe("townhouse");
    expect(toPropertyType("Condominium")).toBe("condo");
    expect(toPropertyType("Duplex")).toBe("multi_family");
    expect(toPropertyType("Vacant Land")).toBe("land");
  });

  it("prefers the more specific claim when a string says both", () => {
    expect(toPropertyType("Single Family Condominium")).toBe("condo");
  });

  it("returns other rather than assuming a house", () => {
    // Defaulting to single_family would score a warehouse against houses.
    expect(toPropertyType("Grain Silo")).toBe("other");
    expect(toPropertyType("")).toBe("other");
    expect(toPropertyType(undefined)).toBe("other");
  });
});

describe("parseLotSqft", () => {
  it("handles the formats exports actually use", () => {
    expect(parseLotSqft("10,890")).toBe(10_890);
    expect(parseLotSqft("10890 SF")).toBe(10_890);
    expect(parseLotSqft("0.25 Acres")).toBe(10_890);
    expect(parseLotSqft("0.25 AC")).toBe(10_890);
  });

  it("reads a bare small number as acres", () => {
    // Acreage is written as a decimal; a 0.25 sqft lot does not exist.
    expect(parseLotSqft("0.25")).toBe(10_890);
    expect(parseLotSqft("8500")).toBe(8500);
  });

  it("returns undefined for junk", () => {
    expect(parseLotSqft("")).toBeUndefined();
    expect(parseLotSqft("N/A")).toBeUndefined();
    expect(parseLotSqft(undefined)).toBeUndefined();
  });
});

describe("parseSaleDate", () => {
  it("reads US and ISO forms", () => {
    expect(parseSaleDate("05/14/2026")).toBe("2026-05-14");
    expect(parseSaleDate("5/4/2026")).toBe("2026-05-04");
    expect(parseSaleDate("2026-05-14")).toBe("2026-05-14");
    expect(parseSaleDate("2026-05-14T00:00:00Z")).toBe("2026-05-14");
  });

  it("reads month-day order, not day-month", () => {
    // 05/14 is unambiguous, but 03/04 is not — US exports mean 4 March.
    expect(parseSaleDate("03/04/2026")).toBe("2026-03-04");
  });

  it("returns undefined rather than a wrong date", () => {
    expect(parseSaleDate("")).toBeUndefined();
    expect(parseSaleDate("not a date")).toBeUndefined();
    expect(parseSaleDate(undefined)).toBeUndefined();
  });
});
