"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface AddressData {
  full: string;
  streetNumber: string;
  streetName: string;
  city: string;
  state: string;
  zipCode: string;
  lat?: number;
  lng?: number;
}

interface Step1AddressProps {
  onSubmit: (data: { address: AddressData; sqft: string }) => void;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google: any;
    googleMapsReady: boolean;
  }
}

export default function Step1Address({ onNext }: Step1AddressProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autocompleteRef = useRef<any>(null);
  const initializedRef = useRef(false);
  const [inputValue, setInputValue] = useState("");
  const [selectedAddress, setSelectedAddress] = useState<AddressData | null>(null);
  const [sqft, setSqft] = useState("");
  const [showSqft, setShowSqft] = useState(false);
  const [isValid, setIsValid] = useState(false);

  const initAutocomplete = useCallback(() => {
    if (initializedRef.current) return;
    if (!inputRef.current) return;
    if (!window.google?.maps?.places) return;

    initializedRef.current = true;

    autocompleteRef.current = new window.google.maps.places.Autocomplete(
      inputRef.current,
      {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["address_components", "formatted_address", "geometry"],
      }
    );

    autocompleteRef.current.addListener("place_changed", () => {
      const place = autocompleteRef.current?.getPlace();
      if (!place?.address_components) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const get = (type: string, short = false) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = place.address_components.find((c: any) => c.types.includes(type));
        return short ? c?.short_name || "" : c?.long_name || "";
      };

      const addressData: AddressData = {
        full: place.formatted_address || inputRef.current!.value,
        streetNumber: get("street_number"),
        streetName: get("route"),
        city: get("locality") || get("sublocality") || get("neighborhood"),
        state: get("administrative_area_level_1", true),
        zipCode: get("postal_code"),
        lat: place.geometry?.location?.lat?.(),
        lng: place.geometry?.location?.lng?.(),
      };

      setSelectedAddress(addressData);
      setInputValue(place.formatted_address || inputRef.current!.value);
      setIsValid(!!addressData.zipCode);
      setShowSqft(true);
    });
  }, []);

  useEffect(() => {
    // Try immediately
    if (window.google?.maps?.places) {
      initAutocomplete();
      return;
    }

    // Poll until loaded
    const interval = setInterval(() => {
      if (window.google?.maps?.places) {
        clearInterval(interval);
        initAutocomplete();
      }
    }, 300);

    return () => clearInterval(interval);
  }, [initAutocomplete]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rawValue = inputRef.current?.value || inputValue;
    if (selectedAddress) {
      onSubmit({ address: selectedAddress, sqft });
      return;
    }
    if (rawValue.trim().length > 5) {
      const parts = rawValue.split(",").map((p: string) => p.trim());
      const fallback: AddressData = {
        full: rawValue,
        streetNumber: "",
        streetName: parts[0] || "",
        city: parts[1] || "",
        state: parts[2]?.split(" ")[0] || "",
        zipCode: parts[2]?.split(" ")[1] || "",
      };
      onSubmit({ address: fallback, sqft });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">
          What&apos;s Your Home Worth?
        </h1>
        <p className="text-white/60">
          Get an instant estimate based on real market data.
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="relative">
          <label htmlFor="address" className="block text-white/70 text-sm font-medium mb-2">
            Your Home Address
          </label>
          <div className="relative">
            <svg
              className="absolute left-4 top-1/2 -translate-y-1/2 text-gold"
              width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2"
            >
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <input
              id="address"
              ref={inputRef}
              type="text"
              defaultValue=""
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                if (val !== inputValue) setInputValue(val);
                if (selectedAddress) {
                  setSelectedAddress(null);
                  setIsValid(false);
                  setShowSqft(false);
                }
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
        </div>

        {/* Sqft selector */}
        {showSqft && (
          <div>
            <label htmlFor="sqft" className="block text-white/70 text-sm font-medium mb-2">
              Approximate Square Footage <span className="text-white/30">(optional)</span>
            </label>
            <select
              id="sqft"
              value={sqft}
              onChange={(e) => setSqft(e.target.value)}
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
          disabled={false}
          className="w-full bg-gold hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed text-navy font-bold py-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 text-base shadow-lg shadow-gold/20"
        >
          Get My Home Value
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      </form>

      {/* Trust line */}
      <p className="text-center text-white/30 text-xs">TTR Sotheby&apos;s International Realty · Northern Virginia</p>
    </div>
  );
}
