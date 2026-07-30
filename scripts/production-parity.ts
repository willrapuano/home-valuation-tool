/**
 * Is production running what the repository says it is?
 *
 *   npx tsx scripts/production-parity.ts [url] [expectedSha]
 *
 * WHY THIS EXISTS
 *
 * Everything in this repository is verified against a LOCAL build — screenshots
 * from `next start`, tests from vitest, backtests against live county services.
 * None of that says anything about what a homeowner is being served.
 *
 * Measured 2026-07-30: while this session redesigned the landing page, built the
 * accuracy display gate and corrected three county medians, the live site went
 * on serving a build EIGHT COMMITS BEHIND — "⚡ 30-Second Results", "🔒 100%
 * Private" and an unrounded seven-digit estimate — because the pull request was
 * open and never merged. Every "verified by rendering" in that work was true and
 * none of it was deployed.
 *
 * That is the same silent-absence failure as a market contributing zero rows to
 * a backtest, or a county service returning 200 with stale data: nothing errors,
 * so nothing is noticed. This makes it loud.
 *
 * WHAT IT CHECKS
 *
 *   1. /api/version answers at all — a deployment that 404s here predates this
 *      check and is by definition out of date.
 *   2. Its commit SHA matches the expected one (default: local origin/main).
 *   3. The settings most likely to drift — valuation mode, tenant market.
 *
 * Exits non-zero on any mismatch, so it can gate a workflow.
 */

import { execSync } from "node:child_process";

const DEFAULT_URL = process.env.PARITY_URL ?? "https://home-valuation-tool.vercel.app";
/**
 * Vercel builds take a minute or two after a merge. Polling briefly turns "the
 * deployment had not finished yet" into a pass rather than a false alarm, which
 * is what makes this safe to run automatically on push.
 */
const ATTEMPTS = Number(process.env.PARITY_ATTEMPTS ?? 6);
const BACKOFF_MS = [10_000, 20_000, 30_000, 45_000, 60_000, 60_000];

interface Version {
  sha: string | null;
  branch: string | null;
  environment: string;
  valuationMode: string;
  publicValuationMode?: string;
  market: string | null;
  missingAgentConfig?: string[];
  hasAdvertisingIdentity?: boolean;
}

function expectedSha(): string {
  const arg = process.argv[3];
  if (arg) return arg.trim();
  try {
    // origin/main, not HEAD: the question is whether production matches what
    // has been MERGED, not whatever happens to be checked out locally.
    return execSync("git rev-parse origin/main", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "could not resolve origin/main — pass the expected SHA as the second argument"
    );
  }
}

async function fetchVersion(url: string): Promise<Version | null> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/version`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "cache-control": "no-cache" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/version returned ${res.status}`);
  return (await res.json()) as Version;
}

async function main() {
  const url = process.argv[2] ?? DEFAULT_URL;
  const want = expectedSha();

  console.log(`Checking ${url}`);
  console.log(`Expecting ${want.slice(0, 7)} (origin/main)\n`);

  let last: Version | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      console.log(`  not yet — waiting ${wait / 1000}s (attempt ${attempt + 1}/${ATTEMPTS})`);
      await new Promise(r => setTimeout(r, wait));
    }

    let got: Version | null;
    try {
      got = await fetchVersion(url);
    } catch (err) {
      console.log(`  request failed: ${(err as Error)?.message}`);
      continue;
    }

    if (got === null) {
      // /api/version did not exist before this check did, so a 404 is itself a
      // definitive answer: production predates it.
      console.error(
        `\n✗ OUT OF DATE — /api/version is not deployed.\n` +
          `  The running build predates this check, so it is at least as old as\n` +
          `  the commit that introduced it. Merge and redeploy.`
      );
      process.exit(1);
    }

    last = got;
    if (got.sha === want) {
      console.log(`\n✓ IN SYNC — ${got.sha?.slice(0, 7)} on ${got.branch}`);
      console.log(`  environment   ${got.environment}`);
      console.log(`  valuationMode ${got.valuationMode}`);
      console.log(`  market        ${got.market ?? "(unset — hero shows coverage panel)"}`);

      // Matching the SHA is necessary and not sufficient. NEXT_PUBLIC_* bake at
      // build time, so the right commit can still be serving the wrong tenant.
      const problems: string[] = [];
      if (got.missingAgentConfig?.length) {
        problems.push(`unset branding: ${got.missingAgentConfig.join(", ")}`);
      }
      if (got.hasAdvertisingIdentity === false) {
        problems.push("no brokerage or licence on the page — advertising-registration risk");
      }
      if (
        got.publicValuationMode !== undefined &&
        got.publicValuationMode !== got.valuationMode
      ) {
        problems.push(
          `VALUATION_MODE (${got.valuationMode}) disagrees with ` +
            `NEXT_PUBLIC_VALUATION_MODE (${got.publicValuationMode}) — the lead gate ` +
            `will promise the wrong thing`
        );
      }
      if (problems.length) {
        console.error(`\n✗ RIGHT COMMIT, WRONG CONFIGURATION`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
      }
      return;
    }
  }

  console.error(
    `\n✗ OUT OF SYNC\n` +
      `  production  ${last?.sha?.slice(0, 7) ?? "unknown"} on ${last?.branch ?? "unknown"}\n` +
      `  origin/main ${want.slice(0, 7)}\n\n` +
      `  Production is serving a different commit. Either a pull request is open\n` +
      `  and unmerged, or a deployment failed. Until it matches, nothing verified\n` +
      `  in this repository describes what a homeowner receives.`
  );
  process.exit(1);
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
