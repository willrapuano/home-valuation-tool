/**
 * Live market figures for the landing page.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The landing page previously proved it was real with three emoji badges —
 * "🏠 Public Property Data", "🔒 100% Private", "⚡ 30-Second Results". Those
 * are claims anyone can type. Every home-valuation tool a homeowner has already
 * used (Redfin, Zillow, Homebot, Opendoor) leads instead with a number that is
 * specific enough that it could only have come from somewhere: sale counts,
 * median prices, a date.
 *
 * So the trust strip is wired to the same county service the valuation engine
 * queries. It is current, it moves week to week, and a template cannot fake it.
 *
 * WHAT IT MUST NEVER DO IS BLOCK THE PAGE. This runs at build/revalidate time
 * behind `unstable_cache`, has a hard timeout, and returns null on any failure.
 * A landing page that 500s because a county ArcGIS service is having a bad
 * morning would be a strictly worse trade than one missing three statistics.
 */

const SALES_LAYER =
  "https://www.fairfaxcounty.gov/mercator/rest/services/GIS/ParcelPlusSales/MapServer/0/query";

/** Short: nothing here is worth a slow page. */
const TIMEOUT_MS = 6_000;

/** Window for the headline figures. A quarter is long enough to be stable. */
const WINDOW_DAYS = 90;

/**
 * Same knockouts the Fairfax provider applies, and for the same reason: public
 * record includes family transfers and nominal $1 conveyances, which are not
 * evidence of market value. A median that includes them is not the median a
 * homeowner would recognise.
 */
const MIN_PRICE = 50_000;

export interface MarketPulse {
  /** Arm's-length sales recorded in the window. */
  sales: number;
  /** True median sale price of those, in dollars. */
  medianPrice: number;
  /** Sales on file across the engine's full 12-month lookback. */
  salesOnFile: number;
  /** Window length, so the copy can name it rather than hard-code "90 days". */
  windowDays: number;
  /** ISO date the figures were computed, shown as "as of". */
  asOf: string;
}

function where(sinceIso: string): string {
  return [
    `PRICE > ${MIN_PRICE}`,
    `SALEDT > DATE '${sinceIso}'`,
    // Fairfax spells the arm's-length flag in SALEVAL_DESC. Filtering in SQL
    // rather than in JS keeps this to a count query instead of a 3,000-row pull.
    "SALEVAL_DESC LIKE '%Valid%'",
    "SALEVAL_DESC NOT LIKE '%Multi-Parcel%'",
    "(NOPAR IS NULL OR NOPAR <= 1)",
  ].join(" AND ");
}

async function post(params: Record<string, string>): Promise<any> {
  const res = await fetch(SALES_LAYER, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, f: "json" }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Fairfax sales layer returned ${res.status}`);
  const json = await res.json();
  // ArcGIS reports failures inside a 200 body, so the status check above is not
  // on its own enough to know the query ran.
  if (json?.error) throw new Error(json.error.message ?? "ArcGIS error");
  return json;
}

async function count(sinceIso: string): Promise<number> {
  const json = await post({ where: where(sinceIso), returnCountOnly: "true" });
  if (typeof json?.count !== "number") throw new Error("no count in response");
  return json.count;
}

/**
 * The exact median, not an average.
 *
 * ArcGIS `outStatistics` offers avg but not median, and a mean sale price in a
 * market containing Great Falls estates is meaningfully higher than what a
 * typical seller would recognise as "the going rate". Pagination gets the real
 * middle value in one extra request: order by price, skip to the midpoint, take
 * one row.
 */
async function medianPrice(sinceIso: string, n: number): Promise<number> {
  if (n < 1) throw new Error("no sales to take a median of");
  const json = await post({
    where: where(sinceIso),
    outFields: "PRICE",
    orderByFields: "PRICE ASC",
    resultOffset: String(Math.floor(n / 2)),
    resultRecordCount: "1",
    returnGeometry: "false",
  });
  const price = json?.features?.[0]?.attributes?.PRICE;
  if (typeof price !== "number" || price <= 0) throw new Error("no price at the midpoint");
  return price;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns null rather than throwing. Callers render the strip only when this is
 * non-null, so a county outage degrades the page to a shorter one instead of an
 * error — and, importantly, never to invented figures.
 */
export async function fetchMarketPulse(): Promise<MarketPulse | null> {
  try {
    const since = isoDaysAgo(WINDOW_DAYS);
    const yearAgo = isoDaysAgo(365);

    const [sales, salesOnFile] = await Promise.all([count(since), count(yearAgo)]);
    const median = await medianPrice(since, sales);

    return {
      sales,
      medianPrice: median,
      salesOnFile,
      windowDays: WINDOW_DAYS,
      asOf: new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.warn("market pulse unavailable:", (err as Error)?.message ?? err);
    return null;
  }
}
