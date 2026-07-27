import { ComparableSale, CompsProvider, SubjectProperty } from "./types";

/**
 * Test/development fixtures. A subject in McLean plus a set of candidate
 * sales positioned to exercise each filter and scoring dimension.
 *
 * Coordinates are real enough to produce sensible distances; prices are
 * illustrative, not market data.
 */

export const SUBJECT: SubjectProperty = {
  location: { lat: 38.94, lng: -77.161 },
  propertyType: "single_family",
  sqft: 3000,
  lotSqft: 12000,
  beds: 4,
  baths: 3,
  yearBuilt: 1995,
  condition: 3,
  subdivision: "Ballantrae",
  schoolZone: "Churchill Road ES",
  zipCode: "22101",
};

/** ~0.05 miles from the subject at this latitude. */
const NEAR = { lat: 38.9407, lng: -77.1615 };
const MID = { lat: 38.9455, lng: -77.166 };  // ~0.45 mi
const FAR = { lat: 38.98, lng: -77.21 };     // ~3.5 mi

export function comp(overrides: Partial<ComparableSale> & { id: string }): ComparableSale {
  return {
    address: `${overrides.id} Test Ln`,
    location: NEAR,
    propertyType: "single_family",
    soldPrice: 1_200_000,
    soldDate: "2026-05-01",
    sqft: 3000,
    lotSqft: 12000,
    beds: 4,
    baths: 3,
    yearBuilt: 1995,
    condition: 3,
    subdivision: "Ballantrae",
    schoolZone: "Churchill Road ES",
    ...overrides,
  };
}

/** A tight, high-quality comp set — should reconcile confidently. */
export const TIGHT_COMPS: ComparableSale[] = [
  comp({ id: "A", soldPrice: 1_190_000 }),
  comp({ id: "B", soldPrice: 1_210_000, sqft: 3050 }),
  comp({ id: "C", soldPrice: 1_205_000, location: MID }),
  comp({ id: "D", soldPrice: 1_195_000, sqft: 2950 }),
];

/** Same count, wildly inconsistent prices — should widen the band and drop confidence. */
export const SCATTERED_COMPS: ComparableSale[] = [
  comp({ id: "A", soldPrice: 900_000 }),
  comp({ id: "B", soldPrice: 1_500_000 }),
  comp({ id: "C", soldPrice: 1_050_000, location: MID }),
  comp({ id: "D", soldPrice: 1_400_000 }),
];

export const FAR_COMP = comp({ id: "FAR", location: FAR });
export const STALE_COMP = comp({ id: "STALE", soldDate: "2023-01-01" });
export const CONDO_COMP = comp({ id: "CONDO", propertyType: "condo" });
export const TINY_COMP = comp({ id: "TINY", sqft: 900 });

/** In-memory provider, useful for development before a licensed feed exists. */
export class FixtureCompsProvider implements CompsProvider {
  readonly name = "fixture";
  constructor(private readonly candidates: ComparableSale[]) {}
  async fetchCandidates(): Promise<ComparableSale[]> {
    return this.candidates;
  }
}
