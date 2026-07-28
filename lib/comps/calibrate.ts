import { MarketConfig } from "./config";
import { ComparableSale } from "./types";

/**
 * Derive market constants from the local sales themselves.
 *
 * The adjustment grid needs to know what a square foot is worth, how fast the
 * market is moving, and what a year of age costs. Hardcoding those numbers is
 * the reason this engine only worked in one county: $250/sqft is roughly right
 * for Northern Virginia, 40% too low for Frederick, and 60% too low for
 * Bethesda. Every GLA adjustment in an expensive market was undersized, which
 * dragged every estimate toward the middle of the local price range.
 *
 * Measuring the constants from the same sales we are about to reconcile
 * removes the per-jurisdiction tuning step entirely: pointing the engine at a
 * new county calibrates it to that county on the first request.
 *
 * WHAT THIS IS NOT: a hedonic pricing model. The regression here has three
 * terms and exists only to size the adjustments in an appraisal grid. Every
 * coefficient is clamped to a plausible range and falls back to the supplied
 * prior when the local sample is too thin to support it, because an
 * unconstrained fit on 40 noisy records produces negative dollars per square
 * foot often enough to matter.
 */

/** Minimum usable rows before a coefficient is trusted over the prior. */
const MIN_ROWS = 25;
/** Minimum sales per half-window before a time trend is trusted. */
const MIN_TREND_ROWS = 12;

export interface Calibration {
  market: MarketConfig;
  /** Which constants were measured rather than inherited from the prior. */
  derived: string[];
  notes: string[];
  /** Median sale price per square foot locally, or undefined if unmeasurable. */
  medianPricePerSqft?: number;
  /** Median sale price locally, used to scale the room and condition terms. */
  medianPrice?: number;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function yearsBetween(iso: string, asOf: string): number {
  const a = Date.parse(iso);
  const b = Date.parse(asOf);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return (b - a) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Ordinary least squares on mean-centred predictors, with ridge regularisation.
 *
 * Centring removes the intercept and conditions the problem: raw square
 * footage (~2,000), lot size (~8,000) and year built (~1,960) differ enough in
 * scale that the uncentred normal equations lose most of their precision. The
 * ridge term is small but keeps the system solvable when two predictors are
 * nearly collinear, which happens whenever a subdivision was built out in one
 * pass and lot size tracks house size almost exactly.
 *
 * Returns one coefficient per predictor, or null if the system is degenerate.
 */
export function olsCentered(rows: number[][], y: number[], ridge = 1e-6): number[] | null {
  const n = rows.length;
  const k = rows[0]?.length ?? 0;
  if (n < 2 || k === 0) return null;

  const meanX = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  const X = rows.map(r => r.map((v, j) => v - meanX[j]));
  const Y = y.map(v => v - meanY);

  // Scale each column to unit standard deviation so the ridge penalty is
  // applied evenly rather than falling almost entirely on the largest column.
  const sd = Array.from({ length: k }, (_, j) => {
    const v = X.reduce((s, r) => s + r[j] * r[j], 0) / n;
    return Math.sqrt(v) || 1;
  });
  for (const r of X) for (let j = 0; j < k; j++) r[j] /= sd[j];

  // Normal equations: (XᵀX + λI) β = XᵀY
  const A: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? ridge * n : 0))
  );
  const b: number[] = Array.from({ length: k }, (_, i) => X.reduce((s, r, idx) => s + r[i] * Y[idx], 0));

  // Gauss-Jordan with partial pivoting.
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-9) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    const d = A[col][col];
    for (let j = col; j < k; j++) A[col][j] /= d;
    b[col] /= d;

    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let j = col; j < k; j++) A[r][j] -= f * A[col][j];
      b[r] -= f * b[col];
    }
  }

  // Undo the unit-variance scaling to return coefficients in original units.
  const beta = b.map((v, j) => v / sd[j]);
  return beta.every(Number.isFinite) ? beta : null;
}

/**
 * Annualised appreciation from the local sales.
 *
 * Compares median price per square foot in the older and newer halves of the
 * window, rather than fitting a line to price: a line through raw prices picks
 * up any drift in which houses happened to sell, and the mix of what sells
 * shifts seasonally.
 */
function estimateAppreciation(rows: ComparableSale[], asOf: string, prior: number): number | null {
  const usable = rows
    .filter(c => c.sqft && c.sqft > 300 && c.soldPrice > 0)
    .map(c => ({ ppsf: c.soldPrice / c.sqft!, t: yearsBetween(c.soldDate, asOf) }))
    .filter(r => Number.isFinite(r.t))
    .sort((a, b) => b.t - a.t);

  if (usable.length < MIN_TREND_ROWS * 2) return null;

  const mid = Math.floor(usable.length / 2);
  const older = usable.slice(0, mid);
  const newer = usable.slice(mid);
  if (older.length < MIN_TREND_ROWS || newer.length < MIN_TREND_ROWS) return null;

  const oldPpsf = median(older.map(r => r.ppsf));
  const newPpsf = median(newer.map(r => r.ppsf));
  const gap = median(older.map(r => r.t)) - median(newer.map(r => r.t));

  if (!(oldPpsf > 0) || !(newPpsf > 0) || !(gap > 0.25)) return null;

  const annual = Math.pow(newPpsf / oldPpsf, 1 / gap) - 1;
  if (!Number.isFinite(annual)) return null;

  // A half-window comparison over a thin sample can imply absurd rates. Cap at
  // a range that has actually occurred in US housing rather than trusting the
  // arithmetic; outside it, the prior is the better guess.
  return Math.abs(annual) > 0.35 ? prior : clamp(annual, -0.2, 0.25);
}

/**
 * Fit `MarketConfig` to a pool of local sales, falling back to `prior` for any
 * constant the sample cannot support.
 */
export function calibrateMarket(
  candidates: ComparableSale[],
  prior: MarketConfig,
  asOf: string
): Calibration {
  const market: MarketConfig = { ...prior };
  const derived: string[] = [];
  const notes: string[] = [];

  const priced = candidates.filter(c => c.soldPrice > 0);
  const medianPrice = priced.length ? median(priced.map(c => c.soldPrice)) : undefined;

  const withSqft = priced.filter(c => c.sqft && c.sqft > 300);
  const medianPricePerSqft = withSqft.length >= MIN_ROWS
    ? median(withSqft.map(c => c.soldPrice / c.sqft!))
    : undefined;

  const appreciation = estimateAppreciation(priced, asOf, prior.annualAppreciation);
  if (appreciation !== null) {
    market.annualAppreciation = appreciation;
    derived.push("annualAppreciation");
  }

  // Remove the time trend before fitting the physical terms, so a rising
  // market does not get attributed to whatever happened to sell late in it.
  const detrend = (c: ComparableSale) => {
    const t = yearsBetween(c.soldDate, asOf);
    if (!Number.isFinite(t)) return c.soldPrice;
    return c.soldPrice * Math.pow(1 + market.annualAppreciation, t);
  };

  const fitRows = priced.filter(
    c => c.sqft && c.sqft > 300 && c.lotSqft && c.lotSqft > 0 && c.yearBuilt && c.yearBuilt > 1800
  );

  if (fitRows.length >= MIN_ROWS && medianPricePerSqft) {
    const beta = olsCentered(
      fitRows.map(c => [c.sqft!, c.lotSqft!, c.yearBuilt!]),
      fitRows.map(detrend)
    );

    if (beta) {
      const [bSqft, bLot, bYear] = beta;

      // The marginal square foot is worth less than the average one: part of
      // any sale price is land and location, which do not scale with the
      // house. Appraisal practice puts the marginal contribution well below
      // average $/sqft, so the fit is clamped into that region rather than
      // trusted outright.
      market.pricePerSqft = clamp(bSqft, medianPricePerSqft * 0.2, medianPricePerSqft * 0.85);
      derived.push("pricePerSqft");

      market.pricePerLotSqft = clamp(bLot, 0, market.pricePerSqft * 0.25);
      derived.push("pricePerLotSqft");

      // A newer house is worth more, never less; a negative coefficient here
      // means age is standing in for neighbourhood rather than for condition.
      const perYear = clamp(bYear, 0, (medianPrice ?? 0) * 0.006);
      if (perYear > 0) {
        market.perYearOfAge = perYear;
        derived.push("perYearOfAge");
      }
    } else {
      notes.push("Local regression was degenerate; using prior physical adjustments.");
    }
  } else if (medianPricePerSqft) {
    // Not enough rows carry every characteristic, but $/sqft alone is still a
    // far better anchor than a constant from another market.
    market.pricePerSqft = clamp(
      medianPricePerSqft * 0.5,
      medianPricePerSqft * 0.2,
      medianPricePerSqft * 0.85
    );
    derived.push("pricePerSqft (from median $/sqft, too few complete records to regress)");
  }

  // Room and condition steps are not identifiable from this data — Maryland
  // publishes neither bed nor bath counts — but a flat $25,000 condition step
  // means something very different on a $450,000 house than on a $1.4M one.
  // Scaling them to the local median keeps them proportionate.
  if (medianPrice && medianPrice > 0) {
    market.perConditionPoint = clamp(medianPrice * 0.05, 5_000, 250_000);
    market.bathValue = clamp(medianPrice * 0.02, 5_000, 100_000);
    market.bedValue = clamp(medianPrice * 0.007, 2_000, 40_000);
    derived.push("perConditionPoint", "bathValue", "bedValue");
  }

  // Sale-to-assessment ratio, from records whose assessment is plausible at
  // all. Maryland reassesses on a three-year cycle and publishes land-only
  // records for some parcels, so a raw median over everything is dragged by
  // sales priced at a hundred times their "assessment".
  const ratios = priced
    .filter(c => c.assessedValue && c.assessedValue > 0)
    .map(c => c.soldPrice / c.assessedValue!)
    .filter(r => r > 0.2 && r < 5);

  if (ratios.length >= MIN_ROWS) {
    market.saleToAssessedRatio = clamp(median(ratios), 0.3, 3);
    derived.push("saleToAssessedRatio");
  }

  // Where nobody nearby has an assessment, the grid is the only basis there
  // is. This is the only case in which the weight is inferred rather than
  // configured.
  //
  // An earlier version derived the weight from the IAAO coefficient of
  // dispersion of local sale-to-assessment ratios, on the theory that
  // non-uniform assessments should be trusted less. Swept against 300 Maryland
  // holdout sales it moved the median error by 0.1 percentage points — inside
  // the noise — because dispersion turned out not to predict which basis wins:
  // Frederick's assessments explain almost none of the local price variance
  // (adjusted R² 0.03) and still beat the physical grid, because what the
  // adjustment grid needs is not a good absolute predictor but a consistent
  // relative one. The derivation was removed rather than kept as decoration.
  if (!priced.some(c => c.assessedValue && c.assessedValue > 0)) {
    market.assessmentWeight = 0;
  }

  if (derived.length) {
    notes.push(
      `Market constants calibrated from ${priced.length} local sales: ` +
        `$${market.pricePerSqft.toFixed(0)}/sqft, ` +
        `${(market.annualAppreciation * 100).toFixed(1)}%/yr appreciation.`
    );
  } else {
    notes.push("Too few local sales to calibrate; using default market constants.");
  }

  return { market, derived, notes, medianPricePerSqft, medianPrice };
}
