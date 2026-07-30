"use client";

import { useState, useRef, useCallback } from "react";

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
  /** Message carried back from a failed lookup, e.g. an incomplete address. */
  initialError?: string | null;
  /** Label on the submit control. */
  cta?: string;
  /** Rendered by the caller under the field, so the hero can say more than a form should. */
  hint?: string;
  autoFocus?: boolean;
}

interface Suggestion {
  place_id: string;
  display_name: string;
  address: Record<string, string>;
  lat: string;
  lon: string;
}

/**
 * The address bar.
 *
 * Split out of the old Step1Address so the landing page can compose a hero
 * around it — every leading valuation tool puts the address field in the hero
 * and then keeps selling below the fold, which is impossible when the form owns
 * the whole screen.
 *
 * Shape follows the convention those tools share: one field, no label chrome,
 * the button attached to the right of the input on desktop and stacked beneath
 * it on mobile. Contact details are asked for LATER (step 3), never here.
 */
export default function AddressSearch({
  onSubmit,
  initialError,
  cta = "Get my estimate",
  hint,
  autoFocus = false,
}: Props) {
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState(initialError ?? "");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef<AddressData | null>(null);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < 4) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`,
        { headers: { "Accept-Language": "en-US" } }
      );
      const data: Suggestion[] = await res.json();
      // Filter to street-level results
      setSuggestions(data.filter(d => d.address?.road || d.address?.house_number));
    } catch {
      setSuggestions([]);
    }
    setLoading(false);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    selectedRef.current = null;
    setError("");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchSuggestions(v), 400);
  };

  const handleSelect = (s: Suggestion) => {
    const a = s.address;
    const streetNumber = a.house_number || "";
    const streetName = a.road || "";
    const city = a.city || a.town || a.village || a.suburb || "";
    const state = a.state || "";
    const zip = a.postcode || "";
    const stateAbbr = STATE_ABBR[state] || state.slice(0, 2).toUpperCase();
    const full = [streetNumber, streetName, city, `${stateAbbr} ${zip}`]
      .filter(Boolean)
      .join(", ")
      .replace(/,\s*,/g, ",");
    selectedRef.current = {
      full,
      streetNumber,
      streetName,
      city,
      state: stateAbbr,
      zipCode: zip,
      lat: parseFloat(s.lat),
      lng: parseFloat(s.lon),
    };
    setValue(full);
    setSuggestions([]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSuggestions([]);
    if (selectedRef.current) {
      onSubmit(selectedRef.current);
      return;
    }
    const val = value.trim();
    if (val.length < 10) {
      setError("Please enter your full address, including city and state.");
      return;
    }
    const parts = val.split(",").map(s => s.trim());
    const sp = (parts[2] || "").split(" ").filter(Boolean);
    onSubmit({
      full: val,
      streetNumber: "",
      streetName: parts[0] || val,
      city: parts[1] || "",
      state: sp[0] || "",
      zipCode: sp[1] || "",
    });
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="relative">
        <div className="flex flex-col sm:flex-row sm:items-stretch gap-2 sm:gap-0">
          <div className="relative flex-1">
            <label htmlFor="addr" className="sr-only">
              Your home address
            </label>
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden="true"
              >
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
            <input
              id="addr"
              type="text"
              value={value}
              onChange={handleChange}
              onBlur={() => setTimeout(() => setSuggestions([]), 200)}
              placeholder="Enter your home address"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "addr-error" : hint ? "addr-hint" : undefined}
              className={`w-full h-14 bg-paper border ${
                error ? "border-red-600" : "border-ink/25"
              } focus:border-navy rounded-md sm:rounded-r-none pl-12 pr-10 text-[16px] text-ink placeholder-ink-faint outline-none transition-colors focus:ring-2 focus:ring-navy/15`}
              autoComplete="street-address"
              autoFocus={autoFocus}
              spellCheck={false}
            />
            {loading && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-ink/15 border-t-navy rounded-full animate-spin" />
              </div>
            )}
            {suggestions.length > 0 && (
              <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-paper border border-rule rounded-md overflow-hidden shadow-lg">
                {suggestions.map(s => (
                  <li
                    key={s.place_id}
                    onMouseDown={() => handleSelect(s)}
                    className="px-4 py-3 text-ink text-sm hover:bg-canvas cursor-pointer border-b border-rule last:border-0 flex items-center gap-3"
                  >
                    <svg
                      width="14"
                      height="14"
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
                    <span className="truncate">{s.display_name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="submit"
            className="h-14 shrink-0 bg-navy hover:bg-navy-light text-white font-semibold px-7 rounded-md sm:rounded-l-none text-[15px] transition-colors"
          >
            {cta}
          </button>
        </div>
      </div>
      {error && (
        <p id="addr-error" className="text-red-700 text-sm mt-2" role="alert">
          {error}
        </p>
      )}
      {hint && !error && (
        <p id="addr-hint" className="text-ink-faint text-sm mt-2">
          {hint}
        </p>
      )}
    </form>
  );
}

const STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI",
  Wyoming: "WY", "District of Columbia": "DC",
};
