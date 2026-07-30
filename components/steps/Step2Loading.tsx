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
  "Matching your address to a parcel record",
  "Reading the assessment and last recorded sale",
  "Pulling arm's-length sales within a mile",
  "Ranking them by distance, recency and similarity",
  "Adjusting each one toward your home",
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
            // Coordinates from the step 1 autocomplete. Without these the
            // county comps engine can't run and we fall back to the external
            // upstream.
            lat: address.lat,
            lng: address.lng,
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

  const streetLine =
    `${address.streetNumber} ${address.streetName}`.trim() || address.full;

  return (
    <div className="animate-fade-in max-w-xl">
      <p className="eyebrow mb-4">Step 2 of 4</p>
      <h2 className="font-serif text-3xl text-ink">Comparing recent sales</h2>
      <p className="mt-2 text-ink-muted">
        {streetLine}
        {address.city ? `, ${address.city}` : ""} {address.state} {address.zipCode}
      </p>

      <div className="mt-8">
        <div
          className="w-full bg-rule rounded-full h-1.5 overflow-hidden"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Valuation progress"
        >
          <div
            className="h-full bg-navy rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/*
          The steps are listed rather than swapped one at a time, so the visitor
          can see what is actually being done and what is left. A single rotating
          line reads as a stall; a checklist reads as work.
        */}
        <ol className="mt-7 space-y-3.5">
          {LOADING_STEPS.map((label, i) => {
            const done = i < currentStep;
            const active = i === currentStep;
            return (
              <li key={label} className="flex items-center gap-3 text-[15px]">
                <span
                  aria-hidden="true"
                  className={`w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-[10px] font-semibold ${
                    done
                      ? "bg-navy border-navy text-white"
                      : active
                      ? "border-navy text-navy"
                      : "border-rule text-ink-faint"
                  }`}
                >
                  {done ? "✓" : ""}
                </span>
                <span className={done || active ? "text-ink" : "text-ink-faint"}>{label}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
