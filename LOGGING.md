# beer-bot logging reference

What the bot writes to the log, at which level, and — importantly for **backfilling
beers after a mistake** — what it does *not* write. All output goes to stdout → the
systemd journal (`journalctl -u beer-bot`).

## Log levels & how to control them

pino numeric levels: `trace 10 · debug 20 · info 30 · warn 40 · error 50 · fatal 60`.
A logger shows its level **and above**.

- **App logger** — `LOG_LEVEL` env (default `info`). Controls everything below except the
  `module:"baileys"` lines.
- **Baileys library logger** — `BAILEYS_LOG_LEVEL` env (default `warn`).
- **`LOG_EVENTS=1`** — dumps every raw WhatsApp event with full payload (separate firehose).

So at the **default `info`**, the `debug` rows below are **not** emitted. Drop
`LOG_LEVEL=debug` to get them.

---

## What IS logged

### Connection / startup
| Message | Level | Notes |
|---|---|---|
| `connected` | info | socket open |
| `watching last beers` | info | last 10 beers loaded, `newest` number |
| `failed to load last beers` | error | |
| `connection closed, reconnecting` | info | includes disconnect `code` |
| `logged out — delete .baileys_auth and re-link` | error | session dead |
| `members synced` / `member sync failed` | info / error | member roster reconcile |
| Pairing code / QR prompt | console | first-run login only |

### Startup audit (offline catch-up, runs on each reconnect)
| Message | Level | Meaning for backfill |
|---|---|---|
| `caught up beer` | info | a beer missed while offline was inserted |
| `corrected beer` | info | a number was fixed via an offline edit |
| `gap-fill from edit` | info | edit created a missing beer |
| `removed beer deleted while offline` | info | offline delete applied |
| `audit complete` | info | end of catch-up |
| `edit correction failed` / `gap-fill edit failed` / `insert failed` / `delete failed` | error | audit step blew up |

### Live beer flow
| Message | Level | Fields |
|---|---|---|
| `message received` | **debug** | `id`, `kind`, `member`, `catchup` — **the only place the wa_message_id is logged** |
| `guard decision` | **debug** | `beer`, `max`, `decision` |
| `beer recorded` | info | `beer`, `member`, `id`, `text` (full caption), `catchup` |
| `duplicate ignored` | info | `beer`, `member`, `id` |
| `write failed` | error | `beer`, `err` |
| `beer ran ahead; awaiting confirmation` | warn | a high number is held pending a 2nd nearby beer |
| `confirmed jump, resuming live counting` | info | held beer inserted |
| `held beer discarded (unconfirmed ran-ahead value)` | info | held value dropped when a normal beer superseded it; `beer`, `member`, `id` |
| `unstick insert failed` | error | |
| `skipped non-beer message` | info | `member`, `id`, `kind`, `text` (first 200 chars) — every non-beer message incl. caption-less media |

### Edits
| Message | Level | |
|---|---|---|
| `edit updated beer` / `edit created new beer` / `edit to non-number: hard deleted beer` | info | includes `id`, `beer`, `member`, `newText` |
| `edit target number already taken — dropped` | warn | conflict |
| `edit for untracked message ignored` | info | |
| `edit handling failed` | error | |
| `message update` | **debug** | every update event; `edit:true/false` |
| `encrypted edit but original secret not cached — skipping` | info | secret expired/not seen |
| `encrypted edit decrypt failed` | warn | |

### Deletions
| Message | Level | |
|---|---|---|
| `beer deleted` | info | `beer`, `member`, `deletedBy`, `byAdmin` |
| `revoke for untracked message … ignored` | info | delete of a non-tracked msg |
| `deletion record failed` / `couldn't fetch group admins` | error | |

### Member / metadata (all fire-and-forget, warn on failure only)
| Message | Level | |
|---|---|---|
| `member touch failed`, `push name update failed`, `phone share update failed` | warn | |
| `group participants update` | **debug** | joins/leaves |
| `group message (discovery mode)` | info | only when `GROUP_JID` unset |
| `wa event` | **debug** | only when `LOG_EVENTS=1` |

---

## What is NOT logged

Remaining silent paths — none block backfill:

1. **Non-group and other-group messages** are silently skipped (expected).
2. **`skipped non-beer message` truncates the caption to 200 chars**, so very long
   non-beer text is only partially recorded (the number is what matters, so fine).

The former backfill gaps — no raw text, no message id at `info`, caption-less media
invisible, discarded held beers silent — are now **closed** (see below).

---

## Backfill tuning — implemented

Logs at the default `info` level are now enough to replay a mistake, without the `debug`
firehose:

- ✅ **`beer recorded` now logs `id` + full `text`** — every recorded beer is traceable to
  its WhatsApp message and exact caption at `info`.
- ✅ **Every non-beer message is logged** (incl. caption-less media, with `kind` + `id`) —
  a beer photo posted without a number is no longer invisible.
- ✅ **Discarded held beers are logged** (`held beer discarded …`) — a wrongly-dropped
  ran-ahead value can be spotted and backfilled by hand.
- **Keep `BAILEYS_LOG_LEVEL=warn`** — Baileys `debug`/`trace` is noise that buries the beer
  events and churns the journal; it doesn't help backfill.
- **Leave `LOG_LEVEL=info`** for normal running; flip to `debug` only when actively
  debugging.
