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

  // An assessment already prices size, quality, condition and lot together,
  // so when one is available for both properties it REPLACES the physical
  // grid rather than adding to it. Applying both would double-count the same
  // differences — a bigger house would be adjusted for its extra square
  // footage once via GLA and again via the higher assessment it produces.
  const useAssessment = Boolean(subject.assessedValue && comp.assessedValue);

  if (useAssessment) {
    adjustments.assessed =
      (subject.assessedValue! - comp.assessedValue!) * market.saleToAssessedRatio;
  } else {
    if (subject.sqft && comp.sqft) {
      adjustments.gla = (subject.sqft - comp.sqft) * market.pricePerSqft;
    }
    if (subject.lotSqft && comp.lotSqft) {
      adjustments.lot = (subject.lotSqft - comp.lotSqft) * market.pricePerLotSqft;
    }
    if (subject.baths && comp.baths) {
      adjustments.baths = (subject.baths - comp.baths) * market.bathValue;
    }
    if (subject.beds && comp.beds) {
      adjustments.beds = (subject.beds - comp.beds) * market.bedValue;
    }
    if (subject.yearBuilt && comp.yearBuilt) {
      // Newer subject than comp => positive adjustment.
      adjustments.age = (subject.yearBuilt - comp.yearBuilt) * market.perYearOfAge;
    }
    if (subject.condition && comp.condition) {
      adjustments.condition = (subject.condition - comp.condition) * market.perConditionPoint;
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
