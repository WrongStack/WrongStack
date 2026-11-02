---
name: queues-jobs
description: "Background jobs and consumers on BullMQ, SQS, RabbitMQ, Kafka, Celery, Sidekiq or Postgres queues: retries, idempotency, DLQs. Use when adding producers or workers, scheduling recurring jobs, fixing duplicate, stuck or lost jobs, tuning retries and concurrency, or upgrading a queue library. Not for live push to clients (use realtime-systems) or webhook signature handling (use payments-webhooks)."
trigger: "Use when work moves to a queue or worker: BullMQ queues, SQS or RabbitMQ consumers, Kafka groups, Celery or Sidekiq jobs, or cron schedules."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
---

# Queues Jobs

## Selection card
- Task: Build or repair producers, workers and schedules with explicit delivery, retry, idempotency and shutdown semantics.
- Start: Map producer → broker → consumer → side effect: read the queue setup, the worker entrypoint, broker config (lease, retention, eviction) and where the job is enqueued relative to the database transaction.
- Finish: duplicate delivery, worker crash, retry exhaustion and SIGTERM were exercised against a real broker, and the business effect happened exactly once in each case.

## Overview

Every production queue is at-least-once: a job can run twice, out of order, after its lock expired, or never because it was enqueued inside a transaction that rolled back, so correctness lives in the handler, not the broker.
Checked BullMQ stable target: 6.5.3 on 2026-10-23. Verify current broker/client/worker compatibility and actual delivery guarantees before implementation.
BullMQ 6 removed legacy repeatable jobs (`repeat` options, `getRepeatableJobs`): recurring work uses Job Schedulers (`upsertJobScheduler`), and v6 errors on legacy repeat metadata left in Redis.

## Rules

1. Make the business effect idempotent, not the message: guard with a unique idempotency key, a conditional transition (`UPDATE ... WHERE status = 'pending'`), or a processed-message row written in the same transaction as the effect.
2. Enqueue after commit or through a transactional outbox. A job enqueued inside a transaction can run before the commit or outlive a rollback; a commit followed by a failed enqueue silently loses work.
3. Payloads carry IDs and a schema version, not mutable snapshots; handlers re-read current state and tolerate the entity being gone or already processed.
4. Retries are bounded with exponential backoff and jitter. Permanent failures (validation, 4xx, missing entity) fail immediately (BullMQ `UnrecoverableError`) into a failed set or DLQ that is monitored and can be redriven.
5. The lease outlasts the work: visibility timeout, lock duration, `max.poll.interval.ms` or `retry_after` must exceed worst-case handler time, or be extended by heartbeat; otherwise a second worker receives the same job.
6. Fence stale workers: completion writes check an attempt token or entity version, so a worker resuming after losing its lease cannot overwrite newer state.
7. On SIGTERM stop fetching, then finish or release in-flight jobs within the grace period (`await worker.close()`); the orchestrator's grace period must exceed the longest job, or jobs must be resumable.
8. Size concurrency to downstream capacity (database pool, partner rate limits), not CPU count. Recurring schedules are opt-in and single-flight.

## First moves by situation

| Situation | First moves |
|---|---|
| New background job | Reuse the existing queue and worker setup; define the job id or dedup key, payload version, attempts, backoff, timeout and retention; write the duplicate-delivery test first |
| Job ran twice | Lease shorter than run time; event-loop blocking starving BullMQ lock renewal; Celery visibility timeout; missing idempotency guard |
| Job lost | Enqueued before a rolled-back commit, or committed without enqueue; Redis evicting keys (`maxmemory-policy` not `noeviction`); consumer acking before processing; `removeOnFail` deleting the evidence |
| Backlog growing | Track oldest-job age, not only depth; per-job duration; poison messages retry-looping; scale workers only if the downstream can absorb it |
| BullMQ 5 to 6 | Upgrade to the latest v5 first; replace `repeat` usage with `upsertJobScheduler`; recreate schedulers; delete legacy repeat keys; then deploy v6 to every producer and worker |
| Recurring or cron job | Single-flight lock, explicit timezone and DST behavior, defined handling of runs missed during deploys; idempotency key = job name + scheduled slot |
| Ordering required | Partition by entity key (Kafka message key, SQS FIFO `MessageGroupId`) and accept less parallelism, or make handlers order-tolerant with version checks |
| Considering a database-backed queue | `SELECT ... FOR UPDATE SKIP LOCKED` workers (pg-boss, Graphile Worker, River, Solid Queue, Oban) enqueue in the same transaction; check polling load and table bloat |

## Patterns and pitfalls

- **BullMQ Redis requirements** — worker connections need ioredis `maxRetriesPerRequest: null`, and Redis must run `maxmemory-policy noeviction`, or jobs disappear under memory pressure.
- **BullMQ stalled jobs** — a processor that blocks the event loop past `lockDuration` (30 s default) cannot renew its lock; the job is treated as stalled, returned to wait and run again, then failed after `maxStalledCount` (default 1). CPU-heavy work belongs in sandboxed processors or worker threads.
- **BullMQ retention and job IDs** — completed and failed jobs are kept forever unless `removeOnComplete`/`removeOnFail` bound them; adding a job whose custom `jobId` still exists, even completed, is silently ignored.
- **SQS** — standard queues are at-least-once and unordered; FIFO deduplication covers a 5-minute window; extend long work with `ChangeMessageVisibility`; set a redrive policy with `maxReceiveCount`; Lambda consumers need `ReportBatchItemFailures` or one failure retries the whole batch.
- **RabbitMQ** — manual acks with a bounded prefetch (`basic.qos`), publisher confirms for durability; RabbitMQ 4.x quorum queues apply a default delivery limit, so configure a dead-letter exchange or poison messages are dropped.
- **Kafka** — commit offsets after the effect; a handler slower than `max.poll.interval.ms` triggers a rebalance and the batch is reprocessed elsewhere; ordering holds only within a partition.
- **Celery** — `acks_late=True` with `task_reject_on_worker_lost=True` for crash safety; with Redis or SQS brokers, ETA or countdown tasks longer than `visibility_timeout` (one hour by default on Redis) are redelivered; use `worker_prefetch_multiplier=1` for long tasks.
- **Sidekiq** — arguments must be JSON-native (strict in Sidekiq 7); the default 25 retries span about three weeks, so set `sidekiq_options retry:` deliberately.
- **Cloudflare Queues** — at-least-once batches; ack or retry per message, otherwise an exception retries the whole batch; configure `max_retries` and a dead letter queue.
- **Postgres queues** — `SKIP LOCKED` scales well, but high churn needs aggressive autovacuum; `LISTEN/NOTIFY` is only a wake-up hint, not delivery.
- **Tracing** — propagate trace context in message headers; alert on oldest-job age, DLQ size and attempt counts, not just throughput.

## Workflow

1. Identify broker, client library and version, worker runtime, and how workers are deployed and stopped.
2. Map the delivery contract: enqueue point versus commit, lease or visibility setting, retry policy, retention, DLQ, and who reads failures.
3. Write tests for the contract first: same message twice, crash after the effect but before ack, permanent error, lease expiry with a stale worker.
4. Implement with idempotent effects, bounded retries, fencing and graceful close.
5. Run against a real broker (container or local) and inspect its state, not only handler unit tests.
6. Report which guarantees were proven and which rely on configuration you could not inspect.

## Proof

- Duplicate delivery: invoke the handler twice with the same payload; assert the effect happened once
- Crash safety: `kill -9` a worker mid-job; confirm redelivery and still exactly one effect
- Lease expiry: shrink the lock or visibility timeout in a test so a second worker claims the job; assert the stale completion is rejected
- Exhaustion: a permanent error lands in the failed set or DLQ with the error recorded, without consuming all attempts
- Shutdown: SIGTERM during a job; the job finishes or is cleanly released, and the process exits within the grace period
- Broker state: `redis-cli CONFIG GET maxmemory-policy`; `aws sqs get-queue-attributes --queue-url "$URL" --attribute-names All`; `rabbitmqctl list_queues name messages_ready messages_unacknowledged`; `kafka-consumer-groups.sh --bootstrap-server "$BROKER" --describe --group <group>`; `celery -A <app> inspect active`

## Stop and ask

- Purging a queue, deleting a DLQ, or redriving failed messages in a shared or production environment.
- Changing broker, delivery mode (FIFO, quorum, partitions) or retention for queues other services use.
- Enabling a recurring schedule the user did not ask for, or changing an existing schedule's timing.
- Proof needs production broker credentials or replaying real customer messages.

## Before returning

- [ ] Broker, client version and delivery guarantee (at-least-once, ordering scope, lease) recorded from config
- [ ] Enqueue happens after commit or through an outbox
- [ ] Handlers idempotent on the business effect; duplicate-delivery test passes
- [ ] Attempts, backoff, timeout, retention and DLQ bounded; permanent errors skip retries
- [ ] Lease exceeds worst-case runtime or is extended; stale completions fenced
- [ ] SIGTERM drain observed against a real broker; grace period covers the longest job

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[BullMQ](https://docs.bullmq.io/), [Cloudflare Queues](https://developers.cloudflare.com/queues/), [BullMQ v5 to v6](https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6), [Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html).

## Skills in scope

- api-design — `202 Accepted` endpoints, job status polling or webhook contracts and idempotency keys.
- database-development — outbox tables, conditional updates and `SKIP LOCKED` claims.
- observability — queue depth, oldest-job age, retry and DLQ metrics, trace propagation.
- testing — deterministic duplicate-delivery, retry-exhaustion and stale-lease tests.
- python-backend — Celery, RQ or Dramatiq wiring inside Python services.
- node-backend — BullMQ workers inside Node services and their shutdown order.
