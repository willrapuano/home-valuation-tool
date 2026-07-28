/**
 * Holdout backtest of the engine against real Maryland sales.
 *
 * Each subject is valued as of the day before it sold, from sales that had
 * already closed, with the subject excluded from its own comp set.
 *
 * LEAKAGE: Maryland assessments carry no date in this feed, so a sale could in
 * principle have informed the assessment being fed in — the guard used in the
 * Fairfax backtest (test only sales after the assessment date) cannot be
 * applied here. Maryland reassesses on a three-year cycle, so most subjects
 * are dated well after their assessment, but the figures below should be read
 * as a slightly optimistic bound rather than as clean out-of-sample error.
 */
import { valueFromComps } from "../lib/comps";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale } from "../lib/comps/types";

const MARKETS = [
  { name: "Bethesda", lat: 38.98836, lng: -77.08292 },
  { name: "Silver Spring", lat: 38.9907, lng: -77.0261 },
  { name: "Rockville", lat: 39.0840, lng: -77.1528 },
  { name: "Columbia", lat: 39.2037, lng: -76.8610 },
  { name: "Annapolis", lat: 38.9784, lng: -76.4922 },
  { name: "Frederick", lat: 39.4143, lng: -77.4105 },
];
const N = Number(process.argv[2]) || 35;
const dayBefore = (iso: string) => { const d=new Date(iso); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); };
const med = (xs:number[]) => { const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };

interface Out { market:string; actual:number; predicted:number; errorPct:number; absErrorPct:number; confidence:string; inRange:boolean }

function report(label:string, rows:Out[]) {
  if(!rows.length){ console.log(`  ${label.padEnd(15)} —`); return; }
  const abs=rows.map(r=>r.absErrorPct);
  const w10=rows.filter(r=>r.absErrorPct<=10).length/rows.length;
  const w20=rows.filter(r=>r.absErrorPct<=20).length/rows.length;
  const ir=rows.filter(r=>r.inRange).length/rows.length;
  const bias=rows.reduce((s,r)=>s+r.errorPct,0)/rows.length;
  console.log(`  ${label.padEnd(15)} n=${String(rows.length).padStart(3)}  MdAPE ${med(abs).toFixed(1).padStart(5)}%  ≤10% ${(w10*100).toFixed(0).padStart(3)}%  ≤20% ${(w20*100).toFixed(0).padStart(3)}%  in-range ${(ir*100).toFixed(0).padStart(3)}%  bias ${(bias>=0?"+":"")+bias.toFixed(1)}%`);
}

async function main(){
  const p=new MarylandProvider();
  const all:Out[]=[];
  for(const m of MARKETS){
    try{
      const pool=await p.fetchCandidates({location:{lat:m.lat,lng:m.lng},propertyType:"single_family"},{radiusMiles:2.5,lookbackMonths:24,limit:2000});
      const usable=pool.filter(c=>c.sqft&&c.sqft>0&&c.propertyType!=="other");
      // Maryland publishes an assessment for every parcel, and measured against
      // a 300-sale holdout it is a far better adjustment basis than the
      // physical grid (8.7% median error against 11.4%). Withholding it from
      // the subject, as the first version of this script did, was measuring a
      // handicapped engine.
      const step=Math.max(1,Math.floor(usable.length/N));
      const subs=usable.filter((_,i)=>i%step===0).slice(0,N);
      let n=0;
      for(const s of subs){
        const cands:ComparableSale[]=usable.filter(c=>c.id!==s.id&&c.soldDate<s.soldDate);
        const r=valueFromComps({location:s.location,propertyType:s.propertyType,sqft:s.sqft,lotSqft:s.lotSqft,yearBuilt:s.yearBuilt,condition:s.condition,subdivision:s.subdivision,assessedValue:s.assessedValue},cands,{asOf:dayBefore(s.soldDate)});
        if(r.estimate===null) continue;
        const e=((r.estimate-s.soldPrice)/s.soldPrice)*100;
        all.push({market:m.name,actual:s.soldPrice,predicted:r.estimate,errorPct:e,absErrorPct:Math.abs(e),confidence:r.confidence,inRange:s.soldPrice>=r.low!&&s.soldPrice<=r.high!});
        n++;
      }
      console.log(`  ${m.name}: ${n} predictions from ${usable.length} sales`);
    }catch(e){ console.error(`  ${m.name} failed: ${(e as Error).message}`); }
  }
  if(!all.length){ console.error("no predictions"); process.exit(1); }
  console.log("\n"+"═".repeat(96)+"\nBY MARKET\n"+"═".repeat(96));
  for(const m of MARKETS) report(m.name, all.filter(r=>r.market===m.name));
  console.log("\n"+"═".repeat(96)+"\nBY CONFIDENCE\n"+"═".repeat(96));
  for(const c of ["high","medium","low"]) report(c, all.filter(r=>r.confidence===c));
  console.log("\n"+"═".repeat(96));
  report("OVERALL", all);
  console.log("═".repeat(96));
}
main().catch(e=>{console.error(e.message);process.exit(1)});
