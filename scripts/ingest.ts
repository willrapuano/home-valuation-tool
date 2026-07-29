/**
 * Pull sales from the live public-records providers into our own Postgres.
 *
 *   npx tsx scripts/ingest.ts                 # every jurisdiction
 *   npx tsx scripts/ingest.ts dc maryland     # named ones
 *   npx tsx scripts/ingest.ts --months 24     # deeper history
 *
 * Requires DATABASE_URL. The schema is applied automatically if missing.
 *
 * HOW IT WORKS
 *
 * Each jurisdiction is covered by a grid of overlapping circular queries. The
 * providers cap results per query — 2,000 for these services — so one query per
 * county would silently truncate, and truncation looks like "no comps nearby"
 * rather than an error. Tiles are sized so a dense urban tile stays under the
 * cap, and they overlap so nothing falls between them; the unique constraint on
 * (jurisdiction, parcel_id, sold_date) makes the overlap free.
 *
 * IDEMPOTENT AND RESUMABLE. Re-running is always safe: rows upsert on their
 * natural key. A tile that fails is logged and skipped rather than aborting the
 * run, and the count of failures is reported at the end — a partial ingest that
 * claims success is exactly the failure mode that would poison the valuations.
 */
import { Pool } from "pg";
import { DcProvider } from "../lib/comps/providers/dc";
import { FairfaxCountyProvider } from "../lib/comps/providers/fairfax";
import { MarylandProvider } from "../lib/comps/providers/maryland";
import { ComparableSale, CompsProvider } from "../lib/comps/types";
import { databaseUrl } from "../lib/db";
import { applySchema, schemaStatus } from "./migrate";

interface Jurisdiction {
  name: string;
  provider: () => CompsProvider;
  /** Bounding box to tile. */
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  /** Tile spacing in degrees. Smaller where property is dense. */
  step: number;
  /** Query radius per tile, miles. Must exceed the tile's half-diagonal. */
  radiusMiles: number;
}

const JURISDICTIONS: Jurisdiction[] = [
  {
    name: "dc",
    provider: () => new DcProvider({ qualifiedOnly: false }),
    bbox: { minLat: 38.79, maxLat: 39.0, minLng: -77.13, maxLng: -76.89 },
    // DC is small and very dense: ~800 sales within 1.5mi of one point.
    step: 0.02,
    radiusMiles: 1.2,
  },
  {
    name: "fairfax",
    provider: () => new FairfaxCountyProvider(),
    bbox: { minLat: 38.55, maxLat: 39.08, minLng: -77.56, maxLng: -77.0 },
    step: 0.03,
    radiusMiles: 1.7,
  },
  {
    name: "maryland",
    provider: () => new MarylandProvider(),
    // Statewide. This is the long one — thousands of tiles.
    bbox: { minLat: 37.88, maxLat: 39.73, minLng: -79.49, maxLng: -74.98 },
    step: 0.05,
    radiusMiles: 2.6,
  },
];

const args = process.argv.slice(2);
const monthsFlag = args.indexOf("--months");
const LOOKBACK_MONTHS = monthsFlag >= 0 ? Number(args[monthsFlag + 1]) || 24 : 24;
const named = args.filter(a => !a.startsWith("--") && a !== String(LOOKBACK_MONTHS));
const TARGETS = named.length ? JURISDICTIONS.filter(j => named.includes(j.name)) : JURISDICTIONS;

/** Tiles are queried a few at a time; these are public services, not ours. */
const CONCURRENCY = 4;
const PER_QUERY_LIMIT = 2000;

function tiles(j: Jurisdiction): { lat: number; lng: number }[] {
  const out: { lat: number; lng: number }[] = [];
  for (let lat = j.bbox.minLat; lat <= j.bbox.maxLat; lat += j.step) {
    for (let lng = j.bbox.minLng; lng <= j.bbox.maxLng; lng += j.step) {
      out.push({ lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) });
    }
  }
  return out;
}

async function upsert(pool: Pool, jurisdiction: string, comps: ComparableSale[]): Promise<number> {
  if (!comps.length) return 0;

  // The provider's id is `parcel@date`; the parcel alone is the natural key.
  const rows = comps.map(c => ({ ...c, parcelId: c.id.split("@")[0] }));

  const values: unknown[] = [];
  const tuples = rows.map((c, i) => {
    const b = i * 16;
    values.push(
      jurisdiction, c.parcelId, c.location.lng, c.location.lat,
      Math.round(c.soldPrice), c.soldDate, c.address ?? null, c.zipCode ?? null,
      c.propertyType, c.assessedValue ? Math.round(c.assessedValue) : null,
      c.sqft ?? null, c.lotSqft ?? null, c.yearBuilt ?? null,
      c.beds ?? null, c.baths ?? null, c.condition ?? null
    );
    return `($${b + 1}, $${b + 2}, ST_MakePoint($${b + 3}, $${b + 4})::geography,
             $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10},
             $${b + 11}, $${b + 12}, $${b + 13}, $${b + 14}, $${b + 15}, $${b + 16})`;
  });

  const res = await pool.query(
    `INSERT INTO sales (
       jurisdiction, parcel_id, location, sold_price, sold_date, address,
       zip_code, property_type, assessed_value, sqft, lot_sqft, year_built,
       beds, baths, condition
     ) VALUES ${tuples.join(",")}
     ON CONFLICT (jurisdiction, parcel_id, sold_date) DO UPDATE SET
       -- Refresh the mutable facts; the assessment in particular changes
       -- annually and a stale one silently degrades every valuation near it.
       assessed_value = EXCLUDED.assessed_value,
       sqft           = COALESCE(EXCLUDED.sqft, sales.sqft),
       lot_sqft       = COALESCE(EXCLUDED.lot_sqft, sales.lot_sqft),
       year_built     = COALESCE(EXCLUDED.year_built, sales.year_built),
       condition      = COALESCE(EXCLUDED.condition, sales.condition),
       ingested_at    = now()`,
    values
  );
  return res.rowCount ?? 0;
}

async function ingestOne(pool: Pool, j: Jurisdiction): Promise<void> {
  const grid = tiles(j);
  const started = Date.now();
  console.log(`\n${j.name}: ${grid.length} tiles, ${LOOKBACK_MONTHS} month lookback`);

  const run = await pool.query<{ id: string }>(
    `INSERT INTO ingest_runs (jurisdiction, tiles_total) VALUES ($1, $2) RETURNING id`,
    [j.name, grid.length]
  );
  const runId = run.rows[0].id;

  let written = 0;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < grid.length; i += CONCURRENCY) {
    const batch = grid.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async tile => {
        try {
          const comps = await j.provider().fetchCandidates(
            { location: tile, propertyType: "single_family" },
            { radiusMiles: j.radiusMiles, lookbackMonths: LOOKBACK_MONTHS, limit: PER_QUERY_LIMIT }
          );
          // A full tile means the cap was probably hit and sales were lost.
          // Say so rather than let a silent truncation look like thin data.
          if (comps.length >= PER_QUERY_LIMIT) {
            console.warn(
              `  ! tile ${tile.lat},${tile.lng} returned the ${PER_QUERY_LIMIT} cap — ` +
                `reduce step/radius for ${j.name}, sales are being dropped`
            );
          }
          written += await upsert(pool, j.name, comps);
        } catch (err) {
          failed++;
          console.warn(`  ! tile ${tile.lat},${tile.lng} failed: ${(err as Error)?.message}`);
        } finally {
          done++;
        }
      })
    );

    if (done % 40 < CONCURRENCY || done === grid.length) {
      const pct = ((done / grid.length) * 100).toFixed(0);
      process.stdout.write(`  ${done}/${grid.length} tiles (${pct}%), ${written} rows\r`);
      await pool.query(`UPDATE ingest_runs SET tiles_done = $1, rows_written = $2 WHERE id = $3`, [
        done, written, runId,
      ]);
    }
  }

  await pool.query(
    `UPDATE ingest_runs
        SET finished_at = now(), tiles_done = $1, rows_written = $2, ok = $3, error = $4
      WHERE id = $5`,
    [done, written, failed === 0, failed ? `${failed} tile(s) failed` : null, runId]
  );

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `\n  ${j.name}: ${written} rows from ${done} tiles in ${secs}s` +
      (failed ? `, ${failed} tile(s) FAILED` : "")
  );
}

async function main() {
  const url = databaseUrl();
  if (!url) {
    console.error(
      "DATABASE_URL is not set.\n\n" +
        "  1. Create a Postgres database (Vercel Storage, Neon or Supabase).\n" +
        "  2. Re-run this script — it applies the schema itself.\n\n" +
        "Use the POOLED connection string, not the direct one."
    );
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    max: 4,
    ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  // Apply the schema rather than requiring someone to have run psql months
  // earlier. The whole file is CREATE ... IF NOT EXISTS, so this is a no-op on
  // an already-migrated database. A database that is provisioned but unmigrated
  // reports itself as configured, which is how this one sat with
  // `relation "sales" does not exist` while looking fine.
  const missing = await schemaStatus(pool);
  if (missing) {
    console.log(`  applying schema (${missing})...`);
    try {
      await applySchema(pool);
    } catch (err) {
      console.error(
        `Could not apply the schema: ${(err as Error)?.message}\n` +
          `PostGIS may not be available to this database role.`
      );
      process.exit(1);
    }
  }

  for (const j of TARGETS) {
    try {
      await ingestOne(pool, j);
    } catch (err) {
      console.error(`${j.name} aborted: ${(err as Error)?.message}`);
    }
  }

  const total = await pool.query<{ jurisdiction: string; n: string }>(
    `SELECT jurisdiction, COUNT(*) AS n FROM sales GROUP BY jurisdiction ORDER BY jurisdiction`
  );
  console.log("\nRows held:");
  for (const r of total.rows) console.log(`  ${r.jurisdiction.padEnd(12)} ${Number(r.n).toLocaleString()}`);
  console.log(
    "\nNext: run the backtests against this data before putting it in front of anyone.\n" +
      "An ingest that dropped a third of the sales still produces confident-looking numbers."
  );

  await pool.end();
}

main().catch(err => {
  console.error("Ingest failed:", err?.message ?? err);
  process.exit(1);
});
