import { NextRequest, NextResponse } from "next/server";

const VALUATION_API_URL = process.env.VALUATION_API_URL || "https://wells-cross-affiliate-almost.trycloudflare.com";
const VALUATION_API_KEY = "valuation-api-key-2026";

const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "AIzaSyC-JJ1EHFKypH-RMQaemYKSp2ZrXoGVcP8";

const NOVA_FMR = { studio: 2050, oneBr: 2080, twoBr: 2370, threeBr: 2960, fourBr: 3540 };

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

function buildStreetViewUrl(address: string): string {
  return `https://maps.googleapis.com/maps/api/streetview?size=800x400&location=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_KEY}`;
}

async function fetchCensusAMI(zip: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.census.gov/data/2022/acs/acs5?get=B19013_001E&for=zip+code+tabulation+area:${zip}&key=DEMO_KEY`
    );
    const data = await res.json();
    const income = parseInt(data?.[1]?.[0]);
    return income > 0 ? income : null;
  } catch { return null; }
}

function zipFallback(zip: string, address: string, areaMedianIncome: number | null) {
  const base = ZIP_ESTIMATES[zip] || 650000;
  return NextResponse.json({
    estimate: base, low: Math.floor(base * 0.96), high: Math.ceil(base * 1.04),
    confidence: "low", source: "estimate", comps: [],
    streetViewUrl: buildStreetViewUrl(address),
    fmr: NOVA_FMR,
    areaMedianIncome,
    pricePerSqft: null, rentZestimate: null,
    beds: null, baths: null, sqft: null, yearBuilt: null, homeType: null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { address, zipCode, city, state, fullAddress: passedFullAddress } = body;

  if (!zipCode) return zipFallback("22015", address || "", null);

  const fullAddress = passedFullAddress || [address, city, state, zipCode].filter(Boolean).join(", ");
  const streetViewUrl = buildStreetViewUrl(fullAddress);
  const amiPromise = fetchCensusAMI(zipCode);

  try {
    const streetOnly = (address || "").split(",")[0].trim();
    
    const res = await fetch(`${VALUATION_API_URL}/api/valuation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": VALUATION_API_KEY,
      },
      body: JSON.stringify({
        address: streetOnly || address,
        city: city || "",
        state: state || "VA",
        zip: zipCode,
      }),
    });

    const areaMedianIncome = await amiPromise;

    if (!res.ok) {
      console.error("Mac Mini API error:", res.status);
      return zipFallback(zipCode, fullAddress, areaMedianIncome);
    }

    const data = await res.json();

    if (data.source === "estimate" || !data.average) {
      return zipFallback(zipCode, fullAddress, areaMedianIncome);
    }

    return NextResponse.json({
      estimate: data.average,
      low: data.low,
      high: data.high,
      confidence: "high",
      source: "zillow",
      comps: [],
      streetViewUrl,
      fmr: NOVA_FMR,
      areaMedianIncome,
      pricePerSqft: data.pricePerSqft || null,
      rentZestimate: data.rentZestimate || null,
      beds: data.beds || null,
      baths: data.baths || null,
      sqft: data.sqft || null,
      yearBuilt: data.yearBuilt || null,
      homeType: data.homeType || null,
    });

  } catch (err) {
    console.error("AVM route error:", err);
    const areaMedianIncome = await amiPromise;
    return zipFallback(zipCode, fullAddress, areaMedianIncome);
  }
}

export const maxDuration = 60;
