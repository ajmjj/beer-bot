// RCA for skipped beers. Classifies each gap as likely human (group skipped) or
// likely system (bot failed to capture) based on time delta between surrounding beers.
//
// Heuristic: if the beer before and after a gap are < 30s apart, the chain was moving
// fast — someone almost certainly sent something the bot couldn't parse (system miss).
// If > 60s, the group just skipped that number (human miss).
//
// Usage: node scripts/rca-gaps.js
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from("beers")
  .select("beer_number, member, ts")
  .order("beer_number", { ascending: true });
if (error) { console.error(error.message); process.exit(1); }

const SYSTEM_THRESHOLD_S = 30;
const HUMAN_THRESHOLD_S  = 60;

const gaps = [];
for (let i = 1; i < data.length; i++) {
  if (data[i].beer_number !== data[i - 1].beer_number + 1) {
    const prev = data[i - 1];
    const next = data[i];
    const deltaSec = (new Date(next.ts) - new Date(prev.ts)) / 1000;
    const missing = data[i].beer_number - data[i - 1].beer_number - 1;
    const label =
      deltaSec < SYSTEM_THRESHOLD_S ? "SYSTEM" :
      deltaSec > HUMAN_THRESHOLD_S  ? "HUMAN"  : "UNCLEAR";
    gaps.push({ prev, next, missing, deltaSec, label });
  }
}

const counts = { SYSTEM: 0, HUMAN: 0, UNCLEAR: 0 };
let systemMissed = 0, humanMissed = 0, unclearMissed = 0;
for (const g of gaps) {
  counts[g.label]++;
  if (g.label === "SYSTEM")  systemMissed  += g.missing;
  if (g.label === "HUMAN")   humanMissed   += g.missing;
  if (g.label === "UNCLEAR") unclearMissed += g.missing;
}

const total = systemMissed + humanMissed + unclearMissed;
console.log(`\n=== Skipped beer RCA (${total} total missing across ${gaps.length} gaps) ===\n`);
console.log(`  SYSTEM  (< ${SYSTEM_THRESHOLD_S}s window): ${systemMissed} beers in ${counts.SYSTEM} gaps`);
console.log(`  HUMAN   (> ${HUMAN_THRESHOLD_S}s window): ${humanMissed} beers in ${counts.HUMAN} gaps`);
console.log(`  UNCLEAR (${SYSTEM_THRESHOLD_S}–${HUMAN_THRESHOLD_S}s window): ${unclearMissed} beers in ${counts.UNCLEAR} gaps`);

console.log(`\n--- SYSTEM gaps (bot likely failed to parse) ---`);
for (const g of gaps.filter(g => g.label === "SYSTEM")) {
  const range = g.missing === 1 ? `#${g.prev.beer_number + 1}` : `#${g.prev.beer_number + 1}–#${g.next.beer_number - 1}`;
  console.log(`  ${range}  (${g.missing} missing, ${g.deltaSec.toFixed(1)}s gap)`);
  console.log(`    before: #${g.prev.beer_number} by ${g.prev.member} at ${new Date(g.prev.ts).toLocaleTimeString()}`);
  console.log(`    after:  #${g.next.beer_number} by ${g.next.member} at ${new Date(g.next.ts).toLocaleTimeString()}`);
}

console.log(`\n--- UNCLEAR gaps (could be either) ---`);
for (const g of gaps.filter(g => g.label === "UNCLEAR")) {
  const range = g.missing === 1 ? `#${g.prev.beer_number + 1}` : `#${g.prev.beer_number + 1}–#${g.next.beer_number - 1}`;
  console.log(`  ${range}  (${g.missing} missing, ${g.deltaSec.toFixed(1)}s gap)`);
}

console.log(`\n--- HUMAN gaps (group skipped the number) ---`);
for (const g of gaps.filter(g => g.label === "HUMAN")) {
  const range = g.missing === 1 ? `#${g.prev.beer_number + 1}` : `#${g.prev.beer_number + 1}–#${g.next.beer_number - 1}`;
  console.log(`  ${range}  (${g.missing} missing, ${g.deltaSec.toFixed(1)}s gap)`);
}
