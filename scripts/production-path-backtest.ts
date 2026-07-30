/**
 * What a homeowner actually gets — measured through the production path.
 *
 * WHY THIS EXISTS, AND WHY THE OTHER BACKTESTS ARE NOT ENOUGH
 *
 * Every other backtest in this directory builds the subject from the holdout's
 * own SALES RECORD: exact living area, beds, baths, year built, assessment,
 * straight off the row being predicted. Production cannot do that. It has a
 * latitude and longitude, and it calls `lookupSubject` to find out what the
 * house is.
 *
 * Those are different systems, and the gap is not academic. DC's subject lookup
 * spent weeks resolving to the wrong parcel entirely — 9 of 10 properties got a
 * neighbour's characteristics — and NO BACKTEST COULD SEE IT, because none of
 * them call `lookupSubject` at all. The published 4.5% described the engine.
 * The product was delivering 23%.
 *
 * So this measures the whole path a request takes:
 *
 *   lat/lng -> lookupSubject -> fetchCandidates -> valueFromComps -> publish gate
 *
 * and reports it beside the record-subject figure, so the two never get quietly
 * conflated again.
 *
 *   npx tsx scripts/production-path-backtest.ts [samplesPerMarket]
 *
 * WHAT IS HELD OUT. The subject's own sale is removed from the candidate pool,
 * along with anything that closed on or after it. Production does not do this —
 * a home that sold three months ago genuinely has its own sale available, and
 * using it is correct behaviour there. But leaving it in measures the engine's
 * ability to read back a number it was handed, so it comes out here.
 *
 * WHAT IS NOT HELD OUT, and cannot be: the assessment. `lookupSubject` returns
 * the CURRENT assessed value, which for an older holdout may already reflect
 * the sale being predicted. That flatters both columns equally, so the
 * comparison between them stands even where the absolute level is optimistic.
 * It is the same limitation the existing backtests carry.
 *
 * COVERAGE IS REPORTED ALONGSIDE ACCURACY, because they trade off and a figure
 * quoted without the other is misleading. `shouldPublishEstimate` withholds low
 * confidence, so "MdAPE among published" is what homeowners experience and
 * "published %" is how often they experience anything at all.
 */
import { valueFromComps } from "../lib/comps";
import { shouldPublishEstimate } from "../lib/comps/publish";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider, SubjectLookup, SubjectProperty } from "../lib/comps/types";

/** Mirrors app/api/avm/route.ts. If those drift, this stops measuring production. */
const RADIUS_MILES = 1.5;
const LOOKBACK_MONTHS = 12;
const CANDIDATE_LIMIT = 200;
/**
 * Retries on the subject lookup. Not production behaviour — production gets one
 * attempt with hedging — but a backtest issues hundreds of requests in a tight
 * loop and gets rate-limited for it. Without this, the script's own load
 * appears as the product failing to cover its own market.
 */
const LOOKUP_ATTEMPTS = 3;

type Provider = CompsProvider & {
  lookupSubject(location: { lat: number; lng: number }): Promise<SubjectLookup | null>;
};

const MARKETS: {
  jurisdiction: string;
  name: string;
  lat: number;
  lng: number;
  provider: () => Provider;
  /** Must mirror COVERAGE.engineOptions for this source. */
  engineOptions?: Record<string, unknown>;
  /** Fairfax assessments are dated 1 Jan; only later sales are clean holdouts. */
  assessmentDate?: string;
}[] = [
  { jurisdiction: "dc", name: "Capitol Hill", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Petworth", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "maryland", name: "Rockville", lat: 39.067, lng: -77.1808, provider: () => new MarylandProvider(), engineOptions: { maxAssessmentRatioDeviation: 0.5 } },
  { jurisdiction: "maryland", name: "Bethesda", lat: 38.98836, lng: -77.08292, provider: () => new MarylandProvider(), engineOptions: { maxAssessmentRatioDeviation: 0.5 } },
  // Maryland is one integration covering 24 jurisdictions, so two Montgomery
  // County towns are not a sample of it. Measured on Rockville and Bethesda
  // alone it publishes 61%; across these four, 85%. The spread is the finding.
  { jurisdiction: "maryland", name: "Frederick", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider(), engineOptions: { maxAssessmentRatioDeviation: 0.5 } },
  { jurisdiction: "maryland", name: "Columbia", lat: 39.2037, lng: -76.861, provider: () => new MarylandProvider(), engineOptions: { maxAssessmentRatioDeviation: 0.5 } },
  { jurisdiction: "fairfax", name: "McLean", lat: 38.94, lng: -77.161, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
  { jurisdiction: "fairfax", name: "Annandale", lat: 38.85175, lng: -77.19818, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
];

const N = Number(process.argv[2]) || 20;

const dayBefore = (iso: string) => {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};
const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");

interface Row {
  jurisdiction: string;
  market: string;
  /** Upstream failed outright — a reliability fact, not a coverage one. */
  upstreamError?: boolean;
  /** Subject built the way the backtests do. */
  recordErr?: number;
  /** Subject built the way production does. */
  liveErr?: number;
  livePublished: boolean;
  liveConfidence: string;
  /** Did lookupSubject resolve the parcel the point is actually in? */
  exact: boolean;
}

async function main() {
  const rows: Row[] = [];
  let attempted = 0;

  for (const m of MARKETS) {
    let pool: ComparableSale[];
    try {
      pool = await m.provider().fetchCandidates(
        { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
        { radiusMiles: 2.5, lookbackMonths: LOOKBACK_MONTHS, limit: 2000 }
      );
    } catch (err) {
      console.error(`  ${m.jurisdiction}/${m.name}: pool fetch failed — ${(err as Error)?.message}`);
      continue;
    }

    const usable = pool.filter(
      c => c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other" && c.propertyType !== "land"
    );
    const testable = m.assessmentDate ? usable.filter(c => c.soldDate > m.assessmentDate!) : usable;
    const step = Math.max(1, Math.floor(testable.length / N));
    const subs = testable.filter((_, i) => i % step === 0).slice(0, N);

    let done = 0;
    for (const s of subs) {
      attempted++;
      const parcel = s.id.split("@")[0];
      // Hold out the subject's own sale and anything at or after it. Production
      // would use them; measuring against them is circular.
      const candidates = usable
        .filter(c => c.id.split("@")[0] !== parcel && c.soldDate < s.soldDate)
        // Mirror the route's fetch cap, which takes the most recent.
        .sort((a, b) => (a.soldDate < b.soldDate ? 1 : -1))
        .slice(0, CANDIDATE_LIMIT);
      if (candidates.length < 10) continue;

      const base = { asOf: dayBefore(s.soldDate), ...(m.engineOptions ?? {}) };
      const row: Row = {
        jurisdiction: m.jurisdiction,
        market: m.name,
        livePublished: false,
        liveConfidence: "none",
        exact: false,
      };

      // (a) The way every existing backtest does it.
      const fromRecord = valueFromComps(
        {
          location: s.location, propertyType: s.propertyType, sqft: s.sqft, lotSqft: s.lotSqft,
          beds: s.beds, baths: s.baths, yearBuilt: s.yearBuilt, condition: s.condition,
          subdivision: s.subdivision, assessedValue: s.assessedValue,
        },
        candidates,
        base
      );
      if (fromRecord.estimate !== null) {
        row.recordErr = Math.abs(((fromRecord.estimate - s.soldPrice) / s.soldPrice) * 100);
      }

      // (b) The way production does it: from the coordinates alone.
      //
      // RETRIED, and the retries matter. A first version of this script counted
      // an upstream timeout as "no estimate" and reported Maryland publishing
      // 53% — half its visitors getting nothing. With retries it publishes 85%.
      // The difference was iMAP rate-limiting a backtest that hammers it in a
      // tight loop, i.e. a property of the measurement, not of the product.
      //
      // Upstream failures are still counted and reported, just separately:
      // "this source is flaky" and "this source cannot value this home" are
      // different problems with different fixes.
      let info: SubjectLookup | null = null;
      let failed = false;
      for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
        try {
          info = await m.provider().lookupSubject(s.location);
          failed = false;
          break;
        } catch {
          failed = true;
        }
      }
      row.upstreamError = failed;

      try {
        if (info) {
          row.exact = info.exactParcel === true;
          const subject: SubjectProperty = {
            location: s.location,
            propertyType: info.propertyType ?? "single_family",
            assessedValue: info.assessedValue, sqft: info.sqft, lotSqft: info.lotSqft,
            beds: info.beds, baths: info.baths, yearBuilt: info.yearBuilt,
            condition: info.condition, subdivision: info.subdivision,
          };
          // Same gate the route applies before valuing at all.
          if (info.assessedValue || info.sqft) {
            const live = valueFromComps(subject, candidates, base);
            row.liveConfidence = live.confidence;
            if (live.estimate !== null) {
              row.liveErr = Math.abs(((live.estimate - s.soldPrice) / s.soldPrice) * 100);
              row.livePublished = shouldPublishEstimate(live).publish;
            }
          }
        }
      } catch {
        // Mapping the result should not fail; if it does, drop the sample.
        row.upstreamError = true;
      }

      rows.push(row);
      done++;
    }
    process.stdout.write(`  ${m.jurisdiction}/${m.name}: ${done} subjects\n`);
  }

  if (!rows.length) {
    console.error("No samples collected.");
    process.exit(1);
  }

  const JURS = ["dc", "maryland", "fairfax"];

  console.log(`\n${"═".repeat(100)}`);
  console.log("PUBLISHED FIGURE vs WHAT PRODUCTION DELIVERS");
  console.log("═".repeat(100));
  console.log(
    `  ${"jurisdiction".padEnd(13)}${"n".padStart(4)}${"paired".padStart(8)}` +
      `${"record subj".padStart(13)}${"live subj".padStart(11)}${"gap".padStart(8)}` +
      `${"published".padStart(11)}${"MdAPE shown".padStart(13)}${"exact".padStart(8)}${"upstream".padStart(10)}`
  );
  console.log("  " + "─".repeat(104));

  for (const j of [...JURS, "ALL"]) {
    const r = j === "ALL" ? rows : rows.filter(x => x.jurisdiction === j);
    if (!r.length) continue;
    // PAIRED ONLY. Taking each median over whatever that column happened to
    // produce compares different subsets of properties and reports the
    // difference as a gap — the same survivorship error that made a tight
    // search radius look accurate in adaptive-radius.ts. Where one path
    // produced no estimate, neither side counts.
    const paired = r.filter(x => x.recordErr !== undefined && x.liveErr !== undefined);
    const rec = med(paired.map(x => x.recordErr!));
    const live = med(paired.map(x => x.liveErr!));
    const shown = med(r.filter(x => x.livePublished).map(x => x.liveErr!).filter(v => v !== undefined));
    // The publish rate answers "can this source value this home", so a source
    // that was simply unreachable must not count against it.
    const reachable = r.filter(x => !x.upstreamError);
    const gap = live - rec;
    if (j === "ALL") console.log("  " + "─".repeat(104));
    console.log(
      `  ${j.padEnd(13)}${String(r.length).padStart(4)}${String(paired.length).padStart(8)}` +
        `${`${rec.toFixed(1)}%`.padStart(13)}${`${live.toFixed(1)}%`.padStart(11)}` +
        `${`${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp`.padStart(8)}` +
        `${pct(reachable.filter(x => x.livePublished).length, reachable.length).padStart(11)}` +
        `${`${shown.toFixed(1)}%`.padStart(13)}` +
        `${pct(r.filter(x => x.exact).length, r.length).padStart(8)}` +
        `${pct(r.filter(x => x.upstreamError).length, r.length).padStart(10)}`
    );
  }

  console.log(`\n${"═".repeat(100)}`);
  console.log("PUBLISH RATE BY MARKET  — a jurisdiction average can hide a market getting nothing");
  console.log("═".repeat(100));
  for (const j of JURS) {
    const markets = [...new Set(rows.filter(x => x.jurisdiction === j).map(x => x.market))];
    for (const name of markets) {
      const r = rows.filter(x => x.market === name && !x.upstreamError);
      if (!r.length) continue;
      console.log(
        `  ${`${j}/${name}`.padEnd(28)}${String(r.length).padStart(4)}` +
          `${pct(r.filter(x => x.livePublished).length, r.length).padStart(11)}`
      );
    }
  }

  console.log(`\n${"═".repeat(100)}`);
  console.log("CONFIDENCE ON THE PRODUCTION PATH");
  console.log("═".repeat(100));
  console.log(`  ${"jurisdiction".padEnd(13)}${"high".padStart(9)}${"medium".padStart(9)}${"low".padStart(9)}${"none".padStart(9)}`);
  for (const j of JURS) {
    const r = rows.filter(x => x.jurisdiction === j);
    if (!r.length) continue;
    console.log(
      `  ${j.padEnd(13)}` +
        ["high", "medium", "low", "none"]
          .map(c => pct(r.filter(x => x.liveConfidence === c).length, r.length).padStart(9))
          .join("")
    );
  }

  console.log(`\n${"═".repeat(100)}`);
  console.log(
    "  'record subj' and 'live subj' are computed over the SAME properties — the\n" +
      "  ones where both paths produced an estimate ('paired'). Comparing each\n" +
      "  column over whatever it happened to answer would report a difference in\n" +
      "  which homes were valued as a difference in accuracy.\n\n" +
      "  A gap between them is subject-lookup quality, not engine quality, and it is\n" +
      "  invisible to every other script here.\n\n" +
      "  'MdAPE shown' is the honest headline: the error of the estimates that were\n" +
      "  actually displayed. 'published' is how often anything was displayed, out of\n" +
      "  the requests where the source was REACHABLE.\n\n" +
      "  'upstream' is how often it was not. That is a reliability number, not a\n" +
      "  coverage one, and it is inflated here by the load this script itself puts\n" +
      "  on the service — production issues one request, not hundreds in a loop."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
