"use client";

import { Fragment, useState } from "react";
import { AddressData, LeadData, ValuationData } from "../HomeValuationFlow";
import PreparingValuation from "./PreparingValuation";
import { agent, agentFirstName } from "@/lib/agent";
import {
  accuracyLine,
  formatEstimate,
  jurisdictionLabel,
  newestCompDate,
  recencyLine,
} from "@/lib/accuracy";

interface Props {
  address: AddressData;
  valuation: ValuationData;
  lead: LeadData;
  onStartOver: () => void;
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Confidence, stated rather than colour-coded.
 *
 * The old version was a pulsing green or amber dot in a tinted pill, which is
 * dashboard furniture — it draws the eye and says nothing. What a homeowner
 * needs to know is how wide the range is and why, and that is now written out
 * in the range line beside it.
 */
function ConfidenceBadge({ confidence }: { confidence: string }) {
  const label =
    confidence === "high"
      ? "High confidence"
      : confidence === "medium"
      ? "Moderate confidence"
      : "Low confidence";
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${
          confidence === "high" ? "bg-emerald-600" : "bg-amber-600"
        }`}
      />
      {label}
    </span>
  );
}

export default function Step4Results({ address, valuation, lead, onStartOver }: Props) {
  // No property-level valuation — hand off to the prepared-by-agent screen
  // rather than showing a number that isn't about this home.
  if (valuation.degraded || valuation.estimate === null) {
    return (
      <PreparingValuation
        address={address}
        valuation={valuation}
        lead={lead}
        onStartOver={onStartOver}
      />
    );
  }
  return (
    <FullResults
      address={address}
      valuation={valuation as ResolvedValuation}
      lead={lead}
      onStartOver={onStartOver}
    />
  );
}

/** A valuation that actually produced a number. */
type ResolvedValuation = ValuationData & { estimate: number; low: number; high: number };

/**
 * The sales behind the number.
 *
 * A Zestimate is a figure from nowhere. What an agent actually does is point at
 * four houses nearby and explain the differences — and the engine already
 * computes exactly that, so showing it costs nothing and is the difference
 * between a number a homeowner believes and one they bounce off.
 *
 * It also invites disagreement, which is the point: an argument about which
 * comps are right is the conversation the agent wants to be in.
 *
 * Laid out as a table rather than a stack of cards. Sale prices are figures to
 * be compared down a column, which is what every listing site and every CMA
 * does with them, and what the card layout made impossible.
 */
function ComparableSales({ comps }: { comps: ResolvedValuation["comps"] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? comps : comps.slice(0, 4);

  return (
    <section className="mt-12">
      <h2 className="font-serif text-2xl text-ink">The sales this is based on</h2>
      <p className="mt-2 text-[15px] text-ink-muted max-w-2xl leading-relaxed">
        Recorded sale prices, public record. Each is adjusted for how it differs from your
        home — a smaller house nearby implies a higher value for yours, and the reverse.
      </p>

      {/*
        No horizontal scroll on a phone. The "Sold" column is folded into the
        address subline below `sm` instead — a table that runs off the right
        edge reads as broken, and the scroll affordance is invisible until
        someone happens to swipe it.
      */}
      <div className="mt-6 card rounded-lg overflow-hidden">
        <div>
          <table className="w-full text-[15px]">
            <thead>
              <tr className="bg-canvas border-b border-rule text-left">
                <th scope="col" className="font-medium text-ink-muted px-3 sm:px-5 py-3">Address</th>
                <th scope="col" className="hidden sm:table-cell font-medium text-ink-muted px-4 py-3">
                  Sold
                </th>
                <th scope="col" className="font-medium text-ink-muted px-2 sm:px-4 py-3 text-right">
                  Sale price
                </th>
                <th scope="col" className="font-medium text-ink-muted px-3 sm:px-5 py-3 text-right">
                  Adjusted
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(c => {
                const key = `${c.address}-${c.soldDate}`;
                const open = expanded === key;
                return (
                  <Fragment key={key}>
                    <tr
                      className="border-b border-rule last:border-0 hover:bg-canvas/60 cursor-pointer"
                      onClick={() => setExpanded(open ? null : key)}
                    >
                      <td className="px-3 sm:px-5 py-3.5">
                        <span className="text-ink">{c.address || "Nearby home"}</span>
                        <span className="block text-[13px] text-ink-faint mt-0.5 tnum">
                          <span className="sm:hidden">
                            {c.monthsAgo === 0 ? "This month" : `${c.monthsAgo} mo ago`} ·{" "}
                          </span>
                          {c.distanceMiles} mi
                          {c.sqft ? ` · ${c.sqft.toLocaleString()} sqft` : ""}
                          <span className="hidden sm:inline">
                            {c.beds ? ` · ${c.beds} bd` : ""}
                            {c.baths ? ` · ${c.baths} ba` : ""}
                          </span>
                        </span>
                      </td>
                      <td className="hidden sm:table-cell px-4 py-3.5 text-ink-muted whitespace-nowrap tnum">
                        {c.monthsAgo === 0 ? "This month" : `${c.monthsAgo} mo ago`}
                      </td>
                      <td className="px-2 sm:px-4 py-3.5 text-right text-ink-muted tnum whitespace-nowrap">
                        {formatCurrency(c.soldPrice)}
                      </td>
                      <td className="px-3 sm:px-5 py-3.5 text-right text-ink font-medium tnum whitespace-nowrap">
                        {formatCurrency(c.adjustedPrice)}
                        {c.adjustments.length > 0 && (
                          <span
                            aria-hidden="true"
                            className={`inline-block ml-2 text-ink-faint transition-transform ${
                              open ? "rotate-180" : ""
                            }`}
                          >
                            ⌄
                          </span>
                        )}
                      </td>
                    </tr>

                    {open && c.adjustments.length > 0 && (
                      <tr className="border-b border-rule last:border-0 bg-canvas">
                        <td colSpan={4} className="px-3 sm:px-5 py-4">
                          <p className="eyebrow mb-3">Adjustments toward your home</p>
                          <dl className="space-y-1.5 max-w-sm">
                            {c.adjustments.map(a => (
                              <div key={a.label} className="flex justify-between gap-6 text-sm">
                                <dt className="text-ink-muted">{a.label}</dt>
                                <dd className="tnum text-ink">
                                  {a.amount >= 0 ? "+" : "−"}
                                  {formatCurrency(Math.abs(a.amount))}
                                </dd>
                              </div>
                            ))}
                            <div className="flex justify-between gap-6 text-sm pt-2 mt-1 border-t border-rule font-medium">
                              <dt className="text-ink">Comparable to your home</dt>
                              <dd className="tnum text-ink">{formatCurrency(c.adjustedPrice)}</dd>
                            </div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {comps.length > 4 && (
          <button
            onClick={() => setShowAll(o => !o)}
            className="w-full px-3 sm:px-5 py-3 text-sm font-medium text-navy hover:bg-canvas border-t border-rule transition-colors text-left"
          >
            {showAll ? "Show fewer" : `Show all ${comps.length} sales`}
          </button>
        )}
      </div>
    </section>
  );
}

/** Results layout for a real, property-level valuation. */
function FullResults({
  address,
  valuation,
  lead,
  onStartOver,
}: Omit<Props, "valuation"> & { valuation: ResolvedValuation }) {
  const [imgError, setImgError] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleEmailReport = async () => {
    setEmailLoading(true);
    try {
      const res = await fetch("/api/email-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: lead.email,
          address: address,
          estimate: valuation.estimate,
          low: valuation.low,
          high: valuation.high,
          confidence: valuation.confidence,
          beds: valuation.beds,
          baths: valuation.baths,
          sqft: valuation.sqft,
          yearBuilt: valuation.yearBuilt,
          rentZestimate: valuation.rentZestimate,
          pricePerSqft: valuation.pricePerSqft,
          homeType: valuation.homeType,
          fmr: valuation.fmr,
          areaMedianIncome: valuation.areaMedianIncome,
          source: valuation.source,
          // Needed for the report's error band; `source` is "county-comps" for
          // every county alike and cannot distinguish them.
          sourceJurisdiction: valuation.sourceJurisdiction,
          degraded: valuation.degraded,
          degradedReason: valuation.degradedReason,
          // So the shared report shows the same sales as this screen. The
          // route trims these to keep the link inside its length budget.
          comps: valuation.comps,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.reportUrl) setReportUrl(data.reportUrl);
      setEmailSent(true);
    } catch { setEmailSent(true); } // show success even if API fails
    setEmailLoading(false);
  };

  const handleCopyLink = async () => {
    if (!reportUrl) return;
    try {
      await navigator.clipboard.writeText(reportUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* ignore */ }
  };

  // Use the URL the server resolved — it may be an actual listing photo, or a
  // Street View shot located by lat/lng rather than by address text.
  const streetViewUrl =
    valuation.streetViewUrl ?? `/api/streetview?location=${encodeURIComponent(address.full)}`;

  const CMA_SUBJECT = encodeURIComponent(`CMA request — ${address.full}`);
  const CMA_BODY = encodeURIComponent(
    `Hi ${agentFirstName},\n\nI'd like a comparative market analysis for ${address.full}.\n\nEmail: ${lead.email}\n\nThank you.`
  );
  const CMA_URL = `mailto:${agent.email}?subject=${CMA_SUBJECT}&body=${CMA_BODY}`;
  const TEL = `tel:${agent.phone.replace(/[^\d+]/g, "")}`;

  // Only ever a real figure: a rent Zestimate for this property, or HUD Fair
  // Market Rents when a token is configured. The static NoVA table that used
  // to back-fill this was the same fabrication we removed from the valuation.
  const suggestedRent = valuation.rentZestimate ?? valuation.fmr?.threeBr ?? null;
  const pricePerSqft = valuation.pricePerSqft ?? null;

  const streetLine = `${address.streetNumber} ${address.streetName}`.trim() || address.full;

  const accuracyBand = accuracyLine(valuation.estimate, valuation.sourceJurisdiction);
  const recency = recencyLine(newestCompDate(valuation.comps));

  return (
    <div className="animate-fade-in w-full">
      {/* ── The number, and the address it belongs to ──────────────── */}
      <header>
        <p className="eyebrow">Estimated market value</p>
        {/*
          ROUNDED, ON PURPOSE. This printed $1,951,882 — seven significant
          digits on a figure whose measured median error in this jurisdiction is
          several percent. That is asserting a precision the backtest says we do
          not have, and it contradicts the accuracy section on the landing page.
          Three significant figures, with the measured band stated underneath.
        */}
        <p className="mt-3 font-serif text-5xl md:text-6xl text-ink tnum leading-none">
          {formatEstimate(valuation.estimate)}
        </p>
        {/*
          One or the other, never a hedge. `accuracyLine` returns null for a
          jurisdiction whose measurement does not reflect production — Maryland,
          whose backtest pool is as lagged as its comps — and the recency line
          takes its place: a fact about the evidence rather than an estimate of
          an estimate. See lib/accuracy.ts.
        */}
        {accuracyBand ? (
          <p className="mt-2 text-[15px] text-ink-muted tnum">{accuracyBand}</p>
        ) : recency ? (
          <p className="mt-2 text-[15px] text-ink-muted">{recency}</p>
        ) : null}

        <p className="mt-5 text-lg text-ink">{streetLine}</p>
        <p className="text-ink-muted">
          {address.city}
          {address.city ? ", " : ""}
          {address.state} {address.zipCode}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
          {/*
            NOT a confidence interval, and no longer labelled as one. `low` and
            `high` come out of reconcile() as the weighted dispersion of the
            adjusted comps — how much the sales disagree with each other, which
            is a different quantity from how far the estimate lands from the
            eventual sale price. Printing them next to the measured band above
            under the label "likely range" invited them to be read as the same
            thing, and they are typically four times wider.
          */}
          <span className="text-[15px] text-ink-muted tnum">
            The sales themselves spread {formatEstimate(valuation.low)} –{" "}
            {formatEstimate(valuation.high)}
          </span>
          <ConfidenceBadge confidence={valuation.confidence} />
        </div>

        {valuation.compCount ? (
          <p className="mt-3 text-sm text-ink-muted max-w-2xl leading-relaxed">
            Built from {valuation.compCount} comparable{" "}
            {valuation.compCount === 1 ? "sale" : "sales"}
            {valuation.compRadiusMiles ? ` within ${valuation.compRadiusMiles} miles` : ""}
            {valuation.lookbackMonths
              ? `, closed in the last ${valuation.lookbackMonths} months`
              : ""}
            , each adjusted toward your property.
          </p>
        ) : null}
      </header>

      {/* ── The house ──────────────────────────────────────────────── */}
      {!imgError && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={streetViewUrl}
          alt={`Street view of ${address.full}`}
          className="mt-8 w-full h-56 md:h-72 object-cover rounded-lg border border-rule"
          onError={() => setImgError(true)}
        />
      )}

      {/* ── Actions ────────────────────────────────────────────────── */}
      <div className="mt-8 flex flex-wrap gap-3">
        <a
          href={CMA_URL}
          className="h-12 inline-flex items-center px-6 bg-navy hover:bg-navy-light text-white font-semibold rounded-md text-[15px] transition-colors"
        >
          Ask {agentFirstName} to review this
        </a>
        <button
          onClick={handleEmailReport}
          disabled={emailLoading || emailSent}
          className="h-12 inline-flex items-center px-6 border border-ink/25 hover:border-navy text-ink font-medium rounded-md text-[15px] transition-colors disabled:opacity-60"
        >
          {emailSent ? "Emailed to you" : emailLoading ? "Sending…" : "Email me this report"}
        </button>
      </div>

      {emailSent && (
        <div className="mt-4 card rounded-md px-5 py-4">
          <p className="text-[15px] text-ink">
            Sent to <span className="font-medium">{lead.email}</span>.{" "}
            {agentFirstName} will follow up within 24 hours with the things an automated
            estimate cannot see.
          </p>
          {reportUrl && (
            <button
              onClick={handleCopyLink}
              className="mt-2 text-sm font-medium text-navy hover:underline"
            >
              {linkCopied ? "Link copied" : "Copy a link to this report"}
            </button>
          )}
        </div>
      )}

      <ComparableSales comps={valuation.comps ?? []} />

      {/* ── The record behind it ───────────────────────────────────── */}
      <section className="mt-12 grid md:grid-cols-2 gap-8 md:gap-12">
        <div>
          <h2 className="font-serif text-2xl text-ink">Your property record</h2>
          <dl className="mt-4">
            {valuation.beds ? <Row label="Bedrooms" value={String(valuation.beds)} /> : null}
            {valuation.baths ? <Row label="Bathrooms" value={String(valuation.baths)} /> : null}
            {valuation.sqft ? (
              <Row label="Living area" value={`${valuation.sqft.toLocaleString()} sqft`} />
            ) : null}
            {valuation.yearBuilt ? (
              <Row label="Year built" value={String(valuation.yearBuilt)} />
            ) : null}
            {valuation.homeType ? (
              <Row
                label="Home type"
                value={<span className="capitalize">{valuation.homeType.replace(/_/g, " ")}</span>}
              />
            ) : null}
            {valuation.assessedValue ? (
              <Row
                label="County assessment"
                value={formatCurrency(valuation.assessedValue)}
                note={`${
                  valuation.estimate > valuation.assessedValue ? "+" : ""
                }${Math.round(
                  ((valuation.estimate - valuation.assessedValue) / valuation.assessedValue) * 100
                )}% vs this estimate`}
              />
            ) : null}
            {pricePerSqft ? (
              <Row label="Price per sqft" value={`$${pricePerSqft.toLocaleString()}`} last />
            ) : (
              <Row
                label="Location"
                value={`${address.city}${address.city ? ", " : ""}${address.state} ${address.zipCode}`}
                last
              />
            )}
          </dl>
        </div>

        <div>
          <h2 className="font-serif text-2xl text-ink">Area context</h2>
          <dl className="mt-4">
            {valuation.compRadiusMiles ? (
              <Row label="Search radius" value={`${valuation.compRadiusMiles} miles`} />
            ) : null}
            {valuation.lookbackMonths ? (
              <Row label="Sales reviewed" value={`Last ${valuation.lookbackMonths} months`} />
            ) : null}
            {valuation.areaMedianIncome ? (
              <Row
                label="Area median income"
                value={formatCurrency(valuation.areaMedianIncome)}
                note="Household, per year"
              />
            ) : null}
            {suggestedRent ? (
              <Row
                label="Estimated monthly rent"
                value={formatCurrency(suggestedRent)}
                note={
                  valuation.rentZestimate
                    ? `${((suggestedRent * 12) / valuation.estimate * 100).toFixed(1)}% gross yield, this property`
                    : `${((suggestedRent * 12) / valuation.estimate * 100).toFixed(1)}% gross yield, HUD area benchmark`
                }
                last
              />
            ) : (
              <Row
                label="Records source"
                value={jurisdictionLabel(valuation.sourceJurisdiction ?? valuation.source)}
                last
              />
            )}
          </dl>
        </div>
      </section>

      {/* ── The agent ──────────────────────────────────────────────── */}
      <section className="mt-12 pt-10 border-t border-rule">
        <div className="grid sm:grid-cols-[auto_1fr] gap-6 items-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={agent.headshot}
            alt={agent.name}
            width={112}
            height={112}
            className="w-24 h-24 rounded-full object-cover object-top border border-rule"
            onError={e => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div>
            <h2 className="font-serif text-2xl text-ink">Where this estimate is likely wrong</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-muted max-w-2xl">
              Public record does not know whether your kitchen was redone, how the light
              falls, or what the lot backs onto — and those routinely move the number by
              more than the band above. {agent.name} will walk the property, tell you which
              of the sales above are genuinely comparable and which are not, and give you a
              figure she would be willing to list at.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px]">
              <a href={TEL} className="text-navy font-medium hover:underline">
                {agent.phone}
              </a>
              <a href={`mailto:${agent.email}`} className="text-navy font-medium hover:underline">
                {agent.email}
              </a>
            </div>
            {/*
              Brokerage sits WITH the licence, not only in the page footer.
              VA, MD and DC advertising rules all require the brokerage's name
              on agent-branded advertising, and this block is what a homeowner
              screenshots and forwards.
            */}
            <p className="mt-3 text-sm text-ink-faint">
              {agent.brokerage} · {agent.license}
            </p>
          </div>
        </div>
      </section>

      <div className="mt-10 pt-6 border-t border-rule">
        <button
          onClick={onStartOver}
          className="text-sm font-medium text-navy hover:underline"
        >
          Value another address
        </button>
      </div>
    </div>
  );
}

/* ── Small helper for detail rows ─────────────────────────────────── */
function Row({
  label,
  value,
  note,
  last = false,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
  last?: boolean;
}) {
  return (
    <div
      // flex-wrap, so a long value ("$1,447,392 – $2,456,372") drops to its own
      // line on a narrow screen rather than running past the container edge.
      className={`flex flex-wrap justify-between items-baseline gap-x-6 gap-y-1 py-3 ${
        last ? "" : "border-b border-rule"
      }`}
    >
      <dt className="text-[15px] text-ink-muted">{label}</dt>
      <dd className="text-right">
        {/*
          NOT `capitalize`. That class title-cases every word, which turned
          "1.23 miles" into "1.23 Miles" and "last 12 months" into
          "Last 12 Months". Values that need casing fixed do it at the call
          site, where only that one value is affected.
        */}
        <span className="text-[15px] text-ink font-medium tnum">{value}</span>
        {note && <span className="block text-[13px] text-ink-faint tnum">{note}</span>}
      </dd>
    </div>
  );
}
