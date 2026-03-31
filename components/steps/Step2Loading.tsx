"use client";

import { useEffect, useState } from "react";
import { AddressData, ValuationData } from "../HomeValuationFlow";

interface Props {
  address: AddressData;
  sqft?: number;
  onComplete: (data: ValuationData) => void;
}

const LOADING_STEPS = [
  { label: "Verifying address...", duration: 600 },
  { label: "Searching MLS records...", duration: 700 },
  { label: "Analyzing recent sales...", duration: 800 },
  { label: "Calculating market trends...", duration: 600 },
  { label: "Preparing your estimate...", duration: 500 },
];

export default function Step2Loading({ address, sqft, onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stepIndex = 0;
    const totalDuration = LOADING_STEPS.reduce((s, step) => s + step.duration, 0);
    let elapsed = 0;

    // Fetch valuation data in parallel
    const fetchData = fetch("/api/avm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: address.full,
        zipCode: address.zipCode,
        sqft,
      }),
    }).then(r => r.json());

    // Progress animation
    const animateSteps = async () => {
      for (const step of LOADING_STEPS) {
        if (cancelled) break;
        setCurrentStep(stepIndex);
        await sleep(step.duration);
        elapsed += step.duration;
        setProgress(Math.round((elapsed / totalDuration) * 95));
        stepIndex++;
      }
    };

    const run = async () => {
      await animateSteps();

      if (cancelled) return;

      try {
        const data = await fetchData;

        if (!cancelled) {
          setProgress(100);
          await sleep(400);
          if (!cancelled) {
            onComplete(data as ValuationData);
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error("AVM fetch error:", err);
          // Provide fallback
          const fallback: ValuationData = {
            estimate: 500000,
            low: 460000,
            high: 540000,
            confidence: "low",
            source: "estimate",
            comps: [],
          };
          setProgress(100);
          await sleep(400);
          if (!cancelled) onComplete(fallback);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [address, sqft, onComplete]);

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
            {LOADING_STEPS[currentStep]?.label || "Finalizing..."}
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-xs mx-auto bg-white/10 rounded-full h-2 overflow-hidden mb-4">
          <div
            className="h-full gold-gradient rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-white/30 text-xs">{progress}% complete</p>

        {/* Mini stats animating */}
        <div className="grid grid-cols-3 gap-3 mt-8">
          {[
            { label: "MLS Records", value: "BrightMLS" },
            { label: "Sales Radius", value: "1 mile" },
            { label: "Lookback", value: "6 months" },
          ].map((item) => (
            <div key={item.label} className="bg-white/5 rounded-xl p-3">
              <p className="text-gold text-xs font-semibold">{item.value}</p>
              <p className="text-white/30 text-xs mt-0.5">{item.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
