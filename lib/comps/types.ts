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

/**
 * What a provider can say about the home being valued.
 *
 * `exactParcel` is the field that decides whether any of it may be SHOWN.
 *
 * Providers resolve a subject from a geocoded point, and they do not all
 * resolve the same thing. A containment query returns the parcel the point sits
 * in — those characteristics are facts about the homeowner's house. A widened
 * fallback, or `PostgresProvider` picking the nearest ingested sale, returns a
 * NEIGHBOUR: good enough to select comparable sales from, and wrong to print
 * back to the homeowner as "your home has 4 bedrooms".
 *
 * Both were previously indistinguishable to the caller, which is how DC spent
 * weeks describing the house next door. Set it true only for an exact match.
 */
export interface SubjectLookup extends Partial<SubjectProperty> {
  lastSalePrice?: number;
  lastSaleDate?: string;
  taxYear?: number;
  /** True only when this describes the parcel containing the requested point. */
  exactParcel?: boolean;
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
  /**
   * The market constants actually used, after calibration against the local
   * sales. Present so a surprising estimate can be traced to the numbers
   * behind it rather than guessed at.
   */
  market?: import("./config").MarketConfig;
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
  /**
   * Street addresses for the handful of comps that will actually be shown.
   *
   * Optional, and only implemented where the sales feed itself carries no
   * situs address — Fairfax's does not, so its comps arrive with `address`
   * empty and are resolved here instead.
   *
   * Called with the final six comps rather than the several hundred
   * candidates, because it costs a network round trip per property and only
   * the published ones are ever read by a human.
   *
   * Returns id → address. An id may be absent: a resolver that is not certain
   * which property it matched must omit it rather than guess, since a comp
   * labelled with the neighbour's address is worse than one labelled
   * "Nearby home".
   */
  resolveAddresses?(comps: ComparableSale[]): Promise<Map<string, string>>;
}
