import { adjustComp } from "./adjust";
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
  const opts: EngineOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);

  const rejected: { comp: ComparableSale; reason: string }[] = [];
  const scored: ScoredComp[] = [];

  for (const comp of candidates) {
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

  const result = reconcile(selected, { minCompCount: opts.minCompCount });

  if (rejected.length) {
    result.notes.push(`${rejected.length} candidate(s) excluded by filters.`);
  }

  return { ...result, comps: selected, rejected };
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
