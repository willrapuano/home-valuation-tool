/**
 * Removing living area IMPROVES Maryland accuracy by 1.1pp. Which mechanism?
 *
 * Square footage does three things once a good assessment is present, and the
 * assessment already prices size:
 *   1. knockout   — rejects comps outside a 0.65-1.5x size band
 *   2. scoring    — competes with assessed value for similarity weight
 *   3. adjustment — inert at assessmentWeight 1, but confirm it
 *
 * Isolating them says whether to relax the filter, the weight, or both.
 */
import { valueFromComps } from "../lib/comps";
import { DEFAULT_WEIGHTS } from "../lib/comps/config";
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
const N = Number(process.argv[2]) || 40;

const VARIANTS: { label: string; opts: Record<string, unknown>; stripSqft?: boolean }[] = [
  { label: "current defaults", opts: {} },
  { label: "no sqft at all", opts: {}, stripSqft: true },
  { label: "sqft knockout off", opts: { minSqftRatio: 0, maxSqftRatio: 99 } },
  { label: "sqft scoring weight 0", opts: { weights: { ...DEFAULT_WEIGHTS, sqft: 0 } } },
  {
    label: "knockout off + weight 0",
    opts: { minSqftRatio: 0, maxSqftRatio: 99, weights: { ...DEFAULT_WEIGHTS, sqft: 0 } },
  },
  { label: "knockout widened 0.5-2.0", opts: { minSqftRatio: 0.5, maxSqftRatio: 2.0 } },
];

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
  const results = new Map<string, number[]>();
  const byMarket = new Map<string, Map<string, number[]>>();

  for (const m of MARKETS) {
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
      const cands = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
      if (cands.length < 10) continue;

      for (const v of VARIANTS) {
        const comps: ComparableSale[] = v.stripSqft
          ? cands.map(c => ({ ...c, sqft: undefined }))
          : cands;
        const subject = {
          location: s.location,
          propertyType: s.propertyType,
          sqft: v.stripSqft ? undefined : s.sqft,
          lotSqft: s.lotSqft,
          yearBuilt: s.yearBuilt,
          condition: s.condition,
          subdivision: s.subdivision,
          assessedValue: s.assessedValue,
        };
        const r = valueFromComps(subject, comps, { asOf: dayBefore(s.soldDate), ...v.opts });
        if (r.estimate === null) continue;
        const e = Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100);
        if (!results.has(v.label)) results.set(v.label, []);
        results.get(v.label)!.push(e);
        if (!byMarket.has(v.label)) byMarket.set(v.label, new Map());
        const bm = byMarket.get(v.label)!;
        if (!bm.has(m.name)) bm.set(m.name, []);
        bm.get(m.name)!.push(e);
      }
    }
    process.stdout.write(`  ${m.name}\n`);
  }

  const base = med(results.get("current defaults") ?? []);
  console.log(`\n${"═".repeat(100)}`);
  console.log(`  ${"variant".padEnd(26)} ${"MdAPE".padStart(7)} ${"delta".padStart(8)} ${"n".padStart(5)}   ` +
    MARKETS.map(m => m.name.slice(0, 6).padStart(7)).join(""));
  console.log("  " + "─".repeat(96));
  for (const v of VARIANTS) {
    const rows = results.get(v.label) ?? [];
    if (!rows.length) continue;
    const val = med(rows);
    const cells = MARKETS.map(m => `${med(byMarket.get(v.label)?.get(m.name) ?? []).toFixed(1)}`.padStart(7));
    console.log(
      `  ${v.label.padEnd(26)} ${val.toFixed(1).padStart(6)}% ` +
        `${(v.label === "current defaults" ? "—" : `${val - base >= 0 ? "+" : ""}${(val - base).toFixed(1)}pp`).padStart(8)} ` +
        `${String(rows.length).padStart(5)}   ${cells.join("")}`
    );
  }
  console.log("═".repeat(100));
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
