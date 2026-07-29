-- Sales we hold ourselves, so a valuation is a local query rather than two to
-- four round trips to a third party's ArcGIS service.
--
-- Run once against a fresh database:
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- Requires PostGIS. Vercel Postgres, Neon and Supabase all ship it; on Neon and
-- Supabase the extension is available without superuser.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS sales (
  id              BIGSERIAL PRIMARY KEY,

  -- Which public-records source this came from: "dc", "maryland", "fairfax".
  jurisdiction    TEXT        NOT NULL,
  -- That jurisdiction's own parcel identifier: SSL in DC, ACCTID in Maryland,
  -- PIN in Fairfax. Kept verbatim, padding and all, so it joins back.
  parcel_id       TEXT        NOT NULL,

  -- The hot path. geography(Point) rather than geometry so ST_DWithin takes
  -- metres and does real distance instead of degrees.
  location        geography(Point, 4326) NOT NULL,

  sold_price      BIGINT      NOT NULL CHECK (sold_price > 0),
  sold_date       DATE        NOT NULL,

  address         TEXT,
  zip_code        TEXT,
  property_type   TEXT        NOT NULL,
  assessed_value  BIGINT,

  sqft            INTEGER,
  lot_sqft        INTEGER,
  year_built      INTEGER,
  beds            REAL,
  baths           REAL,
  condition       SMALLINT,
  subdivision     TEXT,

  -- Published only by DC today, and worth 1.9pp there. NULL means "not
  -- stated", which is different from false and must stay distinguishable.
  arms_length     BOOLEAN,

  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Public records carry re-recorded deeds: the same sale filed twice, days
  -- apart, at the same price. Both Fairfax and Maryland required de-duplicating
  -- by parcel, and doing it here means an ingest bug cannot double-count a
  -- comp no matter how many times the job runs.
  UNIQUE (jurisdiction, parcel_id, sold_date)
);

-- Every valuation is "recent sales near this point", so the index has to serve
-- both halves. GIST on the geography does the spatial half.
CREATE INDEX IF NOT EXISTS sales_location_idx ON sales USING GIST (location);
-- Partial index on the recency half: no query ever asks for old sales, so
-- there is no reason to index them.
CREATE INDEX IF NOT EXISTS sales_recent_idx ON sales (sold_date DESC)
  WHERE sold_date > (CURRENT_DATE - INTERVAL '3 years');
-- Ingest looks rows up by natural key constantly.
CREATE INDEX IF NOT EXISTS sales_parcel_idx ON sales (jurisdiction, parcel_id);

-- Freshness, so /api/health can say when a jurisdiction was last ingested
-- rather than silently serving months-old comps.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            BIGSERIAL PRIMARY KEY,
  jurisdiction  TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  tiles_total   INTEGER,
  tiles_done    INTEGER,
  rows_written  INTEGER,
  ok            BOOLEAN,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS ingest_runs_recent_idx
  ON ingest_runs (jurisdiction, started_at DESC);
