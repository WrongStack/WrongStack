---
name: database-migrations
version: 1.0.1
description: "Design and verify schema migrations, bounded backfills and deployment compatibility for databases. Use when adding constraints or indexes, changing column types, evolving schemas or recovering failed migrations; distinguish reversible application rollback from data restoration."
trigger: "adding constraints or indexes, changing column types, evolving schemas or recovering failed migrations; distinguish reversible application rollback from data restoration."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: data
---

# Database Migrations

## Selection card
- Task: Deploy compatible schema changes and backfills.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Ship schema changes that preserve data and work across deployment overlap.
Database engine, version and migration tool determine transactional DDL,
locking, index creation and rollback behavior.

## Rules

1. Inspect the current schema, migration history, engine/version, ORM and real
   readers/writers. Do not assume every DDL operation is transactional.
2. Use expand/backfill/validate/contract where old and new code overlap.
   Destructive contraction needs verified consumer retirement and a recovery plan.
3. Estimate lock/write amplification and data volume. Use bounded batches,
   stable progress keys, idempotency and checkpointed restart for large backfills.
4. Separate data restoration from a down migration. Dropped information cannot
   be recreated merely by reversing a schema statement.
5. Plan backup/restore or forward repair, monitor progress and define abort
   conditions. A backup existence check is not a tested restoration.
6. Use local fixtures or an authorized isolated database for verification;
   a migration plan does not authorize production execution.

## Workflow

1. Record invariants and compatibility across the old/new application versions.
2. Generate migrations with the project's tool and inspect resulting SQL,
   lock behavior, constraints and index strategy for the actual engine.
3. Apply to a fresh database and a representative existing schema.
4. Inject failure/restart in a bounded backfill and verify no omissions/duplicates.
   Compare row counts, constraints and important application queries.
5. Exercise rollback where reversible; otherwise test the documented forward
   repair/restore in the isolated environment.
6. Report migration commands, data verification, estimated production impact
   and the execution boundary.

## Sources

[PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
is an engine-specific reference; use the selected engine's current documentation
and exact version for operational decisions.

## Acceptance checks

- Prove old/new application compatibility, backfill repeatability, migration ordering and a recovery path.

## Skills in scope

- data-governance — ownership, retention and classification.
- api-design — compatibility for clients.
- testing — migration and restart evidence.
- observability — rollout signals.
