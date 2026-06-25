// Shared, source-agnostic parsing for beer messages.
// Both the live Baileys path and the export backfill call parseBeer() so there's
// one definition of "what counts as a valid beer".

// Invisible marks WhatsApp sprinkles in: LTR/RTL marks, BOM, bidi embeddings/isolates.
const INVISIBLE = /[‎‏﻿‪-‮⁦-⁩]/g;
const ATTACHMENT = /<attached:[^>]*>/gi;
// WhatsApp media placeholders: "image/video/audio/GIF/sticker/document/Contact card omitted".
// Match one or two leading letter-words + "omitted" so we strip the placeholder but never
// the numeric caption (e.g. "67 video omitted" -> "67"). Digits can't precede "omitted" here.
const NOISE = /\b[A-Za-z]+(?: [A-Za-z]+)? omitted|<This message was edited>|This message was deleted/gi;

// Strip invisible Unicode and attachment/edit markers, then trim.
export function cleanText(text) {
  return (text ?? "")
    .replace(INVISIBLE, "")
    .replace(ATTACHMENT, "")
    .replace(NOISE, "")
    .trim();
}

// Mask the middle digits of a phone-number-like string. Display names (contain letters) pass through.
export function maskPhone(s) {
  if (!s || /[a-zA-Z~]/.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8) return s;
  return (s.startsWith('+') ? '+' : '') + digits.slice(0, 4) + 'x'.repeat(digits.length - 8) + digits.slice(-4);
}

// A valid beer is a message whose cleaned text is *purely* a number.
// Returns the integer, or null (caller logs nulls to the skipped log — fail loud).
export function parseBeer(text) {
  const c = cleanText(text);
  return /^\d+$/.test(c) ? parseInt(c, 10) : null;
}

// Parse one WhatsApp export line: "[dd/mm/yyyy, h:mm:ss AM] Sender: body".
// Returns { ts: Date, member, body } or null for lines that don't match
// (system notices, multi-line continuations).
// Handles both iOS 12-hour ("4:19:50 PM") and 24-hour ("16:19:50") export formats.
const LINE = /^[‎‏]?\[(\d{2})\/(\d{2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP])M)?\] ([^:]+?): (.*)$/;

export function parseExportLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, dd, mm, yyyy, h, min, s, ap, member, body] = m;
  let hour = parseInt(h, 10);
  if (ap) { hour = hour % 12; if (ap === "P") hour += 12; } // 12-hour -> 24-hour
  // ponytail: export carries no timezone, so this is the exporter's local time. Good enough.
  const ts = new Date(+yyyy, +mm - 1, +dd, hour, +min, +s);
  return { ts, member: member.replace(INVISIBLE, "").trim(), body };
}

// Self-check: `node src/parser.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert")).default;
  assert.equal(parseBeer("6"), 6);
  assert.equal(parseBeer("6 ‎<attached: 00003005-PHOTO.jpg>"), 6); // number + photo
  assert.equal(parseBeer("1000000"), 1000000);
  assert.equal(parseBeer("Nr? ‎<attached: x.jpg>"), null); // chatter + photo
  assert.equal(parseBeer("Mit 28 members brauchen wir 100jahre"), null); // sentence with digits
  assert.equal(parseBeer("‎<attached: x.jpg>"), null); // photo only
  assert.equal(parseBeer(""), null);
  assert.equal(parseBeer("67 ‎video omitted"), 67); // numbered video
  assert.equal(parseBeer("43 GIF omitted"), 43); // numbered GIF
  assert.equal(parseBeer("‎video omitted"), null); // media only, no number

  const row = parseExportLine("‎[20/06/2026, 4:19:50 PM] stein: 6 ‎<attached: x.jpg>");
  assert.equal(row.member, "stein");
  assert.equal(parseBeer(row.body), 6);
  assert.equal(row.ts.getFullYear(), 2026);
  assert.equal(row.ts.getMonth(), 5); // June (0-indexed)
  assert.equal(row.ts.getHours(), 16); // 4 PM

  assert.equal(parseExportLine("[20/06/2026, 12:39:52 PM] One Million Beers: created group").member, "One Million Beers");
  assert.equal(parseExportLine("just a continuation line"), null);

  // 24-hour format (Android / non-US locale export)
  const h24 = parseExportLine("[20/06/2026, 17:42:14] Toto: 17 ‎image omitted");
  assert.equal(h24.ts.getHours(), 17);
  assert.equal(parseBeer(h24.body), 17); // "image omitted" stripped

  console.log("parser self-check passed");
}
