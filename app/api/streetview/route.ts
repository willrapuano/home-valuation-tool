import { NextRequest, NextResponse } from "next/server";

/**
 * Street View proxy.
 *
 * Exists so the Google Maps key stays server-side. Previously the key was
 * hardcoded into the client bundle and the <img> used referrerPolicy
 * "no-referrer", which meant the key could not be HTTP-referrer restricted
 * and was effectively open to anyone who viewed source.
 *
 * Also checks the metadata endpoint first so that addresses with no
 * panorama return 404 and the UI can show its own placeholder, rather than
 * Google's grey "no imagery here" tile.
 */

const SIZE = "800x400";
const TIMEOUT_MS = 6000;

async function fetchWithTimeout(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const location = req.nextUrl.searchParams.get("location");
  const key = process.env.GOOGLE_MAPS_API_KEY;

  if (!location) {
    return NextResponse.json({ error: "location required" }, { status: 400 });
  }
  if (!key) {
    console.warn("[streetview] GOOGLE_MAPS_API_KEY not configured");
    return NextResponse.json({ error: "not configured" }, { status: 404 });
  }

  const loc = encodeURIComponent(location);

  try {
    // Cheap (free) precheck — tells us whether imagery actually exists.
    const metaRes = await fetchWithTimeout(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&source=outdoor&key=${key}`
    );
    const meta = await metaRes.json().catch(() => ({}));

    if (meta?.status !== "OK") {
      if (meta?.status === "REQUEST_DENIED") {
        console.error(`[streetview] request denied: ${meta?.error_message ?? "unknown"}`);
      }
      return NextResponse.json({ error: "no imagery" }, { status: 404 });
    }

    const imgRes = await fetchWithTimeout(
      `https://maps.googleapis.com/maps/api/streetview?size=${SIZE}&location=${loc}&source=outdoor&key=${key}`
    );

    if (!imgRes.ok) {
      return NextResponse.json({ error: "upstream error" }, { status: 502 });
    }

    return new NextResponse(imgRes.body, {
      status: 200,
      headers: {
        "Content-Type": imgRes.headers.get("content-type") ?? "image/jpeg",
        // Street View imagery is refreshed on the order of years.
        "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    const reason = (err as Error)?.name === "AbortError" ? "timed out" : String(err);
    console.error(`[streetview] ${reason}`);
    return NextResponse.json({ error: "unavailable" }, { status: 504 });
  }
}
