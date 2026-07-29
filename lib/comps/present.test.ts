import { describe, expect, it } from "vitest";
import { titleCase, toPublicComps } from "./present";
import { ScoredComp } from "./types";

/**
 * What a homeowner reads. Wrong here is worse than wrong internally: these
 * are the sales they will check against ones they recognise, and a comp that
 * looks sloppy or nonsensical discredits the estimate beside it.
 */

const scored = (over: Partial<ScoredComp> = {}): ScoredComp => ({
  comp: {
    id: "0402@2026-03-15",
    address: "8805 WANDERING TRAIL DR",
    location: { lat: 38.9, lng: -77.1 },
    soldPrice: 850_000,
    soldDate: "2026-03-15",
    propertyType: "single_family",
    sqft: 2100,
    beds: 4,
    baths: 2.5,
    yearBuilt: 1985,
  },
  score: 0.9,
  dimensions: {},
  adjustedPrice: 872_500.4,
  adjustments: { time: 12_000, gla: 25_000, lot: 900 },
  grossAdjustmentRatio: 0.04,
  netAdjustmentRatio: 0.03,
  distanceMiles: 0.4321,
  ageMonths: 4,
  ...over,
});

describe("toPublicComps", () => {
  it("carries the facts a homeowner would check", () => {
    const [c] = toPublicComps([scored()]);
    expect(c.soldPrice).toBe(850_000);
    expect(c.soldDate).toBe("2026-03-15");
    expect(c.sqft).toBe(2100);
    expect(c.monthsAgo).toBe(4);
  });

  it("rounds distance to something readable", () => {
    // "0.4321 mi away" reads as false precision.
    expect(toPublicComps([scored()])[0].distanceMiles).toBe(0.43);
  });

  it("rounds money to whole dollars", () => {
    expect(toPublicComps([scored()])[0].adjustedPrice).toBe(872_500);
  });

  it("hides immaterial adjustments", () => {
    // A $900 lot adjustment invites scrutiny of a rounding error rather than
    // of the estimate.
    const labels = toPublicComps([scored()])[0].adjustments.map(a => a.label);
    expect(labels).not.toContain("Difference in lot size");
    expect(labels).toHaveLength(2);
  });

  it("orders adjustments by size, largest first", () => {
    const [c] = toPublicComps([scored()]);
    expect(c.adjustments[0].amount).toBe(25_000);
    expect(c.adjustments[1].amount).toBe(12_000);
  });

  it("translates internal keys into plain English", () => {
    const [c] = toPublicComps([scored()]);
    // "gla" means nothing to a homeowner.
    expect(c.adjustments.map(a => a.label)).toEqual([
      "Difference in living area",
      "Market movement since it sold",
    ]);
  });

  it("keeps negative adjustments negative", () => {
    // A superior comp is revised DOWN toward the subject; flipping the sign
    // would tell the homeowner the opposite of the truth.
    const [c] = toPublicComps([scored({ adjustments: { gla: -40_000 } })]);
    expect(c.adjustments[0].amount).toBe(-40_000);
  });

  it("produces an empty adjustment list when nothing material applied", () => {
    const [c] = toPublicComps([scored({ adjustments: { lot: 200 } })]);
    expect(c.adjustments).toEqual([]);
  });

  it("handles comps missing optional characteristics", () => {
    // Fairfax publishes no building characteristics at all.
    const bare = scored();
    const [c] = toPublicComps([
      { ...bare, comp: { ...bare.comp, sqft: undefined, beds: undefined, baths: undefined } },
    ]);
    expect(c.sqft).toBeUndefined();
    expect(c.address).toBeTruthy();
  });
});

describe("titleCase", () => {
  it("tames shouting county records", () => {
    expect(titleCase("8805 WANDERING TRAIL DR")).toBe("8805 Wandering Trail Dr");
  });

  it("keeps directionals and DC upper case, but title-cases street types", () => {
    // "Washington Dc" and "Se" read worse than the problem being fixed, while
    // "ST" for Street should soften to "St".
    expect(titleCase("1604 D ST SE WASHINGTON DC 20003")).toBe("1604 D St SE Washington DC 20003");
  });

  it("leaves words containing digits untouched", () => {
    // "3RD" must not become "3rd"; the rest of the line still normalises.
    expect(titleCase("123 3RD ST NW")).toBe("123 3RD St NW");
  });

  it("survives an address that is really a parcel id", () => {
    // Fairfax returns "0402 03  0006" when it has no street address.
    expect(titleCase("0402 03  0006")).toBe("0402 03 0006");
  });
});

describe("comps with no published address", () => {
  const noAddress = (over: Partial<ScoredComp["comp"]> = {}) =>
    scored({ comp: { ...scored().comp, address: "", ...over } });

  it("never shows a parcel identifier as an address", () => {
    // Fairfax's sales layer carries only a PIN. It was being stored in
    // `address` and rendered verbatim, so Fairfax homeowners — the largest
    // group of them — saw six rows reading "0311 17 0027".
    const [c] = toPublicComps([noAddress()]);
    expect(c.address).toBe("Nearby home");
  });

  it("uses a resolved address when the provider supplies one", () => {
    const [c] = toPublicComps(
      [noAddress()],
      new Map([["0402@2026-03-15", "1205 SUFFIELD DR"]])
    );
    expect(c.address).toBe("1205 Suffield Dr");
  });

  it("falls back per comp, not for the whole set", () => {
    // The resolver verifies each match against the parcel identifier, so a
    // partial result is the normal case rather than an error.
    const comps = toPublicComps(
      [noAddress({ id: "a" }), noAddress({ id: "b" })],
      new Map([["a", "1205 SUFFIELD DR"]])
    );
    expect(comps.map(c => c.address)).toEqual(["1205 Suffield Dr", "Nearby home"]);
  });

  it("prefers a resolved address over one already on the comp", () => {
    const [c] = toPublicComps(
      [scored()],
      new Map([["0402@2026-03-15", "1205 SUFFIELD DR"]])
    );
    expect(c.address).toBe("1205 Suffield Dr");
  });
});
