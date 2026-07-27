import { ComparableSale, CompsProvider, LatLng, PropertyType, SubjectProperty } from "../types";

/**
 * Fairfax County, VA comparable sales provider.
 *
 * Sources two public ArcGIS REST layers and joins them on parcel PIN:
 *   - GIS/ParcelPlusSales           — sale date, price, sale-validity code
 *   - GIS/ParcelPlusAssessedValues  — total assessed value, land use code
 *
 * No API key, no authentication, no licence restriction on redistribution —
 * this is county public record.
 *
 * IMPORTANT LIMITATION: Fairfax does not publish building characteristics
 * (living area, bedrooms, bathrooms, year built) through these endpoints;
 * those sit behind their CPAN/iCare system. So comps carry no sqft.
 *
 * The assessed value stands in for it, and does so well: Virginia requires
 * assessment at 100% of fair market value, and an assessment already prices
 * size, quality, condition and lot together — produced by someone who has
 * actually looked at the property. The engine uses it as both a similarity
 * dimension and the adjustment basis.
 */

const BASE = "https://www.fairfaxcounty.gov/mercator/rest/services/GIS";
const SALES_LAYER = `${BASE}/ParcelPlusSales/MapServer/0/query`;
const ASSESSED_LAYER = `${BASE}/ParcelPlusAssessedValues/MapServer/0/query`;

// Kept well under the API route's own budget: the county service is
// occasionally slow, and a long hang here burns the whole request.
const TIMEOUT_MS = 7_000;
/** The service caps a single response at 2000 features. */
const MAX_RECORDS = 2000;

/**
 * Fairfax land use codes. 011 is overwhelmingly dominant in detached
 * neighbourhoods (367 of 446 parcels in a McLean sample).
 *
 * Anything unmapped becomes "other", which the engine treats as comparable
 * only to itself — so an unrecognised code is excluded rather than silently
 * valued as a house. Add codes here as they are confirmed.
 */
const LAND_USE: Record<string, PropertyType> = {
  "011": "single_family",
  "012": "single_family",
  "013": "single_family",
  "021": "townhouse",
  "022": "townhouse",
  "031": "condo",
  "041": "condo",
};

export interface FairfaxOptions {
  /**
   * Exclude sales whose validity description doesn't indicate an
   * arm's-length transfer. Public record includes family transfers, deeds in
   * lieu, and $1 conveyances, none of which are evidence of market value.
   */
  requireValidSale?: boolean;
  /** Exclude multi-parcel transfers — the price covers more than one property. */
  excludeMultiParcel?: boolean;
  /** Floor for sale price, to drop nominal conveyances. */
  minPrice?: number;
}

interface EsriFeature {
  attributes: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
}

/**
 * Query an ArcGIS layer.
 *
 * POSTs rather than GETs: a `PIN IN (...)` clause covering a few hundred
 * parcels overruns the server's URL length limit, and it responds with an
 * HTML error page rather than JSON. POST has no such ceiling.
 */
async function esriQuery(
  url: string,
  params: Record<string, string>
): Promise<EsriFeature[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ f: "json", ...params }).toString(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Fairfax GIS returned HTTP ${res.status}`);

    // A too-long or malformed request comes back as an HTML error page.
    const text = await res.text();
    let data: { error?: { message?: string }; features?: EsriFeature[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Fairfax GIS returned a non-JSON response");
    }

    if (data?.error) {
      throw new Error(`Fairfax GIS error: ${data.error.message ?? "unknown"}`);
    }
    return data?.features ?? [];
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error(`Fairfax GIS request timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Area-weighted centroid of a polygon's outer ring. */
export function ringCentroid(rings?: number[][][]): LatLng | null {
  const ring = rings?.[0];
  if (!ring || ring.length < 3) return null;

  let twiceArea = 0;
  let x = 0;
  let y = 0;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }

  // Degenerate ring (zero area) — fall back to the vertex mean.
  if (twiceArea === 0) {
    const mean = ring.reduce((acc, [px, py]) => [acc[0] + px, acc[1] + py], [0, 0]);
    return { lng: mean[0] / ring.length, lat: mean[1] / ring.length };
  }

  const factor = 1 / (3 * twiceArea);
  return { lng: x * factor, lat: y * factor };
}

function toDate(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** ArcGIS date literal, which must be `DATE 'YYYY-MM-DD'`. */
function esriDate(d: Date): string {
  return `DATE '${d.toISOString().slice(0, 10)}'`;
}

export class FairfaxCountyProvider implements CompsProvider {
  readonly name = "fairfax-county";

  constructor(private readonly opts: FairfaxOptions = {}) {}

  async fetchCandidates(
    subject: SubjectProperty,
    opts: { radiusMiles: number; lookbackMonths: number; limit?: number }
  ): Promise<ComparableSale[]> {
    const {
      requireValidSale = true,
      excludeMultiParcel = true,
      minPrice = 50_000,
    } = this.opts;

    const since = new Date();
    since.setMonth(since.getMonth() - opts.lookbackMonths);

    const where = [
      `PRICE > ${minPrice}`,
      `SALEDT > ${esriDate(since)}`,
      excludeMultiParcel ? "(NOPAR IS NULL OR NOPAR <= 1)" : null,
    ].filter(Boolean).join(" AND ");

    const geometry = JSON.stringify({
      x: subject.location.lng,
      y: subject.location.lat,
      spatialReference: { wkid: 4326 },
    });

    const spatial = {
      geometry,
      geometryType: "esriGeometryPoint",
      distance: String(opts.radiusMiles),
      units: "esriSRUnit_StatuteMile",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      resultRecordCount: String(Math.min(opts.limit ?? 200, MAX_RECORDS)),
    };

    const sales = await esriQuery(SALES_LAYER, {
      ...spatial,
      where,
      outFields: "PIN,SALEDT,PRICE,SALEVAL_DESC,SALETYPE_DESC,NOPAR",
      returnGeometry: "true",
    });

    if (!sales.length) return [];

    // Assessed values come from a second layer, joined on PIN.
    //
    // Query by PIN rather than over the same footprint: a 1.5-mile radius in
    // Fairfax contains far more parcels than the service's 2000-record cap,
    // so a spatial fetch silently truncates and most sales end up with no
    // land use code — which then reads as "property type other" and gets
    // every one of them rejected. Asking for exactly the PINs we need is
    // both complete and smaller.
    const pins = [...new Set(
      sales.map(f => String(f.attributes.PIN ?? "").trim()).filter(Boolean)
    )];
    const byPin = await this.fetchAssessed(pins);

    // One comp per parcel, keeping the most recent sale.
    //
    // Public record routinely carries the same transaction twice — an
    // original deed plus a correction or re-recording a few days later. Both
    // rows have the same price, so keying on parcel+date lets a single sale
    // through twice and hands it double weight in the reconciliation.
    const latestByPin = new Map<string, ComparableSale>();

    for (const f of sales) {
      const a = f.attributes;
      const pin = String(a.PIN ?? "").trim();
      const price = typeof a.PRICE === "number" ? a.PRICE : undefined;
      const soldDate = toDate(a.SALEDT);
      const location = ringCentroid(f.geometry?.rings);

      if (!pin || !price || !soldDate || !location) continue;

      if (requireValidSale) {
        const validity = String(a.SALEVAL_DESC ?? "").toLowerCase();
        // Public record includes family transfers and nominal conveyances,
        // which are not evidence of market value.
        if (!validity.includes("valid")) continue;
        if (excludeMultiParcel && validity.includes("multi-parcel")) continue;
      }

      const existing = latestByPin.get(pin);
      if (existing && existing.soldDate >= soldDate) continue;

      const extra = byPin.get(pin);

      latestByPin.set(pin, {
        id: `${pin}@${soldDate}`,
        address: pin, // Fairfax's sales layer carries no situs address.
        location,
        propertyType: LAND_USE[extra?.luc ?? ""] ?? "other",
        soldPrice: price,
        soldDate,
        assessedValue: extra?.assessed,
      });
    }

    return [...latestByPin.values()];
  }

  /**
   * Assessed value and land use for a specific set of parcels, chunked so no
   * single request builds an unreasonable URL.
   */
  private async fetchAssessed(
    pins: string[]
  ): Promise<Map<string, { luc?: string; assessed?: number }>> {
    const byPin = new Map<string, { luc?: string; assessed?: number }>();

    // Chunks run concurrently. Sequentially, a dense area with several hundred
    // sales needed enough round trips to blow the request budget entirely.
    //
    // Kept small: the server evaluates a `PIN IN (...)` clause slowly, and a
    // single 179-value clause timed out at 7s. Several small clauses in
    // parallel are far quicker than one large one.
    const CHUNK = 50;
    const chunks: string[][] = [];
    for (let i = 0; i < pins.length; i += CHUNK) chunks.push(pins.slice(i, i + CHUNK));

    const results = await Promise.all(
      chunks.map(chunk => {
        // PINs contain spaces, so they must be quoted literals.
        const where = `PIN IN (${chunk.map(p => `'${p.replace(/'/g, "''")}'`).join(",")})`;

        // Don't swallow this silently. A failure here leaves every parcel in
        // the chunk without a land use code, which the engine then rejects as
        // an incomparable property type — losing most of the comp pool while
        // looking like a legitimate filtering decision.
        return esriQuery(ASSESSED_LAYER, {
          where,
          outFields: "PIN,LUC,APRTOT",
          returnGeometry: "false",
          resultRecordCount: String(MAX_RECORDS),
        }).catch(err => {
          console.warn(`[fairfax] assessed-value lookup failed for ${chunk.length} parcels: ${err.message}`);
          return [] as EsriFeature[];
        });
      })
    );

    for (const f of results.flat()) {
      const pin = String(f.attributes.PIN ?? "").trim();
      if (!pin) continue;
      byPin.set(pin, {
        luc: f.attributes.LUC ? String(f.attributes.LUC).trim() : undefined,
        assessed: typeof f.attributes.APRTOT === "number" ? f.attributes.APRTOT : undefined,
      });
    }

    return byPin;
  }

  /**
   * Total assessed value and land use for one parcel, to describe the subject.
   *
   * A geocoded address often lands on the road centreline rather than inside
   * the parcel polygon, so an exact point intersect misses. Widen the search
   * until a parcel is found instead of reporting the property as unknown.
   */
  async lookupSubject(location: LatLng): Promise<Partial<SubjectProperty> | null> {
    const geometry = JSON.stringify({
      x: location.lng,
      y: location.lat,
      spatialReference: { wkid: 4326 },
    });

    // Restricted to residential land use codes. Widening the search from a
    // geocoded point will otherwise happily return the office block or
    // shopping centre next door, and the engine then finds nothing
    // comparable — a confusing failure that looks like missing data.
    const residentialCodes = Object.keys(LAND_USE)
      .map(c => `'${c}'`)
      .join(",");

    for (const distanceMiles of [0, 0.02, 0.05, 0.1]) {
      const features = await esriQuery(ASSESSED_LAYER, {
        geometry,
        geometryType: "esriGeometryPoint",
        spatialRel: "esriSpatialRelIntersects",
        ...(distanceMiles > 0
          ? { distance: String(distanceMiles), units: "esriSRUnit_StatuteMile" }
          : {}),
        inSR: "4326",
        outSR: "4326",
        where: `LUC IN (${residentialCodes})`,
        outFields: "PIN,LUC,APRTOT",
        returnGeometry: "false",
        resultRecordCount: "1",
      });
      if (features[0]) return this.toSubject(features[0].attributes, location);
    }
    return null;
  }

  private toSubject(a: Record<string, unknown>, location: LatLng): Partial<SubjectProperty> {

    return {
      location,
      propertyType: LAND_USE[String(a.LUC ?? "").trim()] ?? "other",
      assessedValue: typeof a.APRTOT === "number" ? a.APRTOT : undefined,
    };
  }
}
