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

### Degraded mode

When property-level data is unavailable, `/api/avm` returns `degraded: true` with a
`degradedReason`. The UI must — and does — say so plainly: it shows a price *range*
rather than a single figure, labels it "Neighborhood Price Range", and displays a
notice explaining that the number is a ZIP-code average, not a valuation of that home.
The GHL note is flagged too, so the agent knows before calling the lead.

**Do not remove that treatment.** Presenting a ZIP average as a property valuation
is a misrepresentation, and the tool carries a licensed agent's name.

## Comparables engine (`lib/comps`)

A self-contained comps ranking and reconciliation engine. It is decoupled from
any data source — it consumes candidate sales from a `CompsProvider` and knows
nothing about where they came from, so a licensed MLS feed, county assessor
records, or test fixtures all plug into the same logic.

```ts
import { valueFromComps, valueWithProvider } from "@/lib/comps";

const result = valueFromComps(subject, candidateSales);
// → { estimate, low, high, confidence, confidenceScore, comps, rejected, notes }
```

**How it works**

1. **Knockout filters** — distance, sale recency, property-type substitutability,
   GLA ratio band, and a cap on total adjustment size. Rejections are returned
   with a human-readable reason rather than silently dropped.
2. **Similarity scoring** — each comp is scored per dimension (distance, recency,
   GLA, lot, vintage, rooms, subdivision, school zone, condition), then combined
   using configurable weights. Dimensions with no data return `null` and are
   dropped from the average rather than scored zero, so a missing lot size does
   not make a comp look bad.
3. **Adjustment grid** — appraisal-style dollar adjustments toward the subject,
   including the market-time adjustment that is most often skipped and most
   often material. Gross and net adjustment ratios are tracked separately.
4. **Reconciliation** — a similarity-weighted mean, with the range derived from
   how much the comps actually *disagree* rather than a fixed percentage.
   Tightly clustered comps earn a narrow band; scattered ones produce a wide
   one, which is the correct answer rather than a presentation failure.

**Confidence** blends comp count, mean similarity, price dispersion, and mean
adjustment size — and then lets disagreement *veto* the result. Comps that are
physically near-identical but sold at wildly different prices score high on
similarity yet tell you nothing, so agreement caps the final number rather than
merely contributing to it.

Market constants in `lib/comps/config.ts` (price per sqft, bath value,
appreciation rate, etc.) are **documented assumptions calibrated for Northern
Virginia**, not universal truths. Re-derive them by regression against closed
sales before pointing this at another market.

### Operational endpoints

- **`GET /api/health`** — returns **503** when the tool cannot produce
  property-level valuations, and 200 when it can. Point an uptime monitor at it
  and alert on non-200. This exists because the original failure was invisible:
  the upstream vanished and the tool kept returning HTTP 200 with ZIP averages
  for months. A monitor on the homepage would have stayed green throughout.
- **`/api/avm`** is cached (1h for real results, 60s for degraded so recovery is
  picked up quickly) and rate limited (10 burst, ~1 per 6s sustained).

Both the cache and the limiter are **per-instance in-process memory**. On Vercel
each lambda keeps its own copy, so treat them as a speed bump, not a quota
system. For an authoritative shared limit, back them with Vercel KV or Upstash —
the interfaces in `lib/cache.ts` and `lib/rate-limit.ts` are small enough to swap.

## Tests

```bash
npm test
```

Vitest, covering the comps engine (geo, scoring, adjustments, knockouts,
ranking, reconciliation, confidence) and the cache/rate-limit infrastructure.
The UI and API routes are not yet covered.

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
