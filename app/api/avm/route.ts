import { NextRequest, NextResponse } from "next/server";

/* ──────────────────────────────────────────────────────────────
   Upstream valuation service.

   NOTE: this is currently the weak link in the whole tool. It must
   point at a STABLE hostname. A `*.trycloudflare.com` Quick Tunnel
   gets a fresh random URL on every restart, so when the tunnel drops
   the tool silently degrades to the ZIP table below and nobody finds
   out. Use a named Cloudflare tunnel or a hosted API.
────────────────────────────────────────────────────────────────── */
const VALUATION_API_URL = process.env.VALUATION_API_URL || "";
const VALUATION_API_KEY = process.env.VALUATION_API_KEY || "";

const UPSTREAM_TIMEOUT_MS = 8000;
const SIDECAR_TIMEOUT_MS = 4000;

/** Fetch with a hard timeout so a dead upstream can't hold the function open. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = SIDECAR_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ── HUD Fair Market Rents ─────────────────────────────────────── */

const NOVA_FMR_DEFAULT = { studio: 2050, oneBr: 2080, twoBr: 2370, threeBr: 2960, fourBr: 3540 };

/**
 * State → representative county FIPS for HUD FMR lookups.
 * Format is <2-digit state><3-digit county>99999.
 * VA 51 / Fairfax 059, MD 24 / Montgomery 031, DC 11 / 001.
 * This is deliberately coarse — it covers the NoVA/DC metro only.
 */
const STATE_FMR_FIPS: Record<string, string> = {
  VA: "5105999999",
  MD: "2403199999",
  DC: "1100199999",
};

async function fetchHudFMR(zip: string, state: string): Promise<typeof NOVA_FMR_DEFAULT> {
  const HUD_TOKEN = process.env.HUD_API_TOKEN;
  if (!HUD_TOKEN) return NOVA_FMR_DEFAULT;
  const fips = STATE_FMR_FIPS[state?.toUpperCase()] || STATE_FMR_FIPS["VA"];
  try {
    const res = await fetchWithTimeout(`https://www.huduser.gov/hudapi/public/fmr/data/${fips}`, {
      headers: { Authorization: `Bearer ${HUD_TOKEN}` },
    });
    if (!res.ok) return NOVA_FMR_DEFAULT;
    const data = await res.json();
    const zipData =
      data?.data?.basicdata?.find((d: Record<string, unknown>) => d.zip_code === zip) ||
      data?.data?.basicdata?.[0]; // MSA level fallback
    if (!zipData) return NOVA_FMR_DEFAULT;
    return {
      studio: zipData["Efficiency"] || NOVA_FMR_DEFAULT.studio,
      oneBr: zipData["One-Bedroom"] || NOVA_FMR_DEFAULT.oneBr,
      twoBr: zipData["Two-Bedroom"] || NOVA_FMR_DEFAULT.twoBr,
      threeBr: zipData["Three-Bedroom"] || NOVA_FMR_DEFAULT.threeBr,
      fourBr: zipData["Four-Bedroom"] || NOVA_FMR_DEFAULT.fourBr,
    };
  } catch {
    return NOVA_FMR_DEFAULT;
  }
}

/* ── Census ACS median household income ────────────────────────── */

/**
 * The Census data API now requires a key on every request — unkeyed calls
 * return an HTML "Missing Key" page with a 200 status, which is why this
 * silently returned null before. Without CENSUS_API_KEY set we skip the
 * call entirely rather than parsing HTML as JSON.
 */
async function fetchZipMedianIncome(zip: string): Promise<number | null> {
  const CENSUS_KEY = process.env.CENSUS_API_KEY;
  if (!CENSUS_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `https://api.census.gov/data/2023/acs/acs5?get=NAME,B19013_001E` +
        `&for=zip%20code%20tabulation%20area:${encodeURIComponent(zip)}&key=${CENSUS_KEY}`
    );
    if (!res.ok) return null;
    // Guard against the HTML error pages Census serves with a 200.
    if (!res.headers.get("content-type")?.includes("json")) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 1) {
      const income = parseInt(data[1][1], 10);
      return Number.isFinite(income) && income > 0 ? income : null;
    }
    return null;
  } catch {
    return null;
  }
}

/* ── Street View ───────────────────────────────────────────────── */

/**
 * Points at our own proxy rather than maps.googleapis.com so the API key
 * is never shipped to the browser and the response can be cached.
 */
function buildStreetViewUrl(address: string, lat?: number, lng?: number): string {
  const location = lat && lng ? `${lat},${lng}` : address;
  return `/api/streetview?location=${encodeURIComponent(location)}`;
}

/* ── ZIP fallback ──────────────────────────────────────────────── */

const ZIP_ESTIMATES: Record<string, number> = {
  "22101": 1200000,"22102": 950000,"22103": 850000,"22151": 700000,"22152": 680000,
  "22153": 660000,"22201": 850000,"22202": 780000,"22203": 820000,"22204": 720000,
  "22205": 790000,"22206": 750000,"22207": 950000,"22209": 1100000,"22015": 620000,
  "22031": 750000,"22032": 680000,"22033": 700000,"22041": 650000,"22042": 620000,
  "22043": 750000,"22044": 620000,"22046": 900000,"22060": 680000,"20120": 580000,
  "20121": 560000,"20151": 600000,"20170": 750000,"20171": 720000,"20190": 680000,
  "20191": 650000,"20194": 700000,"20147": 580000,"20148": 560000,"20164": 520000,
  "20165": 540000,"20166": 500000,"20175": 580000,"20176": 560000,"20105": 650000,
};

/**
 * Neighbourhood-level guess used when the property-level AVM is unavailable.
 * This is NOT a valuation of the subject property — it is a ZIP-code average
 * with no knowledge of size, condition, or lot. Everything it returns is
 * marked `degraded` so the UI can say so plainly instead of implying the
 * number was derived from the address.
 */
function zipFallback(
  zip: string,
  address: string,
  areaMedianIncome: number | null,
  fmr: typeof NOVA_FMR_DEFAULT = NOVA_FMR_DEFAULT
) {
  const known = Object.prototype.hasOwnProperty.call(ZIP_ESTIMATES, zip);
  const base = ZIP_ESTIMATES[zip] || 650000;
  // Widen the band when we don't even have the ZIP — a ±4% range implies a
  // precision this method does not have.
  const spread = known ? 0.12 : 0.25;
  return NextResponse.json({
    estimate: base,
    low: Math.floor(base * (1 - spread)),
    high: Math.ceil(base * (1 + spread)),
    confidence: "low",
    source: "zip-average",
    degraded: true,
    degradedReason: known
      ? "Property-level data was unavailable, so this is a ZIP-code average rather than a valuation of this specific home."
      : "This ZIP code is outside our coverage area, so this is a broad regional average only.",
    comps: [],
    streetViewUrl: buildStreetViewUrl(address),
    fmr,
    areaMedianIncome,
    pricePerSqft: null, rentZestimate: null,
    beds: null, baths: null, sqft: null, yearBuilt: null, homeType: null,
  });
}

/* ── Route ─────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { address, zipCode, city, state, fullAddress: passedFullAddress } = body;

  // Previously this silently fell back to 22015 (Burke, VA) — returning a
  // Northern Virginia number for an address that might be anywhere.
  if (!zipCode) {
    return NextResponse.json(
      {
        error: "address_incomplete",
        message: "We couldn't determine a ZIP code for that address. Please re-enter it including city, state and ZIP.",
      },
      { status: 422 }
    );
  }

  const fullAddress = passedFullAddress || [address, city, state, zipCode].filter(Boolean).join(", ");
  const amiPromise = fetchZipMedianIncome(zipCode);
  const fmrPromise = fetchHudFMR(zipCode, state || "VA");

  // No upstream configured — don't burn a timeout discovering that.
  if (!VALUATION_API_URL) {
    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
    console.warn("[avm] VALUATION_API_URL not configured — serving ZIP average");
    return zipFallback(zipCode, fullAddress, areaMedianIncome, fmr);
  }

  try {
    const streetOnly = (address || "").split(",")[0].trim();

    const res = await fetchWithTimeout(
      `${VALUATION_API_URL}/api/valuation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": VALUATION_API_KEY,
        },
        body: JSON.stringify({
          address: streetOnly || address,
          city: city || "",
          state: state || "VA",
          zip: zipCode,
        }),
      },
      UPSTREAM_TIMEOUT_MS
    );

    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);

    if (!res.ok) {
      console.error(`[avm] upstream returned ${res.status} — serving ZIP average`);
      return zipFallback(zipCode, fullAddress, areaMedianIncome, fmr);
    }

    const data = await res.json();

    if (data.source === "estimate" || !data.average) {
      console.warn("[avm] upstream had no property-level match — serving ZIP average");
      return zipFallback(zipCode, fullAddress, areaMedianIncome, fmr);
    }

    return NextResponse.json({
      estimate: data.average,
      low: data.low,
      high: data.high,
      confidence: "high",
      source: "avm",
      degraded: false,
      comps: [],
      streetViewUrl: data.photoUrl || buildStreetViewUrl(fullAddress, data.lat, data.lng),
      fmr,
      areaMedianIncome,
      pricePerSqft: data.pricePerSqft || null,
      rentZestimate: data.rentZestimate || null,
      beds: data.beds || null,
      baths: data.baths || null,
      sqft: data.sqft || null,
      yearBuilt: data.yearBuilt || null,
      homeType: data.homeType || null,
    });

  } catch (err) {
    const reason = (err as Error)?.name === "AbortError" ? "timed out" : String(err);
    console.error(`[avm] upstream unreachable (${reason}) — serving ZIP average`);
    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
    return zipFallback(zipCode, fullAddress, areaMedianIncome, fmr);
  }
}

export const maxDuration = 20;
