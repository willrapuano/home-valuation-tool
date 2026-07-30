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
npx tsx scripts/data-source-canary.ts   # exits non-zero when the source is broken
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

**Two numbers, and the difference matters.** A backtest hands the engine a
perfect description of the house, taken from the row it is predicting.
Production has only a latitude and longitude and must resolve the property
itself, so it is a strictly harder problem — and for a while it was quietly a
much worse one. `scripts/production-path-backtest.ts` measures both on the same
properties, and it is the figure to quote:

| Source | Coverage | Engine | **Product** | Shown to visitor |
|---|---|---|---|---|
| Washington, DC | citywide | 4.7% | **4.7%** | 81% |
| Fairfax County | 1 county | 5.4% | **7.2%** | 97% |
| Maryland (SDAT) | all 24 jurisdictions | 6.7% | **6.9%** | 68% |
| **all** | | 5.8% | **6.4%** | 78% |

*124 paired holdouts across eight markets. "Shown" is how often an estimate
clears the confidence gate; below it the tool offers a CMA rather than a number.
Coverage varies more by market than by jurisdiction — Annandale publishes 100%,
Bethesda 44% — so the per-market table in `docs/jurisdiction-data-sources.md`
is the one to read before trusting an average.*

> ⚠️ **The Maryland row above is measured at zero publishing lag and is
> optimistic.** It withholds comps only from the sale date onward, which assumes
> the county publishes a sale the moment it closes. Maryland's state feed runs
> about a quarter behind. Re-run under that lag it is **11.7%**, not 6.9% — see
> [Displayed precision](#displayed-precision) below, and run
> `npx tsx scripts/production-path-backtest.ts 25 90`. The figure the UI shows
> is the lagged one; this table is kept because it is the like-for-like
> comparison of the engine path against the product path.

The engine column, on larger per-source samples, is DC 4.5% / Fairfax 5.3% /
Maryland 8.7%. Those describe the scoring, not what a homeowner receives — see
`docs/jurisdiction-data-sources.md`.

DC is the most accurate because it is the only source that states whether a
sale was arm's-length instead of leaving it to be inferred. Filtering to
qualified sales alone is worth roughly **2 percentage points** — a
larger effect than any physical characteristic. 59% of recent DC sales are
marked unqualified: foreclosures, transfers between relatives, deeds in lieu.
Where that flag does not exist, `assessmentRatioBand()` approximates it.

These figures were re-measured after fixing a truncation bug in the providers
(see `orderByFields` in each). Before that fix the sales queries returned an
arbitrary subset when more records matched than were requested, and the subset
dropped the NEWEST sales — so the earlier published figures (DC 4.3%, Fairfax
4.7%, Maryland 7.8%) were measured against a test set that was both smaller and
biased toward properties the truncation happened to spare. Fairfax went from
160 to 239 predictions. The numbers above are higher and trustworthy; the
earlier ones were lower and were not.

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
- **Deploy:** Vercel

### Design

The pages follow the format the tools homeowners have already used converge on —
Redfin, Zillow, Homebot, Opendoor: a plain-language question as the headline, one
address field in the hero, and substance below the fold in the order accuracy →
method → who prepared it → questions. Contact details are asked for once, at step
3, and never in the hero.

Colours are semantic tokens, not literal ones. `bg-paper`, `bg-canvas`,
`text-ink`, `text-ink-muted`, `border-rule` are defined once in
`app/globals.css` and mapped in `tailwind.config.ts`; navy is the button and
footer ink, gold is a hairline accent and never body text on a light surface
(`#C9A84C` on white is about 2:1 contrast — use `gold-deep` if a gold-toned word
is genuinely wanted). Headlines are set in Source Serif, body in Inter.

The landing page is a server component with `revalidate = 86400`. It reads live
county sale counts through `lib/market-pulse.ts`, which has a hard timeout and
returns `null` on any failure — the hero then renders a coverage panel instead.
Nothing on the page is allowed to block or fail the render.

**Daily, not hourly, and never per pageview.** Getting a true median costs a
paginated ArcGIS query, and county services rate-limit; their rate limit would
become this page's latency. Market statistics do not move intra-day, so one
rebuild a day is the right granularity — four requests per day per deployment.

**Which market is per-tenant** (`NEXT_PUBLIC_AGENT_MARKET`, keys in
`lib/markets.ts`). The figures were hardcoded to Fairfax, so a Bethesda agent's
visitors read Fairfax medians. An unrecognised key falls back to the coverage
panel rather than to another county's numbers.

**The window is anchored to the newest sale on file, not to today.** Measured
2026-07-30: the Maryland state sales feed's newest transfer was 2026-04-30 —
three months behind. A fixed "last 90 days" would have reported *zero* sales for
every Maryland tenant. Anchoring to the data always produces a real window and
makes the lag visible rather than hiding it. This lag applies to the valuation
engine's Maryland comps too, not just to the hero.

### Displayed precision

`lib/accuracy.ts` is the single source for the backtest figures and for how the
estimate is rendered. The results screen used to print `$1,951,882` — seven
significant digits on a number whose measured median error is 6.1%, roughly
±$119,000. That is asserting precision the backtest says we do not have, and it
contradicted the accuracy section on the landing page.

The headline is now three significant figures (`$1.95M`) with the measured band
for that jurisdiction underneath it (`give or take $92,000 — half of estimates
in Washington, DC land within 4.7% of the sale price`).

#### No percentage without a production-path measurement

`accuracyLine()` returns **null** for any jurisdiction whose measurement does not
describe what a visitor actually gets, and the UI shows the data's recency
instead. There is no hedged middle state: a figure is either safe to print or it
is withheld, and every entry carries a `basis` string saying where it came from.

**The rule caught Maryland.** Every backtest here draws its subjects from the
same lagged pool as its comps, so subject and comps sit behind Maryland's
publishing lag together and the forward extrapolation cancels. That reported
6.6%. `scripts/production-path-backtest.ts` now takes a lag argument, and run the
way Maryland actually works:

```bash
npx tsx scripts/production-path-backtest.ts 25 90
```

| run | jurisdiction | paired | record subj | live subj | published | **MdAPE shown** |
|---|---|---|---|---|---|---|
| A | dc | 37 | 5.1% | 4.5% | 90% | **4.5%** |
| A | maryland | 44 | 8.6% | 10.3% | 67% | **11.7%** |
| B | dc | 36 | 5.7% | 5.7% | 85% | **5.2%** |
| B | maryland | 36 | 6.8% | 8.2% | 69% | **10.1%** |
| B | fairfax | 49 | 6.7% | 6.7% | 96% | **6.6%** |

**Maryland is 10–12%, not 6.6%.** Two runs at n≈40 gave 11.7% and 10.1%; the
higher ships, because they straddle about ±1pp of sampling noise and every
figure here is a floor (see below). It carries the condition it was measured
under: *"half of estimates in Maryland land within 11.7% of the sale price,
measured under Maryland's ~3-month reporting lag."* Without that qualifier the
number reads as the engine being bad at Maryland houses rather than working from
records a quarter old.

**DC is the control and it behaves.** 4.5% and 5.2% under a 90-day cutoff
against 4.7% unlagged — flat, as expected for a jurisdiction publishing within
~10 days. A harness that moved DC would be measuring itself, not the lag.

**Fairfax under the same lag is 6.6%, better than the 7.5% displayed.** Its
valuations rest on assessed value, and an assessment does not go stale the way a
comp does. The conservative figure is kept.

Every displayed figure carries `measuredUnderLagDays` and `sampleSize`
structurally, and a test asserts that any figure measured under a nonzero lag
also carries a user-visible `qualifier` — so a lagged number cannot be shown
bare. That check used to grep the `basis` prose for "cutoff" and broke the
moment DC's basis mentioned its control run.

**There is no pooled headline figure any more.** The old "6.1% across eight
markets" averaged jurisdictions with different publishing lags, and included
Maryland at its optimistic 6.6%. An average across counties that publish at
different speeds is not a quantity anyone receives. The per-jurisdiction table
is the claim.

**Every figure here is a floor.** One leak is shared by every backtest in this
repository and cannot be closed with the data available: the subject's
`assessedValue` is the *current* assessment, and assessments chase sales. A
holdout that sold in March may already have been reassessed to reflect that
sale. A live visitor's future sale cannot flatter their assessment the same way.
The leak is uniform across cutoffs, so *differences* stay clean — the lag cost,
the engine-vs-product gap, the effect of a filter — but *levels* are optimistic.

It bites hardest where the assessment **is** the subject: Fairfax publishes no
living area, beds or year built, so its valuations rest almost entirely on
assessed value. DC and Maryland at least carry physical characteristics
alongside it, and Maryland reassesses triennially rather than annually, so its
assessments are on average staler and *less* able to encode a recent sale.

The out-of-time test closes this axis by construction: subjects that sell
*after* the assessments used to value them cannot leak. Once this autumn's
transfers publish — late October for Maryland — that run is not confirmation,
it is the first leak-free measurement, and it says how much of a floor these
numbers are.

**`scripts/lag-cost.ts` was audited for the other obvious leak** and is clean: it calls
`valueFromComps` with only `asOf` and `maxAssessmentRatioDeviation`, never a
`market` override, so `calibrateMarket` refits `annualAppreciation` on the
cut-off candidate set every iteration. The rate does not peek at the future. One
leak remains and is shared by every backtest here — the subject's `assessedValue`
is the current assessment — but it is identical at every cutoff, so the
*difference* between rows is clean.

`JURISDICTION_ACCURACY` is keyed by **provider slug**, not market key. Every
Maryland county is served by the one Maryland provider and reports `maryland`,
so adding counties to `lib/markets.ts` cannot mint per-county accuracy claims
that were never measured. A test asserts that cross-product stays empty, and another asserts every
displayed figure's `basis` names the production path — an engine-path number in
a production-path slot is exactly the substitution `displayable` exists to
prevent.

**A market that contributes nothing now says so.** `production-path-backtest.ts`
prints a `WHERE THE SAMPLE WENT` table covering every market it was asked for,
with pool / usable / testable / sampled / rows / no-comps counts, and marks any
that produced zero rows. A jurisdiction with no rows prints
`contributed NOTHING` with the reason instead of being skipped by the summary
loop. That omission is how a run reported DC and Maryland while quietly not
mentioning Fairfax at all.

#### The Maryland lag is structural, not an ingest problem

Checked and recorded in `scripts/lag-cost.ts`: both iMAP layers carry the
identical lag, as does every service in iMAP's PlanningCadastre catalogue; MDP's
own `mdpgis.mdp.state.md.us` hosts no sales; Montgomery County open data
publishes tax rolls only; SDAT Real Property Search returns 403 to automated
requests. There is no free fresher Maryland source, so fresh Maryland sales are
another thing a TitlePro247 / MDLandRec subscription would unlock.

The engine already time-adjusts each comp forward by its age (`adjustComp`,
`annualAppreciation`), so the point estimate is not naively comparing July to
April — but the rate is fitted on sales that also stop in April, and 11.7% is
what that extrapolation costs in practice. An HPI-indexed market-conditions
adjustment would replace the local fit with a published index.

Every screen that shows comps — results, shareable report, and the mailed-CMA
screen an agent approves letters from — prints *"Based on sales recorded through
30 April 2026 — this jurisdiction publishes sales about 3 months behind."* The
date comes from the newest comp actually shown.

#### Hero medians: filtered, or withheld

`scripts/market-benchmark.ts` prints each market's quartiles filtered and
unfiltered, and does an **offline PIN join** for Fairfax that a pageview cannot
afford. Measured over each market's own 90-day window:

| market | as queried | restricted to dwellings | gap |
|---|---|---|---|
| Washington, DC | $920,000 (n=1,459) | **$870,000** (n=1,115) | −$50,000 |
| Fairfax County | $801,005 (n=4,077) | **$850,000** (n=3,587) | +$48,995 |

Fairfax owed almost exactly the correction DC did, in the opposite direction —
DC's contaminants were hotels and offices, dearer than the housing stock;
Fairfax's are vacant land and small commercial, cheaper. 12.0% of Fairfax
"sales" are not dwellings.

DC filters on `PROPTYPE` and Maryland on `LU`. **Fairfax cannot**, so it now
shows its count and *withholds its median* — the same rule as the accuracy
percentages, since a median $49,000 light is the one figure an agent verifies
from memory. Restoring it needs an ingested PIN → land-use table so the join
happens once offline rather than per pageview; `market-benchmark.ts` already
proves the join works, and `DATABASE_URL` is what unlocks it.

Maryland's `LU` filter is also a large **speedup** on the sales layer — the
median at offset 1,350 measured 72.1s unfiltered against 15.0s with `LU IN` —
which is the opposite of the parcel layer, where the same filter costs 10.9s
against 1.0s.

`scopeLabel()` derives the panel's wording from the filters that actually ran, so
a removed filter cannot leave a claim behind. `scopeFilters` (market identity,
e.g. `JURSCODE`) are kept separate from `qualityFilters` (arm's-length,
residential): the benchmark's baseline drops the latter only. Conflating them
compared Montgomery's 2,715 sales against 21,059 statewide ones.

**Comparing a median against Bright:** match the window. These windows end at the
newest *recorded* sale, so Montgomery's $654,300 is a January–April window and
belongs beside spring closed medians, not July's. Expect a few points of drift
from recorded-vs-settled dates and from Bright seeing only MLS-listed stock.
Close is a pass; exact would be suspicious.

`low`/`high` from the engine are **not** a confidence interval and are no longer
labelled as one. They come out of `reconcile()` as the weighted dispersion of
the adjusted comps — how much the sales disagree with each other — which is a
different quantity, typically about four times wider. They read "the sales
themselves spread X – Y".

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

Every branded string is read from `lib/agent.ts`, which reads these. Nothing
outside that module should mention an agent by name.

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_AGENT_NAME` | |
| `NEXT_PUBLIC_AGENT_EMAIL` | |
| `NEXT_PUBLIC_AGENT_PHONE` | |
| `NEXT_PUBLIC_AGENT_BROKERAGE` | **Required.** VA/MD/DC advertising rules require the brokerage's name on agent-branded advertising. Rendered in the header, footer, agent card, results screen and shareable report. |
| `NEXT_PUBLIC_AGENT_LICENSE` | Rendered alongside the brokerage, not separately from it. |
| `NEXT_PUBLIC_AGENT_HEADSHOT` | Path under `public/`. Hides itself if missing. |
| `NEXT_PUBLIC_AGENT_MARKET` | Which county's live figures the hero shows. See `lib/markets.ts`. |
| `GHL_API_KEY` | The agent's own GHL account. |

---

## Fulfillment: the mailed CMA

Settled, so it does not get rebuilt here by mistake:

- **The PDF renders in `velocity-connectors`.** A WeasyPrint CMA renderer already
  exists there. Do not build a second one in this repo.
- **The Thanks.io account is a platform account**, with credentials alongside the
  connectors — not per agent, and not in this repo's environment.
- **It is a review queue, not auto-send**, gated behind `FULFILLMENT_MODE`. A
  person approves each piece before it goes to post.

What this repo owes that pipeline is the lead plus the comps behind it, which is
what `/api/lead` and `/api/email-report` already carry. `VALUATION_MODE=mailed`
is the switch that stops showing a figure on screen; see `lib/valuation-mode.ts`.

`DATABASE_URL` remains unset and is the account owner's to provide. Until it is,
`scripts/ingest.ts` has nowhere to write, the ingest table stays empty, and every
lookup queries the county services live. `scripts/ingest-status.ts` exits green
in that state rather than failing the scheduled workflow.

---

Built by **Velocity Builders LLC** — willrapuano.com
