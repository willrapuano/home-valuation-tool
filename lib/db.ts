import { Pool, QueryResultRow } from "pg";

/**
 * Postgres access.
 *
 * Optional by design. With no `DATABASE_URL` set, `getPool()` returns null and
 * every caller falls back to querying the public ArcGIS services directly —
 * which is exactly how the tool works today. The database is an accelerator
 * and a durability layer, not a new hard dependency, and adding one would be a
 * poor trade for a tool whose whole point is that it needs no credentials.
 *
 * CONNECTION POOLING IN SERVERLESS
 *
 * Each lambda instance opens its own pool, and instances are created freely, so
 * the total connection count is the number of live instances times `max`. That
 * is how you exhaust a Postgres connection limit without any single request
 * doing anything wrong. Two mitigations:
 *
 *   1. `max: 1` — a request handles one valuation; it has no use for more.
 *   2. Point `DATABASE_URL` at a POOLED connection string. Neon, Supabase and
 *      Vercel Postgres all provide one (usually with `-pooler` in the host, or
 *      port 6543). The direct string will work until traffic arrives and then
 *      fail in a way that looks like a database outage.
 */

let pool: Pool | null | undefined;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

export function hasDatabase(): boolean {
  return Boolean(databaseUrl());
}

export function getPool(): Pool | null {
  if (pool !== undefined) return pool;

  const url = databaseUrl();
  if (!url) {
    pool = null;
    return null;
  }

  pool = new Pool({
    connectionString: url,
    max: 1,
    // A valuation that waits ten seconds for a connection has already failed;
    // better to error and let the caller fall back to the live provider.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    // Managed Postgres requires TLS but presents a certificate chain the
    // default verifier rejects. This is the standard configuration for these
    // providers; the connection is still encrypted.
    ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  // A pool error outside a query (server restart, idle connection reset) is
  // emitted on the pool itself, and an unhandled 'error' event takes down the
  // process.
  pool.on("error", err => {
    console.error(`[db] idle client error: ${err?.message}`);
  });

  return pool;
}

/** Run a query, or return null if no database is configured. */
export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[] | null> {
  const p = getPool();
  if (!p) return null;
  const res = await p.query<T>(sql, params);
  return res.rows;
}

/** Test seam. */
export function __resetPoolForTests(): void {
  pool = undefined;
}
