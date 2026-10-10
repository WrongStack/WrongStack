---
name: database-development
description: "Implement database access, models and queries with explicit consistency, transactions and bounded results. Use when working with SQL, document databases, Redis or ORM clients; use database-migrations for schema rollout/recovery and verify actual engine/client compatibility."
trigger: "Implement database access, models and queries with explicit consistency, transactions and bounded results. Use when working with SQL, document databases, Redis or ORM clients; use database-migrations for schema rollout/recovery and verify actual engine/client compatibility."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
---

# Database Development

## Selection card
- Task: Design database queries, indexes and transactions.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement database access, models and queries with explicit consistency, transactions and bounded results.

Checked 2026-10-09: PostgreSQL 18.6, MongoDB stable 9.0 series, Redis server 8.10.2; Prisma/client 7.10.0, Drizzle 0.45.4, MongoDB Node driver 7.7.0, Redis Node client 6.3.0. Prisma latest tag currently points at 8.0.0-rc.22: choose the verified stable release unless preview is requested.

## Rules

1. Identify engine, topology, schema/model, transaction semantics and actual pool/client lifetime.
2. Model uniqueness, ownership and valid states at the database boundary where appropriate.
3. Bound list/query results and inspect access plans/indexes against representative data.
4. Validate query inputs and public output; parameterization of values does not authorize an object or arbitrary identifier.
5. Define atomicity and retry semantics across multiple writes/external side effects.
6. Treat cache/document/relational consistency deliberately; a client library version is not the server version.

## Workflow

1. Trace callers, read/write contracts and existing persistence conventions.
2. Verify current stable engine/client/ORM support before upgrade.
3. Implement the narrow query/model operation with explicit transaction and failure behavior.
4. Test concurrency, uniqueness, empty/boundary data and rollback/retry cases.
5. Inspect relevant query performance and run application integration checks.

## Before returning

Engine/client identities separated; data/ownership/atomicity contracts tested; queries bounded; schema deployment delegated to its actual migration workflow.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[PostgreSQL](https://www.postgresql.org/docs/current/), [MongoDB releases](https://www.mongodb.com/docs/manual/release-notes/), [Redis clients](https://redis.io/docs/latest/develop/clients/).

## Skills in scope

- database-migrations — design and verify schema migrations, bounded backfills and deployment compatibility for databases.
- data-governance — data governance contracts and verification.
- api-design — api design contracts and verification.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
