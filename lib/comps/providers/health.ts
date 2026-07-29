import { CompsProvider, LatLng, SubjectProperty } from "../types";
import { DcProvider } from "./dc";
import { FairfaxCountyProvider } from "./fairfax";
import { MarylandProvider } from "./maryland";

/**
 * Generic health check for any comps provider.
 *
 * WHY THIS EXISTS
 *
 * The canary was written when Fairfax was the only source, and it checked
 * Fairfax specifically. Two providers were then added and the safety net was
 * not extended with them — so if Maryland's iMAP had gone down, /api/health
 * would have reported "ok" on the strength of Fairfax alone while every
 * Maryland homeowner silently got nothing.
 *
 * That is exactly the failure the canary exists to catch: these are
 * undocumented public GIS services with no versioning or SLA, and every way
 * they break produces the same output as a legitimately out-of-area address —
 * an empty result and an HTTP 200.
 *
 * Written against the `CompsProvider` interface rather than any one source, so
 * the next provider is covered by adding one line to a list instead of by
 * remembering to write another checker. `checkFairfaxHealth` stays as it is:
 * it inspects fields only Fairfax publishes, and those checks are worth
 * keeping on top of these.
 */

/**
 * Default staleness ceiling. Overridable per source, because publishing
 * cadence is a property of the county, not of our code — see PROVIDER_PROBES.
 */
const DEFAULT_STALE_DAYS = 75;
/** Below this many sales at a known-good point, something is wrong. */
const MIN_COMPS = 15;
/** Above this, the source is up but too slow to sit in a request path. */
const SLOW_MS = 9_000;

export interface ProviderHealth {
  jurisdiction: string;
  ok: boolean;
  /** Problems that mean the source is broken now. */
  failures: string[];
  /** Working, but changed in a way that moves the numbers. */
  warnings: string[];
  compCount: number;
  newestSaleDate: string | null;
  daysSinceNewestSale: number | null;
  /** Share of returned sales carrying an assessment — worth 3.1pp of accuracy. */
  assessedCoverage: number;
  /** Whether the subject lookup works, not just the comp search. */
  subjectLookupOk: boolean;
  latencyMs: number;
}

export interface ProviderProbe {
  jurisdiction: string;
  /**
   * A residential address known to have comps around it. NOT a neighbourhood
   * centroid — those land on office blocks and apartment buildings, which the
   * engine rightly refuses to value, and the canary would then report a
   * healthy source as broken.
   */
  location: LatLng;
  create: () => CompsProvider & {
    lookupSubject?: (location: LatLng) => Promise<Partial<SubjectProperty> | null>;
  };
  /**
   * How old the newest sale may be before this source is considered stalled.
   *
   * Must reflect the source's NORMAL lag, or the canary cries wolf daily and
   * gets ignored — which is worse than not having it.
   */
  staleDays?: number;
}

function daysSince(iso: string): number {
  return Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
}

export async function checkProviderHealth(probe: ProviderProbe): Promise<ProviderHealth> {
  const started = Date.now();
  const failures: string[] = [];
  const warnings: string[] = [];

  const base: ProviderHealth = {
    jurisdiction: probe.jurisdiction,
    ok: false,
    failures,
    warnings,
    compCount: 0,
    newestSaleDate: null,
    daysSinceNewestSale: null,
    assessedCoverage: 0,
    subjectLookupOk: false,
    latencyMs: 0,
  };

  let provider: ReturnType<ProviderProbe["create"]>;
  try {
    provider = probe.create();
  } catch (err) {
    failures.push(`Provider could not be constructed: ${(err as Error)?.message}`);
    return { ...base, latencyMs: Date.now() - started };
  }

  const [salesResult, subjectResult] = await Promise.allSettled([
    provider.fetchCandidates(
      { location: probe.location, propertyType: "single_family" },
      { radiusMiles: 1.5, lookbackMonths: 12, limit: 200 }
    ),
    provider.lookupSubject ? provider.lookupSubject(probe.location) : Promise.resolve(null),
  ]);

  const latencyMs = Date.now() - started;

  if (salesResult.status === "rejected") {
    // A schema error means a field was renamed; anything else is transport.
    failures.push(`Comp search failed: ${salesResult.reason?.message ?? salesResult.reason}`);
    return { ...base, latencyMs };
  }

  const sales = salesResult.value;
  const dates = sales.map(s => s.soldDate).filter(Boolean).sort();
  const newestSaleDate = dates.length ? dates[dates.length - 1] : null;
  const daysSinceNewestSale = newestSaleDate ? daysSince(newestSaleDate) : null;
  const assessedCoverage = sales.length
    ? sales.filter(s => s.assessedValue && s.assessedValue > 0).length / sales.length
    : 0;

  if (sales.length === 0) {
    failures.push(
      `No sales returned at a known-good residential location. The source is ` +
        `unreachable, has changed shape, or has stopped publishing.`
    );
  } else if (sales.length < MIN_COMPS) {
    failures.push(`Only ${sales.length} sales returned where ${MIN_COMPS}+ are expected.`);
  }

  // The failure that produces no error at all: sales still return, they are
  // just all old. Every valuation then rests on stale comps while reporting
  // whatever confidence the count justifies.
  const staleDays = probe.staleDays ?? DEFAULT_STALE_DAYS;
  if (daysSinceNewestSale !== null && daysSinceNewestSale > staleDays) {
    failures.push(
      `Newest sale is ${daysSinceNewestSale} days old (${newestSaleDate}). ` +
        `The feed has stalled — valuations are being built from stale comps. ` +
        `Normal lag for this source is under ${staleDays} days.`
    );
  }

  // Assessed value carries roughly ten times the accuracy of any physical
  // field, so losing it is a quiet, serious degradation rather than an outage.
  if (sales.length > 0 && assessedCoverage < 0.5) {
    warnings.push(
      `Only ${(assessedCoverage * 100).toFixed(0)}% of sales carry an assessment ` +
        `(usually ~100%). Accuracy will fall back on physical characteristics.`
    );
  }

  const subjectLookupOk =
    subjectResult.status === "fulfilled" && subjectResult.value !== null;
  if (subjectResult.status === "rejected") {
    failures.push(`Subject lookup failed: ${subjectResult.reason?.message ?? subjectResult.reason}`);
  } else if (!subjectLookupOk) {
    // Comps without a subject description means no valuation, so this is a
    // failure even though the comp search worked.
    failures.push("Subject lookup returned nothing at a known-good residential location.");
  }

  if (latencyMs > SLOW_MS) {
    warnings.push(`Took ${latencyMs}ms, which is slow enough to risk the request timeout.`);
  }

  return {
    jurisdiction: probe.jurisdiction,
    ok: failures.length === 0,
    failures,
    warnings,
    compCount: sales.length,
    newestSaleDate,
    daysSinceNewestSale,
    assessedCoverage,
    subjectLookupOk,
    latencyMs,
  };
}

/**
 * The points the canary probes.
 *
 * Each is a REAL RESIDENTIAL PARCEL verified to return comps, not a
 * neighbourhood centroid. Centroids land on office blocks and apartment
 * buildings — 7500 Wisconsin Ave in Bethesda, 101 W Patrick St in Frederick —
 * which the engine correctly declines to value from house comps, and a canary
 * pointed at one reports a healthy source as broken. That mistake has already
 * been made twice in this codebase.
 */
export const PROVIDER_PROBES: ProviderProbe[] = [
  {
    jurisdiction: "dc",
    // Capitol Hill rowhouse; consistently ~150 comps within 1.5 miles.
    location: { lat: 38.887, lng: -76.993 },
    create: () => new DcProvider(),
  },
  {
    jurisdiction: "maryland",
    // 8805 Wandering Trail Dr, Rockville.
    location: { lat: 39.06703630127611, lng: -77.18079229858597 },
    create: () => new MarylandProvider(),
    // MARYLAND PUBLISHES ~90 DAYS BEHIND, STATEWIDE. Measured 2026-07-29: the
    // newest sale anywhere in Maryland was 2026-04-30, with zero sales
    // recorded for May, June or July — while DC and Fairfax were current to
    // within 10 days. That is SDAT's cadence, not a fault, and it is why this
    // threshold is not the 75-day default: at 75 the canary would fail every
    // single day and be ignored within a week.
    //
    // 150 days still catches a genuine stall — roughly two months beyond
    // normal — while tolerating the lag itself.
    staleDays: 150,
  },
  {
    jurisdiction: "fairfax",
    // McLean. checkFairfaxHealth() additionally inspects fields only Fairfax
    // publishes; this covers the same ground the other two get.
    location: { lat: 38.94, lng: -77.161 },
    create: () => new FairfaxCountyProvider(),
  },
];
