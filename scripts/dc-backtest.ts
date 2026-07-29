/**
 * Holdout backtest of the engine against real District of Columbia sales, plus
 * a measurement of what DC's arm's-length flag is worth.
 *
 * Each subject is valued as of the day before it sold, from sales that had
 * already closed, with the subject excluded from its own comp set.
 *
 * DC is the only source that states whether a sale was arm's-length rather
 * than leaving it to be inferred, and 59% of recent sales are marked
 * unqualified. The QUALIFIED comparison below is therefore the interesting
 * number here, not just the headline error.
 *
 * LEAKAGE: this extract publishes no assessment date, so a sale could in
 * principle have informed the assessment being fed in — the guard used in the
 * Fairfax backtest cannot be applied. Read these as a slightly optimistic
 * bound, as with Maryland.
 *
 *   npx tsx scripts/dc-backtest.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
import { DcProvider } from "../lib/comps/providers/dc";
import { ComparableSale } from "../lib/comps/types";

const MARKETS = [
  { name: "Columbia Heights", lat: 38.935, lng: -77.03 },
  { name: "Capitol Hill", lat: 38.887, lng: -76.993 },
  { name: "Petworth", lat: 38.942, lng: -77.023 },
  { name: "Georgetown", lat: 38.91, lng: -77.065 },
  { name: "Anacostia", lat: 38.8637, lng: -76.9836 },
  { name: "Chevy Chase DC", lat: 38.9686, lng: -77.0736 },
];
const N = Number(process.argv[2]) || 40;

interface Outcome {
  market: string;
  variant: string;
  actual: number;
  errorPct: number;
  absErrorPct: number;
  confidence: string;
  withinRange: boolean;
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
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function report(label: string, rows: Outcome[]) {
  if (!rows.length) {
    console.log(`  ${label.padEnd(18)} —  no predictions`);
    return;
  }
  const abs = rows.map(r => r.absErrorPct);
  const w10 = rows.filter(r => r.absErrorPct <= 10).length / rows.length;
  const w20 = rows.filter(r => r.absErrorPct <= 20).length / rows.length;
  const ir = rows.filter(r => r.withinRange).length / rows.length;
  console.log(
    `  ${label.padEnd(18)} n=${String(rows.length).padStart(3)}  ` +
      `MdAPE ${med(abs).toFixed(1).padStart(5)}%  ` +
      `≤10% ${(w10 * 100).toFixed(0).padStart(3)}%  ` +
      `≤20% ${(w20 * 100).toFixed(0).padStart(3)}%  ` +
      `in-range ${(ir * 100).toFixed(0).padStart(3)}%  ` +
      `med bias ${pct(med(rows.map(r => r.errorPct))).padStart(6)}`
  );
}

async function main() {
  const all: Outcome[] = [];

  // Two pools per market: one keeping every sale, one keeping only the sales
  // DC's assessor marked arm's-length.
  const VARIANTS = [
    { name: "all sales", provider: new DcProvider({ qualifiedOnly: false }) },
    { name: "qualified only", provider: new DcProvider({ qualifiedOnly: true }) },
  ];

  for (const m of MARKETS) {
    for (const v of VARIANTS) {
      try {
        const pool = await v.provider.fetchCandidates(
          { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
          { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
        );
        const usable = pool.filter(
          c => c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other" && c.propertyType !== "land"
        );
        const step = Math.max(1, Math.floor(usable.length / N));
        const subs = usable.filter((_, i) => i % step === 0).slice(0, N);

        for (const s of subs) {
          const cands: ComparableSale[] = usable.filter(
            c => c.id !== s.id && c.soldDate < s.soldDate
          );
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

          const e = ((r.estimate - s.soldPrice) / s.soldPrice) * 100;
          all.push({
            market: m.name,
            variant: v.name,
            actual: s.soldPrice,
            errorPct: e,
            absErrorPct: Math.abs(e),
            confidence: r.confidence,
            withinRange: s.soldPrice >= r.low! && s.soldPrice <= r.high!,
          });
        }
        process.stdout.write(`  ${m.name} / ${v.name}: ${pool.length} sales\n`);
      } catch (err) {
        console.error(`  ${m.name} / ${v.name} failed: ${(err as Error)?.message}`);
      }
    }
  }

  if (!all.length) {
    console.error("\nNo predictions produced.");
    process.exit(1);
  }

  console.log(`\n${"═".repeat(100)}`);
  console.log("DOES DC's ARM'S-LENGTH FLAG HELP?  — 59% of DC sales are marked unqualified");
  console.log("═".repeat(100));
  for (const v of ["all sales", "qualified only"]) {
    report(v, all.filter(r => r.variant === v));
  }

  const best = ["all sales", "qualified only"]
    .map(v => ({ v, s: med(all.filter(r => r.variant === v).map(r => r.absErrorPct)) }))
    .sort((a, b) => a.s - b.s)[0].v;

  console.log(`\n${"═".repeat(100)}`);
  console.log(`BY NEIGHBOURHOOD  (${best})`);
  console.log("═".repeat(100));
  for (const m of MARKETS) {
    report(m.name, all.filter(r => r.variant === best && r.market === m.name));
  }

  console.log(`\n${"═".repeat(100)}`);
  console.log("BY CONFIDENCE  — does the label predict accuracy?");
  console.log("═".repeat(100));
  for (const c of ["high", "medium", "low"]) {
    report(c, all.filter(r => r.variant === best && r.confidence === c));
  }

  console.log(`\n${"═".repeat(100)}`);
  report("OVERALL", all.filter(r => r.variant === best));
  console.log("═".repeat(100));
}

main().catch(err => {
  console.error("DC backtest failed:", err?.message ?? err);
  process.exit(1);
});
