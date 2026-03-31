"use client";

import { useEffect, useRef, useState } from "react";
import { AddressData } from "../HomeValuationFlow";

declare global {
  interface Window {
    google?: {
      maps: {
        places: {
          Autocomplete: new (
            input: HTMLInputElement,
            options?: { types: string[]; componentRestrictions: { country: string } }
          ) => {
            addListener: (event: string, callback: () => void) => void;
            getPlace: () => {
              formatted_address?: string;
              address_components?: Array<{
                long_name: string;
                short_name: string;
                types: string[];
              }>;
              geometry?: { location: { lat: () => number; lng: () => number } };
            };
          };
        };
      };
    };
  }
}

interface Props {
  onSubmit: (address: AddressData, sqft?: number) => void;
}

export default function Step1Address({ onSubmit }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autocompleteRef = useRef<any>(null);
  const [inputValue, setInputValue] = useState("");
  const [selectedAddress, setSelectedAddress] = useState<AddressData | null>(null);
  const [sqft, setSqft] = useState("");
  const [showSqft, setShowSqft] = useState(false);
  const [isValid, setIsValid] = useState(false);

  useEffect(() => {
    if (!inputRef.current) return;

    const initAutocomplete = () => {
      if (!window.google?.maps?.places) return;

      autocompleteRef.current = new window.google.maps.places.Autocomplete(
        inputRef.current!,
        {
          types: ["address"],
          componentRestrictions: { country: "us" },
        }
      );

      autocompleteRef.current.addListener("place_changed", () => {
        const place = autocompleteRef.current?.getPlace();
        if (!place?.address_components) return;

        const components = place.address_components;
        const get = (type: string, short = false) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const c = components.find((c: any) => c.types.includes(type));
          return short ? c?.short_name : c?.long_name || "";
        };

        const addressData: AddressData = {
          full: place.formatted_address || inputRef.current!.value,
          streetNumber: get("street_number"),
          streetName: get("route"),
          city: get("locality") || get("sublocality") || get("neighborhood"),
          state: get("administrative_area_level_1", true),
          zipCode: get("postal_code"),
          lat: place.geometry?.location.lat(),
          lng: place.geometry?.location.lng(),
        };

        setSelectedAddress(addressData);
        setInputValue(place.formatted_address || inputRef.current!.value);
        setIsValid(!!addressData.zipCode);
        setShowSqft(true);
      });
    };

    // Google Maps may already be loaded or we wait for it
    if (window.google?.maps?.places) {
      initAutocomplete();
    } else {
      const interval = setInterval(() => {
        if (window.google?.maps?.places) {
          clearInterval(interval);
          initAutocomplete();
        }
      }, 200);
      return () => clearInterval(interval);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAddress && inputValue.trim().length > 10) {
      // Manual address fallback
      const parts = inputValue.split(",").map((p) => p.trim());
      const manual: AddressData = {
        full: inputValue,
        streetNumber: "",
        streetName: parts[0] || "",
        city: parts[1] || "",
        state: parts[2]?.split(" ")[0] || "VA",
        zipCode: parts[2]?.split(" ")[1] || "",
      };
      onSubmit(manual, sqft ? parseInt(sqft) : undefined);
    } else if (selectedAddress) {
      onSubmit(selectedAddress, sqft ? parseInt(sqft) : undefined);
    }
  };

  return (
    <div className="animate-slide-up">
      {/* Hero */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 text-gold text-xs font-semibold px-4 py-2 rounded-full mb-6 uppercase tracking-widest">
          <span>⚡</span>
          <span>Free Instant Estimate</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-4 leading-tight">
          What's Your Home
          <br />
          <span className="text-gold">Worth Today?</span>
        </h1>
        <p className="text-white/60 text-lg max-w-md mx-auto">
          Get an instant estimate powered by real MLS data. No obligation. Takes 30 seconds.
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="glass rounded-2xl p-6 md:p-8 gold-border">
        <div className="space-y-4">
          <div>
            <label htmlFor="address" className="block text-white/70 text-sm font-medium mb-2">
              Your Property Address
            </label>
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gold/60">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              </div>
              <input
                id="address"
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  setSelectedAddress(null);
                  setIsValid(false);
                  setShowSqft(false);
                }}
                placeholder="123 Main St, McLean, VA 22101"
                className="w-full bg-navy/60 border border-white/20 focus:border-gold rounded-xl pl-12 pr-4 py-4 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-base"
                autoComplete="off"
                required
              />
              {isValid && (
                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-green-400">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
            </div>
            <p className="text-white/30 text-xs mt-2 ml-1">
              Start typing — we'll find your address automatically
            </p>
          </div>

          {/* Optional sqft */}
          {showSqft && (
            <div className="animate-slide-up">
              <label htmlFor="sqft" className="block text-white/70 text-sm font-medium mb-2">
                Approximate Square Footage{" "}
                <span className="text-white/30 font-normal">(optional — improves accuracy)</span>
              </label>
              <select
                id="sqft"
                value={sqft}
                onChange={(e) => setSqft(e.target.value)}
                className="w-full bg-navy/60 border border-white/20 focus:border-gold rounded-xl px-4 py-4 text-white outline-none transition-all focus:ring-2 focus:ring-gold/30 appearance-none cursor-pointer"
              >
                <option value="">Not sure</option>
                <option value="800">Under 1,000 sqft</option>
                <option value="1200">1,000 – 1,500 sqft</option>
                <option value="1750">1,500 – 2,000 sqft</option>
                <option value="2250">2,000 – 2,500 sqft</option>
                <option value="2750">2,500 – 3,000 sqft</option>
                <option value="3500">3,000 – 4,000 sqft</option>
                <option value="4500">4,000 – 5,000 sqft</option>
                <option value="5500">5,000+ sqft</option>
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="w-full gold-gradient text-navy font-bold py-4 rounded-xl text-lg transition-all hover:opacity-90 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100 shadow-lg shadow-gold/20 mt-2"
          >
            Get My Home Value →
          </button>
        </div>

        {/* Trust signals */}
        <div className="flex items-center justify-center gap-6 mt-6 pt-5 border-t border-white/10">
          {[
            { icon: "🏠", text: "Real MLS Data" },
            { icon: "🔒", text: "100% Private" },
            { icon: "⚡", text: "30-Second Results" },
          ].map((item) => (
            <div key={item.text} className="flex items-center gap-1.5 text-white/40 text-xs">
              <span>{item.icon}</span>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </form>

      {/* Brokerage trust line */}
      <p className="text-center text-white/40 text-xs mt-6">TTR Sotheby&apos;s International Realty · Northern Virginia</p>
    </div>
  );
}
