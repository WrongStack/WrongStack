---
name: php-laravel
description: "Laravel and PHP apps: routes, Form Requests, Policies, Eloquent, API Resources, queues and Horizon, Octane, Pest and Composer upgrades. Use when adding or fixing Laravel controllers, validation, authorization, Eloquent queries, jobs or scheduled commands, or upgrading PHP or Laravel. Not for HTTP contract design (use api-design) or broker-agnostic queue semantics (use queues-jobs)."
trigger: "Use when a change touches artisan, routes/*.php, app/Http, app/Models, composer.json, queued jobs or a PHP or Laravel upgrade."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
paths: ["artisan", "routes/{web,api,console}.php", "app/Http/**/*.php", "app/Models/*.php"]
---

# Php Laravel

## Selection card
- Task: Implement or repair Laravel routes, validation, policies, Eloquent access and queued work.
- Start: Read composer.json and composer.lock (PHP constraint, Laravel version), `bootstrap/app.php`, the route file and the controller, request, policy or job being changed.
- Finish: Pint, static analysis and tests pass, the app answers the changed route (and `/up`), and any changed job runs once on a real worker.

## Overview

Laravel's conveniences are where its production bugs live: mass assignment from `$request->all()`, lazy loading that turns one page into hundreds of queries, jobs that run before their transaction commits, and long-lived workers running last week's code.
Checked 2026-11-02: PHP 8.5.12 and Laravel 13.39.0. Verify Composer platform requirements, extensions and framework migration notes before combining current releases.
Laravel 13 needs PHP 8.3+. Since Laravel 11 the slim skeleton configures middleware, exceptions and routing in `bootstrap/app.php`, and the base `Controller` no longer includes `AuthorizesRequests`.

## Rules

1. Validate with Form Requests and persist only `$request->validated()` or `$request->safe()->only([...])`; never `fill($request->all())`, never `Model::unguard()`.
2. Authorize the object: `Gate::authorize('update', $post)` with a Policy (Laravel 11+ controllers lack `$this->authorize()` unless the trait is added), `->scopeBindings()` on nested routes, and tenant `where` clauses on `exists:`/`unique:` rules.
3. Enable `Model::shouldBeStrict(! app()->isProduction())` to catch lazy loading, silently discarded attributes and missing attributes; fix N+1 with `with()`/`loadMissing()` and prove query counts in tests.
4. Side effects wait for commit: inside `DB::transaction`, dispatch jobs, events and mail with `->afterCommit()` (or `after_commit => true` on the queue connection), or a fast worker reads rows that do not exist yet.
5. Jobs are idempotent and carry IDs. Set `$tries`, `$backoff` and `$timeout`, and keep the worker `--timeout` several seconds below the connection's `retry_after`, or a slow job is released and runs twice.
6. Read configuration through `config()` only; once `config:cache` runs, `env()` returns null outside `config/*.php`.
7. Workers, Horizon and Octane keep code and singletons in memory: restart them on deploy (`php artisan queue:restart`, `php artisan horizon:terminate`, `php artisan octane:reload`) and keep request state out of singletons and static properties.
8. Keep the project's PHP constraint, Laravel major, starter kit and test runner (Pest or PHPUnit). Upgrades are their own change.

## First moves by situation

| Situation | First moves |
|---|---|
| New endpoint | `php artisan route:list --path=<prefix>` to find a sibling; `make:request`, `make:policy`, `make:resource`; feature test first with `actingAs()` for the owner and a second user |
| Slow page or API | Count queries in a test with `DB::listen` or locally with Telescope/Debugbar; turn on strict mode; index the `where` and `orderBy` columns |
| Job ran twice or hit `ModelNotFoundException` | Compare `retry_after` with `--timeout`; look for dispatch inside a transaction without `afterCommit`; deleted models need `$deleteWhenMissingModels = true` |
| Laravel upgrade | Upgrade PHP first; `composer why-not laravel/framework <version>` to find blocking packages; follow the official upgrade guide one major at a time |
| PHP upgrade | `composer check-platform-reqs`; run tests with deprecations visible; PHP 8.4 deprecates implicitly nullable parameters (`Type $x = null` must become `?Type $x = null`) |
| Duplicate rows under concurrency | Add a unique index, then `createOrFirst()` or `upsert()`; for read-modify-write use `lockForUpdate()` inside a transaction |
| Scheduled task duplicated or skipped | `php artisan schedule:list`; `->withoutOverlapping()` and `->onOneServer()` (needs a shared lock-capable cache); exactly one scheduler process per environment |
| Security review | `$fillable`/`$guarded`, raw Blade `{!! !!}`, `whereRaw`/`DB::raw` with interpolation, `APP_DEBUG=false`, signed URLs for temporary links, `composer audit` |

## Patterns and pitfalls

- **Builder updates skip the model** — `Post::where(...)->update([...])` and `->delete()` bypass model events, observers and mutators; audit logs and cache invalidation hooked to events silently miss them.
- **Chunking while mutating** — `chunk()` combined with updates to the filtered column skips rows as pages shift; use `chunkById()` or `lazyById()`.
- **firstOrCreate race** — two requests both miss and both insert. Back it with a unique index and switch to `createOrFirst()`, which catches the unique violation.
- **SerializesModels** — a job stores the model identifier and re-queries it when it runs, so it sees current state, not dispatch-time state; pass explicit values when the job must act on a snapshot.
- **ShouldBeUnique locks** — the lock lives until the job completes or fails; a killed worker leaves it until `$uniqueFor` expires, and it needs a cache driver that supports locks.
- **Sync queue in tests** — `QUEUE_CONNECTION=sync` runs jobs inline inside the test's transaction and hides after-commit bugs; assert with `Queue::fake()` and also run one real worker in a feature check.
- **Octane state bleed** — a singleton that receives `Request`, config or the authenticated user in its constructor keeps the first request's values for the worker's life; resolve per call or use scoped bindings.
- **Key rotation** — rotating `APP_KEY` breaks encrypted casts and sessions unless the old key is listed in `APP_PREVIOUS_KEYS` (Laravel 11+) during the transition.
- **Casts** — Laravel 11+ prefers the `casts()` method; casting to `immutable_datetime` stops accidental date mutation; keep the `encrypted` cast for columns you never query by value.
- **Raw SQL** — `whereRaw("name = '$name'")` is injectable; pass bindings (`whereRaw('name = ?', [$name])`) and allowlist sortable columns.
- **Route model binding** — implicit binding finds any row by key; without scoped bindings or a policy check, `/teams/1/projects/99` returns another team's project.

## Workflow

1. `php -v`, `composer show laravel/framework`, `php artisan about`; read the PHP constraint, queue driver, cache driver and whether Octane or Horizon is installed.
2. Trace route (with middleware) → Form Request → Policy → controller or action → Eloquent → Resource; note events, observers and jobs fired.
3. Write the failing Pest or PHPUnit feature test first: owner succeeds, other user denied, invalid input returns 422, and query count stays bounded.
4. Implement with validated data, policies, eager loading, transactions and after-commit dispatch.
5. For schema changes, generate a migration and read its SQL with `--pretend` before running it.
6. Run the proof, then start the app, hit the changed route and process one job on a real worker.

## Proof

Prefer the project's composer scripts and CI workflow. Common defaults:

- Composer: `composer validate --strict`, `composer install --no-interaction`, `composer audit`
- Style: `./vendor/bin/pint --test`
- Static analysis: `./vendor/bin/phpstan analyse` (Larastan) at the configured level
- Tests: `php artisan test --parallel` or `./vendor/bin/pest`
- Migrations: `php artisan migrate --pretend` to read SQL, `php artisan migrate:status`
- Config sanity: `php artisan config:cache` succeeds, then `php artisan config:show queue`
- Smoke: `php artisan serve`, `curl -fsS localhost:8000/up` and the changed route; `php artisan queue:work --once` processes the dispatched job exactly once

## Stop and ask

- The change moves PHP or Laravel to a new major, or adopts Octane, Horizon or a different queue driver.
- A migration drops, renames or rewrites data, or runs against a shared database.
- It changes guards, Sanctum/Fortify settings, session configuration or global middleware.
- Proof needs production credentials, payment sandboxes or mail providers you cannot run locally.

## Before returning

- [ ] PHP constraint and Laravel version intended; `composer validate --strict` and `composer audit` clean
- [ ] Writes use validated data only; Policies or Gates authorize the specific object
- [ ] Strict mode passes; query counts bounded for the changed pages
- [ ] Jobs and events dispatched after commit; `$tries`/`$timeout`/`retry_after` consistent; handlers idempotent
- [ ] No `env()` outside `config/*.php`; `config:cache` succeeds
- [ ] Pint, static analysis and tests pass
- [ ] App served the changed route and `/up`; a real worker processed the job once (observed)

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[PHP releases](https://www.php.net/downloads.php), [Laravel docs](https://laravel.com/docs), [Laravel upgrade guide](https://laravel.com/docs/upgrade), [Laravel queues](https://laravel.com/docs/queues).

## Skills in scope

- api-design — API Resources, status and error responses, rate limiting and pagination contracts.
- database-development — Eloquent and query builder access, transactions, locking and bounded results.
- database-migrations — Laravel migrations that deploy without downtime.
- queues-jobs — delivery, retry, deduplication and shutdown semantics for workers.
- authentication-sessions — Sanctum, Fortify or session sign-in and tenant authorization.
- testing — Pest/PHPUnit feature tests, fakes and database isolation.
