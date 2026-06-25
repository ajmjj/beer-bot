# beer-bot

Live WhatsApp beer tracking for the "One Million Beers" (OMB) group.

People post a photo with a number as the caption — their running count toward a
million beers. A read-only WhatsApp listener parses those numbers into Supabase
(Postgres), and a static webpage reads that table to show leaderboards.

```
photo "6" in group → Baileys → src/bot.js → parseBeer → "6"
  → src/store.js upsert (unique beer_number) → Supabase `beers` table
  → docs/app.js reads view → leaderboard website
```

Two trust levels: the bot uses the **secret** Supabase key (writes); the website
uses the **publishable** key (reads, gated by row-level security).

## The pieces

| File | Role |
|------|------|
| [src/bot.js](src/bot.js) | Live WhatsApp listener (Baileys). Watches the group, handles new messages, edits, and deletes. |
| [src/parser.js](src/parser.js) | Source-agnostic parsing — defines what counts as a valid beer. `npm test` runs its self-check. |
| [src/store.js](src/store.js) | Supabase writer. Idempotent upserts keyed on `beer_number`. |
| [schema.sql](schema.sql) | Postgres schema: `beers` + `deleted_beers` tables, `mask_phone` function, leaderboard views, RLS (public read only). |
| [scripts/](scripts/) | One-offs: `backfill.js` (import a chat export), `gaps.js` (missing numbers), `mismatches.js` (attribution audit), `insert-beer.js` (manually insert a missed beer). |
| [docs/](docs/) | Static leaderboard site (GitHub Pages). |

## How it works

**What counts as a beer** ([parser.js](src/parser.js)): a message whose caption,
after cleaning, is *purely digits*. Cleaning strips WhatsApp's invisible Unicode
marks, `<attached: …>` tags, and "image/video/GIF omitted" placeholders — so
`6 <attached: x.jpg>` → `6`, but `Mit 28 members…` → ignored. Phone-number
senders get their middle digits masked before storage; display names pass through.

**Dedup** ([store.js](src/store.js)): `beer_number` is the unique key, first
writer wins (`onConflict + ignoreDuplicates`). Reruns and reconnect catch-up
never double-count.

**The listener** ([bot.js](src/bot.js)):
- Connects as a WhatsApp "linked device" (same mechanism as WhatsApp Web). Auth
  is cached in `.baileys_auth/`, so it stays logged in across restarts.
- Only watches the group in `GROUP_JID`. With that unset it runs in **discovery
  mode** and prints the JIDs of any group it sees, so you can pick one.
- Handles three event kinds: a normal message (insert a beer), a **revoke**
  (delete-for-everyone → remove the beer, logging who deleted it and whether they
  were an admin), and a **message edit** (re-parse and update/insert/delete).
- On reconnect it runs a **startup audit**: loads the last 10 tracked beers from
  the DB, then cross-checks them against the history the server sends back.
  Beers posted while offline are inserted (`[startup] caught up beer #N`);
  beers deleted while offline are removed (`[startup] removed beer #N`); offline
  edits are corrected. Logged with `[startup]`.

## Setup

Requires Node ≥ 22.

```bash
npm install
```

Create a `.env`:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<service/secret key — write access>
GROUP_JID=<the group's …@g.us id>   # omit to run discovery mode first
PAIR_NUMBER=491701234567            # optional: pairing-code login instead of QR
LOG_LEVEL=warn                      # optional
```

Run [schema.sql](schema.sql) against your Supabase project (see the header in
that file for fresh-install vs. existing-database notes).

## Running

```bash
npm run bot          # start the live listener
npm test             # parser self-check
npm run backfill     # import chat_exports/_chat.txt into Supabase (one-time)
npm run gaps         # report missing beer numbers
npm run mismatches   # audit beer→member attribution
node scripts/insert-beer.js <n> <member> <iso_ts> [participant]  # manually insert a missed beer
```

First run, the bot prints a QR code (or a pairing code if `PAIR_NUMBER` is set) —
link it under WhatsApp → Linked Devices. If `GROUP_JID` is unset, it logs the
groups it sees; copy the right `…@g.us` JID into `.env` and restart.

The website ([docs/](docs/)) is a static site served via GitHub Pages; it reads
Supabase directly using the publishable key in [docs/config.js](docs/config.js).
