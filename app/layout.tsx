import type { Metadata } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

/**
 * Headline face. Inter alone — set large, bold and centred — is most of why the
 * old landing read as generated; a text serif is what brokerage and portal
 * marketing pages actually use for headings.
 */
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
});

const AGENT = process.env.NEXT_PUBLIC_AGENT_NAME || "Candee Currie";
const BROKERAGE = process.env.NEXT_PUBLIC_AGENT_BROKERAGE || "TTR Sotheby's International Realty";

export const metadata: Metadata = {
  title: `What is my home worth? | ${AGENT} | ${BROKERAGE}`,
  description:
    "See what your Northern Virginia, DC or Maryland home is worth, built from recorded sales near you. Free, no obligation.",
  openGraph: {
    title: "What is my home worth?",
    description: "A home value estimate built from recorded sales near you.",
    siteName: `${AGENT} | ${BROKERAGE}`,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${sourceSerif.variable} font-sans min-h-screen bg-paper text-ink`}
      >
        {children}
      </body>
    </html>
  );
}
