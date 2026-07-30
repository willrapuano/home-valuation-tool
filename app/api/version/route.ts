import { NextResponse } from "next/server";
import { hasAdvertisingIdentity, missingAgentConfig } from "@/lib/agent";

/**
 * What is actually deployed here.
 *
 * WHY THIS EXISTS
 *
 * Every "verified by rendering" in this repository has been verified against a
 * LOCAL build. The one check that never ran was repo-versus-production parity,
 * and it turned out to matter: while the landing page was redesigned, the
 * accuracy gate built and three medians corrected, production went on serving a
 * build eight commits behind — emoji trust badges and all — because the pull
 * request was never merged. Nothing in the codebase could tell the difference,
 * because nothing ever asked production what it was running.
 *
 * `scripts/production-parity.ts` reads this and compares it against the SHA at
 * the head of the default branch. One request, and the class of failure that
 * cost this project months stops being invisible.
 *
 * NO SECRETS HERE. A commit SHA and a branch name are public information for a
 * repository the deployer already controls, and the whole point is that it can
 * be read without credentials — a parity check that needs a token is a parity
 * check that gets skipped.
 */

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    /**
     * Vercel injects these at build time. Locally they are absent, which is
     * itself the correct answer: a local dev server is not a deployment, and
     * the parity script says so rather than comparing against nothing.
     */
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? "local",
    /**
     * The two settings most likely to differ between what was reviewed and what
     * is serving. `VALUATION_MODE` decides whether a figure reaches the browser
     * at all, and `NEXT_PUBLIC_AGENT_MARKET` decides whose county figures the
     * hero prints — a tenant misconfigured here shows a Bethesda visitor
     * Fairfax medians, which is exactly what per-tenant market config exists to
     * prevent.
     */
    valuationMode: process.env.VALUATION_MODE ?? "instant",
    publicValuationMode: process.env.NEXT_PUBLIC_VALUATION_MODE ?? "instant",
    market: process.env.NEXT_PUBLIC_AGENT_MARKET ?? null,
    /**
     * Branding variables that were never set. NEXT_PUBLIC_* bake at build time,
     * so this is answerable only by the deployment itself — and a page missing
     * its brokerage or licence is an advertising-registration problem in VA, MD
     * and DC, not a cosmetic one.
     */
    missingAgentConfig: missingAgentConfig(),
    hasAdvertisingIdentity: hasAdvertisingIdentity(),
  });
}
