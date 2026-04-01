"use client";

import { useState, useRef, useCallback } from "react";

export type AddressData = {
  full: string; streetNumber: string; streetName: string;
  city: string; state: string; zipCode: string; lat?: number; lng?: number;
};
interface Props { onSubmit: (data: AddressData, sqft?: number) => void; }
interface Suggestion { place_id: string; display_name: string; address: Record<string, string>; lat: string; lon: string; }

export default function Step1Address({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef<AddressData | null>(null);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < 4) { setSuggestions([]); return; }
    setLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`,
        { headers: { "Accept-Language": "en-US" } }
      );
      const data: Suggestion[] = await res.json();
      // Filter to street-level results
      setSuggestions(data.filter(d => d.address?.road || d.address?.house_number));
    } catch { setSuggestions([]); }
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
    const full = [streetNumber, streetName, city, `${stateAbbr} ${zip}`].filter(Boolean).join(", ").replace(/,\s*,/g, ",");
    selectedRef.current = { full, streetNumber, streetName, city, state: stateAbbr, zipCode: zip, lat: parseFloat(s.lat), lng: parseFloat(s.lon) };
    setValue(full);
    setSuggestions([]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSuggestions([]);
    if (selectedRef.current) { onSubmit(selectedRef.current); return; }
    const val = value.trim();
    if (val.length < 10) { setError("Please enter your full address including city and state."); return; }
    const parts = val.split(",").map(s => s.trim());
    const sp = (parts[2] || "").split(" ").filter(Boolean);
    onSubmit({ full: val, streetNumber: "", streetName: parts[0] || val, city: parts[1] || "", state: sp[0] || "", zipCode: sp[1] || "" });
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
        <p className="text-white/60 text-lg max-w-md mx-auto">Get an instant estimate powered by real MLS data. No obligation. Takes 30 seconds.</p>
      </div>

      <form onSubmit={handleSubmit} className="glass rounded-2xl p-6 md:p-8 gold-border">
        <div className="space-y-4">
          <div className="relative">
            <label htmlFor="addr" className="block text-white/70 text-sm font-medium mb-2">Your Property Address</label>
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gold/60 z-10 pointer-events-none">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                </svg>
              </div>
              <input
                id="addr"
                type="text"
                value={value}
                onChange={handleChange}
                onBlur={() => setTimeout(() => setSuggestions([]), 200)}
                placeholder="123 Main St, McLean, VA 22101"
                className="w-full bg-navy/60 border border-white/20 focus:border-gold rounded-xl pl-12 pr-10 py-4 text-white placeholder-white/30 outline-none transition-all focus:ring-2 focus:ring-gold/30 text-base"
                autoComplete="off"
                spellCheck={false}
              />
              {loading && (
                <div className="absolute right-4 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-white/20 border-t-gold rounded-full animate-spin" />
                </div>
              )}
              {suggestions.length > 0 && (
                <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-[#0d1f3c] border border-white/20 rounded-xl overflow-hidden shadow-xl">
                  {suggestions.map(s => (
                    <li key={s.place_id} onMouseDown={() => handleSelect(s)}
                      className="px-4 py-3 text-white text-sm hover:bg-gold/10 cursor-pointer border-b border-white/10 last:border-0 flex items-center gap-3">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C9A84C" strokeWidth="2" className="shrink-0">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                      </svg>
                      <span className="truncate">{s.display_name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && <p className="text-red-400 text-xs mt-1 ml-1">{error}</p>}
            <p className="text-white/30 text-xs mt-2 ml-1">Start typing — suggestions appear after 4 characters</p>
          </div>



          <button type="submit" className="w-full gold-gradient text-navy font-bold py-4 rounded-xl text-lg transition-all hover:opacity-90 hover:scale-[1.01] active:scale-[0.99] shadow-lg shadow-gold/20 mt-2">
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

const STATE_ABBR: Record<string, string> = {
  "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT","Delaware":"DE","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY","District of Columbia":"DC"
};
