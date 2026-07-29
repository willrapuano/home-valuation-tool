/**
 * Why is Maryland less accurate than Fairfax?
 *
 * Measures field population, the sale-to-assessed ratio distribution, and the
 * implied price per square foot per market — the three things that would
 * explain a 12.9% median error against Fairfax's 5.2%.
 */
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

const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctile = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const share = (rows: ComparableSale[], f: (c: ComparableSale) => unknown) =>
  ((rows.filter(c => f(c) !== undefined && f(c) !== null).length / rows.length) * 100).toFixed(0);

async function main() {
  const p = new MarylandProvider();

  console.log("FIELD POPULATION (% of sales carrying each field)\n");
  console.log(
    "  market          n     sqft  lot   year  grade  subdiv  assessed  zip"
  );

  const pools: Record<string, ComparableSale[]> = {};

  for (const m of MARKETS) {
    const pool = await p.fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    pools[m.name] = pool;
    console.log(
      `  ${m.name.padEnd(15)} ${String(pool.length).padStart(4)}  ` +
        `${share(pool, c => c.sqft).padStart(4)}% ${share(pool, c => c.lotSqft).padStart(4)}% ` +
        `${share(pool, c => c.yearBuilt).padStart(4)}% ${share(pool, c => c.condition).padStart(5)}% ` +
        `${share(pool, c => c.subdivision).padStart(6)}% ${share(pool, c => c.assessedValue).padStart(8)}% ` +
        `${share(pool, c => c.zipCode).padStart(4)}%`
    );
  }

  console.log("\n\nSALE-TO-ASSESSED RATIO  — the knockout band is median ±25%\n");
  console.log("  market            n   p10    p25   median   p75    p90    spread  %knocked");
  for (const m of MARKETS) {
    const ratios = pools[m.name]
      .filter(c => c.assessedValue && c.assessedValue > 0)
      .map(c => c.soldPrice / c.assessedValue!);
    if (ratios.length < 8) {
      console.log(`  ${m.name.padEnd(15)} too few assessed values (${ratios.length})`);
      continue;
    }
    const md = med(ratios);
    const lo = md * 0.75;
    const hi = md * 1.25;
    const knocked = ratios.filter(r => r < lo || r > hi).length / ratios.length;
    console.log(
      `  ${m.name.padEnd(15)} ${String(ratios.length).padStart(4)}  ` +
        `${pctile(ratios, 0.1).toFixed(2)}  ${pctile(ratios, 0.25).toFixed(2)}  ` +
        `${md.toFixed(2).padStart(6)}  ${pctile(ratios, 0.75).toFixed(2)}  ${pctile(ratios, 0.9).toFixed(2)}  ` +
        `${(pctile(ratios, 0.9) / pctile(ratios, 0.1)).toFixed(2)}x  ${(knocked * 100).toFixed(0).padStart(6)}%`
    );
  }

  console.log("\n\nIMPLIED $/SQFT  — engine assumes a flat $250 everywhere (NOVA_MARKET)\n");
  console.log("  market            n   p25   median    p75    median sale price");
  for (const m of MARKETS) {
    const rows = pools[m.name].filter(c => c.sqft && c.sqft > 300 && c.propertyType === "single_family");
    if (!rows.length) continue;
    const ppsf = rows.map(c => c.soldPrice / c.sqft!);
    console.log(
      `  ${m.name.padEnd(15)} ${String(rows.length).padStart(4)}  ` +
        `$${pctile(ppsf, 0.25).toFixed(0).padStart(4)}  $${med(ppsf).toFixed(0).padStart(4)}  ` +
        `$${pctile(ppsf, 0.75).toFixed(0).padStart(4)}   ` +
        `$${med(rows.map(c => c.soldPrice)).toLocaleString()}`
    );
  }

  console.log("\n\nSUBDIVISION VALUES — are these names or opaque codes?\n");
  for (const m of MARKETS) {
    const vals = [...new Set(pools[m.name].map(c => c.subdivision).filter(Boolean))].slice(0, 6);
    console.log(`  ${m.name.padEnd(15)} ${vals.join(" | ") || "(none)"}`);
  }

  console.log("\n\nGRADE → CONDITION distribution\n");
  for (const m of MARKETS) {
    const counts = new Map<number, number>();
    for (const c of pools[m.name]) if (c.condition) counts.set(c.condition, (counts.get(c.condition) ?? 0) + 1);
    const parts = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`);
    console.log(`  ${m.name.padEnd(15)} ${parts.join("  ") || "(none)"}`);
  }
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
