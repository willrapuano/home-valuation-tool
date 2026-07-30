"use client";

import { useState } from "react";
import Image from "next/image";
import { AddressData, LeadData, ValuationData } from "../HomeValuationFlow";

interface Props {
  address: AddressData;
  valuation: ValuationData;
  lead: LeadData;
  onStartOver: () => void;
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

  const CMA_SUBJECT = encodeURIComponent(`CMA Request — ${address.full}`);
  const CMA_BODY = encodeURIComponent(
    `Hi Candee,\n\nI'd like a comparative market analysis for ${address.full}.\n\nEmail: ${lead.email}\n\nThank you!`
  );
  const CMA_URL = `mailto:ccurrie@ttrsir.com?subject=${CMA_SUBJECT}&body=${CMA_BODY}`;

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
    <div className="animate-slide-up space-y-5 w-full">
      {/* Hero — property image + commitment, no number */}
      <div className="relative rounded-2xl overflow-hidden gold-border">
        {!imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={streetViewUrl}
            alt={`Street view of ${address.full}`}
            className="w-full h-52 md:h-64 object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-52 md:h-64 bg-gradient-to-br from-navy via-[#0d2448] to-[#0B1D3A] flex items-center justify-center">
            <div className="text-4xl">🏡</div>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-navy via-navy/70 to-transparent" />

        <div className="absolute bottom-0 left-0 right-0 p-5 md:p-7">
          <div className="inline-flex items-center gap-2 bg-gold/15 border border-gold/40 text-gold text-xs font-semibold px-3 py-1.5 rounded-full mb-3 uppercase tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
            In progress
          </div>
          <h2 className="text-2xl md:text-3xl font-bold text-white leading-tight mb-2">
            {mailed ? "Your valuation report is on its way" : "Your valuation is being prepared"}
          </h2>
          <p className="text-white font-semibold text-sm">
            {address.streetNumber} {address.streetName}
            <span className="text-white/40 font-normal ml-2">
              {address.city}, {address.state} {address.zipCode}
            </span>
          </p>
        </div>
      </div>

      {/* What Candee is doing */}
      <div className="glass rounded-2xl p-5 md:p-6 gold-border">
        <p className="text-white/70 text-sm leading-relaxed mb-5">
          {mailed ? (
            <>
              Candee is preparing a full valuation report for {address.streetNumber}{" "}
              {address.streetName} and will mail it to you for review — prepared by hand
              from the sales below, not generated automatically.
            </>
          ) : (
            <>
              Candee is personally reviewing recent sales near your home. You&apos;ll have a
              full comparative market analysis within 24 hours — prepared by hand, not
              generated automatically.
            </>
          )}
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          {COVERS.map(item => (
            <div key={item.title} className="flex gap-3">
              <svg
                className="w-4 h-4 text-gold shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <div>
                <p className="text-white font-semibold text-sm">{item.title}</p>
                <p className="text-white/45 text-xs mt-0.5 leading-relaxed">{item.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mt-6">
          {confirmed ? (
            <div className="flex-1 bg-gold/10 border border-gold/30 rounded-xl px-4 py-3">
              <p className="text-gold text-sm font-semibold">✓ Request confirmed</p>
              <p className="text-white/60 text-xs mt-1">
                {mailed
                  ? `Your report is being prepared and will be mailed to ${address.streetNumber} ${address.streetName}.`
                  : `Candee will be in touch at ${lead.email} within 24 hours.`}
              </p>
            </div>
          ) : (
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 gold-gradient text-navy font-bold py-4 rounded-xl text-sm transition-all hover:opacity-90 disabled:opacity-60 shadow-lg shadow-gold/20"
            >
              {loading ? "Confirming..." : "Confirm my request →"}
            </button>
          )}
          <a
            href="tel:+17032036005"
            className="flex-1 bg-white/10 hover:bg-white/15 border border-white/20 text-white font-semibold py-4 rounded-xl text-sm text-center transition-all"
          >
            📞 Call Candee now
          </a>
        </div>
      </div>

      {/* The sales the posted report is built from.

          Shown WITHOUT a headline figure on purpose. These are public record
          and verifiable, so they make no accuracy claim of their own, and they
          are what an agent actually opens with — "here is what sold near you".
          The number follows on paper, reviewed by a person. */}
      {comps.length > 0 && (
        <div className="glass rounded-2xl p-5 md:p-6 border border-white/10">
          <p className="text-gold font-bold text-xs uppercase tracking-wider mb-1">
            Recent sales near {address.streetName || "your home"}
          </p>
          <p className="text-white/40 text-xs mb-4">
            Every one is public record. These are what the report is built from.
          </p>

          <ul className="space-y-2">
            {comps.slice(0, 5).map(c => (
              <li
                key={`${c.address}-${c.soldDate}`}
                className="bg-white/5 border border-white/10 rounded-xl px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-white/90 text-sm font-medium">{c.address}</span>
                  <span className="text-white font-semibold text-sm whitespace-nowrap">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                      maximumFractionDigits: 0,
                    }).format(c.soldPrice)}
                  </span>
                </div>
                <p className="text-white/40 text-xs mt-1">
                  {c.distanceMiles} mi away
                  {" · "}
                  {c.monthsAgo === 0 ? "sold this month" : `sold ${c.monthsAgo}mo ago`}
                  {c.sqft ? ` · ${c.sqft.toLocaleString()} sqft` : ""}
                  {c.beds ? ` · ${c.beds} bd` : ""}
                </p>
              </li>
            ))}
          </ul>

          <p className="text-white/30 text-xs mt-3">
            Your report adjusts each of these for how it differs from your home — size,
            condition, lot and timing.
          </p>
        </div>
      )}

      {/* Agent card */}
      <div className="rounded-2xl p-6 border-2 border-gold/40 bg-gradient-to-br from-gold/10 to-navy">
        <div className="flex flex-col md:flex-row gap-5 items-center md:items-start">
          <div className="relative w-20 h-20 rounded-full overflow-hidden border-2 border-gold/50 shrink-0">
            <Image
              src="/candee-headshot.png"
              alt="Candee Currie"
              fill
              className="object-cover object-top"
              sizes="80px"
            />
          </div>
          <div className="flex-1 text-center md:text-left">
            <p className="text-gold/80 text-xs uppercase tracking-widest font-semibold mb-0.5">
              Your Local Expert
            </p>
            <h3 className="text-white font-bold text-lg">Candee Currie</h3>
            <p className="text-white/50 text-sm">TTR Sotheby&apos;s International Realty</p>
            <p className="text-white/30 text-xs mt-0.5">VA License 0225203164</p>
            <div className="flex flex-col sm:flex-row gap-3 mt-3 justify-center md:justify-start">
              <a href="tel:+17032036005" className="text-white/60 hover:text-gold transition-colors text-sm">
                (703) 203-6005
              </a>
              <a href={CMA_URL} className="text-white/60 hover:text-gold transition-colors text-sm">
                ccurrie@ttrsir.com
              </a>
            </div>
          </div>
        </div>
      </div>

      <button
        onClick={onStartOver}
        className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 font-medium py-3 rounded-xl text-sm transition-all"
      >
        Look up a different address
      </button>
    </div>
  );
}
