import { describe, expect, it } from "vitest";
import { MARKETS, resolveMarket } from "./markets";
import { parseLayerDate } from "./market-pulse";

describe("resolveMarket", () => {
  it("resolves a configured market", () => {
    expect(resolveMarket("fairfax")?.label).toBe("Fairfax County");
    expect(resolveMarket("  Montgomery ")?.label).toBe("Montgomery County");
  });

  /**
   * The whole point of the registry: a Bethesda deployment must not silently
   * fall back to Fairfax figures. Null means the hero shows its coverage panel.
   */
  it("returns null rather than guessing a market", () => {
    expect(resolveMarket("arlington")).toBeNull();
    expect(resolveMarket("")).toBeNull();
    expect(resolveMarket(undefined)).toBeNull();
    expect(resolveMarket(null)).toBeNull();
  });
});

describe("market definitions", () => {
  it("writes each layer's date literal in the syntax that layer accepts", () => {
    const d = new Date("2026-05-01T00:00:00Z");
    // Fairfax and DC are Esri date fields.
    expect(MARKETS.fairfax.dateLiteral(d)).toBe("DATE '2026-05-01'");
    expect(MARKETS.dc.dateLiteral(d)).toBe("DATE '2026-05-01'");
    // Maryland stores TRADATE as an eight-character STRING; an unquoted literal
    // is a syntax error rather than a wrong answer.
    expect(MARKETS.montgomery.dateLiteral(d)).toBe("'20260501'");
  });

  /**
   * Only Fairfax publishes a sale-validity flag we can filter on in SQL. The
   * panel's wording is driven by this, so getting it wrong means claiming a
   * filter that was never applied.
   */
  it("only claims arm's-length where a filter actually excludes transfers", () => {
    expect(MARKETS.fairfax.armsLength).toBe(true);
    expect(MARKETS.fairfax.filters.some(f => f.includes("SALEVAL_DESC"))).toBe(true);

    expect(MARKETS.dc.armsLength).toBe(false);
    expect(MARKETS.montgomery.armsLength).toBe(false);
  });

  it("scopes every Maryland county to its own JURSCODE", () => {
    const md = ["montgomery", "prince-georges", "howard", "frederick", "anne-arundel"];
    const codes = md.map(k => {
      const f = MARKETS[k].filters.find(x => x.startsWith("JURSCODE"));
      expect(f).toBeDefined();
      return f;
    });
    // Sharing one statewide layer means an unscoped query returns the whole
    // state, so a missing or duplicated code is a wrong number, not an error.
    expect(new Set(codes).size).toBe(md.length);
  });
});

describe("parseLayerDate", () => {
  it("reads Esri epoch milliseconds", () => {
    expect(parseLayerDate(1784779200000)?.toISOString().slice(0, 10)).toBe("2026-07-23");
  });

  it("reads Maryland's YYYYMMDD string", () => {
    expect(parseLayerDate("20260430")?.toISOString().slice(0, 10)).toBe("2026-04-30");
  });

  it("returns null for anything else", () => {
    expect(parseLayerDate(null)).toBeNull();
    expect(parseLayerDate("2026-04-30")).toBeNull();
    expect(parseLayerDate(NaN)).toBeNull();
    expect(parseLayerDate({})).toBeNull();
  });
});
