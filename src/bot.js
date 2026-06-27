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
import { guardDecision } from "./guard.js";
import { acquireSessionLock } from "./session-lock.js";
import { insertBeers, markBeerDeleted, getMemberName, handleBeerEdit, getLastBeers, getMaxBeerNumber } from "./store.js";

const REVOKE = proto.Message.ProtocolMessage.Type.REVOKE;
const MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null); // jid -> bare number

const GROUP_JID = process.env.GROUP_JID || null;
const MAX_SKIP = 5; // reject beer numbers more than this far ahead of current max
const PAIR_NUMBER = process.env.PAIR_NUMBER || null; // optional: e.g. 491701234567 for pairing-code login
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

function messageText(message) {
  // Unwrap container types: HD images (viewOnceMessageV2), live photos (viewOnceMessage),
  // docs-with-caption, and disappearing messages all nest the real message one level down.
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

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(".baileys_auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger,
    syncFullHistory: true,
    getMessage: async () => undefined, // ponytail: no local cache; tells Baileys to fetch missed messages from server
  });

  sock.ev.on("creds.update", saveCreds);

  // First-run login: pairing code if PAIR_NUMBER is set, else QR.
  if (!sock.authState.creds.registered && PAIR_NUMBER) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PAIR_NUMBER);
      console.log(`\nPairing code: ${code}\nWhatsApp -> Linked Devices -> Link with phone number\n`);
    }, 3000);
  }

  // Resolved when connection opens; the history handler awaits it to avoid a race.
  let resolveAudit;
  let startupAuditPromise = new Promise((r) => { resolveAudit = r; });

  // A beer number that ran ahead of the known max, held until a second nearby beer confirms
  // it's a real jump (offline gap) rather than a typo. Reset each connection.
  let pendingHigh = null;

  // On reconnect, compare the last 10 tracked beers against WhatsApp history:
  // catch offline deletions/edits and insert any new beers we missed.
  sock.ev.on("messaging-history.set", async ({ messages, isLatest }) => {
    const audit = await startupAuditPromise;
    if (!audit || audit.done) return;

    for (const msg of messages) {
      if (msg.key?.remoteJid !== GROUP_JID) continue;
      const msgTs = Number(msg.messageTimestamp) * 1000;
      if (msgTs < audit.oldestSeen) audit.oldestSeen = msgTs;

      const id = msg.key.id;

      // Check offline edits on our tracked beers.
      if (audit.pending.has(id)) {
        audit.seen.add(id);
        const text = messageText(msg.message);
        const newNum = parseBeer(text);
        const dbBeer = audit.beers.get(id);
        if (newNum !== null && newNum !== dbBeer.beer_number) {
          try {
            await handleBeerEdit(id, newNum, { raw_caption: text });
            console.log(`[startup] corrected beer #${dbBeer.beer_number} → #${newNum}`);
          } catch (err) {
            console.error("[startup] edit correction failed:", err.message);
          }
        }
      }

      // Catch edits of previously-skipped messages (original was never in DB).
      const protoMsg = msg.message?.protocolMessage;
      if (protoMsg?.type === MESSAGE_EDIT && !audit.pending.has(id)) {
        const editText = messageText(protoMsg.editedMessage);
        const editNum = parseBeer(editText);
        if (editNum !== null) {
          const member = msg.pushName || num(msg.key.participant) || "unknown";
          try {
            const n = await insertBeers([{ beer_number: editNum, member, push_name: msg.pushName ?? null, participant: num(msg.key.participant), ts: new Date(msgTs), raw_caption: editText, source: "live", wa_message_id: id }]);
            if (n) console.log(`[startup] gap-fill from edit: beer #${editNum} by ${member}`);
          } catch (err) { console.error(`[startup] gap-fill edit failed #${editNum}:`, err.message); }
        }
      }

      // Insert beers that arrived while we were offline.
      const text = messageText(msg.message);
      const beerNum = parseBeer(text);
      if (beerNum !== null && beerNum > audit.lastBeerNumber) {
        const member = msg.pushName || num(msg.key.participant) || "unknown";
        try {
          const inserted = await insertBeers([{
            beer_number: beerNum, member,
            push_name: msg.pushName ?? null,
            participant: num(msg.key.participant),
            ts: new Date(msgTs),
            raw_caption: text, source: "live", wa_message_id: id,
          }]);
          if (inserted) console.log(`[startup] caught up beer #${beerNum} by ${member}`);
        } catch (err) {
          console.error(`[startup] insert failed for #${beerNum}:`, err.message);
        }
      }
    }

    if (isLatest) {
      // Beer not seen in history, but history covers its timestamp → deleted while offline.
      for (const id of audit.pending) {
        if (audit.seen.has(id)) continue;
        const beer = audit.beers.get(id);
        if (audit.oldestSeen <= new Date(beer.ts).getTime()) {
          try {
            const deleted = await markBeerDeleted(id, "startup-audit", null, false);
            if (deleted) console.log(`[startup] removed beer #${deleted.beer_number} (deleted while offline)`);
          } catch (err) {
            console.error("[startup] delete failed:", err.message);
          }
        }
      }
      audit.done = true;
      console.log("[startup] audit complete");
    }
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !PAIR_NUMBER) {
      console.log("Scan this QR in WhatsApp -> Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("connected" + (GROUP_JID ? `, watching ${GROUP_JID}` : ", no GROUP_JID set — logging group JIDs below"));
      if (GROUP_JID) {
        try {
          const lastBeers = await getLastBeers(10);
          const lastBeerNumber = lastBeers[0]?.beer_number ?? -1;
          resolveAudit({
            lastBeerNumber,
            pending: new Set(lastBeers.map((b) => b.wa_message_id)),
            beers: new Map(lastBeers.map((b) => [b.wa_message_id, b])),
            seen: new Set(),
            oldestSeen: Infinity,
            done: false,
          });
          console.log(`[startup] watching last ${lastBeers.length} beers (newest: #${lastBeerNumber})`);
        } catch (err) {
          console.error("[startup] failed to load last beers:", err.message);
          resolveAudit(null);
        }
      } else {
        resolveAudit(null);
      }
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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    const catchup = type === "append";
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

      // Message edit (rarely arrives via upsert; main path is the messages.update handler below).
      if (msg.message?.protocolMessage?.type === MESSAGE_EDIT) {
        const p = msg.message.protocolMessage;
        await handleEdit(p.key?.id, messageText(p.editedMessage), new Date(Number(msg.messageTimestamp) * 1000), msg.pushName, num(msg.key.participant));
        continue;
      }

      const text = messageText(msg.message);
      const beer_number = parseBeer(text);
      const member = msg.pushName || num(msg.key.participant) || "unknown";
      if (beer_number === null) {
        if (text.trim()) console.log(`skipped: ${member}: ${JSON.stringify(text.slice(0, 60))}`);
        continue;
      }
      const entry = {
        beer_number,
        member,
        push_name: msg.pushName ?? null,
        participant: num(msg.key.participant),
        ts: new Date(Number(msg.messageTimestamp) * 1000),
        raw_caption: text,
        source: "live",
        wa_message_id: msg.key.id,
      };

      const maxKnown = await getMaxBeerNumber();
      // ponytail: a lone typo runs ahead once; a real offline jump is confirmed by the next nearby beer.
      // Ceiling: two typos within MAX_SKIP of each other could slip through — tighten to N confirmations if it bites.
      const decision = guardDecision(beer_number, maxKnown, pendingHigh, MAX_SKIP);
      if (decision === "hold") {
        pendingHigh = entry;
        console.warn(`[hold] beer #${beer_number} by ${member} ran ahead of #${maxKnown}; awaiting confirmation`);
        continue;
      }
      if (decision === "confirm") {
        try {
          await insertBeers([pendingHigh]);
          console.log(`[unstick] confirmed jump to #${pendingHigh.beer_number}, resuming live counting`);
        } catch (err) {
          console.error(`unstick insert failed for #${pendingHigh.beer_number}:`, err.message);
        }
      }
      pendingHigh = null;

      try {
        const inserted = await insertBeers([entry]);
        console.log(inserted ? `${catchup ? "[catchup] " : ""}beer #${beer_number} by ${member}` : `dup #${beer_number} (ignored)`);
      } catch (err) {
        console.error(`write failed for #${beer_number}:`, err.message);
      }
    }
  });

  // Live message edits arrive here, NOT on messages.upsert — Baileys routes MESSAGE_EDIT
  // to messages.update with the new content under update.message.editedMessage.
  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates) {
      if (u.key?.remoteJid !== GROUP_JID) continue;
      const edited = u.update?.message?.editedMessage?.message;
      if (!edited) continue; // status/receipt update, not an edit
      const ts = new Date(Number(u.update.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000);
      await handleEdit(u.key.id, messageText(edited), ts, u.pushName, num(u.key.participant));
    }
  });
}

// originalId: id of the edited message. Only updates the fields an edit changes —
// pushName is usually absent on edit events, so we don't pass it (would clobber the
// stored poster name); identity is preserved unless we're inserting a fresh row.
async function handleEdit(originalId, newText, ts, pushName, participant) {
  if (!originalId) return;
  const beer_number = parseBeer(newText);

  const fields = { raw_caption: newText, ts };
  if (pushName) { fields.member = pushName; fields.push_name = pushName; }
  if (participant) fields.participant = participant;

  try {
    const result = await handleBeerEdit(originalId, beer_number, fields);
    if (result.action === "deleted") console.log(`edit→non-number: hard deleted beer #${result.beer?.beer_number} (${result.beer?.member})`);
    else if (result.action === "updated") console.log(`edit: message ${originalId} → beer #${beer_number}`);
    else if (result.action === "inserted") console.log(`edit→new: beer #${beer_number}`);
    else console.log(`edit for untracked message ${originalId} — ignored`);
  } catch (err) {
    console.error("edit handling failed:", err.message);
  }
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

acquireSessionLock(); // refuse to start if another process holds the WhatsApp session
start();
