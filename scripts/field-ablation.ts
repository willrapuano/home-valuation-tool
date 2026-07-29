/**
 * What is each data field actually worth?
 *
 * Before paying for a richer data source, measure the marginal accuracy of the
 * fields we already have. Each run drops one field from the subject and its
 * comps and re-scores an identical holdout set; the error it costs is that
 * field's contribution.
 *
 * This is the honest way to price a data licence. If dropping the structure
 * grade costs 0.2 percentage points, then buying beds and baths is unlikely to
 * transform anything either, and the coverage gap is the better place to spend.
 * If the physical fields carry real weight, richer characteristics are worth
 * chasing.
 *
 *   npx tsx scripts/field-ablation.ts [samplesPerMarket]
 */
import { valueFromComps } from "../lib/comps";
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
const N = Number(process.argv[2]) || 40;

type Field = "assessedValue" | "sqft" | "lotSqft" | "yearBuilt" | "condition" | "subdivision";

/**
 * Dropping a field from the SUBJECT only disables its adjustment; dropping it
 * from the comps too is what actually simulates not having the data at all.
 */
const ABLATIONS: { label: string; drop: Field[] }[] = [
  { label: "(everything we have)", drop: [] },
  { label: "no assessed value", drop: ["assessedValue"] },
  { label: "no living area", drop: ["sqft"] },
  { label: "no lot size", drop: ["lotSqft"] },
  { label: "no year built", drop: ["yearBuilt"] },
  { label: "no condition/grade", drop: ["condition"] },
  { label: "no subdivision", drop: ["subdivision"] },
  { label: "no physical data at all", drop: ["sqft", "lotSqft", "yearBuilt", "condition"] },
  { label: "location + recency only", drop: ["assessedValue", "sqft", "lotSqft", "yearBuilt", "condition", "subdivision"] },
];

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

function strip<T extends object>(o: T, drop: Field[]): T {
  const out = { ...o };
  for (const f of drop) delete (out as Record<string, unknown>)[f];
  return out;
}

async function main() {
  const p = new MarylandProvider();
  const pools: { market: string; usable: ComparableSale[]; subs: ComparableSale[] }[] = [];

  for (const m of MARKETS) {
    const pool = await p.fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    const usable = pool.filter(
      c => c.sqft && c.sqft > 0 && c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other"
    );
    const step = Math.max(1, Math.floor(usable.length / N));
    pools.push({ market: m.name, usable, subs: usable.filter((_, i) => i % step === 0).slice(0, N) });
    process.stdout.write(`  ${m.name}: ${Math.min(N, usable.length)} subjects\n`);
  }

  const results = new Map<string, number[]>();
  const perMarket = new Map<string, Map<string, number[]>>();

  for (const { market, usable, subs } of pools) {
    for (const s of subs) {
      const cands = usable.filter(c => c.id !== s.id && c.soldDate < s.soldDate);
      if (cands.length < 10) continue;

      for (const ab of ABLATIONS) {
        // Strip from the comps as well: not having a field means not having it
        // anywhere, not just for the property being valued.
        const comps: ComparableSale[] = ab.drop.length ? cands.map(c => strip(c, ab.drop)) : cands;
        const subject = strip(
          {
            location: s.location,
            propertyType: s.propertyType,
            sqft: s.sqft,
            lotSqft: s.lotSqft,
            yearBuilt: s.yearBuilt,
            condition: s.condition,
            subdivision: s.subdivision,
            assessedValue: s.assessedValue,
          },
          ab.drop
        );

        const r = valueFromComps(subject, comps, { asOf: dayBefore(s.soldDate) });
        if (r.estimate === null) continue;
        const e = Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100);

        if (!results.has(ab.label)) results.set(ab.label, []);
        results.get(ab.label)!.push(e);
        if (!perMarket.has(ab.label)) perMarket.set(ab.label, new Map());
        const pm = perMarket.get(ab.label)!;
        if (!pm.has(market)) pm.set(market, []);
        pm.get(market)!.push(e);
      }
    }
  }

  const baseline = med(results.get("(everything we have)") ?? []);

  console.log(`\n${"═".repeat(96)}`);
  console.log("MARGINAL VALUE OF EACH FIELD  — what accuracy costs when it is taken away");
  console.log("═".repeat(96));
  console.log(`  ${"configuration".padEnd(28)} ${"MdAPE".padStart(7)} ${"cost".padStart(8)}  ${"n".padStart(5)}   worst-hit market`);
  console.log("  " + "─".repeat(92));

  for (const ab of ABLATIONS) {
    const rows = results.get(ab.label) ?? [];
    if (!rows.length) continue;
    const v = med(rows);
    const delta = v - baseline;

    // Which market suffers most without this field.
    let worst = "";
    let worstDelta = -Infinity;
    for (const [mkt, errs] of perMarket.get(ab.label) ?? []) {
      const baseErrs = perMarket.get("(everything we have)")?.get(mkt) ?? [];
      const d = med(errs) - med(baseErrs);
      if (d > worstDelta) {
        worstDelta = d;
        worst = mkt;
      }
    }

    console.log(
      `  ${ab.label.padEnd(28)} ${v.toFixed(1).padStart(6)}% ` +
        `${(ab.drop.length ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp` : "—").padStart(8)}  ` +
        `${String(rows.length).padStart(5)}   ` +
        `${ab.drop.length ? `${worst} ${worstDelta >= 0 ? "+" : ""}${worstDelta.toFixed(1)}pp` : ""}`
    );
  }

  console.log("═".repeat(96));
  console.log(
    "\n  A field that costs little when removed is a field whose richer commercial\n" +
      "  equivalent will not buy much accuracy either."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
