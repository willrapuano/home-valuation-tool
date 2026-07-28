# Questions for DataTrace — TitleFlex API integration

Copy/paste ready. Question 1 is the one that decides whether the project works
at all; ask it first, before spending money or engineering time.

The technical questions (4–7) can mostly be answered empirically by running
`npm run probe:titleflex` against a live key — ask them only if the probe
comes back inconclusive.

---

## 1. Permitted use — display to consumers *(blocking)*

> We are building a home-valuation tool that a licensed real estate agent
> embeds on their public website. A homeowner enters their address and is shown
> an estimated value derived from nearby comparable sales, along with basic
> property characteristics. The visitor is an anonymous member of the public,
> not an existing client of the agent, at the point the estimate is displayed.
>
> Does our licence permit displaying TitleFlex-derived data — sale prices,
> property characteristics, and values computed from them — to anonymous
> consumers on a public website?
>
> If not, what licence tier or agreement does permit that use?

**Why it matters:** many property-data licences allow internal business use and
client deliverables, but restrict public redistribution. That is precisely what
a lead-magnet tool does. A "no" here means this approach doesn't work regardless
of how good the API is.

**Follow-ups if the answer is yes:**

- Is attribution or a specific data-source notice required on display?
- Are there restrictions on caching or storing returned data, and for how long?
- May we display derived values (our own estimate computed from their comps),
  as distinct from re-displaying their raw records?

## 2. Resale to other agents *(blocking for the product model)*

> We intend to sell this tool to multiple independent real estate agents at
> different brokerages, each on their own deployment.
>
> Can a single commercial licence with us cover data served to end users across
> all of those deployments? Or does each agent need their own TitleFlex
> agreement?

**Why it matters:** this is the whole reason to prefer TitleFlex over an MLS
feed. MLS data rights flow through each broker's participation, so an MLS feed
authorised by one agent covers only that agent. If TitleFlex has the same
per-seat constraint, the advantage disappears and the licensing cost scales
linearly with customers.

## 3. Credential type

> Please confirm we have been issued **API credentials for programmatic
> access**, distinct from a titleflex.com web portal login.

**Why it matters:** portal logins are per-user seats. Driving one from a server
is both technically fragile and typically outside the terms.

---

## 4. Comparable sales endpoint

> Which endpoint returns **closed sales near a coordinate** within a radius and
> date window? Specifically, we need: given a latitude/longitude, a radius in
> miles, and a "sold since" date, return the matching closed sales with sale
> price, sale date, and property characteristics.
>
> If no single endpoint does this, what is the intended pattern — a geographic
> property search followed by a per-property sale-history call?

**Why it matters:** this is the biggest unknown in the integration. A
single radius-search endpoint is one call per valuation. Search-then-hydrate is
N+1 calls, which changes latency, caching strategy, and cost per lookup
substantially.

## 5. Authentication

> Which header carries the API key, and is there a scheme prefix?
> (`Authorization: Bearer <key>`, `X-API-Key: <key>`, or something else.)
> Are keys environment-specific — separate sandbox and production?

## 6. Rate limits and pricing

> - Requests per second / per day?
> - Is billing per call, per record returned, or a flat subscription?
> - Is there a sandbox or test key with sample data?

**Why it matters:** determines how aggressively we cache. Per-call billing makes
caching a cost control, not just a latency optimisation.

## 7. AVM

> Is the AVM available through the API as a separate endpoint? If so, what does
> it return — a point value, a confidence score, a value range, a forecast
> standard deviation?

**Why it matters:** if their AVM is strong, the better design may be to show
their value alongside our comps-based estimate as a cross-check, rather than
choosing one. Two independent estimates that agree is a genuinely stronger
signal than either alone.

---

## Also useful, if they offer it

- API documentation (PDF, OpenAPI/Swagger spec, or Postman collection)
- One sample response for the comparable-sales endpoint
- Whether coverage includes **non-disclosure states**. Roughly a dozen (TX, UT,
  ID, KS, MS, MT, NM, ND, WY, AK among them) don't publish sale prices in public
  record. Not an issue for VA/MD/DC, which all record transfer taxes — but it
  caps comps quality if the product is sold nationally.
