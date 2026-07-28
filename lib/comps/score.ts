import { ScoringWeights } from "./config";
import { ComparableSale, SubjectProperty } from "./types";

/**
 * Similarity scoring.
 *
 * Every dimension returns a value in [0,1] where 1 means "indistinguishable
 * from the subject". Dimensions the data can't answer return `null` and are
 * dropped from the weighted average rather than scored as 0 — a missing lot
 * size should not make a comp look bad, it should just carry no opinion.
 */

/** Exponential decay: 1 at zero, `half` at the half-life, asymptotic to 0. */
export function decay(value: number, half: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.pow(0.5, value / half);
}

/**
 * Similarity of two magnitudes, judged on their ratio rather than their
 * difference — 200 sqft matters far more on a 900 sqft condo than on a
 * 6,000 sqft house.
 */
export function ratioSimilarity(a: number | undefined, b: number | undefined, tolerance = 0.25): number | null {
  if (!a || !b || a <= 0 || b <= 0) return null;
  const ratio = Math.min(a, b) / Math.max(a, b);
  const deviation = 1 - ratio;
  return clamp01(1 - deviation / tolerance);
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Case- and whitespace-insensitive comparison for names like subdivisions. */
export function sameName(a?: string, b?: string): boolean | null {
  if (!a || !b) return null;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface DimensionInput {
  subject: SubjectProperty;
  comp: ComparableSale;
  distanceMiles: number;
  ageMonths: number;
}

/**
 * Score each dimension independently. Half-lives encode how fast each factor
 * stops mattering: distance decays fast (0.4mi), recency slower (6 months).
 */
export function scoreDimensions(input: DimensionInput): Record<string, number | null> {
  const { subject, comp, distanceMiles, ageMonths } = input;

  const subdivisionMatch = sameName(subject.subdivision, comp.subdivision);
  const schoolMatch = sameName(subject.schoolZone, comp.schoolZone);

  return {
    distance: decay(distanceMiles, 0.4),
    recency: decay(ageMonths, 6),
    sqft: ratioSimilarity(subject.sqft, comp.sqft, 0.3),
    lot: ratioSimilarity(subject.lotSqft, comp.lotSqft, 0.6),
    vintage:
      subject.yearBuilt && comp.yearBuilt
        ? decay(Math.abs(subject.yearBuilt - comp.yearBuilt), 15)
        : null,
    rooms: scoreRooms(subject, comp),
    // A same-subdivision comp is the strongest signal available in tract
    // housing; a different one is not disqualifying, just uninformative.
    subdivision: subdivisionMatch === null ? null : subdivisionMatch ? 1 : 0.35,
    schoolZone: schoolMatch === null ? null : schoolMatch ? 1 : 0.4,
    condition:
      subject.condition && comp.condition
        ? clamp01(1 - Math.abs(subject.condition - comp.condition) / 4)
        : null,
    // Two homes assessed similarly are usually similar in size, quality and
    // condition together — the single most useful dimension when building
    // characteristics aren't published.
    assessedValue: ratioSimilarity(subject.assessedValue, comp.assessedValue, 0.35),
  };
}

function scoreRooms(subject: SubjectProperty, comp: ComparableSale): number | null {
  const parts: number[] = [];
  if (subject.beds && comp.beds) {
    parts.push(clamp01(1 - Math.abs(subject.beds - comp.beds) / 3));
  }
  if (subject.baths && comp.baths) {
    parts.push(clamp01(1 - Math.abs(subject.baths - comp.baths) / 3));
  }
  if (!parts.length) return null;
  return parts.reduce((s, n) => s + n, 0) / parts.length;
}

/**
 * Collapse the dimensions into one similarity score, renormalising over
 * whichever dimensions actually had data.
 */
export function weightedScore(
  dimensions: Record<string, number | null>,
  weights: ScoringWeights
): { score: number; used: Record<string, number> } {
  let weightSum = 0;
  let acc = 0;
  const used: Record<string, number> = {};

  for (const [key, value] of Object.entries(dimensions)) {
    if (value === null || !Number.isFinite(value)) continue;
    const weight = weights[key as keyof ScoringWeights] ?? 0;
    if (weight <= 0) continue;
    used[key] = value;
    acc += value * weight;
    weightSum += weight;
  }

  // No usable dimensions at all — express that as zero confidence, not 1.
  if (weightSum === 0) return { score: 0, used };
  return { score: clamp01(acc / weightSum), used };
}
