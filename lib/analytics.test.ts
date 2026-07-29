import { describe, expect, it } from "vitest";
import { counterKeys, sanitizeEvent, summarize } from "./analytics";

/**
 * `sanitizeEvent` is the privacy boundary of a PUBLIC endpoint. Everything a
 * homeowner's browser sends passes through it, and anything it lets through
 * ends up in a log line that outlives the visit. These tests are less about
 * correctness than about that boundary holding.
 */

const valid = { name: "valuation_returned", sessionId: "abc123" };

describe("sanitizeEvent — what must never get through", () => {
  it("drops personal fields even when a caller sends them", () => {
    const out = sanitizeEvent({
      ...valid,
      email: "someone@example.com",
      address: "123 Main St",
      fullAddress: "123 Main St, McLean, VA 22101",
      name: "valuation_returned",
      ownerName: "A Homeowner",
      lat: 38.9,
      lng: -77.1,
    })!;

    // Allow-list, not deny-list: the shape of the output is fixed.
    expect(Object.keys(out).sort()).toEqual(
      ["confidence", "degradedCode", "hasEstimate", "jurisdiction", "name", "sessionId", "zipCode"].sort()
    );
    expect(JSON.stringify(out)).not.toContain("example.com");
    expect(JSON.stringify(out)).not.toContain("Main St");
    expect(JSON.stringify(out)).not.toContain("38.9");
  });

  it("reduces a ZIP+4 to five digits", () => {
    // A ZIP+4 identifies a building; five digits identify a town.
    expect(sanitizeEvent({ ...valid, zipCode: "22101-1234" })?.zipCode).toBe("22101");
  });

  it("drops a malformed ZIP rather than passing it through", () => {
    expect(sanitizeEvent({ ...valid, zipCode: "abc" })?.zipCode).toBeUndefined();
    expect(sanitizeEvent({ ...valid, zipCode: "221" })?.zipCode).toBeUndefined();
  });

  it("bounds field length so a hostile payload cannot bloat the logs", () => {
    const out = sanitizeEvent({ ...valid, jurisdiction: "x".repeat(5000) })!;
    expect(out.jurisdiction!.length).toBeLessThanOrEqual(24);
  });
});

describe("sanitizeEvent — validation", () => {
  it("rejects an unknown event name", () => {
    expect(sanitizeEvent({ name: "wire_me_money", sessionId: "a" })).toBeNull();
  });

  it("requires a session id", () => {
    expect(sanitizeEvent({ name: "lead_submitted" })).toBeNull();
    expect(sanitizeEvent({ name: "lead_submitted", sessionId: "   " })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent("lead_submitted")).toBeNull();
    expect(sanitizeEvent(42)).toBeNull();
  });

  it("keeps hasEstimate only when it is genuinely boolean", () => {
    expect(sanitizeEvent({ ...valid, hasEstimate: true })?.hasEstimate).toBe(true);
    expect(sanitizeEvent({ ...valid, hasEstimate: false })?.hasEstimate).toBe(false);
    // "false" as a string must not become true.
    expect(sanitizeEvent({ ...valid, hasEstimate: "false" })?.hasEstimate).toBeUndefined();
  });
});

describe("counterKeys", () => {
  it("splits by whether a number was shown", () => {
    const withNumber = counterKeys({ name: "lead_submitted", sessionId: "a", hasEstimate: true });
    expect(withNumber).toContain("ev:lead_submitted");
    expect(withNumber).toContain("ev:lead_submitted:with_estimate");
  });

  it("distinguishes false from absent", () => {
    // `hasEstimate: false` is the case the publish threshold created; it must
    // count, not be treated as missing.
    expect(counterKeys({ name: "lead_submitted", sessionId: "a", hasEstimate: false })).toContain(
      "ev:lead_submitted:without_estimate"
    );
    expect(counterKeys({ name: "lead_submitted", sessionId: "a" })).toEqual(["ev:lead_submitted"]);
  });
});

describe("summarize", () => {
  it("computes the comparison the publish threshold rests on", () => {
    const s = summarize({
      "ev:valuation_returned": 100,
      "ev:valuation_returned:with_estimate": 90,
      "ev:valuation_returned:without_estimate": 10,
      "ev:lead_submitted": 40,
      "ev:lead_submitted:with_estimate": 36,
      "ev:lead_submitted:without_estimate": 4,
    });

    expect(s.conversion.overall).toBe(0.4);
    expect(s.conversion.withEstimate).toBe(0.4);
    expect(s.conversion.withoutEstimate).toBe(0.4);
    expect(s.valuationOutcome.shareWithEstimate).toBe(0.9);
  });

  it("returns null rather than dividing by zero", () => {
    const s = summarize({});
    expect(s.conversion.overall).toBeNull();
    expect(s.conversion.withEstimate).toBeNull();
    expect(s.totals.leadSubmitted).toBe(0);
  });

  it("surfaces a real gap between the two paths", () => {
    const s = summarize({
      "ev:valuation_returned:with_estimate": 100,
      "ev:valuation_returned:without_estimate": 100,
      "ev:lead_submitted:with_estimate": 50,
      "ev:lead_submitted:without_estimate": 20,
    });
    // If this is what the live data looks like, withholding low-confidence
    // estimates is costing leads and the threshold needs revisiting.
    expect(s.conversion.withEstimate).toBe(0.5);
    expect(s.conversion.withoutEstimate).toBe(0.2);
  });
});
