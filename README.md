# 🏠 Home Valuation Tool — Velocity Builders

A multi-step home valuation lead capture tool built for Candee Currie (TTR Sotheby's International Realty). Built to be resold to multiple agents as a Velocity Builders product.

## Live Demo
🔗 [Deployed on Vercel] — URL in deployment-status.json

## Embeddable iFrame
```html
<iframe
  src="https://home-valuation-tool.vercel.app"
  width="100%"
  height="700"
  frameborder="0"
  style="border-radius: 12px; min-height: 600px;"
  allow="geolocation"
  title="Home Valuation Tool"
></iframe>
```

---

## User Flow

1. **Step 1 — Address Entry** — Google Places autocomplete + optional sqft
2. **Step 2 — Loading** — Animated processing screen, fetches AVM data in background
3. **Step 3 — Lead Gate** — Captures name/email/phone before showing results
4. **Step 4 — Results** — Value range, comps, agent CTA card

---

## Required API Keys

| Key | Status | Purpose |
|-----|--------|---------|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | ✅ Configured | Address autocomplete |
| `GHL_API_KEY` | ✅ Configured | Lead push to GoHighLevel |
| `GHL_LOCATION_ID` | ✅ Configured | GHL location targeting |
| `REPLIERS_API_KEY` | ❌ **MISSING** | Real AVM + comps data |

### Missing: Repliers API Key
Without `REPLIERS_API_KEY`, the tool falls back to a price-per-sqft estimate algorithm using a NoVA zip code table. Results will show "Medium Confidence" and recommend a CMA.

**To enable real Repliers data:**
1. Log into https://app.repliers.io
2. Go to Settings → API Keys
3. Copy the key and add to Vercel environment variables as `REPLIERS_API_KEY`

---

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **Brand:** Navy #0B1D3A + Gold #C9A84C (Sotheby's palette)
- **APIs:** Google Places, Repliers IDX, GoHighLevel CRM
- **Deploy:** Vercel

---

## Local Development

```bash
npm install
cp .env.example .env.local
# Fill in your API keys
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Reselling to Other Agents

To deploy for a new agent, update these env vars:
- `NEXT_PUBLIC_AGENT_NAME`
- `NEXT_PUBLIC_AGENT_EMAIL`
- `NEXT_PUBLIC_AGENT_PHONE`
- `NEXT_PUBLIC_AGENT_BROKERAGE`
- `NEXT_PUBLIC_AGENT_LICENSE`
- `GHL_API_KEY` (agent's GHL account)
- Replace `/public/candee-headshot.png` with agent headshot

---

## GHL Pipeline Setup

To fully enable GHL pipeline creation:
1. In GHL, create a pipeline named "Home Valuation Leads"
2. Add a stage "New Lead"
3. Copy the Pipeline ID and Stage ID from GHL Settings
4. Add to `app/api/lead/route.ts` at the `pipelineId` and `pipelineStageId` fields

---

Built by **Velocity Builders LLC** — willrapuano.com
