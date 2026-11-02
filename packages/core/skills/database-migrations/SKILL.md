---
name: database-migrations
version: 1.1.0
description: "Schema migrations and backfills on PostgreSQL, MySQL and SQLite via Prisma, Drizzle, Alembic, Django, Rails, Flyway or EF Core. Use when adding columns, indexes or constraints, changing types, renaming or dropping fields, running large backfills, or recovering a failed or dirty migration. Not for query and transaction code (use database-development) or restore drills (use backup-recovery)."
trigger: "Use when a change adds or edits files under migrations/, alters a live table, needs a data backfill, or must recover a failed migration."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: data
paths: ["**/migrations/**"]
---

# Database Migrations

## Selection card
- Task: Ship schema changes and backfills that keep serving traffic while old and new code overlap.
- Start: Read the migration history and tool config, the engine and server version, the generated SQL, and every reader and writer of the touched tables.
- Finish: the migration applies to a fresh database and to representative data within a measured lock budget, the backfill survives a restart, and the recovery path is tested.

## Overview

A migration is a deploy that runs while old and new code both serve traffic: the danger is rarely the SQL itself but the lock it waits for, the table it rewrites, and the old pods still reading the column you just dropped.
Database engine, version and migration tool determine transactional DDL, locking, index creation and rollback behavior.

## Rules

1. Expand, migrate, contract across separate deploys: add nullable or defaulted columns, dual-write, backfill, switch reads, and drop only after every running version (including the rollback target and background workers) stops using it. A rename is add, copy and drop.
2. Run DDL on live PostgreSQL tables with a short `lock_timeout` and a retry: an `ACCESS EXCLUSIVE` request queued behind one long transaction blocks every read and write that arrives after it.
3. Know what rewrites or scans: most `ALTER COLUMN TYPE` changes, adding a column with a volatile default such as `gen_random_uuid()`, `SET NOT NULL` without a validated `CHECK (col IS NOT NULL)`, and constraint validation. Read the generated SQL, not the ORM diff.
4. Build indexes on live tables with `CREATE INDEX CONCURRENTLY` outside any transaction, and add constraints as `NOT VALID` followed by `VALIDATE CONSTRAINT`; tell the tool to skip its wrapping transaction for that file.
5. Keep backfills out of schema migrations: batch by primary-key range with a commit per batch, make them idempotent and resumable from a checkpoint, and throttle on replication lag.
6. Never edit a migration that has run anywhere shared; add a new one. Checksums (Flyway, Liquibase) and drift detection (Prisma, Alembic, Django) depend on history being immutable.
7. A down migration does not bring data back. Destructive steps need a verified restore path or a forward-fix plan decided before they run.
8. Exactly one runner applies migrations per deploy (a release job or a lock), never every pod racing at boot.

## First moves by situation

| Situation | First moves |
|---|---|
| Add a column | Nullable or constant default (metadata-only on PostgreSQL 11+; MySQL 8 `ALGORITHM=INSTANT` where supported); make it NOT NULL later via `CHECK ... NOT VALID`, `VALIDATE`, then `SET NOT NULL` |
| Add an index | `CREATE INDEX CONCURRENTLY` in its own non-transactional migration; on failure drop the INVALID leftover with `DROP INDEX CONCURRENTLY` and retry; MySQL: `ALGORITHM=INPLACE, LOCK=NONE` stated explicitly |
| Add a unique constraint | Deduplicate first; `CREATE UNIQUE INDEX CONCURRENTLY`, then `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX` |
| Add a foreign key or check | `ADD CONSTRAINT ... NOT VALID` now, `VALIDATE CONSTRAINT` in a later migration (it does not block reads or writes) |
| Change a type or rename | New column, dual-write, backfill, switch reads, drop later; widening `varchar(n)` or converting `varchar` to `text` is metadata-only on PostgreSQL |
| Add an enum value | `ALTER TYPE ... ADD VALUE` in its own migration: the value cannot be used until that transaction commits; deploy readers that tolerate it before writers emit it |
| Failed or dirty migration | Read the tool's state table first (`_prisma_migrations`, `flyway_schema_history`, `alembic_version`, golang-migrate's dirty flag); establish what actually applied; finish or revert by hand, then record it (`prisma migrate resolve --applied/--rolled-back`, `flyway repair`, `migrate force <version>`); never re-run blindly |
| SQLite change | Most `ALTER TABLE` changes need a rebuild (create new table, copy, drop, rename) with `PRAGMA foreign_keys=OFF` set outside the transaction; Alembic offers `batch_alter_table` |

## Tool notes

- **Django** — `atomic = False` on the Migration class for concurrent operations; `AddIndexConcurrently` from `django.contrib.postgres.operations`; read SQL with `python manage.py sqlmigrate <app> <number>`.
- **Rails** — `disable_ddl_transaction!` with `algorithm: :concurrently`; the strong_migrations gem blocks known-unsafe operations.
- **Alembic** — wrap concurrent DDL in `with op.get_context().autocommit_block():`; `alembic upgrade head --sql` prints the SQL; `alembic check` detects model drift.
- **Prisma** — create with `prisma migrate dev --create-only` and edit the SQL; a file mixing `CONCURRENTLY` with other statements fails, so keep it alone; production applies with `prisma migrate deploy`, never `migrate dev` or `migrate reset`. A renamed model field without `@map` is generated as drop plus add.
- **Drizzle** — `drizzle-kit generate` writes reviewable SQL; `drizzle-kit push` applies a diff with no migration file and is not a production path.
- **EF Core** — `dotnet ef migrations script --idempotent` to review; `migrationBuilder.Sql(sql, suppressTransaction: true)` for concurrent index builds.
- **Flyway / Liquibase** — `flyway validate` and `flyway info` before deploy; Liquibase `update-sql` previews; clear a stale changelog lock only after confirming no runner is alive.

## Patterns and pitfalls

- **Lock queue amplification** — the migration waits for a lock, and everything behind it waits for the migration. Watch `SELECT * FROM pg_locks WHERE NOT granted` during rehearsal; `lock_timeout` plus retry turns an outage into a delayed deploy.
- **Invalid leftovers** — a failed concurrent build leaves an INVALID index that still costs every write; find them with `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`.
- **One-statement backfills** — a single `UPDATE` over millions of rows holds locks, floods WAL, lags replicas and leaves bloat; batch, commit, pause, and vacuum afterwards.
- **MySQL metadata locks** — an idle open transaction holding a metadata lock stalls the `ALTER`, which stalls every later query on the table; set `lock_wait_timeout` and use gh-ost or pt-online-schema-change for large tables without an INSTANT or INPLACE path.
- **Logical replication** — DDL is not replicated; apply schema to subscribers before publishers send rows that need it.
- **Old code meets new data** — new enum values, stricter checks or dropped defaults break the previous release still running during rollout; ship tolerant readers first.
- **Boot-time migrations** — several pods running migrations on start race or deadlock; use the tool's lock or a single release job, and fail the deploy if it fails.

## Workflow

1. Record invariants, data volume, table write rate and the compatibility window between the old and new application versions.
2. Generate the migration with the project's tool and read the SQL: lock level, rewrite or scan, transaction wrapping, index strategy.
3. Apply to a fresh database and to a copy with representative volume; time it and watch for lock waits.
4. Run the backfill, kill it midway, restart it, and prove no rows were skipped or processed twice.
5. Exercise the down migration where it is reversible; otherwise rehearse the forward fix or restore in the isolated environment.
6. Report commands, measured duration and locks, data checks, and exactly where the migration has and has not run.

## Proof

- Lint: `squawk <file>.sql` for PostgreSQL, `atlas migrate lint`, or the strong_migrations checks in Rails tests
- Preview: the tool's SQL output (see Tool notes) committed for review
- Drift: `prisma migrate status`, `alembic check`, `python manage.py makemigrations --check --dry-run`, `dotnet ef migrations has-pending-model-changes`
- Apply: fresh database, then representative copy, with `\timing` on and `pg_locks` observed
- Backfill: `SELECT count(*) FROM <table> WHERE <new_col> IS NULL` returns 0 after an interrupted-and-resumed run; spot-check values against the source column
- Indexes and constraints: no rows from the invalid-index query; `pg_constraint.convalidated` true after validation

## Stop and ask

- Any run against production or a shared environment: a migration plan does not authorize execution.
- The change drops, truncates or narrows data and no restore has been tested.
- A hot or large table would be rewritten or exclusively locked with no online path.
- Fixing history requires editing an applied migration or forcing the migration state table.

## Acceptance checks

- [ ] Generated SQL read for rewrites, scans, lock levels and transaction wrapping on the actual engine
- [ ] Old and new application versions both work against every intermediate schema state
- [ ] DDL on live tables uses `lock_timeout`, concurrent index builds and `NOT VALID` constraints where applicable
- [ ] Backfill batched, idempotent and proven to resume after interruption without gaps or duplicates
- [ ] Applied to empty and representative data with measured duration; no invalid indexes left
- [ ] Down migration or forward fix rehearsed; execution boundary (where it ran, where it did not) reported

## Sources

[PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
is an engine-specific reference; use the selected engine's current documentation
and exact version for operational decisions. See also [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Skills in scope

- database-development — the queries, constraints and transactions that the schema serves.
- data-governance — retention, PII anonymization and audit compliance during schema or backfill changes.
- api-design — keeping public payloads backward-compatible while columns evolve.
- backup-recovery — verified restore before destructive contraction steps.
- testing — automated up/down/backfill tests against realistic seed data.
- observability — lock waits, replication lag and latency during rollout.
