// Passive history sync: connects using an existing auth session, waits for
// WhatsApp to push all available history via messaging-history.set, then reconciles.
//
// Requires the bot to be STOPPED first — two processes on the same auth corrupt creds.
// By default uses .baileys_auth (the live bot session, which has sender keys).
//
// Usage: node scripts/history-sync/history-sync.js [flags]
//
// Flags:
//   --fill-gaps          Insert missing beers into the DB
//   --fill-push-names    Update push_name in the members table
//   --dry-run            Preview only, auto-saves JSON to output/
//   --auth-dir=<dir>     Auth directory (default: .baileys_auth)
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, proto, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { parseBeer, maskPhone } from "../../src/parser.js";
import { insertBeers, correctBeerMember } from "../../src/store.js";
import { acquireSessionLock } from "../../src/session-lock.js";
import { createClient } from "@supabase/supabase-js";

const GROUP_JID = process.env.GROUP_JID;
if (!GROUP_JID) { console.error("GROUP_JID not set"); process.exit(1); }

const FILL_GAPS  = process.argv.includes("--fill-gaps");
const FILL_NAMES = process.argv.includes("--fill-push-names");
const DRY_RUN    = process.argv.includes("--dry-run");
const AUTH_DIR  = ".baileys_auth.history";
const LOCK_FILE = `${AUTH_DIR}.lock`;

if (!FILL_GAPS && !FILL_NAMES) {
  console.error("No action flag set. Use --fill-gaps, --fill-push-names, or both. Add --dry-run to preview.");
  process.exit(1);
}

console.log(`Actions: ${[FILL_GAPS && "fill-gaps", FILL_NAMES && "fill-push-names"].filter(Boolean).join(", ")}${DRY_RUN ? " (dry-run)" : ""}`);

const OUTPUT_DIR = new URL("output/", import.meta.url).pathname;
mkdirSync(OUTPUT_DIR, { recursive: true });
const runTs = new Date().toISOString().slice(0, 16).replace(/:/g, "-");
const DRY_RUN_FILE = `${OUTPUT_DIR}dry-run-${runTs}.json`;

const MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null);
const logger = pino({ level: "fatal" }); // silence expected decrypt errors

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

// Load existing DB state
const existing = [];
for (let from = 0; ; from += 1000) {
  const { data: page, error } = await supabase.from("beers").select("beer_number, ts, participant, member, push_name").order("beer_number", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  existing.push(...page);
  if (page.length < 1000) break;
}
const known = new Set(existing.map(r => r.beer_number));
const byNum = new Map(existing.map(r => [r.beer_number, r]));
console.log(`Loaded ${known.size} beers from the database.`);

let inserted = 0, nameUpdates = 0;
const crawlByNum = new Map();
const pushNamesSeen = new Map();

function ingest(msg) {
  if (msg.key?.remoteJid !== GROUP_JID) return;
  const msgTs = Number(msg.messageTimestamp) * 1000;
  const participant = num(msg.key.participant);
  if (participant && msg.pushName) pushNamesSeen.set(participant, msg.pushName);

  const proto_msg = msg.message?.protocolMessage;
  const text = mediaCaption(proto_msg?.type === MESSAGE_EDIT ? proto_msg.editedMessage : msg.message);
  if (text === null) return;
  const beerNum = parseBeer(text);
  if (beerNum === null) return;

  const list = crawlByNum.get(beerNum) ?? [];
  list.push({ ts: new Date(msgTs), participant, pushName: msg.pushName ?? null, member: msg.pushName || participant || "unknown", wa_message_id: msg.key.id, raw_caption: text });
  crawlByNum.set(beerNum, list);
}

async function reconcile() {
  if (FILL_NAMES) {
    for (const [participant, pushName] of pushNamesSeen) {
      if (DRY_RUN) continue;
      await supabase.from("members").update({ push_name: pushName }).eq("participant", participant);
      nameUpdates++;
    }
  }

  for (const beerNum of [...crawlByNum.keys()].sort((a, b) => a - b)) {
    if (known.has(beerNum)) continue;
    if (!FILL_GAPS) continue;
    const first = crawlByNum.get(beerNum).sort((a, b) => a.ts - b.ts)[0];
    console.log(`[gap] #${beerNum} by ${first.member} @ ${first.ts.toLocaleString()}${DRY_RUN ? " (dry-run)" : ""}`);
    if (!DRY_RUN) {
      try {
        const n = await insertBeers([{ beer_number: beerNum, member: first.member, push_name: first.pushName, participant: first.participant, ts: first.ts, raw_caption: first.raw_caption, source: "sync", wa_message_id: first.wa_message_id }]);
        if (n) inserted++;
      } catch (e) { console.error(`[gap] failed #${beerNum}:`, e.message); }
    }
  }
}

let done = false;
async function finish() {
  if (done) return;
  done = true;

  const gapCount = [...crawlByNum.keys()].filter(n => !known.has(n)).length;
  console.log(`\nSync complete. Reconciling…`);
  await reconcile();

  if (FILL_GAPS)  console.log(`Gaps: ${DRY_RUN ? "would insert" : "inserted"} ${DRY_RUN ? gapCount : inserted} beers.`);
  if (FILL_NAMES) console.log(`Push names: ${DRY_RUN ? "would update" : "updated"} ${DRY_RUN ? pushNamesSeen.size : nameUpdates} members.`);

  if (DRY_RUN) {
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
    writeFileSync(DRY_RUN_FILE, JSON.stringify(payload, null, 2));
    console.log(`[save] ${DRY_RUN_FILE} (${payload.crawlByNum.length} beers, ${payload.pushNamesSeen.length} push names)`);
  }

  process.exit(0);
}

acquireSessionLock(LOCK_FILE);
const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({ version, auth: state, logger, syncFullHistory: true, getMessage: async () => undefined });
sock.ev.on("creds.update", saveCreds);
sock.ev.on("messages.upsert", ({ messages }) => { for (const msg of messages) ingest(msg); });

let chunks = 0;
let totalSeen = 0;
let finishTimer = null;

sock.ev.on("messaging-history.set", ({ messages, isLatest }) => {
  const groupMsgs = messages.filter(m => m.key?.remoteJid === GROUP_JID);
  for (const msg of groupMsgs) ingest(msg);

  chunks++;
  totalSeen += messages.length;
  const beersFound = crawlByNum.size;
  const namesFound = pushNamesSeen.size;
  console.log(`[chunk ${chunks}] ${messages.length} messages (${groupMsgs.length} from group) | beers: ${beersFound} | push names: ${namesFound} | total seen: ${totalSeen}${isLatest ? " ← last chunk" : ""}`);

  if (isLatest) {
    // Small buffer in case a final in-flight chunk arrives just after
    clearTimeout(finishTimer);
    finishTimer = setTimeout(finish, 3_000);
  }
});

sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    console.log("Scan in WhatsApp → Linked Devices to link this session (one-time):");
    qrcode.generate(qr, { small: true });
  }
  if (connection === "open") console.log("Connected. Waiting for history sync…");
  if (connection === "close" && !done) {
    const code = lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      console.error(`Session logged out — re-link the bot (delete ${AUTH_DIR} and restart bot.js).`);
      process.exit(1);
    }
  }
});

// Fallback: if isLatest never fires, finish after 15 minutes
setTimeout(() => {
  console.log("\nTimeout reached — finishing with what was collected.");
  finish();
}, 15 * 60_000);
