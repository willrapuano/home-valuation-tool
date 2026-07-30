"use client";

/**
 * Mailed mode is decided on the server, but this screen runs BEFORE the
 * valuation call, so it has nothing to read the decision from. The public
 * mirror exists only for copy — the server is still what withholds the
 * estimate, so a mismatched build changes wording and never leaks a number.
 */
const MAILED_MODE = process.env.NEXT_PUBLIC_VALUATION_MODE?.trim().toLowerCase() === "mailed";

import { useState } from "react";
import { AddressData } from "../HomeValuationFlow";
import { agentFirstName } from "@/lib/agent";

interface Step3LeadGateProps {
  address: AddressData;
  valuation: { estimate: number | null; degraded?: boolean };
  onSubmit: (leadData: { email: string }) => void;
}

export default function Step3LeadGate({ address, valuation, onSubmit }: Step3LeadGateProps) {
  // When no automated valuation was produced, the gate must not promise a
  // number it cannot deliver on the next screen.
  const hasEstimate = !valuation.degraded && valuation.estimate !== null;
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, address: address.full }),
      });
    } catch {}
    setLoading(false);
    onSubmit({ email });
  };

  return (
    <div className="max-w-xl">
      <p className="eyebrow mb-4">Step 3 of 4</p>
      <h2 className="font-serif text-3xl text-ink">
        {hasEstimate
          ? "Where should we send your analysis?"
          : `Where should ${agentFirstName} send your analysis?`}
      </h2>
      <p className="mt-3 text-ink-muted leading-relaxed">
        {hasEstimate
          ? "Your estimate is ready. Enter an email address and it opens on the next screen — you will also get a copy you can come back to."
          : MAILED_MODE
          ? `${agentFirstName} will prepare a comparative market analysis for this address by hand and post it to you. Leave an email address so she can confirm it is on the way.`
          : `${agentFirstName} will prepare a comparative market analysis for this address and send it within 24 hours.`}
      </p>

      <div className="mt-6 card rounded-md px-4 py-3 flex items-center gap-3">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          className="shrink-0 text-ink-faint"
          aria-hidden="true"
        >
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <p className="text-ink text-[15px] truncate">{address.full}</p>
      </div>

      <form onSubmit={handleSubmit} className="mt-6">
        <label htmlFor="lead-email" className="block text-sm font-medium text-ink mb-2">
          Email address
        </label>
        <input
          id="lead-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => {
            setEmail(e.target.value);
            setError("");
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "lead-email-error" : undefined}
          className={`w-full h-14 bg-paper border ${
            error ? "border-red-600" : "border-ink/25"
          } focus:border-navy rounded-md px-4 text-[16px] text-ink placeholder-ink-faint outline-none transition-colors focus:ring-2 focus:ring-navy/15`}
          autoComplete="email"
          autoFocus
        />
        {error && (
          <p id="lead-email-error" className="text-red-700 text-sm mt-2" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-4 w-full h-14 bg-navy hover:bg-navy-light disabled:opacity-60 text-white font-semibold rounded-md transition-colors flex items-center justify-center gap-2 text-[15px]"
        >
          {loading ? (
            <>
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Sending
            </>
          ) : hasEstimate ? (
            "See my estimate"
          ) : (
            "Send my analysis"
          )}
        </button>

        <p className="mt-4 text-sm text-ink-faint leading-relaxed">
          One email address, no phone number. {agentFirstName} may follow up by email; your
          details are not sold or shared.
        </p>
      </form>
    </div>
  );
}
