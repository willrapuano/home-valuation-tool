/**
 * Agent branding, in one place.
 *
 * This tool is resold: the same codebase is deployed per agent and configured
 * through NEXT_PUBLIC_AGENT_*. The name, brokerage, licence and phone were
 * previously typed literally into the header, the footer, the lead gate and the
 * results screen, so every new deployment meant hunting for hardcoded
 * "Candee Currie" strings.
 *
 * Each `process.env.NEXT_PUBLIC_…` lookup must be written out in full rather
 * than built from a variable: Next.js inlines these at build time by literal
 * text substitution, and a computed key silently becomes undefined. It is also
 * why these BAKE AT BUILD TIME — changing one in the dashboard does nothing
 * until the next deployment.
 *
 * ── THE DEFAULTS ARE PLACEHOLDERS, NOT CANDEE'S DETAILS ──────────────────
 *
 * They used to be her real name, email, phone and VA licence number. That makes
 * the dangerous failure the silent one: a second agent deploys, forgets one
 * variable, and ships a page carrying ANOTHER LICENSEE'S REGISTRATION NUMBER.
 * VA, MD and DC all require the advertising agent's own brokerage and licence,
 * so that is not a cosmetic slip — and nothing on the page would look wrong.
 *
 * Inverted, so the failure is loud and harmless instead of quiet and
 * regulatory. A missing variable now renders visibly unset. Candee's own
 * deployment supplies these through the environment like every other tenant;
 * see .env.example.
 */

const PLACEHOLDER = {
  name: "Agent name not set",
  email: "not-set@example.com",
  phone: "(000) 000-0000",
  brokerage: "Brokerage not set",
  license: "LICENCE NOT SET",
} as const;

export const agent = {
  name: process.env.NEXT_PUBLIC_AGENT_NAME || PLACEHOLDER.name,
  email: process.env.NEXT_PUBLIC_AGENT_EMAIL || PLACEHOLDER.email,
  phone: process.env.NEXT_PUBLIC_AGENT_PHONE || PLACEHOLDER.phone,
  brokerage: process.env.NEXT_PUBLIC_AGENT_BROKERAGE || PLACEHOLDER.brokerage,
  license: process.env.NEXT_PUBLIC_AGENT_LICENSE || PLACEHOLDER.license,
  /** Optional; the image element hides itself when the file is absent. */
  headshot: process.env.NEXT_PUBLIC_AGENT_HEADSHOT || "/candee-headshot.png",
  /**
   * Which market's live figures the landing page shows. A key from
   * lib/markets.ts — "fairfax", "dc", "montgomery", …
   *
   * NO DEFAULT, deliberately. This used to fall back to "fairfax", which meant a
   * Bethesda tenant who forgot the variable served Fairfax medians to Maryland
   * homeowners — the exact failure per-tenant market config was built to
   * prevent, reintroduced through the default. Unset resolves to null and the
   * hero renders its coverage panel, which is the safe direction to fail in.
   */
  market: process.env.NEXT_PUBLIC_AGENT_MARKET || "",
} as const;

/**
 * Which required variables are missing.
 *
 * Exported so a deployment check can assert on it rather than a human noticing
 * "LICENCE NOT SET" in a screenshot after the fact.
 */
export function missingAgentConfig(): string[] {
  const missing: string[] = [];
  if (agent.name === PLACEHOLDER.name) missing.push("NEXT_PUBLIC_AGENT_NAME");
  if (agent.email === PLACEHOLDER.email) missing.push("NEXT_PUBLIC_AGENT_EMAIL");
  if (agent.phone === PLACEHOLDER.phone) missing.push("NEXT_PUBLIC_AGENT_PHONE");
  if (agent.brokerage === PLACEHOLDER.brokerage) missing.push("NEXT_PUBLIC_AGENT_BROKERAGE");
  if (agent.license === PLACEHOLDER.license) missing.push("NEXT_PUBLIC_AGENT_LICENSE");
  if (!agent.market) missing.push("NEXT_PUBLIC_AGENT_MARKET");
  return missing;
}

/** True when the page would carry no valid brokerage or licence. */
export function hasAdvertisingIdentity(): boolean {
  return (
    agent.brokerage !== PLACEHOLDER.brokerage && agent.license !== PLACEHOLDER.license
  );
}

/** First name only, for the conversational copy on the lead gate. */
export const agentFirstName = agent.name.split(" ")[0];

export const agentInitials = agent.name
  .split(" ")
  .filter(Boolean)
  .slice(0, 2)
  .map(p => p[0]?.toUpperCase() ?? "")
  .join("");
