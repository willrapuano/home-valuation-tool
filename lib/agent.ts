/**
 * Agent branding, in one place.
 *
 * This tool is resold: the same codebase is deployed per agent and configured
 * through NEXT_PUBLIC_AGENT_*. The name, brokerage, licence and phone were
 * previously typed literally into the header, the footer, the lead gate and the
 * results screen, so every new deployment meant hunting for hardcoded
 * "Candee Currie" strings — and the landing redesign would have added several
 * more.
 *
 * Each `process.env.NEXT_PUBLIC_…` lookup must be written out in full rather
 * than built from a variable: Next.js inlines these at build time by literal
 * text substitution, and a computed key silently becomes undefined.
 */
export const agent = {
  name: process.env.NEXT_PUBLIC_AGENT_NAME || "Candee Currie",
  email: process.env.NEXT_PUBLIC_AGENT_EMAIL || "ccurrie@ttrsir.com",
  phone: process.env.NEXT_PUBLIC_AGENT_PHONE || "(703) 203-6005",
  brokerage: process.env.NEXT_PUBLIC_AGENT_BROKERAGE || "TTR Sotheby's International Realty",
  license: process.env.NEXT_PUBLIC_AGENT_LICENSE || "VA License 0225203164",
  /** Optional; the agent card falls back to initials when absent. */
  headshot: process.env.NEXT_PUBLIC_AGENT_HEADSHOT || "/candee-headshot.png",
} as const;

/** First name only, for the conversational copy on the lead gate. */
export const agentFirstName = agent.name.split(" ")[0];

export const agentInitials = agent.name
  .split(" ")
  .filter(Boolean)
  .slice(0, 2)
  .map(p => p[0]?.toUpperCase() ?? "")
  .join("");
