import { NextResponse } from "next/server";
import { checkFairfaxHealth } from "@/lib/comps/providers/fairfax";
import { hasSharedCache } from "@/lib/kv";
import { hasDatabase } from "@/lib/db";
import { ingestFreshness } from "@/lib/comps/providers/postgres";

/**
 * Health check for uptime monitoring.
 *
 * The failure this exists to catch is the one that actually happened: the
 * valuation upstream disappeared and the tool kept returning HTTP 200 for
 * months while producing no real valuations. A monitor pointed at the
 * homepage would have stayed green the whole time.
 *
 * So this endpoint returns a NON-200 status when the tool cannot produce real
 * property-level valuations. Point an uptime monitor (Better Stack, Pingdom,
 * UptimeRobot, or a Vercel cron) at it and alert on non-200.
 *
 *   200 — healthy, property-level valuations working
 *   503 — no valuations available; visitors are routed to a manual CMA
 */

const PROBE_TIMEOUT_MS = 5000;

type Status = "ok" | "degraded" | "not_configured";

interface Check {
  status: Status;
  detail: string;
  /** True when this check failing means no real valuations. */
  critical: boolean;
  latencyMs?: number;
}

async function probe(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; ms: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    const error = (err as Error)?.name === "AbortError" ? "timed out" : String(err);
    return { ok: false, status: 0, ms: Date.now() - started, error };
  } finally {
    clearTimeout(timer);
  }
}

async function checkValuationUpstream(): Promise<Check> {
  const url = process.env.VALUATION_API_URL;
  if (!url) {
    return {
      status: "not_configured",
      // Not critical on its own: county comps cover Fairfax without it.
      critical: false,
      detail: "VALUATION_API_URL is unset — addresses outside Fairfax County cannot be valued.",
    };
  }

  const res = await probe(`${url}/api/valuation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.VALUATION_API_KEY ?? "",
    },
    // A known-good address so a 200 means the pipeline really works, not just
    // that something is listening on the port.
    body: JSON.stringify({ address: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "20500" }),
  });

  if (res.ok) {
    return { status: "ok", critical: false, detail: `Reachable (HTTP ${res.status}).`, latencyMs: res.ms };
  }
  return {
    status: "degraded",
    critical: false,
    detail: res.error ? `Unreachable: ${res.error}.` : `Returned HTTP ${res.status}.`,
    latencyMs: res.ms,
  };
}

async function checkCensus(): Promise<Check> {
  const key = process.env.CENSUS_API_KEY;
  if (!key) {
    return { status: "not_configured", critical: false, detail: "CENSUS_API_KEY unset — median income hidden." };
  }
  const res = await probe(
    `https://api.census.gov/data/2023/acs/acs5?get=NAME,B19013_001E&for=zip%20code%20tabulation%20area:22101&key=${key}`
  );
  return res.ok
    ? { status: "ok", critical: false, detail: "Reachable.", latencyMs: res.ms }
    : { status: "degraded", critical: false, detail: res.error ?? `HTTP ${res.status}.`, latencyMs: res.ms };
}

async function checkHud(): Promise<Check> {
  const token = process.env.HUD_API_TOKEN;
  if (!token) {
    return { status: "not_configured", critical: false, detail: "HUD_API_TOKEN unset — rental section hidden." };
  }
  const res = await probe("https://www.huduser.gov/hudapi/public/fmr/data/5105999999", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok
    ? { status: "ok", critical: false, detail: "Reachable.", latencyMs: res.ms }
    : { status: "degraded", critical: false, detail: res.error ?? `HTTP ${res.status}.`, latencyMs: res.ms };
}

/**
 * TitleFlex is not yet critical — it is scaffolded but not wired into the
 * valuation path, since the field mapping is unverified. Flip `critical` to
 * true once it is the primary comps source.
 */
async function checkTitleFlex(): Promise<Check> {
  const key = process.env.TITLEFLEX_API_KEY;
  const url = process.env.TITLEFLEX_API_URL;
  if (!key || !url) {
    return {
      status: "not_configured",
      critical: false,
      detail: "TITLEFLEX_API_KEY / TITLEFLEX_API_URL unset — comps provider inactive.",
    };
  }

  const authHeader = process.env.TITLEFLEX_AUTH_HEADER || "Authorization";
  const scheme = process.env.TITLEFLEX_AUTH_SCHEME === undefined ? "Bearer" : process.env.TITLEFLEX_AUTH_SCHEME;
  const res = await probe(`${url.replace(/\/+$/, "")}${process.env.TITLEFLEX_SEARCH_PATH || "/property/sales/search"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      [authHeader]: scheme ? `${scheme} ${key}` : key,
    },
    body: JSON.stringify({ latitude: 38.94, longitude: -77.161, radiusMiles: 1, limit: 1 }),
  });

  if (res.ok) {
    return { status: "ok", critical: false, detail: "Reachable and authenticated.", latencyMs: res.ms };
  }
  return {
    status: "degraded",
    critical: false,
    detail: res.status === 401 || res.status === 403
      ? `Authentication rejected (HTTP ${res.status}) — check key, auth header and scheme.`
      : res.error ?? `HTTP ${res.status} (the search path may be wrong — see TITLEFLEX_SEARCH_PATH).`,
    latencyMs: res.ms,
  };
}

/**
 * Our own comps engine on Fairfax County records — the primary valuation
 * source. Every way this can break currently produces the same output as a
 * legitimately out-of-area address, so the canary reports the specific cause.
 */
async function checkCountyComps(): Promise<Check> {
  try {
    const h = await checkFairfaxHealth();
    const detail = [
      `${h.compCount} sales`,
      h.newestSaleDate ? `newest ${h.daysSinceNewestSale}d old` : null,
      `${(h.landUseCoverage * 100).toFixed(0)}% land use mapped`,
      h.medianSaleToAssessedRatio ? `median ratio ${h.medianSaleToAssessedRatio}` : null,
      h.taxYear ? `assessment year ${h.taxYear}` : null,
    ].filter(Boolean).join(", ");

    if (!h.ok) {
      return { status: "degraded", critical: true, detail: h.failures.join(" "), latencyMs: h.latencyMs };
    }
    // Warnings don't break the source, but they change the numbers it produces.
    return {
      status: "ok",
      critical: true,
      detail: h.warnings.length ? `${detail}. WARNING: ${h.warnings.join(" ")}` : detail,
      latencyMs: h.latencyMs,
    };
  } catch (err) {
    return {
      status: "degraded",
      critical: true,
      detail: `Canary failed: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

function checkStreetView(): Check {
  return process.env.GOOGLE_MAPS_API_KEY
    ? { status: "ok", critical: false, detail: "Key configured." }
    : { status: "not_configured", critical: false, detail: "GOOGLE_MAPS_API_KEY unset — property imagery disabled." };
}

function checkCrm(): Check {
  return process.env.GHL_API_KEY
    ? { status: "ok", critical: false, detail: "Key configured." }
    : { status: "not_configured", critical: false, detail: "GHL_API_KEY unset — leads are not being captured." };
}

/** Ingested-data freshness, or null when running purely on live sources. */
async function datastoreStatus() {
  if (!hasDatabase()) return { configured: false as const };
  try {
    return { configured: true as const, jurisdictions: await ingestFreshness() };
  } catch (err) {
    return { configured: true as const, error: (err as Error)?.message ?? "unreachable" };
  }
}

export async function GET() {
  const [countyComps, valuation, census, hud, titleflex] = await Promise.all([
    checkCountyComps(),
    checkValuationUpstream(),
    checkCensus(),
    checkHud(),
    checkTitleFlex(),
  ]);

  const checks: Record<string, Check> = {
    countyComps,
    valuationUpstream: valuation,
    titleflex,
    census,
    hud,
    streetView: checkStreetView(),
    crm: checkCrm(),
  };

  // The tool is healthy when SOME route to a valuation works — not when every
  // one does. County comps cover Fairfax; the upstream covers everywhere else.
  const valuationSources = { countyComps, externalUpstream: valuation };
  const workingSources = Object.entries(valuationSources)
    .filter(([, c]) => c.status === "ok")
    .map(([name]) => name);

  const criticalFailures = Object.entries(checks)
    .filter(([, c]) => c.critical && c.status !== "ok")
    .map(([name]) => name);

  const healthy = workingSources.length > 0;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      // Stated plainly so whoever reads the alert knows what users are seeing.
      summary: healthy
        ? `Valuations working via: ${workingSources.join(", ")}.`
        : "No valuations are being produced — every visitor is being routed to a manual CMA.",
      workingSources,
      // Whether repeat lookups survive a lambda recycle. Without a shared
      // store the cache still works, but only within one instance — see
      // lib/kv.ts for why that measurably matters.
      sharedCache: hasSharedCache(),
      // Serving from our own copy is only better than the live sources while
      // that copy is fresh; stale comps degrade silently, so say how old.
      datastore: await datastoreStatus(),
      failing: criticalFailures,
      checks,
      timestamp: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

export const dynamic = "force-dynamic";
