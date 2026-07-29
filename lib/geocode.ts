/**
 * Batch address → coordinates, via the Census Bureau's geocoder.
 *
 * WHY THIS EXISTS
 *
 * TitlePro247 exports carry a site address but NO latitude or longitude — only
 * `distanceFeet` from the search centre, which fixes a radius and not a
 * position, so it cannot produce the pairwise distances the engine scores on or
 * the geography the PostGIS index is built over. Coordinates have to come from
 * somewhere, and that somewhere is here.
 *
 * WHY THE CENSUS GEOCODER
 *
 * It is free, needs no API key, and is built for exactly this shape of job:
 * upload a CSV of up to 10,000 addresses, get coordinates back. Google's
 * geocoder would work and is already keyed in this project for Street View,
 * but it bills per address, and an ingest of two counties' recent sales is
 * thousands of lookups that would recur on every refresh.
 *
 * MEASURED MATCH RATE: 11 of 12 (92%) on real Arlington and Loudoun street
 * addresses — the two jurisdictions this exists to serve. So roughly one sale
 * in twelve is lost from an ingest. That is a real cost and it is why
 * `geocodeAll` returns the unmatched ids rather than only the hits: an ingest
 * that quietly placed 92% of a county would look indistinguishable from a
 * small county.
 *
 * If that rate ever proves too lossy, Google's geocoder is already keyed in
 * this project for Street View and would backfill only the misses — a few
 * hundred paid lookups per ingest rather than thousands.
 *
 * This runs at INGEST time, never in a request path. A homeowner waiting on a
 * valuation must never be waiting on a geocoder.
 */
import { LatLng } from "./comps/types";

const ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
/** The service's documented ceiling per upload. */
const MAX_BATCH = 10_000;
/** Batches are large and the service is slow; this is not a request path. */
const TIMEOUT_MS = 300_000;

export interface GeocodeInput {
  /** Caller's own key, returned alongside the result so rows can be rejoined. */
  id: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface GeocodeOutcome {
  matched: Map<string, LatLng>;
  /** Ids the geocoder could not place, for the caller to report rather than drop silently. */
  unmatched: string[];
}

/** A field containing a comma would shift every column after it. */
function csvCell(value: string): string {
  const clean = value.replace(/["\r\n]/g, " ").trim();
  return clean.includes(",") ? `"${clean}"` : clean;
}

/**
 * The response is CSV with quoted fields, one row per input:
 *   "id","input address","Match","Exact","matched address","lng,lat","tiger","L"
 *
 * Note the coordinate pair is LONGITUDE FIRST — the opposite order to every
 * other coordinate in this codebase, and a silent 30-degree error if assumed.
 */
export function parseGeocodeResponse(body: string): GeocodeOutcome {
  const matched = new Map<string, LatLng>();
  const unmatched: string[] = [];

  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const id = cells[0];
    if (!id) continue;

    if (cells[2] !== "Match") {
      unmatched.push(id);
      continue;
    }

    const [lngRaw, latRaw] = (cells[5] ?? "").split(",");
    // Number("") is 0, not NaN — so an empty coordinate would sail through as
    // a perfectly valid-looking point at 0°,0°, which is in the Gulf of
    // Guinea. Check for content before converting.
    const lng = lngRaw?.trim() ? Number(lngRaw) : NaN;
    const lat = latRaw?.trim() ? Number(latRaw) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      unmatched.push(id);
      continue;
    }
    matched.set(id, { lat, lng });
  }

  return { matched, unmatched };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is one literal quote.
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function geocodeBatch(rows: GeocodeInput[]): Promise<GeocodeOutcome> {
  const csv = rows
    .map(r => [r.id, r.street, r.city, r.state, r.zip].map(csvCell).join(","))
    .join("\n");

  const form = new FormData();
  form.append("addressFile", new Blob([csv], { type: "text/csv" }), "addresses.csv");
  form.append("benchmark", "Public_AR_Current");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { method: "POST", body: form, signal: controller.signal });
    if (!res.ok) throw new Error(`Census geocoder returned HTTP ${res.status}`);
    return parseGeocodeResponse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode any number of addresses, in batches.
 *
 * A failed batch is reported as unmatched rather than thrown: losing a tenth of
 * an ingest is recoverable and visible, whereas aborting the whole run over one
 * bad batch means nothing lands at all.
 */
export async function geocodeAll(
  rows: GeocodeInput[],
  onProgress?: (done: number, total: number) => void
): Promise<GeocodeOutcome> {
  const matched = new Map<string, LatLng>();
  const unmatched: string[] = [];

  for (let i = 0; i < rows.length; i += MAX_BATCH) {
    const slice = rows.slice(i, i + MAX_BATCH);
    try {
      const out = await geocodeBatch(slice);
      out.matched.forEach((v, k) => matched.set(k, v));
      unmatched.push(...out.unmatched);
    } catch (err) {
      console.warn(`  ! geocode batch failed (${(err as Error)?.message}) — ${slice.length} rows unplaced`);
      unmatched.push(...slice.map(r => r.id));
    }
    onProgress?.(Math.min(i + MAX_BATCH, rows.length), rows.length);
  }

  return { matched, unmatched };
}
