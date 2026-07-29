/**
 * How long does a real homeowner actually wait?
 *
 * Measures /api/avm end to end against a deployed environment, which is the
 * only number that matters — local timings understate cold serverless starts
 * and overstate nothing, and timings taken while hammering the upstream GIS
 * services (as happens during a backtest) are pure noise.
 *
 *   npx tsx scripts/latency-probe.ts [baseUrl] [perJurisdiction]
 *
 * TWO THINGS THIS HAS TO GET RIGHT OR IT MEASURES THE WRONG QUANTITY:
 *
 *   1. The route caches valuations by address for an hour, so every probe must
 *      use a DISTINCT REAL address. Repeating one address measures the cache.
 *   2. The route rate-limits to a 10 request burst and roughly one per six
 *      seconds after that. Firing faster measures throttling, not latency.
 *
 * Addresses are drawn live from the providers so they are real homes rather
 * than neighbourhood centroids — a centroid lands on an office block or an
 * apartment building, which the engine rightly declines to value from house
 * comps, and the probe would then be timing the refusal path.
 */
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale } from "../lib/comps/types";

const BASE = (process.argv[2] || "https://home-valuation-tool.vercel.app").replace(/\/+$/, "");
const PER_JURISDICTION = Number(process.argv[3]) || 5;

/** Sustained limit is ~1 request per 6s; leave headroom. */
const PACE_MS = 7_000;
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * `city` and `zip` are seed-level fallbacks because not every provider
 * populates them on a comp: the DC provider carries the ZIP inside the address
 * string, and the Fairfax provider returns a parcel identifier rather than a
 * street address at all. /api/avm rejects a request with no ZIP (422), so
 * without these the probe measures its own malformed payloads.
 */
const SEEDS = [
  { jurisdiction: "dc", state: "DC", city: "Washington", zip: "20003", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", state: "DC", city: "Washington", zip: "20011", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "maryland", state: "MD", city: "Rockville", zip: "20850", lat: 39.084, lng: -77.1528, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", state: "MD", city: "Frederick", zip: "21701", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider() },
  { jurisdiction: "fairfax", state: "VA", city: "McLean", zip: "22101", lat: 38.94, lng: -77.161, provider: () => new FairfaxCountyProvider() },
  { jurisdiction: "fairfax", state: "VA", city: "Vienna", zip: "22180", lat: 38.8938, lng: -77.25, provider: () => new FairfaxCountyProvider() },
];

interface Probe {
  jurisdiction: string;
  state: string;
  city: string;
  address: string;
  lat: number;
  lng: number;
  zip: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pctile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Real, distinct, recently-sold homes near a seed point. */
async function homesNear(seed: (typeof SEEDS)[number], want: number): Promise<Probe[]> {
  const sales: ComparableSale[] = await seed.provider().fetchCandidates(
    { location: { lat: seed.lat, lng: seed.lng }, propertyType: "single_family" },
    { radiusMiles: 2.5, lookbackMonths: 24, limit: 400 }
  );

  const seen = new Set<string>();
  const out: Probe[] = [];
  for (const s of sales) {
    if (out.length >= want) break;
    const isHome = s.propertyType === "single_family" || s.propertyType === "townhouse";
    if (!isHome || !s.assessedValue) continue;
    const address = (s.address || "").trim();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    // Prefer a ZIP the provider gave us, then one embedded in the address
    // string, then the seed's.
    const embedded = address.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1];
    out.push({
      jurisdiction: seed.jurisdiction,
      state: seed.state,
      city: seed.city,
      address,
      lat: s.location.lat,
      lng: s.location.lng,
      zip: s.zipCode || embedded || seed.zip,
    });
  }
  return out;
}

interface Result {
  jurisdiction: string;
  ms: number;
  status: number;
  valued: boolean;
  cached: boolean;
  confidence?: string;
}

async function probe(p: Probe): Promise<Result> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/avm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: p.address,
        city: p.city,
        state: p.state,
        zipCode: p.zip,
        lat: p.lat,
        lng: p.lng,
      }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    let body: Record<string, unknown> = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON: recorded via status */
    }
    return {
      jurisdiction: p.jurisdiction,
      ms,
      status: res.status,
      valued: body.estimate !== null && body.estimate !== undefined,
      cached: body.cached === true,
      confidence: body.confidence as string | undefined,
    };
  } catch {
    return {
      jurisdiction: p.jurisdiction,
      ms: Date.now() - started,
      status: 0,
      valued: false,
      cached: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`Probing ${BASE}\n`);

  const probes: Probe[] = [];
  for (const seed of SEEDS) {
    const want = Math.ceil(PER_JURISDICTION / 2);
    try {
      probes.push(...(await homesNear(seed, want)));
    } catch (err) {
      console.error(`  seed ${seed.jurisdiction} @${seed.lat},${seed.lng} failed: ${(err as Error).message}`);
    }
  }

  if (!probes.length) {
    console.error("No probe addresses could be assembled.");
    process.exit(1);
  }
  console.log(`  ${probes.length} distinct real addresses assembled, pacing ${PACE_MS}ms apart`);
  console.log(`  (expect roughly ${Math.round((probes.length * PACE_MS) / 1000)}s plus request time)\n`);

  const results: Result[] = [];
  for (let i = 0; i < probes.length; i++) {
    if (i > 0) await sleep(PACE_MS);
    const r = await probe(probes[i]);
    results.push(r);
    const flag = r.status !== 200 ? ` HTTP ${r.status}` : r.cached ? " CACHED" : "";
    console.log(
      `  ${String(i + 1).padStart(2)}/${probes.length} ${r.jurisdiction.padEnd(9)} ` +
        `${String(r.ms).padStart(6)}ms  ${(r.valued ? r.confidence ?? "valued" : "no estimate").padEnd(12)}` +
        `${flag}  ${probes[i].address.slice(0, 32)}`
    );
  }

  // Cache behaviour: repeat the first address, which should now be warm.
  await sleep(PACE_MS);
  const warm = await probe(probes[0]);

  console.log(`\n${"═".repeat(84)}`);
  console.log("COLD LATENCY BY JURISDICTION  (uncached, one distinct address each)");
  console.log("═".repeat(84));
  console.log(`  ${"jurisdiction".padEnd(14)} ${"n".padStart(3)} ${"p50".padStart(8)} ${"p90".padStart(8)} ${"max".padStart(8)}   valued`);
  console.log("  " + "─".repeat(80));

  const cold = results.filter(r => !r.cached && r.status === 200);
  for (const j of ["dc", "maryland", "fairfax"]) {
    const rows = cold.filter(r => r.jurisdiction === j);
    if (!rows.length) {
      console.log(`  ${j.padEnd(14)}   —`);
      continue;
    }
    const ms = rows.map(r => r.ms);
    console.log(
      `  ${j.padEnd(14)} ${String(rows.length).padStart(3)} ` +
        `${(median(ms) / 1000).toFixed(2).padStart(7)}s ${(pctile(ms, 0.9) / 1000).toFixed(2).padStart(7)}s ` +
        `${(Math.max(...ms) / 1000).toFixed(2).padStart(7)}s   ` +
        `${rows.filter(r => r.valued).length}/${rows.length}`
    );
  }

  const allMs = cold.map(r => r.ms);
  console.log("  " + "─".repeat(80));
  console.log(
    `  ${"ALL".padEnd(14)} ${String(cold.length).padStart(3)} ` +
      `${(median(allMs) / 1000).toFixed(2).padStart(7)}s ${(pctile(allMs, 0.9) / 1000).toFixed(2).padStart(7)}s ` +
      `${(Math.max(...allMs) / 1000).toFixed(2).padStart(7)}s   ` +
      `${cold.filter(r => r.valued).length}/${cold.length}`
  );
  console.log("═".repeat(84));

  const failures = results.filter(r => r.status !== 200);
  if (failures.length) {
    const throttled = failures.filter(r => r.status === 429).length;
    const timedOut = failures.filter(r => r.status === 0).length;
    console.log(
      `\n  ${failures.length} non-200 response(s): ${throttled} rate-limited, ${timedOut} timed out. ` +
        `Rate limiting here means the pacing is too aggressive, not that production is slow.`
    );
  }

  console.log(
    `\n  Warm cache repeat of the first address: ${warm.ms}ms` +
      `${warm.cached ? " (served from cache)" : " (NOT cached — the cache may not be working)"}`
  );

  const p90 = pctile(allMs, 0.9) / 1000;
  console.log(
    `\n  Judgement: a homeowner watching a spinner tolerates a few seconds. ` +
      `p90 is ${p90.toFixed(1)}s.\n  ` +
      (p90 <= 4
        ? "That is fine — no latency work needed."
        : p90 <= 8
          ? "Acceptable but worth trimming; the subject lookup and comp fetch already run concurrently, so the next win is caching the comp POOL per area rather than per address."
          : "Too slow. Investigate before adding features.")
  );
}

main().catch(err => {
  console.error("Latency probe failed:", err?.message ?? err);
  process.exit(1);
});
