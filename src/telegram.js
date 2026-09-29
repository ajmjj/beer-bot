// Minimal Telegram control channel: notify the admin (pairing codes, logout
// alerts) and let them trigger a remote re-pair with /repair — no SSH needed.
// No-op entirely if TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are unset.
import { log } from "./logger.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

export async function notifyTelegram(text) {
  if (!API || !CHAT_ID) return;
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
  } catch (err) {
    log.warn({ err }, "telegram notify failed");
  }
}

// Long-polls getUpdates for a "/repair" command from CHAT_ID only — any other
// chat is ignored, so a leaked bot token alone can't be used to hijack the pairing.
export function listenForRepair(onRepair) {
  if (!API || !CHAT_ID) return;
  let offset = 0;
  (async function poll() {
    for (;;) {
      try {
        const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
        const { result } = await res.json();
        for (const update of result ?? []) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (String(msg?.chat?.id) === CHAT_ID && msg.text?.trim() === "/repair") await onRepair();
        }
      } catch (err) {
        log.warn({ err }, "telegram poll failed");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
