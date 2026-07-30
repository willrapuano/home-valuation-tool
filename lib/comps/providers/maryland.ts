import { ComparableSale, CompsProvider, Condition, LatLng, PropertyType, SubjectLookup, SubjectProperty } from "../types";
import { EsriFeature, esriQuery as sharedEsriQuery } from "./esri";

/**
 * Maryland STATEWIDE comparable sales provider.
 *
 * Covers all 24 Maryland jurisdictions through one integration — Montgomery,
 * Frederick, Howard, Anne Arundel, Baltimore City and County, and the rest.
 * Published by the Maryland Department of Planning from SDAT assessment data.
 *
 * Two layers, both statewide and both point geometry (so unlike DC no parcel
 * join is needed, and unlike Fairfax no polygon centroid):
 *
 *   MD_PropertySales/0   sold properties — price, date, characteristics
 *   MD_PropertyData/0    all parcels — characteristics, for the subject
 *
 * WHY THIS IS BETTER THAN THE FAIRFAX SOURCE:
 *
 * Fairfax publishes no building characteristics, so the engine substitutes
 * assessed value as a size-and-quality proxy. Maryland publishes living area,
 * lot acreage, year built and a structure grade, so the full appraisal-style
 * adjustment grid applies.
 *
 * That expectation did not survive measurement. Maryland runs at 8.7% median
 * error against Fairfax's 5.3% and DC's 4.5%, despite the richer data — see
 * docs/jurisdiction-data-sources.md, where an ablation shows the physical
 * fields are worth tenths of a point while the assessment is worth 3.1pp.
 *
 * PUBLISHING LAG: measured 2026-07-29, the newest sale anywhere in Maryland
 * was 2026-04-30, with none recorded for May, June or July — a ~90 day lag,
 * against 10 days for DC and Fairfax. Comps here are always about a quarter
 * stale. The engine time-adjusts them forward with locally-measured
 * appreciation, so this is compensated rather than ignored, but extrapolating
 * that far adds error and is part of why Maryland trails.
 */

const BASE = "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre";
const SALES_LAYER = `${BASE}/MD_PropertySales/MapServer/0/query`;
const PARCEL_LAYER = `${BASE}/MD_PropertyData/MapServer/0/query`;

const TIMEOUT_MS = 8_000;
/** Fire a second attempt once the first has stalled this long. */
const HEDGE_AFTER_MS = 2_500;
const MAX_RECORDS = 2000;
/** Widest search for the subject parcel, in miles. */
/**
 * Subject lookup widens only when containment finds nothing; 0 means "the
 * parcel containing this point". See lookupSubject for why that must come
 * first — a plain radius query returns an arbitrary page of neighbours and
 * silently describes the wrong house.
 */
const SUBJECT_SEARCH_LADDER = [0, 0.1];
/*
 * TWO RUNGS, NOT FOUR. Each rung is a sequential round trip against a service
 * that is occasionally slow, and the route's whole budget is 20s. A four-rung
 * ladder measured 12.1s in Frederick and timed out entirely in Silver Spring —
 * trading a wrong answer for no answer. Containment plus one widened fallback
 * keeps the correctness that matters and bounds the cost at two queries.
 */
/** Enough that a widened rung ranks the true nearest parcel, not a page of 40. */
const SUBJECT_SEARCH_RECORDS = 1000;
/**
 * Containment returns the one or two parcels under the point, so it needs no
 * large page — and asking for one costs time on a slow service.
 */
const CONTAINMENT_RECORDS = 25;

/**
 * Maryland land use codes, confirmed against a 541-record Bethesda sample:
 * R 481, U 40, C 15, E 3, M 1, CR 1.
 *
 * Anything unmapped becomes "other", which the engine treats as comparable
 * only to itself — so an unrecognised code is excluded rather than silently
 * valued as a house.
 */
const LAND_USE: Record<string, PropertyType> = {
  R: "single_family",
  U: "condo",
  TH: "townhouse",
  M: "multi_family",
};

const SALES_FIELDS = ["ACCTID", "TRADATE", "CONSIDR1", "LU"];
const PARCEL_FIELDS = ["ACCTID", "SQFTSTRC", "YEARBLT"];

export class MarylandSchemaError extends Error {
  constructor(readonly layer: string, readonly missing: string[], readonly present: string[]) {
    super(
      `Maryland ${layer} response is missing expected field(s): ${missing.join(", ")}. ` +
        `Fields present: ${present.join(", ")}`
    );
    this.name = "MarylandSchemaError";
  }
}

function assertFields(features: EsriFeature[], required: string[], layer: string): void {
  if (!features.length) return;
  const sample = features[0].attributes ?? {};
  const missing = required.filter(f => !(f in sample));
  if (missing.length) throw new MarylandSchemaError(layer, missing, Object.keys(sample));
}

/**
 * Query the Maryland service, hedging a second attempt when the first stalls.
 * See esri.ts — the previous serial retry meant a stalled request cost the
 * full 8s timeout before the attempt that answered even began.
 */
async function esriQuery(url: string, params: Record<string, string>): Promise<EsriFeature[]> {
  return sharedEsriQuery({
    url,
    params,
    timeoutMs: TIMEOUT_MS,
    hedgeAfterMs: HEDGE_AFTER_MS,
    label: "Maryland iMAP",
  });
}

/**
 * Maryland stores dates as a YYYYMMDD integer, not epoch milliseconds as
 * Fairfax does. Getting this wrong silently produces 1970 dates, which the
 * recency filter would then reject as ancient.
 */
export function parseMdDate(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n < 19000101 || n > 21001231) return undefined;
  const s = String(Math.trunc(n));
  if (s.length !== 8) return undefined;
  const [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${y}-${m}-${d}`;
}

/**
 * YYYYMMDD for a WHERE clause against TRADATE.
 *
 * TRADATE is a STRING field, so the literal must be quoted — an unquoted
 * numeric comparison makes the service reject the whole query with a bare
 * "Unable to complete operation". Lexicographic comparison is correct for
 * this format.
 */
function toMdDateLiteral(d: Date): string {
  return `'${d.toISOString().slice(0, 10).replace(/-/g, "")}'`;
}

/**
 * Maryland's structure grade is a construction-quality rating, higher being
 * better. Measured against 660 graded Bethesda sales the observed range is
 * 3–9, with grade 5 the mode:
 *
 *   3:1   4:39   5:290   6:153   7:97   8:51   9:29
 *
 * The engine's condition scale is 1–5 with 3 as average, so grade 5 has to
 * land on 3. An earlier version of this mapping assumed a 1–13 scale and put
 * everything at or below grade 4 on condition 1; in the cheaper markets, where
 * grades 3–4 dominate, that collapsed most of the pool onto a single value and
 * threw away the dimension's ability to discriminate.
 */
export function gradeToCondition(value: unknown): Condition | undefined {
  const g = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(g) || g <= 0) return undefined;
  if (g <= 3) return 1;
  if (g === 4) return 2;
  if (g === 5) return 3;
  if (g <= 7) return 4;
  return 5;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[,$\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function str(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s && s.toLowerCase() !== "null" ? s : undefined;
}

const ACRES_TO_SQFT = 43_560;

/** Shared attribute mapping — the two layers use the same column names. */
function characteristics(a: Record<string, unknown>) {
  const acres = num(a.ACRES);
  return {
    propertyType: LAND_USE[str(a.LU)?.toUpperCase() ?? ""] ?? "other",
    sqft: num(a.SQFTSTRC),
    lotSqft: acres ? Math.round(acres * ACRES_TO_SQFT) : undefined,
    yearBuilt: num(a.YEARBLT),
    subdivision: str(a.SUBDIVSN),
    condition: gradeToCondition(a.STRUGRAD),
    // The two layers name the same number differently: the sales layer
    // publishes CURTTLVL ("Current Total Value"), the parcel layer NFMTTLVL
    // ("New Appraised Full Value"). Maryland phases assessment increases in
    // over three years, so these could easily have been the phased and the
    // full figure — joining 581 accounts across both layers puts their ratio
    // at exactly 1.000 at the quartiles, so they are interchangeable.
    assessedValue: num(a.CURTTLVL) ?? num(a.NFMTTLVL),
    zipCode: str(a.ZIPCODE)?.slice(0, 5),
  };
}

export interface MarylandOptions {
  /** Floor for sale price, to drop nominal conveyances. */
  minPrice?: number;
}

export class MarylandProvider implements CompsProvider {
  readonly name = "maryland-sdat";

  constructor(private readonly opts: MarylandOptions = {}) {}

  async fetchCandidates(
    subject: SubjectProperty,
    opts: { radiusMiles: number; lookbackMonths: number; limit?: number }
  ): Promise<ComparableSale[]> {
    const { minPrice = 50_000 } = this.opts;

    const since = new Date();
    since.setMonth(since.getMonth() - opts.lookbackMonths);

    const limit = Math.min(opts.limit ?? 200, MAX_RECORDS);
    const residential = Object.keys(LAND_USE).map(c => `'${c}'`).join(",");
    const where = [
      `CONSIDR1 > ${minPrice}`,
      `TRADATE > ${toMdDateLiteral(since)}`,
      `LU IN (${residential})`,
    ].join(" AND ");

    const features = await esriQuery(SALES_LAYER, {
      geometry: JSON.stringify({
        x: subject.location.lng,
        y: subject.location.lat,
        spatialReference: { wkid: 4326 },
      }),
      geometryType: "esriGeometryPoint",
      distance: String(opts.radiusMiles),
      units: "esriSRUnit_StatuteMile",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      where,
      outFields:
        "ACCTID,ADDRESS,TRADATE,CONSIDR1,CURTTLVL,SQFTSTRC,YEARBLT,ACRES,SUBDIVSN,STRUGRAD,LU,ZIPCODE",
      returnGeometry: "true",
      resultRecordCount: String(limit),
      // Truncation must cost us the OLDEST sales, not the newest. Without an
      // explicit order the service returns an arbitrary subset when more
      // records match than were requested, and in Fairfax that was measured
      // dropping every sale from the most recent seven months.
      orderByFields: "TRADATE DESC",
    });

    assertFields(features, SALES_FIELDS, "MD_PropertySales");
    if (features.length >= limit) {
      console.warn(
        `[maryland] sales query returned the full ${limit} requested at ` +
          `${opts.radiusMiles}mi — comps are the most recent ${limit}, but the pool is capped.`
      );
    }

    // One comp per account, keeping the most recent sale — public record
    // carries re-recorded deeds, the same defect seen in Fairfax.
    const latest = new Map<string, ComparableSale>();

    for (const f of features) {
      const a = f.attributes;
      const acct = str(a.ACCTID);
      const soldPrice = num(a.CONSIDR1);
      const soldDate = parseMdDate(a.TRADATE);
      const lat = f.geometry?.y;
      const lng = f.geometry?.x;

      if (!acct || !soldPrice || !soldDate || lat === undefined || lng === undefined) continue;

      const existing = latest.get(acct);
      if (existing && existing.soldDate >= soldDate) continue;

      latest.set(acct, {
        id: `${acct}@${soldDate}`,
        address: str(a.ADDRESS) ?? acct,
        location: { lat, lng },
        soldPrice,
        soldDate,
        ...characteristics(a),
      });
    }

    return [...latest.values()];
  }

  /**
   * Describe the subject from the statewide parcel layer, which covers all
   * properties rather than only those that have sold.
   *
   * Searches a single wide radius and picks the nearest parcel, rather than
   * widening in stages. Staged widening cost up to three sequential round
   * trips — a 24-second worst case on a service that throttles under load —
   * and was also subtly wrong: it returned an arbitrary parcel from the
   * smallest radius that matched any, not the closest one. The radius is wide
   * because a geocoded address often lands on the road centreline rather than
   * on the parcel point.
   *
   * NOTE: no `where` clause. The parcel layer holds every parcel in Maryland
   * and has no index on land use, so adding `LU IN (...)` makes the service
   * evaluate the filter instead of using its spatial index — measured at 10.9
   * seconds against 1.0 second for the identical query without it, which was
   * enough to blow the request timeout on every Maryland address. Land use is
   * filtered client-side instead, on the rows we actually get back.
   *
   * CONTAINMENT FIRST. This used to be one radius query at 0.1 miles asking for
   * 40 records with no ordering, then a client-side pick of the nearest. That
   * returns an arbitrary page of whatever is near, and the parcel the point
   * actually sits in need not be in it — measured in DC, which shares the
   * pattern, at 9 of 10 properties resolving to a DIFFERENT house, with a
   * neighbour's living area, year built and assessment. Nothing errors; the
   * valuation is simply computed for the wrong home.
   *
   * Omitting `distance` makes the query a point-in-polygon test, so the
   * containing parcel comes back or nothing does. The wider rungs are the real
   * fallback — a geocode landing on the street centreline — and they request
   * enough records that "nearest" is genuinely the nearest.
   */
  async lookupSubject(
    location: LatLng
  ): Promise<SubjectLookup | null> {
    for (const distanceMiles of SUBJECT_SEARCH_LADDER) {
    const features = await esriQuery(PARCEL_LAYER, {
      geometry: JSON.stringify({
        x: location.lng,
        y: location.lat,
        spatialReference: { wkid: 4326 },
      }),
      geometryType: "esriGeometryPoint",
      ...(distanceMiles > 0
        ? { distance: String(distanceMiles), units: "esriSRUnit_StatuteMile" }
        : {}),
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      // NFMTTLVL is the subject's assessed value on THIS layer (the sales
      // layer calls the same number CURTTLVL), and it is the single most
      // valuable field here: measured against 300 Maryland holdout sales,
      // valuing on the assessment basis rather than the physical grid moved
      // median error from 11.4% to 8.7%. Omitting it from this list silently
      // demoted every Maryland valuation to the weaker basis, because the
      // comps carried assessments and the subject did not.
      outFields:
        "ACCTID,ADDRESS,SQFTSTRC,YEARBLT,ACRES,SUBDIVSN,STRUGRAD,LU,ZIPCODE,TRADATE,CONSIDR1,NFMTTLVL",
      returnGeometry: "true",
      resultRecordCount: String(distanceMiles > 0 ? SUBJECT_SEARCH_RECORDS : CONTAINMENT_RECORDS),
    });

    assertFields(features, PARCEL_FIELDS, "MD_PropertyData");

    let best: EsriFeature | undefined;
    let bestDistance = Infinity;
    for (const f of features) {
      const x = f.geometry?.x;
      const y = f.geometry?.y;
      if (x === undefined || y === undefined) continue;
      // Skip commercial and industrial neighbours; we want the house.
      if (!LAND_USE[str(f.attributes?.LU)?.toUpperCase() ?? ""]) continue;
      // Squared degrees is enough to rank candidates within a tenth of a mile.
      const d = (x - location.lng) ** 2 + (y - location.lat) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = f;
      }
    }

    const a = best?.attributes;
    if (!a) continue;

    return {
      location,
      ...characteristics(a),
      lastSalePrice: num(a.CONSIDR1),
      lastSaleDate: parseMdDate(a.TRADATE),
      // Only the containment rung describes the requested home; a widened
      // rung found a neighbour, which is fine for picking comps and wrong to
      // print back as facts about this house.
      exactParcel: distanceMiles === 0,
    };
    }
    return null;
  }
}
