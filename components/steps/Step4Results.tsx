"use client";

import Image from "next/image";
import { AddressData, LeadData, ValuationData } from "../HomeValuationFlow";

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

function formatDate(dateStr: string): string {
  if (!dateStr) return "Recently";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const config = {
    high: { label: "High Confidence", color: "text-green-400", bg: "bg-green-400/10 border-green-400/30", dot: "bg-green-400", desc: "Based on strong comparable sales data" },
    medium: { label: "Medium Confidence", color: "text-gold", bg: "bg-gold/10 border-gold/30", dot: "bg-gold", desc: "Based on available market data" },
    low: { label: "Estimate Only", color: "text-orange-400", bg: "bg-orange-400/10 border-orange-400/30", dot: "bg-orange-400", desc: "Limited data available — CMA recommended" },
  };
  const c = config[confidence as keyof typeof config] || config.medium;

  return (
    <div className={`inline-flex items-center gap-2 ${c.bg} border rounded-full px-3 py-1.5 mt-2`}>
      <div className={`w-2 h-2 rounded-full ${c.dot} animate-pulse`} />
      <span className={`${c.color} text-xs font-semibold`}>{c.label}</span>
      <span className="text-white/40 text-xs">· {c.desc}</span>
    </div>
  );
}

export default function Step4Results({ address, valuation, lead, onStartOver }: Props) {
  const CMA_URL = `mailto:ccurrie@ttrsir.com?subject=${encodeURIComponent(`Free CMA Request — ${address.full}`)}&body=${encodeURIComponent(`Hi Candee,\n\nI'd like to request a free CMA for ${address.full}.\n\nName: ${lead.firstName} ${lead.lastName}\nPhone: ${lead.phone}\n\nThank you!`)}`;

  return (
    <div className="animate-slide-up space-y-4">
      {/* Header */}
      <div className="text-center mb-2">
        <p className="text-gold/80 text-sm font-medium uppercase tracking-widest mb-2">
          ✨ Your Results Are In
        </p>
        <h2 className="text-2xl font-bold text-white">
          {address.streetNumber} {address.streetName}
        </h2>
        <p className="text-white/40 text-sm">{address.city}, {address.state} {address.zipCode}</p>
      </div>

      {/* Main valuation card */}
      <div className="glass rounded-2xl p-6 md:p-8 gold-border relative overflow-hidden">
        {/* Background accent */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-gold/5 rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />

        <p className="text-white/50 text-sm uppercase tracking-widest mb-3 font-medium">
          Estimated Market Value
        </p>

        {/* Value range */}
        <div className="flex flex-col md:flex-row md:items-end gap-2 md:gap-4 mb-3">
          <p className="text-4xl md:text-5xl font-bold text-white">
            {formatCurrency(valuation.low)}
          </p>
          <div className="flex items-center gap-3">
            <div className="hidden md:block w-8 h-px bg-gold/50" />
            <span className="text-white/40 text-sm">to</span>
            <div className="hidden md:block w-8 h-px bg-gold/50" />
          </div>
          <p className="text-4xl md:text-5xl font-bold text-gold">
            {formatCurrency(valuation.high)}
          </p>
        </div>

        <p className="text-white/50 text-sm">
          Midpoint estimate:{" "}
          <span className="text-white font-semibold">{formatCurrency(valuation.estimate)}</span>
        </p>

        <ConfidenceBadge confidence={valuation.confidence} />

        {valuation.source === "estimate" && (
          <div className="mt-4 p-3 bg-white/5 rounded-xl border border-white/10">
            <p className="text-white/40 text-xs">
              📊 This estimate is based on recent sold prices per square foot in{" "}
              {address.zipCode ? `zip code ${address.zipCode}` : "your area"}. For a precise valuation, request a free CMA below.
            </p>
          </div>
        )}
      </div>

      {/* Comparable Sales */}
      {valuation.comps && valuation.comps.length > 0 && (
        <div className="glass rounded-2xl p-6 gold-border">
          <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
            <span className="text-gold">📍</span>
            Recent Nearby Sales
          </h3>
          <div className="space-y-3">
            {valuation.comps.slice(0, 3).map((comp, i) => (
              <div key={i} className="bg-white/5 rounded-xl p-4 border border-white/10 hover:border-gold/30 transition-all">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                  <div>
                    <p className="text-white font-medium text-sm">{comp.address}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      {comp.beds > 0 && (
                        <span className="text-white/40 text-xs flex items-center gap-1">
                          🛏 {comp.beds} bed
                        </span>
                      )}
                      {comp.baths > 0 && (
                        <span className="text-white/40 text-xs flex items-center gap-1">
                          🚿 {comp.baths} bath
                        </span>
                      )}
                      {comp.sqft > 0 && (
                        <span className="text-white/40 text-xs">
                          {comp.sqft.toLocaleString()} sqft
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right md:text-right">
                    <p className="text-gold font-bold text-lg">{formatCurrency(comp.soldPrice)}</p>
                    <p className="text-white/30 text-xs">Sold {formatDate(comp.soldDate)}</p>
                    {comp.pricePerSqft && (
                      <p className="text-white/20 text-xs">${comp.pricePerSqft}/sqft</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {valuation.source === "estimate" && (
            <p className="text-white/25 text-xs mt-3 text-center">
              * Comparable properties are representative of the local market
            </p>
          )}
        </div>
      )}

      {/* Agent CTA Card */}
      <div className="rounded-2xl p-6 md:p-8 border-2 border-gold/40 bg-gradient-to-br from-gold/10 to-navy">
        <div className="flex flex-col md:flex-row gap-5 md:gap-6">
          {/* Headshot */}
          <div className="flex-shrink-0">
            <div className="relative w-20 h-20 md:w-24 md:h-24 rounded-full overflow-hidden border-2 border-gold/50 mx-auto md:mx-0">
              <Image
                src="/candee-headshot.png"
                alt="Candee Currie"
                fill
                className="object-cover object-top"
                sizes="96px"
              />
            </div>
          </div>

          {/* Info */}
          <div className="flex-1 text-center md:text-left">
            <p className="text-gold/80 text-xs uppercase tracking-widest font-semibold mb-1">
              Your Local Expert
            </p>
            <h3 className="text-white font-bold text-xl">Candee Currie</h3>
            <p className="text-white/50 text-sm">TTR Sotheby's International Realty</p>

            <div className="flex flex-col md:flex-row gap-2 mt-3">
              <a
                href="tel:+17032036005"
                className="flex items-center justify-center md:justify-start gap-2 text-white/70 hover:text-gold transition-colors text-sm"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.37 2 2 0 0 1 3.91 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
                (703) 203-6005
              </a>
              <a
                href="mailto:ccurrie@ttrsir.com"
                className="flex items-center justify-center md:justify-start gap-2 text-white/70 hover:text-gold transition-colors text-sm"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                ccurrie@ttrsir.com
              </a>
            </div>

            <p className="text-white/40 text-xs mt-2">VA License 0225203164</p>
          </div>
        </div>

        <div className="mt-5 pt-5 border-t border-white/10">
          <p className="text-white font-semibold text-lg mb-1">
            Thinking about selling? Let's talk.
          </p>
          <p className="text-white/50 text-sm mb-4">
            Hi {lead.firstName}! A free CMA gives you a precise, agent-prepared valuation — often $20,000–$40,000 more accurate than automated estimates.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={CMA_URL}
              className="flex-1 gold-gradient text-navy font-bold py-3.5 rounded-xl text-sm text-center transition-all hover:opacity-90 hover:scale-[1.01] shadow-lg shadow-gold/20"
            >
              Get a Free CMA →
            </a>
            <a
              href="tel:+17032036005"
              className="flex-1 bg-white/10 hover:bg-white/15 text-white font-semibold py-3.5 rounded-xl text-sm text-center transition-all border border-white/20 hover:border-white/40"
            >
              📞 Call Candee
            </a>
          </div>
        </div>
      </div>

      {/* Disclaimer + start over */}
      <div className="text-center space-y-3">
        <p className="text-white/20 text-xs max-w-lg mx-auto">
          This estimate is generated from publicly available MLS data and is not a formal appraisal. Actual market value may vary. All data deemed reliable but not guaranteed.
        </p>
        <button
          onClick={onStartOver}
          className="text-white/30 hover:text-white/60 text-xs transition-colors underline"
        >
          Value another property
        </button>
      </div>
    </div>
  );
}
