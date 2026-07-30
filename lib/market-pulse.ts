/**
 * Live market figures for the landing page.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The landing page previously proved it was real with three emoji badges —
 * "🏠 Public Property Data", "🔒 100% Private", "⚡ 30-Second Results". Those
 * are claims anyone can type. Every home-valuation tool a homeowner has already
 * used (Redfin, Zillow, Homebot, Opendoor) leads instead with a number specific
 * enough that it could only have come from somewhere: sale counts, median
 * prices, a date.
 *
 * So the trust strip is wired to the same county services the valuation engine
 * queries. It is current, it moves week to week, and a template cannot fake it.
 *
 * WHICH MARKET is per-tenant config, not a constant — see lib/markets.ts. This
 * is deployed per agent, and a Bethesda visitor reading Fairfax medians is
 * wrong copy that looks authoritative.
 *
 * THE WINDOW IS ANCHORED TO THE DATA, NOT TO TODAY. Measured 2026-07-30: the
 * Maryland state sales feed's newest transfer was 2026-04-30, three months
 * behind. A fixed "last 90 days" would have reported ZERO sales for every
 * Maryland tenant. Anchoring to the newest sale on file always produces a real
 * window, and `through` makes the lag visible instead of hiding it.
 *
 * IT MUST NEVER BLOCK THE PAGE. This runs at revalidate time behind ISR, has a
 * hard timeout, and returns null on any failure — the hero then renders a
 * coverage panel. A landing page that 500s because a county ArcGIS service is
 * having a bad morning is a strictly worse trade than one missing three
 * statistics.
 */

import { MarketDefinition, resolveMarket, scopeLabel } from "./markets";

/**
 * ONE BUDGET FOR THE WHOLE OPERATION, not per request.
 *
 * A per-request timeout bounds the wrong thing: this makes three sequential
 * legs (newest date → counts → median), so N × timeout is the real worst case.
 * A single signal created once and shared by every fetch caps the total.
 *
 * Sized from measurement, not guessed. Maryland's iMAP service answers a count
 * in ~2s and the paginated median in 6.3–14.5s — wildly variable, and a 6s
 * per-request timeout killed every Maryland tenant's hero. Fairfax and DC
 * answer in well under a second.
 *
 * Deep pagination is the RIGHT algorithm despite that: pulling the whole price
 * column and taking the middle locally measured 29.8s against the same service,
 * three times worse.
 *
 * Overrunning is survivable: this runs during background revalidation, so the
 * visitor is served the previous page either way and the next rebuild retries.
 */
const TOTAL_BUDGET_MS = 25_000;

/** Window for the headline figures. A quarter is long enough to be stable. */
const WINDOW_DAYS = 90;

export interface MarketPulse {
  /** Human name of the market these figures describe. */
  market: string;
  /** Sales recorded in the window. */
  sales: number;
  /**
   * True median sale price, in dollars — or null when the median query alone
   * timed out. The counts are cheap and reliable; the median is the expensive
   * one, so it is allowed to fail on its own rather than taking the panel with
   * it. Partial figures beat no figures.
   */
  medianPrice: number | null;
  /** Sales on file across the engine's full 12-month lookback. */
  salesOnFile: number;
  /** Window length in days. */
  windowDays: number;
  /**
   * ISO date of the newest sale on file — the window's end.
   *
   * NOT "today". Where a feed lags, this is the honest thing to print, and the
   * copy says "through" rather than "as of".
   */
  through: string;
  /**
   * What the count actually covers, e.g. "Arm's-length property sales recorded"
   * or "Home sales recorded".
   *
   * Derived from the filters that were applied rather than written per market,
   * so the panel cannot claim a filter it did not run. Only Fairfax can assert
   * arm's-length; only DC and Maryland can assert residential.
   */
  scope: string;
}

function where(m: MarketDefinition, from: Date, to: Date): string {
  return [
    `${m.priceField} > ${m.minPrice}`,
    `${m.dateField} > ${m.dateLiteral(from)}`,
    `${m.dateField} <= ${m.dateLiteral(to)}`,
    ...m.filters,
  ].join(" AND ");
}

async function post(
  m: MarketDefinition,
  params: Record<string, string>,
  signal: AbortSignal
): Promise<any> {
  const res = await fetch(m.layer, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, f: "json" }).toString(),
    signal,
  });
  if (!res.ok) throw new Error(`${m.label} sales layer returned ${res.status}`);
  const json = await res.json();
  // ArcGIS reports failures inside a 200 body, so the status check above is not
  // on its own enough to know the query ran.
  if (json?.error) throw new Error(json.error.message ?? "ArcGIS error");
  return json;
}

async function count(
  m: MarketDefinition,
  from: Date,
  to: Date,
  signal: AbortSignal
): Promise<number> {
  const json = await post(m, { where: where(m, from, to), returnCountOnly: "true" }, signal);
  if (typeof json?.count !== "number") throw new Error("no count in response");
  return json.count;
}

/**
 * The exact median, not an average.
 *
 * ArcGIS `outStatistics` offers avg but not median, and a mean sale price in a
 * market containing Great Falls estates is meaningfully higher than what a
 * typical seller would recognise as "the going rate". Pagination gets the real
 * middle value in one request: order by price, skip to the midpoint, take one
 * row.
 */
async function medianPrice(
  m: MarketDefinition,
  from: Date,
  to: Date,
  n: number,
  signal: AbortSignal
): Promise<number> {
  if (n < 1) throw new Error("no sales to take a median of");
  const json = await post(
    m,
    {
      where: where(m, from, to),
      outFields: m.priceField,
      orderByFields: `${m.priceField} ASC`,
      resultOffset: String(Math.floor(n / 2)),
      resultRecordCount: "1",
      returnGeometry: "false",
    },
    signal
  );
  const price = json?.features?.[0]?.attributes?.[m.priceField];
  if (typeof price !== "number" || price <= 0) throw new Error("no price at the midpoint");
  return price;
}

/**
 * Esri date fields come back as epoch milliseconds; Maryland stores TRADATE as
 * an eight-character 'YYYYMMDD' string. Both appear in the registry, so parse
 * by shape rather than by configuration.
 */
export function parseLayerDate(raw: unknown): Date | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "string" && /^\d{8}$/.test(raw)) {
    const d = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Newest sale on file — the anchor for every window below.
 *
 * `m.filters` MUST be applied here. Every Maryland county shares one statewide
 * layer, so without the JURSCODE term this asks "when did anything last sell in
 * Maryland" and anchors a Howard County window to a Montgomery County date. Any
 * county whose records lag the state's would then get a window ending after its
 * own data stops — reporting a low count, or none at all.
 */
async function newestSaleDate(m: MarketDefinition, signal: AbortSignal): Promise<Date> {
  const json = await post(
    m,
    {
      where: [`${m.priceField} > ${m.minPrice}`, ...m.filters].join(" AND "),
      outFields: m.dateField,
      orderByFields: `${m.dateField} DESC`,
      resultRecordCount: "1",
      returnGeometry: "false",
    },
    signal
  );
  const parsed = parseLayerDate(json?.features?.[0]?.attributes?.[m.dateField]);
  if (!parsed) throw new Error(`could not read the newest ${m.dateField}`);
  // A feed reporting sales from the future is a data error, not a scoop.
  const now = new Date();
  return parsed > now ? now : parsed;
}

function daysBefore(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() - days);
  return out;
}

/**
 * Returns null rather than throwing. Callers render the strip only when this is
 * non-null, so a county outage — or a market key we cannot serve — degrades the
 * page to a shorter one instead of an error, and never to invented figures.
 */
export async function fetchMarketPulse(marketKey?: string | null): Promise<MarketPulse | null> {
  const market = resolveMarket(marketKey);
  if (!market) return null;

  // Created once, shared by every request below, so the ceiling is on the whole
  // operation rather than on each leg of it.
  const signal = AbortSignal.timeout(TOTAL_BUDGET_MS);

  try {
    const through = await newestSaleDate(market, signal);
    const windowStart = daysBefore(through, WINDOW_DAYS);
    const yearStart = daysBefore(through, 365);

    const [sales, salesOnFile] = await Promise.all([
      count(market, windowStart, through, signal),
      count(market, yearStart, through, signal),
    ]);

    // Attempted, not required. Maryland's median leg alone has been measured at
    // 14.5s; letting that drop the whole hero to a coverage panel would be a
    // disproportionate response to one slow query.
    let median: number | null = null;
    try {
      median = await medianPrice(market, windowStart, through, sales, signal);
    } catch (err) {
      console.warn(
        `median unavailable for ${market.label}:`,
        (err as Error)?.message ?? err
      );
    }

    return {
      market: market.label,
      sales,
      medianPrice: median,
      salesOnFile,
      windowDays: WINDOW_DAYS,
      through: through.toISOString().slice(0, 10),
      scope: scopeLabel(market),
    };
  } catch (err) {
    console.warn(
      `market pulse unavailable for ${market.label}:`,
      (err as Error)?.message ?? err
    );
    return null;
  }
}
