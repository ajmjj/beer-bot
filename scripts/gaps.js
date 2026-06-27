// Check for gaps and duplicates in the beer sequence.
// Usage: node scripts/gaps.js
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Paginate: Supabase caps a single select at 1000 rows, which silently hid
// every gap above the 1000th beer once the table grew past that.
const data = [];
for (let from = 0; ; from += 1000) {
  const { data: page, error } = await supabase
    .from("beers")
    .select("beer_number, member, ts")
    .order("beer_number", { ascending: true })
    .range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  data.push(...page);
  if (page.length < 1000) break;
}

console.log(`Total beers: ${data.length}\n`);

// Gaps
const nums = data.map((r) => r.beer_number);
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
