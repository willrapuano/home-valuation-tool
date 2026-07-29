/**
 * End-to-end smoke test across jurisdictions, mirroring the routing in
 * /api/avm: try each covering provider in order, first real valuation wins.
 *
 * Confirms that a Maryland address falls through the overlapping Fairfax
 * bounding box and lands on the Maryland source, and that Fairfax addresses
 * are unaffected.
 */
import { valueFromComps } from "../lib/comps";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { DcProvider } from "../lib/comps/providers/dc";
import { SubjectProperty } from "../lib/comps/types";

const COVERAGE = [
  {
    name: "fairfax",
    bbox: { minLat: 38.55, maxLat: 39.08, minLng: -77.56, maxLng: -77.0 },
    create: () => new FairfaxCountyProvider(),
  },
  {
    name: "dc",
    bbox: { minLat: 38.79, maxLat: 39.0, minLng: -77.13, maxLng: -76.89 },
    create: () => new DcProvider(),
  },
  {
    name: "maryland",
    bbox: { minLat: 37.88, maxLat: 39.73, minLng: -79.49, maxLng: -74.98 },
    create: () => new MarylandProvider(),
  },
];

/**
 * City-centre coordinates are NOT usable here. A downtown centroid lands on a
 * commercial parcel — 7500 Wisconsin Ave in Bethesda, 101 W Patrick St in
 * Frederick — and the engine correctly refuses to value an office block from
 * house comps. An earlier version of this script used centroids and reported
 * five false failures. For Maryland markets we therefore look up a real
 * residential parcel near the centre first, and test routing from there.
 */
const ADDRESSES = [
  // Known residential coordinates, the same ones the Fairfax backtest uses.
  { label: "McLean, VA", lat: 38.94, lng: -77.161, expect: "fairfax", locate: false },
  { label: "Vienna, VA", lat: 38.8938, lng: -77.25, expect: "fairfax", locate: false },
  { label: "Bethesda, MD", lat: 38.98836, lng: -77.08292, expect: "maryland", locate: true },
  { label: "Silver Spring, MD", lat: 38.9907, lng: -77.0261, expect: "maryland", locate: true },
  { label: "Rockville, MD", lat: 39.084, lng: -77.1528, expect: "maryland", locate: true },
  { label: "Frederick, MD", lat: 39.4143, lng: -77.4105, expect: "maryland", locate: true },
  { label: "Annapolis, MD", lat: 38.9784, lng: -76.4922, expect: "maryland", locate: true },
  { label: "Salisbury, MD", lat: 38.3607, lng: -75.5994, expect: "maryland", locate: true },
  { label: "Cumberland, MD", lat: 39.6529, lng: -78.7625, expect: "maryland", locate: true },
  { label: "Hagerstown, MD", lat: 39.6418, lng: -77.7199, expect: "maryland", locate: true },
  // Outside every covered source: these must return nothing rather than guess.
  { label: "Capitol Hill, DC", lat: 38.887, lng: -76.993, expect: "dc", locate: true },
  { label: "Petworth, DC", lat: 38.942, lng: -77.023, expect: "dc", locate: true },
  { label: "Anacostia, DC", lat: 38.8637, lng: -76.9836, expect: "dc", locate: true },
  { label: "Leesburg, VA", lat: 39.1157, lng: -77.5636, expect: "none", locate: false },
];

/**
 * Nearest recently-sold house to a point, so the test values a real home.
 *
 * Needed because a neighbourhood centroid lands on whatever happens to be
 * there — a downtown office block in Bethesda, an apartment walk-up in
 * Anacostia — and the engine rightly refuses to value those from house comps.
 */
async function nearestHome(
  which: "maryland" | "dc",
  lat: number,
  lng: number
): Promise<{ lat: number; lng: number } | null> {
  const provider = which === "dc" ? new DcProvider() : new MarylandProvider();
  const sales = await provider.fetchCandidates(
    { location: { lat, lng }, propertyType: "single_family" },
    { radiusMiles: 3, lookbackMonths: 24, limit: 400 }
  );
  const houses = sales.filter(
    s => (s.propertyType === "single_family" || s.propertyType === "townhouse") && s.sqft
  );
  if (!houses.length) return null;
  let best = houses[0];
  let bestD = Infinity;
  for (const h of houses) {
    const d = (h.location.lat - lat) ** 2 + (h.location.lng - lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best.location;
}

async function value(lat: number, lng: number) {
  const location = { lat, lng };
  // Mirrors /api/avm: every covering source runs at once, first by priority
  // that produces a valuation wins.
  const covering = COVERAGE.filter(
    c => lat >= c.bbox.minLat && lat <= c.bbox.maxLat && lng >= c.bbox.minLng && lng <= c.bbox.maxLng
  );
  const attempts = await Promise.all(covering.map(c => attempt(c, location)));
  return attempts.find(Boolean) ?? null;
}

async function attempt(c: (typeof COVERAGE)[number], location: { lat: number; lng: number }) {
  try {
    const provider = c.create();
    const [subjectInfo, comps] = await Promise.all([
      provider.lookupSubject(location),
      provider.fetchCandidates(
        { location, propertyType: "single_family" },
        { radiusMiles: 1.5, lookbackMonths: 12, limit: 200 }
      ),
    ]);
    if (!subjectInfo?.assessedValue && !subjectInfo?.sqft) return null;

    const subject: SubjectProperty = {
      location,
      propertyType: subjectInfo.propertyType ?? "single_family",
      assessedValue: subjectInfo.assessedValue,
      sqft: subjectInfo.sqft,
      lotSqft: subjectInfo.lotSqft,
      yearBuilt: subjectInfo.yearBuilt,
      condition: subjectInfo.condition,
      subdivision: subjectInfo.subdivision,
    };
    const r = valueFromComps(subject, comps);
    if (r.estimate === null) return null;
    return { source: c.name, r, candidates: comps.length };
  } catch (e) {
    console.error(`     ${c.name} errored: ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  let failures = 0;
  console.log(
    `  ${"address".padEnd(20)} ${"source".padEnd(10)} ${"estimate".padStart(12)} ` +
      `${"range".padStart(24)}  conf     ms`
  );
  console.log("  " + "─".repeat(88));

  for (const a of ADDRESSES) {
    let { lat, lng } = a;
    if (a.locate) {
      const home = await nearestHome(a.expect === "dc" ? "dc" : "maryland", lat, lng);
      if (home) ({ lat, lng } = home);
    }
    const t0 = Date.now();
    const out = await value(lat, lng);
    const ms = Date.now() - t0;
    const source = out?.source ?? "none";
    const ok = source === a.expect;
    if (!ok) failures++;

    console.log(
      `  ${a.label.padEnd(20)} ${source.padEnd(10)} ` +
        `${(out ? "$" + out.r.estimate!.toLocaleString() : "—").padStart(12)} ` +
        `${(out ? `$${Math.round(out.r.low! / 1000)}k–$${Math.round(out.r.high! / 1000)}k` : "—").padStart(24)}  ` +
        `${(out?.r.confidence ?? "—").padEnd(7)} ${String(ms).padStart(5)}` +
        `${ok ? "" : `   ← expected ${a.expect}`}`
    );
  }

  console.log("  " + "─".repeat(88));
  console.log(
    failures
      ? `  ${failures} address(es) did not route as expected.`
      : "  All addresses routed to the expected source."
  );
  process.exit(failures ? 1 : 0);
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
