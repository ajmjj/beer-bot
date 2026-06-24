// Live WhatsApp ingestion via Baileys (websocket companion device). Read-only.
import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { parseBeer } from "./parser.js";
import { insertBeers } from "./store.js";

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

      const text = messageText(msg.message);
      const beer_number = parseBeer(text);
      const member = msg.pushName || msg.key.participant || "unknown";
      if (beer_number === null) {
        if (text.trim()) console.log(`skipped: ${member}: ${JSON.stringify(text.slice(0, 60))}`);
        continue;
      }
      try {
        const inserted = await insertBeers([{
          beer_number,
          member,
          ts: new Date(Number(msg.messageTimestamp) * 1000),
          raw_caption: text,
          source: "live",
        }]);
        console.log(inserted ? `beer #${beer_number} by ${member}` : `dup #${beer_number} (ignored)`);
      } catch (err) {
        console.error(`write failed for #${beer_number}:`, err.message);
      }
    }
  });
}

start();
