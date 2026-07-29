/**
 * Funnel instrumentation.
 *
 * THE QUESTION THIS EXISTS TO ANSWER
 *
 * The lead gate sits at step 3, before the homeowner sees anything, and its
 * headline already forks on whether we produced an estimate:
 *
 *   "Your estimate is ready!"   when we have a number
 *   "One last step"             when we do not
 *
 * Nobody knows which converts better. That matters more since low-confidence
 * estimates stopped being published (lib/comps/publish.ts) — roughly 10% of
 * valuations moved from the first path to the second, and the case for that
 * change rests on an assumption that the CMA offer converts at least as well
 * as a number we do not trust. This measures it instead of assuming it.
 *
 * WHAT IS DELIBERATELY NOT RECORDED
 *
 * No email, no name, no street address. A homeowner asking what their house is
 * worth has not agreed to be catalogued, and none of those fields are needed to
 * answer the question above. What is kept is the coarse geography (ZIP), which
 * jurisdiction served the valuation, and how the valuation turned out. The
 * session id is random per visit and tied to nothing.
 *
 * WHERE IT GOES
 *
 * Every event is written as one structured JSON line, which Vercel captures and
 * makes searchable — that is the durable record today. Counters are also kept
 * in the shared store when one is configured; without it they are per-instance
 * and therefore useless for totals, which /api/events reports honestly rather
 * than quietly returning a wrong number.
 */

export const EVENT_NAMES = [
  /** Address accepted, valuation started. Denominator for everything below. */
  "address_submitted",
  /** Valuation finished, lead gate shown. Carries how it turned out. */
  "valuation_returned",
  /** Email captured. The conversion. */
  "lead_submitted",
  /** Report screen reached. */
  "report_viewed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface FunnelEvent {
  name: EventName;
  /** Random per visit, so a journey can be stitched. Not tied to identity. */
  sessionId: string;
  /** Coarse geography only. */
  zipCode?: string;
  /** Which public-records source served it, when one did. */
  jurisdiction?: string;
  /** Whether a number was actually shown. The fork we care about. */
  hasEstimate?: boolean;
  confidence?: string;
  /** "low_confidence" or "no_data" when nothing was published. */
  degradedCode?: string;
}

const NAME_SET = new Set<string>(EVENT_NAMES);

/** Bound every field so a malformed or hostile payload cannot bloat the logs. */
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * Validate and strip an incoming event.
 *
 * Allow-list, not deny-list: anything not named here is dropped. A deny-list
 * would eventually let a full address through because someone added a field
 * upstream, and this endpoint is public.
 */
export function sanitizeEvent(input: unknown): FunnelEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const name = clip(raw.name, 32);
  if (!name || !NAME_SET.has(name)) return null;

  const sessionId = clip(raw.sessionId, 64);
  if (!sessionId) return null;

  // Digits only, first five. A ZIP+4 is more identifying than we need.
  const zip = clip(raw.zipCode, 10)?.replace(/\D/g, "").slice(0, 5);

  return {
    name: name as EventName,
    sessionId,
    zipCode: zip && zip.length === 5 ? zip : undefined,
    jurisdiction: clip(raw.jurisdiction, 24),
    hasEstimate: typeof raw.hasEstimate === "boolean" ? raw.hasEstimate : undefined,
    confidence: clip(raw.confidence, 16),
    degradedCode: clip(raw.degradedCode, 24),
  };
}

/**
 * Counter keys for one event.
 *
 * Deliberately few and coarse. The conversion question needs the funnel split
 * by whether a number was shown; everything finer is better answered from the
 * logs than from counters that cannot be reset or explored.
 */
export function counterKeys(event: FunnelEvent): string[] {
  const keys = [`ev:${event.name}`];
  if (event.hasEstimate !== undefined) {
    keys.push(`ev:${event.name}:${event.hasEstimate ? "with_estimate" : "without_estimate"}`);
  }
  if (event.jurisdiction) keys.push(`ev:${event.name}:j:${event.jurisdiction}`);
  return keys;
}

/**
 * Conversion rates from raw counters.
 *
 * The headline is `lead_submitted / valuation_returned` split by whether a
 * number was shown — if the two are close, withholding low-confidence
 * estimates costs nothing; if the no-number path converts materially worse,
 * that is a real argument for revisiting the threshold.
 */
export function summarize(counts: Record<string, number>) {
  const n = (k: string) => counts[k] ?? 0;
  const rate = (num: number, den: number) => (den > 0 ? Number((num / den).toFixed(4)) : null);

  const valuations = n("ev:valuation_returned");
  const withEstimate = n("ev:valuation_returned:with_estimate");
  const withoutEstimate = n("ev:valuation_returned:without_estimate");

  return {
    totals: {
      addressSubmitted: n("ev:address_submitted"),
      valuationReturned: valuations,
      leadSubmitted: n("ev:lead_submitted"),
      reportViewed: n("ev:report_viewed"),
    },
    conversion: {
      /** The number that decides whether the publish threshold is right. */
      overall: rate(n("ev:lead_submitted"), valuations),
      withEstimate: rate(n("ev:lead_submitted:with_estimate"), withEstimate),
      withoutEstimate: rate(n("ev:lead_submitted:without_estimate"), withoutEstimate),
    },
    valuationOutcome: {
      withEstimate,
      withoutEstimate,
      shareWithEstimate: rate(withEstimate, valuations),
    },
  };
}
