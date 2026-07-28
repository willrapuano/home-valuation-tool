/**
 * Does the derived assessment weight match the weight that actually works?
 *
 * calibrate.ts sets `assessmentWeight` from the IAAO coefficient of dispersion
 * of local sale-to-assessment ratios, using published thresholds rather than
 * anything fitted to this data. That is only defensible if the weight it picks
 * is near the empirical optimum — this sweeps fixed weights against the same
 * holdout set so the two can be compared.
 *
 *   npx tsx scripts/maryland-weight-sweep.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale } from "../lib/comps/types";

const MARKETS = [
  { name: "Bethesda", lat: 38.98836, lng: -77.08292 },
  { name: "Silver Spring", lat: 38.9907, lng: -77.0261 },
  { name: "Rockville", lat: 39.084, lng: -77.1528 },
  { name: "Columbia", lat: 39.2037, lng: -76.861 },
  { name: "Annapolis", lat: 38.9784, lng: -76.4922 },
  { name: "Frederick", lat: 39.4143, lng: -77.4105 },
];
const N = Number(process.argv[2]) || 30;
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1];

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
  const p = new MarylandProvider();
  // market -> label -> abs errors
  const results = new Map<string, Map<string, number[]>>();
  const derivedWeights = new Map<string, number[]>();

  for (const m of MARKETS) {
    const byLabel = new Map<string, number[]>();
    results.set(m.name, byLabel);
    derivedWeights.set(m.name, []);

    const pool = await p.fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    const usable = pool.filter(
      c => c.sqft && c.sqft > 0 && c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other"
    );
    const step = Math.max(1, Math.floor(usable.length / N));
    const subs = usable.filter((_, i) => i % step === 0).slice(0, N);

    for (const s of subs) {
      const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
      if (cands.length < 10) continue;

      const subject = {
        location: s.location,
        propertyType: s.propertyType,
        sqft: s.sqft,
        lotSqft: s.lotSqft,
        yearBuilt: s.yearBuilt,
        condition: s.condition,
        subdivision: s.subdivision,
        assessedValue: s.assessedValue,
      };

      const runs: [string, Record<string, unknown>][] = [
        ...WEIGHTS.map(w => [`w=${w}`, { marketOverrides: { assessmentWeight: w } }] as [string, Record<string, unknown>]),
        ["derived", {}],
      ];

      for (const [label, extra] of runs) {
        const r = valueFromComps(subject, cands, { asOf: dayBefore(s.soldDate), ...extra });
        if (r.estimate === null) continue;
        const e = Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100);
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label)!.push(e);
        if (label === "derived" && r.market) derivedWeights.get(m.name)!.push(r.market.assessmentWeight);
      }
    }
    process.stdout.write(`  ${m.name}: ${subs.length} subjects\n`);
  }

  const labels = [...WEIGHTS.map(w => `w=${w}`), "derived"];
  console.log(`\n${"═".repeat(92)}`);
  console.log("MdAPE BY FIXED ASSESSMENT WEIGHT  (0 = physical grid only, 1 = assessment only)");
  console.log("═".repeat(92));
  console.log(`  ${"market".padEnd(15)} ${labels.map(l => l.padStart(9)).join("")}   best  derived-w`);

  const pooled = new Map<string, number[]>();
  for (const m of MARKETS) {
    const byLabel = results.get(m.name)!;
    const cells = labels.map(l => {
      const v = med(byLabel.get(l) ?? []);
      for (const e of byLabel.get(l) ?? []) {
        if (!pooled.has(l)) pooled.set(l, []);
        pooled.get(l)!.push(e);
      }
      return Number.isFinite(v) ? `${v.toFixed(1)}%`.padStart(9) : "—".padStart(9);
    });
    const bestW = WEIGHTS.map(w => ({ w, v: med(byLabel.get(`w=${w}`) ?? []) }))
      .filter(x => Number.isFinite(x.v))
      .sort((a, b) => a.v - b.v)[0];
    const dw = med(derivedWeights.get(m.name) ?? []);
    console.log(
      `  ${m.name.padEnd(15)}${cells.join("")}   ${String(bestW?.w ?? "—").padStart(4)}   ` +
        `${Number.isFinite(dw) ? dw.toFixed(2) : "—"}`
    );
  }

  console.log("  " + "─".repeat(88));
  const pooledCells = labels.map(l => `${med(pooled.get(l) ?? []).toFixed(1)}%`.padStart(9));
  console.log(`  ${"ALL".padEnd(15)}${pooledCells.join("")}`);
  console.log("═".repeat(92));
  console.log(
    "\nA derived column at or below the best fixed column means the calibration is\n" +
      "picking the right basis per market without being told which market it is in."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
