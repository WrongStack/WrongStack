---
name: cloudflare-workers
version: 1.1.1
description: "Cloudflare Workers with Wrangler: wrangler.jsonc, KV, R2, D1, Durable Objects, Queues and Hyperdrive bindings, versions, deploys. Use when writing or debugging a Worker handler, adding a binding, migrating D1, designing a Durable Object, upgrading Wrangler or shipping a gradual deployment or rollback. Not for generic HTTP contract design (use api-design) or generic pipeline plumbing (use ci-cd)."
trigger: "Use when a request touches wrangler.jsonc or wrangler.toml, a Worker fetch/queue/scheduled handler, or Cloudflare KV, R2, D1, Durable Objects or Queues."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: operations
paths: ["wrangler.{toml,json,jsonc}"]
---

# Cloudflare Workers

## Selection card
- Task: Implement, debug or ship Cloudflare Workers code, bindings and deployments.
- Start: Read the Wrangler config (compatibility_date, flags, environments, bindings), the generated Env types and the handler being changed.
- Finish: types regenerate cleanly, tests pass inside workerd, the local dev server answers the changed route, and any live step names the exact environment and version.

## Overview

A Worker runs in a short-lived V8 isolate with per-request I/O, small memory and strict concurrency limits; bindings, not globals, carry state, and each storage product has its own consistency contract.
Latest checked 2026-11-02: Wrangler 4.156.2 and workers-types 5.20261102.1.
Refresh before installation. Wrangler-generated types and compatibility dates should match the project's actual bindings and runtime, not a guessed Node API set.

## Rules

1. Pin the target before any command: Wrangler config file, `--env`, account and resource IDs. Named environments do not inherit bindings or `vars`; each environment must redeclare them.
2. Keep per-request state request-local. Module scope may be reused across requests and users, or evicted at any time; I/O objects from one request cannot be used by another ("Cannot perform I/O on behalf of a different request").
3. Choose storage by consistency: KV for read-heavy, eventually consistent data (propagation can take about a minute; about one write per second per key); D1 for relational SQL; R2 for blobs; Queues for at-least-once background work; Durable Objects for strongly consistent per-entity coordination.
4. Consume or cancel every subrequest body and stream large payloads; a Worker has a small cap on simultaneous open connections (6), and unread bodies stall later fetches.
5. Secrets go through `wrangler secret put` and `.dev.vars` locally, never into `vars`, which are plaintext. `wrangler deploy` overwrites dashboard-edited vars unless `keep_vars` is set.
6. Regenerate types after any config change with `wrangler types` and commit the result; nodejs_compat is a compatibility layer, so check each Node package against the compatibility matrix.
7. Test in workerd (`@cloudflare/vitest-pool-workers`, `wrangler dev`); Node-only tests do not prove binding or runtime behaviour.
8. Ship with versions: upload, check the preview, then deploy gradually; know the rollback version ID before shifting traffic.

## First moves by situation

| Situation | First moves |
|---|---|
| New handler or binding | Add the binding in config per environment; `wrangler types`; sibling handler conventions; workerd test first |
| Works locally, fails deployed | Binding or var missing in that `--env`; `wrangler secret list --env production`; simulated local data vs remote; `wrangler tail --env production --format pretty` |
| Error 1101 / 1102 | 1101 = uncaught exception, 1102 = exceeded CPU or memory; tail logs; look for whole-body buffering, large JSON parse, unbounded loops |
| Hangs or "stalled response" warnings | Unconsumed subrequest bodies, promises never awaited or resolved, cross-request promise reuse |
| D1 schema change | `wrangler d1 migrations create <db> <name>`; apply with `--local`, test, then `--remote` only when authorized; `wrangler d1 export <db> --remote --output backup.sql` first |
| Durable Object design | One object per entity key; SQLite storage API; alarms for timers; hibernatable WebSockets via `ctx.acceptWebSocket`; plan migrations tags |
| Wrangler 3 → 4 upgrade | KV and R2 commands now default to local storage, so scripts need `--remote`; `d1 backups` was removed (use time-travel or export); read the migration guide |
| Deploy or rollback | `wrangler deploy --dry-run --outdir dist`; `wrangler versions upload`; `wrangler versions deploy`; `wrangler deployments list`; `wrangler rollback <version-id>` |

## Patterns and pitfalls

- **Frozen clock** — `Date.now()` does not advance during CPU-bound code (it moves only after I/O), so in-Worker timing of pure computation reads zero. Measure CPU via tail logs or analytics.
- **No I/O at module scope** — fetches or storage calls outside a handler fail; lazily initialize inside the handler and cache only immutable values.
- **`waitUntil` is bounded** — `ctx.waitUntil()` extends the invocation briefly after the response; durable or long work belongs in Queues or Workflows.
- **Queue batches retry together** — if a consumer throws, the whole batch is redelivered unless messages were individually `msg.ack()`ed; make consumers idempotent and configure `max_retries` plus a dead-letter queue.
- **Durable Object hot spots** — each object processes one request at a time with input/output gates; a single global object becomes the bottleneck. Shard by key. A `deleted_classes` migration deletes that class's stored data.
- **Compatibility date is behaviour** — bumping `compatibility_date` enables new runtime flags; read the flags changelog and rerun tests rather than bumping casually.
- **Local data is separate** — `wrangler dev` uses local simulated KV/R2/D1 unless remote mode is configured (check docs for per-binding remote options); seed fixtures deliberately.
- **Postgres from Workers** — use Hyperdrive for pooling and caching; direct TCP via `connect()` from `cloudflare:sockets` without pooling exhausts the database.
- **CPU limits** — paid plans allow raising CPU time through `limits.cpu_ms` (check the current maximum); memory per isolate stays about 128 MB, so stream instead of buffering.
- **Static assets** — new full-stack apps use Workers static assets (`assets.directory`, `not_found_handling`) rather than Pages; check whether the Worker or the asset handler runs first for a path.
- **Rollback scope** — `wrangler rollback` restores code and config of a prior version, not KV, R2, D1 or Durable Object data; check the docs for rollback limits around Durable Object migrations and secrets.

## Workflow

1. Define the handler contract (fetch, queue, scheduled, DO method), bindings and failure behaviour.
2. Update config per environment, regenerate types, and typecheck.
3. Write workerd tests for success, upstream failure, timeouts and retries; verify idempotency for queue work.
4. Run `wrangler dev` and exercise the changed route or trigger.
5. Inspect the bundle (`wrangler deploy --dry-run --outdir dist`): size, included modules, bindings per environment.
6. For an authorized release, upload a version, test its preview URL, deploy gradually, watch `wrangler tail`, and record the version ID and rollback target.

## Proof

Use the project's package runner (`npx`, `bunx`, `pnpm exec`). Common defaults:
- Types: `npx wrangler types` then `git diff --exit-code worker-configuration.d.ts`; `npx tsc --noEmit`
- Tests: `npx vitest run` with `@cloudflare/vitest-pool-workers` (check its supported Vitest range)
- Local smoke: `npx wrangler dev` then `curl -fsS http://localhost:8787/healthz` and the changed route
- Bundle: `npx wrangler deploy --dry-run --outdir dist`
- D1: `npx wrangler d1 migrations list <db> --local`, then `--remote` when authorized
- Live: `npx wrangler versions upload`, curl the preview URL, `npx wrangler deployments list`, `npx wrangler tail --format pretty`

## Stop and ask

- Any `--remote` write to KV, R2, D1 or Durable Objects, or `wrangler d1 migrations apply --remote`.
- `wrangler deploy`, `versions deploy`, `rollback` or route/custom-domain changes on a production environment.
- Durable Object migrations that rename, transfer or delete classes.
- Secrets would need to be read back, printed or moved between environments.

## Before returning

- [ ] Wrangler config, environment, `compatibility_date` and flags identified; bindings declared in every environment that uses them
- [ ] Types regenerated from config and typecheck passes
- [ ] No per-request or auth state in module scope; deferred work uses `ctx.waitUntil()` or a queue
- [ ] Subrequest bodies consumed or cancelled; large payloads streamed
- [ ] Tests ran inside workerd; local dev server answered the changed route
- [ ] Secrets set via `wrangler secret put`, not `vars`; nothing secret printed
- [ ] Any live action reports environment, version ID, observed health and the rollback version

## Sources

[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[Wrangler](https://developers.cloudflare.com/workers/wrangler/), [Wrangler v3 to v4](https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/).

## Skills in scope

- api-design — Edge HTTP caching headers, request validation, and streaming response contracts.
- database-migrations — D1 SQLite schema migrations, batch queries, and backward-compatible rollouts.
- observability — Workers Tail logs, Analytics Engine metrics, and OpenTelemetry trace export.
- ci-cd — Wrangler version uploads, gradual deployments, and preview environment gates.
- release-rollback — gradual version deployment, abort thresholds and rollback targets.
- realtime-systems — WebSockets and Durable Object coordination for live features.
