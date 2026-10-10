---
name: queues-jobs
description: "Implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics. Use when adding BullMQ or another established queue, background processing or scheduled work; enqueue success is not job completion."
trigger: "Implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics. Use when adding BullMQ or another established queue, background processing or scheduled work; enqueue success is not job completion."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
---

# Queues Jobs

## Selection card
- Task: Build bounded retries, background jobs and deduplication.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics.

Checked BullMQ stable target: 6.3.12 on 2026-10-09. Verify current broker/client/worker compatibility and actual delivery guarantees before implementation.

## Rules

1. Define job identity, payload/schema version, ownership and the user-visible completion state.
2. Treat delivery as potentially duplicated/out of order unless the actual system proves stronger guarantees.
3. Make side effects idempotent or transactionally reconciled; acknowledge only after the intended completion boundary.
4. Bound attempts, delay/backoff, concurrency, payload/output size and dead-letter behavior.
5. Handle crash/restart, lease/visibility expiry and cancellation without letting stale workers overwrite successors.
6. Keep scheduling opt-in when the user did not request recurring work; queue infrastructure does not grant new autonomous tasks.

## Workflow

1. Map producer, broker, consumer and persistent side effects.
2. Choose supported current APIs and specify delivery/recovery contracts.
3. Implement bounded processing and observable lifecycle state.
4. Test duplicate delivery, partial failure, restart, retry exhaustion and stale completion.
5. Verify shutdown/drain behavior and user completion signals.

## Before returning

Delivery/ack semantics explicit; retry and ownership cases tested; job status truthful; recurring work and external effects authorized.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[BullMQ](https://docs.bullmq.io/), [Cloudflare Queues](https://developers.cloudflare.com/queues/).

## Skills in scope

- api-design — api design contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- observability — observability contracts and verification.
- testing — testing contracts and verification.
