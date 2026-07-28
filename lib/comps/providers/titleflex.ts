import { ComparableSale, CompsProvider, PropertyType, SubjectProperty } from "../types";

/**
 * DataTrace TitleFlex comps provider.
 *
 * ⚠️  THE FIELD MAPPING BELOW IS PROVISIONAL.
 *
 * It was written from TitleFlex's public product descriptions, not from their
 * API specification — titleflex.com returned 403 to automated fetches, so the
 * exact response shape is unverified. Everything that depends on their naming
 * is isolated into `FIELD_ALIASES` and `mapRecord()` so correcting it means
 * editing one constant, not rewriting the provider.
 *
 * Each field lists several candidate names and takes the first that is
 * present, so there is a reasonable chance this works unmodified. Do not
 * assume it does — run `describeResponse()` against a real payload first and
 * reconcile the reported keys against the aliases.
 *
 * Two things still need confirming with DataTrace before this goes live:
 *   1. Which endpoint returns nearby CLOSED SALES for a radius + date window.
 *      If there is no such endpoint, comps have to be assembled from a
 *      geographic search plus per-property sale history, which is a different
 *      and much chattier shape than what is written here.
 *   2. Whether the licence permits displaying this data to anonymous
 *      consumers on a public website. See README.
 */

export interface TitleFlexConfig {
  baseUrl: string;
  apiKey: string;
  /** Header carrying the key. Commonly "Authorization" or "X-API-Key". */
  authHeader: string;
  /** Scheme prefix, e.g. "Bearer". Empty string sends the raw key. */
  authScheme: string;
  /** Path of the nearby-sales search, relative to baseUrl. */
  searchPath: string;
  timeoutMs: number;
}

const DEFAULTS = {
  authHeader: "Authorization",
  authScheme: "Bearer",
  searchPath: "/property/sales/search",
  timeoutMs: 8000,
};

/**
 * Build config from the environment. Returns null when unconfigured so the
 * caller can degrade rather than throw — an unset key is a deployment state,
 * not an error.
 */
export function titleFlexConfigFromEnv(): TitleFlexConfig | null {
  const apiKey = process.env.TITLEFLEX_API_KEY;
  const baseUrl = process.env.TITLEFLEX_API_URL;
  if (!apiKey || !baseUrl) return null;

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    authHeader: process.env.TITLEFLEX_AUTH_HEADER || DEFAULTS.authHeader,
    // Allow an explicitly empty scheme for raw-key headers like X-API-Key.
    authScheme:
      process.env.TITLEFLEX_AUTH_SCHEME === undefined
        ? DEFAULTS.authScheme
        : process.env.TITLEFLEX_AUTH_SCHEME,
    searchPath: process.env.TITLEFLEX_SEARCH_PATH || DEFAULTS.searchPath,
    timeoutMs: Number(process.env.TITLEFLEX_TIMEOUT_MS) || DEFAULTS.timeoutMs,
  };
}

export class TitleFlexError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TitleFlexError";
  }
}

/* ── Field mapping (PROVISIONAL — see file header) ─────────────── */

type Raw = Record<string, unknown>;

/**
 * Candidate field names, tried in order. Add the real name to the front of
 * the relevant array once the API spec is in hand.
 */
export const FIELD_ALIASES = {
  id: ["propertyId", "PropertyID", "fips_apn", "apn", "id"],
  address: ["situsAddress", "SitusFullAddress", "propertyAddress", "address", "fullAddress"],
  soldPrice: ["saleAmount", "SaleAmount", "lastSalePrice", "salePrice", "transferAmount"],
  soldDate: ["saleDate", "SaleDate", "lastSaleDate", "recordingDate", "transferDate"],
  sqft: ["livingSquareFeet", "LivingSqFt", "buildingArea", "sqft", "livingArea"],
  lotSqft: ["lotSquareFeet", "LotSqFt", "lotSize", "landSquareFootage"],
  beds: ["bedrooms", "Bedrooms", "bedroomCount", "beds"],
  baths: ["bathrooms", "totalBathrooms", "Bathrooms", "bathCount", "baths"],
  yearBuilt: ["yearBuilt", "YearBuilt", "effectiveYearBuilt"],
  lat: ["latitude", "Latitude", "lat"],
  lng: ["longitude", "Longitude", "lng", "lon"],
  propertyType: ["propertyType", "PropertyType", "landUse", "useCode", "propertyUseGroup"],
  subdivision: ["subdivisionName", "Subdivision", "subdivision", "legalSubdivision"],
  zipCode: ["situsZip", "zipCode", "postalCode", "zip"],
} as const;

/** Records may be nested under any of these keys, or returned as a bare array. */
const RESULT_CONTAINERS = ["results", "data", "properties", "records", "items", "sales"];

function pick(raw: Raw, aliases: readonly string[]): unknown {
  for (const key of aliases) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    // Tolerate "1,250,000" and "$1250000".
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalise an ISO-ish or US-format date to YYYY-MM-DD. */
export function normalizeDate(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

/**
 * Map a vendor land-use / property-type value onto our union. Public-record
 * use codes vary by county, so this matches on substrings rather than exact
 * values and falls back to "other" (which the engine treats as comparable
 * only to itself, so an unmapped code is excluded rather than silently
 * treated as a house).
 */
export function normalizePropertyType(value: unknown): PropertyType {
  const s = str(value)?.toLowerCase();
  if (!s) return "other";
  if (/\b(condo|condominium)\b/.test(s)) return "condo";
  if (/(townhouse|townhome|row house|attached)/.test(s)) return "townhouse";
  if (/(duplex|triplex|fourplex|multi[- ]?family|apartment)/.test(s)) return "multi_family";
  if (/(vacant|land|lot)/.test(s)) return "land";
  if (/(single|sfr|detached|residential)/.test(s)) return "single_family";
  return "other";
}

/** Convert one vendor record into a ComparableSale, or null if unusable. */
export function mapRecord(raw: Raw): ComparableSale | null {
  const soldPrice = num(pick(raw, FIELD_ALIASES.soldPrice));
  const soldDate = normalizeDate(pick(raw, FIELD_ALIASES.soldDate));
  const lat = num(pick(raw, FIELD_ALIASES.lat));
  const lng = num(pick(raw, FIELD_ALIASES.lng));

  // Without price, date and position a record cannot function as a comp.
  if (!soldPrice || soldPrice <= 0 || !soldDate || lat === undefined || lng === undefined) {
    return null;
  }

  const id =
    str(pick(raw, FIELD_ALIASES.id)) ??
    `${lat.toFixed(5)},${lng.toFixed(5)}@${soldDate}`;

  return {
    id,
    address: str(pick(raw, FIELD_ALIASES.address)) ?? "Unknown address",
    location: { lat, lng },
    propertyType: normalizePropertyType(pick(raw, FIELD_ALIASES.propertyType)),
    soldPrice,
    soldDate,
    sqft: num(pick(raw, FIELD_ALIASES.sqft)),
    lotSqft: num(pick(raw, FIELD_ALIASES.lotSqft)),
    beds: num(pick(raw, FIELD_ALIASES.beds)),
    baths: num(pick(raw, FIELD_ALIASES.baths)),
    yearBuilt: num(pick(raw, FIELD_ALIASES.yearBuilt)),
    subdivision: str(pick(raw, FIELD_ALIASES.subdivision)),
    zipCode: str(pick(raw, FIELD_ALIASES.zipCode)),
    // Public record carries no interior condition. The engine drops null
    // dimensions from the weighted average rather than penalising the comp.
    condition: undefined,
  };
}

/** Locate the record array in a response of unknown shape. */
export function extractRecords(payload: unknown): Raw[] {
  if (Array.isArray(payload)) return payload as Raw[];
  if (!payload || typeof payload !== "object") return [];

  const obj = payload as Raw;
  for (const key of RESULT_CONTAINERS) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Raw[];
    // One level of nesting, e.g. { data: { results: [...] } }
    if (value && typeof value === "object") {
      for (const inner of RESULT_CONTAINERS) {
        const nested = (value as Raw)[inner];
        if (Array.isArray(nested)) return nested as Raw[];
      }
    }
  }
  return [];
}

/**
 * Diagnostic helper for reconciling the mapping against a real payload.
 * Reports which of our fields resolved and what keys were left over, so the
 * aliases can be corrected without guesswork.
 */
export function describeResponse(payload: unknown): {
  recordCount: number;
  resolved: Record<string, string | null>;
  unmappedKeys: string[];
} {
  const records = extractRecords(payload);
  const sample = records[0] ?? {};
  const resolved: Record<string, string | null> = {};
  const consumed = new Set<string>();

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const hit = (aliases as readonly string[]).find(
      k => sample[k] !== undefined && sample[k] !== null && sample[k] !== ""
    );
    resolved[field] = hit ?? null;
    if (hit) consumed.add(hit);
  }

  return {
    recordCount: records.length,
    resolved,
    unmappedKeys: Object.keys(sample).filter(k => !consumed.has(k)),
  };
}

/* ── Provider ──────────────────────────────────────────────────── */

export class TitleFlexProvider implements CompsProvider {
  readonly name = "titleflex";

  constructor(private readonly config: TitleFlexConfig) {}

  /** Convenience factory; returns null when the environment is unconfigured. */
  static fromEnv(): TitleFlexProvider | null {
    const config = titleFlexConfigFromEnv();
    return config ? new TitleFlexProvider(config) : null;
  }

  async fetchCandidates(
    subject: SubjectProperty,
    opts: { radiusMiles: number; lookbackMonths: number; limit?: number }
  ): Promise<ComparableSale[]> {
    const since = new Date();
    since.setMonth(since.getMonth() - opts.lookbackMonths);

    const body = {
      latitude: subject.location.lat,
      longitude: subject.location.lng,
      radiusMiles: opts.radiusMiles,
      soldSince: since.toISOString().slice(0, 10),
      limit: opts.limit ?? 50,
      ...(subject.zipCode ? { zipCode: subject.zipCode } : {}),
    };

    const payload = await this.post(this.config.searchPath, body);
    return extractRecords(payload)
      .map(mapRecord)
      .filter((c): c is ComparableSale => c !== null);
  }

  /** Exposed so a real payload can be inspected without running a valuation. */
  async describe(subject: SubjectProperty): Promise<ReturnType<typeof describeResponse>> {
    const payload = await this.post(this.config.searchPath, {
      latitude: subject.location.lat,
      longitude: subject.location.lng,
      radiusMiles: 1,
      limit: 5,
    });
    return describeResponse(payload);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const authValue = this.config.authScheme
      ? `${this.config.authScheme} ${this.config.apiKey}`
      : this.config.apiKey;

    try {
      const res = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          [this.config.authHeader]: authValue,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Never echo the response body — vendor errors can restate the
        // credential that was sent.
        throw new TitleFlexError(`TitleFlex returned HTTP ${res.status}`, res.status);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof TitleFlexError) throw err;
      if ((err as Error)?.name === "AbortError") {
        throw new TitleFlexError(`TitleFlex request timed out after ${this.config.timeoutMs}ms`);
      }
      throw new TitleFlexError(`TitleFlex request failed: ${(err as Error)?.message ?? "unknown"}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
