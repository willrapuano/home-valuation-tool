import { describe, expect, it } from "vitest";
import { calibrateMarket, olsCentered } from "./calibrate";
import { NOVA_MARKET } from "./config";
import { adjustComp } from "./adjust";
import { ComparableSale } from "./types";

/**
 * Calibration exists because the engine's constants were Northern Virginia
 * numbers applied everywhere: $250/sqft is roughly right in Fairfax, and 60%
 * low in Bethesda, where the measured figure is $634. These tests pin the
 * behaviour that makes that safe — it must track a real market, and it must
 * refuse to move on evidence too thin to support it.
 */

const ASOF = "2026-07-01";

/** Synthetic market where price is a known function of size, plus noise. */
function syntheticMarket(opts: {
  n: number;
  pricePerSqft: number;
  base: number;
  assessed?: (price: number) => number;
}): ComparableSale[] {
  const rows: ComparableSale[] = [];
  for (let i = 0; i < opts.n; i++) {
    // Deterministic pseudo-variation, so the test never flakes.
    const sqft = 1200 + ((i * 137) % 2400);
    const lotSqft = 5000 + ((i * 311) % 9000);
    const yearBuilt = 1950 + ((i * 7) % 70);
    const price = Math.round(opts.base + sqft * opts.pricePerSqft + ((i * 53) % 40000));
    rows.push({
      id: `c${i}`,
      address: `${i} Test St`,
      location: { lat: 38.9 + i * 1e-4, lng: -77.1 + i * 1e-4 },
      soldPrice: price,
      soldDate: `2026-0${(i % 6) + 1}-15`,
      propertyType: "single_family",
      sqft,
      lotSqft,
      yearBuilt,
      assessedValue: opts.assessed ? Math.round(opts.assessed(price)) : undefined,
    });
  }
  return rows;
}

describe("olsCentered", () => {
  it("recovers a known linear relationship", () => {
    const rows = Array.from({ length: 60 }, (_, i) => [i, (i * 7) % 13]);
    const y = rows.map(([a, b]) => 3 * a + 5 * b + 100);
    const beta = olsCentered(rows, y)!;
    expect(beta[0]).toBeCloseTo(3, 1);
    expect(beta[1]).toBeCloseTo(5, 1);
  });

  it("returns null rather than nonsense on a degenerate system", () => {
    expect(olsCentered([[1, 1]], [1])).toBeNull();
    expect(olsCentered([], [])).toBeNull();
  });

  it("survives perfectly collinear predictors", () => {
    // Lot size tracking house size exactly is common in a single-builder
    // subdivision; the ridge term has to keep this solvable.
    const rows = Array.from({ length: 40 }, (_, i) => [1000 + i * 10, 2000 + i * 20]);
    const y = rows.map(r => r[0] * 200);
    const beta = olsCentered(rows, y);
    expect(beta).not.toBeNull();
    expect(beta!.every(Number.isFinite)).toBe(true);
  });
});

describe("calibrateMarket", () => {
  it("tracks an expensive market instead of using the Fairfax default", () => {
    const rows = syntheticMarket({ n: 120, pricePerSqft: 600, base: 200_000 });
    const { market, derived } = calibrateMarket(rows, NOVA_MARKET, ASOF);

    expect(derived).toContain("pricePerSqft");
    expect(market.pricePerSqft).toBeGreaterThan(NOVA_MARKET.pricePerSqft * 1.5);
  });

  it("tracks a cheap market downward too", () => {
    const cheap = calibrateMarket(
      syntheticMarket({ n: 120, pricePerSqft: 120, base: 60_000 }),
      NOVA_MARKET,
      ASOF
    );
    const dear = calibrateMarket(
      syntheticMarket({ n: 120, pricePerSqft: 600, base: 200_000 }),
      NOVA_MARKET,
      ASOF
    );
    expect(cheap.market.pricePerSqft).toBeLessThan(dear.market.pricePerSqft);
  });

  it("keeps the prior when the sample is too thin to support a change", () => {
    const { market, derived } = calibrateMarket(
      syntheticMarket({ n: 4, pricePerSqft: 600, base: 200_000 }),
      NOVA_MARKET,
      ASOF
    );
    expect(derived).not.toContain("pricePerSqft");
    expect(market.pricePerSqft).toBe(NOVA_MARKET.pricePerSqft);
  });

  it("never returns a negative or absurd price per square foot", () => {
    // Prices unrelated to size: an unconstrained fit can go negative here.
    const rows = syntheticMarket({ n: 100, pricePerSqft: 0, base: 500_000 });
    const { market } = calibrateMarket(rows, NOVA_MARKET, ASOF);
    expect(market.pricePerSqft).toBeGreaterThan(0);
    expect(market.pricePerLotSqft).toBeGreaterThanOrEqual(0);
    expect(market.perYearOfAge).toBeGreaterThanOrEqual(0);
  });

  it("scales the condition step to local prices", () => {
    const cheap = calibrateMarket(
      syntheticMarket({ n: 100, pricePerSqft: 120, base: 60_000 }),
      NOVA_MARKET,
      ASOF
    );
    const dear = calibrateMarket(
      syntheticMarket({ n: 100, pricePerSqft: 600, base: 200_000 }),
      NOVA_MARKET,
      ASOF
    );
    // A flat $25,000 condition step means something very different on a
    // $450,000 house than on a $1.4M one.
    expect(dear.market.perConditionPoint).toBeGreaterThan(cheap.market.perConditionPoint);
  });

  it("drops to the physical grid where nobody publishes assessments", () => {
    const rows = syntheticMarket({ n: 100, pricePerSqft: 300, base: 100_000 });
    const { market } = calibrateMarket(rows, NOVA_MARKET, ASOF);
    expect(market.assessmentWeight).toBe(0);
  });

  it("keeps the assessment basis where assessments exist", () => {
    const rows = syntheticMarket({
      n: 100,
      pricePerSqft: 300,
      base: 100_000,
      assessed: p => p / 1.1,
    });
    const { market } = calibrateMarket(rows, NOVA_MARKET, ASOF);
    expect(market.assessmentWeight).toBeGreaterThan(0);
    expect(market.saleToAssessedRatio).toBeCloseTo(1.1, 1);
  });

  it("ignores implausible assessments when setting the ratio", () => {
    // Maryland publishes land-only records: $1,200 assessed against a $1.4M
    // sale. Left in, these drag the ratio far from what assessors actually do.
    const rows = syntheticMarket({ n: 100, pricePerSqft: 300, base: 100_000, assessed: p => p });
    for (let i = 0; i < 20; i++) rows[i].assessedValue = 1_200;
    const { market } = calibrateMarket(rows, NOVA_MARKET, ASOF);
    expect(market.saleToAssessedRatio).toBeLessThan(1.5);
  });
});

describe("adjustComp assessment blending", () => {
  const subject = { location: { lat: 38.9, lng: -77.1 }, propertyType: "single_family" as const };

  const comp: ComparableSale = {
    id: "c",
    address: "1 Test St",
    location: { lat: 38.9, lng: -77.1 },
    soldPrice: 800_000,
    soldDate: "2026-01-15",
    propertyType: "single_family",
    sqft: 2000,
    assessedValue: 800_000,
  };

  it("uses the assessment alone at full weight", () => {
    const r = adjustComp(
      { ...subject, sqft: 3000, assessedValue: 900_000 },
      comp,
      0,
      { ...NOVA_MARKET, assessmentWeight: 1 }
    );
    expect(r.adjustments.assessed).toBeCloseTo(100_000, 0);
    expect(r.adjustments.gla).toBeUndefined();
  });

  it("uses the physical grid alone at zero weight", () => {
    const r = adjustComp(
      { ...subject, sqft: 3000, assessedValue: 900_000 },
      comp,
      0,
      { ...NOVA_MARKET, assessmentWeight: 0 }
    );
    expect(r.adjustments.assessed).toBeUndefined();
    expect(r.adjustments.gla).toBeCloseTo(1000 * NOVA_MARKET.pricePerSqft, 0);
  });

  it("splits between them in between, without double-counting", () => {
    const r = adjustComp(
      { ...subject, sqft: 3000, assessedValue: 900_000 },
      comp,
      0,
      { ...NOVA_MARKET, assessmentWeight: 0.5 }
    );
    // Half of each basis, not the sum of both — summing would charge the extra
    // 1,000 sqft twice, once directly and once through the assessment it lifts.
    expect(r.adjustments.assessed).toBeCloseTo(50_000, 0);
    expect(r.adjustments.gla).toBeCloseTo(0.5 * 1000 * NOVA_MARKET.pricePerSqft, 0);
  });

  it("falls back to the assessment when a comp has no living area", () => {
    // Fairfax publishes no building characteristics at all. Blending toward a
    // basis that does not exist would shrink every adjustment toward zero.
    const noSqft = { ...comp, sqft: undefined };
    const r = adjustComp(
      { ...subject, assessedValue: 900_000 },
      noSqft,
      0,
      { ...NOVA_MARKET, assessmentWeight: 0.5 }
    );
    expect(r.adjustments.assessed).toBeCloseTo(100_000, 0);
  });

  it("falls back to the grid when a comp has no assessment", () => {
    const noAssessment = { ...comp, assessedValue: undefined };
    const r = adjustComp(
      { ...subject, sqft: 3000, assessedValue: 900_000 },
      noAssessment,
      0,
      { ...NOVA_MARKET, assessmentWeight: 0.9 }
    );
    expect(r.adjustments.assessed).toBeUndefined();
    expect(r.adjustments.gla).toBeCloseTo(1000 * NOVA_MARKET.pricePerSqft, 0);
  });
});
