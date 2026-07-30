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

| Jurisdiction | Sale price | Assessed value | Characteristics | Arm's-length | Street address |
|---|---|---|---|---|---|
| Washington, DC | yes | yes | beds, baths, GBA, condition, year | **yes** | yes |
| Fairfax County, VA | yes | yes | none | inferred | **no — see below** |
| Maryland (all 24) | yes | yes | sqft, lot, year, grade | inferred | yes |

## Accuracy: the engine, and the product

These are two different numbers and conflating them has already cost dearly.
`scripts/production-path-backtest.ts` measures both on the same properties.

| | engine (record subject) | product (live subject) | published | **error of what is shown** |
|---|---|---|---|---|
| Washington, DC | 4.7% | 4.7% | 81% | **4.7%** |
| Maryland | 6.7% | 6.9% | 68% | **6.6%** |
| Fairfax County | 5.4% | 7.2% | 97% | **7.5%** |
| **all** | 5.8% | 6.4% | 78% | **6.1%** |

*124 paired holdouts across eight markets. Both columns are computed over the
same properties — comparing each over whatever it happened to answer reports a
difference in which homes were valued as a difference in accuracy, the same
survivorship error that made a tight search radius look good in
`adaptive-radius.ts`.*

**Engine** hands the valuation a perfect description of the house, straight off
the row being predicted. That is what every other backtest here measures, and
it is not available to production, which has only a latitude and longitude.

**Product** resolves the subject the way a request does, through
`lookupSubject`. The gap between the columns is subject-lookup quality. DC's is
now zero at 100% exact-parcel resolution — before the containment fix it was
+12.9pp. Fairfax's 1.7pp tracks its 86% exact rate: it publishes no
characteristics, so the subject is nothing but the assessment, and a wrong
parcel is a wrong adjustment basis directly.

### Two ways this measurement lied before it was trusted

Both are recorded because both are easy to repeat.

**It compared different subsets.** Taking each column's median over whatever
that column happened to produce reported Maryland at +3.9pp — impossible, since
a field-by-field diff showed the subject data identical through both paths on
the correct parcel every time. Where `lookupSubject` failed, the property
counted in one column and not the other. Paired, the gap is +0.3pp.

**It counted its own load as the product failing.** With one attempt per
lookup, Maryland appeared to publish 53% — half its visitors getting nothing.
A backtest issues hundreds of requests in a tight loop and iMAP rate-limits it;
production issues one. With retries, upstream errors go to 0% and the figure is
68%. Upstream failures are now reported in their own column, because "this
source is flaky under load" and "this source cannot value this home" are
different problems.

### How much of a market's error is its transactions, not the code

Bethesda is the worst market in the tool on both coverage and accuracy. Most of
that turns out to be a property of its sales, not of the valuation.

Maryland and Fairfax publish no arm's-length flag, so a holdout drawn straight
from the sales record contains intra-family transfers, distressed sales and
nominal conveyances. Those are not market value, and scoring an estimate
against them measures a failure to predict a non-market number. The engine
already refuses such sales *as comps* via `assessmentRatioBand`; nothing
applied the same standard to the holdout. `scripts/holdout-quality.ts`:

| | share with a plausible sale/assessment ratio | all holdouts | plausible only |
|---|---|---|---|
| Bethesda | 81% | 18.7% | **8.2%** |
| Rockville | 92% | 6.6% | **5.1%** |

Bethesda carries more than twice Rockville's share of implausible sales, which
is most of the difference between them.

**The filter is circular, so this is a bracket and not a number.** "Plausible"
means the sale is close to its own assessment, and the engine's estimate is
largely *driven* by that assessment — the strongest single input, worth 3.1pp.
Filtering this way keeps the sales the engine was always going to get right, so
8.2% is optimistic by construction in a way no adjustment can remove.

The honest statement: Bethesda's accuracy on genuine arm's-length sales is
somewhere between 8.2% and 18.7%, and public Maryland data cannot narrow it.
DC can be measured properly because DC publishes the qualified flag. That is a
second, independent reason to want deed-type data — beyond the coverage
argument for Arlington and Loudoun.

Do not "fix" a market's numbers by filtering its holdout.

### Coverage varies more by market than by jurisdiction

| market | published |
|---|---|
| fairfax/Annandale | 100% |
| fairfax/McLean | 94% |
| dc/Capitol Hill | 89% |
| dc/Petworth | 78% |
| maryland/Rockville | 78% |
| maryland/Frederick | 75% |
| maryland/Columbia | 72% |
| **maryland/Bethesda** | **44%** |

Bethesda is the outlier, not Maryland — expensive and heterogeneous, so comps
disagree, dispersion rises and `scoreConfidence`'s agreement cap withholds the
result. Quoting a jurisdiction average would have hidden a market where more
than half of visitors get no number. Maryland measured on Rockville and
Bethesda alone reads 61%; across four markets, 68%.

Re-run this after any change to a provider's `lookupSubject`, candidate query,
or the publish gate. The older per-jurisdiction figures (DC 4.5%, Fairfax 5.3%,
Maryland 8.7%) were engine numbers on different samples; they describe the
scoring, not what anyone receives.

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

## Finding the subject: containment, not proximity

Every provider must answer "which parcel is this?" from a geocoded point, and
DC and Maryland both got it wrong in a way nothing detected for weeks.

Both issued a single radius query at 0.1 miles with `resultRecordCount: 40` and
no ordering, then picked the nearest of whatever came back. **DC packs 159–340
parcels into that radius.** ArcGIS returned an arbitrary page of 40, and the
parcel the point actually sits in was usually not among them — measured on
Capitol Hill at **9 of 10 properties resolving to a different house**.

Nothing errored. Each lookup returned a complete, plausible subject carrying a
neighbour's living area, bedrooms, year built and assessment. Measured against
actual sale prices on 27 DC holdouts:

| subject taken from | MdAPE |
|---|---|
| the property's own sales record | **10.1%** |
| old lookup (radius, page of 40) | **23.0%** |
| new lookup (containment first) | **10.1%** |

The bug more than doubled DC's error, and the confidence label barely moved —
so homeowners were shown confident-looking estimates for someone else's house.
The fix restores accuracy exactly to what the sales record gives.

**No backtest could have caught this.** Every backtest builds the subject from
the sales record and never calls `lookupSubject` at all. It is only visible by
comparing the two against live data, which is now what
`lib/comps/providers/subject-lookup.test.ts` pins in structure.

Omitting `distance` makes the query a point-in-polygon test: the containing
parcel comes back, or nothing does. One widened rung remains as the genuine
fallback for a geocode landing on a street centreline, and it requests enough
records that "nearest" is really the nearest. Fairfax always did it this way,
which is why Fairfax was unaffected.

**The ladder is two rungs, and that bound is load-bearing.** A first attempt
used four (0, 0.02, 0.05, 0.1). Each rung is a sequential round trip against a
service that is occasionally slow, and Maryland measured 12.1s in Frederick and
timed out entirely in Silver Spring against the route's 20s budget — trading a
wrong answer for no answer. Two rungs brought those to 6.1s and 8.3s.

### Only an exact match may be shown

Resolving a neighbour is fine for CHOOSING comparable sales and wrong for
printing "your home has 4 bedrooms". `SubjectLookup.exactParcel` separates the
two, and `/api/avm` publishes the subject's characteristics only when it is
true. It is false on a widened rung, and always false for `PostgresProvider`,
whose table holds only properties that have SOLD — a home that has not changed
hands is not in it, so its "subject" is necessarily the nearest neighbour.

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
acquisition problem.

### Records requests — considered and REJECTED

Letters to the Arlington and Loudoun assessors were drafted and then dropped
without being sent. Recording why, because it is a proposal that looks sensible
on paper and will otherwise be reinvented.

A FOIA extract is a **point-in-time snapshot**. Keeping it useful means
re-requesting, re-downloading and re-ingesting it forever, by hand, because
nothing about a records request is automatable. And `scripts/lag-cost.ts`
measured what stale comps cost:

| data cutoff | MdAPE | coverage |
|---|---|---|
| same week | 5.3% | 93% |
| 90 days | 7.0% | 73% |
| 135 days | 7.8% | 61% |

A quarterly refresh — optimistic for a FOIA cycle — lands at the 90-day row or
worse. That is Maryland's situation, the worst of the three sources, adopted
deliberately. And it degrades from there the first time the refresh is skipped,
which for a manual chore on a solo agent's calendar is soon. The failure is
silent: stale comps produce confident-looking numbers.

So the realistic outcome is two counties served worse than the three already
covered, plus a permanent recurring chore, in exchange for coverage that a
commercial feed supplies without any of it.

### What actually closes the gap: TitlePro247

Already licensed, already implemented in the sibling `velocity-connectors`
repo (`lib/titlepro247/`, shipped 2026-07-23), and **confirmed by the licence
holder as permitted for consumer display**. Its export carries everything the
engine needs:

```
lastSaleAmount, lastSaleDate, assessedValue, beds, baths, sqft,
yearBuilt, lotSize, propertyType, siteAddress*
```

**It is a batch source, not a query API.** A TitlePro247 "search" is a
billable, asynchronous farm-list *order* — submit, poll, download XLSX, parse.
It cannot sit in a request path at any latency. So the export is ingested into
`sales` and served from Postgres, which is why the datastore is a
**prerequisite** for Northern Virginia coverage rather than a latency
optimisation. See `lib/comps/providers/titlepro247.ts` and
`scripts/ingest-titlepro.ts`.

#### The budget is the constraint, and it is a one-time one

Pulls are capped at **10,000 per month**. `scripts/titlepro-budget.ts` sizes an
order before any of it is spent, using a turnover rate measured on Fairfax —
27,135 sales against 369,079 parcels, **7.35% per year**:

| county | parcels | est. sales/yr | 12-month backfill | % of cap |
|---|---|---|---|---|
| Arlington | 38,683 | 2,844 | 2,844 | 28% |
| Loudoun | 132,557 | 9,746 | 9,746 | 97% |
| **total** | 171,240 | 12,590 | 12,590 | **126%** |

So the backfill needs two months, or a shortened history. **Steady state is
~1,050 pulls per month — 10% of the cap** — because only new sales are pulled
once the history is loaded.

**Use `maxOwnershipYears`.** A farm search returns current owners in a radius,
so tiling a county without it pulls all 171,240 parcels to find the ~12,600
that sold: seventeen months of budget for one year of comps. Ownership tenure
is time since the last sale, so `maxOwnershipYears: 1` returns the comp set and
nothing else.

Confirm with `getCount()` in velocity-connectors before ordering — it asks
TitlePro247 for the real number without spending any budget. The table above is
an estimate from a neighbouring county.

#### Two gaps in the export, both handled at ingest

- **No coordinates.** Only `distanceFeet` from the search centre, which fixes a
  radius and not a position. Addresses go through the Census Bureau's free batch
  geocoder — 92% matched on real Arlington and Loudoun addresses, and the
  misses are reported rather than silently dropped.
- **No parcel number.** The normalised site address is the natural key, which
  keeps re-ingest idempotent.

#### It also buys a deed-type flag

Worth noting beyond coverage: DC is the only jurisdiction that can be measured
honestly today, because it is the only one publishing an arm's-length flag —
see the holdout-quality section above. TitlePro247 carries deed type, which
would let Maryland and Fairfax be measured properly too.

**Scraping the county property-search applications** remains the fallback if
that answer is no. Brittle, and it puts a third party's uptime in the request
path; if taken, ingest on a schedule into our own store rather than calling at
request time, so a broken scraper degrades to stale data instead of no
valuation.
