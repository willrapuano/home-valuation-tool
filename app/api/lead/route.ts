import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, address, estimatedValue, valueLow, valueHigh } = body;

    if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

    const apiKey = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;
    if (!apiKey) return NextResponse.json({ success: true, message: "No GHL key" });

    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };

    // Create contact
    const contactPayload: Record<string, unknown> = {
      email,
      address1: address || "",
      country: "US",
      source: "Home Valuation Tool",
      tags: ["Home Valuation Lead", "Seller Lead", "Candee Currie - HVT"],
      customField: {
        property_address: address || "",
        estimated_value: estimatedValue ? `$${Number(estimatedValue).toLocaleString()}` : "",
        value_range: valueLow && valueHigh ? `$${Number(valueLow).toLocaleString()} – $${Number(valueHigh).toLocaleString()}` : "",
        lead_source: "Home Valuation Tool",
        inquiry_date: new Date().toISOString(),
      },
    };
    if (locationId) contactPayload.locationId = locationId;

    const res = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST", headers, body: JSON.stringify(contactPayload),
    });
    const data = await res.json();
    const contactId = data.contact?.id;

    // Add note
    if (contactId) {
      const note = `🏠 Home Valuation Lead\n\nProperty: ${address}\nEstimate: $${Number(valueLow).toLocaleString()} – $${Number(valueHigh).toLocaleString()}\n\nSubmitted: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes/`, {
        method: "POST", headers, body: JSON.stringify({ body: note }),
      }).catch(() => {});
    }

    return NextResponse.json({ success: true, contactId });
  } catch (err) {
    console.error("Lead route error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
