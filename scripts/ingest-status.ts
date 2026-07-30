/**
 * What is actually in the sales table?
 *
 *   npx tsx scripts/ingest-status.ts
 *
 * An ingest that quietly wrote a third of the sales still produces
 * confident-looking valuations — the numbers just get worse, with nothing to
 * say so. This prints what landed, per jurisdiction, so a bad run is visible
 * in the workflow log rather than in a homeowner's estimate.
 *
 * Freshness is the number to watch. Rows arriving is not the same as rows
 * being current: DC and Fairfax publish within about 10 days, Maryland about
 * 90, so a jurisdiction whose newest sale is far past that has stalled even
 * though the ingest "succeeded".
 */
import { databaseUrl, query } from "../lib/db";

/** Normal publishing lag per source, measured. Beyond this, something stalled. */
const EXPECTED_LAG_DAYS: Record<string, number> = {
  dc: 25,
  fairfax: 25,
  maryland: 130,
  arlington: 45,
  loudoun: 45,
};

interface Row {
  jurisdiction: string;
  rows: string;
  newest: string | null;
  oldest: string | null;
  with_assessment: string;
  ingested: string | null;
}

async function main() {
  if (!databaseUrl()) {
    console.log("DATABASE_URL is not set — nothing to report.");
    return;
  }

  const rows = await query<Row>(
    `SELECT jurisdiction,
            COUNT(*)                                        AS rows,
            MAX(sold_date)::text                            AS newest,
            MIN(sold_date)::text                            AS oldest,
            COUNT(*) FILTER (WHERE assessed_value > 0)      AS with_assessment,
            MAX(ingested_at)::text                          AS ingested
       FROM sales
      GROUP BY jurisdiction
      ORDER BY jurisdiction`
  );

  if (!rows?.length) {
    console.error(
      "The sales table is EMPTY.\n\n" +
        "The schema exists but nothing has been ingested, which means\n" +
        "PostgresProvider returns no rows and every valuation falls through to\n" +
        "the live services. That is survivable but it is not what a configured\n" +
        "datastore should look like."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `  ${"jurisdiction".padEnd(13)}${"rows".padStart(9)}${"newest sale".padStart(14)}` +
      `${"age".padStart(7)}${"assessed".padStart(10)}${"last ingest".padStart(14)}`
  );
  console.log("  " + "─".repeat(67));

  const stale: string[] = [];
  for (const r of rows) {
    const n = Number(r.rows);
    const ageDays = r.newest
      ? Math.round((Date.now() - Date.parse(r.newest)) / 86_400_000)
      : NaN;
    const limit = EXPECTED_LAG_DAYS[r.jurisdiction] ?? 45;
    if (Number.isFinite(ageDays) && ageDays > limit) stale.push(`${r.jurisdiction} (${ageDays}d)`);

    console.log(
      `  ${r.jurisdiction.padEnd(13)}${n.toLocaleString().padStart(9)}` +
        `${(r.newest ?? "—").padStart(14)}${`${ageDays}d`.padStart(7)}` +
        `${`${((Number(r.with_assessment) / n) * 100).toFixed(0)}%`.padStart(10)}` +
        `${(r.ingested?.slice(0, 10) ?? "—").padStart(14)}`
    );
  }

  if (stale.length) {
    // A warning, not a failure: the rows are still usable and the engine
    // time-adjusts them. But a feed that has stopped looks exactly like a
    // quiet market, and only this tells them apart.
    console.log(
      `\n::warning::Newest sale is older than the source's normal lag for: ${stale.join(", ")}. ` +
        `The feed may have stalled.`
    );
  }
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
