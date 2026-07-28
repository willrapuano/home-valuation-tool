import { describe, expect, it } from "vitest";
import { adjustComp } from "./adjust";
import { NOVA_MARKET, DEFAULT_WEIGHTS } from "./config";
import {
  CONDO_COMP,
  FAR_COMP,
  FixtureCompsProvider,
  SCATTERED_COMPS,
  STALE_COMP,
  SUBJECT,
  TIGHT_COMPS,
  TINY_COMP,
  comp,
} from "./fixtures";
import { haversineMiles, monthsBetween } from "./geo";
import { valueFromComps, valueWithProvider } from "./index";
import { reconcile, scoreConfidence } from "./reconcile";
import { decay, ratioSimilarity, scoreDimensions, weightedScore } from "./score";

const AS_OF = "2026-07-01";
const opts = { asOf: AS_OF };

describe("geo", () => {
  it("measures a known distance", () => {
    // DC to Baltimore is ~35 miles.
    const d = haversineMiles({ lat: 38.9072, lng: -77.0369 }, { lat: 39.2904, lng: -76.6122 });
    expect(d).toBeGreaterThan(33);
    expect(d).toBeLessThan(38);
  });

  it("returns zero for the same point", () => {
    expect(haversineMiles({ lat: 38.9, lng: -77.1 }, { lat: 38.9, lng: -77.1 })).toBe(0);
  });

  it("counts whole months and floors at zero", () => {
    expect(monthsBetween("2026-01-01", "2026-07-01")).toBe(6);
    expect(monthsBetween("2026-06-20", "2026-07-01")).toBe(0);
    // A future sale date must not produce a negative age.
    expect(monthsBetween("2026-12-01", "2026-07-01")).toBe(0);
  });
});

describe("scoring primitives", () => {
  it("decays to half at the half-life", () => {
    expect(decay(0, 6)).toBe(1);
    expect(decay(6, 6)).toBeCloseTo(0.5, 5);
    expect(decay(12, 6)).toBeCloseTo(0.25, 5);
  });

  it("judges size similarity on ratio, not absolute difference", () => {
    // 200 sqft on a small home is a bigger deal than on a large one.
    const small = ratioSimilarity(900, 1100)!;
    const large = ratioSimilarity(5000, 5200)!;
    expect(large).toBeGreaterThan(small);
  });

  it("returns null rather than zero for missing data", () => {
    expect(ratioSimilarity(undefined, 1000)).toBeNull();
    expect(ratioSimilarity(1000, 0)).toBeNull();
  });

  it("drops null dimensions instead of scoring them as zero", () => {
    const full = weightedScore({ distance: 1, sqft: 1 }, DEFAULT_WEIGHTS);
    const withGap = weightedScore({ distance: 1, sqft: 1, lot: null }, DEFAULT_WEIGHTS);
    expect(withGap.score).toBeCloseTo(full.score, 10);
    expect(withGap.used).not.toHaveProperty("lot");
  });

  it("scores zero when no dimension has data", () => {
    expect(weightedScore({ distance: null, sqft: null }, DEFAULT_WEIGHTS).score).toBe(0);
  });

  it("rewards a same-subdivision comp over a different one", () => {
    const base = { distanceMiles: 0.3, ageMonths: 2 };
    const same = scoreDimensions({ subject: SUBJECT, comp: comp({ id: "s" }), ...base });
    const other = scoreDimensions({
      subject: SUBJECT,
      comp: comp({ id: "o", subdivision: "Langley Oaks" }),
      ...base,
    });
    expect(same.subdivision).toBeGreaterThan(other.subdivision!);
  });
});

describe("adjustments", () => {
  it("revises an older sale upward in an appreciating market", () => {
    const c = comp({ id: "t", soldDate: "2025-07-01" });
    const { adjustments, adjustedPrice } = adjustComp(SUBJECT, c, 12, NOVA_MARKET);
    expect(adjustments.time).toBeGreaterThan(0);
    expect(adjustedPrice).toBeGreaterThan(c.soldPrice);
  });

  it("revises a larger comp downward toward a smaller subject", () => {
    const bigger = comp({ id: "b", sqft: 3500 });
    const { adjustments } = adjustComp(SUBJECT, bigger, 0, NOVA_MARKET);
    // Subject 3000 vs comp 3500 => -500 sqft * $250.
    expect(adjustments.gla).toBeCloseTo(-125_000, 5);
  });

  it("reports gross and net adjustment ratios separately", () => {
    // Offsetting adjustments: small net, large gross.
    const c = comp({ id: "x", sqft: 3400, baths: 2 });
    const r = adjustComp(SUBJECT, c, 0, NOVA_MARKET);
    expect(Math.abs(r.netAdjustmentRatio)).toBeLessThan(r.grossAdjustmentRatio);
  });

  it("never produces a negative adjusted price", () => {
    const c = comp({ id: "cheap", soldPrice: 10_000, sqft: 12_000 });
    expect(adjustComp(SUBJECT, c, 0, NOVA_MARKET).adjustedPrice).toBeGreaterThanOrEqual(0);
  });
});

describe("knockout filters", () => {
  const cases: [string, ReturnType<typeof comp>, RegExp][] = [
    ["distance", FAR_COMP, /miles away/],
    ["staleness", STALE_COMP, /months ago/],
    ["property type", CONDO_COMP, /not comparable/],
    ["size band", TINY_COMP, /outside the/],
  ];

  for (const [label, candidate, pattern] of cases) {
    it(`rejects on ${label}`, () => {
      const r = valueFromComps(SUBJECT, [...TIGHT_COMPS, candidate], opts);
      const rejected = r.rejected.find(x => x.comp.id === candidate.id);
      expect(rejected, `${candidate.id} should have been rejected`).toBeDefined();
      expect(rejected!.reason).toMatch(pattern);
      expect(r.comps.map(c => c.comp.id)).not.toContain(candidate.id);
    });
  }

  it("rejects a comp needing excessive gross adjustments", () => {
    // Within the sqft band but far enough off on everything else to blow the cap.
    const awkward = comp({
      id: "AWKWARD",
      sqft: 2100,
      lotSqft: 40_000,
      baths: 7,
      beds: 8,
      yearBuilt: 1930,
      condition: 5,
      soldPrice: 800_000,
    });
    const r = valueFromComps(SUBJECT, [...TIGHT_COMPS, awkward], opts);
    expect(r.rejected.find(x => x.comp.id === "AWKWARD")?.reason).toMatch(/gross adjustments/);
  });

  it("keeps a townhouse for a detached subject but penalises it", () => {
    const th = comp({ id: "TH", propertyType: "townhouse" });
    const identical = comp({ id: "SF" });
    const r = valueFromComps(SUBJECT, [th, identical, ...TIGHT_COMPS], opts);
    const thScore = r.comps.find(c => c.comp.id === "TH")?.score;
    const sfScore = r.comps.find(c => c.comp.id === "SF")?.score;
    expect(thScore).toBeDefined();
    expect(thScore!).toBeLessThan(sfScore!);
  });
});

describe("ranking", () => {
  it("ranks a near, recent, same-subdivision comp above a distant stale one", () => {
    const best = comp({ id: "BEST" });
    const worst = comp({
      id: "WORST",
      location: { lat: 38.9455, lng: -77.166 },
      soldDate: "2025-09-01",
      subdivision: "Langley Oaks",
      schoolZone: "Kent Gardens ES",
    });
    const r = valueFromComps(SUBJECT, [worst, best], { ...opts, minCompCount: 1 });
    expect(r.comps[0].comp.id).toBe("BEST");
  });

  it("returns comps sorted by descending score", () => {
    const r = valueFromComps(SUBJECT, TIGHT_COMPS, opts);
    const scores = r.comps.map(c => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("limits the reconciled set to targetCompCount", () => {
    const many = Array.from({ length: 20 }, (_, i) => comp({ id: `C${i}` }));
    const r = valueFromComps(SUBJECT, many, { ...opts, targetCompCount: 5 });
    expect(r.comps).toHaveLength(5);
  });
});

describe("reconciliation", () => {
  it("produces an estimate inside the comp range", () => {
    const r = valueFromComps(SUBJECT, TIGHT_COMPS, opts);
    expect(r.estimate).not.toBeNull();
    const prices = r.comps.map(c => c.adjustedPrice);
    expect(r.estimate!).toBeGreaterThanOrEqual(Math.min(...prices));
    expect(r.estimate!).toBeLessThanOrEqual(Math.max(...prices));
    expect(r.low!).toBeLessThan(r.estimate!);
    expect(r.high!).toBeGreaterThan(r.estimate!);
  });

  it("gives scattered comps a wider band and lower confidence than tight ones", () => {
    const tight = valueFromComps(SUBJECT, TIGHT_COMPS, opts);
    const scattered = valueFromComps(SUBJECT, SCATTERED_COMPS, opts);

    const width = (r: typeof tight) => (r.high! - r.low!) / r.estimate!;
    expect(width(scattered)).toBeGreaterThan(width(tight));
    expect(scattered.confidenceScore).toBeLessThan(tight.confidenceScore);
  });

  it("refuses to estimate below the minimum comp count", () => {
    const r = valueFromComps(SUBJECT, [comp({ id: "only" })], { ...opts, minCompCount: 3 });
    expect(r.estimate).toBeNull();
    expect(r.confidence).toBe("none");
    expect(r.notes.join(" ")).toMatch(/at least 3/);
  });

  it("weights the best comps most heavily", () => {
    // The outlier is materially worse on location and recency, so the
    // estimate should sit nearer the cluster than a plain mean would.
    const cluster = [
      comp({ id: "A", soldPrice: 1_000_000 }),
      comp({ id: "B", soldPrice: 1_000_000 }),
      comp({ id: "C", soldPrice: 1_000_000 }),
    ];
    const outlier = comp({
      id: "OUT",
      soldPrice: 1_400_000,
      location: { lat: 38.9455, lng: -77.166 },
      soldDate: "2025-09-15",
      subdivision: "Elsewhere",
    });
    const r = valueFromComps(SUBJECT, [...cluster, outlier], opts);
    const plainMean =
      r.comps.reduce((s, c) => s + c.adjustedPrice, 0) / r.comps.length;
    expect(r.estimate!).toBeLessThan(plainMean);
  });

  it("clamps the band to the configured floor for identical comps", () => {
    const identical = Array.from({ length: 4 }, (_, i) =>
      comp({ id: `I${i}`, soldPrice: 1_200_000 })
    );
    const r = reconcile(
      valueFromComps(SUBJECT, identical, opts).comps,
      { minCompCount: 3, minBandRatio: 0.04 }
    );
    const width = (r.high! - r.low!) / r.estimate!;
    expect(width).toBeCloseTo(0.08, 2);
  });
});

describe("confidence scoring", () => {
  it("rewards many similar, agreeing, lightly-adjusted comps", () => {
    const strong = scoreConfidence({
      compCount: 6, meanScore: 0.9, dispersion: 0.02, meanGrossAdjustment: 0.05,
    });
    const weak = scoreConfidence({
      compCount: 3, meanScore: 0.4, dispersion: 0.18, meanGrossAdjustment: 0.3,
    });
    expect(strong).toBeGreaterThan(0.8);
    expect(weak).toBeLessThan(0.4);
  });

  it("lets disagreement veto an otherwise strong comp set", () => {
    // Near-identical comps that sold at wildly different prices: similarity
    // and adjustment signals are excellent, but we still do not know the
    // answer, so this must not read as anything above "low".
    const disagreeing = scoreConfidence({
      compCount: 6, meanScore: 0.95, dispersion: 0.25, meanGrossAdjustment: 0.01,
    });
    expect(disagreeing).toBeLessThanOrEqual(0.35);
  });

  it("marks physically similar but price-scattered comps as low confidence", () => {
    const r = valueFromComps(SUBJECT, SCATTERED_COMPS, opts);
    expect(r.confidence).toBe("low");
  });

  it("stays within [0,1] at the extremes", () => {
    const worst = scoreConfidence({
      compCount: 0, meanScore: 0, dispersion: 5, meanGrossAdjustment: 5,
    });
    const best = scoreConfidence({
      compCount: 99, meanScore: 1, dispersion: 0, meanGrossAdjustment: 0,
    });
    expect(worst).toBeGreaterThanOrEqual(0);
    expect(best).toBeLessThanOrEqual(1);
  });
});

describe("provider integration", () => {
  it("values through a provider", async () => {
    const r = await valueWithProvider(
      SUBJECT,
      new FixtureCompsProvider(TIGHT_COMPS),
      opts
    );
    expect(r.estimate).toBeGreaterThan(0);
    expect(r.comps.length).toBeGreaterThanOrEqual(3);
  });

  it("degrades cleanly when the provider returns nothing", async () => {
    const r = await valueWithProvider(SUBJECT, new FixtureCompsProvider([]), opts);
    expect(r.estimate).toBeNull();
    expect(r.confidence).toBe("none");
    expect(r.comps).toHaveLength(0);
  });
});

describe("sparse subject data", () => {
  it("still values a subject with only location and type", () => {
    const sparse = { location: SUBJECT.location, propertyType: "single_family" as const };
    const r = valueFromComps(sparse, TIGHT_COMPS, opts);
    expect(r.estimate).toBeGreaterThan(0);
    // With nothing to adjust toward, prices pass through unadjusted apart from time.
    expect(r.comps[0].adjustments.gla).toBeUndefined();
  });

  it("is less confident about a sparse subject than a fully described one", () => {
    const sparse = { location: SUBJECT.location, propertyType: "single_family" as const };
    const full = valueFromComps(SUBJECT, TIGHT_COMPS, opts);
    const thin = valueFromComps(sparse, TIGHT_COMPS, opts);
    expect(thin.confidenceScore).toBeLessThanOrEqual(full.confidenceScore);
  });
});
