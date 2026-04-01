"use client";

import { useEffect, useRef, useState } from "react";

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

interface Props {
  onSubmit: (data: AddressData, sqft?: number) => void;
}

declare global {
  interface Window { google: any; } // eslint-disable-line @typescript-eslint/no-explicit-any
}

export default function Step1Address({ onSubmit }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [selected, setSelected] = useState<AddressData | null>(null);
  const [sqft, setSqft] = useState("");
  const [showSqft, setShowSqft] = useState(false);
  const [ready, setReady] = useState(false);

  // Init Google Places once
  useEffect(() => {
    const init = () => {
      if (!inputRef.current || acRef.current) return;
      if (!window.google?.maps?.places) return;
      acRef.current = new window.google.maps.places.Autocomplete(inputRef.current, {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["address_components", "formatted_address", "geometry"],
      });
      acRef.current.addListener("place_changed", () => {
        const place = acRef.current.getPlace();
        if (!place?.address_components) return;
        const get = (type: string, short = false) => {
          const c = place.address_components.find((x: any) => x.types.includes(type)); // eslint-disable-line @typescript-eslint/no-explicit-any
          return (short ? c?.short_name : c?.long_name) || "";
        };
        const data: AddressData = {
          full: place.formatted_address || inputRef.current?.value || "",
          streetNumber: get("street_number"),
          streetName: get("route"),
          city: get("locality") || get("sublocality"),
          state: get("administrative_area_level_1", true),
          zipCode: get("postal_code"),
          lat: place.geometry?.location?.lat?.(),
          lng: place.geometry?.location?.lng?.(),
        };
        setSelected(data);
        setShowSqft(true);
      });
      setReady(true);
    };

    if (window.google?.maps?.places) { init(); return; }
    const t = setInterval(() => { if (window.google?.maps?.places) { clearInterval(t); init(); } }, 200);
    return () => clearInterval(t);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = inputRef.current?.value || "";
    if (selected) { onSubmit(selected, sqft ? parseInt(sqft) : undefined); return; }
    if (val.trim().length > 5) {
      const parts = val.split(",").map(s => s.trim());
      const stateParts = (parts[2] || "").split(" ").filter(Boolean);
      onSubmit({
        full: val,
        streetNumber: "",
        streetName: parts[0] || "",
        city: parts[1] || "",
        state: stateParts[0] || "",
        zipCode: stateParts[1] || "",
      }, sqft ? parseInt(sqft) : undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 text-gold text-xs font-semibold px-4 py-2 rounded-full mb-6 uppercase tracking-widest">
          <span>⚡</span><span>Free Instant Estimate</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-4 leading-tight">
          What&apos;s Your Home<br /><span className="text-gold">Worth Today?</span>
        </h1>
        <p className="text-white/60 text-lg max-w-md mx-auto">
          Get an instant estimate powered by real MLS data. No obligation. Takes 30 seconds.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="glass rounded-2xl p-6 md:p-8 gold-border">
        <div className="space-y-4">
          <div>
            <label htmlFor="addr" className="block text-white/70 text-sm font-medium mb-2">
              Your Property Address
            </label>
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gold/60">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                </svg>
              </div>
              {/* UNCONTROLLED INPUT — no value prop, no onChange */}
              <input
                id="addr"
                ref={inputRef}
                type="text"
                placeholder="123 Main St, McLean, VA 22101"
                className="w-full bg-navy/60 border border-white/20 focus:border-gold rounded-xl pl-12 pr-4 py-4 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-base"
                autoComplete="off"
              />
            </div>
            <p className="text-white/30 text-xs mt-2 ml-1">
              {ready ? "Start typing — we'll find your address automatically" : "Loading address search..."}
            </p>
          </div>

          {showSqft && (
            <div>
              <label htmlFor="sqft" className="block text-white/70 text-sm font-medium mb-2">
                Approximate Sq Ft <span className="text-white/30">(optional)</span>
              </label>
              <select
                id="sqft"
                value={sqft}
                onChange={e => setSqft(e.target.value)}
                className="w-full bg-navy/60 border border-white/20 focus:border-gold rounded-xl px-4 py-3.5 text-white outline-none transition-all focus:ring-2 focus:ring-gold/30 text-sm appearance-none"
              >
                <option value="">Not sure</option>
                <option value="800">Under 1,000 sqft</option>
                <option value="1200">1,000 – 1,500 sqft</option>
                <option value="1750">1,500 – 2,000 sqft</option>
                <option value="2250">2,000 – 2,500 sqft</option>
                <option value="2750">2,500 – 3,000 sqft</option>
                <option value="3500">3,000 – 4,000 sqft</option>
                <option value="4500">4,000+ sqft</option>
              </select>
            </div>
          )}

          <button
            type="submit"
            className="w-full gold-gradient text-navy font-bold py-4 rounded-xl text-lg transition-all hover:opacity-90 hover:scale-[1.01] active:scale-[0.99] shadow-lg shadow-gold/20 mt-2"
          >
            Get My Home Value →
          </button>
        </div>

        <div className="flex items-center justify-center gap-6 mt-6 pt-5 border-t border-white/10">
          <div className="flex items-center gap-1.5 text-white/40 text-xs"><span>🏠</span><span>Real MLS Data</span></div>
          <div className="flex items-center gap-1.5 text-white/40 text-xs"><span>🔒</span><span>100% Private</span></div>
          <div className="flex items-center gap-1.5 text-white/40 text-xs"><span>⚡</span><span>30-Second Results</span></div>
        </div>
      </form>

      <p className="text-center text-white/40 text-xs">TTR Sotheby&apos;s International Realty · Northern Virginia</p>
    </div>
  );
}
