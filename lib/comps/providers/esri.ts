/**
 * Shared ArcGIS REST query, with hedging to control tail latency.
 *
 * WHY THIS EXISTS
 *
 * All three public-records providers talk to ArcGIS services, and all three
 * had independently grown the same query function — POST rather than GET,
 * JSON-or-HTML detection, abort on timeout. Measured against production
 * (`scripts/latency-probe.ts`), they had also grown the same latency problem:
 *
 *     dc         p50  3.46s   p90 14.56s
 *     fairfax    p50  4.44s   p90 14.81s
 *     maryland   p50  1.44s   p90  2.66s
 *
 * The median is fine. The tail is not: roughly one homeowner in ten waited
 * fifteen seconds. The cause was not a slow service but a *serial retry* — an
 * 8s timeout followed by a second attempt, so any request that stalled cost
 * 8 seconds before the retry that actually answered had even started.
 *
 * HEDGING
 *
 * Rather than waiting for the timeout to expire before trying again, a second
 * request is fired once the first has merely taken longer than expected, and
 * whichever answers first wins. This is the standard fix for tail latency in
 * request-response systems (Dean & Barroso, "The Tail at Scale"): these
 * services are usually fast, and a stalled request is far more likely to stay
 * stalled than to be about to finish.
 *
 * The cost is a modest number of duplicate reads against a public GIS service,
 * and only for requests that are already slow — the hedge never fires on the
 * common fast path. A slow-but-succeeding query is no longer abandoned either,
 * because the original attempt stays in the race.
 */

export interface EsriFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number; rings?: number[][][] };
}

/**
 * A failure the service will reproduce on retry — a malformed WHERE clause, an
 * unknown field. Hedging these wastes a request and delays the error.
 */
export class EsriPermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "EsriPermanentError";
  }
}

export function isPermanent(err: unknown): boolean {
  return (err as { permanent?: boolean } | null)?.permanent === true;
}

export interface EsriQueryOptions {
  url: string;
  params: Record<string, string>;
  /** Hard ceiling on a single attempt. */
  timeoutMs: number;
  /**
   * Start a second attempt once the first has taken this long. Omit to disable
   * hedging. Should sit above the normal response time and well below
   * `timeoutMs`, so it fires on stalls but not on ordinary requests.
   */
  hedgeAfterMs?: number;
  /** Service name for error messages, e.g. "Maryland iMAP". */
  label: string;
}

async function attempt(opts: EsriQueryOptions): Promise<EsriFeature[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ f: "json", ...opts.params }).toString(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${opts.label} returned HTTP ${res.status}`);

    // A malformed or over-long request comes back as an HTML error page with a
    // 200 status, so the body has to be inspected rather than trusted.
    const text = await res.text();
    let data: { error?: { message?: string }; features?: EsriFeature[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${opts.label} returned a non-JSON response`);
    }
    if (data?.error) {
      throw new EsriPermanentError(`${opts.label} error: ${data.error.message ?? "unknown"}`);
    }
    return data?.features ?? [];
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error(`${opts.label} request timed out after ${opts.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Marker resolved by the hedge timer, distinguishable from a features array. */
const HEDGE = Symbol("hedge");

export async function esriQuery(opts: EsriQueryOptions): Promise<EsriFeature[]> {
  const first = attempt(opts);

  if (!opts.hedgeAfterMs) return first;

  // Wrap so a rejection does not escape before we are ready to handle it.
  const firstSettled = first.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  );

  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const hedgeSignal = new Promise<typeof HEDGE>(resolve => {
    hedgeTimer = setTimeout(() => resolve(HEDGE), opts.hedgeAfterMs);
  });

  const winner = await Promise.race([firstSettled, hedgeSignal]);
  clearTimeout(hedgeTimer);

  if (winner !== HEDGE) {
    if (winner.ok) return winner.value;
    // Failed faster than the hedge delay. A permanent error will repeat, so
    // surface it; anything else is worth one more try.
    if (isPermanent(winner.error)) throw winner.error;
    return attempt(opts);
  }

  // Still running. Race a second attempt against it and take the first answer.
  try {
    return await Promise.any([first, attempt(opts)]);
  } catch (err) {
    // Both failed. AggregateError hides the useful message; unwrap it.
    const errors = (err as AggregateError)?.errors;
    throw Array.isArray(errors) && errors.length ? errors[0] : err;
  }
}
