import { describe, expect, it } from "vitest";
import { shouldPublishEstimate } from "./publish";

/**
 * The rule that decides whether a homeowner sees a number. Getting this wrong
 * in either direction is expensive: publish too freely and we anchor people on
 * figures that are 20%+ wrong; withhold too freely and we lose the hook the
 * whole funnel runs on.
 */

describe("shouldPublishEstimate", () => {
  it("publishes high confidence", () => {
    expect(shouldPublishEstimate({ estimate: 900_000, confidence: "high" })).toEqual({
      publish: true,
    });
  });

  it("publishes medium confidence", () => {
    // 16% of medium estimates land beyond 20% error, against 40% for low.
    // Materially worse than high, but the estimate still tracks the property
    // and the range communicates the uncertainty.
    expect(shouldPublishEstimate({ estimate: 900_000, confidence: "medium" })).toEqual({
      publish: true,
    });
  });

  it("withholds low confidence even though an estimate exists", () => {
    // The engine produced a number; we decline to show it. Two in five are
    // more than 20% wrong, around a range a median 80% wide.
    expect(shouldPublishEstimate({ estimate: 1_650_000, confidence: "low" })).toEqual({
      publish: false,
      reason: "low_confidence",
    });
  });

  it("distinguishes no-estimate from low-confidence", () => {
    // These need different fixes — one is a coverage problem, the other a
    // property problem — so they must not collapse into one reason.
    expect(shouldPublishEstimate({ estimate: null, confidence: "none" })).toEqual({
      publish: false,
      reason: "no_estimate",
    });
  });

  it("withholds a null estimate regardless of the confidence label", () => {
    expect(shouldPublishEstimate({ estimate: null, confidence: "high" })).toEqual({
      publish: false,
      reason: "no_estimate",
    });
  });

  it("does not publish a zero or negative estimate as if it were a valuation", () => {
    // Zero is falsy but not null, so a `=== null` check would let it through
    // and print "$0" to a homeowner. reconcile() should never produce one,
    // which is why the guard is here rather than assumed away.
    expect(shouldPublishEstimate({ estimate: 0, confidence: "high" })).toEqual({
      publish: false,
      reason: "no_estimate",
    });
    expect(shouldPublishEstimate({ estimate: -5, confidence: "high" })).toEqual({
      publish: false,
      reason: "no_estimate",
    });
  });
});
