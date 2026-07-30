import { describe, expect, it } from "vitest";
import { MARKETS, resolveMarket, scopeLabel } from "./markets";
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

  /**
   * Measured on DC, 24 April – 23 July 2026: median $920,000 unfiltered against
   * $870,000 restricted to dwellings. The $50,000 gap was hotels, offices,
   * warehouses, parking lots and vacant land inside a "median sale price".
   */
  it("restricts to dwellings wherever the layer allows it", () => {
    expect(MARKETS.dc.residentialOnly).toBe(true);
    expect(MARKETS.dc.filters.some(f => f.includes("PROPTYPE"))).toBe(true);

    expect(MARKETS.montgomery.residentialOnly).toBe(true);
    expect(MARKETS.montgomery.filters.some(f => f.startsWith("LU IN"))).toBe(true);

    // Fairfax genuinely cannot: land use lives on a different layer.
    expect(MARKETS.fairfax.residentialOnly).toBe(false);
  });

  /** The label must never claim a filter that did not run. */
  it("derives the panel label from the filters that actually ran", () => {
    expect(scopeLabel(MARKETS.fairfax)).toBe("Arm’s-length property sales recorded");
    expect(scopeLabel(MARKETS.dc)).toBe("Home sales recorded");
    expect(scopeLabel(MARKETS.montgomery)).toBe("Home sales recorded");

    for (const m of Object.values(MARKETS)) {
      const label = scopeLabel(m);
      if (!m.armsLength) expect(label).not.toContain("Arm");
      if (!m.residentialOnly) expect(label).not.toContain("Home sales");
    }
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
