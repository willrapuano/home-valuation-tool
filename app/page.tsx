import HomeValuationFlow from "@/components/HomeValuationFlow";
import { fetchMarketPulse } from "@/lib/market-pulse";
import { agent } from "@/lib/agent";

/**
 * Rebuilt DAILY, not per request.
 *
 * The landing page reads live county sale counts, and getting the true median
 * costs a paginated ArcGIS query. Neither can happen on a pageview: county
 * services rate-limit, and their rate limit would become this page's latency.
 *
 * Market statistics do not move intra-day — a county records a few dozen deeds
 * a day against a 90-day window of thousands — so one rebuild a day is the
 * right granularity. Four requests per day per deployment, and a visitor never
 * waits on any of them: the page they get was already built.
 */
export const revalidate = 86_400;

/**
 * Room for the slowest market. Maryland's iMAP service takes 6.3s to answer the
 * paginated median query and 2.5s for a count; the default 15s ceiling would
 * abort a Maryland tenant's rebuild partway through. This only applies to the
 * background regeneration — no visitor ever waits on it.
 */
export const maxDuration = 30;

export default async function Home() {
  // Returns null for an unreachable service OR an unrecognised market key; the
  // landing renders a coverage panel in either case.
  const pulse = await fetchMarketPulse(agent.market);
  return <HomeValuationFlow pulse={pulse} />;
}
