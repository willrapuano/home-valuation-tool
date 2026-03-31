"use client";

import { useState } from "react";
import { AddressData, LeadData, ValuationData } from "../HomeValuationFlow";

interface Props {
  address: AddressData;
  valuation: ValuationData;
  onSubmit: (data: LeadData) => void;
}

export default function Step3LeadGate({ address, valuation, onSubmit }: Props) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<typeof form>>({});

  const validate = () => {
    const errs: Partial<typeof form> = {};
    if (!form.firstName.trim()) errs.firstName = "Required";
    if (!form.lastName.trim()) errs.lastName = "Required";
    if (!form.email.trim() || !/\S+@\S+\.\S+/.test(form.email)) errs.email = "Valid email required";
    if (!form.phone.trim() || form.phone.replace(/\D/g, "").length < 10)
      errs.phone = "Valid phone required";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }

    setLoading(true);

    try {
      // Push lead to GHL
      await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          address: address.full,
          city: address.city,
          state: address.state,
          zipCode: address.zipCode,
          estimatedValue: valuation.estimate,
          valueLow: valuation.low,
          valueHigh: valuation.high,
        }),
      });
    } catch (err) {
      console.error("Lead capture error:", err);
      // Continue even if GHL push fails
    }

    setLoading(false);
    onSubmit(form);
  };

  const handleChange = (field: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const formatPhone = (value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  return (
    <div className="animate-slide-up">
      {/* Blurred preview teaser */}
      <div className="glass rounded-2xl p-6 gold-border mb-4 relative overflow-hidden">
        <div className="absolute inset-0 backdrop-blur-sm bg-navy/50 flex flex-col items-center justify-center z-10 rounded-2xl">
          <div className="bg-gold/10 border border-gold/30 rounded-full p-3 mb-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <p className="text-gold font-semibold text-sm">Your estimate is ready!</p>
          <p className="text-white/50 text-xs mt-1">Enter your info below to unlock</p>
        </div>

        {/* Fake blurred numbers behind */}
        <div className="opacity-20 select-none pointer-events-none">
          <p className="text-white/40 text-xs uppercase tracking-widest mb-2">Estimated Value</p>
          <p className="text-4xl font-bold text-white blur-sm">$492,000 – $531,000</p>
          <div className="flex gap-2 mt-3">
            <div className="h-4 w-24 bg-white/20 rounded blur-sm" />
            <div className="h-4 w-16 bg-white/20 rounded blur-sm" />
          </div>
        </div>
      </div>

      {/* Lead form */}
      <div className="glass rounded-2xl p-6 md:p-8 gold-border">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-white">Your estimate is ready!</h2>
          <p className="text-white/50 text-sm mt-2">
            Enter your info to see your home's value for{" "}
            <span className="text-gold font-medium">
              {address.streetNumber} {address.streetName}
            </span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <input
                type="text"
                placeholder="First Name"
                value={form.firstName}
                onChange={(e) => handleChange("firstName", e.target.value)}
                className={`w-full bg-navy/60 border ${errors.firstName ? "border-red-400/70" : "border-white/20"} focus:border-gold rounded-xl px-4 py-3.5 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-sm`}
                required
              />
              {errors.firstName && (
                <p className="text-red-400 text-xs mt-1 ml-1">{errors.firstName}</p>
              )}
            </div>
            <div>
              <input
                type="text"
                placeholder="Last Name"
                value={form.lastName}
                onChange={(e) => handleChange("lastName", e.target.value)}
                className={`w-full bg-navy/60 border ${errors.lastName ? "border-red-400/70" : "border-white/20"} focus:border-gold rounded-xl px-4 py-3.5 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-sm`}
                required
              />
              {errors.lastName && (
                <p className="text-red-400 text-xs mt-1 ml-1">{errors.lastName}</p>
              )}
            </div>
          </div>

          <div>
            <input
              type="email"
              placeholder="Email Address"
              value={form.email}
              onChange={(e) => handleChange("email", e.target.value)}
              className={`w-full bg-navy/60 border ${errors.email ? "border-red-400/70" : "border-white/20"} focus:border-gold rounded-xl px-4 py-3.5 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-sm`}
              required
            />
            {errors.email && (
              <p className="text-red-400 text-xs mt-1 ml-1">{errors.email}</p>
            )}
          </div>

          <div>
            <input
              type="tel"
              placeholder="Phone Number"
              value={form.phone}
              onChange={(e) => handleChange("phone", formatPhone(e.target.value))}
              className={`w-full bg-navy/60 border ${errors.phone ? "border-red-400/70" : "border-white/20"} focus:border-gold rounded-xl px-4 py-3.5 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-sm`}
              required
            />
            {errors.phone && (
              <p className="text-red-400 text-xs mt-1 ml-1">{errors.phone}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full gold-gradient text-navy font-bold py-4 rounded-xl text-base transition-all hover:opacity-90 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-gold/20 mt-1"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Processing...
              </span>
            ) : (
              "See My Home Value →"
            )}
          </button>

          <p className="text-white/30 text-xs text-center mt-3">
            🔒 Your info is private. No spam, no solicitation — just your results.
          </p>
        </form>
      </div>
    </div>
  );
}
