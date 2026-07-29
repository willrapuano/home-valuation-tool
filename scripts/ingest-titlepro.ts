/**
 * Load a TitlePro247 farm-list export into the `sales` table.
 *
 *   npx tsx scripts/ingest-titlepro.ts <export-file> --jurisdiction arlington
 *   npx tsx scripts/ingest-titlepro.ts export.xlsx -j loudoun --months 24
 *   npx tsx scripts/ingest-titlepro.ts export.xlsx -j arlington --dry-run
 *
 * Accepts .xlsx, .csv or .json.
 *
 * WHY A FILE AND NOT AN API CALL
 *
 * TitlePro247 searches are billable, asynchronous farm-list ORDERS, not
 * queries — see lib/comps/providers/titlepro247.ts. `velocity-connectors`
 * owns placing them, because it holds the credentials and the cost ceiling,
 * and neither should be duplicated into a public-facing valuation app. This
 * takes the resulting export.
 *
 * WHAT IT DOES NOT DO: wire TitlePro247 into `/api/avm`. Rows land in the
 * table and are served only if a PostgresProvider covering that jurisdiction
 * is added to COVERAGE, which is deliberately a separate, deliberate act —
 * whether this data may be shown to anonymous consumers is a licensing
 * question that has not been answered. Ingesting is reversible; publishing
 * someone else's licensed data is not.
 *
 * --dry-run does everything except write, and prints the same report. Run it
 * first on any new county: it is how you find out that the property-type
 * strings differ before you have written ten thousand rows of "other".
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { geocodeAll, GeocodeInput } from "../lib/geocode";
import {
  geocodeKeyFor,
  toComparableSales,
  TP247Property,
} from "../lib/comps/providers/titlepro247";
import { ComparableSale } from "../lib/comps/types";
import { databaseUrl } from "../lib/db";
import { applySchema, schemaStatus } from "./migrate";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("-") && /\.(xlsx|csv|json)$/i.test(a));
const flag = (...names: string[]) => {
  const i = args.findIndex(a => names.includes(a));
  return i >= 0 ? args[i + 1] : undefined;
};
const jurisdiction = flag("--jurisdiction", "-j");
const months = Number(flag("--months")) || 24;
const dryRun = args.includes("--dry-run");

function usage(msg: string): never {
  console.error(
    `${msg}\n\n` +
      `  npx tsx scripts/ingest-titlepro.ts <export.xlsx|csv|json> --jurisdiction <name> [--months 24] [--dry-run]\n\n` +
      `The jurisdiction name is stored on every row and is how a PostgresProvider\n` +
      `later selects them. Use a stable slug: "arlington", "loudoun".`
  );
  process.exit(1);
}

/* ── Reading the export ─────────────────────────────────────────── */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Header aliasing, mirroring velocity-connectors' `normalizePropertyRow`.
 * TitlePro247 names the same column differently depending on the county's
 * underlying data source, so each field lists every name seen.
 */
const ALIASES: Record<keyof TP247Property, string[]> = {
  siteAddressLine1: ["siteAddressLine1", "SiteAddress", "SitusAddress", "PropertyAddress", "Site Address", "Situs Address", "Property Address", "Property Street Address"],
  siteCity: ["SiteCity", "siteCity", "PropertyCity", "Site City", "Situs City", "Property City", "City"],
  siteState: ["SiteState", "siteState", "PropertyState", "Site State", "Situs State", "Property State", "State"],
  siteZip: ["SiteZip", "siteZip", "PropertyZip", "Site Zip", "Situs Zip", "Property Zip", "ZIP Code", "Zip Code"],
  lastSaleAmount: ["LastSaleAmount", "lastSaleAmount", "SaleAmount", "Last Sale Amount", "Sale Amount"],
  lastSaleDate: ["LastSaleDate", "lastSaleDate", "SaleDate", "Last Sale Date", "Sale Date", "Sale Recording Date"],
  assessedValue: ["AssessedValue", "assessedValue", "Assessed Value", "Total Assessed Value", "Assessed Total Value"],
  marketValue: ["MarketValue", "marketValue", "Market Value", "Estimated Value"],
  propertyType: ["PropertyType", "propertyType", "Property Type", "Land Use"],
  detailedPropertyType: ["DetailedPropertyType", "detailedPropertyType", "PropertySubType", "Detailed Property Type", "Property Sub Type", "Property Subtype"],
  sqft: ["Sqft", "sqft", "SquareFeet", "Building Area", "Living Area", "Building Sq Ft", "Total Building Area"],
  lotSize: ["LotSize", "lotSize", "Lot Size", "Lot Size SF / Acre", "Lot Sq Ft", "Acres"],
  yearBuilt: ["YearBuilt", "yearBuilt", "Year Built", "Effective Year Built"],
  beds: ["Beds", "beds", "Bedrooms", "Bed"],
  baths: ["Baths", "baths", "Bathrooms", "Bath"],
  ownerType: ["OwnerType", "ownerType", "Owner Type"],
};

const NUMERIC = new Set<keyof TP247Property>([
  "lastSaleAmount", "assessedValue", "marketValue", "sqft", "yearBuilt", "beds", "baths",
]);

function pick(row: Record<string, unknown>, names: string[]): unknown {
  // Case- and space-insensitive, because export headers are inconsistent
  // about both and a missed header silently becomes a missing field.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const index = new Map(Object.keys(row).map(k => [norm(k), k]));
  for (const n of names) {
    const k = index.get(norm(n));
    if (k !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return undefined;
}

function toProperty(row: Record<string, unknown>): TP247Property {
  const out: Record<string, unknown> = {};
  for (const [field, names] of Object.entries(ALIASES) as [keyof TP247Property, string[]][]) {
    const raw = pick(row, names);
    if (raw === undefined) continue;
    if (NUMERIC.has(field)) {
      const n = Number(String(raw).replace(/[$,\s]/g, ""));
      if (Number.isFinite(n)) out[field] = n;
    } else {
      out[field] = String(raw).trim();
    }
  }
  return {
    siteAddressLine1: "", siteCity: "", siteState: "", siteZip: "",
    ...out,
  } as TP247Property;
}

async function readRows(path: string): Promise<Record<string, unknown>[]> {
  if (/\.json$/i.test(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.properties ?? []);
  }

  if (/\.csv$/i.test(path)) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const headers = splitCsvLine(lines[0]);
    return lines.slice(1).map(l => {
      const cells = splitCsvLine(l);
      return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
    });
  }

  // XLSX. exceljs is NOT a dependency of this app and should not become one
  // for a script — TitlePro247's exportFarmList can emit CSV directly, which
  // needs nothing. The specifier is held in a variable so TypeScript does not
  // try to resolve a package that is legitimately absent.
  const specifier = "exceljs";
  const mod = await import(specifier).catch(() => null);
  if (!mod) {
    console.error(
      `Reading .xlsx needs exceljs, which is not installed:  npm i -D exceljs\n` +
        `Simpler: export the farm list as CSV instead — TitlePro247 offers both\n` +
        `and the CSV path needs no extra package.`
    );
    process.exit(1);
  }

  const workbook = new (mod.default ?? mod).Workbook();
  await workbook.xlsx.readFile(path);
  const ws = workbook.worksheets[0];
  if (!ws) return [];

  // The header is not always row 1 — exports carry title and filter banners.
  let headers: string[] = [];
  const rows: Record<string, unknown>[] = [];
  ws.eachRow((row: { values: unknown }) => {
    const values = (row.values as unknown[]).slice(1).map(v => (v == null ? "" : String(v).trim()));
    if (!headers.length) {
      if (values.filter(Boolean).length >= 3) headers = values;
      return;
    }
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
  });
  return rows;
}

/* ── Writing ────────────────────────────────────────────────────── */

async function upsert(pool: Pool, jur: string, sales: ComparableSale[]): Promise<number> {
  let written = 0;
  const CHUNK = 500;

  for (let i = 0; i < sales.length; i += CHUNK) {
    const batch = sales.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = batch.map((c, n) => {
      const b = n * 15;
      values.push(
        jur, c.id.split("@")[0], c.location.lng, c.location.lat,
        Math.round(c.soldPrice), c.soldDate, c.address ?? null, c.zipCode ?? null,
        c.propertyType, c.assessedValue ? Math.round(c.assessedValue) : null,
        c.sqft ?? null, c.lotSqft ?? null, c.yearBuilt ?? null, c.beds ?? null, c.baths ?? null
      );
      return `($${b + 1}, $${b + 2}, ST_MakePoint($${b + 3}, $${b + 4})::geography,
               $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10},
               $${b + 11}, $${b + 12}, $${b + 13}, $${b + 14}, $${b + 15})`;
    });

    const res = await pool.query(
      `INSERT INTO sales (
         jurisdiction, parcel_id, location, sold_price, sold_date, address,
         zip_code, property_type, assessed_value, sqft, lot_sqft, year_built, beds, baths
       ) VALUES ${tuples.join(",")}
       ON CONFLICT (jurisdiction, parcel_id, sold_date) DO UPDATE SET
         assessed_value = EXCLUDED.assessed_value,
         sqft           = COALESCE(EXCLUDED.sqft, sales.sqft),
         lot_sqft       = COALESCE(EXCLUDED.lot_sqft, sales.lot_sqft),
         year_built     = COALESCE(EXCLUDED.year_built, sales.year_built),
         beds           = COALESCE(EXCLUDED.beds, sales.beds),
         baths          = COALESCE(EXCLUDED.baths, sales.baths),
         ingested_at    = now()`,
      values
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

/* ── Main ───────────────────────────────────────────────────────── */

async function main() {
  if (!file) usage("No export file given.");
  if (!jurisdiction) usage("--jurisdiction is required.");

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const soldSince = cutoff.toISOString().slice(0, 10);

  console.log(`Reading ${file}...`);
  const raw = await readRows(file);
  console.log(`  ${raw.length} rows`);
  if (!raw.length) { console.error("Nothing to ingest."); process.exit(1); }

  const properties = raw.map(toProperty);

  // Geocode BEFORE mapping, but only the rows that could survive it — no point
  // paying for a lookup on a sale from 1994. The mapper re-checks everything;
  // this is purely to keep the geocode batch small.
  const candidates = properties.filter(p => {
    if (!p.siteAddressLine1) return false;
    const d = p.lastSaleDate ? String(p.lastSaleDate) : "";
    return d.length > 0;
  });

  const seen = new Set<string>();
  const toGeocode: GeocodeInput[] = [];
  for (const p of candidates) {
    const id = geocodeKeyFor(p);
    if (seen.has(id)) continue;
    seen.add(id);
    toGeocode.push({ id, street: p.siteAddressLine1, city: p.siteCity, state: p.siteState, zip: p.siteZip });
  }

  console.log(`Geocoding ${toGeocode.length} distinct addresses (Census, free)...`);
  const geo = await geocodeAll(toGeocode, (done, total) =>
    process.stdout.write(`  ${done}/${total}\r`)
  );
  console.log(`  ${geo.matched.size} placed, ${geo.unmatched.length} unmatched`);

  const report = toComparableSales(properties, geo.matched, soldSince);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`Usable comps: ${report.sales.length}  (sold since ${soldSince})`);
  console.log("Dropped:");
  for (const [reason, n] of Object.entries(report.skipped).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(26)} ${String(n).padStart(6)}`);
  }
  if (Object.keys(report.unmappedTypes).length) {
    // Loud, because it means TYPE_KEYWORDS needs a line and the alternative is
    // discarding a county's worth of good sales without noticing.
    console.log("\n  ⚠ UNRECOGNISED PROPERTY TYPES — add these to TYPE_KEYWORDS:");
    for (const [t, n] of Object.entries(report.unmappedTypes).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`      ${String(n).padStart(6)}  ${t}`);
    }
  }
  console.log("─".repeat(70));

  if (!report.sales.length) {
    console.error("\nNothing usable. Fix the above before writing.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written. Sample of what would land:\n");
    for (const s of report.sales.slice(0, 5)) {
      console.log(
        `  ${s.address.slice(0, 34).padEnd(34)} $${s.soldPrice.toLocaleString().padStart(10)}  ` +
          `${s.soldDate}  ${s.propertyType}${s.assessedValue ? `  assessed $${s.assessedValue.toLocaleString()}` : ""}`
      );
    }
    return;
  }

  const url = databaseUrl();
  if (!url) {
    console.error("\nDATABASE_URL is not set — nowhere to write. Re-run with --dry-run to validate the file.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    max: 2,
    ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  try {
    const missing = await schemaStatus(pool);
    if (missing) {
      console.log(`Applying schema (${missing})...`);
      await applySchema(pool);
    }
    const written = await upsert(pool, jurisdiction, report.sales);
    console.log(`\nWrote ${written} rows as jurisdiction "${jurisdiction}".`);
    console.log(
      `\nThese are NOT served yet. /api/avm has no coverage entry for "${jurisdiction}",\n` +
        `and adding one publishes licensed third-party data to anonymous visitors —\n` +
        `confirm that is permitted before wiring it up.`
    );
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
