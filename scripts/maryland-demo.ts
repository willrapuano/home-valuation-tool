import { valueFromComps } from "../lib/comps";
import { MarylandProvider } from "../lib/comps/providers/maryland";

const lat = Number(process.argv[2]) || 38.9847;
const lng = Number(process.argv[3]) || -77.0947;
const fmt = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

async function main() {
  const p = new MarylandProvider();
  console.log(`Subject: ${lat}, ${lng}\n`);

  const s = await p.lookupSubject({ lat, lng });
  if (!s) { console.error("No Maryland parcel found."); process.exit(1); }
  console.log(`  type:       ${s.propertyType}`);
  console.log(`  sqft:       ${s.sqft ?? "—"}   lot: ${s.lotSqft ?? "—"}   built: ${s.yearBuilt ?? "—"}`);
  console.log(`  subdivision:${s.subdivision ?? " —"}   condition: ${s.condition ?? "—"}`);
  console.log(`  last sale:  ${fmt(s.lastSalePrice)} on ${s.lastSaleDate ?? "—"}\n`);

  const t = Date.now();
  const cands = await p.fetchCandidates(s as never, { radiusMiles: 1.5, lookbackMonths: 12, limit: 200 });
  console.log(`Fetched ${cands.length} residential sales in ${Date.now() - t}ms\n`);

  const r = valueFromComps(s as never, cands);
  console.log("─".repeat(78));
  console.log(`ESTIMATE   ${fmt(r.estimate)}`);
  console.log(`RANGE      ${fmt(r.low)} – ${fmt(r.high)}`);
  console.log(`CONFIDENCE ${r.confidence} (${r.confidenceScore})`);
  console.log("─".repeat(78));
  if (r.comps.length) {
    console.log("\nComparables used:");
    for (const c of r.comps) {
      console.log(
        `  ${String(c.comp.address).slice(0,24).padEnd(26)} ${c.score.toFixed(3)} ` +
        `${c.comp.soldDate}  ${fmt(c.comp.soldPrice).padStart(11)} → ${fmt(c.adjustedPrice).padStart(11)}  ` +
        `${String(c.comp.sqft ?? "?").padStart(5)}sqft  ${c.distanceMiles}mi`
      );
    }
    console.log("\n  adjustments on top comp:", JSON.stringify(r.comps[0].adjustments));
  }
  r.notes.forEach(n => console.log(`  · ${n}`));
}
main().catch(e => { console.error("Failed:", e.message); process.exit(1); });
