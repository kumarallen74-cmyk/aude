#!/usr/bin/env bash
# PlugSure — PostgreSQL archive_command: copy one finished WAL segment into the
# local WAL archive, compressed. Continuous archiving + the weekly base backup
# (pg-basebackup.sh) give point-in-time recovery: the nightly pg_dump alone can
# lose up to a day of sessions, payments and refunds.
#
# postgresql.conf (deploy/pitr/postgresql-pitr.conf):
#   archive_command = '/opt/plugsure/tools/backup/wal-archive.sh %p %f'
#
# Runs as the postgres OS user, from the data directory, once per segment. The
# contract with PostgreSQL:
#   exit 0  ONLY when the segment is durably stored: PostgreSQL may then recycle it.
#   exit ≠0 PostgreSQL keeps the segment and retries (pg_wal grows meanwhile —
#           watch it: pg-wal-offsite.sh fails when archiving is failing).
#
# Written to a temporary file, fsynced, then renamed, so a crash never leaves a
# truncated segment under the final name. A segment that is already archived
# with IDENTICAL content is accepted (PostgreSQL retries after a crash between
# our rename and its bookkeeping); a DIFFERENT file under the same name is
# refused — that means two clusters archive into one directory, which would
# corrupt recovery.
#
# Environment: WAL_ARCHIVE_DIR (default /var/backups/plugsure-pitr/wal). Set it in
# archive_command itself if not the default:
#   archive_command = 'WAL_ARCHIVE_DIR=/srv/wal /opt/plugsure/tools/backup/wal-archive.sh %p %f'
set -euo pipefail
umask 077

src="${1:?usage: wal-archive.sh %p %f}"
name="${2:?usage: wal-archive.sh %p %f}"
dir="${WAL_ARCHIVE_DIR:-/var/backups/plugsure-pitr/wal}"
dest="$dir/$name.gz"

# Only WAL file names: never let an odd %f write outside the archive.
case "$name" in
  */*|.*|'') echo "wal-archive: refusing file name '$name'" >&2; exit 1 ;;
esac

if [ -e "$dest" ]; then
  if cmp -s <(gzip -dc "$dest") "$src"; then
    exit 0
  fi
  echo "wal-archive: $dest exists with DIFFERENT content — is another cluster archiving here? refusing" >&2
  exit 1
fi

tmp="$dir/.$name.gz.$$.tmp"
trap 'rm -f "$tmp"' EXIT
gzip -c -6 < "$src" > "$tmp"
# Durable before PostgreSQL may recycle the segment: the file, then the rename's directory entry.
sync "$tmp"
mv "$tmp" "$dest"
sync "$dir"
trap - EXIT
