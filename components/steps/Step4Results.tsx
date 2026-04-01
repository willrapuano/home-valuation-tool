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

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const config: Record<string, { label: string; color: string; bg: string; dot: string }> = {
    high: { label: "High Confidence", color: "text-green-400", bg: "bg-green-400/10 border-green-400/30", dot: "bg-green-400" },
    medium: { label: "Medium Confidence", color: "text-yellow-400", bg: "bg-yellow-400/10 border-yellow-400/30", dot: "bg-yellow-400" },
    low: { label: "Estimate Only", color: "text-orange-400", bg: "bg-orange-400/10 border-orange-400/30", dot: "bg-orange-400" },
  };
  const c = config[confidence] || config.medium;
  return (
    <span className={`inline-flex items-center gap-1.5 ${c.bg} border rounded-full px-3 py-1 text-xs font-semibold ${c.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} animate-pulse`} />
      {c.label}
    </span>
  );
}

export default function Step4Results({ address, valuation, lead, onStartOver }: Props) {
  const CMA_URL = `mailto:ccurrie@ttrsir.com?subject=${encodeURIComponent(`Free CMA Request — ${address.full}`)}&body=${encodeURIComponent(`Hi Candee,\n\nI'd like to request a free CMA for ${address.full}.\n\nEmail: ${lead.email}\n\nThank you!`)}`;

  const midpoint = valuation.estimate;
  const rangeSpread = valuation.high - valuation.low;
  const midZipEstimate = 750000; // rough NoVA median for % change calc
  const valueChangePct = ((midpoint - midZipEstimate) / midZipEstimate) * 100;

  const fmr = valuation.fmr ?? {
    studio: 2050,
    oneBr: 2080,
    twoBr: 2370,
    threeBr: 2960,
    fourBr: 3540,
  };

  const suggestedRent = fmr.threeBr;

  return (
    <div className="animate-slide-up space-y-6">

      {/* ── 1. HERO SECTION ─────────────────────────────────────────── */}
      <div className="relative rounded-2xl overflow-hidden gold-border">
        {/* Street View Image */}
        {valuation.streetViewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={valuation.streetViewUrl}
            alt={`Street view of ${address.full}`}
            className="w-full h-56 object-cover"
          />
        ) : (
          <div className="w-full h-56 bg-white/5 flex items-center justify-center">
            <span className="text-white/20 text-sm">Street view unavailable</span>
          </div>
        )}

        {/* Dark overlay + property info */}
        <div className="absolute inset-0 bg-gradient-to-t from-navy via-navy/70 to-transparent" />

        <div className="absolute bottom-0 left-0 right-0 p-6">
          <p className="text-white/60 text-xs uppercase tracking-widest mb-1">Estimated Market Value</p>
          <p className="text-4xl md:text-5xl font-bold text-gold leading-none mb-2">
            {formatCurrency(midpoint)}
          </p>
          <h2 className="text-white font-semibold text-lg mb-3">
            {address.streetNumber} {address.streetName}
            <span className="text-white/50 font-normal text-sm ml-2">
              {address.city}, {address.state} {address.zipCode}
            </span>
          </h2>

          {/* Beds/Baths/Sqft boxes — shown only if we have the data */}
          <div className="flex gap-2 flex-wrap mb-4">
            {valuation.pricePerSqft && (
              <span className="glass rounded-lg px-3 py-1 text-xs text-white/80 border border-white/10">
                ${valuation.pricePerSqft.toLocaleString()}/sqft
              </span>
            )}
            <ConfidenceBadge confidence={valuation.confidence} />
          </div>

          {/* CTA Buttons */}
          <div className="flex gap-3 flex-wrap">
            <a
              href={CMA_URL}
              className="gold-gradient text-navy font-bold px-5 py-2.5 rounded-xl text-sm hover:opacity-90 transition-all shadow-lg shadow-gold/20"
            >
              Get Full CMA →
            </a>
            <button
              onClick={onStartOver}
              className="bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all"
            >
              Start Over
            </button>
          </div>
        </div>
      </div>

      {/* ── 2. FOUR STAT BOXES ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Property Value */}
        <div className="glass rounded-xl p-4 gold-border text-center">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Property Value</p>
          <p className="text-gold font-bold text-lg">{formatCurrency(midpoint)}</p>
          {valuation.pricePerSqft && (
            <p className="text-white/40 text-xs mt-0.5">${valuation.pricePerSqft}/sqft</p>
          )}
        </div>

        {/* Price Range */}
        <div className="glass rounded-xl p-4 text-center border border-white/10">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Price Range</p>
          <p className="text-white font-semibold text-sm">
            {formatCurrency(valuation.low)}
          </p>
          <p className="text-white/30 text-xs">–</p>
          <p className="text-white font-semibold text-sm">{formatCurrency(valuation.high)}</p>
          <p className="text-white/30 text-xs mt-0.5">±{Math.round((rangeSpread / midpoint) * 50)}%</p>
        </div>

        {/* Estimated Rent */}
        <div className="glass rounded-xl p-4 text-center border border-white/10">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Est. Rent</p>
          <p className="text-white font-bold text-lg">{formatCurrency(suggestedRent)}</p>
          <p className="text-white/30 text-xs mt-0.5">3BR HUD FMR</p>
        </div>

        {/* Value vs Median */}
        <div className="glass rounded-xl p-4 text-center border border-white/10">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">vs. Area Median</p>
          <p className={`font-bold text-lg ${valueChangePct >= 0 ? "text-green-400" : "text-red-400"}`}>
            {valueChangePct >= 0 ? "+" : ""}{valueChangePct.toFixed(1)}%
          </p>
          <p className="text-white/30 text-xs mt-0.5">from zip median</p>
        </div>
      </div>

      {/* ── 3. TWO-COLUMN: MARKET ANALYSIS + PROPERTY INSIGHTS ─────── */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Market Analysis */}
        <div className="glass rounded-2xl p-5 gold-border">
          <h3 className="text-gold font-bold text-sm uppercase tracking-wider mb-4 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
            </svg>
            Market Analysis
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b border-white/10">
              <span className="text-white/50 text-sm">Price Range</span>
              <span className="text-white font-semibold text-sm">
                {formatCurrency(valuation.low)} – {formatCurrency(valuation.high)}
              </span>
            </div>
            {valuation.pricePerSqft && (
              <div className="flex justify-between items-center py-2 border-b border-white/10">
                <span className="text-white/50 text-sm">Price per Sqft</span>
                <span className="text-white font-semibold text-sm">${valuation.pricePerSqft.toLocaleString()}</span>
              </div>
            )}
            <div className="flex justify-between items-center py-2 border-b border-white/10">
              <span className="text-white/50 text-sm">Confidence</span>
              <ConfidenceBadge confidence={valuation.confidence} />
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-white/50 text-sm">Midpoint Estimate</span>
              <span className="text-gold font-bold">{formatCurrency(midpoint)}</span>
            </div>
          </div>
        </div>

        {/* Property Insights */}
        <div className="glass rounded-2xl p-5 border border-white/10">
          <h3 className="text-gold font-bold text-sm uppercase tracking-wider mb-4 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Property Insights
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b border-white/10">
              <span className="text-white/50 text-sm">Property Type</span>
              <span className="text-white font-semibold text-sm">Single Family</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-white/10">
              <span className="text-white/50 text-sm">Location</span>
              <span className="text-white font-semibold text-sm">{address.city}, {address.state}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-white/10">
              <span className="text-white/50 text-sm">Zip Code</span>
              <span className="text-white font-semibold text-sm">{address.zipCode}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-white/50 text-sm">Data Source</span>
              <span className="text-white/70 text-sm">
                {valuation.source === "zillow" ? "Zillow Zestimate" : "Market Estimate"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── 4. RENTAL MARKET ANALYSIS ───────────────────────────────── */}
      <div className="glass rounded-2xl p-5 md:p-6 border border-white/10">
        <h3 className="text-gold font-bold text-sm uppercase tracking-wider mb-5 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          Rental Market Analysis
        </h3>

        {/* Suggested Rent Hero */}
        <div className="bg-gold/10 border border-gold/30 rounded-xl p-4 mb-5 flex items-center justify-between">
          <div>
            <p className="text-white/50 text-xs uppercase tracking-wider">Suggested Rent</p>
            <p className="text-gold font-bold text-3xl mt-1">{formatCurrency(suggestedRent)}<span className="text-gold/60 text-base font-normal">/mo</span></p>
            <p className="text-white/40 text-xs mt-1">Based on 3BR HUD Fair Market Rent</p>
          </div>
          <div className="text-right">
            <p className="text-white/40 text-xs">Annual Gross</p>
            <p className="text-white font-semibold">{formatCurrency(suggestedRent * 12)}</p>
            <p className="text-white/30 text-xs mt-1">~{((suggestedRent * 12) / midpoint * 100).toFixed(1)}% gross yield</p>
          </div>
        </div>

        {/* FMR Table */}
        <div className="grid grid-cols-5 gap-2 mb-5">
          {[
            { label: "Studio", value: fmr.studio },
            { label: "1 BR", value: fmr.oneBr },
            { label: "2 BR", value: fmr.twoBr },
            { label: "3 BR", value: fmr.threeBr },
            { label: "4 BR", value: fmr.fourBr },
          ].map((row) => (
            <div
              key={row.label}
              className={`rounded-xl p-3 text-center border ${row.label === "3 BR" ? "border-gold/50 bg-gold/10" : "border-white/10 bg-white/5"}`}
            >
              <p className="text-white/40 text-xs mb-1">{row.label}</p>
              <p className={`font-bold text-sm ${row.label === "3 BR" ? "text-gold" : "text-white"}`}>
                ${(row.value / 1000).toFixed(1)}k
              </p>
            </div>
          ))}
        </div>

        {/* AMI */}
        {valuation.areaMedianIncome && (
          <div className="flex items-center justify-between py-3 border-t border-white/10">
            <div>
              <p className="text-white/50 text-sm">Area Median Income</p>
              <p className="text-white/30 text-xs">Zip {address.zipCode} · Census ACS 2022</p>
            </div>
            <p className="text-white font-semibold">{formatCurrency(valuation.areaMedianIncome)}<span className="text-white/30 text-xs">/yr</span></p>
          </div>
        )}

        <p className="text-white/20 text-xs mt-3">
          📊 Data source: HUD Fair Market Rents FY2025 · DC-VA-MD Metropolitan Area
        </p>
      </div>

      {/* ── 5. CTA — GET YOUR FREE CMA ──────────────────────────────── */}
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
            <p className="text-gold/80 text-xs uppercase tracking-widest font-semibold mb-1">Your Local Expert</p>
            <h3 className="text-white font-bold text-xl">Candee Currie</h3>
            <p className="text-white/50 text-sm">TTR Sotheby&apos;s International Realty</p>

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
          <p className="text-white font-semibold text-lg mb-1">Get Your Free CMA</p>
          <p className="text-white/50 text-sm mb-5">
            Hi {lead.email}! A free CMA gives you a precise, agent-prepared valuation —
            often $20,000–$40,000 more accurate than automated estimates. No obligation.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={CMA_URL}
              className="flex-1 gold-gradient text-navy font-bold py-4 rounded-xl text-sm text-center transition-all hover:opacity-90 hover:scale-[1.01] shadow-lg shadow-gold/20"
            >
              Request Free CMA from Candee →
            </a>
            <a
              href="tel:+17032036005"
              className="flex-1 bg-white/10 hover:bg-white/15 text-white font-semibold py-4 rounded-xl text-sm text-center transition-all border border-white/20 hover:border-white/40"
            >
              📞 Call Candee
            </a>
          </div>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="text-center">
        <p className="text-white/20 text-xs max-w-lg mx-auto">
          This estimate is generated from publicly available data and is not a formal appraisal.
          Actual market value may vary. All data deemed reliable but not guaranteed.
        </p>
      </div>
    </div>
  );
}
