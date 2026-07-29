"use client";

import { EventName } from "./analytics";

/**
 * Client-side funnel tracking.
 *
 * Three rules, all of which exist because analytics has no business degrading
 * the thing it is measuring:
 *
 *   1. Never throws. A tracking failure must not surface to a homeowner.
 *   2. Never awaited. Nothing in the funnel waits on an event being recorded.
 *   3. Never sends identity. The payload is assembled here from a short
 *      allow-list, so an email or street address cannot reach it by accident
 *      even if a caller passes the whole valuation object.
 */

const SESSION_KEY = "hv_session";

/**
 * A random id per browser session, so one visitor's steps can be joined.
 * sessionStorage rather than a cookie or localStorage: it dies with the tab,
 * which is the shortest lifetime that still answers the question.
 */
function sessionId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // Private browsing can refuse storage; an unjoined event still counts.
    return "anonymous";
  }
}

export interface TrackFields {
  zipCode?: string;
  jurisdiction?: string;
  hasEstimate?: boolean;
  confidence?: string;
  degradedCode?: string;
}

export function track(name: EventName, fields: TrackFields = {}): void {
  if (typeof window === "undefined") return;

  const body = JSON.stringify({
    name,
    sessionId: sessionId(),
    // Explicit allow-list. Spreading `fields` would eventually carry whatever
    // a future caller happened to have in scope.
    zipCode: fields.zipCode,
    jurisdiction: fields.jurisdiction,
    hasEstimate: fields.hasEstimate,
    confidence: fields.confidence,
    degradedCode: fields.degradedCode,
  });

  try {
    // sendBeacon survives the page being navigated away from, which is exactly
    // when the interesting events (abandonment) happen.
    if (navigator.sendBeacon?.(("/api/events"), new Blob([body], { type: "application/json" }))) {
      return;
    }
  } catch {
    /* fall through to fetch */
  }

  try {
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* tracking must never surface to the user */
  }
}
