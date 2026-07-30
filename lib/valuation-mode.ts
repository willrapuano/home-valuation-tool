/**
 * Whether the tool shows a number, or promises one in the post.
 *
 * WHY THIS IS A SETTING AND NOT A DECISION
 *
 * Two products share this codebase and they convert differently.
 *
 * INSTANT gives the visitor a figure on screen. It is the Homebot shape: the
 * number is the payoff, and the visitor leaves satisfied.
 *
 * MAILED gives them the comparable sales — public record, verifiable, and the
 * thing an agent actually opens with — and commits to an agent-prepared report
 * arriving by post. The number is the follow-up rather than the payoff, and it
 * arrives with the agent's name on it.
 *
 * THE LEAD IS CAPTURED EITHER WAY. Step 3 is the email gate and step 4 is the
 * result, so the address and email are already in the CRM before any figure
 * would have been shown. Withholding the number costs nothing in lead volume;
 * it changes what the visitor does next, not whether we know who they are.
 *
 * WHAT MAILED MODE BUYS
 *
 *   - COVERAGE goes from three jurisdictions to everywhere. Arlington,
 *     Loudoun, Alexandria and Prince William publish no sales data, so they
 *     can never produce an instant figure — but they can be researched in the
 *     days before a letter goes out.
 *   - The 20-second request budget stops mattering. Every awkward compromise
 *     in the providers exists because of it: hedged requests, two-rung
 *     ladders, a 200-comp cap, a confidence gate that withholds roughly a
 *     fifth of estimates. A batch job overnight has none of those limits and
 *     can afford a wider search and more comps.
 *   - A HUMAN SEES IT before a homeowner does, which is a different and much
 *     stronger guarantee than any confidence score.
 *
 * WHAT IT DOES NOT BUY: data. A mailed Arlington report still needs Arlington
 * sales from somewhere. Mail moves the deadline from twenty seconds to three
 * days, which is enormously more forgiving, but on day three the data still
 * has to exist.
 */

export type ValuationMode = "instant" | "mailed";

/**
 * Server-side so the estimate never reaches the browser in mailed mode.
 * Deciding this in the client would leave the figure sitting in the network
 * response for anyone who opened devtools, which is not "we did not show you a
 * number" — it is "we hid one from you".
 */
export function valuationMode(): ValuationMode {
  return process.env.VALUATION_MODE?.trim().toLowerCase() === "mailed"
    ? "mailed"
    : "instant";
}

/**
 * Whether a computed estimate may be sent to the browser.
 *
 * The estimate is still COMPUTED in mailed mode — the comps come from the same
 * pass, and the figure is worth recording so the two modes can be compared on
 * the same traffic. It just does not leave the server.
 */
export function mayPublishEstimate(mode: ValuationMode = valuationMode()): boolean {
  return mode === "instant";
}

/**
 * Set NEXT_PUBLIC_VALUATION_MODE to the same value when running in mailed
 * mode. It is read by the lead gate, which renders BEFORE the valuation call
 * and so has nothing else to go on.
 *
 * It affects COPY ONLY. `valuationMode()` above is what withholds the
 * estimate, and it is server-side, so the two disagreeing produces wrong
 * wording rather than a leaked figure.
 */
