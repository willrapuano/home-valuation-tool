import { describe, expect, it } from "vitest";
import { conditionFromCndtn, parseDcDate, propertyTypeFromProptype } from "./dc";

/**
 * DC field parsing. Each of these is a mapping that fails silently rather than
 * loudly if it is wrong — a misparsed date becomes a 1970 sale the recency
 * filter quietly discards, and a mistyped rowhouse gets compared against
 * detached homes without complaint.
 */

describe("parseDcDate", () => {
  it("reads epoch milliseconds", () => {
    // 3524 10TH ST NW, sold 2016-09-23 per the live extract.
    expect(parseDcDate(1474603200000)).toBe("2016-09-23");
  });

  it("does not mistake Maryland's YYYYMMDD format for a date", () => {
    // 20250714 as epoch ms is 1970; it must be rejected, not silently wrong.
    expect(parseDcDate(20250714)).toBeUndefined();
  });

  it("rejects missing and nonsense values", () => {
    expect(parseDcDate(null)).toBeUndefined();
    expect(parseDcDate(0)).toBeUndefined();
    expect(parseDcDate(-1)).toBeUndefined();
    expect(parseDcDate("not a date")).toBeUndefined();
  });
});

describe("conditionFromCndtn", () => {
  it("puts DC's Average on our average", () => {
    // CNDTN 3 = "Average", the modal value across 107,471 residential records.
    expect(conditionFromCndtn(3)).toBe(3);
  });

  it("maps the published scale monotonically", () => {
    const mapped = [1, 2, 3, 4, 5, 6].map(n => conditionFromCndtn(n)!);
    for (let i = 1; i < mapped.length; i++) {
      expect(mapped[i]).toBeGreaterThanOrEqual(mapped[i - 1]);
    }
    expect(conditionFromCndtn(1)).toBe(1); // Poor
    expect(conditionFromCndtn(6)).toBe(5); // Excellent, clamped to our top
  });

  it("rejects the out-of-range codes the source carries", () => {
    expect(conditionFromCndtn(0)).toBeUndefined();
    expect(conditionFromCndtn(7)).toBeUndefined();
    expect(conditionFromCndtn(null)).toBeUndefined();
  });
});

describe("propertyTypeFromProptype", () => {
  it("treats a DC rowhouse as a townhouse, not a detached home", () => {
    // Rowhouses are the dominant form in DC; comparing one to a detached house
    // without the distinction would be badly wrong.
    expect(propertyTypeFromProptype("Residential-Single Family (Row Inside)")).toBe("townhouse");
    expect(propertyTypeFromProptype("Residential-Single Family (Semi-Detached)")).toBe("townhouse");
  });

  it("recognises detached homes", () => {
    expect(propertyTypeFromProptype("Residential-Single Family (Detached)")).toBe("single_family");
  });

  it("recognises multi-family forms", () => {
    expect(propertyTypeFromProptype("Residential-Conversion (2 Units)")).toBe("multi_family");
    expect(propertyTypeFromProptype("Residential-Flats (2 Units)")).toBe("multi_family");
    expect(propertyTypeFromProptype("Residential-Multi-Family (3 to 4 Units)")).toBe("multi_family");
    expect(propertyTypeFromProptype("Residential-Apartment (Walkup)")).toBe("multi_family");
  });

  it("recognises condos and vacant land", () => {
    expect(propertyTypeFromProptype("Residential-Condominium")).toBe("condo");
    expect(propertyTypeFromProptype("Vacant-True")).toBe("land");
    expect(propertyTypeFromProptype("Vacant-Permit")).toBe("land");
  });

  it("falls back to 'other' rather than guessing", () => {
    // "other" is comparable only to itself, so an unrecognised code is
    // excluded rather than silently valued as a house.
    expect(propertyTypeFromProptype("Store-Miscellaneous")).toBe("other");
    expect(propertyTypeFromProptype("")).toBe("other");
    expect(propertyTypeFromProptype(null)).toBe("other");
  });
});
