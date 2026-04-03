import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { email, address, estimate, low, high, beds, baths, sqft, yearBuilt, rentZestimate, pricePerSqft } = body;

  if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return NextResponse.json({ success: true, message: "No GHL key" });

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

    const valueSummary = estimate
      ? `$${Number(estimate).toLocaleString()} (range: $${Number(low).toLocaleString()} – $${Number(high).toLocaleString()})`
      : "N/A";

    const noteBody = [
      `🏠 Home Valuation Report Requested`,
      ``,
      `Property: ${address}`,
      `Estimated Value: ${valueSummary}`,
      beds ? `Beds: ${beds}` : null,
      baths ? `Baths: ${baths}` : null,
      sqft ? `Sqft: ${Number(sqft).toLocaleString()}` : null,
      yearBuilt ? `Year Built: ${yearBuilt}` : null,
      pricePerSqft ? `Price/Sqft: $${pricePerSqft}` : null,
      rentZestimate ? `Est. Rent: $${Number(rentZestimate).toLocaleString()}/mo` : null,
    ].filter(Boolean).join("\n");

    if (contactId) {
      // Add tag to trigger GHL workflow
      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          tags: ["Home Valuation Lead", "Seller Lead", "Candee Currie - HVT", "HVT Email Report Requested"],
          customField: {
            property_address: address,
            estimated_value: valueSummary,
          },
        }),
      });

      // Add note with full details
      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes/`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: noteBody }),
      }).catch(() => {});

    } else {
      // Create contact + tag
      await fetch("https://rest.gohighlevel.com/v1/contacts/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email,
          source: "Home Valuation Tool",
          tags: ["Home Valuation Lead", "Seller Lead", "Candee Currie - HVT", "HVT Email Report Requested"],
          customField: {
            property_address: address,
            estimated_value: valueSummary,
          },
        }),
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("email-report error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
