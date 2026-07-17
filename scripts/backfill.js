// One-time historical backfill: parse a WhatsApp export into Supabase.
// Usage: node scripts/backfill.js [--dry-run] [path]   (default: chat_exports/_chat.txt)
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { parseExportLine, parseBeer } from "../src/parser.js";
import { createClient } from "@supabase/supabase-js";

const isPhone = (s) => !/[a-zA-Z~]/.test(s) && s.replace(/\D/g, '').length >= 8;
const normalizePhone = (s) => s.replace(/\D/g, '');
import { insertBeers } from "../src/store.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find(a => !a.startsWith("--")) || "chat_exports/_chat.txt";
const lines = readFileSync(file, "utf8").split(/\r?\n/);

const entries = [];
let skipped = 0;
for (const line of lines) {
  const row = parseExportLine(line);
  if (!row) continue; // system notice / continuation line
  const beer_number = parseBeer(row.body);
  if (beer_number === null) {
    if (row.body.trim()) skipped++;
    continue;
  }
  const participant = isPhone(row.member) ? normalizePhone(row.member) : null;
  entries.push({ beer_number, member: row.member, participant, ts: row.ts, raw_caption: row.body, source: "export" });
}

console.log(`parsed ${entries.length} beers, ${skipped} non-beer messages skipped`);

if (dryRun) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

  // Load all existing beers
  const existing = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase.from("beers").select("beer_number, member, ts").range(from, from + 999);
    if (error) throw error;
    existing.push(...page);
    if (page.length < 1000) break;
  }

  // Build push_name -> participant map from members table (case-insensitive, unambiguous only)
  const { data: members, error: mErr } = await supabase.from("members").select("participant, push_name, phone");
  if (mErr) throw mErr;
  const nameToMember = {};
  for (const m of members) {
    if (!m.push_name || !m.participant) continue;
    const key = m.push_name.toLowerCase();
    nameToMember[key] = nameToMember[key] === undefined ? { participant: m.participant, push_name: m.push_name } : null; // null = ambiguous
  }

  const dbMap = new Map(existing.map(r => [r.beer_number, r]));
  const clashes = [], fresh = [], unresolved = [];
  for (const e of entries) {
    const db = dbMap.get(e.beer_number);
    if (db) {
      const sameName = db.member?.toLowerCase() === e.member?.toLowerCase();
      const sameDate = String(db.ts).slice(0, 10) === e.ts.toISOString().slice(0, 10);
      if (!sameName || !sameDate) clashes.push({ beer_number: e.beer_number, export: { member: e.member, ts: e.ts }, db: { member: db.member, ts: db.ts } });
      continue;
    }
    // New beer — resolve participant
    const resolved = nameToMember[e.member.toLowerCase()];
    const participant = e.participant ?? resolved?.participant;
    if (!participant) { unresolved.push(e); continue; }
    fresh.push({ ...e, participant, push_name: resolved?.push_name ?? e.member });
  }

  // Deduplicate fresh by beer_number keeping earliest ts
  const freshMap = new Map();
  for (const e of fresh) {
    const ex = freshMap.get(e.beer_number);
    if (!ex || e.ts < ex.ts) freshMap.set(e.beer_number, e);
  }
  const freshUniq = [...freshMap.values()].sort((a, b) => a.beer_number - b.beer_number);
  const unresolvedNums = new Set(unresolved.map(e => e.beer_number));

  const lines = [];
  const p = (...s) => lines.push(...s);

  p(`# Backfill Dry Run — ${new Date().toISOString().slice(0, 10)}`, ``);
  p(`## Summary`, ``);
  p(`| | Count |`, `|---|---|`);
  p(`| Would insert (participant resolved) | ${freshUniq.length} |`);
  p(`| Cannot insert (ambiguous or unknown member) | ${unresolvedNums.size} |`);
  p(`| Clashes (different member or date, skipped) | ${clashes.length} |`);
  p(``);

  p(`## Would Insert`, ``);
  p(`| beer_number | date | export name | push_name | participant |`, `|---|---|---|---|---|`);
  for (const e of freshUniq) {
    p(`| #${e.beer_number} | ${e.ts.toISOString().slice(0,10)} | ${e.member} | ${e.push_name} | ${e.participant} |`);
  }
  p(``);

  if (unresolvedNums.size) {
    p(`## Unresolved (not safe to insert)`, ``);
    p(`| beer_number | date | push_name | reason |`, `|---|---|---|---|`);
    const seen = new Set();
    for (const e of unresolved) {
      if (seen.has(e.beer_number)) continue;
      seen.add(e.beer_number);
      p(`| #${e.beer_number} | ${e.ts.toISOString().slice(0,10)} | ${e.member} | no unique match |`);
    }
    p(``);
  }

  if (clashes.length) {
    p(`## Clashes (export vs DB)`, ``);
    p(`| beer_number | date | export member | db member |`, `|---|---|---|---|`);
    for (const c of clashes) {
      p(`| #${c.beer_number} | ${c.export.ts.toISOString().slice(0,10)} | ${c.export.member} | ${c.db.member} |`);
    }
  }

  writeFileSync("scripts/dry-run-output.md", lines.join("\n") + "\n");
  console.log("dry-run written to scripts/dry-run-output.md");
  process.exit(0);
}

const inserted = await insertBeers(entries);
console.log(`inserted ${inserted} new rows (${entries.length - inserted} already present)`);
