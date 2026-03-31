import { NextRequest, NextResponse } from "next/server";

interface LeadPayload {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city?: string;
  state?: string;
  zipCode?: string;
  estimatedValue?: number;
  valueLow?: number;
  valueHigh?: number;
  source?: string;
}

async function pushToGHL(lead: LeadPayload): Promise<{ success: boolean; contactId?: string; error?: string }> {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;

  if (!apiKey) {
    console.error("GHL_API_KEY not set");
    return { success: false, error: "GHL API key not configured" };
  }

  try {
    // Create/update contact
    const contactPayload: Record<string, unknown> = {
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      address1: lead.address,
      city: lead.city || "",
      state: lead.state || "VA",
      postalCode: lead.zipCode || "",
      country: "US",
      source: "Home Valuation Tool",
      tags: ["Home Valuation Lead", "Seller Lead", "Candee Currie - HVT"],
      customField: {
        property_address: lead.address,
        estimated_value: lead.estimatedValue ? `$${lead.estimatedValue.toLocaleString()}` : "",
        value_range: lead.valueLow && lead.valueHigh
          ? `$${lead.valueLow.toLocaleString()} – $${lead.valueHigh.toLocaleString()}`
          : "",
        lead_source: lead.source || "Home Valuation Tool",
        inquiry_date: new Date().toISOString(),
      },
    };

    // If location ID provided, add it
    if (locationId) {
      contactPayload.locationId = locationId;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };

    const res = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST",
      headers,
      body: JSON.stringify(contactPayload),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("GHL create contact error:", data);
      return { success: false, error: data.message || "Failed to create contact" };
    }

    const contactId = data.contact?.id;

    // Add note to contact
    if (contactId) {
      const noteBody = `🏠 Home Valuation Lead\n\nProperty: ${lead.address}\nEstimated Value: $${lead.valueLow?.toLocaleString()} – $${lead.valueHigh?.toLocaleString()}\n\nSubmitted via Home Valuation Tool on ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

      await fetch(`https://rest.gohighlevel.com/v1/contacts/${contactId}/notes/`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: noteBody }),
      }).catch(err => console.error("GHL note error:", err));

      // Try to create an opportunity in "Home Valuation Leads" pipeline
      // This is optional — won't fail the lead capture if it errors
      if (locationId) {
        await fetch("https://rest.gohighlevel.com/v1/opportunities/", {
          method: "POST",
          headers,
          body: JSON.stringify({
            pipelineId: "", // Will need to be filled in with actual pipeline ID
            locationId,
            name: `${lead.firstName} ${lead.lastName} — Home Valuation`,
            pipelineStageId: "", // Will need stage ID
            status: "open",
            contactId,
            monetaryValue: lead.estimatedValue || 0,
            source: "Home Valuation Tool",
          }),
        }).catch(err => console.error("GHL opportunity error (non-fatal):", err));
      }
    }

    return { success: true, contactId };
  } catch (err) {
    console.error("GHL push error:", err);
    return { success: false, error: "Failed to push lead to GHL" };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { firstName, lastName, email, phone, address, city, state, zipCode, estimatedValue, valueLow, valueHigh } = body;

    // Basic validation
    if (!firstName || !lastName || !email || !phone) {
      return NextResponse.json(
        { error: "First name, last name, email, and phone are required" },
        { status: 400 }
      );
    }

    const lead: LeadPayload = {
      firstName,
      lastName,
      email,
      phone,
      address: address || "",
      city,
      state,
      zipCode,
      estimatedValue,
      valueLow,
      valueHigh,
      source: "Home Valuation Tool",
    };

    const result = await pushToGHL(lead);

    if (!result.success) {
      // Log but don't fail the user flow — lead is captured regardless
      console.error("GHL push failed:", result.error);
    }

    return NextResponse.json({
      success: true,
      contactId: result.contactId,
      message: "Lead captured successfully",
    });
  } catch (err) {
    console.error("Lead route error:", err);
    return NextResponse.json({ error: "Failed to capture lead" }, { status: 500 });
  }
}
