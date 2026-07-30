import { query } from "../../db";
import { ComparableSale, CompsProvider, Condition, LatLng, PropertyType, SubjectLookup, SubjectProperty } from "../types";

/**
 * Comps from our own ingested copy of the public records.
 *
 * One indexed spatial query instead of the two-to-four third-party round trips
 * every other provider makes. Production measured p50 3.95s / p90 10.54s
 * against the live sources; this path does not have an upstream in it at all.
 *
 * It serves the same `CompsProvider` interface as the live providers, so the
 * scoring, adjustment and reconciliation engine is untouched and the existing
 * backtests validate this data exactly as they validate theirs. That check is
 * not optional: an ingest bug that silently dropped a third of the sales would
 * still produce confident-looking valuations.
 */

/** Row shape returned by both queries below. */
interface SaleRow {
  parcel_id: string;
  address: string | null;
  lat: number;
  lng: number;
  sold_price: string | number;
  sold_date: Date | string;
  property_type: string;
  assessed_value: string | number | null;
  sqft: number | null;
  lot_sqft: number | null;
  year_built: number | null;
  beds: number | null;
  baths: number | null;
  condition: number | null;
  subdivision: string | null;
  zip_code: string | null;
  arms_length: boolean | null;
}

const MILES_TO_METRES = 1609.344;

function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isoDate(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function toComp(r: SaleRow): ComparableSale {
  const soldDate = isoDate(r.sold_date);
  return {
    id: `${r.parcel_id}@${soldDate}`,
    address: r.address ?? r.parcel_id,
    location: { lat: Number(r.lat), lng: Number(r.lng) },
    soldPrice: Number(r.sold_price),
    soldDate,
    propertyType: (r.property_type as PropertyType) ?? "other",
    assessedValue: num(r.assessed_value),
    sqft: num(r.sqft),
    lotSqft: num(r.lot_sqft),
    yearBuilt: num(r.year_built),
    beds: num(r.beds),
    baths: num(r.baths),
    condition: (r.condition ?? undefined) as Condition | undefined,
    subdivision: r.subdivision ?? undefined,
    zipCode: r.zip_code ?? undefined,
  };
}

const SELECT_COLUMNS = `
  parcel_id, address,
  ST_Y(location::geometry) AS lat,
  ST_X(location::geometry) AS lng,
  sold_price, sold_date, property_type, assessed_value,
  sqft, lot_sqft, year_built, beds, baths, condition, subdivision, zip_code,
  arms_length
`;

/**
 * Jurisdictions this provider will serve.
 *
 * AN ALLOW-LIST, NOT A FILTER, AND THE DISTINCTION IS THE POINT.
 *
 * The table is a shared bucket keyed by `jurisdiction`, and the query used to
 * have no jurisdiction predicate at all — every row within the radius was
 * served. That was harmless while the only writer was `scripts/ingest.ts`,
 * which pulls the same public-records sources the live providers already use.
 *
 * It stops being harmless the moment anything else writes to the table.
 * `scripts/ingest-titlepro.ts` loads TitlePro247 farm-list exports, and whether
 * that licensed third-party data may be shown to anonymous consumers is an
 * open question. Without this list, ingesting it would publish it — silently,
 * on the next request, with no code change and no decision.
 *
 * So serving is opt-in per jurisdiction. These three are county public record,
 * already served live, and carry no redistribution restriction. Adding to this
 * list is the deliberate act that publishes a source.
 */
const PUBLIC_RECORD_JURISDICTIONS = ["dc", "fairfax", "maryland"] as const;

export interface PostgresOptions {
  /**
   * Restrict to sales the assessor marked arm's-length, where that is stated.
   * `arms_length IS NOT FALSE` rather than `IS TRUE`: NULL means "not
   * published", which is most jurisdictions, and excluding those would empty
   * the pool everywhere except DC.
   */
  qualifiedOnly?: boolean;
  /**
   * Which jurisdictions to read. Defaults to the public-record sources.
   * Overriding this is how a licensed source gets published, once someone has
   * established that it may be.
   */
  jurisdictions?: readonly string[];
}

export class PostgresProvider implements CompsProvider {
  readonly name = "postgres";

  constructor(private readonly opts: PostgresOptions = {}) {}

  async fetchCandidates(
    subject: SubjectProperty,
    opts: { radiusMiles: number; lookbackMonths: number; limit?: number }
  ): Promise<ComparableSale[]> {
    const { qualifiedOnly = true, jurisdictions = PUBLIC_RECORD_JURISDICTIONS } = this.opts;

    const rows = await query<SaleRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM sales
        WHERE ST_DWithin(location, ST_MakePoint($1, $2)::geography, $3)
          AND sold_date > (CURRENT_DATE - ($4 || ' months')::interval)
          AND jurisdiction = ANY($5)
          ${qualifiedOnly ? "AND arms_length IS NOT FALSE" : ""}
        ORDER BY sold_date DESC
        LIMIT $6`,
      [
        subject.location.lng,
        subject.location.lat,
        opts.radiusMiles * MILES_TO_METRES,
        opts.lookbackMonths,
        jurisdictions,
        Math.min(opts.limit ?? 200, 2000),
      ]
    );

    // null means no database configured; an empty array means no comps. The
    // caller must be able to tell those apart, so this returns [] and
    // `hasDatabase()` answers the other question.
    return (rows ?? []).map(toComp);
  }

  /**
   * Describe the subject from the nearest ingested sale.
   *
   * NOTE the limitation: this table holds properties that have SOLD. A home
   * that has not changed hands in the lookback window is not in it, so this
   * returns the nearest neighbour's characteristics rather than the subject's
   * own. That is good enough to select comps but wrong to publish as facts
   * about the subject, which is why the route treats a live-provider subject
   * lookup as preferable when one is available.
   */
  async lookupSubject(
    location: LatLng
  ): Promise<SubjectLookup | null> {
    // Same allow-list as fetchCandidates. This path publishes too — the
    // subject's living area and assessment are shown on the results screen —
    // so restricting only the comp search would leave the side door open.
    const { jurisdictions = PUBLIC_RECORD_JURISDICTIONS } = this.opts;

    const rows = await query<SaleRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM sales
        WHERE ST_DWithin(location, ST_MakePoint($1, $2)::geography, $3)
          AND property_type NOT IN ('other', 'land')
          AND jurisdiction = ANY($4)
        ORDER BY location <-> ST_MakePoint($1, $2)::geography
        LIMIT 1`,
      [location.lng, location.lat, 0.1 * MILES_TO_METRES, jurisdictions]
    );

    const r = rows?.[0];
    if (!r) return null;

    const comp = toComp(r);
    return {
      // NEVER exact. This table holds properties that have SOLD; a home that
      // has not changed hands in the window is simply not in it, so this is
      // the nearest neighbour's description. Fine for choosing comps, wrong to
      // show the homeowner as facts about their house.
      exactParcel: false,
      location,
      propertyType: comp.propertyType,
      assessedValue: comp.assessedValue,
      sqft: comp.sqft,
      lotSqft: comp.lotSqft,
      beds: comp.beds,
      baths: comp.baths,
      yearBuilt: comp.yearBuilt,
      condition: comp.condition,
      subdivision: comp.subdivision,
      zipCode: comp.zipCode,
      lastSalePrice: comp.soldPrice,
      lastSaleDate: comp.soldDate,
    };
  }
}

/** How stale is each jurisdiction's data? For /api/health. */
export async function ingestFreshness(): Promise<
  { jurisdiction: string; rows: number; newestSale: string | null; lastRunAt: string | null }[] | null
> {
  const rows = await query<{
    jurisdiction: string;
    rows: string;
    newest_sale: Date | null;
    last_run_at: Date | null;
  }>(
    `SELECT s.jurisdiction,
            COUNT(*)                AS rows,
            MAX(s.sold_date)        AS newest_sale,
            MAX(r.finished_at)      AS last_run_at
       FROM sales s
       LEFT JOIN ingest_runs r
         ON r.jurisdiction = s.jurisdiction AND r.ok
      GROUP BY s.jurisdiction
      ORDER BY s.jurisdiction`
  );

  return (
    rows?.map(r => ({
      jurisdiction: r.jurisdiction,
      rows: Number(r.rows),
      newestSale: r.newest_sale ? isoDate(r.newest_sale) : null,
      lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
    })) ?? null
  );
}
