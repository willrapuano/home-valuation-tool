/**
 * Which basis explains local sale prices better — the assessment, or the
 * physical characteristics?
 *
 * Reports, per market, the candidate signals for choosing between them
 * (dispersion, median ratio, explanatory power) alongside the empirically best
 * blend weight at a larger sample, so the calibration rule can be chosen
 * against evidence rather than assumed.
 */
import { olsCentered } from "../lib/comps/calibrate";
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
const N = Number(process.argv[2]) || 50;
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1];

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

/** Adjusted R² of a centred OLS fit, penalising the extra physical terms. */
function adjR2(rows: number[][], y: number[]): number {
  const beta = olsCentered(rows, y);
  if (!beta) return 0;
  const n = rows.length;
  const k = rows[0].length;
  const meanX = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let pred = meanY;
    for (let j = 0; j < k; j++) pred += beta[j] * (rows[i][j] - meanX[j]);
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - meanY) ** 2;
  }
  if (ssTot <= 0 || n - k - 1 <= 0) return 0;
  const r2 = 1 - ssRes / ssTot;
  return Math.max(0, 1 - (1 - r2) * ((n - 1) / (n - k - 1)));
}

async function main() {
  const p = new MarylandProvider();

  console.log(
    `  ${"market".padEnd(15)} ${"n".padStart(5)} ${"COD".padStart(6)} ${"medRatio".padStart(9)} ` +
      `${"R2assess".padStart(9)} ${"R2physical".padStart(11)}   bestW   MdAPE@best  MdAPE@w=1`
  );
  console.log("  " + "─".repeat(94));

  for (const m of MARKETS) {
    const pool = await p.fetchCandidates(
      { location: { lat: m.lat, lng: m.lng }, propertyType: "single_family" },
      { radiusMiles: 2.5, lookbackMonths: 24, limit: 2000 }
    );
    const usable = pool.filter(
      c => c.sqft && c.sqft > 0 && c.assessedValue && c.assessedValue > 0 && c.propertyType !== "other"
    );

    // Signals, measured on the whole local pool.
    const ratios = usable.map(c => c.soldPrice / c.assessedValue!).filter(r => r > 0.2 && r < 5);
    const rMed = med(ratios);
    const cod = med(ratios.map(r => Math.abs(r - rMed))) / rMed;

    const full = usable.filter(c => c.lotSqft && c.lotSqft > 0 && c.yearBuilt && c.yearBuilt > 1800);
    const y = full.map(c => c.soldPrice);
    const r2a = adjR2(full.map(c => [c.assessedValue!]), y);
    const r2p = adjR2(full.map(c => [c.sqft!, c.lotSqft!, c.yearBuilt!]), y);

    // Empirical best weight at a larger sample.
    const step = Math.max(1, Math.floor(usable.length / N));
    const subs = usable.filter((_, i) => i % step === 0).slice(0, N);
    const byW = new Map<number, number[]>();
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
      for (const w of WEIGHTS) {
        const r = valueFromComps(subject, cands, {
          asOf: dayBefore(s.soldDate),
          marketOverrides: { assessmentWeight: w },
        });
        if (r.estimate === null) continue;
        if (!byW.has(w)) byW.set(w, []);
        byW.get(w)!.push(Math.abs(((r.estimate - s.soldPrice) / s.soldPrice) * 100));
      }
    }
    const scored = WEIGHTS.map(w => ({ w, v: med(byW.get(w) ?? []) })).filter(x => Number.isFinite(x.v));
    const best = [...scored].sort((a, b) => a.v - b.v)[0];
    const atOne = scored.find(x => x.w === 1);

    console.log(
      `  ${m.name.padEnd(15)} ${String(full.length).padStart(5)} ${cod.toFixed(3).padStart(6)} ` +
        `${rMed.toFixed(2).padStart(9)} ${r2a.toFixed(3).padStart(9)} ${r2p.toFixed(3).padStart(11)}   ` +
        `${String(best?.w).padStart(5)}   ${(best?.v ?? NaN).toFixed(1).padStart(9)}%  ${(atOne?.v ?? NaN).toFixed(1).padStart(8)}%`
    );
  }

  console.log(
    "\n  COD  = coefficient of dispersion of sale-to-assessment ratios (IAAO uniformity measure)\n" +
      "  R2   = adjusted R² of that basis regressed on sale price, over the local pool\n" +
      "  bestW= empirically lowest-error blend weight (1 = assessment only, 0 = physical grid only)"
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
