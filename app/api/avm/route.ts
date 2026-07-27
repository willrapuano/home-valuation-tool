import { NextRequest, NextResponse } from "next/server";
import { TtlCache, addressCacheKey } from "@/lib/cache";
import { RateLimiter, clientKey } from "@/lib/rate-limit";

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
  fmr: typeof NOVA_FMR_DEFAULT = NOVA_FMR_DEFAULT
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
    fmr,
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

  const cacheKey = addressCacheKey({ address, city, state, zipCode });
  const cached = valuationCache.get(cacheKey);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  const amiPromise = fetchZipMedianIncome(zipCode);
  const fmrPromise = fetchHudFMR(zipCode, state || "VA");

  // No upstream configured — don't burn a timeout discovering that.
  if (!VALUATION_API_URL) {
    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
    console.warn("[avm] VALUATION_API_URL not configured — no valuation available");
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
    console.error(`[avm] upstream unreachable (${reason}) — no valuation available`);
    const [areaMedianIncome, fmr] = await Promise.all([amiPromise, fmrPromise]);
    return respond(cacheKey, noValuation(fullAddress, areaMedianIncome, fmr));
  }
}

export const maxDuration = 20;
