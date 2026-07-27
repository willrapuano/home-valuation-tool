/**
 * Core types for the comparable-sales valuation engine.
 *
 * The engine is deliberately decoupled from any particular data source. It
 * consumes candidate sales from a `CompsProvider` and knows nothing about
 * where they came from — MLS feed, county assessor records, or fixtures in a
 * test. Swapping providers must not require touching the scoring logic.
 */

export type PropertyType =
  | "single_family"
  | "townhouse"
  | "condo"
  | "multi_family"
  | "land"
  | "other";

/** Condition on a 1–5 scale, 3 being average for the neighbourhood. */
export type Condition = 1 | 2 | 3 | 4 | 5;

/** The home being valued. Only `location` and `propertyType` are required. */
export interface SubjectProperty {
  location: LatLng;
  propertyType: PropertyType;
  sqft?: number;
  lotSqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number;
  condition?: Condition;
  subdivision?: string;
  schoolZone?: string;
  zipCode?: string;
  /**
   * Total assessed value from the taxing authority.
   *
   * Valuable where building characteristics aren't published: an assessment
   * already encodes size, quality, condition and lot in one number, produced
   * by someone who inspects the property. In jurisdictions that assess at
   * full market value (Virginia requires 100% of fair market value), the
   * difference between two assessments approximates the difference in market
   * value, which makes it a better adjustment basis than square footage.
   */
  assessedValue?: number;
}

/** A closed sale that might serve as a comparable. */
export interface ComparableSale extends SubjectProperty {
  id: string;
  address: string;
  /** Closed sale price in dollars. */
  soldPrice: number;
  /** ISO date (YYYY-MM-DD) the sale closed. */
  soldDate: string;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** How a single comp scored against the subject, dimension by dimension. */
export interface ScoredComp {
  comp: ComparableSale;
  /** Weighted similarity in [0,1]. Higher is more comparable. */
  score: number;
  /** Per-dimension similarity in [0,1], before weighting. */
  dimensions: Record<string, number>;
  /** Sale price after adjusting toward the subject. */
  adjustedPrice: number;
  /** Signed dollar adjustments applied, by reason. */
  adjustments: Record<string, number>;
  /** Sum of absolute adjustments as a fraction of sale price. */
  grossAdjustmentRatio: number;
  /** Sum of signed adjustments as a fraction of sale price. */
  netAdjustmentRatio: number;
  distanceMiles: number;
  ageMonths: number;
}

export interface ValuationResult {
  /** Reconciled point estimate, or null when there was nothing usable. */
  estimate: number | null;
  low: number | null;
  high: number | null;
  confidence: "high" | "medium" | "low" | "none";
  /** 0–1 score behind the confidence bucket, for tuning and debugging. */
  confidenceScore: number;
  /** Comps that survived filtering, best first. */
  comps: ScoredComp[];
  /** Candidates rejected by hard filters, with the reason why. */
  rejected: { comp: ComparableSale; reason: string }[];
  /** Human-readable notes about how the estimate was reached. */
  notes: string[];
}

/**
 * Source of candidate sales. Implementations must not filter for
 * comparability — return everything nearby and let the engine rank it.
 */
export interface CompsProvider {
  readonly name: string;
  fetchCandidates(
    subject: SubjectProperty,
    opts: { radiusMiles: number; lookbackMonths: number; limit?: number }
  ): Promise<ComparableSale[]>;
}
