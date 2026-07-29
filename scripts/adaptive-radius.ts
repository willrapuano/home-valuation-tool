/**
 * Would an adaptive search radius beat a fixed one?
 *
 * The radius sweep produced a clean tradeoff and no obvious winner:
 *
 *   0.5mi   5.9% median error, but only 73% of homes got an estimate
 *   1.5mi   6.0% median error, 91% valued          <- shipped
 *
 * Tight comps are better comps; there just are not always enough of them. That
 * is an argument for neither fixed radius: it is an argument for starting
 * tight and widening only when the neighbourhood is too thin to support it,
 * which is also what an appraiser does.
 *
 * The ladder is free at request time — the candidate pool is already fetched
 * at the widest radius, so each rung is a filter over data we hold, not
 * another round trip.
 *
 * Measured across all three jurisdictions, because this would be a change to
 * shared engine behaviour, and the last two sweeps both showed a setting that
 * helps one source hurting another.
 *
 *   npx tsx scripts/adaptive-radius.ts [samplesPerMarket]
 *
 * RESULT: REJECTED. Adaptive is WORSE — 6.7% against 6.1% for a fixed 1.5mi,
 * at identical 95% coverage:
 *
 *              MdAPE  valued   maryland   dc    fairfax
 *   fixed 1.5   6.1%    95%      6.7%    6.3%    5.4%
 *   adaptive    6.7%    95%      7.9%    6.1%    5.9%
 *
 * It also explains the sweep that motivated it. The tight radius never was
 * more accurate: at 0.5mi only 73% of homes produced an estimate at all, and
 * those were the ones in dense neighbourhoods with plenty of nearby sales —
 * the easy ones. The apparent accuracy gain was SURVIVORSHIP, and it vanishes
 * the moment the strategy has to answer everywhere. Adaptive picks 0.5mi 69%
 * of the time and is worse for it.
 *
 * Kept because a rejected hypothesis is cheaper to read than to re-derive, and
 * because the trap generalises: any filter evaluated only on the cases it
 * chooses to answer will look better than it is.
 */
import { valueFromComps } from "../lib/comps";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider, SubjectProperty, ValuationResult } from "../lib/comps/types";

const MARKETS: {
  name: string;
  jurisdiction: string;
  lat: number;
  lng: number;
  provider: () => CompsProvider;
  ratioDev?: number;
  assessmentDate?: string;
}[] = [
  { jurisdiction: "maryland", name: "Bethesda", lat: 38.98836, lng: -77.08292, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Silver Spring", lat: 38.9907, lng: -77.0261, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Columbia", lat: 39.2037, lng: -76.861, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Frederick", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "dc", name: "Capitol Hill", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Petworth", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Anacostia", lat: 38.8637, lng: -76.9836, provider: () => new DcProvider() },
  { jurisdiction: "fairfax", name: "McLean", lat: 38.94, lng: -77.161, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
  { jurisdiction: "fairfax", name: "Springfield", lat: 38.7893, lng: -77.1872, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
  { jurisdiction: "fairfax", name: "Annandale", lat: 38.85175, lng: -77.19818, provider: () => new FairfaxCountyProvider(), assessmentDate: "2026-01-01" },
];

const N = Number(process.argv[2]) || 40;
const LADDER = [0.5, 0.75, 1.0, 1.5];

/**
 * Value at the tightest radius that yields a full set of comps, widening only
 * when it does not. `targetCompCount` is what reconcile() actually uses, so
 * "enough" means enough to reconcile from rather than merely enough to pass
 * the minimum.
 */
function valueAdaptive(
  subject: SubjectProperty,
  candidates: ComparableSale[],
  base: Record<string, unknown>,
  wanted: number
): { result: ValuationResult; radiusUsed: number } {
  let last: { result: ValuationResult; radiusUsed: number } | null = null;

  for (const radius of LADDER) {
    const result = valueFromComps(subject, candidates, { ...base, maxDistanceMiles: radius });
    last = { result, radiusUsed: radius };
    if (result.estimate !== null && result.comps.length >= wanted) return last;
  }
  // Nothing satisfied the target; the widest attempt is the best available.
  return last!;
}

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

interface Row { jurisdiction: string; err: number; radius?: number }

async function main() {
  const fixed: Row[] = [];
  const adaptive: Row[] = [];
  let fixedAttempts = 0;
  let fixedValued = 0;
  let adaptiveValued = 0;

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

    for (const s of subs) {
      const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
      if (cands.length < 10) continue;

      const subject: SubjectProperty = {
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
      const base: Record<string, unknown> = {
        asOf: dayBefore(s.soldDate),
        ...(m.ratioDev ? { maxAssessmentRatioDeviation: m.ratioDev } : {}),
      };

      fixedAttempts++;

      const f = valueFromComps(subject, cands, { ...base, maxDistanceMiles: 1.5 });
      if (f.estimate !== null) {
        fixedValued++;
        fixed.push({ jurisdiction: m.jurisdiction, err: Math.abs(((f.estimate - s.soldPrice) / s.soldPrice) * 100) });
      }

      const a = valueAdaptive(subject, cands, base, 6);
      if (a.result.estimate !== null) {
        adaptiveValued++;
        adaptive.push({
          jurisdiction: m.jurisdiction,
          err: Math.abs(((a.result.estimate - s.soldPrice) / s.soldPrice) * 100),
          radius: a.radiusUsed,
        });
      }
    }
    process.stdout.write(`  ${m.jurisdiction}/${m.name}: ${subs.length} subjects\n`);
  }

  const JURS = ["maryland", "dc", "fairfax"];
  const byJur = (rows: Row[], j: string) => rows.filter(r => r.jurisdiction === j).map(r => r.err);

  console.log(`\n${"═".repeat(96)}`);
  console.log("FIXED 1.5mi  vs  ADAPTIVE (tightest radius yielding 6 comps)");
  console.log("═".repeat(96));
  console.log(`  ${"strategy".padEnd(14)} ${"MdAPE".padStart(7)} ${"valued".padStart(8)}   ` +
    JURS.map(j => j.slice(0, 8).padStart(10)).join(""));
  console.log("  " + "─".repeat(92));

  for (const [label, rows, valued] of [
    ["fixed 1.5mi", fixed, fixedValued],
    ["adaptive", adaptive, adaptiveValued],
  ] as const) {
    console.log(
      `  ${label.padEnd(14)} ${med(rows.map(r => r.err)).toFixed(1).padStart(6)}% ` +
        `${((valued / fixedAttempts) * 100).toFixed(0).padStart(7)}%   ` +
        JURS.map(j => `${med(byJur(rows, j)).toFixed(1)}%`.padStart(10)).join("")
    );
  }

  console.log(`\n  Radius actually chosen by the adaptive strategy:`);
  for (const r of LADDER) {
    const n = adaptive.filter(x => x.radius === r).length;
    console.log(`    ${`${r}mi`.padEnd(7)} ${String(n).padStart(4)}  ${((n / adaptive.length) * 100).toFixed(0)}%`);
  }
  console.log("═".repeat(96));
  console.log(
    "\n  Adaptive is only worth shipping if it improves accuracy WITHOUT losing\n" +
      "  coverage. Matching the fixed radius on both would mean the extra\n" +
      "  complexity buys nothing."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
