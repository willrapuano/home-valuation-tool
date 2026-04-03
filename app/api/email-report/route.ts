import { NextRequest, NextResponse } from "next/server";

const BASE_URL = "https://home-valuation-tool.vercel.app";

function buildReportUrl(body: {
  address: { full: string; streetNumber: string; streetName: string; city: string; state: string; zipCode: string };
  estimate?: number;
  low?: number;
  high?: number;
  confidence?: string;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  yearBuilt?: number | null;
  rentZestimate?: number | null;
  pricePerSqft?: number | null;
  homeType?: string | null;
  fmr?: { studio: number; oneBr: number; twoBr: number; threeBr: number; fourBr: number };
  areaMedianIncome?: number | null;
}): string {
  const reportData = {
    address: body.address,
    valuation: {
      estimate: body.estimate,
      low: body.low,
      high: body.high,
      confidence: body.confidence ?? "medium",
      source: "Zillow AVM",
      beds: body.beds,
      baths: body.baths,
      sqft: body.sqft,
      yearBuilt: body.yearBuilt,
      rentZestimate: body.rentZestimate,
      pricePerSqft: body.pricePerSqft,
      homeType: body.homeType,
      fmr: body.fmr,
      areaMedianIncome: body.areaMedianIncome,
    },
  };
  const encoded = encodeURIComponent(Buffer.from(JSON.stringify(reportData)).toString("base64"));
  return `${BASE_URL}/report?d=${encoded}`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const {
    email,
    address,
    estimate,
    low,
    high,
    confidence,
    beds,
    baths,
    sqft,
    yearBuilt,
    rentZestimate,
    pricePerSqft,
    homeType,
    fmr,
    areaMedianIncome,
  } = body;

  if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

  // Build shareable report URL (base64 encoded — no backend storage needed)
  const addressObj = typeof address === "object" ? address : {
    full: address,
    streetNumber: "",
    streetName: address,
    city: "",
    state: "",
    zipCode: "",
  };

  const reportUrl = buildReportUrl({
    address: addressObj,
    estimate,
    low,
    high,
    confidence,
    beds,
    baths,
    sqft,
    yearBuilt,
    rentZestimate,
    pricePerSqft,
    homeType,
    fmr,
    areaMedianIncome,
  });

  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return NextResponse.json({ success: true, reportUrl, message: "No GHL key" });

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  try {
    // Search for existing contact
    const searchRes = await fetch(
      `https://rest.gohighlevel.com/v1/contacts/?email=${encodeURIComponent(email)}`,
      { headers }
    );
    const searchData = await searchRes.json();
    const contactId = searchData?.contacts?.[0]?.id;

    const addressFull = typeof address === "string" ? address : address?.full ?? "";
    const valueSummary = estimate
      ? `$${Number(estimate).toLocaleString()} (range: $${Number(low).toLocaleString()} – $${Number(high).toLocaleString()})`
      : "N/A";

    const noteBody = [
      `🏠 Home Valuation Report Requested`,
      ``,
      `Property: ${addressFull}`,
      `Estimated Value: ${valueSummary}`,
      beds ? `Beds: ${beds}` : null,
      baths ? `Baths: ${baths}` : null,
      sqft ? `Sqft: ${Number(sqft).toLocaleString()}` : null,
      yearBuilt ? `Year Built: ${yearBuilt}` : null,
      pricePerSqft ? `Price/Sqft: $${pricePerSqft}` : null,
      rentZestimate ? `Est. Rent: $${Number(rentZestimate).toLocaleString()}/mo` : null,
      ``,
      `📎 Shareable Report: ${reportUrl}`,
    ].filter(Boolean).join("\n");

    const customFieldPayload = {
      property_address: addressFull,
      estimated_value: valueSummary,
      report_url: reportUrl,
    };

    if (contactId) {
      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          tags: ["Home Valuation Lead", "Seller Lead", "Candee Currie - HVT", "HVT Email Report Requested"],
          customField: customFieldPayload,
        }),
      });

      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes/`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: noteBody }),
      }).catch(() => {});
    } else {
      await fetch("https://rest.gohighlevel.com/v1/contacts/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email,
          source: "Home Valuation Tool",
          tags: ["Home Valuation Lead", "Seller Lead", "Candee Currie - HVT", "HVT Email Report Requested"],
          customField: customFieldPayload,
        }),
      });
    }

    return NextResponse.json({ success: true, reportUrl });
  } catch (err) {
    console.error("email-report error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
