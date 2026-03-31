"use client";

import { useState } from "react";

interface Step3LeadGateProps {
  address: string;
  onSubmit: (leadData: { email: string }) => void;
}

export default function Step3LeadGate({ address, onSubmit }: Step3LeadGateProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const validate = () => {
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address");
      return false;
    }
    setError("");
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, address }),
      });
    } catch {}
    setLoading(false);
    onSubmit({ email });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-gold/20 border border-gold/40 mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Your estimate is ready!</h2>
        <p className="text-white/60 text-sm">Enter your email to see your home&apos;s value</p>
      </div>

      {/* Address preview */}
      <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="2" className="shrink-0">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <p className="text-white/70 text-sm truncate">{address}</p>
      </div>

      {/* Blurred preview */}
      <div className="relative rounded-2xl overflow-hidden border border-white/10">
        <div className="bg-gradient-to-br from-navy-light to-navy p-6 blur-sm pointer-events-none select-none">
          <p className="text-white/40 text-xs mb-1">Estimated Value</p>
          <p className="text-3xl font-bold text-gold">$XXX,XXX – $XXX,XXX</p>
          <div className="flex gap-4 mt-4">
            <div className="h-12 w-28 bg-white/10 rounded-lg" />
            <div className="h-12 w-28 bg-white/10 rounded-lg" />
          </div>
        </div>
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
          <div className="text-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="2" className="mx-auto mb-2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <p className="text-white text-sm font-medium">Enter email to unlock</p>
          </div>
        </div>
      </div>

      {/* Email form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(""); }}
            className={`w-full bg-navy/60 border ${error ? "border-red-400/70" : "border-white/20"} focus:border-gold rounded-xl px-4 py-4 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-base`}
            autoFocus
          />
          {error && <p className="text-red-400 text-xs mt-1 ml-1">{error}</p>}
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-gold hover:bg-gold/90 disabled:opacity-60 text-navy font-bold py-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 text-base shadow-lg shadow-gold/20"
        >
          {loading ? (
            <><span className="w-4 h-4 border-2 border-navy/30 border-t-navy rounded-full animate-spin" /> Processing...</>
          ) : (
            <>See My Home Value <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></>
          )}
        </button>

        <p className="text-center text-white/30 text-xs">No spam. Your info is kept private.</p>
      </form>
    </div>
  );
}
