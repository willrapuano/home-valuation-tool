# Holding the data ourselves

## What caching does and does not fix

The valuation cache now survives a lambda recycle (`lib/kv.ts`). That was a
real defect — the same address measured 511ms/cached on one run and
4,371ms/uncached on the next, because the second request landed on a different
instance — and it is worth fixing.

**It does not fix first-visit latency, and it should not be sold as if it
does.** A homeowner typing their address for the first time is a cache miss by
definition. Measured against production:

| | p50 | p90 |
|---|---|---|
| Before hedging | 3.31s | 14.56s |
| After hedging | 3.95s | 10.54s |

Hedging took the easy win by removing a serial retry. What remains is
structural, and no cache in front of it will help:

1. **Cold serverless starts.**
2. **Multiple upstream round trips per valuation.** Every request does a subject
   lookup and a comp search, and DC adds a CAMA join of one query per 75
   parcels. That is 2–4 sequential network hops to a third party, per visitor.
3. **A third party's latency is in our request path.** When Maryland iMAP is
   slow, our funnel is slow, and there is nothing we can do about it at
   request time.

Caching a per-address result only helps the second person to ask about that
exact house. Caching a comp *pool* per neighbourhood helps more, but only once
someone nearby has already asked — and it has a trap worth stating: to serve a
subject anywhere in a cell, the pool must be fetched at `radius +
half-cell-diagonal`, which returns more records, and if that exceeds the
provider's record cap the result is **silently truncated**. Truncation looks
like "no comps nearby" rather than an error. That failure mode has already bitten
this codebase once, in Fairfax, and it is the reason the pool cache was not
shipped alongside the KV change on a guess.

## The actual fix: ingest, don't fetch

Hold the sales data ourselves and make a valuation a local query.

```
scheduled job  →  DC / Maryland / Fairfax providers  →  normalise  →  Postgres + PostGIS
                                                                          ↓
homeowner request  →  /api/avm  →  one indexed spatial query  →  valuation
```

Comps become a single indexed `ST_DWithin` query instead of 2–4 third-party
round trips. Expect sub-100ms where we currently spend seconds, and the tail
disappears because there is no upstream in the request path.

### What it unlocks beyond speed

- **Monthly re-valuation.** The retention mechanism this product is missing.
  You cannot re-value a portfolio nightly by making four ArcGIS calls per home;
  you can trivially with a local table.
- **No third-party outage in the funnel.** A failed ingest means yesterday's
  data, not a blank screen. The system degrades instead of breaking.
- **Somewhere to put non-API sources.** A commercial extract is a file, not an
  endpoint, and needs a table to land in.
- **Backtesting gets cheap.** Every backtest in `scripts/` currently re-fetches
  thousands of records from public services; several of the slow, flaky runs in
  this project's history were self-inflicted rate limiting.

### Shape

One table does most of the work:

```
sales(
  id, jurisdiction, parcel_id,
  location geography(Point,4326),   -- GIST index; this is the hot path
  sold_price, sold_date,
  assessed_value, property_type,
  sqft, lot_sqft, year_built, beds, baths, condition,
  arms_length boolean,              -- worth 1.9pp where published; see
                                    -- jurisdiction-data-sources.md
  ingested_at,
  unique (jurisdiction, parcel_id, sold_date)
)
```

The unique constraint is doing real work: public records carry re-recorded
deeds, and both Fairfax and Maryland required de-duplication by parcel to avoid
counting the same sale twice.

Providers already return this shape — `ComparableSale` in `lib/comps/types.ts`
is very nearly the row. So ingest is `fetchCandidates` over a tiling of each
jurisdiction, and the query side is a new `CompsProvider` reading from Postgres.
**The scoring, adjustment and reconciliation engine does not change at all**,
which also means the existing backtests can validate the ingested data against
the same holdout method before it serves anyone.

### It is also a PREREQUISITE, not only an optimisation

The framing above is latency, and that was the original motivation. It
undersells it.

TitlePro247 — the only viable source for Arlington and Loudoun, which publish
no sale price or assessed value at all — is a **batch** source. A search there
is a billable, asynchronous farm-list order: submit, poll, download XLSX,
parse. It cannot be called per valuation at any price or any latency.

So there is no version of Northern Virginia coverage that does not go through
a local table. `scripts/ingest-titlepro.ts` writes into this schema. Without
the datastore, those two counties simply cannot be served.

### Status — code is written, database is not provisioned

| | |
|---|---|
| Schema + indexes | **done** — `db/schema.sql`, applied automatically by `scripts/ingest.ts` |
| Pooled client, optional by design | **done** — `lib/db.ts` |
| `PostgresProvider` | **done** — `lib/comps/providers/postgres.ts` |
| Tiled, idempotent, resumable ingest | **done** — `scripts/ingest.ts` |
| Wired into `COVERAGE`, first, behind `hasDatabase()` | **done** |
| Freshness in `/api/health` | **done** |
| **Provision the database** | **needs a human** |
| **Backtest the ingested data** | blocked on the above |

With no `DATABASE_URL` the provider is skipped entirely and the tool behaves
exactly as it does today — the database is an accelerator, not a new hard
dependency.

### To turn it on

```bash
# 1. Create a Postgres with PostGIS (Vercel Storage, Neon, Supabase).
#    Copy the POOLED connection string.
export DATABASE_URL='postgres://...-pooler...'

# 2. Ingest. It applies db/schema.sql itself if the tables are missing, so
#    there is no separate migration step to forget. Start with one
#    jurisdiction; Maryland is statewide and long.
npx tsx scripts/ingest.ts dc
npx tsx scripts/ingest.ts fairfax
npx tsx scripts/ingest.ts maryland

# 3. VALIDATE BEFORE TRUSTING IT. These must match the live-source numbers
#    (DC 4.5%, Fairfax 5.3%, Maryland 8.7%).
npx tsx scripts/dc-backtest.ts 40
npx tsx scripts/backtest.ts 40
npx tsx scripts/maryland-backtest.ts 50

# 4. Set DATABASE_URL in Vercel, redeploy, then re-measure.
npx tsx scripts/latency-probe.ts
```

Step 4 is not optional. An ingest bug that drops a third of the sales still
produces confident-looking valuations — the numbers just quietly get worse.

### Then: monthly re-valuation

Once the table exists this is a cron over it rather than a rebuild: iterate
captured leads, re-run `valueFromComps` against current rows, and email the
delta. That is the Homebot retention loop, and it is the reason to do this
beyond latency.
