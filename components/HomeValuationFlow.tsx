"use client";

import { useState, useCallback } from "react";
import Step1Address from "./steps/Step1Address";
import Step2Loading from "./steps/Step2Loading";
import Step3LeadGate from "./steps/Step3LeadGate";
import Step4Results from "./steps/Step4Results";
import { track } from "@/lib/track";

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
  comps: {
    address: string;
    soldPrice: number;
    beds: number;
    baths: number;
    sqft: number;
    soldDate: string;
    pricePerSqft?: number;
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

export default function HomeValuationFlow() {
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

  return (
    <div className="min-h-screen bg-navy flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full gold-gradient flex items-center justify-center text-navy font-bold text-sm">
            C
          </div>
          <div>
            <p className="text-white font-semibold text-sm leading-none">Candee Currie</p>
            <p className="text-white/50 text-xs">TTR Sotheby's International Realty</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2">
          <StepIndicator current={step} />
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-2xl">
          {step === 1 && (
            <Step1Address onSubmit={handleAddressSubmit} initialError={addressError} />
          )}
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
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 border-t border-white/10 text-center">
        <p className="text-white/30 text-xs">
          © {new Date().getFullYear()} Candee Currie · TTR Sotheby's International Realty ·
          VA License 0225203164 · (703) 203-6005 ·{" "}
          <a href="mailto:ccurrie@ttrsir.com" className="hover:text-gold transition-colors">
            ccurrie@ttrsir.com
          </a>
        </p>
        <p className="text-white/20 text-xs mt-1">
          Estimates are generated from publicly available data and are not a formal appraisal.
          All data is deemed reliable but not guaranteed.
        </p>
      </footer>
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  const steps = [
    { n: 1, label: "Address" },
    { n: 2, label: "Analyzing" },
    { n: 3, label: "Unlock" },
    { n: 4, label: "Results" },
  ];

  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 text-xs transition-all ${
              current >= s.n ? "text-gold" : "text-white/30"
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold border transition-all ${
                current > s.n
                  ? "bg-gold border-gold text-navy"
                  : current === s.n
                  ? "border-gold text-gold"
                  : "border-white/20 text-white/30"
              }`}
            >
              {current > s.n ? "✓" : s.n}
            </div>
            <span className="hidden lg:block">{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-6 h-px transition-all ${current > s.n ? "bg-gold/50" : "bg-white/10"}`} />
          )}
        </div>
      ))}
    </div>
  );
}
