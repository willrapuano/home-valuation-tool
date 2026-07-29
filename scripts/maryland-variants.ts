/**
 * Same subjects, same comps, different valuation bases.
 *
 * The Fairfax engine reaches 5.2% median error using assessed value as the
 * adjustment basis. Maryland publishes assessments for 100% of parcels but the
 * first Maryland backtest ignored them and used the physical grid. This runs
 * the variants head to head on an identical holdout set so the choice is
 * measured rather than argued.
 *
 *   npx tsx scripts/maryland-variants.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, SubjectProperty } from "../lib/comps/types";

const MARKETS = [
  { name: "Bethesda", lat: 38.98836, lng: -77.08292 },
  { name: "Silver Spring", lat: 38.9907, lng: -77.0261 },
  { name: "Rockville", lat: 39.084, lng: -77.1528 },
  { name: "Columbia", lat: 39.2037, lng: -76.861 },
  { name: "Annapolis", lat: 38.9784, lng: -76.4922 },
  { name: "Frederick", lat: 39.4143, lng: -77.4105 },
];
const N = Number(process.argv[2]) || 35;

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

/**
 * Each variant describes the subject differently. The comps are untouched, so
 * any difference is attributable to the adjustment basis alone.
 */
const VARIANTS: { name: string; subject: (s: ComparableSale) => SubjectProperty }[] = [
  {
    name: "physical only",
    subject: s => ({
      location: s.location,
      propertyType: s.propertyType,
      sqft: s.sqft,
      lotSqft: s.lotSqft,
      yearBuilt: s.yearBuilt,
      condition: s.condition,
      subdivision: s.subdivision,
    }),
  },
  {
    name: "assessed only",
    subject: s => ({
      location: s.location,
      propertyType: s.propertyType,
      assessedValue: s.assessedValue,
      subdivision: s.subdivision,
    }),
  },
  {
    name: "assessed + physical",
    subject: s => ({
      location: s.location,
      propertyType: s.propertyType,
      sqft: s.sqft,
      lotSqft: s.lotSqft,
      yearBuilt: s.yearBuilt,
      condition: s.condition,
      subdivision: s.subdivision,
      assessedValue: s.assessedValue,
    }),
  },
];

interface Out {
  variant: string;
  market: string;
  errorPct: number;
  absErrorPct: number;
  confidence: string;
  inRange: boolean;
}

function report(label: string, rows: Out[]) {
  if (!rows.length) {
    console.log(`  ${label.padEnd(21)} —`);
    return;
  }
  const abs = rows.map(r => r.absErrorPct);
  const w10 = rows.filter(r => r.absErrorPct <= 10).length / rows.length;
  const w20 = rows.filter(r => r.absErrorPct <= 20).length / rows.length;
  const ir = rows.filter(r => r.inRange).length / rows.length;
  const bias = med(rows.map(r => r.errorPct));
  console.log(
    `  ${label.padEnd(21)} n=${String(rows.length).padStart(4)}  ` +
      `MdAPE ${med(abs).toFixed(1).padStart(5)}%  ` +
      `≤10% ${(w10 * 100).toFixed(0).padStart(3)}%  ` +
      `≤20% ${(w20 * 100).toFixed(0).padStart(3)}%  ` +
      `in-range ${(ir * 100).toFixed(0).padStart(3)}%  ` +
      `med bias ${((bias >= 0 ? "+" : "") + bias.toFixed(1)).padStart(6)}%`
  );
}

async function main() {
  const p = new MarylandProvider();
  const all: Out[] = [];

  for (const m of MARKETS) {
    try {
      const pool = await p.fetchCandidates(
        { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
        { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
      );
      // Only subjects carrying BOTH bases, so the variants are compared on an
      // identical set rather than on whichever subset each one happened to
      // support.
      const usable = pool.filter(
        c => c.sqft && c.sqft > 0 && c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other"
      );
      const step = Math.max(1, Math.floor(usable.length / N));
      const subs = usable.filter((_, i) => i % step === 0).slice(0, N);

      for (const s of subs) {
        const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
        if (cands.length < 10) continue;
        for (const v of VARIANTS) {
          const r = valueFromComps(v.subject(s), cands, { asOf: dayBefore(s.soldDate) });
          if (r.estimate === null) continue;
          const e = ((r.estimate - s.soldPrice) / s.soldPrice) * 100;
          all.push({
            variant: v.name,
            market: m.name,
            errorPct: e,
            absErrorPct: Math.abs(e),
            confidence: r.confidence,
            inRange: s.soldPrice >= r.low! && s.soldPrice <= r.high!,
          });
        }
      }
      console.log(`  ${m.name}: ${subs.length} subjects`);
    } catch (e) {
      console.error(`  ${m.name} failed: ${(e as Error).message}`);
    }
  }

  console.log(`\n${"═".repeat(104)}\nOVERALL BY VARIANT\n${"═".repeat(104)}`);
  for (const v of VARIANTS) report(v.name, all.filter(r => r.variant === v.name));

  for (const m of MARKETS) {
    console.log(`\n${m.name}`);
    for (const v of VARIANTS) report(v.name, all.filter(r => r.variant === v.name && r.market === m.name));
  }

  console.log(`\n${"═".repeat(104)}\nBY CONFIDENCE, best variant only\n${"═".repeat(104)}`);
  const best = VARIANTS.map(v => ({
    name: v.name,
    score: med(all.filter(r => r.variant === v.name).map(r => r.absErrorPct)),
  })).sort((a, b) => a.score - b.score)[0];
  console.log(`  (best = ${best.name})`);
  for (const c of ["high", "medium", "low"]) {
    report(c, all.filter(r => r.variant === best.name && r.confidence === c));
  }
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
