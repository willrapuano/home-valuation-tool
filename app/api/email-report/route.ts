import { NextRequest, NextResponse } from "next/server";
import { encodeReportUrl, ReportAddress, ReportComp } from "@/lib/report-payload";

/**
 * Where report links point.
 *
 * VERCEL_URL is the DEPLOYMENT-specific hostname — in production it produced
 * links reading `home-valuation-tool-n5ew7irgi-will-rapuanos-projects.
 * vercel.app`, which is exactly what a phishing link looks like in an email a
 * homeowner was not expecting, and which stops resolving if that deployment is
 * ever removed or rolled back.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is the project's stable production domain and
 * is set automatically alongside it, so it is preferred. NEXT_PUBLIC_BASE_URL
 * still wins over both, for a custom domain.
 */
const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://home-valuation-tool.vercel.app");

function buildReportUrl(body: {
  address: ReportAddress;
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
  source?: string;
  sourceJurisdiction?: string;
  degraded?: boolean;
  degradedReason?: string;
  comps?: ReportComp[];
}): string {
  return encodeReportUrl(BASE_URL, {
    address: body.address,
    valuation: {
      estimate: body.estimate,
      low: body.low,
      high: body.high,
      confidence: body.confidence ?? "medium",
      // Carry the real provenance through — this used to be hardcoded, so a
      // ZIP-average fallback was labelled as a property-level AVM in the report.
      source: body.source ?? "estimate",
      // Which county served it, so the report can state the measured error band
      // for the right jurisdiction rather than the pooled one.
      sourceJurisdiction: body.sourceJurisdiction,
      degraded: body.degraded ?? false,
      degradedReason: body.degradedReason,
      beds: body.beds,
      baths: body.baths,
      sqft: body.sqft,
      yearBuilt: body.yearBuilt,
      rentZestimate: body.rentZestimate,
      pricePerSqft: body.pricePerSqft,
      homeType: body.homeType,
      fmr: body.fmr,
      areaMedianIncome: body.areaMedianIncome,
      // The sales behind the number. Shown on the results screen since #8; the
      // shareable report was still saying "based on 6 sales" without naming one.
      comps: Array.isArray(body.comps) ? body.comps : undefined,
    },
  });
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
    source,
    sourceJurisdiction,
    degraded,
    degradedReason,
    comps,
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
    source,
    sourceJurisdiction,
    degraded,
    degradedReason,
    comps,
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
    const hasEstimate = !degraded && estimate != null;
    const valueSummary = hasEstimate
      ? `$${Number(estimate).toLocaleString()} (range: $${Number(low).toLocaleString()} – $${Number(high).toLocaleString()})`
      : "No automated estimate — CMA required";

    const noteBody = [
      hasEstimate ? `🏠 Home Valuation Report Requested` : `🏠 CMA Requested — no automated estimate`,
      ``,
      `Property: ${addressFull}`,
      `Estimated Value: ${valueSummary}`,
      // No number is sent when we couldn't value the property. The homeowner
      // has been told a CMA is coming within 24 hours — this is the prompt.
      !hasEstimate
        ? `⚠️ ACTION REQUIRED: the tool could not value this property, so the homeowner was told Candee will send a CMA within 24 hours. No figure was shown to them.`
        : null,
      beds ? `Beds: ${beds}` : null,
      baths ? `Baths: ${baths}` : null,
      sqft ? `Sqft: ${Number(sqft).toLocaleString()}` : null,
      yearBuilt ? `Year Built: ${yearBuilt}` : null,
      pricePerSqft ? `Price/Sqft: $${pricePerSqft}` : null,
      rentZestimate ? `Est. Rent: $${Number(rentZestimate).toLocaleString()}/mo` : null,
      ``,
      hasEstimate ? `📎 Shareable Report: ${reportUrl}` : null,
    ].filter(Boolean).join("\n");

    const customFieldPayload = {
      property_address: addressFull,
      estimated_value: valueSummary,
      report_url: hasEstimate ? reportUrl : "",
    };

    if (contactId) {
      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          tags: [
            "Home Valuation Lead", "Seller Lead", "Candee Currie - HVT", "HVT Email Report Requested",
            // Lets Candee filter the leads that need a manual CMA before contact.
            ...(hasEstimate ? [] : ["HVT Manual CMA Required"]),
          ],
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
          tags: [
            "Home Valuation Lead", "Seller Lead", "Candee Currie - HVT", "HVT Email Report Requested",
            // Lets Candee filter the leads that need a manual CMA before contact.
            ...(hasEstimate ? [] : ["HVT Manual CMA Required"]),
          ],
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
