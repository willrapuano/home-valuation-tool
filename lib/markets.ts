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
  /** Extra WHERE terms — jurisdiction scope, arm's-length filters. */
  filters: string[];
  /**
   * Whether `filters` actually excludes non-arm's-length transfers.
   *
   * Fairfax publishes SALEVAL_DESC and Maryland's feed is already filtered to
   * considerations; DC's parcel layer carries no qualification flag at all —
   * the flag lives on a separate CAMA layer the count cannot join to. So the DC
   * copy must NOT claim "arm's-length", and this is what drives that wording.
   */
  armsLength: boolean;
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
    filters: [`JURSCODE = '${jurscode}'`],
    armsLength: false,
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
    filters: [
      // Public record includes family transfers and nominal $1 conveyances,
      // which are not evidence of market value. Filtering in SQL keeps this to
      // a count query rather than a several-thousand-row pull.
      "SALEVAL_DESC LIKE '%Valid%'",
      "SALEVAL_DESC NOT LIKE '%Multi-Parcel%'",
      "(NOPAR IS NULL OR NOPAR <= 1)",
    ],
    armsLength: true,
  },

  dc: {
    label: "Washington, DC",
    layer:
      "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer/40/query",
    priceField: "SALEPRICE",
    dateField: "SALEDATE",
    dateLiteral: esriDate,
    minPrice: 50_000,
    filters: [],
    armsLength: false,
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
