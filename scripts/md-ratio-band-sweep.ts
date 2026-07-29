/**
 * Can Maryland close some of its gap to DC by tuning its stand-in for the
 * arm's-length flag?
 *
 * DC publishes whether each sale was arm's-length, and filtering on it is worth
 * 1.9 percentage points there — a larger effect than any physical
 * characteristic. Maryland publishes no such flag, so `assessmentRatioBand()`
 * approximates one: a sale far from the local median sale-to-assessment ratio
 * is probably a teardown, a renovation, or a transfer between relatives.
 *
 * That band has sat at ±25% since it was written, chosen by reasoning rather
 * than measurement. This sweeps it against the same holdout method used
 * everywhere else. Maryland is 8.0% against DC's 4.3%; if the band is
 * mistuned, some of that difference is recoverable for free.
 *
 *   npx tsx scripts/md-ratio-band-sweep.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider } from "../lib/comps/types";

/**
 * All three jurisdictions, because the band is SHARED engine config. Maryland
 * alone says to loosen it; Fairfax publishes no building characteristics at
 * all, so assessed value is the only basis there and the filter may be doing
 * real work. Changing a global default on one jurisdiction's evidence is how
 * you fix one market and quietly break another.
 */
const MARKETS: {
  name: string;
  jurisdiction: string;
  lat: number;
  lng: number;
  provider: () => CompsProvider;
  assessmentDate?: string;
}[] = [
  { jurisdiction: "maryland", name: "Bethesda", lat: 38.98836, lng: -77.08292, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", name: "Silver Spring", lat: 38.9907, lng: -77.0261, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", name: "Annapolis", lat: 38.9784, lng: -76.4922, provider: () => new MarylandProvider() },
  { jurisdiction: "maryland", name: "Frederick", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider() },
  { jurisdiction: "dc", name: "Capitol Hill", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Petworth", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Anacostia", lat: 38.8637, lng: -76.9836, provider: () => new DcProvider() },
  { jurisdiction: "fairfax", name: "McLean", lat: 38.94, lng: -77.161, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
  { jurisdiction: "fairfax", name: "Springfield", lat: 38.7893, lng: -77.1872, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
  { jurisdiction: "fairfax", name: "Annandale", lat: 38.85175, lng: -77.19818, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
];
const N = Number(process.argv[2]) || 45;

/** 0.25 is the shipped value. 0.99 effectively disables the filter. */
const DEVIATIONS = [0.12, 0.18, 0.25, 0.35, 0.5, 0.99];

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
const shareOver = (xs: number[], t: number) =>
  xs.length ? xs.filter(v => v > t).length / xs.length : NaN;

async function main() {
  const byDev = new Map<number, number[]>();
  const byMarketDev = new Map<string, Map<number, number[]>>();
  const byJurDev = new Map<string, Map<number, number[]>>();

  for (const m of MARKETS) {
    const pool = await m.provider().fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    // Fairfax publishes no characteristics, so require only an assessment.
    const usable = pool.filter(
      c => c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other" && c.propertyType !== "land"
    );
    const testable = m.assessmentDate ? usable.filter(c => c.soldDate > m.assessmentDate!) : usable;
    const step = Math.max(1, Math.floor(testable.length / N));
    const subs = testable.filter((_, i) => i % step === 0).slice(0, N);
    byMarketDev.set(m.name, new Map());
    if (!byJurDev.has(m.jurisdiction)) byJurDev.set(m.jurisdiction, new Map());

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

      for (const dev of DEVIATIONS) {
        const r = valueFromComps(subject, cands, {
          asOf: dayBefore(s.soldDate),
          maxAssessmentRatioDeviation: dev,
        });
        if (r.estimate === null) continue;
        const e = Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100);

        if (!byDev.has(dev)) byDev.set(dev, []);
        byDev.get(dev)!.push(e);
        const mm = byMarketDev.get(m.name)!;
        if (!mm.has(dev)) mm.set(dev, []);
        mm.get(dev)!.push(e);
        const jj = byJurDev.get(m.jurisdiction)!;
        if (!jj.has(dev)) jj.set(dev, []);
        jj.get(dev)!.push(e);
      }
    }
    process.stdout.write(`  ${m.jurisdiction}/${m.name}: ${subs.length} subjects\n`);
  }

  const base = med(byDev.get(0.25) ?? []);

  console.log(`\n${"═".repeat(104)}`);
  console.log("ASSESSMENT-RATIO BAND SWEEP  — Maryland's stand-in for an arm's-length flag");
  console.log("═".repeat(104));
  const JURS = ["maryland", "dc", "fairfax"];
  console.log(
    `  ${"band".padEnd(10)} ${"ALL".padStart(7)} ${"delta".padStart(8)} ${"n".padStart(5)}   ` +
      JURS.map(j => j.slice(0, 8).padStart(10)).join("")
  );
  console.log("  " + "─".repeat(100));

  for (const dev of DEVIATIONS) {
    const rows = byDev.get(dev) ?? [];
    if (!rows.length) continue;
    const v = med(rows);
    const label = dev >= 0.99 ? "off" : `±${(dev * 100).toFixed(0)}%`;
    const cells = JURS.map(j => {
      const rs = byJurDev.get(j)?.get(dev) ?? [];
      return `${med(rs).toFixed(1)}%`.padStart(10);
    });
    console.log(
      `  ${label.padEnd(10)} ${v.toFixed(1).padStart(6)}% ` +
        `${(dev === 0.25 ? "shipped" : `${v - base >= 0 ? "+" : ""}${(v - base).toFixed(1)}pp`).padStart(8)} ` +
        `${String(rows.length).padStart(5)}   ${cells.join("")}`
    );
  }
  console.log("═".repeat(104));
  console.log(
    "\n  A band that is too tight discards good comps; too loose lets teardowns and\n" +
      "  family transfers in. DC's published flag is worth 1.9pp, which is roughly\n" +
      "  the ceiling on what getting this right could recover."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
