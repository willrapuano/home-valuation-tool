/**
 * What will a TitlePro247 backfill cost against the monthly cap?
 *
 *   npx tsx scripts/titlepro-budget.ts [monthsOfHistory]
 *
 * WHY THIS EXISTS
 *
 * Farm list pulls are capped at 10,000 records per month. That is a hard
 * budget, and the failure mode is spending it on the wrong thing: a farm
 * search returns CURRENT OWNERS in a radius, so tiling a county naively pulls
 * every parcel in it — 132,557 for Loudoun — to find the few thousand that
 * actually changed hands. That is thirteen months of budget for one county's
 * worth of comps.
 *
 * The mechanism that makes this affordable is `maxOwnershipYears` in
 * TP247FarmSearchParams. Ownership tenure is time since the last sale, so
 * `maxOwnershipYears: 1` returns only properties that sold within the year —
 * which is exactly the comp set, and nothing else.
 *
 * ⚠️ THIS SCRIPT NEVER CONTACTS TITLEPRO247, AND MUST NOT.
 *
 * It reads PUBLIC county GIS parcel counts only — Arlington, Loudoun,
 * Alexandria, Fairfax. Every number below is arithmetic on those.
 *
 * FARM LIST ORDERS COST REAL MONEY, PER RECORD. A measured order: 142 items
 * for $172.50, i.e. about $1.21 each. Placing one is a purchase, not a query,
 * and nothing in this repository should ever place one. The credentials and
 * the cost ceiling live in velocity-connectors deliberately; keep them there.
 *
 * The point of this script is to make the size of that purchase visible
 * BEFORE anyone commits to it.
 */

// This file has no imports, so without an explicit export TypeScript treats it
// as a global script and its helpers collide with other scripts' — `count`
// already exists in md-value-fields.ts.
export {};

interface County {
  name: string;
  /** Total parcels, from the county's own public GIS. */
  parcelsUrl: string;
  method: "GET" | "POST";
}

/** Counties we want and cannot serve from public records. */
const TARGETS: County[] = [
  {
    name: "arlington",
    parcelsUrl:
      "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_REA_Property_Polygons/FeatureServer/0/query",
    method: "GET",
  },
  {
    name: "loudoun",
    parcelsUrl: "https://logis.loudoun.gov/gis/rest/services/COL/LandRecords/MapServer/5/query",
    method: "GET",
  },
  {
    // Alexandria publishes assessed value (TOT_CYR/LAND_CYR/IMP_CYR), address
    // and lot size — more than Arlington or Loudoun give — but NO sale price
    // or sale date anywhere in its services. Assessments without sales cannot
    // produce comps, so it needs TitlePro247 like the others.
    name: "alexandria",
    parcelsUrl: "https://maps.alexandriava.gov/arcgis/rest/services/alxLandWm/MapServer/1/query",
    method: "GET",
  },
];

/**
 * NOT COUNTED HERE, and it matters for the total.
 *
 * Prince William County is the largest uncovered Northern Virginia
 * jurisdiction and its GIS was not reachable to measure — gis.pwcgov.org and
 * maps.pwcgov.org both refused connections, gisweb.pwcgov.org served HTML.
 * At roughly 150,000 parcels it would add about 11,000 sales a year, which is
 * more than a month's cap on its own.
 *
 * Count it before ordering. Do not treat the total below as complete.
 */
const UNMEASURED = ["prince william (~150,000 parcels, unreachable to confirm)"];

/**
 * Fairfax is the calibration county: we hold its complete sales history AND
 * its parcel count, so its turnover rate is measured rather than assumed.
 * Neighbouring Northern Virginia counties are close enough in market
 * behaviour for a budget estimate — this is for sizing an order, not for
 * publishing a number.
 */
const FAIRFAX_SALES =
  "https://www.fairfaxcounty.gov/mercator/rest/services/GIS/ParcelPlusSales/MapServer/0/query";
const FAIRFAX_PARCELS =
  "https://www.fairfaxcounty.gov/mercator/rest/services/GIS/ParcelPlusAssessedValues/MapServer/0/query";

/** The licensed ceiling on records per month. */
const MONTHLY_CAP = 10_000;
/**
 * Measured unit cost: an order of 142 items billed $172.50.
 *
 * THIS IS THE CONSTRAINT, NOT THE CAP. An earlier version of this script
 * reported only "% of the monthly cap", which reads as though the quota were
 * the limiting factor and the records were free. They are not. At this price
 * the Northern Virginia backfill is a five-figure purchase, and that changes
 * the decision rather than merely scheduling it.
 */
const COST_PER_RECORD = 172.50 / 142;

const MONTHS = Number(process.argv[2]) || 12;

async function count(url: string, params: Record<string, string>, method: "GET" | "POST"): Promise<number> {
  const body = new URLSearchParams({ ...params, returnCountOnly: "true", f: "json" });
  const res =
    method === "POST"
      ? await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        })
      : await fetch(`${url}?${body.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const json = await res.json();
  if (typeof json?.count !== "number") throw new Error(`no count in response from ${url}`);
  return json.count;
}

function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`Sizing a ${MONTHS}-month TitlePro247 backfill against a ${MONTHLY_CAP.toLocaleString()}/month cap.\n`);

  // Turnover, measured rather than assumed.
  const [fxParcels, fxSales] = await Promise.all([
    count(FAIRFAX_PARCELS, { where: "1=1" }, "POST"),
    count(FAIRFAX_SALES, { where: `SALEDT > DATE '${isoMonthsAgo(12)}'` }, "POST"),
  ]);
  const turnover = fxSales / fxParcels;
  console.log(
    `Turnover, measured on Fairfax: ${fxSales.toLocaleString()} sales / ` +
      `${fxParcels.toLocaleString()} parcels = ${(turnover * 100).toFixed(2)}% per year\n`
  );

  console.log(
    `  ${"county".padEnd(12)}${"parcels".padStart(10)}${"sales/yr".padStart(10)}` +
      `${`${MONTHS}mo pull`.padStart(11)}${"% of cap".padStart(10)}${"COST".padStart(12)}`
  );
  console.log("  " + "─".repeat(65));

  let backfill = 0;
  let naive = 0;
  for (const c of TARGETS) {
    const parcels = await count(c.parcelsUrl, { where: "1=1" }, c.method);
    const perYear = Math.round(parcels * turnover);
    const pull = Math.round(perYear * (MONTHS / 12));
    backfill += pull;
    naive += parcels;
    console.log(
      `  ${c.name.padEnd(12)}${parcels.toLocaleString().padStart(10)}${perYear.toLocaleString().padStart(10)}` +
        `${pull.toLocaleString().padStart(11)}${`${((pull / MONTHLY_CAP) * 100).toFixed(0)}%`.padStart(10)}` +
        `${`$${Math.round(pull * COST_PER_RECORD).toLocaleString()}`.padStart(12)}`
    );
  }

  const steady = Math.round((backfill / MONTHS) || 0);
  console.log("  " + "─".repeat(65));
  console.log(
    `  ${"TOTAL".padEnd(12)}${"".padStart(10)}${"".padStart(10)}` +
      `${backfill.toLocaleString().padStart(11)}${`${((backfill / MONTHLY_CAP) * 100).toFixed(0)}%`.padStart(10)}` +
      `${`$${Math.round(backfill * COST_PER_RECORD).toLocaleString()}`.padStart(12)}`
  );

  console.log(`\n${"═".repeat(70)}`);
  console.log("WHAT THIS MEANS");
  console.log("═".repeat(70));

  if (backfill > MONTHLY_CAP) {
    const months = Math.ceil(backfill / MONTHLY_CAP);
    console.log(
      `  The ${MONTHS}-month backfill needs ${backfill.toLocaleString()} pulls, over the ` +
        `${MONTHLY_CAP.toLocaleString()} cap.\n` +
        `  Split it across ${months} months, or shorten the history — the engine only\n` +
        `  looks back 12 months, and 6 still produces comps in most markets.`
    );
  } else {
    console.log(
      `  The ${MONTHS}-month backfill fits in one month at ` +
        `${((backfill / MONTHLY_CAP) * 100).toFixed(0)}% of the cap.`
    );
  }

  console.log(
    `\n  COST, NOT QUOTA, IS THE CONSTRAINT. At $${COST_PER_RECORD.toFixed(2)} a record ` +
      `(measured: 142 items\n  for $172.50) the backfill above is ` +
      `$${Math.round(backfill * COST_PER_RECORD).toLocaleString()}, and steady state is ` +
      `$${Math.round(steady * COST_PER_RECORD).toLocaleString()} a month\n  ` +
      `(${steady.toLocaleString()} records, ${((steady / MONTHLY_CAP) * 100).toFixed(0)}% of the cap).\n\n` +
      `  Weigh that against what it buys: Arlington, Loudoun and Alexandria are\n` +
      `  currently offered a CMA rather than a number, which is a working funnel.\n\n` +
      `  AND USE maxOwnershipYears. Without it a farm search returns every current\n` +
      `  owner in the radius — ${naive.toLocaleString()} parcels across these counties, ` +
      `${(naive / MONTHLY_CAP).toFixed(0)}x the\n` +
      `  monthly cap — to find the few thousand that actually sold.`
  );

  console.log(
    `\n  NOT INCLUDED ABOVE: ${UNMEASURED.join("; ")}.\n` +
      `  The total is therefore a floor, not the whole job.`
  );

  console.log(
    `\n  Confirm with getCount() in velocity-connectors before ordering. It asks\n` +
      `  TitlePro247 for the real number without spending any of the budget; the\n` +
      `  figures above are a turnover estimate from a neighbouring county.`
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
