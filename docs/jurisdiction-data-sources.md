# What each jurisdiction actually publishes

Adding a jurisdiction is only cheap when it publishes the two fields the engine
depends on. This records what was found, so the next person does not repeat the
search.

The ranking that matters, measured by `scripts/field-ablation.ts` against 213
Maryland holdout sales — what accuracy costs when a field is removed:

| Field | Worth |
|---|---|
| **Assessed value** | **+3.1pp** |
| Arm's-length flag (DC only) | **+1.9pp** |
| Year built | +0.3pp |
| Condition / grade | +0.3pp |
| Lot size | −0.1pp |
| Subdivision | −0.1pp |

A source without **sale price** cannot produce comps at all. A source without
**assessed value** loses roughly three points of accuracy and falls back on the
physical grid. Everything else is a rounding error by comparison — which is why
"this county publishes beds and baths" is not, on its own, a reason to
integrate it.

## Integrated

| Jurisdiction | Sale price | Assessed value | Characteristics | Arm's-length | Street address | MdAPE |
|---|---|---|---|---|---|---|
| Washington, DC | yes | yes | beds, baths, GBA, condition, year | **yes** | yes | **4.5%** |
| Fairfax County, VA | yes | yes | none | inferred | **no — see below** | **5.3%** |
| Maryland (all 24) | yes | yes | sqft, lot, year, grade | inferred | yes | **8.7%** |

### Fairfax publishes no street address with a sale

Its sales layer carries only the parcel identifier (PIN), and so does every
other Fairfax service checked — `ParcelsPlus`, `OpenData_A9/Parcels` and
`ParcelPlusAssessedValues` all publish PIN and geometry, no situs address.

That did not matter while comps were internal. It mattered the moment they were
shown to homeowners, who saw six rows reading `0311 17 0027`.

The one public source that has addresses is the county's own locator,
`Locators/FairfaxCountyAddresses/GeocodeServer`, which takes a point rather
than a PIN. `FairfaxCountyProvider.resolveAddresses` reverse-geocodes the
parcel centroid for the six comps that will actually be shown — not the
candidate pool — at roughly 240ms for the batch warm, 1s cold.

**The match is verified against the PIN the locator returns.** Measured over 18
comps across McLean, Annandale and Springfield: 14 resolved, 4 rejected, and
every rejection was an *adjacent* parcel (`0804 02030013` → `0804 02030012`).
Widening the search to 1,000m returns the same neighbour, so those parcels have
no address point of their own. Without the check, all four would have been
published under the house next door's address. Unmatched comps read
"Nearby home".

The assessment-ratio band is set per source, not globally, because the right
setting depends on whether the source publishes an arm's-length flag. Measured
over 369 holdout sales:

| band | Maryland | DC | Fairfax |
|---|---|---|---|
| ±25% | 9.0% | **4.4%** | 4.7% |
| ±50% | 8.6% | 4.6% | **4.6%** |
| off | **8.3%** | 4.9% | 4.6% |

Maryland improves monotonically as the band loosens; DC gets worse. DC already
knows which sales were arm's-length, so the band is a useful second check
there. Maryland has no flag, so the band is a *proxy* for one — and a proxy
that discards good comps costs more than it saves. Maryland now runs at ±50%,
which still rejects the egregious cases it genuinely carries (a $1,200
assessment against a $1.4M sale) without throwing away ordinary sales.

DC is the most accurate because of the arm's-length flag, not because of the
building characteristics. 59% of recent DC sales are marked unqualified —
foreclosures, intra-family transfers, deeds in lieu. Elsewhere
`assessmentRatioBand()` guesses at these from sale-to-assessment ratios.

## Publishing lag — measured 2026-07-29

How current each source is matters as much as how complete it is, and they
differ enormously:

| Source | Newest sale available | Lag |
|---|---|---|
| Washington, DC | 2026-07-20 | **10 days** |
| Fairfax County | 2026-07-20 | **10 days** |
| Maryland (SDAT) | 2026-04-30 | **90 days** |

Maryland's is statewide, not local: querying the whole state returned **zero
sales recorded in May, June or July**. That is SDAT's publishing cadence, not a
fault and not something we can fix.

It has two consequences worth stating plainly:

1. **Maryland valuations are built on comps at least three months old.** The
   engine time-adjusts them forward using locally-measured appreciation, so
   this is compensated rather than ignored — but extrapolating a quarter ahead
   adds error, and it is part of why Maryland trails DC and Fairfax.
2. **The canary has to tolerate it.** `PROVIDER_PROBES` sets Maryland's
   staleness threshold to 150 days rather than the 75-day default. At 75 it
   would fail every single day and be ignored inside a week, which is worse
   than having no canary. 150 still catches a genuine stall.

## Investigated and NOT viable on public data

### Arlington County, VA

`https://arlgis.arlingtonva.us/arcgis/rest/services` — 244 open-data services.

- `Open_Data/od_REA_Property_Polygons` — parcel geometry keyed by `RPCMSTR`.
  Seven fields, all geometry and sync metadata. **No sale price, no assessed
  value.**
- `Open_Data/od_MHUD_Polygons` — Master Housing Unit Database. Unit type, total
  units, affordability, year built. **No sale price, no assessed value.**
- ArcGIS Online, `owner:arlgis` — nothing carrying assessments.
- `data.arlingtonva.us` serves an HTML app shell, not a data API.

Arlington's real estate assessment data exists but is behind its property
search web application, not published as an API or bulk extract.

### Loudoun County, VA

`https://logis.loudoun.gov/gis/rest/services` (note: **not** `/arcgis/` or
`/loudoungis/`, both of which 404).

- `COL/LandRecords/MapServer/5` Parcel Boundaries — subdivision name, phase,
  section, block, legal square footage. **No sale price, no assessed value.**
- `COL/LMIS_ParcelsPlatfile/MapServer/2` — carries `VPC_OWN_SALE_DT`, a sale
  **date with no price**, plus ownership dates.
- `COL/LandRecordData` — address points and stacked parcels only.

A sale date without a price is not a comparable sale.

## What this means

The assumption that "another county is just another provider" holds for
Maryland (one integration, 24 jurisdictions) and DC. It does **not** hold
across Virginia. Fairfax is unusually generous — most Virginia counties publish
parcel geometry for planning purposes and keep assessment and sales behind a
property-search application.

So the remaining Northern Virginia gap is not an engineering problem, it is an
acquisition problem. The options, in order of cost:

1. **Records request / bulk extract** from each county assessor. Often free or
   near-free, and produces exactly the two fields that matter. Slow to arrange,
   and needs a refresh cadence. **Drafted and ready to send:**
   `records-request-arlington.md`, `records-request-loudoun.md`.

   Both ask for the parcel identifier first, because we already hold the
   geometry for both counties — only the attributes are missing, and they join
   on a key the counties already publish. Both also ask for the assessor's
   arm's-length/validity code, which DC showed is worth 1.9pp.

   Each letter opens with a phone call rather than a filing: localities often
   sell a standing assessment extract outside FOIA, which is faster, cheaper,
   and comes with a refresh schedule.
2. **Commercial property data** (TitlePro247, TitleFlex, or an MLS feed).
   Worth noting where the value actually is: not accuracy in the jurisdictions
   already covered, where public assessments are already doing the work, but
   coverage in the ones that publish nothing — plus the deed-type flag, which
   DC shows is worth ~1.9pp.
3. **Scraping the county property-search applications.** Brittle, and it puts
   a third party's uptime in the request path. If taken, ingest on a schedule
   into our own store rather than calling at request time, so a broken scraper
   degrades to stale data instead of no valuation.
