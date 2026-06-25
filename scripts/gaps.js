// Check for gaps and duplicates in the beer sequence.
// Usage: node scripts/gaps.js
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from("beers")
  .select("beer_number, member, ts, deleted_at")
  .order("beer_number", { ascending: true });

if (error) { console.error(error.message); process.exit(1); }

const active = data.filter((r) => !r.deleted_at);
const deleted = data.filter((r) => r.deleted_at);

console.log(`Total rows: ${data.length}  Active: ${active.length}  Soft-deleted: ${deleted.length}\n`);

// Gaps
const nums = active.map((r) => r.beer_number);
const gaps = [];
for (let i = 1; i < nums.length; i++) {
  if (nums[i] !== nums[i - 1] + 1) {
    gaps.push({ after: nums[i - 1], before: nums[i], missing: nums[i] - nums[i - 1] - 1 });
  }
}

if (gaps.length === 0) {
  console.log("No gaps — sequence is clean.");
} else {
  console.log(`${gaps.length} gap(s):`);
  for (const g of gaps) {
    const range = g.missing === 1 ? `#${g.after + 1}` : `#${g.after + 1}–#${g.before - 1}`;
    console.log(`  ${range}  (${g.missing} missing, between #${g.after} and #${g.before})`);
  }
}

// Soft-deleted — show what's in limbo
if (deleted.length) {
  console.log(`\nSoft-deleted beers (not in active sequence):`);
  for (const r of deleted) {
    console.log(`  #${r.beer_number}  ${r.member}  ${new Date(r.ts).toLocaleString()}`);
  }
}
