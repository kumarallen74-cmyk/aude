#!/usr/bin/env bash
# PlugSure — weekly base backup for point-in-time recovery (PITR).
#
# A base backup is a physical copy of the whole cluster; with the WAL archived
# since (wal-archive.sh) it can be rolled forward to ANY moment up to the last
# archived segment — e.g. to one minute before a bad migration or a mistaken
# DELETE. The nightly pg_dump (pg-backup.sh) stays: it is the portable,
# version-independent copy, and the one to use for a single table.
#
#   1. pg_basebackup -Fp -Xs  (plain format, with the WAL needed to be consistent)
#   2. pg_verifybackup        (every file against the backup manifest, and the WAL)
#   3. tar.gz + SHA-256       (base-<stamp>.tar.gz, base-<stamp>.sha256)
#   4. BACKUP_OFFSITE_CMD     (optional off-host copy)
#   5. retention, ONLY after all of the above succeeded: keep the newest
#      BASEBACKUP_KEEP base backups (default 4 = four weeks of PITR window), and
#      delete archived WAL older than the oldest one kept (pg_archivecleanup).
#
# Runs as the postgres OS user on the database host (local socket, peer auth),
# or with BASEBACKUP_DATABASE_URL naming a role with REPLICATION.
#
# Environment (systemd: /etc/plugsure/pitr.env via deploy/plugsure-basebackup.service):
#   PITR_DIR                 default /var/backups/plugsure-pitr  (base/ and wal/ under it)
#   WAL_ARCHIVE_DIR          default $PITR_DIR/wal (must match archive_command)
#   BASEBACKUP_DATABASE_URL  optional; default: the local socket as the current user
#   BASEBACKUP_KEEP          default 4
#   BACKUP_OFFSITE_CMD       optional, run with PITR_DIR exported, e.g.
#                            'aws s3 sync "$PITR_DIR/base" s3://<bucket>/plugsure-pitr/base/ --only-show-errors'
#
# Exit status is non-zero on any failure (the unit then shows "failed"; alert on it).
set -euo pipefail
umask 077

PITR_DIR="${PITR_DIR:-/var/backups/plugsure-pitr}"
WAL_ARCHIVE_DIR="${WAL_ARCHIVE_DIR:-$PITR_DIR/wal}"
BASEBACKUP_KEEP="${BASEBACKUP_KEEP:-4}"
base_dir="$PITR_DIR/base"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$base_dir/.base-$stamp.partial"
archive="$base_dir/base-$stamp.tar.gz"

log() { printf '%s pg-basebackup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
cleanup() { rm -rf "$work" "$archive.partial"; }
trap cleanup EXIT

mkdir -p "$base_dir" "$WAL_ARCHIVE_DIR"
# Debian/Ubuntu put only some PostgreSQL tools on PATH (pg_verifybackup and
# pg_archivecleanup may live only in /usr/lib/postgresql/<major>/bin).
# PG_BINDIR overrides; otherwise the newest installed major version's bin is appended.
if [ -n "${PG_BINDIR:-}" ]; then
  PATH="$PG_BINDIR:$PATH"
elif ! command -v pg_verifybackup >/dev/null 2>&1; then
  newest="$(ls -1d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)"
  [ -n "$newest" ] && PATH="$PATH:$newest"
fi
conn=()
[ -n "${BASEBACKUP_DATABASE_URL:-}" ] && conn=(--dbname="$BASEBACKUP_DATABASE_URL")

log "base backup to $archive"
# --checkpoint=fast: start now rather than at the next scheduled checkpoint.
pg_basebackup "${conn[@]}" --pgdata="$work" --format=plain --wal-method=stream \
  --checkpoint=fast --label="plugsure-$stamp" --no-password

log "verifying against the manifest"
pg_verifybackup --quiet "$work"

# The WAL segment this backup starts in: the oldest archived WAL it can need.
start_wal="$(sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]\{24\}\))$/\1/p' "$work/backup_label")"
[ -n "$start_wal" ] || { log "no START WAL LOCATION in backup_label"; exit 1; }

tar --create --gzip --file="$archive.partial" --directory="$work" .
mv "$archive.partial" "$archive"
printf '%s\n' "$start_wal" > "$base_dir/base-$stamp.startwal"
( cd "$base_dir" && sha256sum "base-$stamp.tar.gz" "base-$stamp.startwal" > "base-$stamp.sha256" )
rm -rf "$work"

if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  log "copying off host"
  export PITR_DIR
  bash -c "$BACKUP_OFFSITE_CMD"
fi

# ---- retention (only after success) --------------------------------------------
mapfile -t bases < <(cd "$base_dir" && ls -1 base-*.tar.gz 2>/dev/null | sort -r)
if [ "${#bases[@]}" -gt "$BASEBACKUP_KEEP" ]; then
  for old in "${bases[@]:$BASEBACKUP_KEEP}"; do
    s="${old#base-}"; s="${s%.tar.gz}"
    log "removing old base backup $old"
    rm -f "$base_dir/base-$s.tar.gz" "$base_dir/base-$s.sha256" "$base_dir/base-$s.startwal"
  done
fi
oldest="$(cd "$base_dir" && ls -1 base-*.startwal 2>/dev/null | sort | head -n 1)"
if [ -n "$oldest" ]; then
  keep_from="$(cat "$base_dir/$oldest")"
  # Removes archived WAL segments older than keep_from (history files are kept).
  log "removing archived WAL older than $keep_from"
  pg_archivecleanup -x .gz "$WAL_ARCHIVE_DIR" "$keep_from"
fi

log "done: $(du -h "$archive" | cut -f1), WAL from $start_wal"
