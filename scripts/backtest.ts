/**
 * Holdout backtest of the valuation engine against real closed sales.
 *
 * For each test property: run the engine as of the day before it sold, using
 * only sales that closed BEFORE that date, with the property itself excluded
 * from its own comp set. Then compare the prediction to what it actually
 * fetched.
 *
 *   npx tsx scripts/backtest.ts [samplesPerMarket]
 *
 * METHODOLOGY NOTE — why only 2026 sales are tested:
 *
 * Fairfax assessments carry TAXYR 2026, meaning they were set as of 1 Jan
 * 2026. The engine uses assessed value as its main input, so testing a sale
 * from 2025 would leak information: that sale would have informed the
 * assessment we're feeding in. Restricting the test set to sales that closed
 * AFTER the assessment date makes each prediction genuinely out-of-sample.
 */

import { valueFromComps } from "../lib/comps";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { ComparableSale } from "../lib/comps/types";

const SAMPLES_PER_MARKET = Number(process.argv[2]) || 40;

/** Assessments are dated 1 Jan 2026; only later sales are clean holdouts. */
const ASSESSMENT_DATE = "2026-01-01";

const MARKETS = [
  { name: "McLean", lat: 38.94, lng: -77.161 },
  { name: "Vienna", lat: 38.8938, lng: -77.25 },
  { name: "Burke", lat: 38.80701, lng: -77.26485 },
  { name: "Reston", lat: 38.94127, lng: -77.37368 },
  { name: "Annandale", lat: 38.85175, lng: -77.19818 },
  { name: "Springfield", lat: 38.7893, lng: -77.1872 },
];

interface Outcome {
  market: string;
  actual: number;
  predicted: number;
  errorPct: number;
  absErrorPct: number;
  confidence: string;
  confidenceScore: number;
  compCount: number;
  withinRange: boolean;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** One day before the given ISO date, so the sale itself is never "today". */
function dayBefore(iso: string): string {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function backtestMarket(market: (typeof MARKETS)[number]): Promise<Outcome[]> {
  const provider = new FairfaxCountyProvider();

  // A wide window so each test property has a deep pool of prior sales.
  const pool = await provider.fetchCandidates(
    { location: { lat: market.lat, lng: market.lng }, propertyType: "single_family" },
    { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
  );

  const usable = pool.filter(c => c.assessedValue && c.assessedValue > 0);

  // Only sales after the assessment date are genuine holdouts.
  const testable = usable
    .filter(c => c.soldDate > ASSESSMENT_DATE && c.propertyType !== "other")
    .sort((a, b) => b.soldDate.localeCompare(a.soldDate));

  // Spread the sample across the window rather than taking only the newest.
  const step = Math.max(1, Math.floor(testable.length / SAMPLES_PER_MARKET));
  const subjects = testable.filter((_, i) => i % step === 0).slice(0, SAMPLES_PER_MARKET);

  const outcomes: Outcome[] = [];

  for (const subject of subjects) {
    const asOf = dayBefore(subject.soldDate);

    // Everything that had closed before the subject sold, minus the subject.
    const candidates: ComparableSale[] = usable.filter(
      c => c.id !== subject.id && c.soldDate < subject.soldDate
    );

    const result = valueFromComps(
      {
        location: subject.location,
        propertyType: subject.propertyType,
        assessedValue: subject.assessedValue,
      },
      candidates,
      { asOf }
    );

    if (result.estimate === null) continue;

    const errorPct = ((result.estimate - subject.soldPrice) / subject.soldPrice) * 100;

    outcomes.push({
      market: market.name,
      actual: subject.soldPrice,
      predicted: result.estimate,
      errorPct,
      absErrorPct: Math.abs(errorPct),
      confidence: result.confidence,
      confidenceScore: result.confidenceScore,
      compCount: result.comps.length,
      withinRange: subject.soldPrice >= result.low! && subject.soldPrice <= result.high!,
    });
  }

  return outcomes;
}

function report(label: string, rows: Outcome[]) {
  if (!rows.length) {
    console.log(`  ${label.padEnd(14)} —  no predictions`);
    return;
  }
  const abs = rows.map(r => r.absErrorPct);
  const within10 = rows.filter(r => r.absErrorPct <= 10).length / rows.length;
  const within20 = rows.filter(r => r.absErrorPct <= 20).length / rows.length;
  const inRange = rows.filter(r => r.withinRange).length / rows.length;
  const bias = rows.reduce((s, r) => s + r.errorPct, 0) / rows.length;

  console.log(
    `  ${label.padEnd(14)} n=${String(rows.length).padStart(3)}  ` +
      `MdAPE ${median(abs).toFixed(1).padStart(5)}%  ` +
      `≤10% ${(within10 * 100).toFixed(0).padStart(3)}%  ` +
      `≤20% ${(within20 * 100).toFixed(0).padStart(3)}%  ` +
      `in-range ${(inRange * 100).toFixed(0).padStart(3)}%  ` +
      `bias ${pct(bias).padStart(6)}`
  );
}

async function main() {
  console.log(`Holdout backtest — sales after ${ASSESSMENT_DATE}, subject excluded from its own comps\n`);

  const all: Outcome[] = [];
  for (const m of MARKETS) {
    try {
      const rows = await backtestMarket(m);
      all.push(...rows);
      process.stdout.write(`  fetched ${m.name}: ${rows.length} predictions\n`);
    } catch (err) {
      console.error(`  ${m.name} failed: ${(err as Error)?.message}`);
    }
  }

  if (!all.length) {
    console.error("\nNo predictions produced — nothing to measure.");
    process.exit(1);
  }

  console.log(`\n${"═".repeat(96)}`);
  console.log("BY MARKET");
  console.log("═".repeat(96));
  for (const m of MARKETS) report(m.name, all.filter(r => r.market === m.name));

  console.log(`\n${"═".repeat(96)}`);
  console.log("BY CONFIDENCE BUCKET  — does the confidence score actually predict accuracy?");
  console.log("═".repeat(96));
  for (const c of ["high", "medium", "low"]) report(c, all.filter(r => r.confidence === c));

  console.log(`\n${"═".repeat(96)}`);
  console.log("BY PRICE BAND");
  console.log("═".repeat(96));
  const bands: [string, (n: number) => boolean][] = [
    ["<$700k", n => n < 700_000],
    ["$700k–1.2M", n => n >= 700_000 && n < 1_200_000],
    ["$1.2M–2M", n => n >= 1_200_000 && n < 2_000_000],
    ["≥$2M", n => n >= 2_000_000],
  ];
  for (const [label, test] of bands) report(label, all.filter(r => test(r.actual)));

  console.log(`\n${"═".repeat(96)}`);
  report("OVERALL", all);
  console.log("═".repeat(96));

  const worst = [...all].sort((a, b) => b.absErrorPct - a.absErrorPct).slice(0, 5);
  console.log("\nWorst 5 misses:");
  for (const w of worst) {
    console.log(
      `  ${w.market.padEnd(12)} actual $${w.actual.toLocaleString().padStart(10)}  ` +
        `predicted $${w.predicted.toLocaleString().padStart(10)}  ${pct(w.errorPct).padStart(7)}  ` +
        `(${w.confidence}, ${w.compCount} comps)`
    );
  }

  console.log(
    "\nMdAPE = median absolute percent error. Zillow reports ~2-3% for on-market\n" +
      "homes and ~7% off-market; every home here is off-market by construction."
  );
}

main().catch(err => {
  console.error("Backtest failed:", err?.message ?? err);
  process.exit(1);
});
