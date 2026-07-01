// Backfill beers the bot missed by paging WhatsApp history on demand.
// Crawls backward from the newest message the server delivers down to the last known
// beer's timestamp, inserting anything missing. Idempotent — safe to run repeatedly.
// Runs on its OWN linked device (.baileys_auth.sync), so it can run in parallel with
// the live bot. First run prints a QR — scan it in WhatsApp → Linked Devices once.
// A beer counts only as a NUMBER captioned on a photo/video — plain-text numbers (replies,
// typos, chatter) are ignored. Collects every such message first, then per number keeps the
// EARLIEST poster as ground truth: inserts missing beers, and (with --fix) corrects a wrong
// recorded sender / fills a missing push_name. Same history window as inserts.
// Usage: node scripts/sync-gaps.js [--fix]
import "dotenv/config";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, proto, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { parseBeer, maskPhone } from "../src/parser.js";
import { insertBeers, correctBeerMember } from "../src/store.js";
import { acquireSessionLock } from "../src/session-lock.js";
import { createClient } from "@supabase/supabase-js";

const GROUP_JID = process.env.GROUP_JID;
if (!GROUP_JID) { console.error("GROUP_JID not set"); process.exit(1); }
const FIX = process.argv.includes("--fix"); // also overwrite wrong senders, not just insert missing

const MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null);
const logger = pino({ level: "warn" });

// A beer must be a NUMBER captioned on a photo/video. Returns the caption for image/video
// messages (unwrapping ephemeral / view-once / doc-with-caption), or null for anything else —
// so plain-text numbers (replies, typos, chatter) are never counted as beers.
function mediaCaption(message) {
  const m =
    message?.ephemeralMessage?.message ??
    message?.viewOnceMessage?.message ??
    message?.viewOnceMessageV2?.message ??
    message?.documentWithCaptionMessage?.message ??
    message;
  const media = m?.imageMessage ?? m?.videoMessage;
  return media ? (media.caption ?? "") : null;
}

// fetchMessageHistory only pages backward, so we seed from the newest delivered message
// and crawl back to `cutoff`. Cutoff reaches the oldest gap within LOOKBACK days so recent
// interior holes get filled — bounded so we don't chase months-old human-skips forever.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

// Paginate: a single select caps at 1000 rows.
const existing = [];
for (let from = 0; ; from += 1000) {
  const { data: page, error } = await supabase.from("beers").select("beer_number, ts, participant, member, push_name").order("beer_number", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  existing.push(...page);
  if (page.length < 1000) break;
}
const known = new Set(existing.map((r) => r.beer_number));
const byNum = new Map(existing.map((r) => [r.beer_number, r])); // for sender reconciliation
const maxTs = existing.reduce((m, r) => Math.max(m, new Date(r.ts).getTime()), 0);

// Historical messages from fetchMessageHistory carry NO pushName, so resolve display names
// from what we already know — existing beers, the members roster, and contacts/live messages
// seen during the crawl — keyed by participant (the stable LID/phone). First real name wins.
const nameByPart = new Map();
const looksLikePhone = (s) => !s || /^[+\d x]+$/.test(s); // masked/raw phone → not a real name
function learnName(participant, name) {
  if (participant && name && !looksLikePhone(name) && !nameByPart.has(participant)) nameByPart.set(participant, name.trim());
}
function learnContacts(contacts) {
  for (const c of contacts ?? []) learnName(num(c.id), c.name || c.notify || c.verifiedName);
}
for (const r of existing) { learnName(r.participant, r.push_name); learnName(r.participant, r.member); }
const { data: members } = await supabase.from("members").select("participant, member, push_name");
for (const m of members ?? []) { learnName(m.participant, m.push_name); learnName(m.participant, m.member); }

const LOOKBACK = 5 * 24 * 60 * 60_000; // only chase gaps from the last 5 days
const SYNC_AUTH_DIR = ".baileys_auth.sync";   // own linked device → runs alongside the bot
const SYNC_LOCK = ".baileys_auth.sync.lock";  // locks only against another sync run, not the bot
const PAGE_SIZE = 50;                          // WhatsApp caps fetchMessageHistory ~50
const MAX_PAGES = 500;                         // ponytail: backstop only (~25k msgs/run); cutoff + end-of-history are the real stops, export+backfill handles gaps older than LOOKBACK
const RUN_TIMEOUT_MS = 10 * 60_000;            // 10 min hard backstop
const recentFloor = Date.now() - LOOKBACK;
let cutoff = maxTs - 5 * 60_000; // default: just the live tip
for (let i = 1; i < existing.length; i++) {
  if (existing[i].beer_number !== existing[i - 1].beer_number + 1) {
    const lowerTs = new Date(existing[i - 1].ts).getTime();
    if (lowerTs >= recentFloor && lowerTs < cutoff) cutoff = lowerTs; // reach back to the oldest recent gap
  }
}
cutoff -= 5 * 60_000;
console.log(`Loaded ${known.size} beers. Crawling back to ${new Date(cutoff).toLocaleString()} (last beer − 5 min).`);

let inserted = 0;
let mismatches = 0, fixes = 0;
const crawlByNum = new Map(); // beer_number -> [{ ts, participant, pushName, member, wa_message_id, raw_caption }] — reconciled after the crawl
let frontierBeer = Infinity; // lowest beer number scanned so far (crawl goes backward → numbers decrease)
let oldestKey = null, oldestTs = Infinity;
let newestTs = 0;
let sawGroupMsg = false;
let pageSignal = null; // resolves the in-flight page wait when a batch arrives
let done = false;

// Collect only — the crawl sees the same number from newest to oldest and can see duplicate
// posters; we decide the authoritative (earliest) sender once, in reconcile(), after the crawl.
function ingest(msg) {
  if (msg.key?.remoteJid !== GROUP_JID) return;
  sawGroupMsg = true;
  const msgTs = Number(msg.messageTimestamp) * 1000;
  if (msgTs < oldestTs) { oldestTs = msgTs; oldestKey = msg.key; }
  if (msgTs > newestTs) { newestTs = msgTs; }

  // Edits carry the new content in a protocol message; re-parse it.
  const proto_msg = msg.message?.protocolMessage;
  const text = mediaCaption(proto_msg?.type === MESSAGE_EDIT ? proto_msg.editedMessage : msg.message);
  if (text === null) return;           // not a photo/video → not a beer
  const beerNum = parseBeer(text);
  if (beerNum === null) return;
  if (beerNum < frontierBeer) frontierBeer = beerNum;

  const participant = num(msg.key.participant);
  if (msg.pushName) learnName(participant, msg.pushName); // live/tip messages do carry it
  const list = crawlByNum.get(beerNum) ?? [];
  list.push({ ts: new Date(msgTs), participant, pushName: msg.pushName ?? null, member: msg.pushName || participant || "unknown", wa_message_id: msg.key.id, raw_caption: text });
  crawlByNum.set(beerNum, list);
}

// After the crawl: per number, the EARLIEST poster is ground truth. Insert missing beers;
// with --fix, correct a wrong recorded sender and fill a missing push_name.
async function reconcile() {
  for (const beerNum of [...crawlByNum.keys()].sort((a, b) => a - b)) {
    const list = crawlByNum.get(beerNum).sort((a, b) => a.ts - b.ts);
    const first = list[0]; // earliest media submission wins over later duplicates
    // History has no pushName → fall back to the resolved name for this participant.
    const name = first.pushName || nameByPart.get(first.participant) || null;
    const member = name || first.participant || "unknown";
    const senders = new Set(list.filter((e) => e.participant).map((e) => e.participant));
    if (senders.size > 1) console.log(`[dup] #${beerNum} posted by ${senders.size} people — keeping earliest ${member}(${maskPhone(first.participant)})`);

    if (!known.has(beerNum)) {
      try {
        const n = await insertBeers([{ beer_number: beerNum, member, push_name: name, participant: first.participant, ts: first.ts, raw_caption: first.raw_caption, source: "sync", wa_message_id: first.wa_message_id }]);
        if (n) { inserted++; console.log(`[sync] inserted #${beerNum} by ${member} @ ${first.ts.toLocaleString()}`); }
      } catch (e) { console.error(`[sync] failed #${beerNum}:`, e.message); }
      continue;
    }

    const db = byNum.get(beerNum);
    const senderWrong = first.participant && db.participant !== first.participant;
    const pushMissing = name && !db.push_name; // store the display name we now have
    if (!senderWrong && !pushMissing) continue;
    const what = senderWrong ? `${db.member}(${maskPhone(db.participant)}) → ${member}(${maskPhone(first.participant)})` : `fill push_name → ${name}`;
    console.log(`[fix] #${beerNum} ${what}${FIX ? "" : "  (dry-run)"}`);
    mismatches++;
    if (FIX) { await correctBeerMember(beerNum, { participant: first.participant ?? db.participant, pushName: name, member }); fixes++; }
  }
}

function ingestBatch(messages) {
  for (const msg of messages) ingest(msg);
  if (pageSignal) { const r = pageSignal; pageSignal = null; r(); }
}

acquireSessionLock(SYNC_LOCK); // exit only if another sync run holds the sync session (the bot uses a different lock)
const { state, saveCreds } = await useMultiFileAuthState(SYNC_AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();

let sock;          // reassigned on each (re)connect; pageBack reads the latest
let pagingStarted = false;

function connect() {
  // syncFullHistory: this is our own fresh device — it has no local history to page through
  // until WhatsApp syncs it, so pull the full history (the bot does the same). Streams in via
  // messaging-history.set; may take a minute on the first run.
  sock = makeWASocket({ version, auth: state, logger, syncFullHistory: true, getMessage: async () => undefined });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messaging-history.set", ({ messages, contacts }) => { learnContacts(contacts); ingestBatch(messages); });
  sock.ev.on("messages.upsert", ({ messages }) => ingestBatch(messages)); // offline-queued / live
  sock.ev.on("contacts.upsert", learnContacts);
  sock.ev.on("contacts.set", ({ contacts }) => learnContacts(contacts));
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("Scan in WhatsApp → Linked Devices to link the sync device (one-time):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      if (pagingStarted) return;
      pagingStarted = true;
      console.log("Connected. Waiting 8s for the initial history chunk, then paging back…");
      setTimeout(pageBack, 8_000);
    }
    if (connection === "close" && !done) {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { console.error(`logged out — delete ${SYNC_AUTH_DIR} and re-link`); process.exit(1); }
      console.log(`connection closed (code ${code}), reconnecting…`);
      connect();
    }
  });
}

async function finish(reason) {
  if (done) return;
  done = true;
  console.log(`\n${reason} Reconciling ${crawlByNum.size} collected beers…`);
  await reconcile();
  const senders = FIX ? `Fixed ${fixes} senders.` : `${mismatches} sender mismatch${mismatches === 1 ? "" : "es"}${mismatches ? " (re-run with --fix to apply)" : ""}.`;
  console.log(`${reason} Inserted ${inserted}. ${senders} Covered down to ${oldestTs === Infinity ? "nothing" : new Date(oldestTs).toLocaleString()}${frontierBeer === Infinity ? "" : ` (beer #${frontierBeer})`}.`);
  if (!sawGroupMsg) {
    console.log("WhatsApp delivered no messages for this group — can't seed the crawl.");
    console.log("Fallback: export the chat (Settings → Export Chat, without media) into chat_exports/ and run `npm run backfill`.");
  }
  process.exit(0);
}

async function pageBack() {
  // Fresh device: full history streams in via messaging-history.set and can lag the 8s seed wait.
  // Wait up to 60s for the first group message to anchor the crawl before declaring "No anchor".
  for (let waited = 0; !oldestKey && waited < 60_000; waited += 2_000) {
    await new Promise((r) => setTimeout(r, 2_000));
  }
  let stalls = 0;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    if (!oldestKey || oldestTs < cutoff) return finish(oldestTs < cutoff ? "Reached cutoff." : "No anchor.");
    const anchorKey = oldestKey, anchorTs = oldestTs;
    const sid = await sock.fetchMessageHistory(PAGE_SIZE, anchorKey, anchorTs).catch((e) => { console.error("fetchMessageHistory failed:", e.message); return null; });
    if (!sid) return finish("Fetch error.");

    // Wait for the response batch (handler resolves pageSignal), or time out.
    await new Promise((resolve) => {
      pageSignal = resolve;
      setTimeout(() => { if (pageSignal === resolve) { pageSignal = null; resolve(); } }, 15_000);
    });

    if (oldestKey === anchorKey && oldestTs === anchorTs) {
      // No older messages came back. If we're still well above the cutoff, the phone's history
      // sync is probably just lagging — wait and retry a few times before concluding we hit the floor.
      if (++stalls <= 5 && oldestTs > cutoff) {
        console.log(`[sync] no older messages yet — waiting for history to stream in… (at ${frontierBeer === Infinity ? "?" : "#" + frontierBeer})`);
        await new Promise((r) => setTimeout(r, 5_000)); pages--; continue;
      }
      return finish("Reached end of available history.");
    }
    stalls = 0;
    console.log(`[sync] page ${pages + 1}/${MAX_PAGES}: back to beer ${frontierBeer === Infinity ? "?" : "#" + frontierBeer} (${new Date(oldestTs).toLocaleString()})`);
  }
  finish("Hit page cap.");
}

// Global safety net so the script can never hang forever (the old bug).
setTimeout(() => finish("Global timeout."), RUN_TIMEOUT_MS);

connect();
