"use client";

import { Fragment, Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  decodeReportPayload,
  ReportComp,
  ReportPayload,
  ReportValuation,
} from "@/lib/report-payload";
import { agent, agentFirstName } from "@/lib/agent";

// The payload shape is defined once, in lib/report-payload.ts, and shared with
// the route that writes it — it used to be re-declared here by hand and had
// already drifted from what the encoder actually sent.
type ValuationData = ReportValuation;
type ReportData = ReportPayload;

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

const TEL = `tel:${agent.phone.replace(/[^\d+]/g, "")}`;

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
        {/* Not `capitalize` — it title-cased "1.23 miles" into "1.23 Miles".
            Values needing case fixed do it at the call site. */}
        <span className="text-[15px] text-ink font-medium tnum">{value}</span>
        {note && <span className="block text-[13px] text-ink-faint tnum">{note}</span>}
      </dd>
    </div>
  );
}

/**
 * The sales behind the number.
 *
 * The results screen has shown these since the estimate stopped being a figure
 * from nowhere; the shareable report — the artifact that actually gets
 * forwarded to a spouse, or to another agent — did not, and still described an
 * estimate "based on comparable sales" without naming one. This closes that.
 *
 * Absent on links generated before the payload carried comps, so it renders
 * nothing rather than an empty section.
 */
function ComparableSales({ comps }: { comps: ReportComp[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? comps : comps.slice(0, 4);

  return (
    <section className="mt-12">
      <h2 className="font-serif text-2xl text-ink">The sales this is based on</h2>
      <p className="mt-2 text-[15px] text-ink-muted max-w-2xl leading-relaxed">
        Recorded sale prices, public record. Each is adjusted for how it differs from this
        home — a smaller house nearby implies a higher value, and the reverse.
      </p>

      {/* "Sold" folds into the address subline below `sm` rather than making the
          table scroll sideways off a phone screen. */}
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
                          <p className="eyebrow mb-3">Adjustments toward this home</p>
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
                              <dt className="text-ink">Comparable to this home</dt>
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

function ReportContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const raw = searchParams.get("d");
    if (!raw) { setError(true); return; }
    const decoded = decodeReportPayload(raw);
    if (decoded) setData(decoded);
    else setError(true);
  }, [searchParams]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  if (error) {
    return (
      <Centered>
        <h1 className="font-serif text-3xl text-ink">This report link is not valid</h1>
        <p className="mt-3 text-ink-muted">
          It may have been truncated by an email client, or it may have expired.
        </p>
        <a
          href="/"
          className="mt-6 h-12 inline-flex items-center px-6 bg-navy hover:bg-navy-light text-white font-semibold rounded-md text-[15px] transition-colors"
        >
          Value a home
        </a>
      </Centered>
    );
  }

  if (!data) {
    return (
      <Centered>
        <div className="w-6 h-6 border-2 border-rule border-t-navy rounded-full animate-spin" />
      </Centered>
    );
  }

  const { address } = data;

  // A report is only ever generated for a real valuation. If a link somehow
  // carries a degraded payload, say so rather than rendering an empty figure.
  if (data.valuation.degraded || data.valuation.estimate == null || data.valuation.low == null || data.valuation.high == null) {
    return (
      <Centered>
        <h1 className="font-serif text-3xl text-ink">Valuation in progress</h1>
        <p className="mt-3 text-ink-muted max-w-md">
          No automated estimate was available for {address.full}. {agent.name} is preparing a
          comparative market analysis by hand and will be in touch directly.
        </p>
        <a
          href={TEL}
          className="mt-6 h-12 inline-flex items-center px-6 bg-navy hover:bg-navy-light text-white font-semibold rounded-md text-[15px] transition-colors"
        >
          Call {agentFirstName} — {agent.phone}
        </a>
      </Centered>
    );
  }

  // Narrowed by the guard above: a report only ever renders a resolved valuation.
  const valuation = data.valuation as ValuationData & {
    estimate: number;
    low: number;
    high: number;
  };

  // Proxied so the Maps key stays server-side.
  const streetViewUrl = `/api/streetview?location=${encodeURIComponent(address.full)}`;

  /*
   * NO STATIC RENT FALLBACK.
   *
   * This page used to substitute a hardcoded Northern Virginia FMR table —
   * {studio: 2050, … threeBr: 2960} — whenever HUD data was absent, and then
   * label the result "HUD FMR 3BR". That is the same fabrication that was
   * removed from the valuation itself: a made-up figure presented as sourced.
   * The section is now omitted when there is nothing real to put in it.
   */
  const suggestedRent = valuation.rentZestimate ?? valuation.fmr?.threeBr ?? null;
  const pricePerSqft = valuation.pricePerSqft ?? null;

  const CMA_SUBJECT = encodeURIComponent(`CMA request — ${address.full}`);
  const CMA_BODY = encodeURIComponent(
    `Hi ${agentFirstName},\n\nI'd like a comparative market analysis for ${address.full}.\n\nThank you.`
  );
  const CMA_URL = `mailto:${agent.email}?subject=${CMA_SUBJECT}&body=${CMA_BODY}`;

  const streetLine = `${address.streetNumber} ${address.streetName}`.trim() || address.full;

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="border-b border-rule bg-paper sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="font-serif text-lg text-ink leading-tight truncate">{agent.name}</p>
            <p className="text-[11px] uppercase tracking-[0.13em] text-ink-faint truncate">
              {agent.brokerage}
            </p>
          </div>
          <button
            onClick={handleCopyLink}
            className="shrink-0 h-9 px-4 border border-ink/25 hover:border-navy text-ink text-sm font-medium rounded-md transition-colors"
          >
            {copied ? "Link copied" : "Share"}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-5 sm:px-8 py-10 md:py-14">
        <p className="eyebrow">Estimated market value</p>
        <p className="mt-3 font-serif text-5xl md:text-6xl text-ink tnum leading-none">
          {formatCurrency(valuation.estimate)}
        </p>
        <p className="mt-4 text-lg text-ink">{streetLine}</p>
        <p className="text-ink-muted">
          {address.city}
          {address.city ? ", " : ""}
          {address.state} {address.zipCode}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="text-[15px] text-ink tnum">
            Likely range {formatCurrency(valuation.low)} – {formatCurrency(valuation.high)}
          </span>
          <ConfidenceBadge confidence={valuation.confidence} />
        </div>

        {!imgError && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={streetViewUrl}
            alt={`Street view of ${address.full}`}
            className="mt-8 w-full h-56 md:h-72 object-cover rounded-lg border border-rule"
            onError={() => setImgError(true)}
          />
        )}

        {valuation.comps?.length ? <ComparableSales comps={valuation.comps} /> : null}

        <section className="mt-12 grid md:grid-cols-2 gap-8 md:gap-12">
          <div>
            <h2 className="font-serif text-2xl text-ink">Property record</h2>
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
              <Row
                label="Location"
                value={`${address.city}${address.city ? ", " : ""}${address.state} ${address.zipCode}`}
                last
              />
            </dl>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-ink">Market context</h2>
            <dl className="mt-4">
              <Row
                label="Likely range"
                value={`${formatCurrency(valuation.low)} – ${formatCurrency(valuation.high)}`}
                note={`± ${formatCurrency(Math.round((valuation.high - valuation.low) / 2))}`}
              />
              {pricePerSqft ? (
                <Row label="Price per sqft" value={`$${pricePerSqft.toLocaleString()}`} />
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
                  note={`${((suggestedRent * 12) / valuation.estimate * 100).toFixed(1)}% gross yield · ${
                    valuation.rentZestimate ? "this property" : "HUD area benchmark"
                  }`}
                  last
                />
              ) : (
                <Row label="Confidence" value={<ConfidenceBadge confidence={valuation.confidence} />} last />
              )}
            </dl>
          </div>
        </section>

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
                Public record cannot see condition, renovations or finishes, and those
                routinely move the number by more than the range above. {agent.name} will walk
                the property and give you a figure she would be willing to list at.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a
                  href={CMA_URL}
                  className="h-12 inline-flex items-center px-6 bg-navy hover:bg-navy-light text-white font-semibold rounded-md text-[15px] transition-colors"
                >
                  Ask {agentFirstName} to review this
                </a>
                <a
                  href={TEL}
                  className="h-12 inline-flex items-center px-6 border border-ink/25 hover:border-navy text-ink font-medium rounded-md text-[15px] transition-colors"
                >
                  {agent.phone}
                </a>
              </div>
              <p className="mt-4 text-sm text-ink-faint">{agent.license}</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-rule bg-canvas">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-8">
          <p className="text-xs leading-relaxed text-ink-faint">
            Estimates are produced from publicly available property records and are not a
            formal appraisal, a guarantee of value, or an offer to purchase. Data is deemed
            reliable but is not guaranteed. If your home is currently listed with another
            brokerage, this is not a solicitation.
          </p>
          <p className="mt-4 text-xs text-ink-faint">
            {agent.name} · {agent.brokerage} ·{" "}
            <a href="/" className="text-navy hover:underline">
              Value another home
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center px-6 text-center">
      {children}
    </div>
  );
}

export default function ReportPage() {
  return (
    <Suspense
      fallback={
        <Centered>
          <div className="w-6 h-6 border-2 border-rule border-t-navy rounded-full animate-spin" />
        </Centered>
      }
    >
      <ReportContent />
    </Suspense>
  );
}
