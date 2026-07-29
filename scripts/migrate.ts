/**
 * Apply db/schema.sql to the configured database.
 *
 *   npx tsx scripts/migrate.ts
 *
 * WHY THIS EXISTS RATHER THAN A README LINE
 *
 * The schema used to be applied by hand, with `psql "$DATABASE_URL" -f
 * db/schema.sql` written in three places. Predictably it was never run: the
 * database was provisioned, `DATABASE_URL` was set, and /api/health sat there
 * reporting `relation "sales" does not exist` — a half-configured state that
 * looks configured from the outside.
 *
 * A manual step that must be remembered once, months before it matters, is a
 * step that does not happen. `scripts/ingest.ts` now calls this first, so
 * whoever runs the ingest gets the tables whether or not they knew they needed
 * to.
 *
 * SAFE TO RUN REPEATEDLY. Every statement in the schema is CREATE ... IF NOT
 * EXISTS, so this is a no-op against an already-migrated database. It does not
 * drop, alter or migrate existing columns — if the schema ever changes shape,
 * that needs a real migration, not this.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { databaseUrl } from "../lib/db";

export const SCHEMA_PATH = join(process.cwd(), "db", "schema.sql");

export async function applySchema(pool: Pool): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(sql);
}

/**
 * What the database is missing, in the terms a caller can act on. Returns null
 * when everything is present.
 */
export async function schemaStatus(pool: Pool): Promise<string | null> {
  try {
    await pool.query("SELECT postgis_version()");
  } catch {
    return "PostGIS is not installed";
  }
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.sales') IS NOT NULL AS present`
  );
  return rows[0]?.present ? null : `table "sales" does not exist`;
}

async function main() {
  const url = databaseUrl();
  if (!url) {
    console.error(
      "DATABASE_URL is not set. Nothing to migrate.\n\n" +
        "This is a valid state: with no database the tool queries the public\n" +
        "ArcGIS services directly, which is how it runs today."
    );
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    max: 1,
    ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  try {
    const before = await schemaStatus(pool);
    if (!before) {
      console.log("Schema already present — nothing to do.");
      return;
    }
    console.log(`Applying db/schema.sql (${before})...`);
    await applySchema(pool);

    const after = await schemaStatus(pool);
    if (after) {
      // Applying the file reported success but the tables are still missing:
      // almost always PostGIS unavailable to this role.
      console.error(`Schema applied but ${after}. Check the database role's privileges.`);
      process.exit(1);
    }
    console.log("Schema applied. Run `npx tsx scripts/ingest.ts` to populate it.");
  } catch (err) {
    console.error(`Migration failed: ${(err as Error)?.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly, so importing applySchema does not migrate.
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  main();
}
