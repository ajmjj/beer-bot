// Decide what the live handler does with a beer number relative to the known max.
// Pure + side-effect-free so it can be unit-checked without a socket or DB.
//
//   "pass"    — within MAX_SKIP of max: insert it (and clear any held value).
//   "hold"    — runs ahead of max with nothing corroborating: quarantine, don't insert yet.
//   "confirm" — runs ahead of max but a held value is within MAX_SKIP: a real offline
//               jump, not a typo — insert the held value, then this one.
import { fileURLToPath } from "node:url";

export function guardDecision(beerNumber, maxKnown, pendingHigh, maxSkip) {
  if (beerNumber <= maxKnown + maxSkip) return "pass";
  if (pendingHigh && Math.abs(beerNumber - pendingHigh.beer_number) <= maxSkip) return "confirm";
  return "hold";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  assert(guardDecision(883, 880, null, 5) === "pass", "in range should pass");
  assert(guardDecision(885, 880, null, 5) === "pass", "exactly at threshold should pass");
  assert(guardDecision(999, 880, null, 5) === "hold", "first over-threshold should hold");
  assert(guardDecision(1000, 880, { beer_number: 999 }, 5) === "confirm", "nearby second should confirm");
  assert(guardDecision(2000, 880, { beer_number: 999 }, 5) === "hold", "far-from-held should re-hold");
  // confirm is order-independent: held could be higher than the new one
  assert(guardDecision(996, 880, { beer_number: 1000 }, 5) === "confirm", "held-higher nearby should confirm");
  console.log("guard self-check passed");
}
