// Shared pino instance. LOG_LEVEL overrides; LOG_EVENTS implies debug.
import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL || (process.env.LOG_EVENTS ? "debug" : "info"),
  // supabase-js errors carry message/code/details/hint on a non-Error object,
  // which pino's default err handling drops — log lines showed no cause at all.
  serializers: {
    err: (e) => ({
      message: e?.message ?? String(e),
      code: e?.code,
      details: e?.details,
      hint: e?.hint,
      stack: e?.stack,
    }),
  },
});
export const dbLog = log.child({ module: "db" });

// Redirect console.error to pino so dependencies (e.g. libsignal) get timestamps.
const _consoleError = console.error.bind(console);
console.error = (...args) => log.error(args.map(String).join(" "));
