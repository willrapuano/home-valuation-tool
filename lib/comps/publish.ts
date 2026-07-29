import { ValuationResult } from "./types";

/**
 * Is this estimate good enough to put in front of a homeowner?
 *
 * Producing an estimate and publishing one are different decisions. The engine
 * is already honest about uncertainty — it widens the range as confidence
 * falls — but a range does not undo an anchor. A homeowner shown "$1,650,000
 * (range $990,000–$2,310,000)" remembers $1.65M, and if the house is worth
 * $1.1M the agent inherits a conversation that starts from a number we
 * invented.
 *
 * MEASURED, not assumed. `scripts/confidence-calibration.ts` over 291 holdout
 * sales across DC, Maryland and Fairfax:
 *
 *   confidence   share   MdAPE   off >20%   off >30%   range width
 *   high          60%     4.5%       10%        5%         24%
 *   medium        29%    11.6%       16%        8%         48%
 *   low           10%    16.4%       40%       20%         80%
 *
 * At low confidence two estimates in five are more than 20% wrong and one in
 * five is more than 30% wrong, around a range so wide it carries no
 * information. That is not a valuation; it is a guess with error bars.
 *
 * Suppressing it costs 10% of valuations their number, and those users get the
 * agent-CMA path instead — which is what the funnel converts on anyway, and
 * which is the same reasoning that removed the ZIP-code average: a number that
 * isn't really about the subject property has no business on the screen.
 *
 * Medium is published. 16% beyond 20% is materially worse than high, but the
 * estimate still tracks the property, and the 48% range communicates the
 * uncertainty rather than hiding it.
 */
export type PublishDecision =
  | { publish: true }
  | { publish: false; reason: "low_confidence" | "no_estimate" };

export function shouldPublishEstimate(
  result: Pick<ValuationResult, "estimate" | "confidence">
): PublishDecision {
  // `> 0` rather than `!== null`: a zero or negative estimate is not a
  // valuation, and printing "$0" to a homeowner would be worse than printing
  // nothing. reconcile() should never produce one, which is exactly why the
  // guard belongs here rather than being assumed away.
  if (result.estimate === null || !(result.estimate > 0) || result.confidence === "none") {
    return { publish: false, reason: "no_estimate" };
  }
  if (result.confidence === "low") {
    return { publish: false, reason: "low_confidence" };
  }
  return { publish: true };
}
