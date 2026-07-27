"use client";

import { useEffect, useState } from "react";
import { AddressData, ValuationData } from "../HomeValuationFlow";

interface Props {
  address: AddressData;
  sqft?: number;
  onComplete: (data: ValuationData) => void;
  onAddressRejected: (message: string) => void;
}

/**
 * Labels shown while the lookup runs. These describe what the tool actually
 * does — it does not search MLS or BrightMLS records.
 */
const LOADING_STEPS = [
  "Verifying address...",
  "Looking up property records...",
  "Checking recent area sales...",
  "Estimating rental potential...",
  "Preparing your estimate...",
];

/**
 * The progress screen used to run on a fixed 14s timeline regardless of how
 * fast the data came back. Now it races the real request: we hold for a short
 * floor so the transition doesn't feel jarring, then move on as soon as the
 * data lands, and give up at the cap.
 */
const MIN_DISPLAY_MS = 2500;
const MAX_DISPLAY_MS = 8000;
const STEP_INTERVAL_MS = 900;

export default function Step2Loading({ address, sqft, onComplete, onAddressRejected }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    // Parse city/state/zip from full address if not set
    const parts = address.full.split(",").map(s => s.trim());
    const stateParts = (parts[2] || parts[1] || "").trim().split(" ").filter(Boolean);
    const resolvedCity = address.city || parts[1] || "";
    const resolvedState = address.state || stateParts[0] || "VA";
    const resolvedZip = address.zipCode || stateParts[1] || "";
    const resolvedStreet = (`${address.streetNumber} ${address.streetName}`.trim()) || parts[0] || address.full;

    // Advance the step label and creep the bar forward on a timer. The bar is
    // capped below 95% so completion always lines up with real data arriving.
    const stepTimer = setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      setCurrentStep(Math.min(Math.floor(elapsed / STEP_INTERVAL_MS), LOADING_STEPS.length - 1));
      setProgress(Math.min(Math.round((elapsed / MAX_DISPLAY_MS) * 90), 90));
    }, 100);

    const finish = async (data: ValuationData) => {
      const remaining = MIN_DISPLAY_MS - (Date.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
      if (cancelled) return;
      setProgress(100);
      await sleep(300);
      if (!cancelled) onComplete(data);
    };

    const run = async () => {
      try {
        const res = await fetch("/api/avm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: resolvedStreet,
            city: resolvedCity,
            state: resolvedState,
            zipCode: resolvedZip,
            fullAddress: address.full,
            sqft,
          }),
          signal: AbortSignal.timeout(MAX_DISPLAY_MS + 4000),
        });

        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        // Address wasn't specific enough — bounce back to step 1 rather than
        // inventing a number for a ZIP we don't have.
        if (res.status === 422 || data?.error === "address_incomplete") {
          onAddressRejected(
            data?.message ??
              "We couldn't determine a ZIP code for that address. Please re-enter it including city, state and ZIP."
          );
          return;
        }

        if (!res.ok) throw new Error(`AVM responded ${res.status}`);

        await finish(data as ValuationData);
      } catch (err) {
        if (cancelled) return;
        console.error("AVM fetch error:", err);
        // Never fabricate a value here. Send them back with an honest message
        // instead of showing a made-up $500k estimate as if it were real.
        onAddressRejected(
          "We couldn't reach our valuation service just now. Please try again in a moment."
        );
      }
    };

    run();

    return () => {
      cancelled = true;
      clearInterval(stepTimer);
    };
  }, [address, sqft, onComplete, onAddressRejected]);

  return (
    <div className="animate-fade-in text-center">
      <div className="glass rounded-2xl p-10 gold-border">
        {/* Animated house icon */}
        <div className="relative mx-auto w-24 h-24 mb-8">
          <div className="absolute inset-0 rounded-full bg-gold/10 animate-ping" />
          <div className="absolute inset-2 rounded-full bg-gold/10 animate-ping [animation-delay:300ms]" />
          <div className="relative w-full h-full rounded-full bg-navy border-2 border-gold/50 flex items-center justify-center">
            <svg
              width="44"
              height="44"
              viewBox="0 0 24 24"
              fill="none"
              className="text-gold"
            >
              <path
                d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="rgba(201,168,76,0.15)"
              />
              <polyline
                points="9,22 9,12 15,12 15,22"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </div>
        </div>

        <h2 className="text-2xl font-bold text-white mb-2">Analyzing Your Home</h2>
        <p className="text-white/50 text-sm mb-2 max-w-xs mx-auto">
          {address.streetNumber} {address.streetName},{" "}
          {address.city}, {address.state} {address.zipCode}
        </p>

        {/* Loading step text */}
        <div className="h-6 mb-6">
          <p className="text-gold/80 text-sm font-medium transition-all duration-300 animate-pulse">
            {LOADING_STEPS[currentStep] ?? "Finalizing..."}
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-xs mx-auto bg-white/10 rounded-full h-2 overflow-hidden mb-4">
          <div
            className="h-full gold-gradient rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-white/30 text-xs">{progress}% complete</p>
      </div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
