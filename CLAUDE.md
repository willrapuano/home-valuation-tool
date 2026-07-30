# Working conventions

Rules this repository learned the hard way. Each one is here because it already
cost something.

## Silence is not evidence of absence

Four failures this project has shipped, all the same shape: a thing did not
happen, nothing errored, and the absence read as a fact.

| what was silent | what it was read as | what it actually was |
|---|---|---|
| a county service returning 200 with stale data | "no sales nearby" | a stalled feed |
| a market contributing zero rows to a backtest | "that market wasn't in scope" | Fairfax sampled and dropped |
| `lookupSubject` timing out | "no data for this address" | Maryland dark since the day it shipped |
| a capability claim carried across turns | "I can't do that" | Vercel access that arrived mid-session |

The rule, in all four cases: **a missing result must be reported, counted or
retried — never returned as an empty one.** Concretely —

- A backtest names every market it asked for, including the ones that gave
  nothing, with the reason. `production-path-backtest.ts` prints
  `WHERE THE SAMPLE WENT`.
- A transient fetch failure retries with backoff before it becomes a finding.
- A provider that cannot answer says so; it does not return null and let the
  caller invent a meaning.
- **Access and capability claims are re-verified at the start of a turn, never
  carried forward.** "I don't have Vercel access" was true when written and
  false an hour later, and the stale claim was load-bearing in a plan.

## Verified means verified against the deployed SHA

Local tests, local screenshots and live backtests say nothing about what a
homeowner is served. This repository ran eight commits ahead of production for a
full working session because a pull request was open and nothing asked.

`npx tsx scripts/production-parity.ts` after every merge, and
`.github/workflows/production-parity.yml` on every push to main. A matching SHA
is necessary and not sufficient — `NEXT_PUBLIC_*` bakes at build time, so the
right commit can still serve the wrong tenant.

## No number is displayed that was not measured under the conditions it claims

`lib/accuracy.ts` is the authority. A figure is either safe to print or it is
withheld — there is no hedged middle — and each carries its `basis`,
`sampleSize` and `measuredUnderLagDays`. Documents elsewhere in the repo hold
figures measured under other conditions; they are labelled and must not be
copied into anything user-facing.

The same rule governs hero medians: a market that cannot restrict its sales
query to dwellings shows its count and withholds its median, because an
unfiltered one measured $49,000 out in Fairfax and $50,000 in DC.

## Write access is held, disclosed, and unused without a word

Merging, deploying and anything else that reaches a homeowner is proposed, not
taken. The tooling can do it; the decision is not the tooling's.

## Measure before assuming, in both directions

Maryland's subject lookup was split in two because twelve fields across a
thousand parcels swung 4.6–28.2s against an 8s timeout. DC issues the same shape
and returns in 0.4s. The hazard is a property of that service, not of ArcGIS —
"fix it everywhere for consistency" would have added a round trip to a query
that was already fast. See `lib/comps/providers/esri.ts`.
