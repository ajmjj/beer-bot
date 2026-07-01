// Backfill push_name (and the masked member name) for beers that were posted
// without a WhatsApp display name, using a push_name already known for the same
// participant on another beer. Beers whose participant has no push_name anywhere
// are written to missing-push-names.md for manual follow-up.
//
// Read-only by default; pass --apply to write. Idempotent.
// Usage: node scripts/fill-push-names.js [--apply]
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Mirror of the DB's mask_phone(): used to tell whether `member` is just the
// anonymised participant number (a placeholder we can replace) vs a real name.
function maskPhone(m) {
  if (!m) return m;
  const digits = m.replace(/[^0-9]/g, "");
  if (/[a-zA-Z~]/.test(m) || digits.length < 8) return m;
  const mid = digits.length - 8;
  return (m[0] === "+" ? "+" : "") + digits.slice(0, 4) + "x".repeat(mid) + digits.slice(-4);
}

// Backfill null push_names from a name already known for the same participant on another beer.
// Read-only unless apply; returns { resolvable, missing, updated }. Callable standalone or from sync-gaps.
export async function fillPushNames({ apply = false } = {}) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("beers").select("beer_number, member, push_name, participant").order("beer_number", { ascending: true }).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    rows.push(...data);
    if (data.length < 1000) break;
  }

  // participant -> chosen push_name (most frequent; ties broken by first seen).
  const counts = {};
  for (const r of rows) {
    if (!r.participant || !r.push_name) continue;
    (counts[r.participant] ||= {});
    counts[r.participant][r.push_name] = (counts[r.participant][r.push_name] || 0) + 1;
  }
  const pushFor = {};
  for (const [p, names] of Object.entries(counts)) {
    pushFor[p] = Object.entries(names).sort((a, b) => b[1] - a[1])[0][0];
  }

  const nullPush = rows.filter((r) => r.push_name == null);
  const fixable = [];
  const missing = [];
  for (const r of nullPush) {
    const name = r.participant ? pushFor[r.participant] : undefined;
    if (name) fixable.push({ ...r, name });
    else missing.push(r);
  }

  console.log(`[names] ${nullPush.length} beers with NULL push_name: ${fixable.length} resolvable, ${missing.length} unmatched.`);

  let updated = 0;
  for (const r of fixable) {
    const placeholder = r.member == null || r.member === r.participant || r.member === maskPhone(r.participant);
    const patch = { push_name: r.name };
    if (placeholder) patch.member = r.name; // only overwrite the anonymised number, never a real/registered name
    if (!apply) { console.log(`[names]   would set #${r.beer_number} push_name=${JSON.stringify(r.name)}${placeholder ? ` member=${JSON.stringify(r.name)}` : ` (keep member ${JSON.stringify(r.member)})`}`); continue; }
    const { error } = await supabase.from("beers").update(patch).eq("beer_number", r.beer_number);
    if (error) { console.error(`[names]   #${r.beer_number} failed: ${error.message}`); continue; }
    updated++;
  }

  const md = [
    "# Beers with no resolvable push_name",
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} — ${missing.length} beer(s) whose participant has no push_name on any other beer, so the real name is unknown.`,
    "",
    "| Beer # | Participant ID | Current member |",
    "| ------ | -------------- | -------------- |",
    ...missing.map((r) => `| ${r.beer_number} | ${r.participant ?? "(none)"} | ${r.member ?? ""} |`),
    "",
  ].join("\n");
  writeFileSync("missing-push-names.md", md);

  return { resolvable: fixable.length, missing: missing.length, updated };
}

// Run standalone: node scripts/fill-push-names.js [--apply]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { updated, missing } = await fillPushNames({ apply: process.argv.includes("--apply") });
  console.log(process.argv.includes("--apply") ? `Applied: updated ${updated} beers. Wrote missing-push-names.md (${missing}).` : `Dry run. Wrote missing-push-names.md (${missing}). Re-run with --apply to update.`);
}
