/**
 * Fairfax data-source canary.
 *
 * Exits non-zero when the source is broken, so it can run on a schedule in CI
 * and tell you the county changed something before a homeowner does.
 *
 *   npx tsx scripts/fairfax-canary.ts
 */
import { checkFairfaxHealth } from "../lib/comps/providers/fairfax";

async function main() {
  const h = await checkFairfaxHealth();

  console.log(`Fairfax County data source — ${h.ok ? "OK" : "FAILING"}`);
  console.log(`  sales returned:      ${h.compCount}`);
  console.log(`  newest sale:         ${h.newestSaleDate} (${h.daysSinceNewestSale} days ago)`);
  console.log(`  land use coverage:   ${(h.landUseCoverage * 100).toFixed(0)}%`);
  console.log(`  median sale/assess:  ${h.medianSaleToAssessedRatio}`);
  console.log(`  assessment year:     ${h.taxYear}`);
  console.log(`  latency:             ${h.latencyMs}ms`);

  for (const w of h.warnings) console.log(`\n  WARNING: ${w}`);
  for (const f of h.failures) console.log(`\n  FAILURE: ${f}`);

  if (!h.ok) process.exit(1);
}

main().catch(err => {
  console.error("Canary itself failed:", err?.message ?? err);
  process.exit(1);
});
