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
 * the county's or Bright's published figure, and if they disagree by more than
 * a few percent the filters in lib/markets.ts are wrong — not the market.
 *
 * ── MATCH THE WINDOW, OR THE COMPARISON IS MEANINGLESS ───────────────────
 *
 * The window printed below ENDS AT THE NEWEST RECORDED SALE, not at today. For
 * Maryland that is about a quarter ago: Montgomery's $654,300 is a
 * January–April window, so it must be compared against SPRING closed medians,
 * not against whatever Bright published this month. Comparing a spring figure
 * to a summer one will look like a filter bug and is not.
 *
 * Two further reasons close beats exact, and exact would be suspicious:
 *
 *   - RECORDED vs SETTLED. These are deed recordation dates; Bright reports
 *     settlement. The two differ by days to weeks and the sets are not
 *     identical at the window edges.
 *   - UNIVERSE. Bright sees MLS-listed sales. Public record sees everything
 *     recorded, including for-sale-by-owner, new construction sold direct,
 *     estate sales and auctions — which skew differently from listed stock.
 *
 * A few points of drift is a pass. A DC-sized $50,000 gap is a filter bug.
 */

import { allFilters, MARKETS, MarketDefinition, scopeLabel } from "../lib/markets";

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

/* ── Fairfax: the join a pageview cannot do, done offline ──────────────── */

const FX_ASSESSED =
  "https://www.fairfaxcounty.gov/mercator/rest/services/GIS/ParcelPlusAssessedValues/MapServer/0/query";
/**
 * Fairfax land use codes that are dwellings — the same set
 * `providers/fairfax.ts` maps to a property type. Everything else is
 * commercial, industrial, institutional or vacant.
 */
const FX_RESIDENTIAL = ["011", "012", "013", "021", "022", "031", "041"];
/** PINs per `IN (...)` clause. Larger risks a URL/statement length limit. */
const FX_CHUNK = 150;

/**
 * WHY THIS EXISTS
 *
 * DC's hero median moved $50,000 once non-residential parcels came out. Fairfax
 * still prints a median with commercial sales inside it, because its sales
 * layer carries no land-use field — that lives on ParcelPlusAssessedValues, and
 * a single count query cannot join the two. The panel is honestly relabelled
 * "property sales", but relabelling is not measuring: nobody knows whether
 * Fairfax owes the same $50,000 correction DC did.
 *
 * A pageview cannot afford this join. An offline diagnostic can: pull the
 * window's sales with their PINs, then look up land use for those PINs in
 * chunks. Roughly 30 extra requests against a service that answers in about a
 * second.
 *
 * If the delta is DC-sized, relabelling was the smaller half of the fix and
 * Fairfax needs an ingested land-use table rather than a live query.
 */
async function fairfaxResidentialMedian(
  m: MarketDefinition,
  where: string
): Promise<{ n: number; median: number | null; nonResidentialShare: number } | null> {
  const sales: { pin: string; price: number }[] = [];
  for (let offset = 0; offset < 10_000; offset += 2000) {
    const json = await post(m, {
      where,
      outFields: "PIN,PRICE",
      orderByFields: "PIN ASC",
      resultOffset: String(offset),
      resultRecordCount: "2000",
      returnGeometry: "false",
    });
    const rows = json?.features ?? [];
    for (const f of rows) {
      const pin = String(f.attributes?.PIN ?? "").trim();
      const price = f.attributes?.PRICE;
      if (pin && typeof price === "number" && price > 0) sales.push({ pin, price });
    }
    if (rows.length < 2000) break;
  }
  if (!sales.length) return null;

  const pins = [...new Set(sales.map(s => s.pin))];
  const residential = new Set<string>();
  for (let i = 0; i < pins.length; i += FX_CHUNK) {
    const chunk = pins.slice(i, i + FX_CHUNK);
    const res = await fetch(FX_ASSESSED, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        where:
          `PIN IN (${chunk.map(p => `'${p}'`).join(",")}) AND ` +
          `LUC IN (${FX_RESIDENTIAL.map(c => `'${c}'`).join(",")})`,
        outFields: "PIN",
        returnGeometry: "false",
        f: "json",
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then(r => r.json());
    if (res?.error) throw new Error(res.error.message ?? "assessed layer error");
    for (const f of res?.features ?? []) {
      const pin = String(f.attributes?.PIN ?? "").trim();
      if (pin) residential.add(pin);
    }
  }

  const kept = sales.filter(s => residential.has(s.pin)).map(s => s.price).sort((a, b) => a - b);
  if (!kept.length) return null;
  const mid = Math.floor(kept.length / 2);
  return {
    n: kept.length,
    median: kept.length % 2 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2,
    nonResidentialShare: 1 - kept.length / sales.length,
  };
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
      const base = [`${m.priceField} > ${m.minPrice}`, ...allFilters(m)].join(" AND ");
      const through = new Date(`${await newest(m, base)}T00:00:00Z`);
      const from = new Date(through);
      from.setDate(from.getDate() - WINDOW_DAYS);

      const filtered = `${base} AND ${dateTerms(from, through)}`;
      // SCOPE IS KEPT, quality is dropped. Dropping every filter also drops
      // Maryland's JURSCODE, which compared Montgomery's 2,715 sales against
      // 21,059 statewide ones and reported the difference as the value of the
      // land-use filter. The baseline must be the same market, unfiltered.
      const bare = [
        `${m.priceField} > ${m.minPrice}`,
        ...m.scopeFilters,
        dateTerms(from, through),
      ].join(" AND ");

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
      // Fairfax owes the delta DC already paid. Measure it rather than assume.
      if (key === "fairfax") {
        try {
          const fx = await fairfaxResidentialMedian(m, filtered);
          if (fx) {
            console.log(
              `  residential  n=${fx.n.toLocaleString()}  MEDIAN ${money(fx.median)}` +
                `   ← ${(fx.nonResidentialShare * 100).toFixed(1)}% of sales are not dwellings` +
                (p50 !== null && fx.median !== null
                  ? `, worth ${money(Math.abs(fx.median - p50))}`
                  : "")
            );
            console.log(
              "               (offline PIN join against ParcelPlusAssessedValues — a" +
                "\n                pageview cannot do this, an ingest table could)"
            );
          }
        } catch (err) {
          console.log(`  residential  UNAVAILABLE: ${(err as Error)?.message ?? err}`);
        }
      }

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
