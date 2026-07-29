import { ScoredComp } from "./types";

/**
 * The comparable sales, shaped for a homeowner.
 *
 * WHY THIS EXISTS
 *
 * `/api/avm` returned a hardcoded `comps: []` on every response while the
 * engine was computing, and discarding, the address, price, date, distance and
 * full adjustment grid for each of the six comps behind the number.
 *
 * That is the entire differentiator thrown away. A Zestimate is a number from
 * nowhere; what an agent actually does is say "these four houses on your
 * street sold for this, yours is bigger, here is the math". We already do the
 * second thing and were showing the first.
 *
 * It is also the honest thing to publish. An estimate a homeowner can check
 * against sales they recognise is one they can argue with — and an argument
 * about which comps are right is the conversation the agent wants to be having.
 *
 * PRIVACY: every field here comes from published sale records — the same data
 * on any county property search. Nothing about the *subject* is included, and
 * nothing about the visitor.
 */

export interface PublicComp {
  address: string;
  soldPrice: number;
  soldDate: string;
  distanceMiles: number;
  /** Months between that sale and the valuation date. */
  monthsAgo: number;
  sqft?: number;
  beds?: number;
  baths?: number;
  yearBuilt?: number;
  /**
   * What this sale implies for the subject, after adjusting for the
   * differences between the two properties.
   */
  adjustedPrice: number;
  /**
   * Plain-English reasons the adjusted price differs from the sale price,
   * largest first. Empty when the two properties were close enough that no
   * adjustment mattered.
   */
  adjustments: { label: string; amount: number }[];
}

/**
 * Adjustment keys are internal. These are what a homeowner reads, phrased from
 * the comp's point of view: a positive adjustment means the comp was inferior
 * and its price is revised up toward the subject.
 */
export const LABELS: Record<string, string> = {
  time: "Market movement since it sold",
  assessed: "Difference in assessed value",
  gla: "Difference in living area",
  lot: "Difference in lot size",
  age: "Difference in age",
  condition: "Difference in condition",
  beds: "Difference in bedrooms",
  baths: "Difference in bathrooms",
};

/**
 * Adjustments below this are noise to a homeowner — showing "Difference in lot
 * size: $312" invites scrutiny of a rounding error rather than of the estimate.
 */
const MATERIAL_ADJUSTMENT = 5_000;

/**
 * Shown when a source publishes no street address for a sale and none could be
 * resolved. Honest, and the rest of the row — distance, date, price, size —
 * still carries the comparison. Fairfax is the case: its sales layer carries
 * only a parcel identifier, and "0311 17 0027" reads as a database leak.
 */
const UNNAMED_COMP = "Nearby home";

/**
 * @param addresses Optional id → street address, from a provider's
 * `resolveAddresses`. Used where the sales feed itself carries none.
 */
export function toPublicComps(
  scored: ScoredComp[],
  addresses?: Map<string, string>
): PublicComp[] {
  return scored.map(s => ({
    address: publicAddress(s.comp.address, addresses?.get(s.comp.id)),
    soldPrice: Math.round(s.comp.soldPrice),
    soldDate: s.comp.soldDate,
    distanceMiles: Number(s.distanceMiles.toFixed(2)),
    monthsAgo: s.ageMonths,
    sqft: s.comp.sqft,
    beds: s.comp.beds,
    baths: s.comp.baths,
    yearBuilt: s.comp.yearBuilt,
    adjustedPrice: Math.round(s.adjustedPrice),
    adjustments: Object.entries(s.adjustments)
      .filter(([, amount]) => Math.abs(amount) >= MATERIAL_ADJUSTMENT)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([key, amount]) => ({
        label: LABELS[key] ?? key,
        amount: Math.round(amount),
      })),
  }));
}

function publicAddress(raw: string, resolved?: string): string {
  const best = (resolved ?? raw ?? "").trim();
  return best ? titleCase(best) : UNNAMED_COMP;
}

/**
 * County records shout: "8805 WANDERING TRAIL DR". Presented to a homeowner
 * alongside their own address that reads as a database dump.
 *
 * Directionals and unit designators stay upper case, since "8805 Wandering
 * Trail Dr Ne" is worse than the problem being fixed.
 */
const KEEP_UPPER = new Set(["NE", "NW", "SE", "SW", "N", "S", "E", "W", "US", "DC"]);

export function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .map(word => {
      const bare = word.replace(/[^A-Za-z]/g, "");
      if (KEEP_UPPER.has(bare.toUpperCase())) return word.toUpperCase();
      // Leave anything with digits alone: "8805", "3RD", "1-A".
      if (/\d/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
