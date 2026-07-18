#!/usr/bin/env bash
# Nightly /data backup (plans/08 §5): tar the eduagent-data volume to
# $BACKUP_DIR, keep the newest $KEEP. Runs 30 min after the Alex reset
# (cron/crontab.example) so SQLite is quiet; provider snapshots are the
# second copy — take a manual one before recording day and before submission.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/eduagent}"
KEEP="${KEEP:-7}"
# compose project "eduagent" + volume "eduagent-data" → docker volume name:
VOLUME="${VOLUME:-eduagent_eduagent-data}"

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)

docker run --rm \
  -v "$VOLUME":/data:ro \
  -v "$BACKUP_DIR":/backup \
  debian:bookworm-slim \
  tar czf "/backup/eduagent-data-$stamp.tar.gz" -C / data

ls -1t "$BACKUP_DIR"/eduagent-data-*.tar.gz | tail -n "+$((KEEP + 1))" | xargs -r rm -f
echo "backup written: $BACKUP_DIR/eduagent-data-$stamp.tar.gz (keeping newest $KEEP)"
