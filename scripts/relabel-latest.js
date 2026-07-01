// Relabel every beer of a participant to that participant's LATEST WhatsApp display name
// (the push_name on their most-recent named beer). Fixes stale names left behind when someone
// renames themselves — bot.js records the name as it was at post time and never rewrites it.
//
// Read-only by default; pass --apply to write. Idempotent.
// Usage: node scripts/relabel-latest.js [--apply]
//
// NB: "one participant, multiple names" can also be a shared device (two real people) — this
// tool does NOT guess. The dry-run lists every name per participant so you can eyeball a
// `[Alice | Bob]` case before applying (rows with 3+ names are flagged ⚠).
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { maskPhone } from "../src/parser.js";

const APPLY = process.argv.includes("--apply");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from("beers").select("beer_number, ts, participant, member, push_name").order("beer_number", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...data);
  if (data.length < 1000) break;
}

const byPart = new Map();
for (const r of rows) {
  if (!r.participant) continue;
  if (!byPart.has(r.participant)) byPart.set(r.participant, []);
  byPart.get(r.participant).push(r);
}

const clean = (n) => (n ? n.replace(/\s+/g, " ").trim() : n); // collapse/trim whitespace so "Moritz Flick " == "Moritz Flick"

let changedParts = 0, changedBeers = 0;
for (const [p, list] of byPart) {
  const named = list.filter((r) => clean(r.push_name)); // has a real (non-blank) name
  if (!named.length) continue; // nothing to normalise to
  const latest = clean(named.reduce((a, b) => (new Date(b.ts) >= new Date(a.ts) ? b : a)).push_name);
  const stale = list.filter((r) => r.push_name !== latest); // null, an older name, or a whitespace variant
  if (!stale.length) continue;

  const distinct = [...new Set(named.map((r) => clean(r.push_name)))];
  changedParts++;
  changedBeers += stale.length;
  console.log(`${maskPhone(p)}: [${distinct.join(" | ")}] -> ${JSON.stringify(latest)} — ${stale.length} beers${distinct.length > 2 ? "  ⚠ 3+ names (check for shared device)" : ""}`);

  if (APPLY) {
    const { error } = await supabase.from("beers").update({ push_name: latest, member: latest }).eq("participant", p);
    if (error) { console.error(`  ${maskPhone(p)} failed: ${error.message}`); changedParts--; changedBeers -= stale.length; }
  }
}

console.log(APPLY
  ? `Relabelled ${changedBeers} beers across ${changedParts} participants.`
  : `Would relabel ${changedBeers} beers across ${changedParts} participants. Re-run with --apply to write.`);
