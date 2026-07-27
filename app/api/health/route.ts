import { NextResponse } from "next/server";

/**
 * Health check for uptime monitoring.
 *
 * The failure this exists to catch is the one that actually happened: the
 * valuation upstream disappeared and the tool kept returning HTTP 200 with a
 * ZIP-code average for months. A monitor pointed at the homepage would have
 * stayed green the whole time.
 *
 * So this endpoint returns a NON-200 status when the tool cannot produce real
 * property-level valuations. Point an uptime monitor (Better Stack, Pingdom,
 * UptimeRobot, or a Vercel cron) at it and alert on non-200.
 *
 *   200 — healthy, property-level valuations working
 *   503 — degraded, serving fallbacks only
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
      critical: true,
      detail: "VALUATION_API_URL is unset — every valuation is a ZIP-code average.",
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
    return { status: "ok", critical: true, detail: `Reachable (HTTP ${res.status}).`, latencyMs: res.ms };
  }
  return {
    status: "degraded",
    critical: true,
    detail: res.error
      ? `Unreachable: ${res.error}.`
      : `Returned HTTP ${res.status}.`,
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
    return { status: "not_configured", critical: false, detail: "HUD_API_TOKEN unset — using static NoVA rent averages." };
  }
  const res = await probe("https://www.huduser.gov/hudapi/public/fmr/data/5105999999", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok
    ? { status: "ok", critical: false, detail: "Reachable.", latencyMs: res.ms }
    : { status: "degraded", critical: false, detail: res.error ?? `HTTP ${res.status}.`, latencyMs: res.ms };
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

export async function GET() {
  const [valuation, census, hud] = await Promise.all([
    checkValuationUpstream(),
    checkCensus(),
    checkHud(),
  ]);

  const checks: Record<string, Check> = {
    valuationUpstream: valuation,
    census,
    hud,
    streetView: checkStreetView(),
    crm: checkCrm(),
  };

  const criticalFailures = Object.entries(checks)
    .filter(([, c]) => c.critical && c.status !== "ok")
    .map(([name]) => name);

  const healthy = criticalFailures.length === 0;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      // Stated plainly so whoever reads the alert knows what users are seeing.
      summary: healthy
        ? "Property-level valuations are working."
        : "Serving ZIP-code averages only — users are NOT getting property-level valuations.",
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
