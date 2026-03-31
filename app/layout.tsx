import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Script from "next/script";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "What's My Home Worth? | Candee Currie | TTR Sotheby's International Realty",
  description:
    "Get an instant home value estimate for your Northern Virginia property. Powered by real MLS data. Free, fast, no obligation.",
  openGraph: {
    title: "What's My Home Worth?",
    description: "Get your instant home value estimate — powered by real MLS data.",
    siteName: "Candee Currie | TTR Sotheby's International Realty",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY && (
          <Script
            src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places`}
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body className={`${inter.variable} font-sans min-h-screen bg-navy`}>
        {children}
      </body>
    </html>
  );
}
