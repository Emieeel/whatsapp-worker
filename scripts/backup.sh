#!/usr/bin/env bash
# Back up the database (consistent online copy) and auth/ into one tarball.
# Usage: scripts/backup.sh [backup-dir]   (default: ./backups, keeps the newest $KEEP, default 14)
# Cron example (daily 04:00): 0 4 * * * /opt/whatsapp-score-bot/scripts/backup.sh >> /tmp/bot-backup.log 2>&1
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
DEST="${1:-./backups}"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"

if command -v docker >/dev/null && [ -n "$(docker compose ps -q --status running bot 2>/dev/null)" ]; then
  # Copy via docker: the volumes belong to the container user (uid 1000), not necessarily to you.
  docker compose exec -T bot node dist/cli.js backup /tmp/backup.db
  docker compose cp bot:/tmp/backup.db "$TMP/scores.db"
  docker compose exec -T bot rm -f /tmp/backup.db
  docker compose cp bot:/app/auth "$TMP/auth"
else
  node dist/cli.js backup "$TMP/scores.db"
  cp -a auth "$TMP/auth"
fi

tar -czf "$DEST/whatsapp-bot-$STAMP.tar.gz" -C "$TMP" scores.db auth
echo "Backup written: $DEST/whatsapp-bot-$STAMP.tar.gz"
ls -1t "$DEST"/whatsapp-bot-*.tar.gz | tail -n +"$((KEEP + 1))" | xargs -r rm --
