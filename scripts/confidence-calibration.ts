/**
 * When we tell a homeowner "low confidence", what are they actually getting?
 *
 * The engine publishes a point estimate at every confidence level, with a
 * wider range at lower confidence. That is internally consistent, but it is
 * not obviously the right product: a wide range still anchors on the number in
 * the middle of it, and an anchor that is badly wrong damages the agent
 * relationship the tool exists to create.
 *
 * The question is not "is the range honest" — it is. It is "how often is the
 * NUMBER badly wrong", which is a different quantity and the one a homeowner
 * actually experiences. This measures it per confidence bucket across all
 * three jurisdictions, so the display rule can be set from evidence.
 *
 *   npx tsx scripts/confidence-calibration.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider } from "../lib/comps/types";

const N = Number(process.argv[2]) || 35;

/** Fairfax assessments are dated 1 Jan 2026; only later sales are clean. */
const FAIRFAX_ASSESSMENT_DATE = "2026-01-01";

const MARKETS: {
  jurisdiction: string;
  name: string;
  lat: number;
  lng: number;
  provider: () => CompsProvider;
  assessmentDate?: string;
}[] = [
  { jurisdiction: "dc", name: "Capitol Hill", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Petworth", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Anacostia", lat: 38.8637, lng: -76.9836, provider: () => new DcProvider() },
  { jurisdiction: "maryland", name: "Bethesda", lat: 38.98836, lng: -77.08292, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", name: "Silver Spring", lat: 38.9907, lng: -77.0261, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", name: "Frederick", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", name: "Annapolis", lat: 38.9784, lng: -76.4922, provider: () => new MarylandProvider() },
  {
    jurisdiction: "fairfax", name: "McLean", lat: 38.94, lng: -77.161,
    provider: () => new FairfaxCountyProvider(), assessmentDate: FAIRFAX_ASSESSMENT_DATE,
  },
  {
    jurisdiction: "fairfax", name: "Springfield", lat: 38.7893, lng: -77.1872,
    provider: () => new FairfaxCountyProvider(), assessmentDate: FAIRFAX_ASSESSMENT_DATE,
  },
];

interface Row {
  jurisdiction: string;
  confidence: string;
  absErrorPct: number;
  rangeWidthPct: number;
  inRange: boolean;
}

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
const share = (xs: Row[], f: (r: Row) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);

async function collect(): Promise<Row[]> {
  const rows: Row[] = [];

  for (const m of MARKETS) {
    try {
      const pool = await m.provider().fetchCandidates(
        { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
        { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
      );
      let usable = pool.filter(
        c => c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other" && c.propertyType !== "land"
      );
      // Fairfax publishes no characteristics, so its holdouts must post-date
      // the assessment or the assessment has seen the sale.
      const testable = m.assessmentDate
        ? usable.filter(c => c.soldDate > m.assessmentDate!)
        : usable;

      const step = Math.max(1, Math.floor(testable.length / N));
      const subs = testable.filter((_, i) => i % step === 0).slice(0, N);

      for (const s of subs) {
        const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
        if (cands.length < 10) continue;

        const r = valueFromComps(
          {
            location: s.location,
            propertyType: s.propertyType,
            sqft: s.sqft,
            lotSqft: s.lotSqft,
            beds: s.beds,
            baths: s.baths,
            yearBuilt: s.yearBuilt,
            condition: s.condition,
            subdivision: s.subdivision,
            assessedValue: s.assessedValue,
          },
          cands,
          { asOf: dayBefore(s.soldDate) }
        );
        if (r.estimate === null) continue;

        rows.push({
          jurisdiction: m.jurisdiction,
          confidence: r.confidence,
          absErrorPct: Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100),
          rangeWidthPct: ((r.high! - r.low!) / r.estimate) * 100,
          inRange: s.soldPrice >= r.low! && s.soldPrice <= r.high!,
        });
      }
      process.stdout.write(`  ${m.jurisdiction}/${m.name}: ${subs.length} subjects\n`);
    } catch (err) {
      console.error(`  ${m.name} failed: ${(err as Error)?.message}`);
    }
  }
  return rows;
}

function report(label: string, rows: Row[]) {
  if (!rows.length) {
    console.log(`  ${label.padEnd(12)} —`);
    return;
  }
  console.log(
    `  ${label.padEnd(12)} n=${String(rows.length).padStart(4)}  ` +
      `MdAPE ${med(rows.map(r => r.absErrorPct)).toFixed(1).padStart(5)}%  ` +
      `off>20% ${(share(rows, r => r.absErrorPct > 20) * 100).toFixed(0).padStart(3)}%  ` +
      `off>30% ${(share(rows, r => r.absErrorPct > 30) * 100).toFixed(0).padStart(3)}%  ` +
      `range width ${med(rows.map(r => r.rangeWidthPct)).toFixed(0).padStart(3)}%  ` +
      `in-range ${(share(rows, r => r.inRange) * 100).toFixed(0).padStart(3)}%`
  );
}

async function main() {
  const rows = await collect();
  if (!rows.length) {
    console.error("No predictions produced.");
    process.exit(1);
  }

  console.log(`\n${"═".repeat(104)}`);
  console.log("WHAT EACH CONFIDENCE LABEL DELIVERS  — pooled across DC, Maryland and Fairfax");
  console.log("═".repeat(104));
  for (const c of ["high", "medium", "low"]) {
    report(c, rows.filter(r => r.confidence === c));
  }
  console.log("  " + "─".repeat(100));
  report("ALL", rows);

  console.log(`\n${"═".repeat(104)}`);
  console.log("SHARE OF ALL VALUATIONS BY CONFIDENCE");
  console.log("═".repeat(104));
  for (const c of ["high", "medium", "low"]) {
    const n = rows.filter(r => r.confidence === c).length;
    console.log(`  ${c.padEnd(12)} ${((n / rows.length) * 100).toFixed(0).padStart(3)}%  (${n})`);
  }

  console.log(`\n${"═".repeat(104)}`);
  console.log("THE DECISION");
  console.log("═".repeat(104));
  const low = rows.filter(r => r.confidence === "low");
  const med20 = share(rows.filter(r => r.confidence === "medium"), r => r.absErrorPct > 20);
  const low20 = share(low, r => r.absErrorPct > 20);
  console.log(
    `  At LOW confidence ${(low20 * 100).toFixed(0)}% of estimates are off by more than 20%,\n` +
      `  and the published range is a median ${med(low.map(r => r.rangeWidthPct)).toFixed(0)}% wide.\n` +
      `  At MEDIUM, ${(med20 * 100).toFixed(0)}% are off by more than 20%.\n\n` +
      `  A number anchors regardless of the range printed around it. If a third of\n` +
      `  low-confidence estimates are 20%+ wrong, that anchor costs more trust than\n` +
      `  the estimate wins — and the funnel converts on the CMA offer, not the number.`
  );
}

main().catch(err => {
  console.error("Calibration failed:", err?.message ?? err);
  process.exit(1);
});
