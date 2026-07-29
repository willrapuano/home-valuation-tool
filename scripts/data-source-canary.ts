/**
 * Are all our data sources still working?
 *
 * These are undocumented public GIS services with no versioning, deprecation
 * policy or SLA. Every way they break produces the same output as a
 * legitimately out-of-area address — an empty result and an HTTP 200 — so
 * nothing surfaces unless something goes looking.
 *
 * Exits non-zero when any source is broken, so CI turns red.
 *
 *   npx tsx scripts/data-source-canary.ts
 *
 * NOTE: this replaces the Fairfax-only canary. Two providers were added
 * without extending the safety net, which meant Maryland or DC could have gone
 * down entirely with nothing reporting it.
 */
import { PROVIDER_PROBES, checkProviderHealth } from "../lib/comps/providers/health";
import { checkFairfaxHealth } from "../lib/comps/providers/fairfax";

async function main() {
  const results = await Promise.all(PROVIDER_PROBES.map(checkProviderHealth));

  let broken = 0;
  for (const h of results) {
    const status = h.ok ? "OK" : "FAILING";
    console.log(`\n${h.jurisdiction.toUpperCase()} — ${status}`);
    console.log(`  sales returned:      ${h.compCount}`);
    console.log(`  newest sale:         ${h.newestSaleDate ?? "none"}` +
      (h.daysSinceNewestSale !== null ? ` (${h.daysSinceNewestSale} days ago)` : ""));
    console.log(`  assessment coverage: ${(h.assessedCoverage * 100).toFixed(0)}%`);
    console.log(`  subject lookup:      ${h.subjectLookupOk ? "ok" : "FAILED"}`);
    console.log(`  latency:             ${h.latencyMs}ms`);
    for (const w of h.warnings) console.log(`  WARNING: ${w}`);
    for (const f of h.failures) console.log(`  FAILURE: ${f}`);
    if (!h.ok) broken++;
  }

  // Fairfax publishes fields the others do not — land use codes, assessment
  // year, sale-to-assessment ratio — and a reassessment moves every Fairfax
  // valuation at once. Worth keeping on top of the generic checks.
  try {
    const f = await checkFairfaxHealth();
    console.log(`\nFAIRFAX — source-specific checks`);
    console.log(`  land use coverage:   ${(f.landUseCoverage * 100).toFixed(0)}%`);
    console.log(`  median sale/assess:  ${f.medianSaleToAssessedRatio}`);
    console.log(`  assessment year:     ${f.taxYear}`);
    for (const w of f.warnings) console.log(`  WARNING: ${w}`);
    for (const fl of f.failures) console.log(`  FAILURE: ${fl}`);
    if (!f.ok) broken++;
  } catch (err) {
    console.log(`\nFAIRFAX — source-specific checks could not run: ${(err as Error)?.message}`);
  }

  console.log(
    `\n${"─".repeat(60)}\n` +
      (broken === 0
        ? `All ${results.length} data sources healthy.`
        : `${broken} check(s) FAILING — homeowners in the affected areas are getting no valuation.`)
  );
  process.exit(broken === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("Canary itself failed:", err?.message ?? err);
  process.exit(1);
});
