/**
 * Is a 1.5-mile search radius right everywhere?
 *
 * It was picked once, for Fairfax, and has applied to every jurisdiction since.
 * But 1.5 miles means very different things in different places: in Frederick
 * it is a coherent neighbourhood, while in Bethesda it spans teardowns and
 * $3M rebuilds, and in Silver Spring it crosses submarkets that have little to
 * do with one another.
 *
 * Maryland's weakest markets are exactly the dense expensive ones — Bethesda
 * and Silver Spring at ~9% against Columbia's 5.3% — which is what you would
 * expect if the radius were letting in comps from a different market.
 *
 * Swept across ALL THREE jurisdictions, because the radius is shared engine
 * config and the ratio-band sweep just demonstrated how easily a change that
 * helps one source hurts another.
 *
 *   npx tsx scripts/radius-sweep.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider } from "../lib/comps/types";

const MARKETS: {
  name: string;
  jurisdiction: string;
  lat: number;
  lng: number;
  provider: () => CompsProvider;
  /** Maryland runs a looser band in production; mirror that here. */
  ratioDev?: number;
  assessmentDate?: string;
}[] = [
  { jurisdiction: "maryland", name: "Bethesda", lat: 38.98836, lng: -77.08292, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Silver Spring", lat: 38.9907, lng: -77.0261, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Columbia", lat: 39.2037, lng: -76.861, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Frederick", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "dc", name: "Capitol Hill", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Petworth", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "fairfax", name: "McLean", lat: 38.94, lng: -77.161, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
  { jurisdiction: "fairfax", name: "Springfield", lat: 38.7893, lng: -77.1872, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
];

const N = Number(process.argv[2]) || 40;
/** 1.5 is shipped. */
const RADII = [0.5, 0.75, 1.0, 1.5, 2.0];

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

async function main() {
  const byRadius = new Map<number, number[]>();
  const byJur = new Map<string, Map<number, number[]>>();
  const byMarket = new Map<string, Map<number, number[]>>();
  /** How often no valuation was produced at all — the cost of a tight radius. */
  const attempts = new Map<number, { produced: number; total: number }>();

  for (const m of MARKETS) {
    const pool = await m.provider().fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 3, lookbackMonths: 24, limit: 2000 }
    );
    const usable = pool.filter(
      c => c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other" && c.propertyType !== "land"
    );
    const testable = m.assessmentDate ? usable.filter(c => c.soldDate > m.assessmentDate!) : usable;
    const step = Math.max(1, Math.floor(testable.length / N));
    const subs = testable.filter((_, i) => i % step === 0).slice(0, N);

    byMarket.set(m.name, new Map());
    if (!byJur.has(m.jurisdiction)) byJur.set(m.jurisdiction, new Map());

    for (const s of subs) {
      const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
      if (cands.length < 10) continue;

      const subject = {
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
      };

      for (const radius of RADII) {
        const a = attempts.get(radius) ?? { produced: 0, total: 0 };
        a.total++;
        const r = valueFromComps(subject, cands, {
          asOf: dayBefore(s.soldDate),
          maxDistanceMiles: radius,
          ...(m.ratioDev ? { maxAssessmentRatioDeviation: m.ratioDev } : {}),
        });
        if (r.estimate !== null) {
          a.produced++;
          const e = Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100);
          if (!byRadius.has(radius)) byRadius.set(radius, []);
          byRadius.get(radius)!.push(e);
          const jj = byJur.get(m.jurisdiction)!;
          if (!jj.has(radius)) jj.set(radius, []);
          jj.get(radius)!.push(e);
          const mm = byMarket.get(m.name)!;
          if (!mm.has(radius)) mm.set(radius, []);
          mm.get(radius)!.push(e);
        }
        attempts.set(radius, a);
      }
    }
    process.stdout.write(`  ${m.jurisdiction}/${m.name}: ${subs.length} subjects\n`);
  }

  const base = med(byRadius.get(1.5) ?? []);
  const JURS = ["maryland", "dc", "fairfax"];

  console.log(`\n${"═".repeat(104)}`);
  console.log("SEARCH RADIUS SWEEP  — a tighter radius means better comps but fewer of them");
  console.log("═".repeat(104));
  console.log(
    `  ${"radius".padEnd(9)} ${"ALL".padStart(7)} ${"delta".padStart(8)} ${"valued".padStart(8)}   ` +
      JURS.map(j => j.slice(0, 8).padStart(10)).join("")
  );
  console.log("  " + "─".repeat(100));

  for (const radius of RADII) {
    const rows = byRadius.get(radius) ?? [];
    if (!rows.length) continue;
    const v = med(rows);
    const a = attempts.get(radius)!;
    console.log(
      `  ${`${radius}mi`.padEnd(9)} ${v.toFixed(1).padStart(6)}% ` +
        `${(radius === 1.5 ? "shipped" : `${v - base >= 0 ? "+" : ""}${(v - base).toFixed(1)}pp`).padStart(8)} ` +
        `${((a.produced / a.total) * 100).toFixed(0).padStart(7)}%   ` +
        JURS.map(j => `${med(byJur.get(j)?.get(radius) ?? []).toFixed(1)}%`.padStart(10)).join("")
    );
  }

  console.log(`\n${"═".repeat(104)}`);
  console.log("BY MARKET  — the dense expensive ones are where a wide radius should hurt most");
  console.log("═".repeat(104));
  console.log(`  ${"market".padEnd(16)}` + RADII.map(r => `${r}mi`.padStart(9)).join(""));
  console.log("  " + "─".repeat(100));
  for (const m of MARKETS) {
    console.log(
      `  ${m.name.padEnd(16)}` +
        RADII.map(r => `${med(byMarket.get(m.name)?.get(r) ?? []).toFixed(1)}%`.padStart(9)).join("")
    );
  }
  console.log("═".repeat(104));
  console.log(
    "\n  'valued' is the share of subjects that produced an estimate at all. A tighter\n" +
      "  radius that improves accuracy by refusing to value half the properties has not\n" +
      "  improved anything — it has moved the failure somewhere less visible."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
