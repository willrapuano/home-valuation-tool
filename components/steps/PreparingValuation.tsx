"use client";

import { useState } from "react";
import { AddressData, LeadData, ValuationData } from "../HomeValuationFlow";
import { agent, agentFirstName } from "@/lib/agent";
import { newestCompDate, recencyLine } from "@/lib/accuracy";

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
 * Shown when no property-level valuation could be produced.
 *
 * Deliberately shows NO number. The earlier version of this path displayed a
 * ZIP-code average, which meant every home in a ZIP returned the same figure
 * regardless of size or condition. Labelling it as an area estimate did not
 * make it a good thing to show a homeowner.
 *
 * Instead the screen commits to the thing the funnel actually converts on —
 * an agent-prepared CMA. The lead is still captured and pushed to the CRM, so
 * nothing is lost commercially by omitting the estimate.
 */
export default function PreparingValuation({ address, valuation, lead, onStartOver }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);

  // Two reasons to be on this screen, and they promise different things.
  // "mailed_mode" is the deliberate product: a report is being prepared and
  // posted. Everything else is a genuine failure to value the property, where
  // the honest commitment is a CMA rather than a printed report.
  const mailed = valuation.degradedCode === "mailed_mode";
  const comps = valuation.comps ?? [];

  const streetViewUrl =
    valuation.streetViewUrl ?? `/api/streetview?location=${encodeURIComponent(address.full)}`;
  const [imgError, setImgError] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await fetch("/api/email-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: lead.email,
          address,
          estimate: null,
          confidence: valuation.confidence,
          source: valuation.source,
          degraded: true,
          degradedReason: valuation.degradedReason,
        }),
      });
    } catch { /* the lead was already captured at the gate */ }
    setLoading(false);
    setConfirmed(true);
  };

  const TEL = `tel:${agent.phone.replace(/[^\d+]/g, "")}`;

  /*
   * HOW OLD THE EVIDENCE IS, STATED.
   *
   * This screen is the mailed-CMA path, so these comps are what an agent
   * approves a letter from. Maryland's state feed publishes about a quarter
   * behind — a letter posted in July built from April sales is not wrong, but
   * whoever signs it needs to know that before it goes out, and so does the
   * homeowner who receives it.
   */
  const recency = recencyLine(newestCompDate(comps));
  const streetLine = `${address.streetNumber} ${address.streetName}`.trim() || address.full;

  const COVERS = [
    {
      title: "Recent comparable sales",
      body: `What similar homes near ${address.streetName || "you"} have actually closed at in the last few months.`,
    },
    {
      title: "Adjustments for your home",
      body: "Size, condition, upgrades and lot — the factors an automated tool can't see from the street.",
    },
    {
      title: "Current buyer demand",
      body: `How quickly homes are moving in ${address.zipCode || address.city || "your area"}, and at what share of asking price.`,
    },
    {
      title: "A pricing strategy",
      body: "Where to list to attract offers quickly without leaving money on the table.",
    },
  ];

  return (
    <div className="animate-fade-in w-full">
      <header>
        <p className="eyebrow">{mailed ? "Report in preparation" : "Being prepared by hand"}</p>
        <h2 className="mt-3 font-serif text-4xl md:text-[2.75rem] leading-[1.1] text-ink">
          {mailed
            ? "Your valuation report is on its way"
            : "Your valuation is being prepared personally"}
        </h2>
        <p className="mt-4 text-lg text-ink">{streetLine}</p>
        <p className="text-ink-muted">
          {address.city}
          {address.city ? ", " : ""}
          {address.state} {address.zipCode}
        </p>

        <p className="mt-5 text-[15px] leading-relaxed text-ink-muted max-w-2xl">
          {mailed ? (
            <>
              {agent.name} is preparing a full valuation report for {streetLine} and will mail
              it to you for review — built by hand from the sales below rather than generated
              automatically.
            </>
          ) : (
            <>
              There were not enough comparable sales on public record near this address to
              publish a figure worth trusting, so no number is being shown. {agent.name} is
              reviewing the area personally and you will have a full comparative market
              analysis within 24 hours.
            </>
          )}
        </p>
      </header>

      {!imgError && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={streetViewUrl}
          alt={`Street view of ${address.full}`}
          className="mt-8 w-full h-52 md:h-64 object-cover rounded-lg border border-rule"
          onError={() => setImgError(true)}
        />
      )}

      {/* ── What arrives ───────────────────────────────────────────── */}
      <section className="mt-10">
        <h3 className="font-serif text-2xl text-ink">What the analysis covers</h3>
        <dl className="mt-5 grid sm:grid-cols-2 gap-x-10 gap-y-6">
          {COVERS.map(item => (
            <div key={item.title} className="border-t border-rule pt-4">
              <dt className="text-[15px] font-medium text-ink">{item.title}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-ink-muted">{item.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── Actions ────────────────────────────────────────────────── */}
      <div className="mt-8">
        {confirmed ? (
          <div className="card rounded-md px-5 py-4">
            <p className="text-[15px] text-ink font-medium">Request confirmed</p>
            <p className="mt-1 text-[15px] text-ink-muted">
              {mailed
                ? `Your report is being prepared and will be posted to ${streetLine}.`
                : `${agentFirstName} will be in touch at ${lead.email} within 24 hours.`}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="h-12 inline-flex items-center px-6 bg-navy hover:bg-navy-light text-white font-semibold rounded-md text-[15px] transition-colors disabled:opacity-60"
            >
              {loading ? "Confirming…" : "Confirm my request"}
            </button>
            <a
              href={TEL}
              className="h-12 inline-flex items-center px-6 border border-ink/25 hover:border-navy text-ink font-medium rounded-md text-[15px] transition-colors"
            >
              Call {agentFirstName} — {agent.phone}
            </a>
          </div>
        )}
      </div>

      {/* The sales the posted report is built from.

          Shown WITHOUT a headline figure on purpose. These are public record
          and verifiable, so they make no accuracy claim of their own, and they
          are what an agent actually opens with — "here is what sold near you".
          The number follows on paper, reviewed by a person. */}
      {comps.length > 0 && (
        <section className="mt-12">
          <h3 className="font-serif text-2xl text-ink">
            Recent sales near {address.streetName || "your home"}
          </h3>
          <p className="mt-2 text-[15px] text-ink-muted max-w-2xl">
            Every one is public record, and these are what the report is built from. Each
            will be adjusted for how it differs from your home — size, condition, lot and
            timing.
          </p>
          {recency && <p className="mt-2 text-[15px] text-ink-muted max-w-2xl">{recency}</p>}

          {/* "Sold" folds into the address subline below `sm` rather than
              making the table scroll sideways off a phone screen. */}
          <div className="mt-6 card rounded-lg overflow-hidden">
            <table className="w-full text-[15px]">
              <thead>
                <tr className="bg-canvas border-b border-rule text-left">
                  <th scope="col" className="font-medium text-ink-muted px-3 sm:px-5 py-3">
                    Address
                  </th>
                  <th scope="col" className="hidden sm:table-cell font-medium text-ink-muted px-4 py-3">
                    Sold
                  </th>
                  <th scope="col" className="font-medium text-ink-muted px-3 sm:px-5 py-3 text-right">
                    Sale price
                  </th>
                </tr>
              </thead>
              <tbody>
                {comps.slice(0, 6).map(c => (
                  <tr key={`${c.address}-${c.soldDate}`} className="border-b border-rule last:border-0">
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
                        </span>
                      </span>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3.5 text-ink-muted whitespace-nowrap tnum">
                      {c.monthsAgo === 0 ? "This month" : `${c.monthsAgo} mo ago`}
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 text-right text-ink font-medium tnum whitespace-nowrap">
                      {formatCurrency(c.soldPrice)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
            <p className="eyebrow mb-2">Prepared by</p>
            <h3 className="font-serif text-2xl text-ink">{agent.name}</h3>
            <p className="mt-1 text-ink-muted">{agent.brokerage}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px]">
              <a href={TEL} className="text-navy font-medium hover:underline">
                {agent.phone}
              </a>
              <a href={`mailto:${agent.email}`} className="text-navy font-medium hover:underline">
                {agent.email}
              </a>
              <span className="text-ink-faint text-sm">{agent.license}</span>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-10 pt-6 border-t border-rule">
        <button onClick={onStartOver} className="text-sm font-medium text-navy hover:underline">
          Look up a different address
        </button>
      </div>
    </div>
  );
}
