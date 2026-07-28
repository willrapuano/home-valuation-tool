import { describe, expect, it } from "vitest";
import { gradeToCondition, parseMdDate } from "./maryland";

/**
 * Field-level parsing for the Maryland statewide feed.
 *
 * These are the mappings that fail silently rather than loudly: a misparsed
 * date produces a 1970 sale that the recency filter quietly discards, and a
 * misread grade shifts every condition adjustment without erroring.
 */

describe("parseMdDate", () => {
  it("reads Maryland's YYYYMMDD integer format", () => {
    expect(parseMdDate(20250714)).toBe("2025-07-14");
    expect(parseMdDate("20250714")).toBe("2025-07-14");
  });

  it("does not mistake epoch milliseconds for a date", () => {
    // Fairfax publishes epoch ms. Feeding that here must fail loudly rather
    // than yield a plausible-looking wrong date.
    expect(parseMdDate(1752451200000)).toBeUndefined();
  });

  it("rejects malformed and out-of-range values", () => {
    expect(parseMdDate(null)).toBeUndefined();
    expect(parseMdDate("")).toBeUndefined();
    expect(parseMdDate("not a date")).toBeUndefined();
    expect(parseMdDate(20251301)).toBeUndefined(); // month 13
    expect(parseMdDate(20250732)).toBeUndefined(); // day 32
    expect(parseMdDate(18991231)).toBeUndefined(); // before the range
    expect(parseMdDate(0)).toBeUndefined();
  });
});

describe("gradeToCondition", () => {
  it("centres the modal grade on 'average'", () => {
    // Grade 5 is the mode across 660 graded Bethesda sales, and the engine's
    // scale calls 3 average.
    expect(gradeToCondition(5)).toBe(3);
  });

  it("is monotonic across the observed 3-9 range", () => {
    const observed = [3, 4, 5, 6, 7, 8, 9];
    const mapped = observed.map(g => gradeToCondition(g)!);
    for (let i = 1; i < mapped.length; i++) {
      expect(mapped[i]).toBeGreaterThanOrEqual(mapped[i - 1]);
    }
    expect(mapped[0]).toBe(1);
    expect(mapped[mapped.length - 1]).toBe(5);
  });

  it("keeps the low grades distinct", () => {
    // The cheaper markets are dominated by grades 3-4. Collapsing those onto a
    // single condition value, as the first version did, left the dimension
    // unable to tell those houses apart at all.
    expect(gradeToCondition(3)).not.toBe(gradeToCondition(4));
  });

  it("rejects missing and nonsense grades", () => {
    expect(gradeToCondition(null)).toBeUndefined();
    expect(gradeToCondition("")).toBeUndefined();
    expect(gradeToCondition(0)).toBeUndefined();
    expect(gradeToCondition(-2)).toBeUndefined();
  });
});
