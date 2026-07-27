import { ScoredComp, ValuationResult } from "./types";

/**
 * Reconciliation — turning a set of adjusted comps into one number plus an
 * honest range.
 *
 * The range is derived from how much the comps actually disagree, not from a
 * fixed percentage. Tightly clustered comps earn a narrow band; scattered
 * ones produce a wide band, which is the correct answer rather than a
 * presentational failure.
 */

export interface ReconcileOptions {
  minCompCount: number;
  /** Multiplier on weighted dispersion when forming the range. */
  bandMultiplier?: number;
  /** Range never narrower than this fraction of the estimate. */
  minBandRatio?: number;
  /** Range never wider than this fraction of the estimate. */
  maxBandRatio?: number;
}

export function reconcile(
  comps: ScoredComp[],
  opts: ReconcileOptions
): Pick<ValuationResult, "estimate" | "low" | "high" | "confidence" | "confidenceScore" | "notes"> {
  const notes: string[] = [];
  const bandMultiplier = opts.bandMultiplier ?? 1.5;
  const minBandRatio = opts.minBandRatio ?? 0.04;
  const maxBandRatio = opts.maxBandRatio ?? 0.3;

  if (comps.length < opts.minCompCount) {
    notes.push(
      `Only ${comps.length} usable comparable${comps.length === 1 ? "" : "s"} found; ` +
        `at least ${opts.minCompCount} are needed for an estimate.`
    );
    return { estimate: null, low: null, high: null, confidence: "none", confidenceScore: 0, notes };
  }

  // Similarity-weighted mean. Squaring sharpens the preference for the best
  // comps without discarding the tail entirely.
  const weights = comps.map(c => c.score ** 2);
  const weightSum = weights.reduce((s, n) => s + n, 0);

  if (weightSum <= 0) {
    notes.push("No comparable carried usable similarity signal.");
    return { estimate: null, low: null, high: null, confidence: "none", confidenceScore: 0, notes };
  }

  const estimate =
    comps.reduce((s, c, i) => s + c.adjustedPrice * weights[i], 0) / weightSum;

  // Weighted standard deviation of the adjusted prices.
  const variance =
    comps.reduce((s, c, i) => s + weights[i] * (c.adjustedPrice - estimate) ** 2, 0) / weightSum;
  const stdDev = Math.sqrt(variance);
  const dispersion = estimate > 0 ? stdDev / estimate : 1;

  const bandRatio = Math.min(maxBandRatio, Math.max(minBandRatio, dispersion * bandMultiplier));
  const low = Math.round(estimate * (1 - bandRatio));
  const high = Math.round(estimate * (1 + bandRatio));

  const meanScore = comps.reduce((s, c) => s + c.score, 0) / comps.length;
  const meanGross = comps.reduce((s, c) => s + c.grossAdjustmentRatio, 0) / comps.length;

  const confidenceScore = scoreConfidence({
    compCount: comps.length,
    meanScore,
    dispersion,
    meanGrossAdjustment: meanGross,
  });

  notes.push(
    `Reconciled from ${comps.length} comparables ` +
      `(mean similarity ${(meanScore * 100).toFixed(0)}%, ` +
      `price dispersion ${(dispersion * 100).toFixed(1)}%, ` +
      `mean gross adjustment ${(meanGross * 100).toFixed(0)}%).`
  );
  if (dispersion > 0.15) {
    notes.push("Comparables disagree substantially — the range is correspondingly wide.");
  }

  return {
    estimate: Math.round(estimate),
    low,
    high,
    confidence: bucket(confidenceScore),
    confidenceScore: Number(confidenceScore.toFixed(3)),
    notes,
  };
}

interface ConfidenceInput {
  compCount: number;
  meanScore: number;
  dispersion: number;
  meanGrossAdjustment: number;
}

/**
 * Confidence combines four independent signals, then lets disagreement veto
 * the result.
 *
 * The blend alone is too generous in one important case: comps that are
 * physically near-identical to the subject but sold at wildly different
 * prices. Similarity and adjustment signals both stay high, so the average
 * lands mid-range — yet that is precisely the situation where we do NOT know
 * the answer. Similarity tells you the comps are *relevant*; dispersion tells
 * you whether they *agree*. When they don't, no amount of relevance should
 * rescue the score, so agreement caps the final value rather than merely
 * contributing to it.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  const countSignal = Math.min(1, input.compCount / 6);
  const similaritySignal = Math.max(0, Math.min(1, input.meanScore));
  // 0% dispersion => 1, 20%+ => 0.
  const agreementSignal = Math.max(0, 1 - input.dispersion / 0.2);
  // 0% adjustment => 1, 35%+ => 0.
  const adjustmentSignal = Math.max(0, 1 - input.meanGrossAdjustment / 0.35);

  const blend =
    countSignal * 0.2 +
    similaritySignal * 0.3 +
    agreementSignal * 0.3 +
    adjustmentSignal * 0.2;

  // Total disagreement caps confidence at 0.35, i.e. "low".
  const agreementCap = 0.35 + 0.65 * agreementSignal;

  return Math.max(0, Math.min(blend, agreementCap));
}

function bucket(score: number): "high" | "medium" | "low" {
  if (score >= 0.72) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}
