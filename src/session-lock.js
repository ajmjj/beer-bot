// Exclusive lock so only one process ever opens the WhatsApp session at a time.
// Two Baileys sockets on one linked-device session corrupt creds.json — this stops that.
// Both bot.js and sync-gaps.js call acquireSessionLock() before connecting.
import { openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOCK = ".baileys_auth.lock";

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function acquireSessionLock(lockPath = LOCK) {
  try {
    const fd = openSync(lockPath, "wx"); // atomic create; throws EEXIST if held
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = parseInt(readFileSync(lockPath, "utf8") || "0", 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      console.error(`WhatsApp session is already held by pid ${pid}. Stop it first — two sockets corrupt the login.`);
      process.exit(1);
    }
    unlinkSync(lockPath); // stale lock from a dead process — retake it
    return acquireSessionLock(lockPath);
  }
  const release = () => { try { unlinkSync(lockPath); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(0));   // triggers 'exit' → release
  process.on("SIGTERM", () => process.exit(0));
  return release;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { existsSync } = await import("node:fs");
  const p = ".session-lock-selfcheck";
  const release = acquireSessionLock(p);
  if (!existsSync(p)) { console.error("FAIL: lock not created"); process.exit(1); }
  // second acquire in-process must NOT exit (same pid is allowed to retake)
  acquireSessionLock(p);
  if (!existsSync(p)) { console.error("FAIL: lock lost on re-acquire"); process.exit(1); }
  release();
  if (existsSync(p)) { console.error("FAIL: lock not released"); process.exit(1); }
  console.log("session-lock self-check passed");
}
