// Live WhatsApp ingestion via Baileys (websocket companion device). Read-only.
import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { log } from "./logger.js";
import { parseBeer } from "./parser.js";
import { guardDecision } from "./guard.js";
import { decryptEdit } from "./edit-crypto.js";
import { acquireSessionLock } from "./session-lock.js";
import { insertBeers, markBeerDeleted, getMemberName, handleBeerEdit, getLastBeers, getMaxBeerNumber, syncMembers, touchMember, updatePushNameByAnyId, updateMemberPhone } from "./store.js";

const REVOKE = proto.Message.ProtocolMessage.Type.REVOKE;
const MESSAGE_EDIT = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
const SECRET_MESSAGE_EDIT = proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT;
const num = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null); // jid -> bare number

// Edits arrive encrypted with the ORIGINAL message's messageSecret, so we retain each
// incoming message's secret keyed by its id. WhatsApp caps edits at 15 min from the
// original; 30 min TTL gives margin. Tiny (32 bytes/entry) and swept lazily.
const EDIT_SECRET_TTL_MS = 30 * 60 * 1000;
const editSecrets = new Map(); // wa_message_id -> { secret: Uint8Array, ts: number }
function rememberSecret(id, secret) {
  if (!id || !secret) return;
  editSecrets.set(id, { secret, ts: Date.now() });
  if (editSecrets.size > 1000) {
    const cutoff = Date.now() - EDIT_SECRET_TTL_MS;
    for (const [k, v] of editSecrets) if (v.ts < cutoff) editSecrets.delete(k);
  }
}

const GROUP_JID = process.env.GROUP_JID || null;
const MAX_SKIP = 5; // reject beer numbers more than this far ahead of current max
const PAIR_NUMBER = process.env.PAIR_NUMBER || null; // optional: e.g. 491701234567 for pairing-code login
const baileysLogger = log.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL || "warn" });

// Dead-man's-switch heartbeat: ping HEALTHCHECK_URL every 60s while WhatsApp is connected,
// and /fail the instant it drops. healthchecks.io alerts (e.g. Telegram push) if pings stop.
// No-op if HEALTHCHECK_URL is unset, so local dev is unaffected.
const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || null;
let heartbeat = null;
let reconnectDelay = 0; // backoff so a refused server (e.g. 405) can't be hammered into an IP block
// ponytail: fire-and-forget — a failed ping must never crash or block the bot.
const hcPing = (path = "") => { if (HEALTHCHECK_URL) fetch(HEALTHCHECK_URL + path).catch(() => {}); };

// Unwrap container types: HD images (viewOnceMessageV2), live photos (viewOnceMessage),
// docs-with-caption, and disappearing messages all nest the real message one level down.
const unwrap = (message) =>
  message?.ephemeralMessage?.message ??
  message?.viewOnceMessage?.message ??
  message?.viewOnceMessageV2?.message ??
  message?.documentWithCaptionMessage?.message ??
  message;

// Content type of a message for debug logging, e.g. "imageMessage" or "protocolMessage:REVOKE".
function messageKind(message) {
  const m = unwrap(message);
  const kind = Object.keys(m ?? {}).find((k) => k !== "messageContextInfo") ?? "empty";
  if (kind !== "protocolMessage") return kind;
  const t = m.protocolMessage?.type;
  const name = Object.keys(proto.Message.ProtocolMessage.Type).find((k) => proto.Message.ProtocolMessage.Type[k] === t);
  return `protocolMessage:${name ?? t}`;
}

function messageText(message) {
  const m = unwrap(message);
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    ""
  );
}

// Full member reconcile from group metadata: the group is lid-addressed, so
// p.id carries the lid and p.jid the phone number (when the server shares
// it). Present members are upserted (rejoin clears left_at), absent ones are
// soft-deleted. On fetch failure we log and keep the table as-is — never wipe.
async function reconcileMembers(sock) {
  if (!GROUP_JID) return;
  try {
    const meta = await sock.groupMetadata(GROUP_JID);
    const n = await syncMembers(meta.participants.map((p) => ({
      participant: num(p.id),
      phone: num(p.jid),
      is_admin: !!p.admin,
    })));
    log.info({ members: n }, "members synced");
  } catch (err) {
    log.error({ err }, "member sync failed");
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(".baileys_auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger: baileysLogger,
    syncFullHistory: true,
    getMessage: async () => undefined, // ponytail: no local cache; tells Baileys to fetch missed messages from server
  });

  // LOG_EVENTS=1: dump every incoming Baileys event with its full payload.
  // ponytail: messaging-history.set batches can be huge — truncate if it bites.
  if (process.env.LOG_EVENTS) {
    sock.ev.process((events) => {
      for (const [event, data] of Object.entries(events)) log.debug({ event, data }, "wa event");
    });
  }

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
            log.info({ scope: "startup", from: dbBeer.beer_number, to: newNum }, "corrected beer");
          } catch (err) {
            log.error({ scope: "startup", err }, "edit correction failed");
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
            if (n) log.info({ scope: "startup", beer: editNum, member }, "gap-fill from edit");
          } catch (err) { log.error({ scope: "startup", beer: editNum, err }, "gap-fill edit failed"); }
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
          if (inserted) log.info({ scope: "startup", beer: beerNum, member }, "caught up beer");
        } catch (err) {
          log.error({ scope: "startup", beer: beerNum, err }, "insert failed");
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
            if (deleted) log.info({ scope: "startup", beer: deleted.beer_number }, "removed beer deleted while offline");
          } catch (err) {
            log.error({ scope: "startup", err }, "delete failed");
          }
        }
      }
      audit.done = true;
      log.info({ scope: "startup" }, "audit complete");
    }
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !PAIR_NUMBER) {
      console.log("Scan this QR in WhatsApp -> Linked Devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      hcPing(); // check in now, then keep checking in while the socket stays open
      clearInterval(heartbeat);
      heartbeat = setInterval(hcPing, 60_000);
      reconnectDelay = 0; // healthy connection — reset backoff
      log.info({ group: GROUP_JID }, GROUP_JID ? "connected" : "connected — no GROUP_JID set, logging group JIDs");
      reconcileMembers(sock); // catches joins/leaves that happened while offline
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
          log.info({ scope: "startup", count: lastBeers.length, newest: lastBeerNumber }, "watching last beers");
        } catch (err) {
          log.error({ scope: "startup", err }, "failed to load last beers");
          resolveAudit(null);
        }
      } else {
        resolveAudit(null);
      }
    }
    if (connection === "close") {
      clearInterval(heartbeat);
      hcPing("/fail"); // tell healthchecks we dropped, so it alerts without waiting for the timeout
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.error("logged out — delete .baileys_auth and re-link");
      } else {
        reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : 2_000, 60_000);
        log.info({ code, delayMs: reconnectDelay }, "connection closed, reconnecting");
        setTimeout(start, reconnectDelay);
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
        log.info({ jid, pushName: msg.pushName ?? null }, "group message (discovery mode)");
        continue;
      }
      if (jid !== GROUP_JID) continue;

      log.debug({ id: msg.key.id, kind: messageKind(msg.message), member: msg.pushName || num(msg.key.participant), catchup }, "message received");

      // Keep the sender's member row current: pushName from the stanza, phone
      // from participantPn (the only live source of phone numbers in a
      // lid-addressed group). Fire-and-forget so beer handling never waits.
      if (!msg.key.fromMe) {
        touchMember({ participant: num(msg.key.participant), phone: num(msg.key.participantPn), pushName: msg.pushName })
          .catch((err) => log.warn({ err }, "member touch failed"));
      }

      // Retain this message's secret so we can decrypt a later edit of it.
      rememberSecret(msg.key.id, unwrap(msg.message)?.messageContextInfo?.messageSecret);

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

      // Encrypted edit: the real live-edit path. Decrypt with the original message's
      // stored secret, then route to the same handler as a plaintext edit.
      const secretEdit = unwrap(msg.message)?.secretEncryptedMessage;
      if (secretEdit?.secretEncType === SECRET_MESSAGE_EDIT) {
        const targetId = secretEdit.targetMessageKey?.id;
        const held = targetId && editSecrets.get(targetId);
        if (!held) {
          log.info({ id: targetId }, "encrypted edit but original secret not cached — skipping");
          continue;
        }
        // Sender JID is the LID form "<lid>@lid" (confirmed empirically); PN form is a
        // fallback for phone-addressed senders. A wrong candidate just fails GCM auth.
        const senderJids = [
          num(msg.key.participant) && `${num(msg.key.participant)}@lid`,
          num(msg.key.participantPn) && `${num(msg.key.participantPn)}@s.whatsapp.net`,
        ].filter(Boolean);
        const edited = decryptEdit({ secret: held.secret, encPayload: secretEdit.encPayload, encIv: secretEdit.encIv, targetId, senderJids });
        if (!edited) {
          log.warn({ id: targetId }, "encrypted edit decrypt failed (no sender jid matched)");
          continue;
        }
        await handleEdit(targetId, messageText(edited), new Date(Number(msg.messageTimestamp) * 1000), msg.pushName, num(msg.key.participant));
        continue;
      }

      const text = messageText(msg.message);
      const beer_number = parseBeer(text);
      const member = msg.pushName || num(msg.key.participant) || "unknown";
      if (beer_number === null) {
        // Log every non-beer message — including caption-less media — so a beer photo
        // posted without a number is still visible in the log for manual backfill.
        log.info({ member, id: msg.key.id, kind: messageKind(msg.message), text: text.slice(0, 200) }, "skipped non-beer message");
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
      log.debug({ beer: beer_number, max: maxKnown, decision }, "guard decision");
      if (decision === "hold") {
        pendingHigh = entry;
        log.warn({ beer: beer_number, member, max: maxKnown }, "beer ran ahead; awaiting confirmation");
        continue;
      }
      if (decision === "confirm") {
        try {
          await insertBeers([pendingHigh]);
          log.info({ beer: pendingHigh.beer_number }, "confirmed jump, resuming live counting");
        } catch (err) {
          log.error({ beer: pendingHigh.beer_number, err }, "unstick insert failed");
        }
      }
      // A held ran-ahead value that a normal beer supersedes (never confirmed) is dropped —
      // log it so a wrongly-discarded beer can be spotted and backfilled by hand.
      if (pendingHigh && decision === "pass") {
        log.info({ beer: pendingHigh.beer_number, member: pendingHigh.member, id: pendingHigh.wa_message_id }, "held beer discarded (unconfirmed ran-ahead value)");
      }
      pendingHigh = null;

      try {
        const inserted = await insertBeers([entry]);
        if (inserted) log.info({ beer: beer_number, member, id: msg.key.id, text, catchup }, "beer recorded");
        else log.info({ beer: beer_number, member, id: msg.key.id }, "duplicate ignored");
      } catch (err) {
        log.error({ beer: beer_number, err }, "write failed");
      }
    }
  });

  // Live message edits arrive here, NOT on messages.upsert — Baileys routes MESSAGE_EDIT
  // to messages.update with the new content under update.message.editedMessage.
  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates) {
      if (u.key?.remoteJid !== GROUP_JID) continue;
      if (!u.key.fromMe) {
        // Best effort: pushName is rarely present on updates, participantPn sometimes is.
        touchMember({ participant: num(u.key.participant), phone: num(u.key.participantPn), pushName: u.update?.pushName })
          .catch((err) => log.warn({ err }, "member touch failed"));
      }
      const edited = u.update?.message?.editedMessage?.message;
      log.debug({ id: u.key.id, edit: !!edited }, "message update");
      if (!edited) continue; // status/receipt update, not an edit
      const ts = new Date(Number(u.update.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000);
      await handleEdit(u.key.id, messageText(edited), ts, u.pushName, num(u.key.participant));
    }
  });

  // Baileys synthesizes contacts.update (id + notify = pushName) for every
  // push-named incoming message; picture-only updates carry no notify and are
  // skipped. The id may be lid- or phone-format; the store matches both.
  // Update-only, so contacts from DMs/other groups never enter the table.
  sock.ev.on("contacts.update", async (contacts) => {
    for (const c of contacts) {
      if (!c.notify) continue;
      await updatePushNameByAnyId(num(c.id), c.notify).catch((err) => log.warn({ err }, "push name update failed"));
    }
  });

  // Explicit lid -> phone mapping pushed by the server.
  sock.ev.on("chats.phoneNumberShare", async ({ lid, jid }) => {
    await updateMemberPhone(num(lid), num(jid)).catch((err) => log.warn({ err }, "phone share update failed"));
  });

  // Membership changes (add/remove/promote/demote/number change): re-sync from
  // fresh metadata. One code path — after a remove the reconcile soft-deletes
  // the leaver; after an add/modify it picks up the new lid+phone mapping
  // (the event itself only carries one JID form).
  // ponytail: one metadata fetch per membership event; fine for a single group.
  sock.ev.on("group-participants.update", async ({ id, action, participants }) => {
    if (id !== GROUP_JID) return;
    log.debug({ action, participants: participants?.map(num) }, "group participants update");
    await reconcileMembers(sock);
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
    if (result.action === "deleted") log.info({ beer: result.beer?.beer_number, member: result.beer?.member, id: originalId, text: newText }, "edit to non-number: hard deleted beer");
    else if (result.action === "updated") log.info({ id: originalId, beer: beer_number, member: result.beer?.member, text: newText }, "edit updated beer");
    else if (result.action === "inserted") log.info({ id: originalId, beer: beer_number, member: result.beer?.member, text: newText }, "edit created new beer");
    else if (result.action === "conflict") log.warn({ id: originalId, beer: beer_number, text: newText }, "edit target number already taken — dropped");
    else log.info({ id: originalId, text: newText }, "edit for untracked message ignored");
  } catch (err) {
    log.error({ id: originalId, err }, "edit handling failed");
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
    log.error({ err }, "couldn't fetch group admins");
  }

  const deleterNumber = num(deleterJid);
  // Revoke usually carries the deleter's pushName; fall back to a name we've seen them post under.
  const deleterName = msg.pushName || (await getMemberName(deleterNumber)) || null;

  try {
    const beer = await markBeerDeleted(deletedId, deleterNumber, deleterName, byAdmin);
    if (beer) log.info({ beer: beer.beer_number, member: beer.member, deletedBy: deleterName || deleterNumber, byAdmin }, "beer deleted");
    else log.info({ id: deletedId }, "revoke for untracked message (likely backfilled/non-beer) ignored");
  } catch (err) {
    log.error({ id: deletedId, err }, "deletion record failed");
  }
}

acquireSessionLock(); // refuse to start if another process holds the WhatsApp session
start();
