// Audit beer→member attribution for likely mis-keys. Read-only, changes nothing.
// Usage: node scripts/mismatches.js
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data: rows, error } = await supabase
  .from("beers")
  .select("beer_number, participant, wa_message_id, member, push_name")
  .order("beer_number", { ascending: true });
if (error) { console.error(error.message); process.exit(1); }

const norm = (s) => (s || "").trim().toLowerCase();

// Trust live (message-id) rows as the source of truth for a name's real LID.
const nameToLid = {};
for (const b of rows) {
  if (!b.wa_message_id || !b.participant) continue;
  for (const n of [b.push_name, b.member]) { const k = norm(n); if (k) nameToLid[k] = b.participant; }
}

// 1) Mis-keys: row's name points to a different LID than it's keyed to (the Georg case).
const miskeys = rows.filter((b) => {
  if (!b.participant) return false;
  const lid = nameToLid[norm(b.member)] ?? nameToLid[norm(b.push_name)];
  return lid && lid !== b.participant.trim(); // trim: pure-whitespace diffs are reported under "dirty"
});

// 2) One participant, several distinct names (shared device / merged identities).
const namesByPart = {};
for (const b of rows) if (b.participant) (namesByPart[b.participant] ||= new Set()).add((b.member || "?").trim());
const multiName = Object.entries(namesByPart).filter(([, s]) => s.size > 1);

// 3) One name, several distinct participants (split identity / name collision).
const partsByName = {};
for (const b of rows) {
  const k = norm(b.member); if (!b.participant || !k) continue;
  (partsByName[k] ||= { display: (b.member || "").trim(), parts: new Set() }).parts.add(b.participant);
}
const multiLid = Object.values(partsByName).filter((e) => e.parts.size > 1);

// 4) Dirty participant values (stray whitespace etc. — the #5 newline case).
const dirty = rows.filter((b) => b.participant && b.participant !== b.participant.trim());

const h = (t) => console.log(`\n=== ${t} ===`);

h(`Mis-keys: name resolves to a different LID (${miskeys.length})`);
if (!miskeys.length) console.log("(none)");
for (const b of miskeys) {
  const lid = nameToLid[norm(b.member)] ?? nameToLid[norm(b.push_name)];
  console.log(`  #${b.beer_number}  ${b.member}: ${b.participant} -> expected ${lid}`);
}

h(`One participant, multiple names (${multiName.length})`);
if (!multiName.length) console.log("(none)");
for (const [p, s] of multiName) console.log(`  ${p}: [${[...s].join(" | ")}]`);

h(`One name, multiple participants (${multiLid.length})`);
if (!multiLid.length) console.log("(none)");
for (const e of multiLid) console.log(`  ${e.display}: [${[...e.parts].join(" | ")}]`);

h(`Dirty participant values (${dirty.length})`);
if (!dirty.length) console.log("(none)");
for (const b of dirty) console.log(`  #${b.beer_number}  ${b.member}: ${JSON.stringify(b.participant)}`);
