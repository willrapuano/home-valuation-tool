import HomeValuationFlow from "@/components/HomeValuationFlow";
import { fetchMarketPulse } from "@/lib/market-pulse";

/**
 * Rebuilt hourly rather than per request.
 *
 * The landing page now reads live sale counts from Fairfax County, and those
 * change a few times a day at most. Regenerating on a schedule means the county
 * service is queried once an hour no matter how much traffic arrives, and a
 * visitor never waits on it — the page they get was already built.
 */
export const revalidate = 3600;

export default async function Home() {
  // Returns null on any failure; the landing renders a coverage panel instead.
  const pulse = await fetchMarketPulse();
  return <HomeValuationFlow pulse={pulse} />;
}
