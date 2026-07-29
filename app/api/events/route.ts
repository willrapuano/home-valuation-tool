import { NextRequest, NextResponse } from "next/server";
import { RateLimiter, clientKey } from "@/lib/rate-limit";
import { counterKeys, sanitizeEvent, summarize, EVENT_NAMES } from "@/lib/analytics";
import { RestKv, getKv, hasSharedCache } from "@/lib/kv";

/**
 * Funnel events in, conversion summary out.
 *
 * POST records one event. GET returns the summary — see lib/analytics.ts for
 * what is recorded and, more importantly, what deliberately is not.
 */

// Roughly one event per funnel step, so this is generous for a real visitor
// and still uninteresting to anyone trying to inflate the numbers.
const limiter = new RateLimiter(30, 1);

export async function POST(req: NextRequest) {
  const rate = limiter.check(clientKey(req.headers));
  if (!rate.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const event = sanitizeEvent(await req.json().catch(() => null));
  if (!event) {
    // A bad event is not worth failing a homeowner's page over, but it should
    // not be silently counted either.
    return NextResponse.json({ ok: false, error: "invalid_event" }, { status: 400 });
  }

  // One structured line. This is the durable record: Vercel captures it and it
  // stays explorable in ways a counter never is.
  console.info(`[funnel] ${JSON.stringify({ ...event, at: new Date().toISOString() })}`);

  const kv = getKv();
  await Promise.all(
    counterKeys(event).map(key =>
      kv.incr(key).catch(err => {
        console.warn(`[funnel] counter failed for ${key}: ${(err as Error)?.message}`);
        return null;
      })
    )
  );

  // 204: the client has nothing to do with the response, and this must never
  // become something a page waits on.
  return new NextResponse(null, { status: 204 });
}

/**
 * Conversion summary.
 *
 * Returns `counted: false` when no shared store is configured rather than
 * serving per-instance numbers as if they were totals. A wrong total invites
 * a wrong decision; "we cannot count yet" invites the right one.
 */
export async function GET() {
  if (!hasSharedCache()) {
    return NextResponse.json(
      {
        counted: false,
        reason:
          "No shared store is configured, so counters only see one serverless " +
          "instance and cannot be totalled. Events are still written to the logs — " +
          "search for [funnel]. Set KV_REST_API_* or UPSTASH_REDIS_REST_* to enable counting.",
        events: EVENT_NAMES,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const shared = getKv().shared as RestKv;
  const keys = [
    ...EVENT_NAMES.map(n => `ev:${n}`),
    ...EVENT_NAMES.flatMap(n => [`ev:${n}:with_estimate`, `ev:${n}:without_estimate`]),
  ];

  try {
    const counts = await shared.mget(keys);
    return NextResponse.json(
      { counted: true, ...summarize(counts) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { counted: false, reason: `Counter read failed: ${(err as Error)?.message}` },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
