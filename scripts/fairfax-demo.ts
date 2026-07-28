/**
 * Live end-to-end check of the comps engine against Fairfax County public
 * records. No API key required.
 *
 *   npx tsx scripts/fairfax-demo.ts [lat] [lng]
 */

import { valueFromComps } from "../lib/comps";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";

const lat = Number(process.argv[2]) || 38.94;
const lng = Number(process.argv[3]) || -77.161;

const fmt = (n: number | null) => (n === null ? "—" : `$${Math.round(n).toLocaleString()}`);

async function main() {
  const provider = new FairfaxCountyProvider();

  console.log(`Subject: ${lat}, ${lng}\n`);

  const subjectInfo = await provider.lookupSubject({ lat, lng });
  if (!subjectInfo) {
    console.error("No parcel found at that point.");
    process.exit(1);
  }

  const subject = {
    location: { lat, lng },
    propertyType: subjectInfo.propertyType ?? ("single_family" as const),
    assessedValue: subjectInfo.assessedValue,
  };

  console.log(`  type:     ${subject.propertyType}`);
  console.log(`  assessed: ${fmt(subject.assessedValue ?? null)}\n`);

  const started = Date.now();
  const candidates = await provider.fetchCandidates(subject, {
    radiusMiles: 1.5,
    lookbackMonths: 12,
    limit: 200,
  });
  const ms = Date.now() - started;

  console.log(`Fetched ${candidates.length} arm's-length sales in ${ms}ms\n`);

  const result = valueFromComps(subject, candidates);

  console.log("─".repeat(78));
  console.log(`ESTIMATE   ${fmt(result.estimate)}`);
  console.log(`RANGE      ${fmt(result.low)} – ${fmt(result.high)}`);
  console.log(`CONFIDENCE ${result.confidence} (${result.confidenceScore})`);
  console.log("─".repeat(78));

  if (result.comps.length) {
    console.log("\nComparables used:");
    console.log(
      `  ${"parcel".padEnd(16)} ${"score".padEnd(6)} ${"sold".padEnd(12)} ` +
        `${"price".padEnd(12)} ${"assessed".padEnd(12)} ${"adjusted".padEnd(12)} dist   age`
    );
    for (const c of result.comps) {
      console.log(
        `  ${c.comp.id.slice(0, 15).padEnd(16)} ${c.score.toFixed(3).padEnd(6)} ` +
          `${c.comp.soldDate.padEnd(12)} ${fmt(c.comp.soldPrice).padEnd(12)} ` +
          `${fmt(c.comp.assessedValue ?? null).padEnd(12)} ${fmt(c.adjustedPrice).padEnd(12)} ` +
          `${c.distanceMiles.toFixed(2)}mi ${c.ageMonths}mo`
      );
    }
  }

  const reasons = result.rejected.reduce<Record<string, number>>((acc, r) => {
    const key = r.reason.replace(/[\d.]+/g, "N");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  if (Object.keys(reasons).length) {
    console.log(`\nRejected ${result.rejected.length}:`);
    for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)} × ${reason}`);
    }
  }

  console.log();
  result.notes.forEach(n => console.log(`  · ${n}`));
}

main().catch(err => {
  console.error("Failed:", err?.message ?? err);
  process.exit(1);
});
