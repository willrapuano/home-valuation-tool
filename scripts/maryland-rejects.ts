/**
 * Where do Maryland comps go? Aggregates knockout reasons, surviving comp
 * counts and derived market constants across a backtest run, so the accuracy
 * gap can be attributed rather than guessed at.
 */
import { valueFromComps } from "../lib/comps";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale } from "../lib/comps/types";

const MARKETS = [
  { name: "Bethesda", lat: 38.98836, lng: -77.08292 },
  { name: "Silver Spring", lat: 38.9907, lng: -77.0261 },
  { name: "Annapolis", lat: 38.9784, lng: -76.4922 },
  { name: "Columbia", lat: 39.2037, lng: -76.861 },
];
const N = Number(process.argv[2]) || 25;

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

/** Collapse a reason string to its category. */
function bucket(reason: string): string {
  if (reason.includes("assessed value")) return "assessment-ratio band";
  if (reason.includes("gross adjustments")) return "gross adjustment cap";
  if (reason.includes("miles away")) return "distance";
  if (reason.includes("months ago")) return "recency";
  if (reason.includes("sqft is")) return "size band";
  if (reason.includes("property type")) return "property type";
  return reason.slice(0, 40);
}

async function main() {
  const p = new MarylandProvider();

  for (const m of MARKETS) {
    const pool = await p.fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    const usable = pool.filter(c => c.sqft && c.sqft > 0 && c.propertyType !== "other");
    const step = Math.max(1, Math.floor(usable.length / N));
    const subs = usable.filter((_, i) => i % step === 0).slice(0, N);

    const reasons = new Map<string, number>();
    const compCounts: number[] = [];
    const ppsf: number[] = [];
    const appr: number[] = [];
    const errs: number[] = [];
    let candTotal = 0;

    for (const s of subs) {
      const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
      if (!cands.length) continue;
      const r = valueFromComps(
        {
          location: s.location,
          propertyType: s.propertyType,
          sqft: s.sqft,
          lotSqft: s.lotSqft,
          yearBuilt: s.yearBuilt,
          condition: s.condition,
          subdivision: s.subdivision,
        },
        cands,
        { asOf: dayBefore(s.soldDate) }
      );
      candTotal += cands.length;
      for (const rej of r.rejected) reasons.set(bucket(rej.reason), (reasons.get(bucket(rej.reason)) ?? 0) + 1);
      if (r.estimate === null) continue;
      compCounts.push(r.comps.length);
      if (r.market) {
        ppsf.push(r.market.pricePerSqft);
        appr.push(r.market.annualAppreciation);
      }
      errs.push(((r.estimate - s.soldPrice) / s.soldPrice) * 100);
    }

    console.log(`\n${"═".repeat(78)}\n${m.name}  — ${subs.length} subjects, ${candTotal} candidate-evaluations`);
    console.log("═".repeat(78));
    console.log(
      `  derived $/sqft ${med(ppsf).toFixed(0).padStart(4)}   ` +
        `appreciation ${(med(appr) * 100).toFixed(1)}%/yr   ` +
        `median comps used ${med(compCounts)}   ` +
        `bias ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)}%`
    );
    console.log("  knockouts:");
    for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(26)} ${String(v).padStart(6)}  (${((v / candTotal) * 100).toFixed(1)}% of candidates)`);
    }
  }
}
main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
