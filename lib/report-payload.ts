import { LABELS } from "./comps/present";

/**
 * The shareable report's URL payload — encode and decode in one place.
 *
 * WHY THIS EXISTS
 *
 * The report has no backend: everything it renders is base64'd into the `?d=`
 * query string, so the link works from an email, a text message or a forward
 * with nothing to look up and nothing to expire. That is a good property and
 * worth keeping.
 *
 * It has two consequences this module handles.
 *
 * FIRST, THE SHAPE WAS WRITTEN DOWN TWICE. The encoder lived inline in
 * /api/email-report and the decoder was a separately hand-maintained type in
 * app/report/page.tsx. Nothing tied them together, and they had already
 * drifted — the route sends `degradedReason` and the page's type never
 * declared it. Both sides now import from here, so a field added to one is a
 * type error on the other rather than a silently missing row in the report.
 *
 * SECOND, THE URL HAS A BUDGET. Comparable sales are the biggest thing the
 * report shows and, written out plainly, six of them take the link from 740
 * characters to 4,144 — past the ~2,000 that Outlook and older clients will
 * carry without breaking it across lines. A report link that arrives broken is
 * worse than one without comps, so the payload is packed (below) and then
 * checked against a budget, dropping the weakest comps if it still does not
 * fit. Packing alone gets six comps into ~1,730 characters.
 */

/** Positional form of a comp. Order is part of the wire format — append only. */
type PackedComp = [
  address: string,
  soldPrice: number,
  /** YYMMDD — the century is not in doubt and this saves 4 chars per comp. */
  soldDate: string,
  distanceMiles: number,
  monthsAgo: number,
  sqft: number,
  beds: number,
  baths: number,
  yearBuilt: number,
  adjustedPrice: number,
  /** [index into ADJUSTMENT_LABELS, dollars] — or [label, dollars] if unknown. */
  adjustments: [number | string, number][],
];

export interface ReportComp {
  address: string;
  soldPrice: number;
  soldDate: string;
  distanceMiles: number;
  monthsAgo: number;
  sqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number;
  adjustedPrice: number;
  adjustments: { label: string; amount: number }[];
}

export interface ReportAddress {
  full: string;
  streetNumber: string;
  streetName: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface ReportValuation {
  estimate?: number | null;
  low?: number | null;
  high?: number | null;
  confidence: string;
  source: string;
  degraded?: boolean;
  degradedReason?: string;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  yearBuilt?: number | null;
  rentZestimate?: number | null;
  pricePerSqft?: number | null;
  homeType?: string | null;
  fmr?: { studio: number; oneBr: number; twoBr: number; threeBr: number; fourBr: number };
  areaMedianIncome?: number | null;
  /** The sales behind the number. Absent on links generated before this existed. */
  comps?: ReportComp[];
}

export interface ReportPayload {
  address: ReportAddress;
  valuation: ReportValuation;
}

/**
 * Adjustment labels, coded by position to keep them out of the URL — the eight
 * strings run 17 to 29 characters and repeat on every comp.
 *
 * APPEND ONLY, AND NEVER REORDER: a link sitting in someone's inbox from last
 * month decodes against whatever this array says today. `report-payload.test.ts`
 * asserts every label present.ts can emit appears here, so adding an adjustment
 * type without extending this list fails the build rather than shipping a
 * report that silently mislabels the reason a comp was adjusted.
 */
export const ADJUSTMENT_LABELS: string[] = Object.values(LABELS);

/**
 * Characters of URL to stay within. Outlook and several older clients stop
 * treating a URL as one link past roughly 2,000, and a report link that arrives
 * split across two lines is a dead link.
 */
const MAX_URL_LENGTH = 2_000;
/** Never put more sales in the link than the results screen shows unexpanded. */
const MAX_COMPS = 6;

function packComp(c: ReportComp): PackedComp {
  return [
    c.address,
    Math.round(c.soldPrice),
    c.soldDate.slice(2).replace(/-/g, ""),
    c.distanceMiles,
    c.monthsAgo,
    c.sqft ?? 0,
    c.beds ?? 0,
    c.baths ?? 0,
    c.yearBuilt ?? 0,
    Math.round(c.adjustedPrice),
    c.adjustments.map(a => {
      const i = ADJUSTMENT_LABELS.indexOf(a.label);
      // An unrecognised label rides through verbatim. It costs bytes, but a
      // correct reason the homeowner can read beats a compact wrong one.
      return [i >= 0 ? i : a.label, Math.round(a.amount)] as [number | string, number];
    }),
  ];
}

function unpackComp(p: PackedComp): ReportComp | null {
  if (!Array.isArray(p) || typeof p[0] !== "string") return null;
  const [address, soldPrice, date, distanceMiles, monthsAgo, sqft, beds, baths, yearBuilt, adjustedPrice, adjustments] = p;
  return {
    address,
    soldPrice,
    soldDate: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    distanceMiles,
    monthsAgo,
    // Zero is the encoder's "absent" marker, and is also not a real value for
    // any of these — no house has 0 bedrooms or was built in year 0.
    sqft: sqft || undefined,
    beds: beds || undefined,
    baths: baths || undefined,
    yearBuilt: yearBuilt || undefined,
    adjustedPrice,
    adjustments: (adjustments ?? []).map(([code, amount]) => ({
      label: typeof code === "number" ? ADJUSTMENT_LABELS[code] ?? "Adjustment" : code,
      amount,
    })),
  };
}

/**
 * Build the report URL, trimming comps until the link fits its budget.
 *
 * Comps arrive best-first from the engine, so dropping from the end sheds the
 * least similar sale first — the same one a homeowner would discard.
 */
export function encodeReportUrl(baseUrl: string, payload: ReportPayload): string {
  const comps = (payload.valuation.comps ?? []).slice(0, MAX_COMPS);

  for (let n = comps.length; n >= 0; n--) {
    const { comps: _omit, ...valuation } = payload.valuation;
    const body: Record<string, unknown> = { address: payload.address, valuation };
    if (n > 0) {
      (body.valuation as Record<string, unknown>).c = comps.slice(0, n).map(packComp);
    }
    const url = `${baseUrl}/report?d=${encodeURIComponent(
      Buffer.from(JSON.stringify(body)).toString("base64")
    )}`;
    if (url.length <= MAX_URL_LENGTH || n === 0) return url;
  }
  // Unreachable: the n === 0 pass always returns.
  return `${baseUrl}/report`;
}

/**
 * Read a `?d=` parameter back. Returns null on anything malformed rather than
 * throwing, because the caller's only useful response is the "report not found"
 * screen either way.
 *
 * Runs in the browser, so it uses atob rather than Buffer.
 */
export function decodeReportPayload(raw: string): ReportPayload | null {
  try {
    const parsed = JSON.parse(atob(decodeURIComponent(raw)));
    if (!parsed?.address || !parsed?.valuation) return null;

    const packed = parsed.valuation.c;
    if (Array.isArray(packed)) {
      parsed.valuation.comps = packed.map(unpackComp).filter(Boolean);
      delete parsed.valuation.c;
    }
    return parsed as ReportPayload;
  } catch {
    return null;
  }
}
