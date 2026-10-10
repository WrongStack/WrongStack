---
name: php-laravel
description: "Build and upgrade PHP/Laravel applications with validated requests, policy authorization and reliable jobs/data access. Use when implementing Laravel routes, Eloquent models or queues; preserve existing project conventions and runtime compatibility."
trigger: "Build and upgrade PHP/Laravel applications with validated requests, policy authorization and reliable jobs/data access. Use when implementing Laravel routes, Eloquent models or queues; preserve existing project conventions and runtime compatibility."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Php Laravel

## Selection card
- Task: Implement Laravel policies, requests and Eloquent.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade PHP/Laravel applications with validated requests, policy authorization and reliable jobs/data access.

Checked 2026-10-09: PHP 8.5.11 and Laravel 13.35.0. Verify Composer platform requirements, extensions and framework migration notes before combining current releases.

## Rules

1. Inspect composer.json/lock, PHP extensions, environment and web/queue entrypoints.
2. Use request validation and policy/object authorization; a middleware login check is not ownership permission.
3. Map allowed persisted fields explicitly and serialize public resources rather than exposing entire models.
4. Review Eloquent loading/query shape and transaction behavior for the actual request/job.
5. Make jobs idempotent, bounded and restart-safe; a successful enqueue is not completed work.
6. Coordinate route/config caches and queue-worker reload with deployment version identity.

## Workflow

1. Trace request/job, model/policy and nearest tests.
2. Resolve latest stable runtime/framework support and required migrations.
3. Implement the narrow feature with validation, transaction and job contracts.
4. Test input/auth, failure/rollback, retry and queue worker lifecycle.
5. Run configured Composer/test/static/build checks and actual app/worker startup.

## Before returning

Runtime/extensions and framework matrix clear; policy/serialization/jobs verified; cache/worker deployment behavior reported.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[PHP releases](https://www.php.net/downloads.php), [Laravel docs](https://laravel.com/docs).

## Skills in scope

- api-design — api design contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- queues-jobs — implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
