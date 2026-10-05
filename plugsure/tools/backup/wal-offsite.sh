#!/usr/bin/env bash
# PlugSure — every few minutes (plugsure-wal-offsite.timer): check that WAL
# archiving is working, then copy the WAL archive off the host.
#
# Archived WAL on the database's own disk protects against a bad migration or a
# mistaken DELETE, not against losing the VM. The off-host copy bounds what a
# lost host costs to archive_timeout (5 min) + this timer's period (5 min).
#
#   1. pg_stat_archiver: fail when the last archive attempt failed (archive_command
#      keeps failing → nothing new is protected AND pg_wal fills the disk).
#   2. WAL_OFFSITE_CMD, e.g.
#        aws s3 sync "$WAL_ARCHIVE_DIR" s3://<bucket>/plugsure-pitr/wal/ --only-show-errors
#        rclone copy "$WAL_ARCHIVE_DIR" offsite:plugsure-pitr/wal
#      (copy/sync WITHOUT --delete: retention is pg-basebackup.sh's job, and a
#      bucket lifecycle rule's off site.)
#
# Runs as the postgres OS user (local socket, peer auth), or with
# BASEBACKUP_DATABASE_URL. Environment from /etc/plugsure/pitr.env.
set -euo pipefail

PITR_DIR="${PITR_DIR:-/var/backups/plugsure-pitr}"
WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-$PITR_DIR/wal}"
log() { printf '%s wal-offsite: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

conn=()
[ -n "${BASEBACKUP_DATABASE_URL:-}" ] && conn=("$BASEBACKUP_DATABASE_URL")
state="$(psql "${conn[@]}" -X -At -F '|' -c \
  "SELECT current_setting('archive_mode'), archived_count, failed_count,
          COALESCE(last_archived_wal, '-'),
          (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))
     FROM pg_stat_archiver")"
IFS='|' read -r mode archived failed last failing <<< "$state"
if [ "$mode" != "on" ] && [ "$mode" != "always" ]; then
  log "archive_mode is '$mode': WAL is NOT being archived (deploy/pitr/postgresql-pitr.conf)"
  exit 1
fi
if [ "$failing" = "t" ]; then
  log "archiving is FAILING (failed_count=$failed, last archived $last) — see the PostgreSQL log"
  exit 1
fi

if [ -n "${WAL_OFFSITE_CMD:-}" ]; then
  export WAL_ARCHIVE_DIR PITR_DIR
  bash -c "$WAL_OFFSITE_CMD"
  log "archived=$archived last=$last; copied off host"
else
  log "archived=$archived last=$last; WAL_OFFSITE_CMD not set — the archive is on this host only"
fi
