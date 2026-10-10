---
name: cloudflare-workers
version: 1.0.1
description: "Build and maintain Cloudflare Workers with typed bindings, explicit compatibility and isolated validation. Use when implementing Workers handlers, integrating KV/R2/D1/Durable Objects/Queues or configuring Wrangler; deployment remains governed by the user task and target environment."
trigger: "implementing Workers handlers, integrating KV/R2/D1/Durable Objects/Queues or configuring Wrangler; deployment remains governed by the user task and target environment."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: operations
---

# Cloudflare Workers

## Selection card
- Task: Implement Cloudflare Workers bindings and deployment.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Latest checked 2026-10-09: Wrangler 4.149.0 and workers-types 5.20261009.1.
Refresh before installation. Wrangler-generated types and compatibility dates
should match the project's actual bindings and runtime, not a guessed Node API set.

## Rules

1. Inspect wrangler.jsonc/toml, compatibility_date/flags, environments and bindings.
   Identify which resources local, preview and production configurations target.
2. Use bindings and secret configuration; avoid embedding credentials or manually
   constructing access to a bound service when the binding already supplies it.
3. Keep request state request-local. Isolate reuse does not guarantee durable
   global storage; choose the persistence product by consistency/coordination needs.
4. Consume or cancel response bodies, bound upstream I/O and stream large output
   where appropriate. Use waitUntil for supported deferred work, not unhandled promises.
5. Check platform limits and runtime compatibility for packages. nodejs_compat
   is a compatibility surface, not a promise that every Node package works.
6. Test with the configured Worker runtime. Node-only unit tests do not establish
   binding or production-runtime behavior.

## Workflow

1. Define the request/queue/scheduled contract, binding types and failure behavior.
2. Run Wrangler type generation and local checks with project commands.
3. Test success, upstream failure, cancellation and binding interactions using
   isolated resources. Validate idempotency for retried jobs.
4. Inspect the deploy bundle/config before any authorized deployment.
5. For an authorized release, verify the exact environment, deployed version,
   health and rollback. Report local and live evidence separately.

## Sources

[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[Wrangler](https://developers.cloudflare.com/workers/wrangler/).

## Acceptance checks

- Check the real bindings, local Worker behavior and deployment target; label live verification separately.

## Skills in scope

- api-design — request contracts.
- database-migrations — D1/schema evolution.
- observability — runtime diagnostics.
- ci-cd — reproducible deployment.
