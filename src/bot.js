// Live WhatsApp ingestion via Baileys (websocket companion device). Read-only.
import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { parseBeer } from "./parser.js";
import { insertBeers, markBeerDeleted, getMemberName } from "./store.js";

const REVOKE = proto.Message.ProtocolMessage.Type.REVOKE;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null); // jid -> bare number

const GROUP_JID = process.env.GROUP_JID || null;
const PAIR_NUMBER = process.env.PAIR_NUMBER || null; // optional: e.g. 491701234567 for pairing-code login
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

function messageText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ""
  );
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(".baileys_auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger });

  sock.ev.on("creds.update", saveCreds);

  // First-run login: pairing code if PAIR_NUMBER is set, else QR.
  if (!sock.authState.creds.registered && PAIR_NUMBER) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PAIR_NUMBER);
      console.log(`\nPairing code: ${code}\nWhatsApp -> Linked Devices -> Link with phone number\n`);
    }, 3000);
  }

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && !PAIR_NUMBER) {
      console.log("Scan this QR in WhatsApp -> Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("connected" + (GROUP_JID ? `, watching ${GROUP_JID}` : ", no GROUP_JID set — logging group JIDs below"));
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("logged out — delete .baileys_auth and re-link");
      } else {
        console.log("connection closed, reconnecting...");
        start();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid?.endsWith("@g.us")) continue; // groups only

      // Discovery mode: no GROUP_JID yet — print what we see so the user can pick.
      if (!GROUP_JID) {
        console.log(`group message from jid=${jid} (${msg.pushName ?? "?"})`);
        continue;
      }
      if (jid !== GROUP_JID) continue;

      // Delete-for-everyone: a REVOKE protocol message naming the deleted message.
      if (msg.message?.protocolMessage?.type === REVOKE) {
        await handleDeletion(sock, msg);
        continue;
      }

      const text = messageText(msg.message);
      const beer_number = parseBeer(text);
      const member = msg.pushName || num(msg.key.participant) || "unknown";
      if (beer_number === null) {
        if (text.trim()) console.log(`skipped: ${member}: ${JSON.stringify(text.slice(0, 60))}`);
        continue;
      }
      try {
        const inserted = await insertBeers([{
          beer_number,
          member,
          push_name: msg.pushName ?? null,
          participant: num(msg.key.participant),
          ts: new Date(Number(msg.messageTimestamp) * 1000),
          raw_caption: text,
          source: "live",
          wa_message_id: msg.key.id,
        }]);
        console.log(inserted ? `beer #${beer_number} by ${member}` : `dup #${beer_number} (ignored)`);
      } catch (err) {
        console.error(`write failed for #${beer_number}:`, err.message);
      }
    }
  });
}

// A revoked message: figure out who deleted it (and whether they're an admin),
// then soft-delete the matching beer.
async function handleDeletion(sock, msg) {
  const deletedId = msg.message.protocolMessage.key?.id;
  const authorJid = msg.message.protocolMessage.key?.participant; // original poster
  const deleterJid = msg.key.participant; // who issued the revoke
  if (!deletedId) return;

  let byAdmin = false;
  try {
    const admins = new Set(
      (await sock.groupMetadata(GROUP_JID)).participants.filter((p) => p.admin).map((p) => p.id),
    );
    byAdmin = !!deleterJid && deleterJid !== authorJid && admins.has(deleterJid);
  } catch (err) {
    console.error("couldn't fetch group admins:", err.message);
  }

  const deleterNumber = num(deleterJid);
  // Revoke usually carries the deleter's pushName; fall back to a name we've seen them post under.
  const deleterName = msg.pushName || (await getMemberName(deleterNumber)) || null;

  try {
    const beer = await markBeerDeleted(deletedId, deleterNumber, deleterName, byAdmin);
    console.log(
      beer
        ? `deleted beer #${beer.beer_number} (${beer.member}) by ${deleterName || deleterNumber}${byAdmin ? " [admin]" : ""}`
        : `revoke for untracked message ${deletedId} (likely a backfilled/non-beer message) — ignored`,
    );
  } catch (err) {
    console.error("deletion record failed:", err.message);
  }
}

start();
