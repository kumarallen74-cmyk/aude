#!/usr/bin/env bash
# PlugSure — nightly backup of the database and the file storage.
#
#   pg_dump -Fc   the whole database, custom format (compressed; pg_restore can
#                 restore it in parallel, or pick single tables out of it)
#   storage tar   STORAGE_DIR: uploaded firmware images and charger diagnostics
#                 logs. NOT in the database, so a database-only backup loses them.
#
# Files older than BACKUP_RETENTION_DAYS are removed after a SUCCESSFUL backup
# only, so a run of failures never deletes the last good copy.
#
# A backup on the same disk as the database is not a backup: copy BACKUP_DIR off
# the host (BACKUP_OFFSITE_CMD, e.g. an `aws s3 sync` or `rclone copy`), and
# rehearse a restore — see deploy/README.md §"Backups and restore rehearsal".
#
# Environment (systemd: /etc/plugsure/backup.env via deploy/plugsure-backup.service):
#   BACKUP_DATABASE_URL    owner or a role that can read every table (pg_dump
#                          needs to bypass row-level security: the owner, or a
#                          role with BYPASSRLS). NOT the plugsure_app role — under
#                          RLS it would dump only what an unscoped session sees.
#   BACKUP_DIR             default /var/backups/plugsure
#   STORAGE_DIR            default /var/lib/plugsure/storage ('' to skip)
#   BACKUP_RETENTION_DAYS  default 14
#   BACKUP_OFFSITE_CMD     optional; run after a successful backup, with
#                          BACKUP_DIR exported. e.g.
#                          'aws s3 sync "$BACKUP_DIR" s3://my-bucket/plugsure/ --only-show-errors'
#
# Exit status is non-zero on any failure (systemd then marks the unit failed;
# alert on it — `systemctl --failed`, or OnFailure= in the unit).
set -euo pipefail
umask 077

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL (owner connection string)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/plugsure}"
STORAGE_DIR="${STORAGE_DIR-/var/lib/plugsure/storage}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
db_file="$BACKUP_DIR/plugsure-db-$stamp.dump"
storage_file="$BACKUP_DIR/plugsure-storage-$stamp.tar.gz"

log() { printf '%s pg-backup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

cleanup_partial() {
  # A failed run must not leave a truncated file that looks like a backup.
  rm -f "$db_file.partial" "$storage_file.partial"
}
trap cleanup_partial EXIT

# ---- database ------------------------------------------------------------------
# --no-owner/--no-privileges are NOT used: a restore should recreate grants to
# plugsure_app exactly. Written to .partial and renamed only when complete.
log "dumping database to $db_file"
pg_dump --format=custom --compress=6 --no-password --file="$db_file.partial" "$BACKUP_DATABASE_URL"
# Proves the archive is readable (catalogue intact), cheaply.
pg_restore --list "$db_file.partial" > /dev/null
mv "$db_file.partial" "$db_file"

# ---- file storage --------------------------------------------------------------
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  log "archiving $STORAGE_DIR to $storage_file"
  tar --create --gzip --file="$storage_file.partial" \
      --directory="$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
  mv "$storage_file.partial" "$storage_file"
else
  log "no storage directory at '${STORAGE_DIR}'; skipped"
fi

# ---- checksums -----------------------------------------------------------------
( cd "$BACKUP_DIR" && sha256sum "$(basename "$db_file")" \
    $( [ -f "$storage_file" ] && basename "$storage_file" ) > "plugsure-$stamp.sha256" )

# ---- off-host copy -------------------------------------------------------------
if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  log "copying off host"
  export BACKUP_DIR
  bash -c "$BACKUP_OFFSITE_CMD"
fi

# ---- retention (only after success) --------------------------------------------
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'plugsure-db-*.dump' -o -name 'plugsure-storage-*.tar.gz' -o -name 'plugsure-*.sha256' \) \
  -mtime +"$BACKUP_RETENTION_DAYS" -print -delete | sed 's/^/pg-backup: removed old /' >&2

log "done: $(du -h "$db_file" | cut -f1) database$( [ -f "$storage_file" ] && echo ", $(du -h "$storage_file" | cut -f1) storage")"
