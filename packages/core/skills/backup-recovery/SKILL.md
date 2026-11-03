---
name: backup-recovery
description: "Backups and restore drills for PostgreSQL, MySQL, SQLite, volumes and buckets: pg_dump, WAL/PITR, restic, snapshots, RPO/RTO. Use when setting up or auditing backup jobs, proving a restore, planning point-in-time recovery or recovering deleted data into an isolated target. Not for schema changes (use database-migrations) or live outage triage (use incident-response)."
trigger: "Use when a request asks whether data can be restored: backup scripts, cron dumps, WAL archiving, snapshot policy, restore drills or lost-row recovery."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Backup Recovery

## Selection card
- Task: Design, audit or prove backups and restores for owned data stores.
- Start: Inventory the data stores, the jobs that claim to back them up and the date of the last restore drill; read the backup scripts and schedules.
- Finish: a backup was restored into an isolated target, counts and an application query match the source, and the measured RPO/RTO is reported.

## Overview

A backup is only a claim until it has been restored into an isolated target, timed and checked; exit codes, file sizes and green dashboards prove nothing.
Use the data engine/platform current supported backup and restore format. Checked PostgreSQL stable target: 18.6; verify tool/server compatibility and recovery semantics before database operations.
A recovery needs the whole set: data, roles and grants, encryption keys, configuration, and the object blobs that rows point to.

## Rules

1. Prove every backup by restoring it into a fresh, isolated target (new database name or scratch host/container, no production credentials) and checking counts, constraints and one real application query. Never "test" by restoring over a live database.
2. Replication, RAID, sync tools (`rsync --delete`, bucket replication) and unquiesced snapshots mirror deletes and corruption: they are availability, not backup. Keep point-in-time copies with retention.
3. Keep at least one copy off-host, under a different account or credential, and immutable or append-only (S3 Object Lock, restic/borg append-only repository) so a compromised host cannot delete its own backups.
4. Keep decryption keys and repository passwords outside the protected system and use them during the drill; a key that lived only on the lost host makes the backup worthless.
5. Back up what a restore needs, not only tables: PostgreSQL roles and grants (`pg_dumpall --globals-only`), extensions, config files, units/cron, and the blobs referenced by rows.
6. Never delete, prune, shorten retention or overwrite a live database without explicit step-specific authorization; snapshot current state before any restore that replaces it.
7. Report the RPO actually achieved (last good capture or WAL position) and the RTO measured in the drill, not the targets copied from a policy.
8. Dump with client tools at least as new as the server major (`pg_dump` refuses a newer server) and restore with the target's tools.

## First moves by situation

| Situation | First moves |
|---|---|
| "Do we have backups?" | `crontab -l`, `systemctl list-timers --all`, provider console/CLI; newest artifact age and size trend; date of the last restore drill (none = unproven) |
| Set up PostgreSQL backups | Size the DB and RPO; dumps give RPO = dump interval. For minutes of RPO use physical + WAL archiving (pgBackRest, WAL-G or `pg_basebackup` + `archive_command`) |
| Prove a restore | Scratch server or `docker run --rm -d postgres:<major>`; `pg_restore` into a new DB; counts, latest timestamps, app smoke query; time each step |
| Rows deleted by mistake | Do not restore over prod. Restore PITR or dump to a side instance just before the delete, extract rows, review, insert selectively |
| WAL archive failing, disk filling | `SELECT * FROM pg_stat_archiver;` (`failed_count`, `last_failed_wal`); fix the archive destination/credentials; never delete files from `pg_wal` by hand |
| SQLite application | `sqlite3 app.db ".backup '/backups/app.db'"` or `VACUUM INTO`; never copy a live WAL-mode file without its `-wal` file |
| Files and volumes | restic or borg: `restic snapshots`, `restic check --read-data-subset=5%`, restore to a temp dir and compare with `diff -r` |
| Managed cloud database | Read automated backup retention and PITR window; test restore-to-new-instance; check whether snapshots survive instance or account deletion |

## Patterns and pitfalls

- **Silent empty dump** — `pg_dump ... | gzip > f.gz` returns gzip's status; without `set -o pipefail` a failed connection writes a 20-byte file and a green job. Check `pg_restore --list` output and alert on size drops.
- **Parallel or atomic, not both** — `pg_restore -j N` (custom/directory formats) cannot be combined with `--single-transaction`. Pick speed or atomicity; use `--exit-on-error` either way.
- **Missing globals** — `pg_dump` covers one database without roles, passwords or tablespaces; restores fail on `role "app" does not exist`. Add `pg_dumpall --globals-only`, or restore with `--no-owner --no-privileges` and re-grant deliberately.
- **Consistency scope** — a `pg_dump` snapshot is consistent within one database only, never across databases or DB plus bucket. MySQL InnoDB needs `mysqldump --single-transaction --routines --triggers --events`.
- **Broken WAL chain** — PITR replays base backup plus every WAL segment; one gap stops recovery there. Check `pgbackrest check` and `pgbackrest info`, or `wal-g wal-verify integrity`. On restore set `recovery_target_time` and create `recovery.signal`.
- **Incremental base backups (PostgreSQL 17+)** — `pg_basebackup --incremental` needs `summarize_wal = on`, every parent in the chain, and `pg_combinebackup` before start. Validate with `pg_verifybackup`.
- **Crash-consistent snapshots** — an EBS/LVM/ZFS snapshot of a running DB is safe only if data and WAL sit in one atomic snapshot; multi-volume layouts need coordinated snapshots or a backup API.
- **Cross-store coherency** — bucket versioning or soft-delete retention must be at least the DB PITR window, or restored rows reference purged objects.
- **Retention typos** — `restic forget --prune` and lifecycle rules delete for real; preview with `restic forget --dry-run` and review prefixes before applying.
- **Restore time is not dump time** — a large logical restore rebuilds every index and can take hours; minute-level RTO needs physical backups, replicas or snapshots, measured.
- **Backups are sensitive data** — dumps contain secrets and PII; encrypt at rest, restrict repository credentials, and mask before non-production drills (hand off to data-governance).

## Workflow

1. Inventory stores, sizes, change rates and dependencies (DB ↔ blobs ↔ config ↔ keys) plus stated RPO/RTO.
2. Read each job end to end: command, pipefail and exit handling, destination, encryption, retention, alerts on failure and on staleness.
3. Choose or fix the method per store (logical, physical + WAL, snapshot, file-level) and its off-host immutable copy.
4. Restore into isolation and time every step.
5. Validate: row counts for critical tables, `max(created_at)` against the expected capture time, constraints and sequences, one application read/write.
6. Write the runbook with exact commands, observed RPO/RTO and gaps; schedule the next drill and a staleness alert.

## Proof

- Artifact: `pg_restore --list backup.dump | head`, `ls -lh`, `sha256sum -c backup.sha256`
- Restore: `createdb restore_check && pg_restore -d restore_check --no-owner --exit-on-error -j 4 backup.dump`
- Data: `psql -d restore_check -c "SELECT count(*), max(created_at) FROM orders;"` compared with the source at capture time
- PITR: start the scratch cluster with `recovery_target_time`, confirm `SELECT pg_is_in_recovery();`, then promote on the scratch host only
- Archiving: `SELECT archived_count, failed_count, last_archived_time FROM pg_stat_archiver;`
- Files: `restic restore latest --target /tmp/restore-check`, `restic check --read-data-subset=10%`, `borg check --verify-data`
- MySQL: load into a scratch schema, then compare counts and `CHECKSUM TABLE` for critical tables

## Stop and ask

- The restore target is, or could resolve to, a live database, or the drill needs production credentials.
- Any delete, prune, retention or lifecycle change, `pg_resetwal`, or manual WAL removal.
- A restore would overwrite newer data (prefer side restore plus selective copy).
- Keys or repository passwords are unavailable or held by someone else.
- Drill data contains PII and the target environment is not approved for it.

## Before returning

- [ ] Each protected store lists method, schedule, off-host/immutable location, retention and key custody
- [ ] Backup jobs fail loudly (pipefail, exit checks) and alert on staleness, not only on errors
- [ ] A restore into an isolated target ran end to end; commands and duration recorded
- [ ] Counts, latest timestamps, constraints/sequences and one application query checked on the restore
- [ ] Roles/globals, configuration and referenced blobs covered or listed as gaps
- [ ] Observed RPO (last good capture or WAL position) and measured RTO reported
- [ ] No live data, retention or existing backup changed without authorization; scratch targets removed

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[PostgreSQL backup](https://www.postgresql.org/docs/current/backup.html), [PostgreSQL versioning](https://www.postgresql.org/support/versioning/).

## Skills in scope

- database-migrations — design and verify schema migrations, bounded backfills and deployment compatibility for databases.
- data-governance — retention schedules, encryption key rotation, and PII handling in non-production restore drills.
- storage-uploads — implement owned file/object storage and upload/download flows with validated metadata, access and lifecycle.
- incident-response — data-loss or corruption incidents where recovery runs under outage pressure.
- database-development — queries used to validate restored data and to extract rows for selective repair.
