# Deploy

The bot runs 24/7 on a VPS as a systemd service (`beer-bot.service`) from a
git checkout at `/home/deploy/beer-bot`. Deploying an update = pull + restart.

> Host IP and SSH user are intentionally kept out of this file. Set `BEER_BOT_HOST`
> in your shell (e.g. `export BEER_BOT_HOST=deploy@<vps-ip>`) or just type the host.

## Update the bot

```bash
ssh "$BEER_BOT_HOST"                 # log in as the deploy user (never root)
cd /home/deploy/beer-bot
git pull
npm ci                               # only if package-lock.json changed
sudo systemctl restart beer-bot
systemctl status beer-bot --no-pager # confirm active (running)
```

Watch it reconnect:

```bash
journalctl -u beer-bot -f            # expect: "egress: <ip>" then "connected"
```

## Recovering from a WhatsApp logout

If healthchecks.io alerts with a body like
`WhatsApp disconnected: loggedOut (code 401) — Stream Errored (conflict)`,
that's not a crash — WhatsApp itself killed the linked-device session (device
limit hit, unlinked from the phone, or a genuine conflicting connection).
`bot.js` deliberately does not auto-reconnect in this case (a dead session
can't be resumed), so the service stays "active (running)" while doing
nothing until it's re-linked.

```bash
ssh "$BEER_BOT_HOST"
cd /home/deploy/beer-bot
./scripts/relink-whatsapp.sh   # stops the service, archives the dead session,
                                # restarts, and tails the log for the QR code
```

Scan the QR with the phone that owns the WhatsApp account (WhatsApp -> Linked
Devices). If it immediately gets logged out again, check that phone's Linked
Devices list isn't at the 4-device cap — remove an unused one first.

## Gotchas

- **Egress guard.** An `ExecStartPre` check refuses to start unless outbound
  traffic exits via the home WireGuard tunnel (i.e. the egress IP is *not* the
  VPS's own IP). If the service won't start, the tunnel is down — fix that
  first, it's not the code.
- **Don't SSH as root.** A system update once set `PermitRootLogin no` and it
  looked like a key problem. Use the `deploy` user + `sudo`.
- **Config lives in `.env`** on the VPS (not in git). No env changes are needed
  for a normal code update.
