import { NextRequest, NextResponse } from "next/server";
import { TtlCache, addressCacheKey } from "@/lib/cache";
import { RateLimiter, clientKey } from "@/lib/rate-limit";
import { valueFromComps } from "@/lib/comps";
import { FairfaxCountyProvider } from "@/lib/comps/providers/fairfax";

/* ──────────────────────────────────────────────────────────────
   Upstream valuation service.

   NOTE: this is currently the weak link in the whole tool. It must
   point at a STABLE hostname. A `*.trycloudflare.com` Quick Tunnel
   gets a fresh random URL on every restart, so when the tunnel drops
   the tool stops producing valuations entirely and nobody finds out.
   Use a named Cloudflare tunnel or a hosted API, and watch /api/health.
────────────────────────────────────────────────────────────────── */
const VALUATION_API_URL = process.env.VALUATION_API_URL || "";
const VALUATION_API_KEY = process.env.VALUATION_API_KEY || "";

const UPSTREAM_TIMEOUT_MS = 8000;
const SIDECAR_TIMEOUT_MS = 4000;

/**
 * A property's value does not move meaningfully within an hour, and repeat
 * lookups of the same address are common (users re-running the flow, embeds
 * being refreshed). Caching keeps those off the paid upstream.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const valuationCache = new TtlCache<Record<string, unknown>>(CACHE_TTL_MS, 500);

// 10 request burst, sustained ~1 every 6s. Comfortable for a human working
// through the funnel; hostile to a script enumerating addresses.
const limiter = new RateLimiter(10, 1 / 6);

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

type FmrResult = { source: "hud" | "default"; values: typeof NOVA_FMR_DEFAULT };

/**
 * Rent benchmarks. The `source` matters: without a HUD token this returns
 * static NoVA averages, and presenting those as this property's rent would be
 * the same fabrication we removed from the valuation itself. Callers must
 * only display `values` when `source` is "hud".
 */
async function fetchHudFMR(zip: string, state: string): Promise<FmrResult> {
  const fallback: FmrResult = { source: "default", values: NOVA_FMR_DEFAULT };
  const HUD_TOKEN = process.env.HUD_API_TOKEN;
  if (!HUD_TOKEN) return fallback;
  const fips = STATE_FMR_FIPS[state?.toUpperCase()] || STATE_FMR_FIPS["VA"];
  try {
    const res = await fetchWithTimeout(`https://www.huduser.gov/hudapi/public/fmr/data/${fips}`, {
      headers: { Authorization: `Bearer ${HUD_TOKEN}` },
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const zipData =
      data?.data?.basicdata?.find((d: Record<string, unknown>) => d.zip_code === zip) ||
      data?.data?.basicdata?.[0]; // MSA level fallback
    if (!zipData) return fallback;
    return {
      source: "hud",
      values: {
        studio: zipData["Efficiency"] || NOVA_FMR_DEFAULT.studio,
        oneBr: zipData["One-Bedroom"] || NOVA_FMR_DEFAULT.oneBr,
        twoBr: zipData["Two-Bedroom"] || NOVA_FMR_DEFAULT.twoBr,
        threeBr: zipData["Three-Bedroom"] || NOVA_FMR_DEFAULT.threeBr,
        fourBr: zipData["Four-Bedroom"] || NOVA_FMR_DEFAULT.fourBr,
      },
    };
  } catch {
    return fallback;
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

/* ── In-house comps valuation ──────────────────────────────────── */

/**
 * Rough bounding box for Fairfax County, used only to skip a pointless round
 * trip for addresses obviously outside it. The provider's spatial query is
 * authoritative — this is a cheap pre-filter, not a boundary test.
 */
const FAIRFAX_BBOX = { minLat: 38.55, maxLat: 39.08, minLng: -77.56, maxLng: -77.0 };

function inFairfax(lat: number, lng: number): boolean {
  return (
    lat >= FAIRFAX_BBOX.minLat && lat <= FAIRFAX_BBOX.maxLat &&
    lng >= FAIRFAX_BBOX.minLng && lng <= FAIRFAX_BBOX.maxLng
  );
}

const RADIUS_MILES = 1.5;
const LOOKBACK_MONTHS = 12;

/**
 * Value the property from county sales records using our own comps engine.
 * Returns null when the address is out of area or there aren't enough usable
 * comparables — the caller then falls through to the next source.
 */
async function valueFromCountyRecords(lat: number, lng: number) {
  if (!inFairfax(lat, lng)) return null;

  const provider = new FairfaxCountyProvider();
  const location = { lat, lng };

  // Run concurrently: the candidate search only needs the location, not the
  // subject's own attributes, so there is no reason to wait for one before
  // starting the other. Sequentially these were stacking into a timeout.
  const [subjectInfo, candidates] = await Promise.all([
    provider.lookupSubject(location),
    provider.fetchCandidates(
      { location, propertyType: "single_family" },
      { radiusMiles: RADIUS_MILES, lookbackMonths: LOOKBACK_MONTHS, limit: 200 }
    ),
  ]);

  if (!subjectInfo?.assessedValue) return null;

  const subject = {
    location,
    propertyType: subjectInfo.propertyType ?? ("single_family" as const),
    assessedValue: subjectInfo.assessedValue,
  };

  const result = valueFromComps(subject, candidates);
  if (result.estimate === null) return null;

  const maxDistance = result.comps.reduce((m, c) => Math.max(m, c.distanceMiles), 0);

  return {
    estimate: Math.round(result.estimate),
    low: result.low!,
    high: result.high!,
    confidence: result.confidence,
    confidenceScore: result.confidenceScore,
    compCount: result.comps.length,
    compRadiusMiles: Number(maxDistance.toFixed(2)),
    lookbackMonths: LOOKBACK_MONTHS,
    assessedValue: subjectInfo.assessedValue,
  };
}

/* ── No-valuation fallback ─────────────────────────────────────── */

/**
 * Returned when we cannot value the specific property.
 *
 * Deliberately carries NO estimate. A previous version substituted a
 * ZIP-code average here, which meant every home in 22101 came back at
 * $1,200,000 whether it was a mansion or a teardown. Labelling that as an
 * area average did not rescue it — a number that isn't about the subject
 * property has no business on the screen, and the funnel converts on the
 * CMA offer rather than on the estimate.
 *
 * The UI switches to a "valuation being prepared" state on `degraded`, so
 * the lead is still captured and routed to the agent.
 */
function noValuation(
  address: string,
  areaMedianIncome: number | null,
  fmr?: FmrResult
): Record<string, unknown> {
  return {
    estimate: null,
    low: null,
    high: null,
    confidence: "none",
    source: "unavailable",
    degraded: true,
    degradedReason:
      "We couldn't retrieve verified sales data for this property, so no automated estimate was produced.",
    comps: [],
    streetViewUrl: buildStreetViewUrl(address),
    fmr: fmr?.source === "hud" ? fmr.values : null,
    areaMedianIncome,
    pricePerSqft: null, rentZestimate: null,
    beds: null, baths: null, sqft: null, yearBuilt: null, homeType: null,
  };
}

/**
 * Cache and return. Degraded payloads get a much shorter TTL — a degraded
 * result means something upstream is broken, and we want the first request
 * after recovery to see real data rather than a stale fallback.
 */
const DEGRADED_TTL_MS = 60 * 1000;

function respond(cacheKey: string | null, payload: Record<string, unknown>) {
  if (cacheKey) {
    valuationCache.set(cacheKey, payload, payload.degraded ? DEGRADED_TTL_MS : undefined);
  }
  return NextResponse.json(payload);
}

/* ── Route ─────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const rate = limiter.check(clientKey(req.headers));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { address, zipCode, city, state, lat, lng, fullAddress: passedFullAddress } = body;

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

  const cacheKey = addressCacheKey({ address, city, state, zipCode });
  const cached = valuationCache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  const amiPromise = fetchZipMedianIncome(zipCode);
  const fmrPromise = fetchHudFMR(zipCode, state || "VA");

  // ── 1. Our own comps engine, on county public records ──────────
  //
  // Tried first: it needs no credentials, no third party, and produces a
  // result we can explain comp by comp. Coordinates come from the address
  // autocomplete in step 1.
  if (typeof lat === "number" && typeof lng === "number") {
    try {
      const valued = await valueFromCountyRecords(lat, lng);
      if (valued) {
        const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
        console.info(
          `[avm] valued from ${valued.compCount} county comps ` +
            `(confidence ${valued.confidence})`
        );
        return respond(cacheKey, {
          estimate: valued.estimate,
          low: valued.low,
          high: valued.high,
          confidence: valued.confidence,
          confidenceScore: valued.confidenceScore,
          source: "county-comps",
          degraded: false,
          comps: [],
          compCount: valued.compCount,
          compRadiusMiles: valued.compRadiusMiles,
          lookbackMonths: valued.lookbackMonths,
          assessedValue: valued.assessedValue,
          streetViewUrl: buildStreetViewUrl(fullAddress, lat, lng),
          fmr: fmr.source === "hud" ? fmr.values : null,
          areaMedianIncome,
          pricePerSqft: null, rentZestimate: null,
          beds: null, baths: null, sqft: null, yearBuilt: null, homeType: null,
        });
      }
    } catch (err) {
      // Never let a county-data problem take down the request; fall through.
      console.error(`[avm] county comps failed: ${(err as Error)?.message ?? err}`);
    }
  }

  // ── 2. External valuation upstream, if one is configured ───────
  if (!VALUATION_API_URL) {
    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
    console.warn("[avm] no county comps and VALUATION_API_URL not configured");
    return respond(cacheKey, noValuation(fullAddress, areaMedianIncome, fmr));
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
      console.error(`[avm] upstream returned ${res.status} — no valuation available`);
      return respond(cacheKey, noValuation(fullAddress, areaMedianIncome, fmr));
    }

    const data = await res.json();

    if (data.source === "estimate" || !data.average) {
      console.warn("[avm] upstream had no property-level match — no valuation available");
      return respond(cacheKey, noValuation(fullAddress, areaMedianIncome, fmr));
    }

    return respond(cacheKey, {
      estimate: data.average,
      low: data.low,
      high: data.high,
      confidence: "high",
      source: "avm",
      degraded: false,
      comps: [],
      streetViewUrl: data.photoUrl || buildStreetViewUrl(fullAddress, data.lat, data.lng),
      fmr: fmr.source === "hud" ? fmr.values : null,
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
    console.error(`[avm] upstream unreachable (${reason}) — no valuation available`);
    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
    return respond(cacheKey, noValuation(fullAddress, areaMedianIncome, fmr));
  }
}

export const maxDuration = 20;
