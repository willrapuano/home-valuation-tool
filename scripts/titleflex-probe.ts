/**
 * TitleFlex API discovery probe.
 *
 * Rather than waiting on vendor documentation, this works out the integration
 * details empirically: it tries the plausible combinations of auth shape,
 * endpoint path and HTTP method, reports which one the API accepts, then runs
 * the field-mapping reconciliation against whatever came back.
 *
 * Usage:
 *   TITLEFLEX_API_URL=https://... TITLEFLEX_API_KEY=... npm run probe:titleflex
 *
 * Flags:
 *   --save     write the raw response to .titleflex-sample.json (gitignored)
 *   --full     print untruncated field values
 *   --path=/x  probe only this path
 *
 * The API key is never printed, and response bodies are only shown for the
 * first successful call.
 */

import { writeFileSync } from "node:fs";
import { describeResponse, extractRecords, mapRecord } from "../lib/comps/providers/titleflex";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) =>
  args.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const API_URL = process.env.TITLEFLEX_API_URL?.replace(/\/+$/, "");
const API_KEY = process.env.TITLEFLEX_API_KEY;
const TIMEOUT_MS = Number(process.env.TITLEFLEX_TIMEOUT_MS) || 12_000;

/** Auth shapes worth trying, most likely first. */
const AUTH_SHAPES: { header: string; scheme: string; label: string }[] = [
  { header: "Authorization", scheme: "Bearer", label: "Authorization: Bearer <key>" },
  { header: "X-API-Key", scheme: "", label: "X-API-Key: <key>" },
  { header: "Authorization", scheme: "", label: "Authorization: <key>" },
  { header: "apikey", scheme: "", label: "apikey: <key>" },
  { header: "X-Auth-Token", scheme: "", label: "X-Auth-Token: <key>" },
];

/** Candidate endpoints for "nearby closed sales". */
const CANDIDATE_PATHS = [
  "/property/sales/search",
  "/property/search",
  "/properties/search",
  "/api/property/search",
  "/v1/property/search",
  "/search/sales",
  "/comparables",
  "/property/comparables",
  "/sales/search",
];

/** A McLean, VA point — real coordinates so a geographic search returns rows. */
const PROBE_BODY = {
  latitude: 38.94,
  longitude: -77.161,
  radiusMiles: 1,
  limit: 5,
};

const PROBE_QUERY = "latitude=38.94&longitude=-77.161&radiusMiles=1&limit=5";

interface Attempt {
  method: "GET" | "POST";
  path: string;
  auth: string;
  status: number | string;
  ms: number;
  note: string;
}

async function attempt(
  method: "GET" | "POST",
  path: string,
  shape: (typeof AUTH_SHAPES)[number]
): Promise<{ result: Attempt; payload?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  const url = method === "GET" ? `${API_URL}${path}?${PROBE_QUERY}` : `${API_URL}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        [shape.header]: shape.scheme ? `${shape.scheme} ${API_KEY}` : API_KEY!,
      },
      ...(method === "POST" ? { body: JSON.stringify(PROBE_BODY) } : {}),
      signal: controller.signal,
    });

    const ms = Date.now() - started;
    const base = { method, path, auth: shape.label, status: res.status, ms };

    if (!res.ok) {
      return { result: { ...base, note: describeStatus(res.status) } };
    }

    const text = await res.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { result: { ...base, note: "200 but body was not JSON" } };
    }

    const records = extractRecords(payload);
    return {
      result: {
        ...base,
        note: records.length
          ? `OK — ${records.length} record(s)`
          : "200 but no record array found (shape may be unrecognised)",
      },
      payload,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const aborted = (err as Error)?.name === "AbortError";
    return {
      result: {
        method, path, auth: shape.label,
        status: aborted ? "timeout" : "error",
        ms,
        note: aborted ? `no response in ${TIMEOUT_MS}ms` : String((err as Error)?.message ?? err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeStatus(status: number): string {
  if (status === 401) return "unauthenticated — wrong auth shape, or key not valid for this endpoint";
  if (status === 403) return "forbidden — auth accepted but not entitled to this resource";
  if (status === 404) return "no such endpoint";
  if (status === 405) return "endpoint exists, wrong HTTP method";
  if (status === 400 || status === 422) return "endpoint exists — request parameters are wrong";
  if (status === 429) return "rate limited — endpoint exists";
  return `HTTP ${status}`;
}

function truncate(v: unknown): unknown {
  if (flag("full")) return v;
  if (typeof v === "string" && v.length > 60) return `${v.slice(0, 60)}…`;
  return v;
}

async function main() {
  if (!API_URL || !API_KEY) {
    console.error("✗ TITLEFLEX_API_URL and TITLEFLEX_API_KEY must both be set.\n");
    console.error("  TITLEFLEX_API_URL=https://api.example.com \\");
    console.error("  TITLEFLEX_API_KEY=... \\");
    console.error("  npm run probe:titleflex");
    process.exit(1);
  }

  const paths = value("path") ? [value("path")!] : CANDIDATE_PATHS;

  console.log(`Probing ${API_URL}`);
  console.log(`  key: ${API_KEY.length} chars (not shown)`);
  console.log(`  ${paths.length} path(s) × ${AUTH_SHAPES.length} auth shape(s) × 2 methods\n`);

  const attempts: Attempt[] = [];
  let success: { result: Attempt; payload: unknown } | null = null;

  outer: for (const path of paths) {
    for (const shape of AUTH_SHAPES) {
      for (const method of ["POST", "GET"] as const) {
        const { result, payload } = await attempt(method, path, shape);
        attempts.push(result);

        // Anything other than 404/405 means the endpoint is real; stop
        // hammering every auth shape against a path that doesn't exist.
        if (result.status === 404) break;

        if (payload !== undefined) {
          success = { result, payload };
          break outer;
        }
      }
    }
  }

  // Only show attempts that tell us something — a wall of 404s is noise.
  const interesting = attempts.filter(a => a.status !== 404);
  if (interesting.length) {
    console.log("Informative responses:");
    for (const a of interesting) {
      console.log(`  ${String(a.status).padEnd(8)} ${a.method.padEnd(4)} ${a.path.padEnd(26)} ${a.auth.padEnd(28)} ${a.note}`);
    }
    console.log();
  }

  const tried404 = attempts.filter(a => a.status === 404).length;
  if (tried404) console.log(`(${tried404} path(s) returned 404 — not shown)\n`);

  if (!success) {
    console.log("✗ No endpoint returned usable JSON.\n");
    console.log("Next steps:");
    console.log("  • If you saw 401/403 everywhere, the auth shape is wrong or the key");
    console.log("    lacks entitlement — ask DataTrace which header they expect.");
    console.log("  • If everything 404'd, the base URL or path is wrong. Re-run with");
    console.log("    --path=/their/actual/path once you know it.");
    console.log("  • If you saw 400/422, the endpoint is right and only the request");
    console.log("    parameter names need correcting.");
    process.exit(2);
  }

  const { result, payload } = success;

  console.log("✓ Working combination found\n");
  console.log("Add to your environment:");
  const shape = AUTH_SHAPES.find(s => s.label === result.auth)!;
  console.log(`  TITLEFLEX_SEARCH_PATH=${result.path}`);
  console.log(`  TITLEFLEX_AUTH_HEADER=${shape.header}`);
  console.log(`  TITLEFLEX_AUTH_SCHEME=${shape.scheme}`);
  if (result.method === "GET") {
    console.log("\n  ⚠ This endpoint answered GET, not POST. The provider currently");
    console.log("    issues POST — tell Claude and it will switch the method.");
  }
  console.log();

  const description = describeResponse(payload);
  console.log(`Response contained ${description.recordCount} record(s).\n`);

  console.log("Field mapping:");
  const unresolved: string[] = [];
  for (const [field, alias] of Object.entries(description.resolved)) {
    if (alias) {
      console.log(`  ✓ ${field.padEnd(14)} ← ${alias}`);
    } else {
      unresolved.push(field);
      console.log(`  ✗ ${field.padEnd(14)}   NOT FOUND`);
    }
  }

  if (description.unmappedKeys.length) {
    console.log(`\nVendor fields we are ignoring (${description.unmappedKeys.length}):`);
    console.log(`  ${description.unmappedKeys.join(", ")}`);
  }

  const sample = extractRecords(payload)[0];
  if (sample) {
    console.log("\nFirst record:");
    for (const [k, v] of Object.entries(sample)) {
      console.log(`  ${k}: ${JSON.stringify(truncate(v))}`);
    }

    const mapped = mapRecord(sample);
    console.log(
      mapped
        ? `\n✓ Sample record maps cleanly to a comparable (${mapped.propertyType}, $${mapped.soldPrice.toLocaleString()}, ${mapped.soldDate}).`
        : "\n✗ Sample record could not be mapped — price, date or coordinates are missing under any known alias."
    );
  }

  if (unresolved.length) {
    console.log(`\n⚠ ${unresolved.length} field(s) unresolved: ${unresolved.join(", ")}`);
    console.log("  Send this output to Claude, or add the correct vendor names to the");
    console.log("  front of the relevant arrays in lib/comps/providers/titleflex.ts.");
  }

  if (flag("save")) {
    writeFileSync(".titleflex-sample.json", JSON.stringify(payload, null, 2));
    console.log("\n→ Raw response written to .titleflex-sample.json (gitignored).");
    console.log("  Check it for anything sensitive before sharing it.");
  } else {
    console.log("\nTip: re-run with --save to write the raw response to a gitignored file.");
  }
}

main().catch(err => {
  console.error("Probe failed:", err?.message ?? err);
  process.exit(1);
});
