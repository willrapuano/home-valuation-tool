import { NextRequest, NextResponse } from "next/server";

const ZENROWS_KEY = process.env.ZENROWS_API_KEY || "7ae266bf2cff31ae0eaa109f144982fb2ef9d30f";

const ZIP_ESTIMATES: Record<string, number> = {
  "22101": 1200000,"22102": 950000,"22103": 850000,"22151": 700000,"22152": 680000,
  "22153": 660000,"22201": 850000,"22202": 780000,"22203": 820000,"22204": 720000,
  "22205": 790000,"22206": 750000,"22207": 950000,"22209": 1100000,"22015": 620000,
  "22031": 750000,"22032": 680000,"22033": 700000,"22041": 650000,"22042": 620000,
  "22043": 750000,"22044": 620000,"22046": 900000,"22060": 680000,"20120": 580000,
  "20121": 560000,"20151": 600000,"20170": 750000,"20171": 720000,"20190": 680000,
  "20191": 650000,"20194": 700000,"20147": 580000,"20148": 560000,"20164": 520000,
  "20165": 540000,"20166": 500000,"20175": 580000,"20176": 560000,"20105": 650000,
};

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function zipFallback(zip: string) {
  const base = ZIP_ESTIMATES[zip] || 650000;
  return NextResponse.json({
    estimate: base, low: Math.floor(base * 0.96), high: Math.ceil(base * 1.04),
    confidence: "low", source: "estimate", comps: [],
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { address, zipCode, city, state } = body;

  if (!zipCode) return zipFallback("22015");

  // Build Zillow URL
  const slug = [address, city, state, zipCode].map(slugify).filter(Boolean).join("-");
  const zillowUrl = `https://www.zillow.com/homes/${slug}_rb/`;

  try {
    const zenUrl = `https://api.zenrows.com/v1/?apikey=${ZENROWS_KEY}&url=${encodeURIComponent(zillowUrl)}&js_render=true&premium_proxy=true&wait=5000`;

    const res = await fetch(zenUrl, { signal: AbortSignal.timeout(35000) });
    if (!res.ok) return zipFallback(zipCode);
    const html = await res.text();

    // Extract Zestimate
    const zestMatches = html.match(/[Zz]estimate[\s\S]{0,200}\$([\d,]+)/);
    if (!zestMatches) return zipFallback(zipCode);

    const zestimate = parseInt(zestMatches[1].replace(/,/g, ""));
    if (zestimate < 50000 || zestimate > 20000000) return zipFallback(zipCode);

    // Extract range
    let low = Math.floor(zestimate * 0.95);
    let high = Math.ceil(zestimate * 1.05);
    const rangeMatch = html.match(/\$([\d,]+)\s*[-–]\s*\$([\d,]+)/);
    if (rangeMatch) {
      const rLow = parseInt(rangeMatch[1].replace(/,/g, ""));
      const rHigh = parseInt(rangeMatch[2].replace(/,/g, ""));
      if (rLow > 50000 && rHigh > rLow) { low = rLow; high = rHigh; }
    }

    return NextResponse.json({
      estimate: zestimate, low, high,
      confidence: "high",
      source: "zillow",
      comps: [],
    });
  } catch (err) {
    console.error("Zillow scrape error:", err);
    return zipFallback(zipCode);
  }
}
