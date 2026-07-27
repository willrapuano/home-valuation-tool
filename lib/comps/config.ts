import { PropertyType } from "./types";

/**
 * Market-specific tuning. Every number here is an assumption about a market,
 * not a universal truth — the defaults are calibrated for Northern Virginia
 * and MUST be re-derived before this is pointed at another region.
 *
 * The right way to set these is regression against closed sales in the target
 * market. Until that data is licensed, they are documented estimates.
 */
export interface MarketConfig {
  /** Marginal value of one additional finished square foot. */
  pricePerSqft: number;
  /** Marginal value of one additional square foot of lot. */
  pricePerLotSqft: number;
  /** Value of one additional full bathroom. */
  bathValue: number;
  /** Value of one additional bedroom (small — GLA already captures most of it). */
  bedValue: number;
  /** Annual value difference per year of effective age. */
  perYearOfAge: number;
  /** Value step between adjacent points on the 1–5 condition scale. */
  perConditionPoint: number;
  /** Annualised market appreciation, used to time-adjust older sales. */
  annualAppreciation: number;
}

export const NOVA_MARKET: MarketConfig = {
  pricePerSqft: 250,
  pricePerLotSqft: 12,
  bathValue: 15000,
  bedValue: 5000,
  perYearOfAge: 900,
  perConditionPoint: 25000,
  annualAppreciation: 0.04,
};

/** Weight of each similarity dimension. Normalised at use, so relative size is what matters. */
export interface ScoringWeights {
  distance: number;
  recency: number;
  sqft: number;
  lot: number;
  vintage: number;
  rooms: number;
  subdivision: number;
  schoolZone: number;
  condition: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  // Location dominates: a close comp in the same subdivision beats a
  // physically similar house a mile away. This is the main thing national
  // AVMs get wrong in neighbourhoods with hard boundaries.
  distance: 2.0,
  subdivision: 2.0,
  schoolZone: 1.25,
  // Size is the strongest physical driver.
  sqft: 1.75,
  recency: 1.5,
  vintage: 0.75,
  lot: 0.75,
  rooms: 0.5,
  condition: 0.5,
};

export interface EngineOptions {
  market: MarketConfig;
  weights: ScoringWeights;
  /** Hard filter: reject candidates beyond this distance. */
  maxDistanceMiles: number;
  /** Hard filter: reject sales older than this. */
  maxAgeMonths: number;
  /** Hard filter: reject comps whose GLA ratio to the subject falls outside this band. */
  minSqftRatio: number;
  maxSqftRatio: number;
  /** Hard filter: reject comps needing more than this in gross adjustments. */
  maxGrossAdjustmentRatio: number;
  /** Number of comps to reconcile from. */
  targetCompCount: number;
  /** Below this many usable comps, refuse to produce an estimate. */
  minCompCount: number;
  /** Evaluation date for recency and time adjustments (ISO). Defaults to today. */
  asOf?: string;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  market: NOVA_MARKET,
  weights: DEFAULT_WEIGHTS,
  maxDistanceMiles: 1.5,
  maxAgeMonths: 12,
  minSqftRatio: 0.65,
  maxSqftRatio: 1.5,
  // Appraisal practice treats comps needing very large adjustments as weak
  // evidence — past a point you are valuing a different house.
  maxGrossAdjustmentRatio: 0.35,
  targetCompCount: 6,
  minCompCount: 3,
};

/**
 * Property types that can stand in for one another. A townhouse is weak but
 * usable evidence for a detached home; a condo is not.
 */
const SUBSTITUTABLE: Record<PropertyType, PropertyType[]> = {
  single_family: ["single_family", "townhouse"],
  townhouse: ["townhouse", "single_family", "condo"],
  condo: ["condo", "townhouse"],
  multi_family: ["multi_family"],
  land: ["land"],
  other: ["other"],
};

export function isSubstitutable(subject: PropertyType, comp: PropertyType): boolean {
  return SUBSTITUTABLE[subject]?.includes(comp) ?? false;
}

/** Penalty applied when the comp is a usable but non-identical property type. */
export function propertyTypePenalty(subject: PropertyType, comp: PropertyType): number {
  return subject === comp ? 1 : 0.75;
}
