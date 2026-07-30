/**
 * Which market's figures the landing page shows.
 *
 * WHY THIS EXISTS
 *
 * The hero statistics were hardcoded to Fairfax County. This tool is deployed
 * per agent, so a Bethesda agent's visitors were reading Fairfax medians —
 * wrong copy, and worse, wrong copy that looks authoritative because it carries
 * a date and a source. Market scope belongs in the same per-tenant config as
 * the agent's name and licence.
 *
 * A tenant sets NEXT_PUBLIC_AGENT_MARKET to one of the keys below. An unknown
 * or unset value resolves to null and the hero renders its coverage panel
 * instead — the page never guesses at a market.
 *
 * ADDING A MARKET means finding a public sales layer that supports
 * `returnCountOnly` and `resultOffset` (for the median), then verifying the
 * WHERE clause against it by hand. Every definition below was checked live.
 */

export interface MarketDefinition {
  /** Shown in the panel heading, e.g. "Fairfax County". */
  label: string;
  /** ArcGIS query endpoint for closed sales. */
  layer: string;
  /** Field holding the sale price. */
  priceField: string;
  /** Field holding the sale date. */
  dateField: string;
  /**
   * How this layer wants a date written in a WHERE clause. Fairfax and DC take
   * an Esri `DATE '...'` literal; Maryland stores TRADATE as an eight-character
   * STRING, so it takes a quoted 'YYYYMMDD' and an unquoted one is a syntax
   * error rather than a wrong answer.
   */
  dateLiteral: (d: Date) => string;
  /** Rows below this price are transfers, not sales. */
  minPrice: number;
  /**
   * WHERE terms that define WHICH market this is — e.g. Maryland's JURSCODE.
   * Always applied; without them a "Montgomery" query returns the whole state.
   *
   * Kept apart from `qualityFilters` because the two answer different
   * questions, and conflating them broke the benchmark: dropping "all filters"
   * to get a baseline also dropped the county, so Montgomery's 2,715 sales were
   * being compared against 21,059 statewide ones. Scope is identity; quality is
   * the thing under test.
   */
  scopeFilters: string[];
  /**
   * WHERE terms that exclude records we do not want counted — non-arm's-length
   * transfers, non-residential parcels. These are what
   * `scripts/market-benchmark.ts` measures the effect of.
   */
  qualityFilters: string[];
  /**
   * Whether `filters` actually excludes non-arm's-length transfers.
   *
   * Fairfax publishes SALEVAL_DESC; DC's parcel layer carries no qualification
   * flag at all — the flag lives on a separate CAMA layer the count cannot join
   * to — and Maryland's feed publishes consideration without a validity code.
   * So only Fairfax's copy may claim "arm's-length", and this is what drives
   * that wording.
   */
  armsLength: boolean;
  /**
   * Whether `filters` restricts to residential dwellings.
   *
   * NOT cosmetic. Measured on DC, 24 April – 23 July 2026: unfiltered, the
   * median of 1,459 "sales" was $920,000; restricted to single-family, the
   * median of 1,115 was $870,000. The $50,000 difference is hotels, offices,
   * warehouses, parking lots, religious buildings, garages and vacant land
   * sitting inside a number labelled "median sale price" — and an agent knows
   * their county's median by heart, so a wrong hero figure costs more than no
   * panel at all.
   *
   * Fairfax cannot do this: its sales layer carries no land-use field (that
   * lives on the assessed-values layer, which a count query cannot join to).
   *
   * MEASURED, not assumed. `scripts/market-benchmark.ts` does the PIN join
   * offline, which a pageview cannot afford. Fairfax, 25 April – 24 July 2026:
   * 4,077 sales with a median of $801,005; restricted to dwellings, 3,587 sales
   * with a median of $850,000. 12.0% of "sales" are not dwellings and they are
   * worth $48,995 — within a thousand dollars of the correction DC owed, in the
   * opposite direction (DC's contaminants were hotels and offices, dearer than
   * the housing stock; Fairfax's are vacant land and small commercial, cheaper).
   *
   * A median that is $49,000 light is a number an agent checks against what they
   * already know and loses confidence over. Relabelling it "property sales" is
   * true but does not help — nobody reads the label that carefully. So markets
   * that cannot filter show their COUNT and withhold their MEDIAN; see
   * `medianDisplayable`.
   */
  residentialOnly: boolean;
}

/**
 * What the panel may call the thing it counted. Derived from the filters that
 * were actually applied rather than written by hand per market, so a filter
 * that gets removed cannot leave a claim behind.
 */
/**
 * May this market's median be printed?
 *
 * Only where the query can restrict to dwellings. An unfiltered median is a
 * measured $49,000 out in Fairfax and $50,000 out in DC, and it is the one
 * figure on the page an agent verifies from memory.
 *
 * This is the same rule `lib/accuracy.ts` applies to error percentages: a
 * number is either measured under the conditions it claims, or it is withheld.
 * The count is unaffected — it is honestly filtered and is the stronger trust
 * signal anyway.
 *
 * FLIPPING THIS BACK requires an ingested PIN -> land-use table so the join can
 * happen offline once rather than per pageview. That is what DATABASE_URL
 * unlocks; `scripts/market-benchmark.ts` already proves the join works.
 */
export function medianDisplayable(m: MarketDefinition): boolean {
  return m.residentialOnly;
}

/** Every WHERE term for this market, scope and quality together. */
export function allFilters(m: MarketDefinition): string[] {
  return [...m.scopeFilters, ...m.qualityFilters];
}

export function scopeLabel(m: MarketDefinition): string {
  const kind = m.residentialOnly ? "home sales" : "property sales";
  return m.armsLength ? `Arm’s-length ${kind} recorded` : `${kind[0].toUpperCase()}${kind.slice(1)} recorded`;
}

const esriDate = (d: Date) => `DATE '${d.toISOString().slice(0, 10)}'`;
const mdDate = (d: Date) => `'${d.toISOString().slice(0, 10).replace(/-/g, "")}'`;

/** Every Maryland county is the same layer with a different JURSCODE. */
function marylandCounty(label: string, jurscode: string): MarketDefinition {
  return {
    label,
    layer:
      "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertySales/MapServer/0/query",
    priceField: "CONSIDR1",
    dateField: "TRADATE",
    dateLiteral: mdDate,
    minPrice: 50_000,
    scopeFilters: [`JURSCODE = '${jurscode}'`],
    qualityFilters: [
      // The same land-use codes the Maryland provider treats as dwellings.
      // Measured on Montgomery: 2,822 sales unfiltered, 2,715 residential.
      //
      // THIS FILTER IS ALSO A LARGE SPEEDUP, which is the opposite of the
      // parcel layer's behaviour (see the `LU IN` note in providers/maryland.ts,
      // where adding it cost 10.9s against 1.0s). On the SALES layer the median
      // query at offset 1,350 measured 72.1s unfiltered against 15.0s with
      // `LU IN` — roughly five times faster. Removing it to "simplify" would
      // both corrupt the median and put it back outside the request budget.
      "LU IN ('R','U','TH','M')",
    ],
    armsLength: false,
    residentialOnly: true,
  };
}

export const MARKETS: Record<string, MarketDefinition> = {
  fairfax: {
    label: "Fairfax County",
    layer:
      "https://www.fairfaxcounty.gov/mercator/rest/services/GIS/ParcelPlusSales/MapServer/0/query",
    priceField: "PRICE",
    dateField: "SALEDT",
    dateLiteral: esriDate,
    minPrice: 50_000,
    scopeFilters: [],
    qualityFilters: [
      // Public record includes family transfers and nominal $1 conveyances,
      // which are not evidence of market value. Filtering in SQL keeps this to
      // a count query rather than a several-thousand-row pull.
      "SALEVAL_DESC LIKE '%Valid%'",
      "SALEVAL_DESC NOT LIKE '%Multi-Parcel%'",
      "(NOPAR IS NULL OR NOPAR <= 1)",
    ],
    armsLength: true,
    // ParcelPlusSales carries no land-use field; it lives on
    // ParcelPlusAssessedValues, which a single count query cannot join to.
    residentialOnly: false,
  },

  dc: {
    label: "Washington, DC",
    layer:
      "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer/40/query",
    priceField: "SALEPRICE",
    dateField: "SALEDATE",
    dateLiteral: esriDate,
    minPrice: 50_000,
    scopeFilters: [],
    qualityFilters: [
      // Row, detached and semi-detached — the three forms `propertyTypeFromProptype`
      // in the DC provider maps to a house. Condominiums are deliberately out:
      // "median home price" and "median condo price" are different numbers and
      // an agent quotes them separately.
      "PROPTYPE LIKE 'Residential-Single Family%'",
    ],
    armsLength: false,
    residentialOnly: true,
  },

  montgomery: marylandCounty("Montgomery County", "MONT"),
  "prince-georges": marylandCounty("Prince George's County", "PRIN"),
  howard: marylandCounty("Howard County", "HOWA"),
  frederick: marylandCounty("Frederick County", "FRED"),
  "anne-arundel": marylandCounty("Anne Arundel County", "ANNE"),
};

/** Resolve a configured market key, or null when it names nothing we can serve. */
export function resolveMarket(key?: string | null): MarketDefinition | null {
  if (!key) return null;
  return MARKETS[key.trim().toLowerCase()] ?? null;
}
