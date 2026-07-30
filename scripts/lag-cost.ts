/**
 * What does Maryland's 90-day publishing lag actually cost?
 *
 * THE BACKTEST HAS BEEN FLATTERING MARYLAND, AND IT IS WORTH BEING PRECISE
 * ABOUT WHY.
 *
 * Every backtest here values a subject as of the day before it sold, using
 * comps that had closed by then. That is the right way to measure an engine.
 * But it is NOT what production faces in Maryland: there, the newest sale
 * available is about 90 days old, so a homeowner asking today is valued from
 * comps that are all at least a quarter stale, and the engine extrapolates
 * forward across that gap.
 *
 * The backtest never simulates that gap, because its subjects come from the
 * same lagged pool — so both subject and comps sit behind the lag together and
 * the extrapolation cancels out.
 *
 * This measures the difference directly: value each subject twice, once with
 * comps available up to the day before it sold, and once with comps cut off 90
 * days earlier. The gap between the two is the cost of the lag.
 *
 * DC and Fairfax are included as controls. They publish within 10 days, so
 * they do not pay this cost today — but running the same simulation on them
 * separates "staleness is expensive" from "Maryland is difficult".
 *
 *   npx tsx scripts/lag-cost.ts [samplesPerMarket]
 *
 * RESULT — the lag is expensive, and Maryland pays it every day:
 *
 *   cutoff       ALL   maryland    dc   fairfax   valued
 *   same week   5.3%     5.7%     5.9%   5.1%      93%
 *   45 days     6.1%     9.1%     6.6%   5.1%      82%
 *   90 days     7.0%     9.5%     7.0%   5.3%      73%
 *   135 days    7.8%    10.4%     7.9%   4.9%      61%
 *
 * Maryland lives at the 90-day row in production and roughly DOUBLES its error
 * against the same-week baseline, while losing 20 points of coverage. Fairfax
 * is nearly immune, because its valuations rest on assessed value rather than
 * on recent sales, and an assessment does not go stale the same way.
 *
 * CONSEQUENCE FOR THE PUBLISHED FIGURES: the standard backtests draw subject
 * and comps from the same lagged pool, so both sit behind the lag together and
 * the extrapolation cancels. Maryland's published 8.7% is therefore optimistic
 * about what a homeowner asking TODAY receives. DC and Fairfax are unaffected —
 * they publish within 10 days, so their backtest conditions match production.
 *
 * DOES THE CONFIDENCE LABEL SURVIVE IT? Largely yes, which was not the
 * expectation going in:
 *
 *   cutoff            high        medium         low
 *   same week    4.3% (62%)    6.6% (29%)   9.5% (10%)
 *   90 days      5.7% (57%)    8.6% (37%)  10.6%  (6%)
 *
 * High confidence degrades from 4.3% to 5.7% but remains clearly the best
 * bucket, the ordering holds at every lag, and the SHARE earning the label
 * falls from 62% to 57% — the engine is already downgrading stale comps
 * without being told to. The `recency` scoring dimension is doing that work.
 *
 * So no staleness penalty was added to scoreConfidence. The obvious worry —
 * that Maryland homeowners see "High Confidence" on estimates the label cannot
 * support — is not borne out. What remains true is that the same word means
 * 4.3% in DC and 5.7% in Maryland, which is a real if modest inconsistency.
 *
 * ── DOES THE APPRECIATION RATE PEEK AT THE FUTURE? AUDITED: NO. ──────────
 *
 * The obvious way to get this wrong is to fit `annualAppreciation` on the full
 * data and then reuse that fit at every cutoff. The rate would then carry
 * information from sales the engine is not supposed to have seen, and every
 * lagged row would be flattered — 9.5% would itself be optimistic.
 *
 * It does not happen here. `valueFromComps` is called with only `asOf` and
 * `maxAssessmentRatioDeviation` as overrides — no `market` — so `calibrate.ts`
 * runs `calibrateMarket(candidates, ...)` against the CUT-OFF candidate set on
 * every iteration and refits the rate from scratch. See the guard in
 * `lib/comps/index.ts`: calibration is skipped only when `calibrate === false`
 * or an explicit `market` override is supplied, and neither is passed here.
 *
 * The candidate pool is fetched over 24 months, which does include sales after
 * the subject's, but `cands` filters `c.soldDate < cutoff` before it reaches the
 * engine.
 *
 * ONE LEAK REMAINS AND IS SHARED BY EVERY BACKTEST HERE: the subject's
 * `assessedValue` is the CURRENT assessment, which for a holdout may already
 * reflect the sale being predicted. It is identical at every cutoff, so the
 * DIFFERENCE between rows — the cost of the lag — is clean even where the
 * absolute level is optimistic.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * The ENGINE path, not the product path. The subject here is built from the
 * holdout's own sales record; production resolves it from a lat/lng through
 * `lookupSubject`, and that gap is worth up to 1.8pp (Fairfax 5.4% -> 7.2%).
 * So 9.5% is "engine error under a 90-day lag", and it is NOT the figure the
 * accuracy band may display.
 *
 * For that, run the production-path script with a lag:
 *
 *   npx tsx scripts/production-path-backtest.ts 25 90
 *
 * which applies the same cutoff to the same pipeline a homeowner goes through.
 *
 * No free fresher Maryland source exists. Checked: both iMAP layers (identical
 * lag), every service in iMAP's PlanningCadastre catalogue, MDP's own
 * mdpgis.mdp.state.md.us (hosts no sales), Montgomery County open data (tax
 * rolls only), and SDAT Real Property Search (403 to automated requests).
 */
import { valueFromComps } from "../lib/comps";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider, SubjectProperty } from "../lib/comps/types";

const MARKETS: {
  name: string;
  jurisdiction: string;
  lat: number;
  lng: number;
  provider: () => CompsProvider;
  ratioDev?: number;
}[] = [
  { jurisdiction: "maryland", name: "Bethesda", lat: 38.98836, lng: -77.08292, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Rockville", lat: 39.084, lng: -77.1528, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "maryland", name: "Frederick", lat: 39.4143, lng: -77.4105, provider: () => new MarylandProvider(), ratioDev: 0.5 },
  { jurisdiction: "dc", name: "Capitol Hill", lat: 38.887, lng: -76.993, provider: () => new DcProvider() },
  { jurisdiction: "dc", name: "Petworth", lat: 38.942, lng: -77.023, provider: () => new DcProvider() },
  { jurisdiction: "fairfax", name: "McLean", lat: 38.94, lng: -77.161, provider: () => new FairfaxCountyProvider() },
  { jurisdiction: "fairfax", name: "Annandale", lat: 38.85175, lng: -77.19818, provider: () => new FairfaxCountyProvider() },
];

const N = Number(process.argv[2]) || 40;
/** Cut-offs to simulate, in days before the sale. 1 = the usual backtest. */
const LAGS = [1, 45, 90, 135];

const shiftDays = (iso: string, days: number) => {
  const d = new Date(iso);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};
const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const byLag = new Map<number, number[]>();
  const byJurLag = new Map<string, Map<number, number[]>>();
  const valued = new Map<number, number>();
  /** lag|confidence -> errors, to see whether the LABEL survives the lag. */
  const byConf = new Map<string, number[]>();
  let attempts = 0;

  for (const m of MARKETS) {
    const pool = await m.provider().fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    const usable = pool.filter(
      c => c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other" && c.propertyType !== "land"
    );
    const step = Math.max(1, Math.floor(usable.length / N));
    const subs = usable.filter((_, i) => i % step === 0).slice(0, N);
    if (!byJurLag.has(m.jurisdiction)) byJurLag.set(m.jurisdiction, new Map());

    for (const s of subs) {
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
      attempts++;

      for (const lag of LAGS) {
        // Only comps that would have been PUBLISHED by the time this home was
        // being valued. The valuation date stays the day before the sale, so
        // the engine must extrapolate across the lag exactly as it does live.
        const cutoff = shiftDays(s.soldDate, lag);
        const cands: ComparableSale[] = usable.filter(c => c.id !== s.id && c.soldDate < cutoff);
        if (cands.length < 10) continue;

        const r = valueFromComps(subject, cands, {
          asOf: shiftDays(s.soldDate, 1),
          ...(m.ratioDev ? { maxAssessmentRatioDeviation: m.ratioDev } : {}),
        });
        if (r.estimate === null) continue;

        const e = Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100);
        const key = `${lag}|${r.confidence}`;
        if (!byConf.has(key)) byConf.set(key, []);
        byConf.get(key)!.push(e);
        if (!byLag.has(lag)) byLag.set(lag, []);
        byLag.get(lag)!.push(e);
        const jj = byJurLag.get(m.jurisdiction)!;
        if (!jj.has(lag)) jj.set(lag, []);
        jj.get(lag)!.push(e);
        valued.set(lag, (valued.get(lag) ?? 0) + 1);
      }
    }
    process.stdout.write(`  ${m.jurisdiction}/${m.name}: ${subs.length} subjects\n`);
  }

  const JURS = ["maryland", "dc", "fairfax"];
  const base = med(byLag.get(1) ?? []);

  console.log(`\n${"═".repeat(96)}`);
  console.log("COST OF PUBLISHING LAG  — comps withheld for N days before the valuation");
  console.log("═".repeat(96));
  console.log(`  ${"data cutoff".padEnd(14)} ${"MdAPE".padStart(7)} ${"cost".padStart(8)} ${"valued".padStart(8)}   ` +
    JURS.map(j => j.slice(0, 8).padStart(10)).join(""));
  console.log("  " + "─".repeat(92));

  for (const lag of LAGS) {
    const rows = byLag.get(lag) ?? [];
    if (!rows.length) continue;
    const v = med(rows);
    const label = lag === 1 ? "same week" : `${lag} days`;
    console.log(
      `  ${label.padEnd(14)} ${v.toFixed(1).padStart(6)}% ` +
        `${(lag === 1 ? "baseline" : `${v - base >= 0 ? "+" : ""}${(v - base).toFixed(1)}pp`).padStart(8)} ` +
        `${(((valued.get(lag) ?? 0) / attempts) * 100).toFixed(0).padStart(7)}%   ` +
        JURS.map(j => `${med(byJurLag.get(j)?.get(lag) ?? []).toFixed(1)}%`.padStart(10)).join("")
    );
  }
  console.log(`\n${"═".repeat(96)}`);
  console.log("DOES THE CONFIDENCE LABEL SURVIVE THE LAG?");
  console.log("═".repeat(96));
  console.log(`  ${"data cutoff".padEnd(14)}` +
    ["high", "medium", "low"].map(c => `${c}`.padStart(16)).join(""));
  console.log("  " + "─".repeat(92));
  for (const lag of LAGS) {
    const cells = ["high", "medium", "low"].map(c => {
      const rows = byConf.get(`${lag}|${c}`) ?? [];
      const total = ["high", "medium", "low"].reduce(
        (n, k) => n + (byConf.get(`${lag}|${k}`)?.length ?? 0), 0);
      if (!rows.length) return "—".padStart(16);
      return `${med(rows).toFixed(1)}% (${((rows.length / total) * 100).toFixed(0)}%)`.padStart(16);
    });
    console.log(`  ${(lag === 1 ? "same week" : `${lag} days`).padEnd(14)}${cells.join("")}`);
  }
  console.log("  (median error, and share of predictions carrying that label)");

  console.log("═".repeat(96));
  console.log(
    "\n  Maryland lives at the 90-day row in production; DC and Fairfax live at the\n" +
      "  top row. If the 90-day cost is small, the lag is an annoyance and the\n" +
      "  published Maryland figure stands. If it is large, the figure is optimistic\n" +
      "  and a fresher source is worth real effort."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
