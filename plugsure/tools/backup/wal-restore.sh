#!/usr/bin/env bash
# PlugSure — PostgreSQL restore_command for point-in-time recovery: fetch one WAL
# segment (or timeline history file) from the archive written by wal-archive.sh.
#
#   restore_command = '/opt/plugsure/tools/backup/wal-restore.sh %f %p'
#
# Exit non-zero when the file is not in the archive: that is how recovery learns
# it has reached the end of the archived WAL (PostgreSQL asks for files that do
# not exist yet, e.g. the next timeline's history; "not found" is normal there).
#
# Environment: WAL_ARCHIVE_DIR (default /var/backups/plugsure-pitr/wal) — for a
# restore from the off-site copy, sync it back to a local directory first and
# point this at it (deploy/pitr/RESTORE.md).
set -euo pipefail

name="${1:?usage: wal-restore.sh %f %p}"
dest="${2:?usage: wal-restore.sh %f %p}"
dir="${WAL_ARCHIVE_DIR:-/var/backups/plugsure-pitr/wal}"

case "$name" in
  */*|.*|'') exit 1 ;;
esac
[ -f "$dir/$name.gz" ] || exit 1
gzip -dc "$dir/$name.gz" > "$dest.tmp"
mv "$dest.tmp" "$dest"
