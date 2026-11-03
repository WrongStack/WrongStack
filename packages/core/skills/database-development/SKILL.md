---
name: database-development
description: "SQL and data access with PostgreSQL, MySQL, SQLite, MongoDB, Redis, Prisma and Drizzle: queries, indexes, transactions, pools. Use when writing or fixing queries, ORM models, upserts, locking, pagination, connection pooling or slow queries, or upgrading a driver or ORM. Not for schema rollout and backfills (use database-migrations) or backup and restore (use backup-recovery)."
trigger: "Use when a change touches SQL, ORM queries or models, transactions, indexes, connection pools, or MongoDB and Redis access."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
paths: ["*.sql"]
---

# Database Development

## Selection card
- Task: Implement or repair queries, data models, transactions and pooling with correct concurrency and bounded cost.
- Start: Identify the engine and server version, the ORM or driver and its version, the pool or pooler, and the callers of the query being changed.
- Finish: the change is proven against the real engine (concurrency test plus `EXPLAIN` on realistic volume), and schema changes are handed to the migration workflow.

## Overview

Database bugs are concurrency and volume bugs: check-then-insert races that pass single-user tests, queries that collapse at ten million rows, and transactions held open across network calls.
Checked 2026-11-02: PostgreSQL 18.6, MongoDB stable 9.0 series, Redis server 8.10.3; Prisma/client 7.10.1, Drizzle 0.45.4, MongoDB Node driver 7.8.0, Redis Node client 6.3.1. Prisma latest tag currently points at 8.0.0-rc.29: choose the verified stable release unless preview is requested.
A client or ORM version is not the server version: check `SELECT version()`, `db.version()` or `INFO server` on the real target before relying on engine features.

## Rules

1. Invariants live in the database (`UNIQUE`, `FOREIGN KEY`, `CHECK`, `NOT NULL`); the application handles the violation (PostgreSQL `23505`) instead of checking first and inserting second.
2. Concurrent state changes are single statements or explicit locks: `INSERT ... ON CONFLICT`, `UPDATE ... WHERE id = $1 AND version = $2` with the affected-row count checked, or `SELECT ... FOR UPDATE` in a short transaction. Read-modify-write under READ COMMITTED (the PostgreSQL default) loses updates.
3. Transactions hold only database work and use the transaction handle. Inside an ORM transaction callback, a query on the outer client (`db` instead of `tx`) runs on another connection, outside the transaction.
4. Every list is bounded with a deterministic order (`ORDER BY created_at DESC, id DESC LIMIT n`); deep pages use keyset predicates like `(created_at, id) < ($1, $2)` backed by an index in the same order.
5. Parameterize values, allowlist identifiers (sort columns, directions), and apply the tenant or owner predicate on every read, update and delete, including raw SQL and bulk operations.
6. One pool per process, sized against the server's connection limit across all replicas and workers; serverless and many-replica deployments go through a pooler.
7. Request paths set `statement_timeout` and `lock_timeout` (or driver equivalents) so a slow query fails instead of stacking connections.
8. Retry serialization failures (`40001`) and deadlocks (`40P01`) by re-running the whole transaction a bounded number of times, never by retrying one statement.

## First moves by situation

| Situation | First moves |
|---|---|
| New query | Copy the sibling repository's tenant scoping and error mapping; run `EXPLAIN (ANALYZE, BUFFERS)` on realistic data and confirm the intended index is used |
| Slow query | `pg_stat_statements` ordered by `total_exec_time`; `EXPLAIN (ANALYZE, BUFFERS)` (it executes the statement, so wrap writes in `BEGIN ... ROLLBACK`); look for row-estimate mismatches, seq scans and sorts spilling to disk |
| Duplicate rows or lost updates | Missing unique constraint or read-modify-write; add the constraint through a migration, then switch to an upsert or version predicate |
| Pool timeouts or "too many connections" | Multiply pools × size × replicas; find long transactions in `pg_stat_activity` (`state = 'idle in transaction'`); look for connections never released on error paths |
| Deadlocks | Lock rows in a consistent order (sort IDs before updating), keep transactions short, remember FK checks lock parent rows |
| ORM or driver upgrade | Read the upgrade guide (Prisma 7 changed the generator, `prisma.config.ts` and driver adapters); regenerate the client; diff the SQL it emits for hot queries |
| MongoDB slow or inconsistent | `explain("executionStats")`; compare `totalDocsExamined` with `nReturned`; order compound index fields Equality, Sort, Range |
| Redis memory or latency | `SCAN`, never `KEYS`, in production; TTL on every cache key; `redis-cli --bigkeys`; eviction policy matching the use (`noeviction` for queues, LRU or LFU for caches) |

## Patterns and pitfalls

- **ON CONFLICT DO NOTHING RETURNING** — returns no row when the conflict fires, so the caller gets nothing back; use a no-op `DO UPDATE SET col = EXCLUDED.col` or select afterwards.
- **NULLs in unique constraints** — NULLs are distinct by default, so `UNIQUE (tenant_id, email)` admits duplicates when `email` is null; PostgreSQL 15+ supports `NULLS NOT DISTINCT`. Soft-delete uniqueness needs a partial index `WHERE deleted_at IS NULL`.
- **Pooler transaction mode** — PgBouncer transaction pooling breaks session state: plain `SET` (use `SET LOCAL`), session advisory locks, `LISTEN`, temp tables; named prepared statements need PgBouncer 1.21+ with `max_prepared_statements`.
- **Interactive transaction limits** — Prisma interactive `$transaction` defaults to a 5-second timeout and 2-second max wait; slow work inside it fails or pins a connection.
- **OFFSET pagination** — `OFFSET 100000` reads and discards every skipped row, and concurrent inserts shift items between pages.
- **SQLite defaults** — foreign keys are off per connection until `PRAGMA foreign_keys = ON`; enable WAL and `busy_timeout`, and start write transactions with `BEGIN IMMEDIATE` to avoid `SQLITE_BUSY` on lock upgrade.
- **MySQL InnoDB** — REPEATABLE READ with next-key locks means range updates lock gaps and block inserts. The charset must be `utf8mb4`; legacy `utf8` is 3-byte and rejects emoji.
- **Money and time** — integer minor units or `numeric`, never floating point; `timestamptz` holding UTC, converted at the edge.
- **Identifier choice** — sequential IDs leak volume; random UUIDv4 keys fragment B-tree indexes; time-ordered UUIDv7 (built in as `uuidv7()` on PostgreSQL 18) balances both.
- **MongoDB transactions** — need a replica set or sharded cluster and abort after 60 seconds by default; unbounded arrays inside documents grow until the 16 MB limit.
- **Redis locks** — acquire with `SET key token NX PX ttl` and release with a compare-and-delete script; without fencing tokens a paused holder can still write after expiry. Redis persistence is snapshot-based by default, so it is not the system of record for orders or money.
- **Cache invalidation order** — invalidate after commit; invalidating before commit lets a concurrent reader repopulate the stale value.

## Workflow

1. Record engine and server version, ORM and driver versions, pool settings, pooler mode and replica routing.
2. Trace callers: which endpoint or job, expected cardinality, concurrency, and tenant boundary.
3. Write the failing test against the real engine (container or local instance, not a mock or a different engine): include a concurrent case that fires N attempts at once.
4. Implement with constraints, atomic statements, bounded queries and the transaction handle.
5. Check plans on realistic data volume; confirm index use and row estimates.
6. Hand schema, index or constraint changes to database-migrations; report what ran where.

## Proof

Prefer the project's test and database scripts. Common checks:

- Server version: `psql "$DATABASE_URL" -c 'SELECT version()'`, `mongosh --eval 'db.version()'`, `redis-cli INFO server`
- Plans: `BEGIN; EXPLAIN (ANALYZE, BUFFERS) <query>; ROLLBACK;` on production-like volume
- Hot queries: `SELECT query, calls, total_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10`
- Stuck transactions: `SELECT pid, state, xact_start, query FROM pg_stat_activity WHERE state = 'idle in transaction'`
- Concurrency: a test that runs the operation 20 times in parallel and asserts exactly one row or the correct final count
- ORM: `npx prisma validate` and `npx prisma generate`, or the project's Drizzle scripts, then the integration tests
- MongoDB: `db.orders.find(filter).explain("executionStats")`; Redis: `redis-cli --bigkeys` and `redis-cli --latency`

## Stop and ask

- A statement would run against production or a shared database, or deletes and updates rows in bulk.
- The fix needs a new constraint, index or column (hand off to database-migrations with the evidence).
- It changes the global isolation level, pool size or pooler mode shared by other services.
- Correctness depends on a guarantee the engine does not give (exactly-once, cross-store atomicity); say so instead of approximating it.

## Before returning

- [ ] Engine and server version, ORM and driver versions recorded from the real target
- [ ] Invariants enforced by constraints; violations mapped to safe errors
- [ ] Concurrent writes atomic or locked; affected-row counts checked; concurrency test passes on the real engine
- [ ] Queries bounded, deterministically ordered and tenant-scoped; plan checked on realistic volume
- [ ] Transactions use the transaction handle, contain no network calls, and have timeouts
- [ ] Schema changes handed off through database-migrations

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[PostgreSQL](https://www.postgresql.org/docs/current/), [MongoDB releases](https://www.mongodb.com/docs/manual/release-notes/), [Redis clients](https://redis.io/docs/latest/develop/clients/), [Prisma upgrade guides](https://www.prisma.io/docs/orm/more/upgrade-guides).

## Skills in scope

- database-migrations — schema, index and constraint rollout with bounded backfills and recovery.
- data-governance — PII classification, tenant isolation, retention and audit requirements.
- api-design — cursor pagination contracts, idempotency and mapping database errors to API responses.
- backup-recovery — backups and restoration for owned databases.
- testing — real-engine integration tests, concurrency races and transactional fixtures.
