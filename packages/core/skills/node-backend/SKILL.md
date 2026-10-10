---
name: node-backend
description: "Build and upgrade Node.js HTTP services with typed validation, lifecycle ownership and production behavior. Use when implementing Hono, Fastify, NestJS or another established Node server; use node-modern for runtime I/O details and preserve the chosen framework."
trigger: "Build and upgrade Node.js HTTP services with typed validation, lifecycle ownership and production behavior. Use when implementing Hono, Fastify, NestJS or another established Node server; use node-modern for runtime I/O details and preserve the chosen framework."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Node Backend

## Selection card
- Task: Implement Node server endpoints and shutdown.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Node.js HTTP services with typed validation, lifecycle ownership and production behavior.

Checked 2026-10-09: Hono 4.13.13, Fastify 5.12.5 and NestJS 12.1.2. Latest stable Node target is 26.11.1; verify framework/plugins/adapter requirements together.

## Rules

1. Inspect framework lifecycle, plugin/dependency injection order and actual runtime adapter.
2. Validate input and serialize public output at the route boundary; do not expose database rows or internal exceptions wholesale.
3. Bound request bodies, external calls and expensive work according to application limits.
4. Keep per-request auth/context isolated and authorize each operation/object.
5. Make startup, readiness and graceful shutdown include owned pools/listeners/jobs.
6. Verify framework error/cancellation semantics; returning an error-shaped object may still produce a success response.

## Workflow

1. Trace route → service → persistence/external operation and existing conventions.
2. Resolve latest stable targets and supported plugins before migration.
3. Implement the feature with explicit contracts and lifecycle cleanup.
4. Test valid/invalid/unauthorized input, dependency failure and stop/restart.
5. Run configured type/lint/tests and a production server health/user-path check.

## Before returning

Route/auth/output contracts verified; startup/shutdown resources owned; framework compatibility and actual server behavior recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Hono](https://hono.dev/docs/), [Fastify](https://fastify.dev/docs/latest/), [NestJS](https://docs.nestjs.com/).

## Skills in scope

- node-modern — node modern contracts and verification.
- api-design — api design contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
- queues-jobs — implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics.
