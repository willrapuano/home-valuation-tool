import { ComparableSale, LatLng, PropertyType } from "../types";

/**
 * TitlePro247 farm-list exports → comparable sales.
 *
 * WHY THIS IS A MAPPER AND NOT A PROVIDER
 *
 * Every other source here implements `CompsProvider` and is queried live.
 * TitlePro247 cannot be, for two reasons that are properties of the product
 * rather than of our code:
 *
 *   1. IT COSTS MONEY PER CALL. A search is a *farm list order*, billed by the
 *      list. `velocity-connectors` guards it with an explicit cost ceiling
 *      (TITLEPRO247_MAX_ORDER_COST_CENTS) for exactly that reason. One order
 *      per homeowner valuation is not a thing anyone would ship.
 *   2. IT IS NOT SYNCHRONOUS. An order is submitted, polled until the file is
 *      ready, downloaded as XLSX and parsed. That is minutes, not the 20s an
 *      API route has.
 *
 * So the flow is batch: `velocity-connectors` places the order (it owns the
 * credentials and the cost guard — neither is duplicated here), the export
 * lands as a file, and `scripts/ingest-titlepro.ts` runs it through this
 * mapper into the `sales` table. Valuations then read Postgres like any other
 * row. That is also why the datastore is a PREREQUISITE for TitlePro247
 * coverage rather than a latency optimisation.
 *
 * WHAT THIS UNLOCKS: Arlington and Loudoun. Both publish parcel geometry and
 * nothing else — no sale price, no assessed value — so they cannot be served
 * from public records at all. TitlePro247 carries both.
 *
 * ⚠️ LICENSING IS UNRESOLVED. Everything the tool publishes today is county
 * public record with no redistribution restriction. TitlePro247 is licensed to
 * a real-estate professional and it is NOT established that its data may be
 * shown to anonymous consumers on a public website. Nothing here is wired into
 * `/api/avm`'s COVERAGE list; ingesting is deliberately separable from serving
 * so that question can be answered before anything reaches a homeowner.
 */

/**
 * One row of a TitlePro247 export.
 *
 * Mirrors `TP247Property` in velocity-connectors — that repo owns the header
 * aliasing across the many names TitlePro247 uses for the same column, and
 * emits this shape. Kept structural rather than imported: the two apps do not
 * share a package, and this one must not pull in Supabase and `server-only`.
 */
export interface TP247Property {
  assessedValue?: number;
  baths?: number;
  beds?: number;
  detailedPropertyType?: string;
  lastSaleAmount?: number;
  lastSaleDate?: string;
  lotSize?: string;
  marketValue?: number;
  ownerType?: string;
  propertyType?: string;
  /** The PROPERTY's address. Not `mailing*`, which is where the owner gets post. */
  siteAddressLine1: string;
  siteCity: string;
  siteState: string;
  siteZip: string;
  sqft?: number;
  yearBuilt?: number;
}

/**
 * Below this, a recorded "sale" is a transfer and not a market transaction —
 * a quitclaim between spouses, a deed into a family trust, a $1 conveyance.
 * These carry real dates and real addresses, so nothing else screens them out,
 * and a $10 sale in the comp set drags an estimate down hard.
 */
const MIN_PLAUSIBLE_SALE = 15_000;

/**
 * TitlePro247's property-type strings are not documented and vary by county
 * data source, so this matches on keywords rather than exact values.
 *
 * Order matters: "single family condominium" exists in some feeds, and condo
 * is the more specific claim.
 */
const TYPE_KEYWORDS: [RegExp, PropertyType][] = [
  [/condo|co-?op|apartment unit/i, "condo"],
  [/town\s?(house|home)|row\s?house|patio home/i, "townhouse"],
  [/duplex|triplex|fourplex|quad|2-4|multi.?family|apartment/i, "multi_family"],
  [/vacant|unimproved|\bland\b|lot only/i, "land"],
  [/single.?family|\bsfr\b|detached|residential/i, "single_family"],
];

export function toPropertyType(raw: string | undefined): PropertyType {
  const s = (raw ?? "").trim();
  if (!s) return "other";
  for (const [re, type] of TYPE_KEYWORDS) if (re.test(s)) return type;
  // Deliberately NOT defaulting to single_family. An unrecognised type that
  // silently became a house would be scored against houses; "other" is
  // filtered out by the engine, and the ingest script reports the distribution
  // of unmapped strings so the first real export tells us what to add.
  return "other";
}

/**
 * Lot size arrives as free text: "10,890", "0.25 Acres", "0.25 AC", "10890 SF".
 * Returns square feet.
 */
export function parseLotSqft(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;

  if (/ac/i.test(raw)) return Math.round(n * 43_560);
  // No unit given. Acreage is written as a decimal and lots are rarely under
  // 1,000 sqft, so a small number is acres and a large one is already sqft.
  if (n < 100) return Math.round(n * 43_560);
  return Math.round(n);
}

/** Exports carry US-formatted dates; the engine and Postgres want ISO. */
export function parseSaleDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return undefined;
}

/**
 * A stable identifier for a property.
 *
 * The export carries no parcel number, and `sales` keys on
 * (jurisdiction, parcel_id, sold_date) to make re-ingest idempotent. The
 * normalised site address is the best available stand-in: stable across
 * exports, and unique within a jurisdiction.
 */
export function syntheticParcelId(p: TP247Property): string {
  return [p.siteAddressLine1, p.siteZip]
    .join(" ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function geocodeKeyFor(p: TP247Property): string {
  return syntheticParcelId(p);
}

export interface MappingReport {
  sales: ComparableSale[];
  /** Why rows were dropped, so an ingest never silently loses most of a file. */
  skipped: Record<string, number>;
  /** Property-type strings that fell through to "other", with counts. */
  unmappedTypes: Record<string, number>;
}

/**
 * Turn an export into comparable sales.
 *
 * A FARM LIST IS NOT A LIST OF SALES. It is a list of CURRENT OWNERS in a
 * radius, each carrying whatever their last transaction was — which for most
 * of them is years or decades ago. Filtering to a recent window is therefore
 * not an optimisation, it is the difference between comps and a mailing list.
 *
 * @param coords id → position, keyed by `geocodeKeyFor`. Rows without a
 * position are dropped: the engine scores on distance and cannot use them.
 * @param soldSince ISO date. Sales older than this are not comps.
 */
export function toComparableSales(
  rows: TP247Property[],
  coords: Map<string, LatLng>,
  soldSince: string
): MappingReport {
  const sales: ComparableSale[] = [];
  const skipped: Record<string, number> = {};
  const unmappedTypes: Record<string, number> = {};
  const bump = (r: Record<string, number>, k: string) => { r[k] = (r[k] ?? 0) + 1; };

  for (const p of rows) {
    if (!p.siteAddressLine1) { bump(skipped, "no_site_address"); continue; }

    const soldDate = parseSaleDate(p.lastSaleDate);
    if (!soldDate) { bump(skipped, "no_sale_date"); continue; }
    if (soldDate < soldSince) { bump(skipped, "sale_too_old"); continue; }

    const soldPrice = p.lastSaleAmount;
    if (!soldPrice || soldPrice < MIN_PLAUSIBLE_SALE) { bump(skipped, "nominal_or_no_price"); continue; }

    const propertyType = toPropertyType(p.propertyType || p.detailedPropertyType);
    if (propertyType === "other") {
      bump(skipped, "unmapped_property_type");
      bump(unmappedTypes, (p.propertyType || p.detailedPropertyType || "(blank)").trim());
      continue;
    }

    const key = geocodeKeyFor(p);
    const location = coords.get(key);
    if (!location) { bump(skipped, "not_geocoded"); continue; }

    sales.push({
      id: `${key}@${soldDate}`,
      address: p.siteAddressLine1,
      location,
      soldPrice,
      soldDate,
      propertyType,
      zipCode: p.siteZip || undefined,
      // TitlePro247 reports both; the assessment is the taxing authority's
      // figure and is what every other provider supplies, so prefer it.
      // marketValue is a vendor AVM — feeding another model's output in as
      // ground truth would make our estimate partly a copy of theirs.
      assessedValue: p.assessedValue && p.assessedValue > 0 ? p.assessedValue : undefined,
      sqft: p.sqft && p.sqft > 0 ? p.sqft : undefined,
      lotSqft: parseLotSqft(p.lotSize),
      beds: p.beds && p.beds > 0 ? p.beds : undefined,
      baths: p.baths && p.baths > 0 ? p.baths : undefined,
      yearBuilt: p.yearBuilt && p.yearBuilt > 1600 ? p.yearBuilt : undefined,
    });
  }

  return { sales, skipped, unmappedTypes };
}
