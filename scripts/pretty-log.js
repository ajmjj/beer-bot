// Pipes pino's JSON stdout into a plain-text format Lumen (and other line-based
// log viewers) can parse: a bare "yyyy-mm-dd HH:MM:ss.l" timestamp at the start
// of each line. pino-pretty's CLI always wraps the timestamp in brackets
// (lib/utils/prettify-time.js), which breaks tools whose timestamp regex is
// anchored to the start of the line — customPrettifiers.time is the only way
// to drop them, and it's JS-API-only, not exposed as a CLI flag.
//
// Uses prettyFactory (a line -> formatted-string function) rather than build()
// (a stream meant to be pino's transport target, writing straight to fd 1
// internally) — piping build()'s stream a second time double-writes stdout.
import { createInterface } from "node:readline";
import { prettyFactory } from "pino-pretty";

const pretty = prettyFactory({
  translateTime: "yyyy-mm-dd HH:MM:ss.l",
  customPrettifiers: { time: (t) => t },
});

createInterface({ input: process.stdin }).on("line", (line) => {
  process.stdout.write(pretty(line));
});
