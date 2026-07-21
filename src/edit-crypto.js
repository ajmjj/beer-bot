// Decrypt a WhatsApp message edit. Edits no longer arrive as a readable
// protocolMessage.editedMessage — they come as a `secretEncryptedMessage`
// (secretEncType MESSAGE_EDIT) encrypted with the ORIGINAL message's messageSecret,
// the same "message secret" scheme Baileys uses for poll votes (decryptPollVote).
//
// Key derivation (mirrors decryptPollVote, swapping the use-case string for edits and
// using an EMPTY AAD — whatsmeow's msgsecret.go sets no additionalData for Message Edit):
//   key0   = HMAC(key=zeros32, data=originalSecret)              // HKDF-extract
//   decKey = HMAC(key=key0, data= targetId ++ sender ++ sender ++ "Message Edit" ++ 0x01)
//   plain  = AES-256-GCM-decrypt(encPayload, decKey, encIv, aad="")
//   decoded = proto.Message.decode(plain)  // wraps a protocolMessage(MESSAGE_EDIT)
//   edited  = decoded.protocolMessage.editedMessage  // the actual new content (verified
//             against a real captured edit: e.g. { imageMessage: { caption: "8557" } })
//
// The sender JID appears twice (original author + edit author — the same person, since
// you can only edit your own message). The form is the LID address "<lid>@lid" (confirmed
// empirically); callers may pass extra candidates for phone-addressed senders. A wrong key
// makes GCM throw on the auth tag, so a wrong candidate can't produce a false positive.
import { aesDecryptGCM, aesEncryptGCM, hmacSign, proto } from "@whiskeysockets/baileys";

const ZEROS32 = new Uint8Array(32);
const EMPTY = Buffer.alloc(0);
const EDIT_USE_CASE = "Message Edit";

const bin = (x) => Buffer.from(x);

// Build the HKDF-expand input for a given sender JID string.
function signBytes(targetId, senderJid) {
  return Buffer.concat([bin(targetId), bin(senderJid), bin(senderJid), bin(EDIT_USE_CASE), new Uint8Array([1])]);
}

// Returns the edited message content (a proto.IMessage, e.g. { imageMessage: { caption }}
// or { conversation }), or null if none of the candidate sender JIDs decrypt it.
export function decryptEdit({ secret, encPayload, encIv, targetId, senderJids }) {
  if (!secret || !encPayload || !encIv || !targetId) return null;
  const key0 = hmacSign(bin(secret), ZEROS32, "sha256"); // sender-independent, compute once
  for (const senderJid of senderJids) {
    if (!senderJid) continue;
    try {
      const decKey = hmacSign(signBytes(targetId, senderJid), key0, "sha256");
      const plain = aesDecryptGCM(bin(encPayload), decKey, bin(encIv), EMPTY);
      // Plaintext is a full Message wrapping protocolMessage(MESSAGE_EDIT); the new
      // content lives at .protocolMessage.editedMessage.
      return proto.Message.decode(plain).protocolMessage?.editedMessage ?? null;
    } catch {
      // wrong sender-JID form → GCM auth failure; try the next candidate
    }
  }
  return null;
}

// Self-check: `node src/edit-crypto.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert")).default;
  const { randomBytes } = await import("node:crypto");

  const secret = randomBytes(32);
  const targetId = "3A22025F8FB01CAD190D";
  const sender = "129158340440168@lid";

  // Encrypt a known edit exactly as WhatsApp would: the edited content is wrapped in a
  // protocolMessage(MESSAGE_EDIT), matching a real captured edit.
  const encrypt = (editedMessage, sJid) => {
    const key0 = hmacSign(Buffer.from(secret), new Uint8Array(32), "sha256");
    const decKey = hmacSign(signBytes(targetId, sJid), key0, "sha256");
    const encIv = randomBytes(12);
    const wrapped = { protocolMessage: { key: { id: targetId }, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, editedMessage } };
    const plain = proto.Message.encode(wrapped).finish();
    return { encPayload: aesEncryptGCM(plain, decKey, encIv, Buffer.alloc(0)), encIv };
  };

  // Correct sender among several candidates → recovers the edited content (unwrapped).
  const { encPayload, encIv } = encrypt({ conversation: "8676" }, sender);
  const out = decryptEdit({ secret, encPayload, encIv, targetId, senderJids: ["999@lid", sender, "wrong"] });
  assert.equal(out?.conversation, "8676", "should decrypt & unwrap the edited text");

  // image-caption edit (the real-world case) survives too.
  const cap = encrypt({ imageMessage: { caption: "8557" } }, sender);
  const out2 = decryptEdit({ secret, encPayload: cap.encPayload, encIv: cap.encIv, targetId, senderJids: [sender] });
  assert.equal(out2?.imageMessage?.caption, "8557", "should decrypt an image-caption edit");

  // No candidate matches → null, never a wrong plaintext.
  const none = decryptEdit({ secret, encPayload, encIv, targetId, senderJids: ["nope@lid", "still-wrong"] });
  assert.equal(none, null, "no matching sender jid → null");

  // Wrong secret → null (auth failure), not a crash.
  const badSecret = decryptEdit({ secret: randomBytes(32), encPayload, encIv, targetId, senderJids: [sender] });
  assert.equal(badSecret, null, "wrong secret → null");

  console.log("edit-crypto self-check passed");
}
