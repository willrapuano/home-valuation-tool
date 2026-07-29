import { describe, expect, it } from "vitest";
import { LABELS } from "./comps/present";
import {
  ADJUSTMENT_LABELS,
  decodeReportPayload,
  encodeReportUrl,
  ReportComp,
  ReportPayload,
} from "./report-payload";

const BASE = "https://home-valuation-tool.vercel.app";

/** atob/btoa are Node globals from v16, but the module targets the browser. */
const comp = (i: number, over: Partial<ReportComp> = {}): ReportComp => ({
  address: `${1400 + i} Independence Avenue SE`,
  soldPrice: 1_285_000,
  soldDate: "2026-05-14",
  distanceMiles: 0.42,
  monthsAgo: 2,
  sqft: 2340,
  beds: 4,
  baths: 3.5,
  yearBuilt: 1926,
  adjustedPrice: 1_312_450,
  adjustments: [
    { label: "Difference in assessed value", amount: -48_200 },
    { label: "Difference in living area", amount: 31_000 },
    { label: "Market movement since it sold", amount: 12_400 },
  ],
  ...over,
});

const payload = (comps?: ReportComp[]): ReportPayload => ({
  address: {
    full: "1425 Independence Avenue SE, Washington, DC 20003",
    streetNumber: "1425",
    streetName: "Independence Avenue SE",
    city: "Washington",
    state: "DC",
    zipCode: "20003",
  },
  valuation: {
    estimate: 1_310_000,
    low: 1_180_000,
    high: 1_440_000,
    confidence: "high",
    source: "comps",
    degraded: false,
    beds: 4,
    baths: 3.5,
    sqft: 2340,
    yearBuilt: 1926,
    pricePerSqft: 560,
    fmr: { studio: 2050, oneBr: 2080, twoBr: 2370, threeBr: 2960, fourBr: 3540 },
    areaMedianIncome: 152_000,
    ...(comps ? { comps } : {}),
  },
});

const decodeUrl = (url: string) => decodeReportPayload(new URL(url).searchParams.get("d")!);

describe("report payload codec", () => {
  it("round-trips a valuation with comps", () => {
    const original = payload([comp(0), comp(1)]);
    const back = decodeUrl(encodeReportUrl(BASE, original));

    expect(back).not.toBeNull();
    expect(back!.address).toEqual(original.address);
    expect(back!.valuation.estimate).toBe(1_310_000);
    expect(back!.valuation.comps).toEqual(original.valuation.comps);
  });

  it("does not leak the packed representation into the decoded payload", () => {
    // The report page renders `comps`; if `c` survived alongside it, a future
    // reader would reasonably use the wrong one.
    const back = decodeUrl(encodeReportUrl(BASE, payload([comp(0)])));
    expect(back!.valuation).not.toHaveProperty("c");
  });

  it("restores absent optional fields as undefined, not zero", () => {
    // The wire format writes 0 for missing numbers. A comp that came back
    // claiming 0 beds and built in year 0 would render as those literal values.
    const sparse = comp(0, { sqft: undefined, beds: undefined, baths: undefined, yearBuilt: undefined });
    const back = decodeUrl(encodeReportUrl(BASE, payload([sparse])));

    const c = back!.valuation.comps![0];
    expect(c.sqft).toBeUndefined();
    expect(c.beds).toBeUndefined();
    expect(c.baths).toBeUndefined();
    expect(c.yearBuilt).toBeUndefined();
  });

  it("keeps six comps inside the URL budget email clients enforce", () => {
    // Written out plainly, six comps take the link past 4,000 characters —
    // Outlook stops treating it as one link around 2,000 and the report arrives
    // broken across two lines.
    const url = encodeReportUrl(BASE, payload(Array.from({ length: 6 }, (_, i) => comp(i))));
    expect(url.length).toBeLessThanOrEqual(2_000);
    expect(decodeUrl(url)!.valuation.comps).toHaveLength(6);
  });

  it("sheds the weakest comps rather than overrunning the budget", () => {
    // Pathologically long addresses; the point is that the link stays usable
    // and keeps the BEST comps, since the engine orders them best-first.
    const long = Array.from({ length: 6 }, (_, i) =>
      comp(i, { address: `${1400 + i} ${"Extraordinarily Long Street Name ".repeat(6)}SE` })
    );
    const url = encodeReportUrl(BASE, payload(long));
    const back = decodeUrl(url);

    expect(url.length).toBeLessThanOrEqual(2_000);
    expect(back!.valuation.comps!.length).toBeGreaterThan(0);
    expect(back!.valuation.comps!.length).toBeLessThan(6);
    expect(back!.valuation.comps![0].address).toBe(long[0].address);
  });

  it("still reads links generated before the payload carried comps", () => {
    // Those URLs are sitting in inboxes and in GHL contact records right now.
    const legacy = {
      address: payload().address,
      valuation: { estimate: 900_000, low: 850_000, high: 950_000, confidence: "high", source: "comps" },
    };
    const raw = encodeURIComponent(Buffer.from(JSON.stringify(legacy)).toString("base64"));
    const back = decodeReportPayload(raw);

    expect(back!.valuation.estimate).toBe(900_000);
    expect(back!.valuation.comps).toBeUndefined();
  });

  it("returns null rather than throwing on a malformed link", () => {
    expect(decodeReportPayload("not-base64!!")).toBeNull();
    expect(decodeReportPayload(encodeURIComponent(Buffer.from("{}").toString("base64")))).toBeNull();
  });

  it("codes every adjustment label present.ts can emit", () => {
    // The labels are sent as indices into ADJUSTMENT_LABELS. Adding an
    // adjustment type in present.ts without extending that list would ship a
    // report that mislabels why a comp was adjusted — silently, and only for
    // the new type. This is the guard.
    for (const label of Object.values(LABELS)) {
      expect(ADJUSTMENT_LABELS).toContain(label);
    }
  });

  it("carries an unrecognised label through verbatim", () => {
    const odd = comp(0, { adjustments: [{ label: "Difference in something new", amount: 20_000 }] });
    const back = decodeUrl(encodeReportUrl(BASE, payload([odd])));

    expect(back!.valuation.comps![0].adjustments[0]).toEqual({
      label: "Difference in something new",
      amount: 20_000,
    });
  });
});
