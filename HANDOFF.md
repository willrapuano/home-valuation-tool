# Handoff: port the production-parity check to another Vercel/Next app

Written for the `velocity-connectors` session. Nothing here is specific to this
repository except two strings you will replace.

## Why you want this

This project spent a full working session with production **eight commits
behind** the branch — the landing page redesigned, three county medians
corrected, an accuracy gate built — while the live site served the old build,
because a pull request was open and nothing ever asked production what it was
running.

Every check that existed passed. Local tests, local screenshots, live backtests
against real county services: all green, all against a build no user saw. The
gap was invisible because nothing in the codebase could see it.

`velocity-connectors` reportedly burned eleven sessions on this shape. The fix
is three files and about twenty minutes.

## The three artifacts

### 1. `app/api/version/route.ts` — production answers what it is

```ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    // Vercel injects these at build time. Absent locally, which is the correct
    // answer: a dev server is not a deployment.
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? "local",
    // Add whatever config differs between "what was reviewed" and "what is
    // serving". NEXT_PUBLIC_* bakes at build time, so a matching SHA can still
    // be serving the wrong configuration — that is the second half of the bug.
  });
}
```

No secrets. A commit SHA and branch name are public information for a repository
the deployer already controls, and a parity check that needs a token is a parity
check that gets skipped.

### 2. `scripts/production-parity.ts` — compare it to the merged HEAD

Copy `scripts/production-parity.ts` from this repo. Change one constant:

```ts
const DEFAULT_URL = process.env.PARITY_URL ?? "https://YOUR-APP.vercel.app";
```

The shape that matters:

- Compares against **`origin/main`**, not local `HEAD` — the question is whether
  production matches what was *merged*.
- **Retries with backoff** (10s → 60s, six attempts). A deployment still
  building must be a pass, not a false alarm, or the check gets disabled within
  a week for crying wolf.
- **A 404 is a definitive failure, not an error.** If `/api/version` is missing,
  the running build predates the check and is by definition out of date. Do not
  treat this as "could not determine".
- Exits non-zero so it can gate a workflow.
- Reports **RIGHT COMMIT, WRONG CONFIGURATION** separately from OUT OF SYNC.
  These have different fixes — one is a merge, the other is a dashboard setting
  plus a redeploy — and collapsing them wastes the reader's time.

### 3. `.github/workflows/production-parity.yml` — make it not a discipline

```yaml
name: production parity
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 13 * * *"
  workflow_dispatch:

jobs:
  parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - env:
          PARITY_URL: ${{ vars.PARITY_URL }}
          PARITY_ATTEMPTS: "8"
        run: npx tsx scripts/production-parity.ts "$PARITY_URL" "${{ github.sha }}"
```

The **push trigger** is the one that matters — it turns "did the deployment
happen" from something a human remembers into something that fails red. The
**schedule** catches the other direction: a rollback, a cleared environment
variable, a tenant's config unset in the dashboard.

## Two things that will bite

**Vercel's system environment variables may be off.** If parity reports the
production SHA as `null` rather than mismatched, `VERCEL_GIT_COMMIT_SHA` is not
being exposed to the build. Project Settings → Environment Variables →
"Automatically expose System Environment Variables". A settings flip, not a real
failure — and the script should say which it is rather than reporting red.

**Preview deployments sit behind Vercel SSO.** Parity targets production, which
is public, so this does not affect the check. It does mean you cannot verify a
preview with plain `curl`; use the Vercel MCP `web_fetch_vercel_url` tool or a
share link.

## The generalisation, if you only take one thing

This is the fourth member of a family this org keeps rediscovering:

| what was silent | what it was read as |
|---|---|
| empty stdout from a subprocess | "no output, therefore success" |
| a market contributing zero rows | "not in scope" |
| a request timing out | "no data for this address" |
| a stale capability claim | "I can't do that" |
| **a deployment that never happened** | **"shipped"** |

The contract is the same every time: **a missing result must be reported,
counted or retried — never returned as an empty one.** Parity is that contract
applied to deployment.
