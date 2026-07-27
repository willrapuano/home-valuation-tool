# 🏠 Home Valuation Tool — Velocity Builders

A multi-step home valuation lead capture tool built for Candee Currie (TTR Sotheby's International Realty). Built to be resold to multiple agents as a Velocity Builders product.

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

1. **Step 1 — Address Entry** — OpenStreetMap/Nominatim autocomplete
2. **Step 2 — Loading** — Progress screen; races the real AVM request (2.5s floor, 8s cap)
3. **Step 3 — Lead Gate** — Captures email before showing results
4. **Step 4 — Results** — Value range, rental analysis, agent CTA card

---

## Where the data comes from

| Layer | Source | Required key | If missing |
|---|---|---|---|
| Address autocomplete | Nominatim (OpenStreetMap) | none | — |
| Property valuation | `VALUATION_API_URL` upstream | `VALUATION_API_KEY` | Falls back to ZIP average, flagged `degraded` |
| Median household income | Census ACS 5-year | `CENSUS_API_KEY` | Field hidden |
| Fair Market Rents | HUD FMR API | `HUD_API_TOKEN` | Static NoVA averages |
| Property imagery | Google Street View via `/api/streetview` | `GOOGLE_MAPS_API_KEY` | Placeholder tile |
| Lead capture | GoHighLevel | `GHL_API_KEY` | No-op, flow still completes |

### When no valuation is available

`/api/avm` returns `degraded: true` with **`estimate`, `low` and `high` all null**
when it cannot value the specific property. It does not substitute an area
average — an earlier version returned a ZIP-code figure here, which meant every
home in 22101 came back at $1,200,000 whether it was a mansion or a teardown.

The UI switches to a "valuation being prepared" screen (`PreparingValuation.tsx`)
that shows no number at all and commits to an agent-prepared CMA within 24 hours.
The lead gate adapts too, so it never promises a figure the next screen can't
deliver. The lead is still captured and pushed to the CRM, tagged
`HVT Manual CMA Required`, with a note telling the agent what the homeowner was
promised.

**Do not reintroduce a placeholder number here.** A figure that isn't about the
subject property has no business on the screen, and the funnel converts on the
CMA offer rather than on the estimate.

### Known limitation: the upstream is the weak link

`VALUATION_API_URL` must point at a **stable hostname**. It was previously hardcoded to
a `*.trycloudflare.com` Quick Tunnel, which is assigned a fresh random URL on every
restart. When that tunnel dropped, every valuation silently became a ZIP-code average
and nothing surfaced it. Use a named Cloudflare tunnel or a hosted API, and add an
uptime check against `/api/avm`.

---

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **Brand:** Navy #0B1D3A + Gold #C9A84C (Sotheby's palette)
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

The tool runs without any keys set — it will serve clearly-labelled degraded
estimates so you can work on the funnel without credentials.

---

## Security notes

- API keys must live in env vars only. Keys previously committed to this repo's
  git history should be considered compromised and rotated.
- The Google Maps key is server-side only, proxied through `/api/streetview`, and
  should be restricted by API rather than by HTTP referrer.
- `/api/avm` is public and unauthenticated. It is worth adding rate limiting before
  driving significant traffic to it.
- Shareable report URLs are unsigned base64 — the values in them can be edited by
  the recipient. Sign them before treating a report link as authoritative.

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

Note: agent details are currently still hardcoded in `HomeValuationFlow.tsx` and
`Step4Results.tsx`. Wiring them to the env vars above is a prerequisite for resale.

---

Built by **Velocity Builders LLC** — willrapuano.com
