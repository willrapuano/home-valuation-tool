import { describe, expect, it, vi } from "vitest";
import { adjustComp } from "./adjust";
import { DEFAULT_OPTIONS, DEFAULT_WEIGHTS, NOVA_MARKET } from "./config";
import { SUBJECT, comp } from "./fixtures";
import { assessmentRatioBand, valueFromComps } from "./index";
import { scoreDimensions, weightedScore } from "./score";
import { ComparableSale } from "./types";
import { ringCentroid } from "./providers/fairfax";

const AS_OF = "2026-07-01";

/** Subject described only by assessment — the shape Fairfax data produces. */
const ASSESSED_SUBJECT = {
  location: SUBJECT.location,
  propertyType: "single_family" as const,
  assessedValue: 2_300_000,
};

/** Comps at a consistent ~1.15 sale-to-assessment ratio. */
function assessedComp(id: string, assessed: number, ratio = 1.15, over: Partial<ComparableSale> = {}) {
  return comp({
    id,
    assessedValue: assessed,
    soldPrice: Math.round(assessed * ratio),
    soldDate: "2026-05-01",
    sqft: undefined,
    lotSqft: undefined,
    beds: undefined,
    baths: undefined,
    yearBuilt: undefined,
    condition: undefined,
    subdivision: undefined,
    schoolZone: undefined,
    ...over,
  });
}

const CONSISTENT = Array.from({ length: 10 }, (_, i) =>
  assessedComp(`C${i}`, 2_200_000 + i * 20_000)
);

describe("assessed value as a similarity dimension", () => {
  it("scores similarly-assessed comps higher", () => {
    const base = { distanceMiles: 0.2, ageMonths: 2 };
    const close = scoreDimensions({
      subject: ASSESSED_SUBJECT, comp: assessedComp("a", 2_300_000), ...base,
    });
    const far = scoreDimensions({
      subject: ASSESSED_SUBJECT, comp: assessedComp("b", 1_200_000), ...base,
    });
    expect(close.assessedValue).toBeGreaterThan(far.assessedValue!);
  });

  it("carries real weight in the blended score", () => {
    const withAssessed = weightedScore({ distance: 1, assessedValue: 0 }, DEFAULT_WEIGHTS);
    const withoutIt = weightedScore({ distance: 1 }, DEFAULT_WEIGHTS);
    expect(withAssessed.score).toBeLessThan(withoutIt.score);
  });
});

describe("assessed value as the adjustment basis", () => {
  it("replaces the physical grid rather than stacking on it", () => {
    // Both assessment AND physical attributes present: only the assessment
    // adjustment should apply, or the same size difference is counted twice.
    const c = comp({ id: "x", assessedValue: 2_000_000, sqft: 2000, beds: 3, baths: 2, yearBuilt: 1980 });
    const subject = { ...SUBJECT, assessedValue: 2_300_000 };
    const { adjustments } = adjustComp(subject, c, 0, NOVA_MARKET);

    expect(adjustments.assessed).toBeCloseTo(300_000, 5);
    expect(adjustments.gla).toBeUndefined();
    expect(adjustments.beds).toBeUndefined();
    expect(adjustments.age).toBeUndefined();
  });

  it("falls back to the physical grid when either side lacks an assessment", () => {
    const c = comp({ id: "y", sqft: 2500 });
    const { adjustments } = adjustComp(SUBJECT, c, 0, NOVA_MARKET);
    expect(adjustments.assessed).toBeUndefined();
    expect(adjustments.gla).toBeDefined();
  });

  it("still applies the time adjustment alongside the assessment", () => {
    const c = assessedComp("t", 2_000_000);
    const { adjustments } = adjustComp(ASSESSED_SUBJECT, c, 12, NOVA_MARKET);
    expect(adjustments.assessed).toBeDefined();
    expect(adjustments.time).toBeGreaterThan(0);
  });
});

describe("assessment-ratio band", () => {
  const opts = { maxAssessmentRatioDeviation: 0.25 };

  it("centres on the median ratio", () => {
    const band = assessmentRatioBand(CONSISTENT, opts)!;
    expect(band.median).toBeCloseTo(1.15, 2);
    expect(band.min).toBeCloseTo(1.15 * 0.75, 2);
    expect(band.max).toBeCloseTo(1.15 * 1.25, 2);
  });

  it("declines to judge on too small a sample", () => {
    // With a handful of sales the "outliers" are just the sample.
    expect(assessmentRatioBand(CONSISTENT.slice(0, 7), opts)).toBeNull();
  });

  it("ignores comps with no assessment", () => {
    const mixed = [...CONSISTENT.slice(0, 5), comp({ id: "n1" }), comp({ id: "n2" })];
    expect(assessmentRatioBand(mixed, opts)).toBeNull();
  });

  it("is unaffected by an extreme outlier, being a median", () => {
    const withOutlier = [...CONSISTENT, assessedComp("WILD", 2_000_000, 4.0)];
    const band = assessmentRatioBand(withOutlier, opts)!;
    expect(band.median).toBeCloseTo(1.15, 1);
  });
});

describe("outlier rejection end to end", () => {
  it("rejects a teardown-style sale far above local assessment ratios", () => {
    const teardown = assessedComp("TEARDOWN", 2_250_000, 1.75);
    const r = valueFromComps(ASSESSED_SUBJECT, [...CONSISTENT, teardown], { asOf: AS_OF });

    const rejection = r.rejected.find(x => x.comp.id === "TEARDOWN");
    expect(rejection).toBeDefined();
    expect(rejection!.reason).toMatch(/× assessed value/);
    expect(r.comps.map(c => c.comp.id)).not.toContain("TEARDOWN");
  });

  it("rejects a distressed sale far below local assessment ratios", () => {
    const distressed = assessedComp("DISTRESSED", 2_250_000, 0.55);
    const r = valueFromComps(ASSESSED_SUBJECT, [...CONSISTENT, distressed], { asOf: AS_OF });
    expect(r.rejected.find(x => x.comp.id === "DISTRESSED")).toBeDefined();
  });

  it("tightens the range and raises confidence versus leaving outliers in", () => {
    const outliers = [
      assessedComp("HI", 2_250_000, 1.75),
      assessedComp("LO", 2_250_000, 0.6),
    ];
    const all = [...CONSISTENT, ...outliers];

    const filtered = valueFromComps(ASSESSED_SUBJECT, all, { asOf: AS_OF });
    const unfiltered = valueFromComps(ASSESSED_SUBJECT, all, {
      asOf: AS_OF,
      maxAssessmentRatioDeviation: 10, // effectively disabled
    });

    const width = (r: typeof filtered) => (r.high! - r.low!) / r.estimate!;
    expect(width(filtered)).toBeLessThan(width(unfiltered));
    expect(filtered.confidenceScore).toBeGreaterThan(unfiltered.confidenceScore);
  });

  it("leaves a clean comp set untouched", () => {
    const r = valueFromComps(ASSESSED_SUBJECT, CONSISTENT, { asOf: AS_OF });
    expect(r.rejected.filter(x => /assessed value/.test(x.reason))).toHaveLength(0);
    expect(r.confidence).toBe("high");
  });

  it("produces an estimate consistent with the local ratio", () => {
    const r = valueFromComps(ASSESSED_SUBJECT, CONSISTENT, { asOf: AS_OF });
    // Subject assessed at 2.3M in a market trading at ~1.15× assessment.
    expect(r.estimate!).toBeGreaterThan(2_500_000);
    expect(r.estimate!).toBeLessThan(2_900_000);
  });

  it("is disabled by default config only through its threshold, not silently", () => {
    expect(DEFAULT_OPTIONS.maxAssessmentRatioDeviation).toBeGreaterThan(0);
  });
});

describe("fairfax geometry and land use", () => {
  it("computes a polygon centroid", () => {
    // Unit square centred on (0.5, 0.5).
    const c = ringCentroid([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])!;
    expect(c.lng).toBeCloseTo(0.5, 6);
    expect(c.lat).toBeCloseTo(0.5, 6);
  });

  it("falls back to the vertex mean for a degenerate ring", () => {
    const c = ringCentroid([[[2, 4], [2, 4], [2, 4]]])!;
    expect(c.lng).toBeCloseTo(2, 6);
    expect(c.lat).toBeCloseTo(4, 6);
  });

  it("returns null for unusable geometry", () => {
    expect(ringCentroid(undefined)).toBeNull();
    expect(ringCentroid([[[0, 0]]])).toBeNull();
  });
});

describe("fairfax record handling", () => {
  it("dedupes a re-recorded deed to one comp per parcel, keeping the latest", async () => {
    // Public record carries the same sale twice — an original deed plus a
    // correction days later. Both rows share a price, so keying on
    // parcel+date lets one sale through twice and doubles its weight.
    const ring = [[[-77.16, 38.94], [-77.159, 38.94], [-77.159, 38.941], [-77.16, 38.941], [-77.16, 38.94]]];
    const sale = (dateMs: number) => ({
      attributes: { PIN: "0694 14  0112", PRICE: 930_000, SALEDT: dateMs, SALEVAL_DESC: "Valid and verified sale", NOPAR: 1 },
      geometry: { rings: ring },
    });

    const responses = [
      { features: [sale(Date.parse("2025-08-08")), sale(Date.parse("2025-08-11"))] },
      { features: [{ attributes: { PIN: "0694 14  0112", LUC: "011", APRTOT: 881_140 } }] },
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(responses[call++] ?? { features: [] }),
    })));

    const { FairfaxCountyProvider } = await import("./providers/fairfax");
    const comps = await new FairfaxCountyProvider().fetchCandidates(
      { location: { lat: 38.94, lng: -77.161 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );

    expect(comps).toHaveLength(1);
    expect(comps[0].soldDate).toBe("2025-08-11"); // the later of the two
    expect(comps[0].assessedValue).toBe(881_140);
    vi.unstubAllGlobals();
  });

  it("drops sales whose validity code isn't an arm's-length transfer", async () => {
    const ring = [[[-77.16, 38.94], [-77.159, 38.94], [-77.159, 38.941], [-77.16, 38.94]]];
    const responses = [
      { features: [
        { attributes: { PIN: "A", PRICE: 900_000, SALEDT: Date.parse("2026-05-01"), SALEVAL_DESC: "Valid and verified sale", NOPAR: 1 }, geometry: { rings: ring } },
        { attributes: { PIN: "B", PRICE: 1, SALEDT: Date.parse("2026-05-01"), SALEVAL_DESC: "Transfer between family members", NOPAR: 1 }, geometry: { rings: ring } },
      ] },
      { features: [{ attributes: { PIN: "A", LUC: "011", APRTOT: 800_000 } }] },
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(responses[call++] ?? { features: [] }),
    })));

    const { FairfaxCountyProvider } = await import("./providers/fairfax");
    const comps = await new FairfaxCountyProvider().fetchCandidates(
      { location: { lat: 38.94, lng: -77.161 }, propertyType: "single_family" },
      { radiusMiles: 1, lookbackMonths: 12 }
    );
    expect(comps.map(c => c.id.split("@")[0])).toEqual(["A"]);
    vi.unstubAllGlobals();
  });
});
