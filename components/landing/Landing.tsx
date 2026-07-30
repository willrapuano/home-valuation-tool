"use client";

import AddressSearch, { AddressData } from "../AddressSearch";
import type { MarketPulse } from "@/lib/market-pulse";
import { agent, agentFirstName } from "@/lib/agent";
// One source for the backtest figures, shared with the results screen and the
// report so the three can never quote different numbers at each other.
import { ACCURACY, JURISDICTION_ACCURACY, jurisdictionLabel } from "@/lib/accuracy";

/**
 * The landing page.
 *
 * SHAPE IS BORROWED FROM THE TOOLS HOMEOWNERS HAVE ALREADY USED. Redfin, Zillow,
 * Homebot, Opendoor and Homes.com converge on the same page: a plain-language
 * question as the headline, one address field in the hero, and then several
 * screens of substance underneath — how the number is produced, what arrives,
 * who is behind it, and the questions people actually ask. Redfin's own order is
 * accuracy → what you can track → market context → who prepared it → resources,
 * and that ordering is followed here.
 *
 * WHAT WAS REMOVED, AND WHY. The previous version was a single centred
 * glass-morphism card on a navy gradient, headed by a "⚡ FREE INSTANT ESTIMATE"
 * pill and footed by three emoji badges reading "🏠 Public Property Data",
 * "🔒 100% Private" and "⚡ 30-Second Results". Every one of those is a generated-
 * page tell, and none of them is checkable. They are replaced by claims that
 * carry a number and a source: which jurisdictions are covered, the measured
 * median error, and live county sale counts.
 *
 * NOTHING BELOW THE FOLD ASKS FOR CONTACT DETAILS. The email gate is step 3, on
 * purpose — asking twice is the fastest way to lose the visitor who was ready.
 */

const MAILED_MODE = process.env.NEXT_PUBLIC_VALUATION_MODE?.trim().toLowerCase() === "mailed";

interface Props {
  onSubmit: (data: AddressData, sqft?: number) => void;
  initialError?: string | null;
  /** Live county figures. Null when the county service was unreachable. */
  pulse: MarketPulse | null;
}

export default function Landing({ onSubmit, initialError, pulse }: Props) {
  return (
    <>
      <Hero onSubmit={onSubmit} initialError={initialError} pulse={pulse} />
      <HowItWorks />
      <Accuracy />
      <AgentSection />
      <Faq />
    </>
  );
}

/* ------------------------------------------------------------------ hero -- */

function Hero({ onSubmit, initialError, pulse }: Props) {
  return (
    <section className="bg-canvas border-b border-rule">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-14 md:py-20">
        <div className="grid lg:grid-cols-[1.15fr_0.85fr] gap-12 lg:gap-16 items-start">
          <div>
            <p className="eyebrow mb-4">
              Washington DC · Northern Virginia · Suburban Maryland
            </p>
            <h1 className="font-serif text-[2.5rem] leading-[1.08] sm:text-5xl lg:text-[3.4rem] text-ink tracking-[-0.015em]">
              {MAILED_MODE ? (
                <>What is your home worth today?</>
              ) : (
                <>How much is your home worth?</>
              )}
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-ink-muted max-w-xl">
              {MAILED_MODE ? (
                <>
                  Enter your address and {agentFirstName} will prepare a comparative market
                  analysis for your home — the recent sales it is priced against, the
                  adjustments between them and yours, and what it would list for — and mail
                  it to you.
                </>
              ) : (
                <>
                  Enter your address to see an estimate built from the sales recorded near
                  you — with the comparable homes, their sale prices and the adjustments
                  shown, so you can check the reasoning rather than take a number on faith.
                </>
              )}
            </p>

            <div className="mt-8 max-w-xl">
              <AddressSearch
                onSubmit={onSubmit}
                initialError={initialError}
                cta={MAILED_MODE ? "Request my report" : "Get my estimate"}
                hint="No account, no phone number, no obligation."
              />
            </div>

            <p className="mt-6 text-sm text-ink-muted leading-relaxed max-w-xl">
              Built from county and District property records — recorded deeds, sale prices
              and assessments. Not an appraisal.
            </p>
          </div>

          {pulse ? <MarketPanel pulse={pulse} /> : <CoveragePanel />}
        </div>
      </div>
    </section>
  );
}

/**
 * Live figures from the same Fairfax service the valuation engine queries.
 *
 * This is the trust signal that replaced the emoji badges. It is specific,
 * dated, and moves week to week — a homeowner can check any of it against the
 * county's own site, which "100% Private" could never offer.
 */
function MarketPanel({ pulse }: { pulse: MarketPulse }) {
  const through = new Date(`${pulse.through}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <aside className="card-raised rounded-lg p-7">
      <p className="eyebrow">
        {pulse.market} · {pulse.windowDays} days to {through}
      </p>

      <dl className="mt-6 space-y-6">
        <div>
          <dd className="font-serif text-4xl text-ink tnum">
            {pulse.sales.toLocaleString()}
          </dd>
          {/*
            The label follows the filters that actually ran — see scopeLabel in
            lib/markets.ts. Only Fairfax can claim arm's-length; only DC and
            Maryland can claim residential. Fairfax's sales layer carries no
            land-use field, so its figure is "property sales", not "home sales".
          */}
          <dt className="text-sm text-ink-muted mt-1">{pulse.scope}</dt>
        </div>
        {/* Omitted rather than faked when the median query timed out — see
            lib/market-pulse.ts. The counts still stand on their own. */}
        {pulse.medianPrice !== null && (
          <div>
            <dd className="font-serif text-4xl text-ink tnum">
              ${pulse.medianPrice.toLocaleString()}
            </dd>
            <dt className="text-sm text-ink-muted mt-1">Median sale price</dt>
          </div>
        )}
      </dl>

      <div className="mt-7 pt-6 border-t border-rule">
        <p className="text-sm text-ink-muted leading-relaxed">
          <span className="tnum font-medium text-ink">
            {pulse.salesOnFile.toLocaleString()}
          </span>{" "}
          sales from the preceding twelve months are on file for {pulse.market} alone. Your
          estimate is drawn from the ones nearest and most like your home.
        </p>
        <p className="mt-3 text-xs text-ink-faint">
          Read from {pulse.market} public records. The window ends at the newest recorded
          sale, not at today&apos;s date.
        </p>
      </div>
    </aside>
  );
}

/** Shown instead of the live figures when the county service is unreachable. */
function CoveragePanel() {
  return (
    <aside className="card-raised rounded-lg p-7">
      <p className="eyebrow">Where instant estimates are available</p>
      <ul className="mt-5 space-y-3 text-[15px] text-ink">
        {[
          ["Washington, DC", "All wards"],
          ["Fairfax County, VA", "Including McLean, Vienna, Falls Church, Reston"],
          ["Maryland", "Montgomery, Prince George's, Howard, Frederick"],
        ].map(([place, detail]) => (
          <li key={place} className="pb-3 border-b border-rule last:border-0 last:pb-0">
            <p className="font-medium">{place}</p>
            <p className="text-sm text-ink-muted mt-0.5">{detail}</p>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-sm text-ink-muted leading-relaxed">
        Elsewhere in the region — Arlington, Alexandria, Loudoun, Prince William —
        sale prices are not published online, so {agentFirstName} prepares those by hand
        instead.
      </p>
    </aside>
  );
}

/* ---------------------------------------------------------- how it works -- */

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "We find your parcel",
      body:
        "Your address is matched to the specific parcel record it sits inside — not the nearest one — so the lot size, assessment and last recorded sale belong to your home.",
    },
    {
      n: "02",
      title: "We select comparable sales",
      body:
        "Every arm's-length sale within a mile over the last year is ranked by how close it is, how recently it closed and how similar the property is. Family transfers and nominal conveyances are excluded.",
    },
    {
      n: "03",
      title: "We adjust and reconcile",
      body:
        MAILED_MODE
          ? "Each comparable is adjusted toward your home for size, age, condition and the months since it sold. Those adjustments are the working draft your report is built from."
          : "Each comparable is adjusted toward your home for size, age, condition and the months since it sold, then weighted into a single range. You see the adjustments, line by line.",
    },
  ];

  return (
    <section className="bg-paper">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-16 md:py-20">
        <h2 className="font-serif text-3xl md:text-4xl text-ink tracking-[-0.01em]">
          How the estimate is put together
        </h2>
        <p className="mt-3 text-ink-muted max-w-2xl">
          The same three steps an appraiser follows, run against public record instead of
          from a clipboard.
        </p>

        <div className="mt-12 grid md:grid-cols-3 gap-x-10 gap-y-10">
          {steps.map(s => (
            <div key={s.n} className="border-t-2 border-navy pt-5">
              <p className="font-serif text-sm text-gold-deep tnum tracking-widest">{s.n}</p>
              <h3 className="mt-2 text-lg font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- accuracy -- */

/**
 * Redfin leads its below-fold content with how accurate its estimate is and
 * publishes the error rate. Ours is measured the same way — held-out sales the
 * engine never saw — and is stated with the same specificity, including the
 * jurisdictions where it is worse.
 */
function Accuracy() {
  return (
    <section className="bg-canvas border-y border-rule">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-16 md:py-20">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-start">
          <div>
            <p className="eyebrow mb-4">Accuracy</p>
            <h2 className="font-serif text-3xl md:text-4xl text-ink tracking-[-0.01em]">
              How close it gets, measured
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-muted">
              The engine was tested against {ACCURACY.sampleSize} homes that had actually
              sold, selected at random across {ACCURACY.marketCount} markets. Each was valued
              from the sales around it with its own sale price withheld, then compared against
              what it really sold for.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">
              Half the estimates landed within {ACCURACY.medianErrorPct}% of the true price.
              Where the nearby sales are too few or too dissimilar for that to hold, no number
              is shown at all — which happens about {100 - ACCURACY.publishRatePct}% of the
              time, and always in the jurisdictions that publish no sale prices. Those
              requests go to {agentFirstName} to prepare by hand.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">
              This is why your estimate is shown rounded, with its band underneath. Printing{" "}
              <span className="tnum">$1,951,882</span> on a figure that is typically{" "}
              {ACCURACY.medianErrorPct}% out would be asserting precision we have measured
              ourselves not to have.
            </p>
          </div>

          <div className="card rounded-lg overflow-hidden">
            <table className="w-full text-[15px]">
              <caption className="sr-only">
                Median absolute error by jurisdiction, on held-out sales
              </caption>
              <thead>
                <tr className="bg-paper border-b border-rule">
                  <th scope="col" className="text-left font-medium text-ink-muted px-5 py-3">
                    Jurisdiction
                  </th>
                  <th scope="col" className="text-right font-medium text-ink-muted px-5 py-3">
                    Typical error
                  </th>
                </tr>
              </thead>
              <tbody>
                {/*
                  A jurisdiction whose measurement does not describe production
                  shows no percentage here either. Maryland's backtest draws
                  subjects from a pool as lagged as its comps, so the number it
                  produces is not the one a homeowner receives — printing it in
                  a table headed "measured" would be the same false claim the
                  results screen now refuses to make.
                */}
                {Object.entries(JURISDICTION_ACCURACY).map(([key, figure]) => (
                  <tr key={key} className="border-b border-rule last:border-0">
                    <td className="px-5 py-3.5 text-ink">{jurisdictionLabel(key)}</td>
                    <td className="px-5 py-3.5 text-right tnum">
                      {figure.displayable ? (
                        <span className="text-ink">{figure.pct}%</span>
                      ) : (
                        <span className="text-ink-faint">being re-measured</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-5 py-4 text-xs text-ink-faint leading-relaxed bg-paper border-t border-rule">
              Median absolute error against recorded sale prices. An estimate is a starting
              point for a conversation, not an appraisal — condition, renovations and
              finishes are not in public record, and they move the number.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- agent -- */

function AgentSection() {
  return (
    <section className="bg-paper">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-16 md:py-20">
        <div className="grid md:grid-cols-[auto_1fr] gap-8 md:gap-12 items-start max-w-4xl">
          <img
            src={agent.headshot}
            alt={agent.name}
            width={160}
            height={160}
            className="w-32 h-32 md:w-40 md:h-40 rounded-full object-cover border border-rule shrink-0"
            onError={e => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div>
            <p className="eyebrow mb-3">Prepared by</p>
            <h2 className="font-serif text-3xl text-ink">{agent.name}</h2>
            <p className="mt-1 text-ink-muted">{agent.brokerage}</p>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-muted max-w-xl">
              An automated estimate cannot see a renovated kitchen, a difficult lot or the
              buyer who has been waiting for your street. {agentFirstName} reviews every
              request personally and will tell you plainly where the model is likely to be
              wrong about your home — whether or not you are thinking of selling.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px]">
              <a href={`tel:${agent.phone.replace(/[^\d+]/g, "")}`} className="text-navy font-medium hover:underline">
                {agent.phone}
              </a>
              <a href={`mailto:${agent.email}`} className="text-navy font-medium hover:underline">
                {agent.email}
              </a>
              <span className="text-ink-faint text-sm">{agent.license}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- faq -- */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Where does the data come from?",
    a: (
      <>
        Recorded deeds, sale prices and assessments published by the District of Columbia,
        Fairfax County and the State of Maryland. It is the same public record a title
        company works from. Nothing is bought from a data broker and nothing comes from
        the MLS.
      </>
    ),
  },
  {
    q: "Is this an appraisal?",
    a: (
      <>
        No. An appraisal involves someone walking through your home, and is the only thing a
        lender will accept. This prices your home against what similar homes nearby actually
        sold for, which is how a listing price is set — but it cannot see condition,
        renovations or finishes, and those routinely move the number by more than the error
        rate above.
      </>
    ),
  },
  {
    q: "Why does it sometimes not show a number?",
    a: (
      <>
        Because the sales nearby were too few, too old or too different from your home for a
        figure to be worth printing. Some jurisdictions — Arlington, Alexandria, Loudoun and
        Prince William — do not publish sale prices online at all, so no automated tool can
        produce one there. In every one of those cases {agentFirstName} prepares the analysis
        by hand instead.
      </>
    ),
  },
  {
    q: "Will I be called or added to a mailing list?",
    a: (
      <>
        You are asked for an email address once, so the analysis can be sent to you, and
        never for a phone number. {agentFirstName} may follow up by email. Your address and
        email are not sold or shared.
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: <>Nothing, and there is no obligation of any kind.</>,
  },
];

function Faq() {
  return (
    <section className="bg-canvas border-t border-rule">
      {/* max-w-6xl so the left edge lines up with every section above it; the
          answers are constrained separately for readability. */}
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-16 md:py-20">
        <h2 className="font-serif text-3xl md:text-4xl text-ink tracking-[-0.01em]">
          Common questions
        </h2>
        <div className="mt-10 border-t border-rule max-w-3xl">
          {FAQ.map(item => (
            <details key={item.q} className="group border-b border-rule">
              <summary className="flex items-start justify-between gap-6 py-5 text-left">
                <span className="text-[17px] font-medium text-ink">{item.q}</span>
                <span
                  aria-hidden="true"
                  className="mt-1 shrink-0 text-ink-faint text-xl leading-none transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <div className="pb-6 pr-10 text-[15px] leading-relaxed text-ink-muted">
                {item.a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
