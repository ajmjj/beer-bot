#!/usr/bin/env bash
# Recover from a WhatsApp session logout — the healthchecks.io alert body reads
# something like "WhatsApp disconnected: loggedOut (code 401) — Stream Errored
# (conflict)". That means WhatsApp itself killed the linked-device session (device
# limit hit, unlinked from the phone, or a real conflicting connection); bot.js
# deliberately does NOT auto-reconnect in that case since the session is dead —
# it needs a fresh QR/pairing link. Run this ON THE VPS as the deploy user.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(id -un)" == "root" ]]; then
  echo "Run this as the deploy user, not root (see DEPLOY.md)." >&2
  exit 1
fi

if [[ ! -d .baileys_auth ]]; then
  echo "No .baileys_auth here — is this /home/deploy/beer-bot?" >&2
  exit 1
fi

echo "Stopping beer-bot..."
sudo systemctl stop beer-bot

backup=".baileys_auth.bak-$(date +%Y%m%d%H%M%S)"
mv .baileys_auth "$backup"
echo "Archived dead session to $backup (safe to delete once the new one is confirmed working)."

echo "Starting beer-bot — watch below for the QR code and scan it in WhatsApp -> Linked Devices."
echo "(Ctrl-C once you see \"connected\" — the service keeps running after you detach.)"
sudo systemctl start beer-bot
journalctl -u beer-bot -f
