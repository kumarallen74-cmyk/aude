# PlugSure — continuous WAL archiving and point-in-time recovery (PITR)

Added in v1.5.1. Read with deploy/README.md §7 "Backups and restore rehearsal".

The nightly `pg_dump` (tools/backup/pg-backup.sh) can lose up to a day: every
session, payment, refund and hold since 02:15. With continuous archiving the
database can be restored to **any moment** — e.g. one minute before a bad
migration or a mistaken `DELETE` — losing at most `archive_timeout` (5 min) on
the host, or about 10 minutes if the host itself is lost (the off-host copy runs
every 5 minutes).

It uses only PostgreSQL's own tools (`pg_basebackup`, `pg_verifybackup`,
`pg_archivecleanup`), `gzip` and bash: nothing to install beyond
`postgresql-16` / `postgresql-client-16`, plus whatever copies files off the host
(`aws` CLI, `rclone`, …). Keep the nightly `pg_dump` too: it is the portable copy,
restorable into another major version and table by table.

| Piece | File | What it does |
|---|---|---|
| PostgreSQL settings | `deploy/pitr/postgresql-pitr.conf` | `archive_mode=on`, `archive_command`, `archive_timeout=300` |
| archive_command | `tools/backup/wal-archive.sh` | each finished WAL segment → `/var/backups/plugsure-pitr/wal/<segment>.gz` (fsynced; refuses to overwrite a different file) |
| restore_command | `tools/backup/wal-restore.sh` | the reverse, during recovery |
| weekly base backup | `tools/backup/pg-basebackup.sh`, `deploy/plugsure-basebackup.{service,timer}` | `pg_basebackup` → `pg_verifybackup` → `base/base-<stamp>.tar.gz` + SHA-256 → off-host copy → retention |
| archive check + off-host copy | `tools/backup/wal-offsite.sh`, `deploy/plugsure-wal-offsite.{service,timer}` | every 5 min: fails if archiving is off or failing, then runs `WAL_OFFSITE_CMD` |

**Retention.** `BASEBACKUP_KEEP` base backups (default 4, weekly → about four
weeks of PITR window). After each SUCCESSFUL base backup the older ones are
deleted, and so is archived WAL older than the oldest base backup kept
(`pg_archivecleanup`). Nothing is deleted after a failure. Off the host, copy
without `--delete` and set the bucket's own lifecycle rule (e.g. expire after
35 days) — and turn on object versioning or object lock, so a compromised host
cannot erase the off-site copy.

**Disk.** Budget for `BASEBACKUP_KEEP + 1` compressed base backups plus four
weeks of compressed WAL in `/var/backups/plugsure-pitr`. A pilot database of a
few GB needs a few tens of GB. Put it on a different disk from the data
directory if you can.

---

## 1. Set up (Path B: PostgreSQL 16 on the VM, Debian/Ubuntu layout)

```bash
# Scripts and units (from the release checkout in /opt/plugsure)
sudo install -o root -g root -m 0755 tools/backup/pg-basebackup.sh tools/backup/wal-archive.sh \
     tools/backup/wal-restore.sh tools/backup/wal-offsite.sh /opt/plugsure/tools/backup/
sudo install -o root -g root -m 0644 deploy/plugsure-basebackup.service deploy/plugsure-basebackup.timer \
     deploy/plugsure-wal-offsite.service deploy/plugsure-wal-offsite.timer /etc/systemd/system/

# Archive directories, owned by the postgres OS user (archive_command runs as postgres)
sudo install -d -o postgres -g postgres -m 0700 /var/backups/plugsure-pitr \
     /var/backups/plugsure-pitr/wal /var/backups/plugsure-pitr/base

# Settings, root-only (they may hold cloud credentials / commands)
sudo install -o root -g root -m 0600 /dev/null /etc/plugsure/pitr.env
sudoedit /etc/plugsure/pitr.env
#   BASEBACKUP_KEEP=4
#   BACKUP_OFFSITE_CMD=aws s3 sync "$PITR_DIR/base" s3://<bucket>/plugsure-pitr/base/ --only-show-errors
#   WAL_OFFSITE_CMD=aws s3 sync "$WAL_ARCHIVE_DIR" s3://<bucket>/plugsure-pitr/wal/ --only-show-errors
# (the postgres OS user needs credentials for the bucket: an EC2 instance role is best)

# Turn archiving on — needs a RESTART of PostgreSQL (brief: the gateway and API
# reconnect on their own; do it off-peak)
sudo install -o root -g root -m 0644 deploy/pitr/postgresql-pitr.conf /etc/postgresql/16/main/conf.d/plugsure-pitr.conf
sudo systemctl restart postgresql

# Archiving works?
sudo -u postgres psql -c "select pg_switch_wal()"
sleep 5; ls -l /var/backups/plugsure-pitr/wal
sudo -u postgres psql -c "select archived_count, failed_count, last_archived_wal, last_failed_wal from pg_stat_archiver"

# Timers, and the FIRST base backup now (point-in-time recovery starts from it)
sudo systemctl daemon-reload
sudo systemctl enable --now plugsure-basebackup.timer plugsure-wal-offsite.timer
sudo systemctl start plugsure-basebackup && journalctl -u plugsure-basebackup -n 20
sudo systemctl start plugsure-wal-offsite && journalctl -u plugsure-wal-offsite -n 5
```

**Monitor** (wire these into whatever pages you; `systemctl --failed` lists both):

- `plugsure-wal-offsite.service` failed → archiving is off or `archive_command`
  is failing. Urgent: PostgreSQL keeps every unarchived segment in `pg_wal` and
  stops when the disk fills.
- `plugsure-basebackup.service` failed, or the newest `base-*.tar.gz` older than
  8 days.
- `df /var/backups/plugsure-pitr` and the data disk.

## 2. Restore to a point in time

Use this for "undo the last N minutes" (a bad migration, a mistaken bulk
change) or to rebuild a lost host. Decide the **target time** first — e.g.
from the audit log or the API log: the last good moment, in UTC or with an
explicit offset.

Rehearse on a scratch instance first (§3) if there is any time: it proves the
chosen base backup and target before the real cluster is touched.

```bash
TARGET='2026-10-02 16:12:23+00'                  # the last good moment
PITR=/var/backups/plugsure-pitr
D=/var/lib/postgresql/16/main                    # the cluster's data directory

# 0. Stop the writers.
sudo systemctl stop plugsure-gateway plugsure-api

# 1. Lost host only: bring the off-site copy back first, e.g.
#    aws s3 sync s3://<bucket>/plugsure-pitr/ $PITR/ && sudo chown -R postgres:postgres $PITR
#    (on a NEW host: install PostgreSQL 16 and the §1 conf.d file first.)

# 2. Stop PostgreSQL and move the current data directory ASIDE. Never delete it
#    until the restore is accepted: it still holds the WAL written after the last
#    archived segment.
sudo systemctl stop postgresql
sudo mv $D $D.before-restore-$(date -u +%Y%m%dT%H%M%SZ)

# 3. The newest base backup taken BEFORE the target time (stamps are UTC), verified.
cd $PITR/base && ls -1 base-*.tar.gz
B=base-<stamp>
sha256sum -c $B.sha256
sudo install -d -o postgres -g postgres -m 0700 $D
sudo -u postgres tar -xzf $B.tar.gz -C $D

# 4. Recovery settings: fetch archived WAL, stop at the target, then promote.
printf '%s\n' \
  "restore_command = '/opt/plugsure/tools/backup/wal-restore.sh %f %p'" \
  "recovery_target_time = '$TARGET'" \
  "recovery_target_action = 'promote'" \
  | sudo tee /etc/postgresql/16/main/conf.d/zz-recovery.conf
sudo -u postgres touch $D/recovery.signal
sudo systemctl start postgresql
sudo grep -E "restored log file|recovery stopping|archive recovery complete" /var/log/postgresql/postgresql-16-main.log
#   "restored log file … from archive" … "recovery stopping before commit of
#   transaction …, time …" … "archive recovery complete"

# 5. Recovery done: remove the recovery settings (ignored once promoted, but they
#    would mislead the next restore). PostgreSQL is now on a new timeline and keeps
#    archiving into the same archive. Take a NEW base backup at once.
sudo rm /etc/postgresql/16/main/conf.d/zz-recovery.conf && sudo systemctl reload postgresql
sudo systemctl start plugsure-basebackup

# 6. Check it, then start the apps (gateway first: chargers reconnect).
sudo -u postgres psql plugsure -c "select max(name) from schema_migration"
sudo -u postgres psql plugsure -c "select count(*), max(started_at) from charging_session"
sudo -u postgres psql plugsure -c "select has_table_privilege('plugsure_app','charging_session','SELECT')"
sudo systemctl start plugsure-gateway plugsure-api
```

Notes:

- A physical backup is the whole cluster: roles (`plugsure`, `plugsure_app`) and
  their passwords come back with it, unlike `pg_dump`. The same PostgreSQL MAJOR
  version (16) is required.
- `AUDIT_HMAC_KEY` and `SECRETS_KEY` are not in any backup. Without the original
  `SECRETS_KEY` every sealed provider credential is lost; keep them in a secrets
  store, apart from the backups.
- Without `recovery_target_time` recovery replays everything archived: that is
  "rebuild the lost host as late as possible".
- Charger transactions that happened after the target time are gone from the
  database. Chargers will send `StopTransaction` / `TransactionEvent` for
  sessions PlugSure no longer knows: review them (Sessions, and the OCPP frame log).
  Payment providers' records (QRIS, e-wallets) are authoritative for money taken
  in that window: reconcile against their dashboards.
- `FILE STORAGE` (firmware images, diagnostics) is not in PostgreSQL: restore it
  from the nightly `plugsure-storage-*.tar.gz` (deploy/README.md §7).

## 2a. After any restore: the runtime role's `app.rls_bypass` default (v1.7.0)

Migration 048 (row-level security fails closed) gives the runtime role a
**per-database** default, as the migration owner:

```sql
ALTER ROLE plugsure_app IN DATABASE <the database> SET app.rls_bypass = 'on';
```

It lives in the cluster-wide catalog `pg_db_role_setting`, not in the database.

- **Physical restore / PITR (§2, §3):** the base backup is the whole cluster, so
  the setting comes back with it. Check it anyway (below).
- **Logical restore (`pg_restore` of the nightly `pg_dump`, deploy/README.md §7,
  a copy for a rehearsal or a new host): `pg_restore` does NOT restore it** (the
  dump holds the database's objects, not role settings; found in the v1.7.0
  migration rehearsal). Connections that bypass the application pool — the API's
  LISTEN connection, `psql` as `plugsure_app`, the e2e fixtures — then see **no
  tenant rows**: every RLS-protected table reads as empty. The pool itself sets
  the bypass per connection, but do not rely on that: re-apply it.

Re-apply it **after `pg_restore` and before starting the apps**, as `postgres` (or
the migration owner, which has `CREATEROLE`), naming the restored database:

```bash
DB=plugsure_restore                              # the database you restored into
sudo -u postgres psql -d "$DB" -c "ALTER ROLE plugsure_app IN DATABASE \"$DB\" SET app.rls_bypass = 'on'"
# Check (also after a PITR): one row, {app.rls_bypass=on}
sudo -u postgres psql -d "$DB" -tAc "SELECT s.setconfig FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
  WHERE r.rolname = 'plugsure_app' AND d.datname = current_database()"
```

Verified on PostgreSQL 16 (v1.7.0, 2026-10-03): after `pg_dump -Fc` →
`pg_restore` into a new database the query above returned no row and
`plugsure_app` counted 0 sites; after the `ALTER ROLE` it returned
`{app.rls_bypass=on}` and `plugsure_app` counted all 7.

Renaming the database later (e.g. `plugsure_restore` → `plugsure`) keeps the
setting (it follows the database's OID). Dropping and re-creating the database
does not: run the command again.

## 3. Restore test (monthly, and after a PostgreSQL upgrade)

A backup that has never been restored is a hope. On the database host or a
scratch VM with PostgreSQL 16, restore the newest base backup plus WAL into a
**separate instance on another port**, to a recent time, and check it. Nothing
here touches the running cluster.

```bash
PITR=/var/backups/plugsure-pitr
T=/var/lib/postgresql/restore-test               # scratch; any disk with room
TARGET="$(date -u -d '-10 min' '+%F %T+00')"     # ten minutes ago
sudo install -d -o postgres -g postgres -m 0700 $T $T/data
cd $PITR/base && B=$(ls -1 base-*.tar.gz | sort | tail -n 1) && B=${B%.tar.gz}
sha256sum -c $B.sha256
sudo -u postgres tar -xzf $B.tar.gz -C $T/data
sudo -u postgres tee $T/data/postgresql.conf >/dev/null <<EOF
port = 5447
listen_addresses = '127.0.0.1'
unix_socket_directories = '/var/run/postgresql'
restore_command = 'WAL_ARCHIVE_DIR=$PITR/wal /opt/plugsure/tools/backup/wal-restore.sh %f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
archive_mode = off
EOF
printf 'local all all peer\nhost all all 127.0.0.1/32 scram-sha-256\n' | sudo -u postgres tee $T/data/pg_hba.conf >/dev/null
sudo -u postgres touch $T/data/recovery.signal
time sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D $T/data -l $T/restore.log -w start
grep -E "restored log file|recovery stopping|consistent|archive recovery complete" $T/restore.log
sudo -u postgres psql -p 5447 plugsure -c "select max(name) from schema_migration"
sudo -u postgres psql -p 5447 plugsure -c "select count(*), max(started_at) from charging_session"
#   max(started_at) should be close to $TARGET on a day with traffic
sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D $T/data -m fast -w stop
sudo rm -rf /var/lib/postgresql/restore-test      # a literal path, on purpose
```

Record: the base backup's age, how long the restore took (copy + replay — that
is the real recovery time), and the newest row you found. A restore that stops
with "requested recovery stop point is before consistent recovery point" means
the target is earlier than the base backup's end: pick an older base backup.

## 4. Proven on PostgreSQL 16.15 (v1.5.1, 2026-10-02)

Run on a throwaway cluster with the shipped scripts, archive_timeout 60:

```bash
# A cluster with archiving into a scratch archive
pg_createcluster 16 pitr5446 -p 5446
cat > /etc/postgresql/16/pitr5446/conf.d/plugsure-pitr.conf <<EOF
wal_level = replica
archive_mode = on
archive_command = 'WAL_ARCHIVE_DIR=/var/lib/postgresql/pitr-test-5446/wal /…/tools/backup/wal-archive.sh %p %f'
archive_timeout = 60
EOF
pg_ctlcluster 16 pitr5446 start
# The PlugSure schema and seed (migrations 001-054 → 53 rows in schema_migration)
DATABASE_URL=postgresql://postgres:…@127.0.0.1:5446/plugsure npm run migrate && npm run seed

# Base backup with the shipped script
sudo -u postgres env PITR_DIR=/var/lib/postgresql/pitr-test-5446 BASEBACKUP_DATABASE_URL="port=5446" \
     tools/backup/pg-basebackup.sh
#   pg-basebackup: base backup to …/base/base-20261002T161210Z.tar.gz
#   pg-basebackup: verifying against the manifest
#   pg-basebackup: removing archived WAL older than 000000010000000000000004
#   pg-basebackup: done: 4.5M, WAL from 000000010000000000000004

# Writes after the base backup, the target time, then "the accident"
psql … -c "CREATE TABLE pitr_marker (id int primary key, note text)" \
       -c "INSERT INTO pitr_marker VALUES (1,'before the accident'),(2,'also before')"
TARGET=$(psql … -Atc "select clock_timestamp()")      # 2026-10-02 16:12:23.4917+00
psql … -c "INSERT INTO pitr_marker VALUES (3,'after target')" -c "TRUNCATE pitr_marker" -c "select pg_switch_wal()"

# Restore into a NEW data directory on port 5447 (the §3 procedure)
#   LOG:  starting backup recovery with redo LSN 0/4000028 …
#   LOG:  restored log file "000000010000000000000004" from archive
#   LOG:  restored log file "000000010000000000000005" from archive
#   LOG:  consistent recovery state reached at 0/4000138
#   LOG:  recovery stopping before commit of transaction 844, time 2026-10-02 16:12:25.586319+00
#   LOG:  archive recovery complete
psql -p 5447 … -c "select id, note from pitr_marker"   # 1 before the accident / 2 also before
psql -p 5447 … -Atc "select pg_is_in_recovery()"        # f (promoted)
psql -p 5447 … -Atc "select count(*) from schema_migration"   # 53
psql -p 5447 … -Atc "select rolname from pg_roles where rolname='plugsure_app'"   # plugsure_app

# The archive check: archive_command set to /bin/false, a segment switched
sudo -u postgres env BASEBACKUP_DATABASE_URL="port=5446" tools/backup/wal-offsite.sh
#   wal-offsite: archiving is FAILING (failed_count=3, last archived 000000010000000000000005)  → exit 1
# … and after resetting archive_command:
#   wal-offsite: archived=8 last=000000010000000000000006; WAL_OFFSITE_CMD not set …            → exit 0

# wal-archive.sh / wal-restore.sh edge cases
#   same segment archived twice with identical content → exit 0 (PostgreSQL's retry after a crash)
#   a DIFFERENT file under an archived name             → exit 1 "is another cluster archiving here?"
#   a file name with a path ("../evil")                 → exit 1
#   restore of a file not in the archive (a timeline history PostgreSQL probes for) → exit 1
```

Not proven here: the off-site copy itself (`WAL_OFFSITE_CMD` / `BACKUP_OFFSITE_CMD`
need a real bucket and credentials) and §2 under systemd (the in-place swap; the
recovery itself is the one proven above). Rehearse both on the pilot VM's staging copy before relying
on them.

## 5. Other deployments

**Docker Compose (Path A).** The `postgres` service needs the archive on a
volume and the settings on its command line, e.g. in a `docker-compose.override.yml`:

```yaml
services:
  postgres:
    command: >-
      postgres -c wal_level=replica -c archive_mode=on -c archive_timeout=300
      -c archive_command='/opt/plugsure-backup/wal-archive.sh %p %f'
    environment:
      WAL_ARCHIVE_DIR: /var/backups/plugsure-pitr/wal
    volumes:
      - ./tools/backup:/opt/plugsure-backup:ro
      - /var/backups/plugsure-pitr:/var/backups/plugsure-pitr
```

(the official image runs PostgreSQL as uid 999: `chown -R 999:999
/var/backups/plugsure-pitr` on the host). Run `pg-basebackup.sh` and
`wal-offsite.sh` with `docker compose exec -u postgres postgres …` from host
cron/timers, with the scripts mounted as above.

**Amazon RDS / managed PostgreSQL.** Do not use these scripts: turn on the
provider's automated backups (RDS: backup retention ≥ 7 days gives
point-in-time restore to any second in the window) and rehearse its
"restore to point in time" into a new instance. Keep the nightly `pg_dump`
(to a bucket in another account) as the portable copy.
