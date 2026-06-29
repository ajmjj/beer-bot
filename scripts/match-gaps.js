// Reconcile bot-missed beers (number gaps) against a WhatsApp chat export.
// For each missing beer number, find it in the export, identify the sender, and
// map that sender to a participant so the beer can be re-inserted with the right
// attribution. A WhatsApp export only carries a display name or a phone number —
// never the LID — so phone senders resolve to one participant (unambiguous) while
// a name shared by several participants is flagged AMBIGUOUS for manual choice.
//
// Read-only by default (writes gap-matches.md + prints paste-ready insert lines).
// --apply inserts ONLY the unambiguous matches. --selfcheck runs the classifier
// asserts and exits (no DB needed).
//
// Usage: node scripts/match-gaps.js [export.txt] [--apply] [--selfcheck]
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseExportLine, parseBeer } from "../src/parser.js";

// ponytail: inline dup of backfill's helpers; export from parser.js if a 3rd caller appears.
const isPhone = (s) => !/[a-zA-Z~]/.test(s) && s.replace(/\D/g, "").length >= 8;
const normalizePhone = (s) => s.replace(/\D/g, "");
const norm = (s) => (s || "").trim().toLowerCase();

// Pure: map an export sender to candidate participant(s).
//   { kind: "phone"|"single", participant, name }     — one participant (unambiguous)
//   { kind: "ambiguous", candidates: [{participant,name}] } — name shared by several
//   { kind: "unknown" }                                — name we've never seen post
// partsByName: norm(name) -> Map(participant -> display name); nameByPart: participant -> name.
export function resolveSender(sender, partsByName, nameByPart) {
  if (isPhone(sender)) {
    const participant = normalizePhone(sender);
    return { kind: "phone", participant, name: nameByPart.get(participant) || sender };
  }
  const parts = partsByName.get(norm(sender));
  if (!parts || parts.size === 0) return { kind: "unknown" };
  if (parts.size === 1) {
    const [participant, name] = [...parts.entries()][0];
    return { kind: "single", participant, name };
  }
  return { kind: "ambiguous", candidates: [...parts.entries()].map(([participant, name]) => ({ participant, name })) };
}

if (process.argv.includes("--selfcheck")) {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const pbn = new Map([
    ["felix", new Map([["111", "Felix"], ["222", "Felix"]])], // same name, two people
    ["toto", new Map([["333", "Toto"]])],
  ]);
  const nbp = new Map([["333", "Toto"]]);
  assert(resolveSender("+49 1522 3093186", pbn, nbp).kind === "phone", "phone -> phone");
  assert(resolveSender("+49 1522 3093186", pbn, nbp).participant === "4915223093186", "phone normalized");
  assert(resolveSender("Toto", pbn, nbp).kind === "single", "single name");
  assert(resolveSender("Toto", pbn, nbp).participant === "333", "single participant");
  assert(resolveSender("Felix", pbn, nbp).kind === "ambiguous", "dup name -> ambiguous");
  assert(resolveSender("Felix", pbn, nbp).candidates.length === 2, "two candidates");
  assert(resolveSender("Nobody", pbn, nbp).kind === "unknown", "unknown sender");
  console.log("match-gaps self-check passed");
  process.exit(0);
}

const APPLY = process.argv.includes("--apply");
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) || "chat_exports/_chat.txt";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

// --- missing numbers (paginate: Supabase caps a select at 1000 rows) ---
const beers = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from("beers").select("beer_number, member, push_name, participant").order("beer_number", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  beers.push(...data);
  if (data.length < 1000) break;
}
if (!beers.length) { console.error("no beers in DB"); process.exit(1); }
const have = new Set(beers.map((b) => b.beer_number));
const lo = beers[0].beer_number, hi = beers[beers.length - 1].beer_number;
const missing = [];
for (let n = lo; n <= hi; n++) if (!have.has(n)) missing.push(n);

// --- name <-> participant indexes (from posting history AND the roster) ---
const { data: members, error: me } = await supabase.from("members").select("participant, member, push_name");
if (me) { console.error(me.message); process.exit(1); }
const partsByName = new Map(); // norm(name) -> Map(participant -> display name)
const nameByPart = new Map();  // participant -> display name (push_name preferred)
function index(participant, names) {
  if (!participant) return;
  const p = participant.trim();
  for (const n of names) {
    if (!n) continue;
    const k = norm(n);
    if (!partsByName.has(k)) partsByName.set(k, new Map());
    if (!partsByName.get(k).has(p)) partsByName.get(k).set(p, n.trim());
    if (!nameByPart.has(p)) nameByPart.set(p, n.trim());
  }
}
for (const b of beers) index(b.participant, [b.push_name, b.member]);
for (const m of members) index(m.participant, [m.push_name, m.member]);

// --- index the export by beer number ---
const exportByNum = new Map(); // beer_number -> [{ sender, ts, body }]
let covLo = Infinity, covHi = -Infinity;
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const row = parseExportLine(line);
  if (!row) continue;
  covLo = Math.min(covLo, row.ts.getTime());
  covHi = Math.max(covHi, row.ts.getTime());
  const num = parseBeer(row.body);
  if (num === null) continue;
  if (!exportByNum.has(num)) exportByNum.set(num, []);
  exportByNum.get(num).push({ sender: row.member, ts: row.ts, body: row.body });
}

// --- classify each missing number ---
const unambiguous = [], ambiguous = [], unknown = [], notInExport = [];
for (const num of missing) {
  const hits = exportByNum.get(num);
  if (!hits) { notInExport.push(num); continue; }
  const cand = new Map(); // participant -> name (union across all hits for this number)
  let unknownSender = null;
  for (const h of hits) {
    const r = resolveSender(h.sender, partsByName, nameByPart);
    if (r.kind === "phone" || r.kind === "single") cand.set(r.participant, r.name);
    else if (r.kind === "ambiguous") for (const c of r.candidates) cand.set(c.participant, c.name);
    else unknownSender = h.sender;
  }
  const { ts, body } = hits[0];
  if (cand.size === 1) {
    const [participant, name] = [...cand.entries()][0];
    unambiguous.push({ num, ts, body, participant, name });
  } else if (cand.size > 1) {
    ambiguous.push({ num, ts, candidates: [...cand.entries()].map(([participant, name]) => ({ participant, name })) });
  } else {
    unknown.push({ num, ts, body, sender: unknownSender });
  }
}

// --- report ---
const fmtT = (t) => new Date(t).toLocaleString();
const esc = (s) => String(s).replace(/"/g, '\\"');
const cmd = (e) => `node scripts/insert-beer.js ${e.num} "${esc(e.name)}" "${new Date(e.ts).toISOString()}" "${e.participant}"`;

const md = [
  "# Gap ↔ export reconciliation",
  "",
  `Generated ${new Date().toISOString().slice(0, 10)}. Export coverage: ${fmtT(covLo)} → ${fmtT(covHi)}.`,
  `Missing ${missing.length} — recoverable ${unambiguous.length}, ambiguous ${ambiguous.length}, unknown-sender ${unknown.length}, not in export ${notInExport.length}.`,
  "",
  "## Recoverable (unambiguous) — paste to insert",
  ...(unambiguous.length ? [] : ["", "_(none)_"]),
];
for (const e of unambiguous) md.push("", `- **#${e.num}** ${fmtT(e.ts)} — ${e.name} (${e.participant})`, "  ```", `  ${cmd(e)}`, "  ```");
md.push("", "## Ambiguous — same name, pick the participant manually", ...(ambiguous.length ? [] : ["", "_(none)_"]));
for (const e of ambiguous) {
  md.push("", `- **#${e.num}** ${fmtT(e.ts)} — candidates:`);
  for (const c of e.candidates) md.push(`  - ${c.name} (${c.participant}) → \`node scripts/insert-beer.js ${e.num} "${esc(c.name)}" "${new Date(e.ts).toISOString()}" "${c.participant}"\``);
}
md.push("", "## Unknown sender — in export but no participant on record", ...(unknown.length ? [] : ["", "_(none)_"]));
for (const e of unknown) md.push(`- **#${e.num}** ${fmtT(e.ts)} — ${e.sender} → \`node scripts/insert-beer.js ${e.num} "${esc(e.sender)}" "${new Date(e.ts).toISOString()}"\``);
md.push("", "## Not in export — likely human-skip or outside the export window", "", notInExport.length ? notInExport.join(", ") : "_(none)_", "");
writeFileSync("gap-matches.md", md.join("\n"));

console.log(`Export coverage: ${fmtT(covLo)} → ${fmtT(covHi)}`);
console.log(`Missing ${missing.length}: recoverable ${unambiguous.length}, ambiguous ${ambiguous.length}, unknown-sender ${unknown.length}, not-in-export ${notInExport.length}`);
console.log("Report → gap-matches.md");

if (APPLY) {
  const { insertBeers } = await import("../src/store.js");
  let ins = 0, dup = 0;
  for (const e of unambiguous) {
    const n = await insertBeers([{ beer_number: e.num, member: e.name, participant: e.participant, ts: new Date(e.ts), raw_caption: e.body, source: "export" }]);
    if (n) { ins++; console.log(`inserted #${e.num} (${e.name})`); } else dup++;
  }
  console.log(`\nApplied: ${ins} inserted, ${dup} already present. Left ${ambiguous.length} ambiguous + ${unknown.length} unknown-sender for manual review.`);
}
