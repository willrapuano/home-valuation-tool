/**
 * Check every market's hero figures against something a human recognises.
 *
 *   npx tsx scripts/market-benchmark.ts
 *
 * WHY
 *
 * The landing page prints a county's median sale price to a homeowner, and the
 * agent selling that page knows their county's median by heart. A wrong hero
 * number costs more than no panel at all — it is the one figure on the page an
 * agent will notice immediately and lose confidence over.
 *
 * The failure is not hypothetical. Before residential filtering, DC's window of
 * 1,459 "sales" carried a median of $920,000; the same window restricted to
 * single-family dwellings held 1,115 sales with a median of $870,000. The
 * $50,000 gap was hotels, offices, warehouses, parking lots, religious
 * buildings, garages and vacant land.
 *
 * WHAT THIS PRINTS, AND WHAT IT DOES NOT
 *
 * It prints the quartiles and the counts, filtered and unfiltered, so the shape
 * of the distribution is visible rather than just its midpoint. It does NOT
 * assert a published benchmark: no free API serves Bright MLS medians, and a
 * hardcoded "expected" figure would rot within a quarter and then fail loudly
 * for the wrong reason.
 *
 * So this is an instrument, not an assertion. Run it, put each median next to
 * the county's or Bright's published figure for the same window, and if they
 * disagree by more than a few percent the filters in lib/markets.ts are wrong —
 * not the market.
 */

import { MARKETS, MarketDefinition, scopeLabel } from "../lib/markets";

const WINDOW_DAYS = 90;
const TIMEOUT_MS = 60_000;

async function post(m: MarketDefinition, params: Record<string, string>): Promise<any> {
  const res = await fetch(m.layer, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, f: "json" }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(json.error.message ?? "ArcGIS error");
  return json;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function newest(m: MarketDefinition, where: string): Promise<string> {
  const json = await post(m, {
    where,
    outFields: m.dateField,
    orderByFields: `${m.dateField} DESC`,
    resultRecordCount: "1",
    returnGeometry: "false",
  });
  const raw = json?.features?.[0]?.attributes?.[m.dateField];
  if (typeof raw === "number") return isoDate(new Date(raw));
  if (typeof raw === "string" && /^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  throw new Error("unreadable date");
}

async function count(m: MarketDefinition, where: string): Promise<number> {
  const json = await post(m, { where, returnCountOnly: "true" });
  return json.count;
}

/**
 * Value at a given rank, by ordering and skipping — the same trick market-pulse
 * uses. Returns null on timeout rather than throwing: on Maryland the
 * UNFILTERED median measured 72s, and losing the whole market's report to one
 * slow diagnostic query defeats the point of the diagnostic.
 */
async function quantile(m: MarketDefinition, where: string, n: number, q: number): Promise<number | null> {
  if (n < 4) return null;
  try {
    return await quantileOnce(m, where, n, q);
  } catch {
    return null;
  }
}

async function quantileOnce(m: MarketDefinition, where: string, n: number, q: number): Promise<number | null> {
  const json = await post(m, {
    where,
    outFields: m.priceField,
    orderByFields: `${m.priceField} ASC`,
    resultOffset: String(Math.floor(n * q)),
    resultRecordCount: "1",
    returnGeometry: "false",
  });
  const v = json?.features?.[0]?.attributes?.[m.priceField];
  return typeof v === "number" ? v : null;
}

function money(n: number | null): string {
  return n === null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}

async function main() {
  console.log(`Hero figures for every market in lib/markets.ts, ${WINDOW_DAYS}-day window.\n`);
  console.log(
    "Put each median beside the county's or Bright's published figure for the\n" +
      "same window. A gap of more than a few percent means the FILTERS are wrong.\n"
  );

  for (const [key, m] of Object.entries(MARKETS)) {
    const dateTerms = (from: Date, to: Date) =>
      `${m.dateField} > ${m.dateLiteral(from)} AND ${m.dateField} <= ${m.dateLiteral(to)}`;

    try {
      const base = [`${m.priceField} > ${m.minPrice}`, ...m.filters].join(" AND ");
      const through = new Date(`${await newest(m, base)}T00:00:00Z`);
      const from = new Date(through);
      from.setDate(from.getDate() - WINDOW_DAYS);

      const filtered = `${base} AND ${dateTerms(from, through)}`;
      // Price and date only — what the figures would be with no type or
      // validity filtering at all. The difference IS the value of the filters.
      const bare = `${m.priceField} > ${m.minPrice} AND ${dateTerms(from, through)}`;

      const [nFiltered, nBare] = await Promise.all([count(m, filtered), count(m, bare)]);

      // SERIALISED, not Promise.all. Each quantile is a deep-pagination query,
      // and Maryland's iMAP service takes 6–15s for one; firing four at once
      // queues them behind each other and every one blows the timeout. This is
      // a diagnostic run by hand, so wall-clock does not matter.
      const p25 = await quantile(m, filtered, nFiltered, 0.25);
      const p50 = await quantile(m, filtered, nFiltered, 0.5);
      const p75 = await quantile(m, filtered, nFiltered, 0.75);
      const bareMedian = await quantile(m, bare, nBare, 0.5);

      console.log(`${m.label}  (${key})`);
      console.log(`  window       ${isoDate(from)} → ${isoDate(through)}`);
      console.log(`  label shown  "${scopeLabel(m)}"`);
      console.log(
        `  filtered     n=${nFiltered.toLocaleString()}  ` +
          `p25 ${money(p25)}  MEDIAN ${money(p50)}  p75 ${money(p75)}`
      );
      console.log(
        `  unfiltered   n=${nBare.toLocaleString()}  median ${money(bareMedian)}` +
          (p50 !== null && bareMedian !== null && p50 !== bareMedian
            ? `   ← filters move the median by ${money(Math.abs(bareMedian - p50))}`
            : "")
      );
      console.log();
    } catch (err) {
      console.log(`${m.label}  (${key})`);
      console.log(`  UNAVAILABLE: ${(err as Error)?.message ?? err}\n`);
    }
  }

  console.log(
    "Fairfax cannot filter by property type — its sales layer carries no land-use\n" +
      "field — so its figures legitimately include commercial parcels and its label\n" +
      'says "property sales" rather than "home sales".'
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
