// Flush-time sequence validator for the persistent write buffer.
//
// Beers wait in `pending_beers` for the WhatsApp 15-minute edit window, then flush oldest
// first. At flush we decide each number against `established` (the highest confirmed beer)
// WITH HINDSIGHT — we already have the ~15 min of beers that followed. That lets us judge a
// jump by whether the group's later count actually continued through it, instead of the old
// blind MAX_SKIP guess:
//
//   n <= established        -> "backfill"   (caller: fill the gap if the slot is free, else duplicate)
//   n == established + 1     -> "accept"     (the normal next step)
//   n  > established + 1     -> jump: "accept" iff >= CORROBORATION later beers continue from n
//                              (i.e. sit at or above n), otherwise "quarantine" (likely typo)
//
// classifyBeer is pure so it can be unit-checked without a socket or DB; flushDue below is
// the impure sweep that applies it against the staging table. store/logger are imported
// lazily inside flushDue so `node src/buffer.js` can run the pure self-check without .env.
import { fileURLToPath } from "node:url";

export const CORROBORATION = Number(process.env.CORROBORATION) || 5;

// laterNumbers: beer numbers of still-buffered beers with a later ts than this one.
export function classifyBeer({ number, established, laterNumbers = [], corroboration = CORROBORATION }) {
  if (number <= established) return "backfill";
  if (number === established + 1) return "accept";
  // A jump: real only if the subsequent count carried on from here.
  const support = laterNumbers.filter((x) => x >= number).length;
  return support >= corroboration ? "accept" : "quarantine";
}

// Flush sweep: confirm every staged beer whose edit window has closed. Runs on a timer;
// stateless (reads the whole staging table each pass) so a restart just resumes.
// `established` seeds from the confirmed max and grows as we accept; the still-staged rows
// after each entry are its corroboration look-ahead.
export async function flushDue(now = Date.now()) {
  const { getAllPending, getMaxBeerNumber, insertBeers, deletePending, insertQuarantined } = await import("./store.js");
  const { log } = await import("./logger.js");

  const pending = await getAllPending(); // oldest ts first
  if (!pending.length) return;
  let established = await getMaxBeerNumber();

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    if (new Date(row.flush_at).getTime() > now) continue; // window still open
    const laterNumbers = pending.slice(i + 1).map((r) => r.beer_number);
    const decision = classifyBeer({ number: row.beer_number, established, laterNumbers });
    try {
      if (decision === "quarantine") {
        await insertQuarantined(row, "uncorroborated jump");
        await deletePending(row.wa_message_id);
        log.warn({ beer: row.beer_number, member: row.member }, "beer quarantined (uncorroborated jump)");
      } else {
        // accept or backfill — insertBeers dedupes on beer_number + wa_message_id, so a taken
        // slot or an already-confirmed message is a no-op (0 inserted) that we just drop.
        const inserted = await insertBeers([{ ...row, source: "live" }]);
        await deletePending(row.wa_message_id);
        if (inserted) {
          if (row.beer_number > established) established = row.beer_number;
          log.info({ beer: row.beer_number, member: row.member }, "beer confirmed");
        } else {
          log.info({ beer: row.beer_number, member: row.member }, "pending dropped (duplicate)");
        }
      }
    } catch (err) {
      log.error({ beer: row.beer_number, err }, "flush failed for beer"); // stays staged, retried next sweep
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const C = 5;
  const call = (number, established, laterNumbers) => classifyBeer({ number, established, laterNumbers, corroboration: C });

  // Normal sequence.
  assert(call(101, 100, []) === "accept", "established+1 accepts with no lookahead");
  assert(call(100, 100, []) === "backfill", "equal to established is backfill (duplicate/gap)");
  assert(call(90, 100, []) === "backfill", "below established is backfill");

  // Uncorroborated jump = typo -> quarantine. Later beers ignored it, continuing from 100.
  assert(call(200, 100, [101, 102, 103, 104, 105]) === "quarantine", "lone +100 jump quarantined");
  assert(call(105, 100, [101, 102, 103, 104]) === "quarantine", "jump with <5 supporters quarantined");

  // Corroborated jump = real -> accept, however big, once >=5 later beers continue from it.
  assert(call(200, 100, [201, 202, 203, 204, 205]) === "accept", "+100 jump the group continued -> accept");
  assert(call(105, 100, [106, 107, 108, 109, 110]) === "accept", "+5 offline gap the count continued -> accept");
  assert(call(200, 100, [201, 202, 203, 204]) === "quarantine", "exactly one short of threshold quarantines");
  assert(call(200, 100, [200, 201, 202, 203, 204]) === "accept", "supporters at-or-above n count (>= n)");

  console.log("buffer validator self-check passed");
}
