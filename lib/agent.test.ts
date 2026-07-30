import { describe, expect, it } from "vitest";
import { agent, hasAdvertisingIdentity, missingAgentConfig } from "./agent";

/**
 * These run with no NEXT_PUBLIC_AGENT_* set, so they exercise exactly the
 * misconfigured-tenant case.
 */
describe("agent config defaults", () => {
  /**
   * THE REGULATORY ONE. Defaults used to be Candee's real name, email, phone
   * and VA licence number, so a second agent who forgot one variable shipped a
   * page carrying another licensee's registration — and nothing looked wrong.
   */
  it("never falls back to a real person's identity", () => {
    const identity = [agent.name, agent.email, agent.phone, agent.brokerage, agent.license]
      .join(" ")
      .toLowerCase();
    expect(identity).not.toContain("candee");
    expect(identity).not.toContain("currie");
    expect(identity).not.toContain("ttrsir");
    expect(identity).not.toContain("sotheby");
    // The specific VA licence number that used to be the default.
    expect(identity).not.toContain("0225203164");
    expect(identity).not.toContain("703) 203-6005");
  });

  it("renders visibly unset rather than blank", () => {
    for (const v of [agent.name, agent.brokerage, agent.license]) {
      expect(v.length).toBeGreaterThan(0);
      expect(v.toLowerCase()).toContain("not set");
    }
  });

  /**
   * A default of "fairfax" meant a Bethesda tenant who forgot the variable
   * served Fairfax medians to Maryland homeowners — the exact failure
   * per-tenant market config exists to prevent, reintroduced via the default.
   */
  it("does not guess a market", () => {
    expect(agent.market).toBe("");
  });

  it("reports every missing variable", () => {
    const missing = missingAgentConfig();
    for (const key of [
      "NEXT_PUBLIC_AGENT_NAME",
      "NEXT_PUBLIC_AGENT_EMAIL",
      "NEXT_PUBLIC_AGENT_PHONE",
      "NEXT_PUBLIC_AGENT_BROKERAGE",
      "NEXT_PUBLIC_AGENT_LICENSE",
      "NEXT_PUBLIC_AGENT_MARKET",
    ]) {
      expect(missing).toContain(key);
    }
  });

  it("knows when the page carries no valid advertising identity", () => {
    expect(hasAdvertisingIdentity()).toBe(false);
  });
});
