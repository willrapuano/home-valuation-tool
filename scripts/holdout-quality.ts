/**
 * How much of a market's measured error is the engine, and how much is the
 * holdout set?
 *
 *   npx tsx scripts/holdout-quality.ts
 *
 * THE PROBLEM. Maryland and Fairfax publish no arm's-length flag, so a holdout
 * drawn straight from the sales record contains intra-family transfers,
 * distressed sales, and nominal conveyances. Those are not market value.
 * Scoring an estimate against them measures the engine's failure to predict a
 * non-market number, which is not a failure.
 *
 * The engine already refuses such sales AS COMPS, via assessmentRatioBand.
 * Nothing applied the same standard to the holdout.
 *
 * MEASURED:
 *
 *   Bethesda   869 sales, 81% with a plausible sale/assessment ratio
 *     all holdouts            n=19   MdAPE 18.7%   off>20% 47%
 *     plausible ratio only    n=16   MdAPE  8.2%   off>20% 19%
 *
 *   Rockville  538 sales, 92% plausible
 *     all holdouts            n=24   MdAPE  6.6%   off>20% 17%
 *     plausible ratio only    n=23   MdAPE  5.1%   off>20%  9%
 *
 * So Bethesda's apparent collapse — the market that publishes least and errs
 * most — is substantially a property of its TRANSACTIONS, not of the code.
 * It carries more than twice Rockville's share of implausible sales.
 *
 * ⚠️ AND THE FILTER IS CIRCULAR, WHICH IS WHY THIS SCRIPT REPORTS A BRACKET
 * RATHER THAN A NUMBER.
 *
 * "Plausible" here means the sale is close to its own assessment. The engine's
 * estimate is largely DRIVEN by that same assessment — it is the strongest
 * single input, worth 3.1pp. So filtering holdouts this way keeps exactly the
 * sales the engine was always going to get right, and 8.2% is optimistic by
 * construction in a way that cannot be corrected away.
 *
 * The honest statement is that Bethesda's true accuracy on genuine
 * arm's-length sales lies somewhere between 8.2% and 18.7%, and that public
 * Maryland data cannot narrow it further. DC can be measured properly because
 * DC publishes the qualified flag; that is a second, independent reason to
 * want deed-type data beyond the coverage argument for Arlington and Loudoun.
 *
 * Do not "fix" a market's numbers by filtering its holdout. Report the bracket.
 */
import { valueFromComps } from "../lib/comps";
import { shouldPublishEstimate } from "../lib/comps/publish";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { SubjectLookup } from "../lib/comps/types";

const dayBefore = (i: string) => { const d=new Date(i); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); };
const med = (xs: number[]) => { if(!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

(async () => {
  for (const [name, lat, lng] of [["Bethesda",38.98836,-77.08292],["Rockville",39.067,-77.1808]] as const) {
    let pool: Awaited<ReturnType<MarylandProvider["fetchCandidates"]>> = [];
    for (let a=0; a<4 && !pool.length; a++) {
      try { pool = await new MarylandProvider().fetchCandidates(
        { location:{lat,lng}, propertyType:"single_family" },
        { radiusMiles: 2.5, lookbackMonths: 12, limit: 2000 }); } catch {}
    }
    const usable = pool.filter(c => c.assessedValue && c.propertyType !== "other" && c.propertyType !== "land");

    // How plausibly arm's-length is each sale, by its own sale-to-assessment ratio?
    const ratio = (c: typeof usable[number]) => c.soldPrice / (c.assessedValue as number);
    const sane = usable.filter(c => { const r = ratio(c); return r >= 0.7 && r <= 1.6; });
    console.log(`\n${name}: ${usable.length} sales, ${sane.length} with a plausible sale/assessment ratio ` +
      `(${((sane.length/usable.length)*100).toFixed(0)}%)`);

    for (const [label, set] of [["all holdouts", usable], ["plausible ratio only", sane]] as const) {
      const N = 30;
      const step = Math.max(1, Math.floor(set.length / N));
      const subs = set.filter((_,i)=>i%step===0).slice(0,N);
      const shown: number[] = []; let held = 0;
      for (const s of subs) {
        const parcel = s.id.split("@")[0];
        const cands = usable.filter(c => c.id.split("@")[0] !== parcel && c.soldDate < s.soldDate)
          .sort((a,b)=> a.soldDate<b.soldDate?1:-1).slice(0,200);
        if (cands.length < 10) continue;
        let info: SubjectLookup | null = null;
        for (let a=0;a<3;a++) { try { info = await new MarylandProvider().lookupSubject(s.location); break; } catch {} }
        if (!info || (!info.assessedValue && !info.sqft)) continue;
        const r = valueFromComps({ location: s.location, propertyType: info.propertyType ?? "single_family",
          assessedValue: info.assessedValue, sqft: info.sqft, lotSqft: info.lotSqft, yearBuilt: info.yearBuilt,
          condition: info.condition, subdivision: info.subdivision }, cands,
          { asOf: dayBefore(s.soldDate), maxAssessmentRatioDeviation: 0.5 });
        if (r.estimate === null) continue;
        const err = Math.abs(((r.estimate - s.soldPrice)/s.soldPrice)*100);
        if (shouldPublishEstimate(r).publish) shown.push(err); else held++;
      }
      console.log(`  ${label.padEnd(22)} shown n=${String(shown.length).padStart(3)}  MdAPE ${med(shown).toFixed(1).padStart(5)}%  ` +
        `off>20% ${(shown.filter(v=>v>20).length/shown.length*100).toFixed(0).padStart(3)}%  publish ${((shown.length/(shown.length+held))*100).toFixed(0)}%`);
    }
  }
})();

/*
 * Reading the output: the gap between the two rows is how much of a market's
 * measured error comes from transactions that were never market sales. A wide
 * gap does NOT mean the lower number is the truth — see the circularity note
 * at the top. It means the market's published figure is unreliable in a
 * direction that flatters nobody, and that a deed-type source would settle it.
 */
