// Backfill beers the bot missed by paging WhatsApp history on demand.
// Crawls backward from the newest message the server delivers down to the last known
// beer's timestamp, inserting anything missing. Idempotent — safe to run repeatedly.
// Uses the existing .baileys_auth/ session (stop the bot first — two sockets conflict).
// Usage: node scripts/sync-gaps.js
import "dotenv/config";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, proto, DisconnectReason } from "@whiskeysockets/baileys";
import pino from "pino";
import { parseBeer } from "../src/parser.js";
import { insertBeers } from "../src/store.js";
import { acquireSessionLock } from "../src/session-lock.js";
import { createClient } from "@supabase/supabase-js";

const GROUP_JID = process.env.GROUP_JID;
if (!GROUP_JID) { console.error("GROUP_JID not set"); process.exit(1); }

const MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null);
const logger = pino({ level: "warn" });

function messageText(message) {
  const m =
    message?.ephemeralMessage?.message ??
    message?.viewOnceMessage?.message ??
    message?.viewOnceMessageV2?.message ??
    message?.documentWithCaptionMessage?.message ??
    message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    ""
  );
}

// fetchMessageHistory only pages backward, so we seed from the newest delivered message
// and crawl back to `cutoff`. Cutoff reaches the oldest gap within LOOKBACK days so recent
// interior holes get filled — bounded so we don't chase months-old human-skips forever.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

// Paginate: a single select caps at 1000 rows.
const existing = [];
for (let from = 0; ; from += 1000) {
  const { data: page, error } = await supabase.from("beers").select("beer_number, ts").order("beer_number", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  existing.push(...page);
  if (page.length < 1000) break;
}
const known = new Set(existing.map((r) => r.beer_number));
const maxTs = existing.reduce((m, r) => Math.max(m, new Date(r.ts).getTime()), 0);

const LOOKBACK = 5 * 24 * 60 * 60_000; // only chase gaps from the last 5 days
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
let oldestKey = null, oldestTs = Infinity;
let newestTs = 0;
let sawGroupMsg = false;
let pageSignal = null; // resolves the in-flight page wait when a batch arrives
let done = false;

async function ingest(msg) {
  if (msg.key?.remoteJid !== GROUP_JID) return;
  sawGroupMsg = true;
  const msgTs = Number(msg.messageTimestamp) * 1000;
  if (msgTs < oldestTs) { oldestTs = msgTs; oldestKey = msg.key; }
  if (msgTs > newestTs) { newestTs = msgTs; }

  const ts = new Date(msgTs);
  const member = msg.pushName || num(msg.key.participant) || "unknown";
  const participant = num(msg.key.participant);
  const wa_message_id = msg.key.id;

  // Edits carry the new content in a protocol message; re-parse it.
  const proto_msg = msg.message?.protocolMessage;
  const text = proto_msg?.type === MESSAGE_EDIT ? messageText(proto_msg.editedMessage) : messageText(msg.message);
  const beerNum = parseBeer(text);
  if (beerNum === null || known.has(beerNum)) return;

  try {
    await insertBeers([{ beer_number: beerNum, member, push_name: msg.pushName ?? null, participant, ts, raw_caption: text, source: "sync", wa_message_id }]);
    known.add(beerNum);
    inserted++;
    console.log(`[sync] inserted #${beerNum} by ${member} @ ${ts.toLocaleTimeString()}`);
  } catch (e) { console.error(`[sync] failed #${beerNum}:`, e.message); }
}

async function ingestBatch(messages) {
  for (const msg of messages) await ingest(msg);
  if (pageSignal) { const r = pageSignal; pageSignal = null; r(); }
}

acquireSessionLock(); // exit if the bot (or another sync) holds the WhatsApp session
const { state, saveCreds } = await useMultiFileAuthState(".baileys_auth");
const { version } = await fetchLatestBaileysVersion();

let sock;          // reassigned on each (re)connect; pageBack reads the latest
let pagingStarted = false;

function connect() {
  sock = makeWASocket({ version, auth: state, logger, syncFullHistory: false, getMessage: async () => undefined });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messaging-history.set", ({ messages }) => ingestBatch(messages));
  sock.ev.on("messages.upsert", ({ messages }) => ingestBatch(messages)); // offline-queued / live
  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      if (pagingStarted) return;
      pagingStarted = true;
      console.log("Connected. Waiting 8s for the initial history chunk, then paging back…");
      setTimeout(pageBack, 8_000);
    }
    if (connection === "close" && !done) {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { console.error("logged out — delete .baileys_auth and re-link"); process.exit(1); }
      console.log(`connection closed (code ${code}), reconnecting…`);
      connect();
    }
  });
}

function finish(reason) {
  if (done) return;
  done = true;
  console.log(`\n${reason} Inserted ${inserted}. Covered down to ${oldestTs === Infinity ? "nothing" : new Date(oldestTs).toLocaleString()}.`);
  if (!sawGroupMsg) {
    console.log("WhatsApp delivered no messages for this group — can't seed the crawl.");
    console.log("Fallback: export the chat (Settings → Export Chat, without media) into chat_exports/ and run `npm run backfill`.");
  }
  process.exit(0);
}

async function pageBack() {
  for (let pages = 0; pages < 30; pages++) {
    if (!oldestKey || oldestTs < cutoff) return finish(oldestTs < cutoff ? "Reached cutoff." : "No anchor.");
    const anchorKey = oldestKey, anchorTs = oldestTs;
    const sid = await sock.fetchMessageHistory(50, anchorKey, anchorTs).catch((e) => { console.error("fetchMessageHistory failed:", e.message); return null; });
    if (!sid) return finish("Fetch error.");

    // Wait for the response batch (handler resolves pageSignal), or time out.
    await new Promise((resolve) => {
      pageSignal = resolve;
      setTimeout(() => { if (pageSignal === resolve) { pageSignal = null; resolve(); } }, 15_000);
    });

    if (oldestKey === anchorKey && oldestTs === anchorTs) return finish("Reached end of available history.");
  }
  finish("Hit page cap.");
}

// Global safety net so the script can never hang forever (the old bug).
setTimeout(() => finish("Global timeout."), 180_000);

connect();
