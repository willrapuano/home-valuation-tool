import { describe, expect, it } from "vitest";
import {
  accuracyLine,
  displayableAccuracy,
  errorPctFor,
  formatErrorBand,
  formatEstimate,
  newestCompDate,
  recencyLine,
  roundToSigFigs,
  ACCURACY,
  JURISDICTION_ACCURACY,
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
  it("names the jurisdiction where the measurement describes production", () => {
    expect(accuracyLine(1_951_882, "dc")).toBe(
      "give or take $92,000 — half of estimates in Washington, DC land within 4.7% of the sale price"
    );
  });

  /**
   * Maryland ships a WIDE number rather than a blank, because 11.7% was
   * measured on the production path under the 90-day cutoff production
   * actually faces. The qualifier is what stops it reading as "the engine is
   * bad at Maryland" — it is working from records a quarter old.
   */
  it("ships the lagged figure with the condition it was measured under", () => {
    const line = accuracyLine(850_000, "maryland");
    expect(line).toContain("11.7%");
    expect(line).toContain("reporting lag");
    expect(JURISDICTION_ACCURACY.maryland.pct).toBe(11.7);
  });

  /** The stale figure must not come back. 6.6% was the pre-lag measurement. */
  it("never prints the pre-lag Maryland figure", () => {
    expect(accuracyLine(850_000, "maryland")).not.toContain("6.6%");
  });

  /** The gate itself still works for anything measured under wrong conditions. */
  it("still refuses a figure marked undisplayable", () => {
    const undisplayable = Object.entries(JURISDICTION_ACCURACY).filter(
      ([, f]) => !f.displayable
    );
    for (const [key] of undisplayable) expect(accuracyLine(1_000_000, key)).toBeNull();
  });

  it("prints nothing at all rather than a pooled fallback", () => {
    expect(accuracyLine(1_951_882)).toBeNull();
    expect(accuracyLine(1_000_000, "arlington")).toBeNull();
    expect(accuracyLine(1_000_000, "postgres")).toBeNull();
  });

  /**
   * Every Maryland county in lib/markets.ts is served by the one Maryland
   * provider and reports `maryland`, so adding counties there cannot mint
   * per-county accuracy claims that were never measured. This asserts the
   * cross-product stays empty.
   */
  it("has no per-county entries the registry could have created", () => {
    for (const key of ["montgomery", "prince-georges", "howard", "frederick", "anne-arundel"]) {
      expect(JURISDICTION_ACCURACY[key]).toBeUndefined();
      expect(accuracyLine(1_000_000, key)).toBeNull();
    }
  });

  /** Every figure, displayed or not, has to say where it came from. */
  it("records the basis of every figure", () => {
    for (const [key, figure] of Object.entries(JURISDICTION_ACCURACY)) {
      expect(figure.basis.length).toBeGreaterThan(20);
      expect(key).toBe(key.toLowerCase());
      // A figure measured under an unusual condition must say so on screen,
      // not only in the basis string a homeowner never sees.
      if (figure.basis.includes("cutoff")) expect(figure.qualifier).toBeTruthy();
    }
  });
});

describe("displayableAccuracy", () => {
  it("returns the figure only when it is safe to print", () => {
    expect(displayableAccuracy("dc")?.pct).toBe(4.7);
    expect(displayableAccuracy("fairfax")?.pct).toBe(7.5);
    expect(displayableAccuracy("maryland")?.pct).toBe(11.7);
    expect(displayableAccuracy(null)).toBeNull();
    expect(displayableAccuracy("arlington")).toBeNull();
  });
});

describe("recencyLine", () => {
  it("states the date the evidence runs to", () => {
    expect(recencyLine("2026-04-30")).toContain("through April 30, 2026");
  });

  /** The whole point for Maryland: make the lag legible, not just the date. */
  it("names the lag when the feed is months behind", () => {
    expect(recencyLine("2026-04-30")).toContain("months behind");
  });

  it("says nothing about lag for a current feed", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(recencyLine(today)).not.toContain("months behind");
  });

  it("returns null rather than a broken sentence", () => {
    expect(recencyLine(null)).toBeNull();
    expect(recencyLine("")).toBeNull();
    expect(recencyLine("not-a-date")).toBeNull();
  });
});

describe("newestCompDate", () => {
  it("takes the most recent sale, not the first row", () => {
    expect(
      newestCompDate([
        { soldDate: "2026-01-15" },
        { soldDate: "2026-04-30" },
        { soldDate: "2026-03-02" },
      ])
    ).toBe("2026-04-30");
  });

  it("handles an empty or missing comp set", () => {
    expect(newestCompDate([])).toBeNull();
    expect(newestCompDate(undefined)).toBeNull();
  });
});
