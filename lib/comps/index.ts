import { adjustComp } from "./adjust";
import { calibrateMarket } from "./calibrate";
import {
  DEFAULT_OPTIONS,
  EngineOptions,
  isSubstitutable,
  propertyTypePenalty,
} from "./config";
import { haversineMiles, monthsBetween } from "./geo";
import { reconcile } from "./reconcile";
import { scoreDimensions, weightedScore } from "./score";
import {
  ComparableSale,
  CompsProvider,
  ScoredComp,
  SubjectProperty,
  ValuationResult,
} from "./types";

export * from "./types";
export { DEFAULT_OPTIONS, NOVA_MARKET, DEFAULT_WEIGHTS } from "./config";
export { reconcile, scoreConfidence } from "./reconcile";
export { haversineMiles, monthsBetween } from "./geo";

/**
 * Rank a set of candidate sales against a subject property and reconcile them
 * into a valuation.
 *
 * The order matters: candidates are knocked out by hard filters first, then
 * scored, then the best N are adjusted and reconciled. Filtering before
 * scoring keeps obviously-wrong candidates from influencing the confidence
 * signals.
 */
export function valueFromComps(
  subject: SubjectProperty,
  candidates: ComparableSale[],
  overrides: Partial<EngineOptions> = {}
): ValuationResult {
  const base: EngineOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const asOf = base.asOf ?? new Date().toISOString().slice(0, 10);

  // Fit the adjustment constants to this market before adjusting anything.
  // An explicit `market` override means the caller has measured it themselves,
  // so it is treated as final rather than as a starting point.
  const calibration =
    base.calibrate === false || overrides.market
      ? null
      : calibrateMarket(candidates, base.market, asOf);

  const opts: EngineOptions = {
    ...base,
    market: {
      ...(calibration ? calibration.market : base.market),
      ...(base.marketOverrides ?? {}),
    },
  };

  const rejected: { comp: ComparableSale; reason: string }[] = [];
  const scored: ScoredComp[] = [];
  const notes: string[] = calibration ? [...calibration.notes] : [];
  let strippedAssessments = 0;

  // Needs the whole candidate set, so it can't live in the per-comp knockout.
  const ratioBand = assessmentRatioBand(candidates, opts);

  for (const raw of candidates) {
    let comp = raw;

    if (ratioBand && comp.assessedValue) {
      const ratio = comp.soldPrice / comp.assessedValue;
      if (ratio < ratioBand.min || ratio > ratioBand.max) {
        // Two very different things look identical here: a sale that was not
        // arm's-length, and a sale that was perfectly ordinary against an
        // assessment record that is stale or land-only. Maryland publishes
        // $1,200 assessments on houses that sold for $1.4M, so treating every
        // outlier as a bad sale threw away a quarter of the usable comps.
        //
        // Square footage breaks the tie: if the price is normal for the size
        // of the house, the assessment is the unreliable number, so drop the
        // assessment and keep the sale.
        if (looksNormalForSize(comp, calibration?.medianPricePerSqft)) {
          comp = { ...comp, assessedValue: undefined };
          strippedAssessments++;
        } else {
          rejected.push({
            comp,
            reason:
              `sold at ${ratio.toFixed(2)}× assessed value, outside the local ` +
              `${ratioBand.min.toFixed(2)}–${ratioBand.max.toFixed(2)}× band ` +
              `(likely a teardown, renovation or non-market transfer)`,
          });
          continue;
        }
      }
    }

    const reason = knockout(subject, comp, asOf, opts);
    if (reason) {
      rejected.push({ comp, reason });
      continue;
    }

    const distanceMiles = haversineMiles(subject.location, comp.location);
    const ageMonths = monthsBetween(comp.soldDate, asOf);

    const adjusted = adjustComp(subject, comp, ageMonths, opts.market);

    // An adjustment grid this large means we are valuing a different house.
    if (adjusted.grossAdjustmentRatio > opts.maxGrossAdjustmentRatio) {
      rejected.push({
        comp,
        reason: `gross adjustments ${(adjusted.grossAdjustmentRatio * 100).toFixed(0)}% exceed ${(
          opts.maxGrossAdjustmentRatio * 100
        ).toFixed(0)}% limit`,
      });
      continue;
    }

    const dimensions = scoreDimensions({ subject, comp, distanceMiles, ageMonths });
    const { score, used } = weightedScore(dimensions, opts.weights);

    scored.push({
      comp,
      score: score * propertyTypePenalty(subject.propertyType, comp.propertyType),
      dimensions: used,
      adjustedPrice: adjusted.adjustedPrice,
      adjustments: adjusted.adjustments,
      grossAdjustmentRatio: adjusted.grossAdjustmentRatio,
      netAdjustmentRatio: adjusted.netAdjustmentRatio,
      distanceMiles: Number(distanceMiles.toFixed(3)),
      ageMonths,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, opts.targetCompCount);

  const result = reconcile(selected, {
    minCompCount: opts.minCompCount,
    bandMultiplier: opts.bandMultiplier,
    minBandRatio: opts.minBandRatio,
    maxBandRatio: opts.maxBandRatio,
  });

  result.notes.unshift(...notes);

  if (strippedAssessments) {
    result.notes.push(
      `${strippedAssessments} comp(s) kept but valued on physical characteristics ` +
        `only, their assessment records being implausible.`
    );
  }
  if (rejected.length) {
    result.notes.push(`${rejected.length} candidate(s) excluded by filters.`);
  }

  return { ...result, comps: selected, rejected, market: opts.market };
}

/**
 * Is this sale price ordinary for a house of this size in this market?
 *
 * Used only to decide whether a wild sale-to-assessment ratio indicts the sale
 * or the assessment. Deliberately loose — it is asking "is this within the
 * range of normal", not "is this the right price".
 */
function looksNormalForSize(comp: ComparableSale, medianPricePerSqft?: number): boolean {
  if (!comp.sqft || comp.sqft <= 300 || !medianPricePerSqft || medianPricePerSqft <= 0) {
    return false;
  }
  const ratio = comp.soldPrice / (comp.sqft * medianPricePerSqft);
  return ratio >= 0.45 && ratio <= 2.2;
}

/**
 * Acceptable band of sale-to-assessment ratios, centred on the local median.
 *
 * Returns null unless there are enough assessed comps to establish a median
 * worth trusting — with a handful of sales the "outliers" are just the sample.
 */
export function assessmentRatioBand(
  candidates: ComparableSale[],
  opts: Pick<EngineOptions, "maxAssessmentRatioDeviation">
): { median: number; min: number; max: number } | null {
  const ratios = candidates
    .filter(c => c.assessedValue && c.assessedValue > 0 && c.soldPrice > 0)
    .map(c => c.soldPrice / c.assessedValue!)
    .sort((a, b) => a - b);

  if (ratios.length < 8) return null;

  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
  if (!Number.isFinite(median) || median <= 0) return null;

  const dev = opts.maxAssessmentRatioDeviation;
  return { median, min: median * (1 - dev), max: median * (1 + dev) };
}

/** Hard filters. Returns a reason string when the candidate is unusable. */
function knockout(
  subject: SubjectProperty,
  comp: ComparableSale,
  asOf: string,
  opts: EngineOptions
): string | null {
  if (!comp.soldPrice || comp.soldPrice <= 0) return "no sale price";
  if (!comp.location) return "no location";

  if (!isSubstitutable(subject.propertyType, comp.propertyType)) {
    return `property type ${comp.propertyType} not comparable to ${subject.propertyType}`;
  }

  const ageMonths = monthsBetween(comp.soldDate, asOf);
  if (!Number.isFinite(ageMonths)) return "invalid sale date";
  if (ageMonths > opts.maxAgeMonths) {
    return `sold ${ageMonths} months ago, beyond ${opts.maxAgeMonths} month lookback`;
  }

  const distance = haversineMiles(subject.location, comp.location);
  if (!Number.isFinite(distance)) return "invalid location";
  if (distance > opts.maxDistanceMiles) {
    return `${distance.toFixed(2)} miles away, beyond ${opts.maxDistanceMiles} mile radius`;
  }

  if (subject.sqft && comp.sqft) {
    const ratio = comp.sqft / subject.sqft;
    if (ratio < opts.minSqftRatio || ratio > opts.maxSqftRatio) {
      return `${comp.sqft} sqft is ${ratio.toFixed(2)}x the subject, outside the ${opts.minSqftRatio}–${opts.maxSqftRatio} band`;
    }
  }

  return null;
}

/** Convenience wrapper: pull candidates from a provider, then value. */
export async function valueWithProvider(
  subject: SubjectProperty,
  provider: CompsProvider,
  overrides: Partial<EngineOptions> = {}
): Promise<ValuationResult> {
  const opts: EngineOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const candidates = await provider.fetchCandidates(subject, {
    // Over-fetch relative to the hard filters so ranking has something to
    // choose from rather than just accepting whatever came back.
    radiusMiles: opts.maxDistanceMiles,
    lookbackMonths: opts.maxAgeMonths,
    limit: Math.max(50, opts.targetCompCount * 8),
  });
  return valueFromComps(subject, candidates, overrides);
}
