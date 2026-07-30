import { ComparableSale, CompsProvider, Condition, LatLng, PropertyType, SubjectLookup, SubjectProperty } from "../types";
import { EsriFeature, esriQuery as sharedEsriQuery } from "./esri";

/**
 * District of Columbia comparable sales provider.
 *
 * DC publishes the richest public property data of any jurisdiction we cover:
 * bedrooms, bathrooms, gross building area, year built, stories, an assessor's
 * condition rating AND a construction grade — plus, uniquely, a flag saying
 * whether each sale was arm's-length.
 *
 * Two sources, joined on SSL (square-suffix-lot, DC's parcel identifier):
 *
 *   layer 40  Owner Polygons  spatial; sale price, sale date, assessed value
 *   table 25  RESIDENTIAL (CAMA)  building characteristics, qualified flag
 *
 * The spatial layer alone would produce a valuation — measured against
 * Maryland holdouts, assessed value carries about ten times the accuracy of
 * any physical field — but the CAMA join is cheap and DC's housing stock
 * (rowhouses of wildly varying size on identical lots) rewards knowing size.
 */

const BASE =
  "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer";
const OWNER_LAYER = `${BASE}/40/query`;
const CAMA_RESIDENTIAL = `${BASE}/25/query`;

const TIMEOUT_MS = 8_000;
/** Fire a second attempt once the first has stalled this long. */
const HEDGE_AFTER_MS = 2_500;
const MAX_RECORDS = 2000;
/**
 * Subject lookup widens only when containment finds nothing. 0 means "the
 * polygon containing this point" — see findSubjectParcel for why that has to
 * come first.
 */
const SUBJECT_SEARCH_LADDER = [0, 0.1];
/*
 * TWO RUNGS, NOT FOUR. Each rung is a sequential round trip against a service
 * that is occasionally slow, and the route's whole budget is 20s. A four-rung
 * ladder measured 12.1s in Frederick and timed out entirely in Silver Spring —
 * trading a wrong answer for no answer. Containment plus one widened fallback
 * keeps the correctness that matters and bounds the cost at two queries.
 */
/**
 * Enough that a widened rung ranks the true nearest parcel rather than the
 * nearest of an arbitrary page. DC packs 159-340 parcels into 0.1 miles; the
 * old value of 40 was well under that and silently returned the wrong house.
 */
const SUBJECT_SEARCH_RECORDS = 1000;
/**
 * Containment returns the one or two parcels under the point, so it needs no
 * large page — and asking for one costs time on a slow service.
 */
const CONTAINMENT_RECORDS = 25;
/**
 * SSLs per CAMA join query. Fairfax taught this lesson expensively: a 179-key
 * IN clause spent seven seconds in the query planner and timed out. Small
 * chunks in parallel are far faster than few large ones.
 */
const SSL_CHUNK = 75;

const SALES_FIELDS = ["SSL", "SALEPRICE", "SALEDATE"];
const CAMA_FIELDS = ["SSL", "GBA"];

export class DcSchemaError extends Error {
  constructor(readonly layer: string, readonly missing: string[], readonly present: string[]) {
    super(
      `DC ${layer} response is missing expected field(s): ${missing.join(", ")}. ` +
        `Fields present: ${present.join(", ")}`
    );
    this.name = "DcSchemaError";
  }
}

function assertFields(features: EsriFeature[], required: string[], layer: string): void {
  if (!features.length) return;
  const sample = features[0].attributes ?? {};
  const missing = required.filter(f => !(f in sample));
  if (missing.length) throw new DcSchemaError(layer, missing, Object.keys(sample));
}

/**
 * Query the DC service, hedging a second attempt when the first stalls.
 * See esri.ts; measured p90 here was 14.56s before hedging.
 */
async function esriQuery(url: string, params: Record<string, string>): Promise<EsriFeature[]> {
  return sharedEsriQuery({
    url,
    params,
    timeoutMs: TIMEOUT_MS,
    hedgeAfterMs: HEDGE_AFTER_MS,
    label: "DC DCGIS",
  });
}

/**
 * DC dates are epoch milliseconds, as in Fairfax — not YYYYMMDD as in Maryland.
 *
 * The magnitude check is the important part. A YYYYMMDD integer (max 21001231,
 * about 2.1e7) read as milliseconds lands in January 1970, which is a valid
 * date, so it would pass any year-range test and then be silently dropped by
 * the recency filter — data loss with no error anywhere. Real epoch-ms values
 * are at least 1e9 in magnitude, negative for sales before 1970, so requiring
 * that cleanly separates the two formats.
 */
export function parseDcDate(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 1e9) return undefined;
  const iso = new Date(n).toISOString().slice(0, 10);
  return iso >= "1900-01-01" && iso <= "2100-01-01" ? iso : undefined;
}

/** Timestamp literal for a WHERE clause against an esriFieldTypeDate column. */
function toDcTimestamp(d: Date): string {
  return `TIMESTAMP '${d.toISOString().slice(0, 10)} 00:00:00'`;
}

/**
 * DC's assessor condition rating, confirmed against 107,471 residential
 * records:
 *
 *   1 Poor 182 | 2 Fair 1,139 | 3 Average 47,757 | 4 Good 42,968
 *   5 Very Good 13,588 | 6 Excellent 1,830
 *
 * This is already a condition scale with "Average" in the middle, so unlike
 * Maryland's construction grade it maps almost one to one onto ours; only the
 * top two collapse.
 */
export function conditionFromCndtn(value: unknown): Condition | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n < 1 || n > 6) return undefined;
  return (n >= 5 ? 5 : n) as Condition;
}

/**
 * Property type from DC's PROPTYPE description.
 *
 * Matched on prefix rather than on USECODE, because the descriptions are
 * self-explaining and survive a renumbering of the code list. A rowhouse is
 * treated as a townhouse: in DC it is the dominant form and comparing one to a
 * detached house without the distinction would be badly wrong.
 */
export function propertyTypeFromProptype(value: unknown): PropertyType {
  const s = String(value ?? "").toLowerCase();
  if (!s) return "other";
  if (s.includes("condominium") || s.includes("condo")) return "condo";
  if (s.startsWith("residential-single family (row")) return "townhouse";
  if (s.startsWith("residential-single family (sem")) return "townhouse";
  if (s.startsWith("residential-single family")) return "single_family";
  if (s.startsWith("residential-conversion") || s.startsWith("residential-flats")) return "multi_family";
  if (s.startsWith("residential-multi-family") || s.startsWith("residential-apartment")) return "multi_family";
  if (s.startsWith("vacant")) return "land";
  return "other";
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[,$\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * PREMISEADD carries the whole address in one field:
 *
 *   "501 SEWARD SQUARE SE WASHINGTON DC 20003"
 *
 * Beside a report already headed with the subject's own city, and beside
 * Fairfax's "1205 Suffield Dr" and Maryland's "437 Winding Rose Dr", that tail
 * is noise on every row — and it is charged twice, because the shared report
 * packs these addresses into a URL with a length budget.
 *
 * Stripped HERE rather than in the presentation layer, because this is the one
 * place the format is known. A general "remove the city, state and ZIP" regex
 * was tried first and turned "7207 Statecrest Dr Silver Spring MD 20910" into
 * "7207" — truncating an address to its house number is a worse bug than the
 * noise it removes. DC is a single city, so the suffix is a fixed string.
 */
const DC_ADDRESS_TAIL = /\s+WASHINGTON\s+DC(\s+\d{5}(?:-\d{4})?)?\s*$/i;

export function streetAddress(value: unknown): string | undefined {
  const full = str(value);
  if (!full) return undefined;
  const street = full.replace(DC_ADDRESS_TAIL, "").trim();
  // Never reduce an address to nothing; a noisy row beats an empty one.
  return street.length >= 4 ? street : full;
}

function str(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s && s.toLowerCase() !== "null" ? s : undefined;
}

/**
 * Centroid of a polygon ring. Owner Polygons are parcel shapes, and the engine
 * measures distance between points, so each parcel is reduced to its middle.
 */
function ringCentroid(rings?: number[][][]): { lat: number; lng: number } | undefined {
  const ring = rings?.[0];
  if (!ring?.length) return undefined;
  let x = 0;
  let y = 0;
  let n = 0;
  for (const p of ring) {
    if (typeof p?.[0] === "number" && typeof p?.[1] === "number") {
      x += p[0];
      y += p[1];
      n++;
    }
  }
  return n ? { lat: y / n, lng: x / n } : undefined;
}

/** Characteristics from a joined CAMA row. */
interface Cama {
  sqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number;
  condition?: Condition;
  qualified?: boolean;
}

function camaFrom(a: Record<string, unknown>): Cama {
  // Half baths count as half a bathroom, which is how the market prices them.
  const full = num(a.BATHRM) ?? 0;
  const half = num(a.HF_BATHRM) ?? 0;
  const baths = full + half * 0.5;

  return {
    sqft: num(a.GBA),
    beds: num(a.BEDRM),
    baths: baths > 0 ? baths : undefined,
    // AYB is when the original structure was built; EYB is the effective year
    // after improvements. EYB is the better predictor of value, so prefer it.
    yearBuilt: num(a.EYB) ?? num(a.AYB),
    condition: conditionFromCndtn(a.CNDTN),
    // The flag is space-padded in the source: "Q        ".
    qualified: str(a.QUALIFIED)?.toUpperCase().startsWith("Q"),
  };
}

export interface DcOptions {
  /** Floor for sale price, to drop nominal conveyances. */
  minPrice?: number;
  /**
   * Keep only sales DC's assessor marked qualified (arm's-length).
   *
   * Uniquely among our sources, DC states this rather than leaving it to be
   * inferred, and it matters: 7,754 of 13,080 sales in a recent twelve-month
   * window were UNqualified — foreclosures, transfers between relatives, deeds
   * in lieu. Elsewhere the engine guesses at these from assessment ratios.
   */
  qualifiedOnly?: boolean;
}

export class DcProvider implements CompsProvider {
  readonly name = "dc-dcgis";

  constructor(private readonly opts: DcOptions = {}) {}

  /** Join building characteristics onto a set of parcels, in parallel chunks. */
  private async fetchCama(ssls: string[]): Promise<Map<string, Cama>> {
    const out = new Map<string, Cama>();
    if (!ssls.length) return out;

    const chunks: string[][] = [];
    for (let i = 0; i < ssls.length; i += SSL_CHUNK) chunks.push(ssls.slice(i, i + SSL_CHUNK));

    const results = await Promise.all(
      chunks.map(chunk =>
        esriQuery(CAMA_RESIDENTIAL, {
          // SSL values carry internal padding ("2832    0113"), so they must be
          // quoted verbatim rather than normalised.
          where: `SSL IN (${chunk.map(s => `'${s.replace(/'/g, "''")}'`).join(",")})`,
          outFields: "SSL,BEDRM,BATHRM,HF_BATHRM,GBA,AYB,EYB,STORIES,CNDTN,QUALIFIED",
          returnGeometry: "false",
          resultRecordCount: String(MAX_RECORDS),
        }).catch(() => [] as EsriFeature[])
      )
    );

    const flat = results.flat();
    assertFields(flat, CAMA_FIELDS, "RESIDENTIAL (CAMA)");
    for (const f of flat) {
      const ssl = str(f.attributes.SSL);
      if (ssl) out.set(ssl, camaFrom(f.attributes));
    }
    return out;
  }

  async fetchCandidates(
    subject: SubjectProperty,
    opts: { radiusMiles: number; lookbackMonths: number; limit?: number }
  ): Promise<ComparableSale[]> {
    const { minPrice = 50_000, qualifiedOnly = true } = this.opts;

    const since = new Date();
    since.setMonth(since.getMonth() - opts.lookbackMonths);
    const limit = Math.min(opts.limit ?? 200, MAX_RECORDS);

    const features = await esriQuery(OWNER_LAYER, {
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
      where: `SALEPRICE > ${minPrice} AND SALEDATE > ${toDcTimestamp(since)}`,
      outFields: "SSL,PREMISEADD,SALEPRICE,SALEDATE,NEWTOTAL,OLDTOTAL,LANDAREA,NBHDNAME,PROPTYPE",
      returnGeometry: "true",
      resultRecordCount: String(limit),
      // See the Fairfax provider: without an explicit order, a capped result
      // set silently loses the newest sales rather than the oldest.
      orderByFields: "SALEDATE DESC",
    });

    assertFields(features, SALES_FIELDS, "Owner Polygons");
    if (features.length >= limit) {
      console.warn(
        `[dc] sales query returned the full ${limit} requested at ` +
          `${opts.radiusMiles}mi — comps are the most recent ${limit}, but the pool is capped.`
      );
    }

    // One comp per parcel, keeping the most recent sale. Public record carries
    // re-recorded deeds; both Fairfax and Maryland showed the same defect.
    const latest = new Map<string, ComparableSale>();

    for (const f of features) {
      const a = f.attributes;
      const ssl = str(a.SSL);
      const soldPrice = num(a.SALEPRICE);
      const soldDate = parseDcDate(a.SALEDATE);
      const location = ringCentroid(f.geometry?.rings);

      if (!ssl || !soldPrice || !soldDate || !location) continue;

      const existing = latest.get(ssl);
      if (existing && existing.soldDate >= soldDate) continue;

      latest.set(ssl, {
        id: `${ssl}@${soldDate}`,
        address: streetAddress(a.PREMISEADD) ?? ssl,
        location,
        soldPrice,
        soldDate,
        propertyType: propertyTypeFromProptype(a.PROPTYPE),
        lotSqft: num(a.LANDAREA),
        subdivision: str(a.NBHDNAME),
        // NEWTOTAL is the assessment about to take effect, OLDTOTAL the one in
        // force. Prefer the current figure and fall back.
        assessedValue: num(a.NEWTOTAL) ?? num(a.OLDTOTAL),
      });
    }

    const cama = await this.fetchCama([...latest.keys()]);

    const out: ComparableSale[] = [];
    for (const [ssl, comp] of latest) {
      const c = cama.get(ssl);
      // Where the assessor says a sale was not arm's-length, believe them.
      if (qualifiedOnly && c && c.qualified === false) continue;
      out.push(
        c
          ? {
              ...comp,
              sqft: c.sqft,
              beds: c.beds,
              baths: c.baths,
              yearBuilt: c.yearBuilt,
              condition: c.condition,
            }
          : comp
      );
    }
    return out;
  }

  /**
   * Describe the subject from the parcel layer, which covers every property
   * rather than only those that have sold.
   *
   * No attribute filter on the spatial query: filtering a large parcel layer
   * by a non-indexed column makes the service abandon its spatial index. In
   * Maryland the identical query went from 1.0s to 10.9s that way, which was
   * enough to blow the request timeout on every address in the state.
   */
  /**
   * The parcel the homeowner is standing on — CONTAINMENT FIRST, then widening.
   *
   * THE BUG THIS REPLACES, because it is subtle and cost DC dearly.
   *
   * This used to be a single radius query at 0.1 miles asking for 40 features,
   * with no ordering, then a client-side pick of the nearest. In DC that radius
   * covers 159–340 parcels. ArcGIS returned an arbitrary 40 of them, and the
   * parcel the point actually sits in was usually not among the 40 — measured
   * at 9 of 10 sampled Capitol Hill properties resolving to a DIFFERENT house.
   *
   * Nothing failed. Every one produced a confident-looking subject with a
   * neighbour's living area, bedrooms, year built and assessment, up to 0.1
   * miles away. Every downstream number was then computed against the wrong
   * home: similarity scored on the wrong sqft, so worse comps; worse comps, so
   * higher dispersion; higher dispersion, so "low" confidence — and the
   * publish gate withheld 1 in 3 DC valuations entirely, in the jurisdiction
   * with the BEST measured accuracy.
   *
   * No backtest could have caught it. They all supply the subject from the
   * sales record and never call this at all.
   *
   * Omitting `distance` makes the point-in-polygon test the query rather than a
   * radius sweep, so the containing parcel is returned or nothing is. The
   * widening rungs are the genuine fallback — a geocoder that lands on the
   * street centreline — and they now request enough records that "nearest"
   * really is the nearest rather than the nearest of an arbitrary 40. Fairfax
   * has always done it this way; DC and Maryland did not.
   */
  private async findSubjectParcel(
    location: LatLng
  ): Promise<{ attributes: Record<string, unknown>; location: LatLng; exact: boolean } | null> {
    for (const distanceMiles of SUBJECT_SEARCH_LADDER) {
      const features = await esriQuery(OWNER_LAYER, {
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
        outFields: "SSL,PREMISEADD,SALEPRICE,SALEDATE,NEWTOTAL,OLDTOTAL,LANDAREA,NBHDNAME,PROPTYPE",
        returnGeometry: "true",
        resultRecordCount: String(distanceMiles > 0 ? SUBJECT_SEARCH_RECORDS : CONTAINMENT_RECORDS),
      });

      assertFields(features, ["SSL"], "Owner Polygons");

      let best: EsriFeature | undefined;
      let bestDistance = Infinity;
      let bestLocation: LatLng | undefined;

      for (const f of features) {
        const type = propertyTypeFromProptype(f.attributes.PROPTYPE);
        // Skip the commercial and vacant neighbours; we want the home.
        if (type === "other" || type === "land") continue;
        const c = ringCentroid(f.geometry?.rings);
        if (!c) continue;
        const d = (c.lng - location.lng) ** 2 + (c.lat - location.lat) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = f;
          bestLocation = c;
        }
      }

      // Only the containment rung (distance 0) describes the requested home.
      if (best && bestLocation) {
        return { attributes: best.attributes, location: bestLocation, exact: distanceMiles === 0 };
      }
    }
    return null;
  }

  async lookupSubject(
    location: LatLng
  ): Promise<SubjectLookup | null> {
    const found = await this.findSubjectParcel(location);
    if (!found) return null;
    const { attributes: a, location: bestLocation, exact } = found;

    const ssl = str(a.SSL);
    const cama = ssl ? (await this.fetchCama([ssl])).get(ssl) : undefined;

    return {
      location,
      propertyType: propertyTypeFromProptype(a.PROPTYPE),
      lotSqft: num(a.LANDAREA),
      subdivision: str(a.NBHDNAME),
      assessedValue: num(a.NEWTOTAL) ?? num(a.OLDTOTAL),
      sqft: cama?.sqft,
      beds: cama?.beds,
      baths: cama?.baths,
      yearBuilt: cama?.yearBuilt,
      condition: cama?.condition,
      lastSalePrice: num(a.SALEPRICE),
      lastSaleDate: parseDcDate(a.SALEDATE),
      exactParcel: exact,
    };
  }
}
