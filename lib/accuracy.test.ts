import { describe, expect, it } from "vitest";
import {
  accuracyLine,
  errorPctFor,
  formatErrorBand,
  formatEstimate,
  roundToSigFigs,
  ACCURACY,
} from "./accuracy";

describe("roundToSigFigs", () => {
  it("rounds to three significant figures", () => {
    expect(roundToSigFigs(1_951_882)).toBe(1_950_000);
    expect(roundToSigFigs(845_231)).toBe(845_000);
    expect(roundToSigFigs(312_456)).toBe(312_000);
    expect(roundToSigFigs(999_999)).toBe(1_000_000);
  });

  it("handles nonsense without throwing", () => {
    expect(roundToSigFigs(0)).toBe(0);
    expect(roundToSigFigs(-5)).toBe(0);
    expect(roundToSigFigs(NaN)).toBe(0);
  });
});

describe("formatEstimate", () => {
  it("abbreviates millions the way a person says them", () => {
    expect(formatEstimate(1_951_882)).toBe("$1.95M");
    expect(formatEstimate(2_500_000)).toBe("$2.5M");
    expect(formatEstimate(1_000_000)).toBe("$1M");
    expect(formatEstimate(12_440_000)).toBe("$12.4M");
  });

  /**
   * Regression: stripping trailing zeros with /0+$/ rather than only after a
   * decimal point turned $120M into $12M.
   */
  it("does not eat trailing zeros of a whole number of millions", () => {
    expect(formatEstimate(120_000_000)).toBe("$120M");
    expect(formatEstimate(100_000_000)).toBe("$100M");
  });

  it("writes sub-million figures out in full", () => {
    expect(formatEstimate(845_231)).toBe("$845,000");
    expect(formatEstimate(312_456)).toBe("$312,000");
  });

  /** Three significant figures, always — never the raw engine output. */
  it("never prints more precision than the engine has earned", () => {
    for (const n of [1_951_882, 845_231, 312_456, 4_212_990]) {
      expect(formatEstimate(n)).not.toContain(String(n % 1000).padStart(3, "0"));
    }
  });
});

describe("errorPctFor", () => {
  it("uses the measured per-jurisdiction figure", () => {
    expect(errorPctFor("dc")).toBe(4.7);
    expect(errorPctFor("DC")).toBe(4.7);
    expect(errorPctFor("fairfax")).toBe(7.5);
  });

  it("falls back to the pooled figure for anything unmeasured", () => {
    expect(errorPctFor("arlington")).toBe(ACCURACY.medianErrorPct);
    expect(errorPctFor(undefined)).toBe(ACCURACY.medianErrorPct);
    expect(errorPctFor(null)).toBe(ACCURACY.medianErrorPct);
  });
});

describe("formatErrorBand", () => {
  it("is two significant figures of the jurisdiction's measured error", () => {
    // 1,951,882 × 4.7% = 91,738 → 92,000
    expect(formatErrorBand(1_951_882, "dc")).toBe("$92,000");
    // × 7.5% = 146,391 → 150,000
    expect(formatErrorBand(1_951_882, "fairfax")).toBe("$150,000");
  });

  it("is wider where the data is worse", () => {
    const dc = formatErrorBand(1_000_000, "dc");
    const fairfax = formatErrorBand(1_000_000, "fairfax");
    expect(dc).not.toBe(fairfax);
  });
});

describe("accuracyLine", () => {
  it("names the jurisdiction when it has its own measured figure", () => {
    expect(accuracyLine(1_951_882, "dc")).toBe(
      "give or take $92,000 — half of estimates in Washington, DC land within 4.7% of the sale price"
    );
  });

  /**
   * Regression: interpolating the fallback label produced "half of public
   * records estimates land within 6.1%…", which is not a sentence.
   */
  it("omits the jurisdiction rather than interpolating the fallback label", () => {
    const line = accuracyLine(1_951_882);
    expect(line).toBe(
      "give or take $120,000 — half of estimates land within 6.1% of the sale price"
    );
    expect(line).not.toContain("public records");
  });

  it("says nothing about a jurisdiction it has not measured", () => {
    expect(accuracyLine(1_000_000, "arlington")).not.toContain("arlington");
  });
});
