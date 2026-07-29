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
| Property valuation (Fairfax County, VA) | County records + our comps engine | none | Falls through to DC/Maryland, then the upstream |
| Property valuation (Washington, DC) | DC DCGIS parcels + CAMA + our comps engine | none | Falls through to the upstream below |
| Property valuation (all 24 Maryland jurisdictions) | Maryland iMAP / SDAT + our comps engine | none | Falls through to the upstream below |
| Property valuation (elsewhere) | `VALUATION_API_URL` upstream | `VALUATION_API_KEY` | No estimate returned; UI routes to a manual CMA |
| Median household income | Census ACS 5-year | `CENSUS_API_KEY` | Field hidden |
| Fair Market Rents | HUD FMR API | `HUD_API_TOKEN` | Rental section hidden entirely |
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

### Detecting when the county source breaks

The Fairfax endpoints are undocumented public GIS services — no versioning, no
deprecation policy, no SLA. They can change without notice, and every way they
can break produces the *same* output as a legitimately out-of-area address:
a degraded valuation and an HTTP 200. That is the real risk, and it is the
failure that already cost this project months once.

Three layers make it loud instead of silent:

**Schema assertion.** `FairfaxSchemaError` is thrown when a layer responds
successfully but without `PIN`/`SALEDT`/`PRICE`/`LUC`/`APRTOT`. Without it, a
renamed column produces records that get silently dropped, and zero comps looks
identical to no sales nearby.

**Health canary.** `/api/health` values a known McLean parcel and reports the
specific cause when it can't:

```
countyComps  ok  142 sales, newest 10d old, 78% land use mapped,
                 median ratio 1.045, assessment year 2026
```

It also catches the two failures that produce *no error at all*:

- **Stalled feed** — sales still return, they're just all old. Fails when the
  newest sale in a 1.5-mile radius is over 60 days old.
- **Ratio drift** — Fairfax reassesses every January. Estimates ride on the
  sale-to-assessment ratio, so a reassessment moves every valuation while the
  tool keeps reporting high confidence. Warns when the median leaves 0.9–1.4,
  and `taxYear` makes the step visible.

**Scheduled CI** (`.github/workflows/data-source-canary.yml`) runs the canary
daily so a break surfaces there rather than in a homeowner's browser.

```bash
npx tsx scripts/fairfax-canary.ts   # exits non-zero when the source is broken
```

`/api/health` returns 200 when *any* valuation route works and 503 when none
do — public records cover Fairfax County and all of Maryland, the external
upstream covers everywhere else.

## Coverage and measured accuracy

Public-records providers are declared in `COVERAGE` in `app/api/avm/route.ts`
with a bounding box each. The boxes deliberately overlap — Bethesda sits inside
the Fairfax box despite being in Maryland — so coverage is decided by running
every covering source **concurrently** and taking the first that actually
produces a valuation. Each provider's spatial query is authoritative; the boxes
only avoid pointless round trips.

Accuracy is measured by holdout backtest: each property is valued as of the day
before it sold, from sales that had already closed, with the property excluded
from its own comp set.

| Source | Coverage | Holdout MdAPE | n |
|---|---|---|---|
| Washington, DC | citywide | **4.3%** | 219 |
| Fairfax County | 1 county | **4.7%** | 160 |
| Maryland (SDAT) | all 24 jurisdictions | **8.0%** | 256 |

DC is the most accurate because it is the only source that states whether a
sale was arm's-length instead of leaving it to be inferred. Filtering to
qualified sales alone is worth **1.9 percentage points** (6.2% → 4.3%) — a
larger effect than any physical characteristic. 59% of recent DC sales are
marked unqualified: foreclosures, transfers between relatives, deeds in lieu.
Where that flag does not exist, `assessmentRatioBand()` approximates it.

MdAPE is median absolute percent error. Zillow publishes ~2-3% for on-market
homes and ~7% off-market; every property here is off-market by construction.
Confidence tracks accuracy in both markets (Maryland: 5.5% high / 11.9% medium
/ 13.6% low), so the label on the screen means something.

```bash
npx tsx scripts/backtest.ts 40           # Fairfax
npx tsx scripts/maryland-backtest.ts 50  # Maryland
npx tsx scripts/dc-backtest.ts 40        # DC, incl. the arm's-length comparison
npx tsx scripts/field-ablation.ts 40     # what each data field is worth
npx tsx scripts/coverage-smoke.ts        # cross-jurisdiction routing
```

### Market constants are measured, not configured

The adjustment grid needs to know what a square foot is worth. Hardcoding it is
why the engine only worked in one county: $250/sqft is about right for Northern
Virginia, and 60% too low for Bethesda, where the measured figure is $634.

`lib/comps/calibrate.ts` derives the constants from the same local sales it is
about to reconcile — price per square foot, per square foot of lot, per year of
age, appreciation, and the sale-to-assessment ratio — so pointing the engine at
a new county calibrates it to that county on the first request, with no
per-jurisdiction tuning step. Every coefficient is clamped to a plausible range
and falls back to the prior when the local sample is too thin, because an
unconstrained fit on 40 noisy records produces negative dollars per square foot
often enough to matter.

Adding a jurisdiction is a provider plus a bounding box, not a calibration
exercise — *provided the jurisdiction publishes sale prices and assessed
values*. Many do not. See `docs/jurisdiction-data-sources.md` for what each one
actually publishes, including why Arlington and Loudoun cannot be added on
public data alone.

### Known limitation: the upstream is the weak link

`VALUATION_API_URL` must point at a **stable hostname**. It was previously hardcoded to
a `*.trycloudflare.com` Quick Tunnel, which is assigned a fresh random URL on every
restart. When that tunnel dropped, the tool silently stopped producing valuations
and nothing surfaced it. Use a named Cloudflare tunnel or a hosted API, and point an
uptime monitor at `/api/health`, which returns 503 in that state.

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

The tool runs without any keys set. Fairfax County addresses are valued from
public records with no credentials at all; everything else routes to the
prepared-CMA screen.

---

## Security notes

- API keys must live in env vars only. Keys previously committed to this repo's
  git history should be considered compromised and rotated.
- The Google Maps key is server-side only, proxied through `/api/streetview`, and
  should be restricted by API rather than by HTTP referrer.
- `/api/avm` is public and unauthenticated, rate limited per client in-process
  (10 burst, ~1 per 6s). That is per-instance on Vercel — back it with Vercel KV or
  Upstash if you need an authoritative limit.
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
