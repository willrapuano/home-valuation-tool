/**
 * How the estimate is displayed, and how accurate it actually is.
 *
 * WHY THESE TWO THINGS LIVE TOGETHER
 *
 * The results screen used to print `$1,951,882`. Seven significant digits
 * asserts precision to the dollar on a number whose measured median error is
 * 6.1% — about ±$119,000 on that figure. Nobody credible does this: Zillow
 * rounds, Redfin shows `$1.95M`. The false precision is worse than cosmetic,
 * because it contradicts the accuracy claim made three sections further down
 * the same page.
 *
 * So rounding and the measured error band are defined in the same module: the
 * figure is rounded to three significant figures, and the band that justifies
 * that rounding is printed underneath it. The honest-error-band position stops
 * being a README paragraph and becomes the product.
 */

/** Measured on 124 held-out sales across eight markets. See scripts/production-path-backtest.ts. */
export const ACCURACY = {
  /** Median absolute percent error, all markets pooled. */
  medianErrorPct: 6.1,
  /** Share of lookups that produce a publishable figure at all. */
  publishRatePct: 78,
  /** Held-out sales in the measurement. */
  sampleSize: 124,
  /** Markets covered by the measurement. */
  marketCount: 8,
} as const;

/**
 * Per-jurisdiction median absolute error, keyed by the provider slug that
 * `/api/avm` reports as `sourceJurisdiction`.
 *
 * DC does best because the District publishes an arm's-length flag AND building
 * characteristics; Fairfax does worst because it publishes neither square
 * footage nor beds, so the assessment has to stand in for all of it.
 */
export const JURISDICTION_ERROR_PCT: Record<string, number> = {
  dc: 4.7,
  maryland: 6.6,
  fairfax: 7.5,
};

/** Display name for a provider slug. */
export const JURISDICTION_NAMES: Record<string, string> = {
  dc: "Washington, DC",
  fairfax: "Fairfax County, VA",
  maryland: "Maryland",
  postgres: "Ingested public records",
  titleflex: "TitleFlex",
  titlepro247: "TitlePro247",
};

export function jurisdictionLabel(key?: string | null): string {
  if (!key) return "public records";
  return JURISDICTION_NAMES[key.toLowerCase()] ?? key;
}

/** The measured error for a jurisdiction, falling back to the pooled figure. */
export function errorPctFor(jurisdiction?: string | null): number {
  if (!jurisdiction) return ACCURACY.medianErrorPct;
  return JURISDICTION_ERROR_PCT[jurisdiction.toLowerCase()] ?? ACCURACY.medianErrorPct;
}

/** Round to `sig` significant figures. 1_951_882 → 1_950_000 at sig = 3. */
export function roundToSigFigs(n: number, sig = 3): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)) - (sig - 1));
  return Math.round(n / magnitude) * magnitude;
}

/**
 * The headline figure: three significant figures, in the form a person would
 * say it out loud.
 *
 *   1_951_882 → "$1.95M"
 *   12_400_000 → "$12.4M"
 *     845_231 → "$845,000"
 *     312_456 → "$312,000"
 */
export function formatEstimate(n: number): string {
  const rounded = roundToSigFigs(n, 3);
  if (rounded >= 1_000_000) {
    const millions = rounded / 1_000_000;
    const text = millions.toFixed(millions >= 100 ? 0 : millions >= 10 ? 1 : 2);
    // Strip trailing zeros AFTER the decimal point only. A naive /0+$/ turns
    // "120" (i.e. $120M) into "12".
    return `$${text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}M`;
  }
  return `$${rounded.toLocaleString("en-US")}`;
}

/**
 * The plus-or-minus that goes under the headline, in dollars.
 *
 * Two significant figures, because a precise-looking error bar on an error bar
 * is the same mistake one level up.
 */
export function formatErrorBand(estimate: number, jurisdiction?: string | null): string {
  const dollars = roundToSigFigs((estimate * errorPctFor(jurisdiction)) / 100, 2);
  return `$${dollars.toLocaleString("en-US")}`;
}

/**
 * The full sentence under the headline figure.
 *
 * Assembled here rather than in the components so the two surfaces that show it
 * — the results screen and the shareable report — cannot drift apart, and so
 * the unmeasured case reads properly. Naming the jurisdiction only when it has
 * its own measured figure avoids "half of public records estimates land
 * within…", which is what interpolating the fallback label produced.
 */
export function accuracyLine(estimate: number, jurisdiction?: string | null): string {
  const measured = jurisdiction ? JURISDICTION_ERROR_PCT[jurisdiction.toLowerCase()] : undefined;
  const where = measured === undefined ? "" : ` in ${jurisdictionLabel(jurisdiction)}`;
  return (
    `give or take ${formatErrorBand(estimate, jurisdiction)} — ` +
    `half of estimates${where} land within ${errorPctFor(jurisdiction)}% of the sale price`
  );
}
