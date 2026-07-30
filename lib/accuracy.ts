/**
 * How the estimate is displayed, and how accurate it actually is.
 *
 * WHY THESE TWO THINGS LIVE TOGETHER
 *
 * The results screen used to print `$1,951,882`. Seven significant digits
 * asserts precision to the dollar on a number whose measured median error is
 * several percent. Nobody credible does this: Zillow rounds, Redfin shows
 * `$1.95M`. The false precision is worse than cosmetic, because it contradicts
 * the accuracy claim made three sections further down the same page.
 *
 * So rounding and the measured error band are defined in the same module: the
 * figure is rounded to three significant figures, and the band that justifies
 * that rounding is printed underneath it.
 *
 * ── THE RULE THAT GOVERNS THIS FILE ──────────────────────────────────────
 *
 * NO PERCENTAGE IS DISPLAYED FOR A JURISDICTION UNLESS IT WAS MEASURED ON THE
 * PRODUCTION PATH, UNDER THE CONDITIONS PRODUCTION ACTUALLY FACES.
 *
 * Both halves matter, and Maryland caught the second one out.
 *
 * `scripts/production-path-backtest.ts` values each holdout from a lat/lng, the
 * way a visitor arrives, and at its default settings reported 6.6% for
 * Maryland. But every backtest here draws its subjects from the SAME lagged
 * pool as its comps, so subject and comps sit behind Maryland's publishing lag
 * together and the forward extrapolation cancels out. Production does not get
 * that: the newest Maryland sale available is about a quarter old, so a
 * homeowner asking today is valued from comps that are all stale.
 *
 * `scripts/lag-cost.ts` measured the difference on the ENGINE path by cutting
 * comps off 90 days early — 5.7% becomes 9.5%, and coverage drops 20 points.
 * That script was audited for the obvious way to get this wrong: it refits
 * `annualAppreciation` on the cut-off candidate set at every iteration rather
 * than reusing a full-data fit, so the rate does not peek at the future.
 *
 * But the engine path hands the subject its own record. Production resolves it
 * from a lat/lng, and for Maryland that gap is worth another +1.7pp. So the
 * measurement that governs the display is the PRODUCTION path run under the
 * lag — `production-path-backtest.ts 25 90`:
 *
 *     jurisdiction   paired   record subj   live subj   published   MdAPE shown
 *     dc                 37          5.1%        4.5%         90%          4.5%
 *     maryland           44          8.6%       10.3%         67%         11.7%
 *
 * MARYLAND IS 11.7%, not 6.6% and not 9.5%. That is the number displayed, and
 * it is displayed BECAUSE it is honest: a wide measured band beats a blank, and
 * it is the figure a Bethesda homeowner actually receives.
 *
 * DC at the same 90-day cutoff shows 4.5% against 4.7% unlagged — statistically
 * flat, which is the expected control result for a jurisdiction that publishes
 * within about ten days. DC's and Fairfax's figures stand as measured.
 *
 * WHEN A FIGURE IS STILL WITHHELD, the UI shows the data's recency instead —
 * see `recencyLine`. That path remains live for any jurisdiction added without
 * a measurement.
 */

/** Pooled figure across every measured market. See production-path-backtest.ts. */
export const ACCURACY = {
  medianErrorPct: 6.1,
  publishRatePct: 78,
  sampleSize: 124,
  marketCount: 8,
} as const;

export interface AccuracyFigure {
  /** Median absolute percent error against recorded sale prices. */
  pct: number;
  /**
   * Whether the measurement reflects what production faces.
   *
   * False means the number exists but describes conditions a visitor does not
   * get — it may be used internally and must NOT be displayed. There is no
   * third state on purpose: a figure is either safe to print or it is not.
   */
  displayable: boolean;
  /** Why, in one line, for whoever changes this next. */
  basis: string;
  /**
   * Appended to the displayed sentence where the figure was measured under a
   * condition a reader should know about.
   *
   * Maryland's 11.7% is not the engine being worse at Maryland houses; it is
   * the engine working from records a quarter old. Saying so turns a
   * discouraging number into an explained one, and it is the same fact the
   * recency line states underneath.
   */
  qualifier?: string;
}

/**
 * Keyed by the provider slug `/api/avm` reports as `sourceJurisdiction` — NOT
 * by market key. Every Maryland county (Montgomery, Prince George's, Howard,
 * Frederick, Anne Arundel) is served by the one Maryland provider and reports
 * `maryland`, so adding counties to `lib/markets.ts` does not silently mint
 * per-county accuracy claims that were never measured.
 */
export const JURISDICTION_ACCURACY: Record<string, AccuracyFigure> = {
  dc: {
    pct: 4.7,
    displayable: true,
    basis: "production-path backtest; DC publishes within ~10 days so backtest conditions match production",
  },
  fairfax: {
    pct: 7.5,
    displayable: true,
    basis: "production-path backtest; Fairfax publishes within ~10 days and rests on assessed value, which does not go stale",
  },
  maryland: {
    pct: 11.7,
    displayable: true,
    basis:
      "production-path backtest run with a 90-day comp cutoff (`production-path-backtest.ts 25 90`), which is the publishing lag Maryland actually has. n=44 paired across Rockville, Bethesda, Frederick and Columbia; 67% published",
    qualifier: "measured under Maryland's ~3-month reporting lag",
  },
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

/** The displayable figure for a jurisdiction, or null when there is none. */
export function displayableAccuracy(jurisdiction?: string | null): AccuracyFigure | null {
  if (!jurisdiction) return null;
  const figure = JURISDICTION_ACCURACY[jurisdiction.toLowerCase()];
  return figure?.displayable ? figure : null;
}

/**
 * The measured error for a jurisdiction, for INTERNAL use — scripts, logging,
 * anything that is not shown to a homeowner. Falls back to the pooled figure.
 *
 * Do not render this. Use `accuracyLine`, which refuses to print an
 * undisplayable figure.
 */
export function errorPctFor(jurisdiction?: string | null): number {
  if (!jurisdiction) return ACCURACY.medianErrorPct;
  return JURISDICTION_ACCURACY[jurisdiction.toLowerCase()]?.pct ?? ACCURACY.medianErrorPct;
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
 * The plus-or-minus that goes under the headline, in dollars. Two significant
 * figures, because a precise-looking error bar on an error bar is the same
 * mistake one level up.
 */
export function formatErrorBand(estimate: number, jurisdiction?: string | null): string {
  const dollars = roundToSigFigs((estimate * errorPctFor(jurisdiction)) / 100, 2);
  return `$${dollars.toLocaleString("en-US")}`;
}

/**
 * The sentence under the headline — or null when this jurisdiction has no
 * displayable measurement.
 *
 * Returning null rather than a hedged sentence is deliberate: the caller then
 * shows the data-recency line instead, which is a fact rather than an estimate
 * of an estimate.
 */
export function accuracyLine(estimate: number, jurisdiction?: string | null): string | null {
  const figure = displayableAccuracy(jurisdiction);
  if (!figure) return null;
  const band = roundToSigFigs((estimate * figure.pct) / 100, 2);
  const qualifier = figure.qualifier ? `, ${figure.qualifier}` : "";
  return (
    `give or take $${band.toLocaleString("en-US")} — half of estimates in ` +
    `${jurisdictionLabel(jurisdiction)} land within ${figure.pct}% of the sale price` +
    qualifier
  );
}

/**
 * What to say when there is no displayable accuracy figure: how current the
 * evidence is.
 *
 * `newestSaleDate` is the most recent sale among the comps actually shown, so
 * this is derived from the estimate itself rather than from a constant that
 * would rot. Maryland's feed runs about a quarter behind, and a homeowner
 * reading a July estimate built from April sales is entitled to know that
 * before they price a house on it.
 */
export function recencyLine(newestSaleDate?: string | null): string | null {
  if (!newestSaleDate) return null;
  const d = new Date(`${newestSaleDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const formatted = d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const monthsBehind = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.4));
  const lag =
    monthsBehind >= 2
      ? ` — this jurisdiction publishes sales about ${monthsBehind} months behind, so the market has moved since`
      : "";
  return `Based on sales recorded through ${formatted}${lag}.`;
}

/** The newest sale date among a set of comps, as ISO YYYY-MM-DD. */
export function newestCompDate(comps: { soldDate: string }[] | undefined): string | null {
  if (!comps?.length) return null;
  const dates = comps.map(c => c.soldDate).filter(Boolean).sort();
  return dates[dates.length - 1] ?? null;
}
