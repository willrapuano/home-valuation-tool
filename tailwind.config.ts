import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Semantic surface tokens. Naming them by role rather than by colour is
        // what let the whole flow move from dark to light without every
        // component re-deciding what "white/60" was supposed to mean.
        paper: "var(--paper)",
        canvas: "var(--canvas)",
        ink: {
          DEFAULT: "var(--ink)",
          muted: "var(--ink-muted)",
          faint: "var(--ink-faint)",
        },
        rule: "var(--rule)",
        navy: {
          DEFAULT: "#0B1D3A",
          light: "#1a3460",
          dark: "#060f1e",
        },
        gold: {
          DEFAULT: "#C9A84C",
          light: "#d9bc76",
          dark: "#a8852e",
          // Readable as text on a light surface; #C9A84C is not.
          deep: "#8A6A24",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        // A real text serif, not Georgia. A headline serif is the single
        // biggest visual difference between a brokerage page and a generated
        // one, and Source Serif is close to the transitional serif TTR
        // Sotheby's sets its own headlines in.
        serif: ["var(--font-serif)", "Georgia", "Times New Roman", "serif"],
      },
      animation: {
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "spin-slow": "spin 3s linear infinite",
        "fade-in": "fadeIn 0.5s ease-in-out",
        "slide-up": "slideUp 0.4s ease-out",
        shimmer: "shimmer 2s infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
