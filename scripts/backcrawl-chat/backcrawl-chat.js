// WhatsApp history crawler. Connects via a second linked device and pages backward
// through group history, then acts on what it finds based on flags.
//
// Usage: node scripts/backcrawl-chat/backcrawl-chat.js [flags]
//
// Flags:
//   --fill-gaps              Insert missing beers into the DB
//   --fill-push-names        Update push_name in the members table from crawled messages
//   --fix-attribution        Correct wrong sender attributions on existing beers
//   --dry-run                Show what would change, write nothing (auto-saves JSON to output/)
//   --lookback=N             Days of history to crawl (default: 5)
//   --apply-from=<file>      Apply a previously saved dry-run JSON (no WhatsApp connection needed)
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, proto, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { parseBeer, maskPhone } from "../../src/parser.js";
import { insertBeers, correctBeerMember } from "../../src/store.js";
import { acquireSessionLock } from "../../src/session-lock.js";
import { createClient } from "@supabase/supabase-js";

const GROUP_JID = process.env.GROUP_JID;
if (!GROUP_JID) { console.error("GROUP_JID not set"); process.exit(1); }

const FILL_GAPS       = process.argv.includes("--fill-gaps");
const FILL_NAMES      = process.argv.includes("--fill-push-names");
const FIX_ATTRIBUTION = process.argv.includes("--fix-attribution");
const DRY_RUN         = process.argv.includes("--dry-run");
const lookbackArg     = process.argv.find(a => a.startsWith("--lookback="));
const LOOKBACK_DAYS   = lookbackArg ? parseInt(lookbackArg.split("=")[1], 10) : 5;
const applyArg        = process.argv.find(a => a.startsWith("--apply-from="));
const APPLY_FILE      = applyArg ? applyArg.split("=")[1] : null;

if (!FILL_GAPS && !FILL_NAMES && !FIX_ATTRIBUTION) {
  console.error("No action flag set. Use --fill-gaps, --fill-push-names, or --fix-attribution (combine freely). Add --dry-run to preview.");
  process.exit(1);
}

console.log(`Actions: ${[FILL_GAPS && "fill-gaps", FILL_NAMES && "fill-push-names", FIX_ATTRIBUTION && "fix-attribution"].filter(Boolean).join(", ")}${DRY_RUN ? " (dry-run)" : ""}${APPLY_FILE ? ` (apply-from: ${APPLY_FILE})` : ""} | lookback: ${LOOKBACK_DAYS}d`);

const OUTPUT_DIR = new URL("output/", import.meta.url).pathname;
mkdirSync(OUTPUT_DIR, { recursive: true });
const runTs = new Date().toISOString().slice(0, 16).replace(/:/g, "-"); // e.g. 2026-07-17T10-32
const DRY_RUN_FILE = `${OUTPUT_DIR}dry-run-${runTs}.json`;

const MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null);
const logger = pino({ level: "warn" });

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

let known = new Set();
let byNum = new Map();
let cutoff = 0;

if (!APPLY_FILE) {
  // Paginate existing beers
  const existing = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase.from("beers").select("beer_number, ts, participant, member, push_name").order("beer_number", { ascending: true }).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    existing.push(...page);
    if (page.length < 1000) break;
  }
  known = new Set(existing.map((r) => r.beer_number));
  byNum = new Map(existing.map((r) => [r.beer_number, r]));
  const maxTs = existing.reduce((m, r) => Math.max(m, new Date(r.ts).getTime()), 0);
  const LOOKBACK = LOOKBACK_DAYS * 24 * 60 * 60_000;
  const recentFloor = Date.now() - LOOKBACK;
  cutoff = maxTs - 5 * 60_000;
  for (let i = 1; i < existing.length; i++) {
    if (existing[i].beer_number !== existing[i - 1].beer_number + 1) {
      const lowerTs = new Date(existing[i - 1].ts).getTime();
      if (lowerTs >= recentFloor && lowerTs < cutoff) cutoff = lowerTs;
    }
  }
  cutoff -= 5 * 60_000;
  console.log(`Loaded ${known.size} beers from the database. Crawling back to ${new Date(cutoff).toLocaleString()}.`);
}

let inserted = 0, mismatches = 0, fixes = 0, nameUpdates = 0;
const crawlByNum = new Map();
const pushNamesSeen = new Map(); // participant -> pushName
let frontierBeer = Infinity;
let oldestKey = null, oldestTs = Infinity;
let sawGroupMsg = false;
let pageSignal = null;
let done = false;

function saveCrawlState(file) {
  const payload = {
    crawledAt: new Date().toISOString(),
    known: [...known],
    byNumRows: [...byNum.entries()],
    crawlByNum: [...crawlByNum.entries()].map(([beerNumber, list]) => ({
      beerNumber,
      submissions: list.map(e => ({ ...e, ts: e.ts instanceof Date ? e.ts.toISOString() : e.ts })),
    })),
    pushNamesSeen: [...pushNamesSeen.entries()].map(([participant, pushName]) => ({ participant, pushName })),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`[save] ${file} (${payload.crawlByNum.length} beers, ${payload.pushNamesSeen.length} push names)`);
}

function loadCrawlState(file) {
  const payload = JSON.parse(readFileSync(file, "utf8"));
  console.log(`[apply-from] loaded ${file} (crawled ${payload.crawledAt})`);
  for (const n of payload.known) known.add(n);
  for (const [n, row] of payload.byNumRows) byNum.set(n, row);
  for (const { beerNumber, submissions } of payload.crawlByNum)
    crawlByNum.set(beerNumber, submissions.map(e => ({ ...e, ts: new Date(e.ts) })));
  for (const { participant, pushName } of payload.pushNamesSeen)
    pushNamesSeen.set(participant, pushName);
}

function ingest(msg) {
  if (msg.key?.remoteJid !== GROUP_JID) return;
  sawGroupMsg = true;
  const msgTs = Number(msg.messageTimestamp) * 1000;
  if (msgTs < oldestTs) { oldestTs = msgTs; oldestKey = msg.key; }

  const participant = num(msg.key.participant);
  if (participant && msg.pushName) pushNamesSeen.set(participant, msg.pushName);

  const proto_msg = msg.message?.protocolMessage;
  const text = mediaCaption(proto_msg?.type === MESSAGE_EDIT ? proto_msg.editedMessage : msg.message);
  if (text === null) return;
  const beerNum = parseBeer(text);
  if (beerNum === null) return;
  if (beerNum < frontierBeer) frontierBeer = beerNum;

  const list = crawlByNum.get(beerNum) ?? [];
  list.push({ ts: new Date(msgTs), participant, pushName: msg.pushName ?? null, member: msg.pushName || participant || "unknown", wa_message_id: msg.key.id, raw_caption: text });
  crawlByNum.set(beerNum, list);
}

async function reconcile() {
  if (FILL_NAMES) {
    for (const [participant, pushName] of pushNamesSeen) {
      console.log(`[push-name] ${participant} → ${pushName}${DRY_RUN ? " (dry-run)" : ""}`);
      if (!DRY_RUN) {
        await supabase.from("members").update({ push_name: pushName }).eq("participant", participant);
        nameUpdates++;
      }
    }
  }

  for (const beerNum of [...crawlByNum.keys()].sort((a, b) => a - b)) {
    const list = crawlByNum.get(beerNum).sort((a, b) => a.ts - b.ts);
    const first = list[0];
    const senders = new Set(list.filter((e) => e.participant).map((e) => e.participant));
    if (senders.size > 1) console.log(`[dup] #${beerNum} posted by ${senders.size} people — keeping earliest ${first.member} (${maskPhone(first.participant)})`);

    if (!known.has(beerNum)) {
      if (!FILL_GAPS) continue;
      console.log(`[gap] #${beerNum} by ${first.member} @ ${first.ts.toLocaleString()}${DRY_RUN ? " (dry-run)" : ""}`);
      if (!DRY_RUN) {
        try {
          const n = await insertBeers([{ beer_number: beerNum, member: first.member, push_name: first.pushName, participant: first.participant, ts: first.ts, raw_caption: first.raw_caption, source: "sync", wa_message_id: first.wa_message_id }]);
          if (n) inserted++;
        } catch (e) { console.error(`[gap] failed #${beerNum}:`, e.message); }
      }
      continue;
    }

    if (!FIX_ATTRIBUTION) continue;
    const db = byNum.get(beerNum);
    const senderWrong = first.participant && db.participant !== first.participant;
    const pushMissing = first.pushName && !db.push_name;
    if (!senderWrong && !pushMissing) continue;
    const what = senderWrong ? `${db.member} (${maskPhone(db.participant)}) → ${first.member} (${maskPhone(first.participant)})` : `fill push_name → ${first.pushName}`;
    console.log(`[fix] #${beerNum} ${what}${DRY_RUN ? " (dry-run)" : ""}`);
    mismatches++;
    if (!DRY_RUN) { await correctBeerMember(beerNum, { participant: first.participant ?? db.participant, pushName: first.pushName, member: first.member }); fixes++; }
  }
}

function ingestBatch(messages) {
  for (const msg of messages) ingest(msg);
  if (pageSignal) { const r = pageSignal; pageSignal = null; r(); }
}

async function finish(reason) {
  if (done) return;
  done = true;
  console.log(`\n${reason} Reconciling ${crawlByNum.size} collected beers…`);
  await reconcile();
  const gapCount = [...crawlByNum.keys()].filter(n => !known.has(n)).length;
  if (FILL_GAPS)       console.log(`Gaps: ${DRY_RUN ? "would insert" : "inserted"} ${DRY_RUN ? gapCount : inserted} beers.`);
  if (FILL_NAMES)      console.log(`Push names: ${DRY_RUN ? "would update" : "updated"} ${DRY_RUN ? pushNamesSeen.size : nameUpdates}.`);
  if (FIX_ATTRIBUTION) console.log(`Attribution: ${mismatches} mismatch${mismatches === 1 ? "" : "es"}${!DRY_RUN ? `, fixed ${fixes}` : " (dry-run, nothing written)"}.`);
  if (!sawGroupMsg && !APPLY_FILE) {
    console.log("WhatsApp delivered no messages for this group — can't seed the crawl.");
    console.log("Fallback: export the chat and run `npm run backfill`.");
  }
  if (DRY_RUN) saveCrawlState(DRY_RUN_FILE);
  process.exit(0);
}

if (APPLY_FILE) {
  loadCrawlState(APPLY_FILE);
  await finish("Loaded from file.");
} else {
  const SYNC_AUTH_DIR = ".baileys_auth.sync";
  const SYNC_LOCK = ".baileys_auth.sync.lock";
  const PAGE_SIZE = 50;
  const MAX_PAGES = 500; // ponytail: backstop only; cutoff + end-of-history are the real stops
  const RUN_TIMEOUT_MS = 10 * 60_000;

  acquireSessionLock(SYNC_LOCK);
  const { state, saveCreds } = await useMultiFileAuthState(SYNC_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  let sock;
  let pagingStarted = false;

  async function pageBack() {
    for (let waited = 0; !oldestKey && waited < 60_000; waited += 2_000) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
    let stalls = 0;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      if (!oldestKey || oldestTs < cutoff) return finish(oldestTs < cutoff ? "Reached cutoff." : "No anchor.");
      const anchorKey = oldestKey, anchorTs = oldestTs;
      const sid = await sock.fetchMessageHistory(PAGE_SIZE, anchorKey, anchorTs).catch((e) => { console.error("fetchMessageHistory failed:", e.message); return null; });
      if (!sid) return finish("Fetch error.");

      await new Promise((resolve) => {
        pageSignal = resolve;
        setTimeout(() => { if (pageSignal === resolve) { pageSignal = null; resolve(); } }, 15_000);
      });

      if (oldestKey === anchorKey && oldestTs === anchorTs) {
        if (++stalls <= 5 && oldestTs > cutoff) {
          console.log(`[sync] no older messages yet — waiting… (at ${frontierBeer === Infinity ? "?" : "#" + frontierBeer})`);
          await new Promise((r) => setTimeout(r, 5_000)); pages--; continue;
        }
        return finish("Reached end of available history.");
      }
      stalls = 0;
      console.log(`[sync] page ${pages + 1}/${MAX_PAGES}: back to beer ${frontierBeer === Infinity ? "?" : "#" + frontierBeer} (${new Date(oldestTs).toLocaleString()})`);
    }
    finish("Hit page cap.");
  }

  function connect() {
    sock = makeWASocket({ version, auth: state, logger, syncFullHistory: true, getMessage: async () => undefined });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messaging-history.set", ({ messages }) => ingestBatch(messages));
    sock.ev.on("messages.upsert", ({ messages }) => ingestBatch(messages));
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

  setTimeout(() => finish("Global timeout."), RUN_TIMEOUT_MS);
  connect();
}
