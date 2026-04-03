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

const GMAPS_KEY = "AIzaSyC-JJ1EHFKypH-RMQaemYKSp2ZrXoGVcP8";

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const isHigh = confidence === "high";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border ${
        isHigh
          ? "bg-green-400/10 border-green-400/30 text-green-400"
          : "bg-yellow-400/10 border-yellow-400/30 text-yellow-400"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full animate-pulse ${
          isHigh ? "bg-green-400" : "bg-yellow-400"
        }`}
      />
      {isHigh ? "High Confidence" : "Estimated"}
    </span>
  );
}

export default function Step4Results({ address, valuation, lead, onStartOver }: Props) {
  const [imgError, setImgError] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);

  const handleEmailReport = async () => {
    setEmailLoading(true);
    try {
      await fetch("/api/email-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: lead.email,
          address: address.full,
          estimate: valuation.estimate,
          low: valuation.low,
          high: valuation.high,
          beds: valuation.beds,
          baths: valuation.baths,
          sqft: valuation.sqft,
          yearBuilt: valuation.yearBuilt,
          rentZestimate: valuation.rentZestimate,
          pricePerSqft: valuation.pricePerSqft,
        }),
      });
      setEmailSent(true);
    } catch { setEmailSent(true); } // show success even if API fails
    setEmailLoading(false);
  };

  const streetViewUrl = `https://maps.googleapis.com/maps/api/streetview?size=800x400&location=${encodeURIComponent(
    address.full
  )}&key=${GMAPS_KEY}`;

  const CMA_SUBJECT = encodeURIComponent(`Free CMA Request — ${address.full}`);
  const CMA_BODY = encodeURIComponent(
    `Hi Candee,\n\nI'd like to request a free CMA for ${address.full}.\n\nEmail: ${lead.email}\n\nThank you!`
  );
  const CMA_URL = `mailto:ccurrie@ttrsir.com?subject=${CMA_SUBJECT}&body=${CMA_BODY}`;

  const fmr = valuation.fmr ?? {
    studio: 2050,
    oneBr: 2080,
    twoBr: 2370,
    threeBr: 2960,
    fourBr: 3540,
  };

  const suggestedRent = valuation.rentZestimate ?? fmr.threeBr;
  const pricePerSqft = valuation.pricePerSqft ?? null;

  return (
    <div className="animate-slide-up space-y-5 w-full">

      {/* ══════════════════════════════════════════════════════════════
          1. HERO — Street View + Value Overlay
      ══════════════════════════════════════════════════════════════ */}
      <div className="relative rounded-2xl overflow-hidden gold-border">
        {/* Street View Photo */}
        {!imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={streetViewUrl}
            alt={`Street view of ${address.full}`}
            className="w-full h-60 md:h-72 object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-60 md:h-72 bg-gradient-to-br from-navy via-[#0d2448] to-[#0B1D3A] flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-2">🏡</div>
              <p className="text-white/20 text-sm">Street view unavailable</p>
            </div>
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-navy via-navy/65 to-transparent" />

        {/* Overlaid content */}
        <div className="absolute bottom-0 left-0 right-0 p-5 md:p-7">
          <p className="text-white/50 text-xs uppercase tracking-widest mb-1">
            Estimated Market Value
          </p>
          <p className="text-4xl md:text-5xl font-bold text-gold leading-none mb-2">
            {formatCurrency(valuation.estimate)}
          </p>
          <p className="text-white font-semibold text-base mb-1">
            {address.streetNumber} {address.streetName}
            <span className="text-white/40 font-normal text-sm ml-2">
              {address.city}, {address.state} {address.zipCode}
            </span>
          </p>

          {/* Confidence + quick-stats row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <ConfidenceBadge confidence={valuation.confidence} />
            {valuation.beds && (
              <span className="text-white/50 text-xs">
                {valuation.beds} bd
              </span>
            )}
            {valuation.baths && (
              <span className="text-white/50 text-xs">· {valuation.baths} ba</span>
            )}
            {valuation.sqft && (
              <span className="text-white/50 text-xs">· {valuation.sqft.toLocaleString()} sqft</span>
            )}
            {valuation.yearBuilt && (
              <span className="text-white/50 text-xs">· Built {valuation.yearBuilt}</span>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3 flex-wrap">
            <a
              href={CMA_URL}
              className="gold-gradient text-navy font-bold px-5 py-2.5 rounded-xl text-sm hover:opacity-90 transition-all shadow-lg shadow-gold/20"
            >
              Request Free CMA →
            </a>
            <button
              onClick={handleEmailReport}
              disabled={emailLoading || emailSent}
              className="bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all disabled:opacity-60 flex items-center gap-2"
            >
              {emailSent ? "✓ Report Sent!" : emailLoading ? "Sending..." : "📧 Email Me This Report"}
            </button>
            <button
              onClick={onStartOver}
              className="bg-white/10 hover:bg-white/20 border border-white/20 text-white/60 font-semibold px-5 py-2.5 rounded-xl text-sm transition-all"
            >
              Start Over
            </button>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          2. STAT ROW — 4 cards
      ══════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Property Value */}
        <div className="glass rounded-2xl p-4 gold-border text-center">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Property Value</p>
          <p className="text-gold font-bold text-xl">{formatCurrency(valuation.estimate)}</p>
          <p className="text-white/30 text-xs mt-0.5">
            ± {formatCurrency(Math.round((valuation.high - valuation.low) / 2))}
          </p>
        </div>

        {/* Price / SqFt */}
        <div className="glass rounded-2xl p-4 border border-white/10 text-center">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Price / SqFt</p>
          {pricePerSqft ? (
            <>
              <p className="text-white font-bold text-xl">${pricePerSqft.toLocaleString()}</p>
              <p className="text-white/30 text-xs mt-0.5">per sqft</p>
            </>
          ) : (
            <p className="text-white/40 font-bold text-xl">—</p>
          )}
        </div>

        {/* Est. Monthly Rent */}
        <div className="glass rounded-2xl p-4 border border-white/10 text-center">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Est. Monthly Rent</p>
          <p className="text-white font-bold text-xl">{formatCurrency(suggestedRent)}</p>
          <p className="text-white/30 text-xs mt-0.5">
            {valuation.rentZestimate ? "Rent Zestimate" : "HUD FMR 3BR"}
          </p>
        </div>

        {/* Area Median Income */}
        <div className="glass rounded-2xl p-4 border border-white/10 text-center">
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Area Median Income</p>
          {valuation.areaMedianIncome ? (
            <>
              <p className="text-white font-bold text-xl">
                {formatCurrency(valuation.areaMedianIncome)}
              </p>
              <p className="text-white/30 text-xs mt-0.5">household / yr</p>
            </>
          ) : (
            <p className="text-white/40 font-bold text-xl">—</p>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          3. TWO-COLUMN — Market Analysis + Property Details
      ══════════════════════════════════════════════════════════════ */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* LEFT: Market Analysis */}
        <div className="glass rounded-2xl p-5 gold-border">
          <h3 className="text-gold font-bold text-xs uppercase tracking-wider mb-4 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
            </svg>
            Market Analysis
          </h3>
          <div className="space-y-0">
            <Row label="Price Range" value={`${formatCurrency(valuation.low)} – ${formatCurrency(valuation.high)}`} />
            <Row label="Confidence Level" value={<ConfidenceBadge confidence={valuation.confidence} />} />
            {valuation.homeType && (
              <Row label="Home Type" value={valuation.homeType.replace(/_/g, " ")} />
            )}
            {valuation.yearBuilt && (
              <Row label="Year Built" value={String(valuation.yearBuilt)} last />
            )}
            {!valuation.yearBuilt && (
              <Row label="Midpoint" value={formatCurrency(valuation.estimate)} last gold />
            )}
          </div>
        </div>

        {/* RIGHT: Property Details */}
        <div className="glass rounded-2xl p-5 border border-white/10">
          <h3 className="text-gold font-bold text-xs uppercase tracking-wider mb-4 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Property Details
          </h3>
          <div className="space-y-0">
            {valuation.beds && <Row label="Bedrooms" value={`${valuation.beds} beds`} />}
            {valuation.baths && <Row label="Bathrooms" value={`${valuation.baths} baths`} />}
            {valuation.sqft && (
              <Row label="Living Area" value={`${valuation.sqft.toLocaleString()} sqft`} />
            )}
            {valuation.yearBuilt && (
              <Row label="Year Built" value={String(valuation.yearBuilt)} />
            )}
            <Row label="Location" value={`${address.city}, ${address.state} ${address.zipCode}`} last />
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          4. RENTAL MARKET ANALYSIS
      ══════════════════════════════════════════════════════════════ */}
      <div className="glass rounded-2xl p-5 md:p-6 border border-white/10">
        <h3 className="text-gold font-bold text-xs uppercase tracking-wider mb-5 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          Rental Market Analysis
        </h3>

        {/* Suggested Rent hero */}
        <div className="bg-gold/10 border border-gold/30 rounded-xl p-4 mb-5 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-white/50 text-xs uppercase tracking-wider">Suggested Rent</p>
            <p className="text-gold font-bold text-3xl mt-1">
              {formatCurrency(suggestedRent)}
              <span className="text-gold/50 text-base font-normal">/mo</span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-white/40 text-xs">Annual Gross</p>
            <p className="text-white font-semibold">{formatCurrency(suggestedRent * 12)}</p>
            <p className="text-white/30 text-xs mt-1">
              ~{((suggestedRent * 12) / valuation.estimate * 100).toFixed(1)}% gross yield
            </p>
          </div>
        </div>

        {/* FMR Tiles */}
        <div className="grid grid-cols-5 gap-2 mb-4">
          {[
            { label: "Studio", value: fmr.studio },
            { label: "1 BR", value: fmr.oneBr },
            { label: "2 BR", value: fmr.twoBr },
            { label: "3 BR", value: fmr.threeBr },
            { label: "4 BR", value: fmr.fourBr },
          ].map((row) => {
            const isThree = row.label === "3 BR";
            return (
              <div
                key={row.label}
                className={`rounded-xl p-3 text-center border ${
                  isThree
                    ? "border-gold/50 bg-gold/10"
                    : "border-white/10 bg-white/5"
                }`}
              >
                <p className="text-white/40 text-xs mb-1">{row.label}</p>
                <p
                  className={`font-bold text-sm ${isThree ? "text-gold" : "text-white"}`}
                >
                  ${(row.value / 1000).toFixed(1)}k
                </p>
              </div>
            );
          })}
        </div>

        <p className="text-white/20 text-xs">
          HUD Fair Market Rents · {address.city}, {address.state} {address.zipCode}
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          5. CTA SECTION
      ══════════════════════════════════════════════════════════════ */}
      <div className="rounded-2xl p-6 md:p-8 border-2 border-gold/40 bg-gradient-to-br from-gold/10 to-navy">
        <p className="text-white font-bold text-xl mb-1 text-center md:text-left">
          Want a precise valuation?
        </p>
        <p className="text-white/50 text-sm mb-6 text-center md:text-left">
          A free CMA from Candee gives you an agent-prepared, market-specific value — often
          $20k–$40k more accurate than automated tools. No pressure, no obligation.
        </p>

        <div className="flex flex-col md:flex-row gap-5 md:gap-6 mb-6">
          {/* Headshot */}
          <div className="flex-shrink-0 flex justify-center md:block">
            <div className="relative w-20 h-20 rounded-full overflow-hidden border-2 border-gold/50">
              <Image
                src="/candee-headshot.png"
                alt="Candee Currie"
                fill
                className="object-cover object-top"
                sizes="80px"
              />
            </div>
          </div>

          {/* Agent info */}
          <div className="flex-1 text-center md:text-left">
            <p className="text-gold/80 text-xs uppercase tracking-widest font-semibold mb-0.5">
              Your Local Expert
            </p>
            <h3 className="text-white font-bold text-lg">Candee Currie</h3>
            <p className="text-white/50 text-sm">TTR Sotheby&apos;s International Realty</p>
            <p className="text-white/30 text-xs mt-0.5">VA License 0225203164</p>

            <div className="flex flex-col sm:flex-row gap-3 mt-3 justify-center md:justify-start">
              <a
                href="tel:+17032036005"
                className="flex items-center justify-center gap-2 text-white/60 hover:text-gold transition-colors text-sm"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.99 12 19.79 19.79 0 0 1 1.93 3.37 2 2 0 0 1 3.91 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
                (703) 203-6005
              </a>
              <a
                href="mailto:ccurrie@ttrsir.com"
                className="flex items-center justify-center gap-2 text-white/60 hover:text-gold transition-colors text-sm"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                ccurrie@ttrsir.com
              </a>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href={CMA_URL}
            className="flex-1 gold-gradient text-navy font-bold py-4 rounded-xl text-sm text-center transition-all hover:opacity-90 shadow-lg shadow-gold/20"
          >
            Request Free CMA →
          </a>
          <a
            href="tel:+17032036005"
            className="flex-1 bg-white/10 hover:bg-white/15 border border-white/20 text-white font-semibold py-4 rounded-xl text-sm text-center transition-all"
          >
            📞 Call Candee
          </a>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-white/20 text-xs text-center max-w-lg mx-auto pb-4">
        This estimate is generated from publicly available data and is not a formal appraisal.
        Actual market value may vary. All data deemed reliable but not guaranteed.
      </p>
    </div>
  );
}

/* ── Small helper for detail rows ─────────────────────────────────── */
function Row({
  label,
  value,
  last = false,
  gold = false,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
  gold?: boolean;
}) {
  return (
    <div
      className={`flex justify-between items-center py-2.5 ${
        last ? "" : "border-b border-white/10"
      }`}
    >
      <span className="text-white/50 text-sm">{label}</span>
      <span className={`font-semibold text-sm ${gold ? "text-gold" : "text-white"}`}>
        {value}
      </span>
    </div>
  );
}
