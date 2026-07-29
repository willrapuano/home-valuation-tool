import { MarketConfig } from "./config";
import { ComparableSale, SubjectProperty } from "./types";

/**
 * Appraisal-style adjustment grid.
 *
 * Each adjustment answers: "what would this comp have sold for if it were
 * more like the subject?" Positive means the comp is inferior and its price
 * is revised upward; negative means it is superior and revised down.
 *
 * The time adjustment is the one most often skipped and most often material —
 * a sale from ten months ago in an appreciating market understates today's
 * value regardless of how physically similar the house is.
 */

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

export interface AdjustmentResult {
  adjustedPrice: number;
  adjustments: Record<string, number>;
  grossAdjustmentRatio: number;
  netAdjustmentRatio: number;
}

export function adjustComp(
  subject: SubjectProperty,
  comp: ComparableSale,
  ageMonths: number,
  market: MarketConfig
): AdjustmentResult {
  const adjustments: Record<string, number> = {};

  // Market movement between the comp's closing and today.
  if (ageMonths > 0 && market.annualAppreciation !== 0) {
    const factor = Math.pow(1 + market.annualAppreciation, ageMonths / 12) - 1;
    adjustments.time = comp.soldPrice * factor;
  }

  // Two ways to say how the subject differs from the comp, and they overlap
  // almost entirely: an assessment already prices size, quality, condition and
  // lot together. Summing both would double-count every difference — a bigger
  // house adjusted once for its extra square footage and again for the higher
  // assessment that square footage produced.
  //
  // So they are alternatives, blended rather than summed. The weight is how
  // much the local assessor is worth listening to, measured from the spread of
  // sale-to-assessment ratios nearby; see calibrate.ts. Where the assessment
  // is fresh it does the whole job, where it is stale the grid takes over, and
  // in between the estimate leans on both.
  const assessedAvailable = Boolean(subject.assessedValue && comp.assessedValue);

  const physical: Record<string, number> = {};
  if (subject.sqft && comp.sqft) {
    physical.gla = (subject.sqft - comp.sqft) * market.pricePerSqft;
  }
  if (subject.lotSqft && comp.lotSqft) {
    physical.lot = (subject.lotSqft - comp.lotSqft) * market.pricePerLotSqft;
  }
  if (subject.baths && comp.baths) {
    physical.baths = (subject.baths - comp.baths) * market.bathValue;
  }
  if (subject.beds && comp.beds) {
    physical.beds = (subject.beds - comp.beds) * market.bedValue;
  }
  if (subject.yearBuilt && comp.yearBuilt) {
    // Newer subject than comp => positive adjustment.
    physical.age = (subject.yearBuilt - comp.yearBuilt) * market.perYearOfAge;
  }
  if (subject.condition && comp.condition) {
    physical.condition = (subject.condition - comp.condition) * market.perConditionPoint;
  }

  // Living area is what carries the physical grid; without it the remaining
  // terms describe a house too vaguely to stand as an alternative basis, and
  // blending toward them would just dilute a good assessment toward zero.
  const physicalAvailable = "gla" in physical;

  // Only blend where both bases genuinely exist. Falling back to a weighted
  // average against a missing basis would silently shrink every adjustment
  // toward no adjustment at all, which reads as confidence rather than as the
  // absence of data it really is.
  const w = assessedAvailable && physicalAvailable ? clamp01(market.assessmentWeight) : assessedAvailable ? 1 : 0;

  if (w > 0) {
    adjustments.assessed =
      (subject.assessedValue! - comp.assessedValue!) * market.saleToAssessedRatio * w;
  }
  if (w < 1) {
    for (const [k, v] of Object.entries(physical)) {
      adjustments[k] = v * (1 - w);
    }
  }

  const values = Object.values(adjustments);
  const net = values.reduce((s, n) => s + n, 0);
  const gross = values.reduce((s, n) => s + Math.abs(n), 0);

  return {
    adjustedPrice: Math.max(0, comp.soldPrice + net),
    adjustments,
    grossAdjustmentRatio: comp.soldPrice > 0 ? gross / comp.soldPrice : 0,
    netAdjustmentRatio: comp.soldPrice > 0 ? net / comp.soldPrice : 0,
  };
}
