// One-time historical backfill: parse a WhatsApp export into Supabase.
// Usage: node scripts/backfill.js [path]   (default: chat_exports/_chat.txt)
import "dotenv/config";
import { readFileSync } from "node:fs";
import { parseExportLine, parseBeer } from "../src/parser.js";

const isPhone = (s) => !/[a-zA-Z~]/.test(s) && s.replace(/\D/g, '').length >= 8;
const normalizePhone = (s) => s.replace(/\D/g, '');
import { insertBeers } from "../src/store.js";

const file = process.argv[2] || "chat_exports/_chat.txt";
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
const inserted = await insertBeers(entries);
console.log(`inserted ${inserted} new rows (${entries.length - inserted} already present)`);
