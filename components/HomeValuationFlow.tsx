"use client";

import { useState, useCallback } from "react";
import Landing from "./landing/Landing";
import Step2Loading from "./steps/Step2Loading";
import Step3LeadGate from "./steps/Step3LeadGate";
import Step4Results from "./steps/Step4Results";
import { track } from "@/lib/track";
import { agent } from "@/lib/agent";
import type { MarketPulse } from "@/lib/market-pulse";

export type AddressData = {
  full: string;
  streetNumber: string;
  streetName: string;
  city: string;
  state: string;
  zipCode: string;
  lat?: number;
  lng?: number;
};

export type LeadData = {
  email: string;
};

export type ValuationData = {
  /**
   * Null when no property-level valuation could be produced. In that case the
   * results screen shows the "valuation being prepared" state — we never
   * substitute an area average for a number about this specific home.
   */
  estimate: number | null;
  low: number | null;
  high: number | null;
  confidence: string;
  source: string;
  /** True when no property-level valuation is available. */
  degraded?: boolean;
  degradedReason?: string;
  /** "low_confidence" or "no_data" when nothing was published. */
  degradedCode?: string;
  /** Which public-records source served it. */
  sourceJurisdiction?: string;
  /** 0–1 score behind the confidence bucket. */
  confidenceScore?: number;
  /** How the estimate was reached — used to describe the method to the user. */
  compCount?: number;
  compRadiusMiles?: number;
  lookbackMonths?: number;
  assessedValue?: number;
  /** The sales the estimate is actually built from. See lib/comps/present.ts. */
  comps: {
    address: string;
    soldPrice: number;
    soldDate: string;
    distanceMiles: number;
    monthsAgo: number;
    sqft?: number;
    beds?: number;
    baths?: number;
    yearBuilt?: number;
    adjustedPrice: number;
    adjustments: { label: string; amount: number }[];
  }[];
  streetViewUrl?: string;
  /** Present only when real HUD data was retrieved; null otherwise. */
  fmr?: {
    studio: number;
    oneBr: number;
    twoBr: number;
    threeBr: number;
    fourBr: number;
  } | null;
  areaMedianIncome?: number | null;
  pricePerSqft?: number | null;
  rentZestimate?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  yearBuilt?: number | null;
  homeType?: string | null;
};

type Step = 1 | 2 | 3 | 4;

interface Props {
  /** Live county figures fetched on the server. Null when unavailable. */
  pulse?: MarketPulse | null;
}

export default function HomeValuationFlow({ pulse = null }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [address, setAddress] = useState<AddressData | null>(null);
  const [lead, setLead] = useState<LeadData | null>(null);
  const [valuation, setValuation] = useState<ValuationData | null>(null);
  const [sqft, setSqft] = useState<number | undefined>(undefined);
  const [addressError, setAddressError] = useState<string | null>(null);

  const handleAddressSubmit = useCallback((data: AddressData, estimatedSqft?: number) => {
    setAddress(data);
    setSqft(estimatedSqft);
    setAddressError(null);
    track("address_submitted", { zipCode: data.zipCode });
    setStep(2);
  }, []);

  const handleLoadingComplete = useCallback((data: ValuationData) => {
    setValuation(data);
    // The fork we are measuring: the lead gate reads "Your estimate is ready!"
    // when there is a number and "One last step" when there is not.
    track("valuation_returned", {
      hasEstimate: !data.degraded && data.estimate !== null,
      confidence: data.confidence,
      degradedCode: data.degradedCode,
      jurisdiction: data.sourceJurisdiction,
    });
    setStep(3);
  }, []);

  /** Address wasn't specific enough to look up — send them back to fix it. */
  const handleAddressRejected = useCallback((message: string) => {
    setAddressError(message);
    setAddress(null);
    setStep(1);
  }, []);

  const handleLeadSubmit = useCallback((data: LeadData) => {
    setLead(data);
    // Tagged with the same fork so conversion can be split by it. The email
    // itself is never sent to the events endpoint.
    track("lead_submitted", {
      hasEstimate: valuation ? !valuation.degraded && valuation.estimate !== null : undefined,
      confidence: valuation?.confidence,
      degradedCode: valuation?.degradedCode,
      jurisdiction: valuation?.sourceJurisdiction,
    });
    track("report_viewed", {
      hasEstimate: valuation ? !valuation.degraded && valuation.estimate !== null : undefined,
    });
    setStep(4);
  }, [valuation]);

  const handleStartOver = useCallback(() => {
    setStep(1);
    setAddress(null);
    setLead(null);
    setValuation(null);
    setSqft(undefined);
    setAddressError(null);
  }, []);

  const onLanding = step === 1;

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="border-b border-rule bg-paper">
        <div
          className={`mx-auto flex items-center justify-between gap-4 px-5 sm:px-8 py-4 ${
            onLanding ? "max-w-6xl" : "max-w-3xl"
          }`}
        >
          <a href="/" className="min-w-0">
            <p className="font-serif text-lg text-ink leading-tight">{agent.name}</p>
            {/* Wraps rather than truncating: "TTR SOTHEBY'S INTERNATIONAL…" cut
                off mid-word on a 390px viewport, which is worse than two lines. */}
            <p className="text-[11px] uppercase tracking-[0.13em] text-ink-faint leading-snug">
              {agent.brokerage}
            </p>
          </a>

          {/*
            On the landing page this is a phone number, which is what a
            brokerage site puts here. The step indicator appears only once the
            visitor is inside the flow: showing a four-step funnel to someone
            who has not started one advertises that three more screens are
            coming, and is not something any of the leading tools do.
          */}
          {onLanding ? (
            <a
              href={`tel:${agent.phone.replace(/[^\d+]/g, "")}`}
              className="shrink-0 text-sm font-medium text-navy hover:underline whitespace-nowrap"
            >
              {agent.phone}
            </a>
          ) : (
            <StepIndicator current={step} />
          )}
        </div>
      </header>

      <main className="flex-1">
        {step === 1 && (
          <Landing onSubmit={handleAddressSubmit} initialError={addressError} pulse={pulse} />
        )}

        {step > 1 && (
          <div className="mx-auto w-full max-w-3xl px-5 sm:px-8 py-10 md:py-14">
            {step === 2 && address && (
              <Step2Loading
                address={address}
                sqft={sqft}
                onComplete={handleLoadingComplete}
                onAddressRejected={handleAddressRejected}
              />
            )}
            {step === 3 && address && valuation && (
              <Step3LeadGate
                address={address}
                valuation={valuation}
                onSubmit={handleLeadSubmit}
              />
            )}
            {step === 4 && address && valuation && lead && (
              <Step4Results
                address={address}
                valuation={valuation}
                lead={lead}
                onStartOver={handleStartOver}
              />
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-rule bg-canvas">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 py-10">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6">
            <div>
              <p className="font-serif text-lg text-ink">{agent.name}</p>
              <p className="text-sm text-ink-muted mt-0.5">{agent.brokerage}</p>
              <p className="text-sm text-ink-muted mt-3">
                <a href={`tel:${agent.phone.replace(/[^\d+]/g, "")}`} className="hover:underline">
                  {agent.phone}
                </a>
                <span className="mx-2 text-ink-faint">·</span>
                <a href={`mailto:${agent.email}`} className="hover:underline">
                  {agent.email}
                </a>
              </p>
            </div>
            <p className="text-xs text-ink-faint sm:text-right">
              {agent.license}
              <br />© {new Date().getFullYear()} {agent.name}. Equal Housing Opportunity.
            </p>
          </div>

          <p className="mt-8 pt-6 border-t border-rule text-xs leading-relaxed text-ink-faint max-w-3xl">
            Estimates are produced from publicly available property records and are not a
            formal appraisal, a guarantee of value, or an offer to purchase. Data is deemed
            reliable but is not guaranteed. If your home is currently listed with another
            brokerage, this is not a solicitation.
          </p>
        </div>
      </footer>
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  const steps = [
    { n: 1, label: "Address" },
    { n: 2, label: "Comparing sales" },
    { n: 3, label: "Delivery" },
    { n: 4, label: "Result" },
  ];

  return (
    <ol className="flex items-center gap-2 shrink-0" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.n} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 text-xs ${
              current >= s.n ? "text-ink" : "text-ink-faint"
            }`}
            aria-current={current === s.n ? "step" : undefined}
          >
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold border tnum ${
                current > s.n
                  ? "bg-navy border-navy text-white"
                  : current === s.n
                  ? "border-navy text-navy"
                  : "border-rule text-ink-faint"
              }`}
            >
              {current > s.n ? "✓" : s.n}
            </span>
            <span className="hidden lg:block">{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={`w-5 h-px ${current > s.n ? "bg-navy/40" : "bg-rule"}`}
            />
          )}
        </li>
      ))}
    </ol>
  );
}
