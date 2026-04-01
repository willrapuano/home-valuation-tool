import { NextRequest, NextResponse } from "next/server";

const ZENROWS_KEY = process.env.ZENROWS_API_KEY || "7ae266bf2cff31ae0eaa109f144982fb2ef9d30f";
const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "AIzaSyC-JJ1EHFKypH-RMQaemYKSp2ZrXoGVcP8";

// Hardcoded 2025 HUD FMR values for DC-VA-MD metro area (NoVA / Fairfax County)
const NOVA_FMR = {
  studio: 2050,
  oneBr: 2080,
  twoBr: 2370,
  threeBr: 2960,
  fourBr: 3540,
};

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

async function fetchCensusAMI(zip: string): Promise<number | null> {
  try {
    const url = `https://api.census.gov/data/2022/acs/acs5?get=B19013_001E&for=zip+code+tabulation+area:${zip}&key=DEMO_KEY`;
    const res = await fetch(url, {});
    if (!res.ok) return null;
    const data = await res.json();
    // Response format: [["B19013_001E","zip code tabulation area"], ["75000", "22101"]]
    if (Array.isArray(data) && data.length > 1 && data[1][0]) {
      const income = parseInt(data[1][0]);
      if (!isNaN(income) && income > 0) return income;
    }
    return null;
  } catch {
    return null;
  }
}

function buildStreetViewUrl(address: string): string {
  const encoded = encodeURIComponent(address);
  return `https://maps.googleapis.com/maps/api/streetview?size=800x400&location=${encoded}&key=${GOOGLE_MAPS_KEY}`;
}

function zipFallback(zip: string, address: string, areaMedianIncome: number | null) {
  const base = ZIP_ESTIMATES[zip] || 650000;
  const streetViewUrl = buildStreetViewUrl(address);
  return NextResponse.json({
    estimate: base,
    low: Math.floor(base * 0.96),
    high: Math.ceil(base * 1.04),
    confidence: "low",
    source: "estimate",
    comps: [],
    streetViewUrl,
    fmr: NOVA_FMR,
    areaMedianIncome,
    pricePerSqft: null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { address, zipCode, city, state, fullAddress: passedFullAddress } = body;

  if (!zipCode) return zipFallback("22015", address || "", null);

  // Fetch Census AMI in parallel with Zillow scrape
  const amiPromise = fetchCensusAMI(zipCode);

  const fullAddress = passedFullAddress || [address, city, state, zipCode].filter(Boolean).join(", ");
  const streetViewUrl = buildStreetViewUrl(fullAddress);

  // Build Zillow URL — use street only (not full address) to avoid double city/state in slug
  const streetOnly = (address || "").split(",")[0].trim();
  const slug = [streetOnly || address, city, state, zipCode].map(slugify).filter(Boolean).join("-");
  const zillowUrl = `https://www.zillow.com/homes/${slug}_rb/`;

  let areaMedianIncome: number | null = null;

  try {
    const zenUrl = `https://api.zenrows.com/v1/?apikey=${ZENROWS_KEY}&url=${encodeURIComponent(zillowUrl)}&js_render=true&premium_proxy=true&wait=5000`;

    const [res] = await Promise.all([
      fetch(zenUrl),
    ]);

    areaMedianIncome = await amiPromise;

    if (!res.ok) return zipFallback(zipCode, fullAddress, areaMedianIncome);
    const html = await res.text();

    // Extract Zestimate
    const zestMatches = html.match(/[Zz]estimate[\s\S]{0,200}\$([\d,]+)/);
    if (!zestMatches) return zipFallback(zipCode, fullAddress, areaMedianIncome);

    const zestimate = parseInt(zestMatches[1].replace(/,/g, ""));
    if (zestimate < 50000 || zestimate > 20000000) return zipFallback(zipCode, fullAddress, areaMedianIncome);

    // Extract range
    let low = Math.floor(zestimate * 0.95);
    let high = Math.ceil(zestimate * 1.05);
    const rangeMatch = html.match(/\$([\d,]+)\s*[-–]\s*\$([\d,]+)/);
    if (rangeMatch) {
      const rLow = parseInt(rangeMatch[1].replace(/,/g, ""));
      const rHigh = parseInt(rangeMatch[2].replace(/,/g, ""));
      if (rLow > 50000 && rHigh > rLow) { low = rLow; high = rHigh; }
    }

    // Extract beds/baths/sqft
    let beds: number | null = null;
    let baths: number | null = null;
    let sqftVal: number | null = null;
    let pricePerSqft: number | null = null;

    const bedsMatch = html.match(/(\d)\s*(?:bds?|beds?)\b/i);
    if (bedsMatch) beds = parseInt(bedsMatch[1]);

    const bathsMatch = html.match(/([\d.]+)\s*(?:bas?|baths?)\b/i);
    if (bathsMatch) baths = parseFloat(bathsMatch[1]);

    const sqftMatch = html.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/i);
    if (sqftMatch) {
      sqftVal = parseInt(sqftMatch[1].replace(/,/g, ""));
      if (sqftVal > 200 && sqftVal < 20000) pricePerSqft = Math.round(zestimate / sqftVal);
      else sqftVal = null;
    }

    // Year built + home type
    const yrMatch = html.match(/(?:Built in|Year built)[:\s]+(\d{4})/i);
    const yearBuilt = yrMatch ? parseInt(yrMatch[1]) : null;

    const typeMatch = html.match(/(?:home type|property type)[:\s]+"?([^"<\n,]{3,30})"?/i);
    const homeType = typeMatch ? typeMatch[1].trim() : null;

    // Rent Zestimate
    let rentZestimate: number | null = null;
    const rentMatches = html.match(/[Rr]ent\s*[Zz]estimate[\s\S]{0,100}\$([\d,]+)/);
    if (rentMatches) {
      const rent = parseInt(rentMatches[1].replace(/,/g, ""));
      if (rent > 500 && rent < 20000) rentZestimate = rent;
    }
    if (!rentZestimate) {
      const rentMoMatch = html.match(/\$([\d,]+)\/mo/);
      if (rentMoMatch) {
        const rent = parseInt(rentMoMatch[1].replace(/,/g, ""));
        if (rent > 500 && rent < 20000) rentZestimate = rent;
      }
    }

    return NextResponse.json({
      estimate: zestimate,
      low,
      high,
      confidence: "high",
      source: "zillow",
      comps: [],
      streetViewUrl,
      fmr: NOVA_FMR,
      areaMedianIncome,
      pricePerSqft,
      rentZestimate,
      beds,
      baths,
      sqft: sqftVal,
      yearBuilt,
      homeType,
    });
  } catch (err) {
    console.error("Zillow scrape error:", err);
    areaMedianIncome = await amiPromise;
    return zipFallback(zipCode, fullAddress, areaMedianIncome);
  }
}

export const maxDuration = 60;
