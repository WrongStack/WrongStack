---
name: node-backend
description: "Node.js HTTP services with Fastify, Hono, NestJS and Express 5: routes, schema validation, timeouts and graceful shutdown. Use when adding or fixing Node server endpoints, plugins, middleware or guards, server lifecycle, or upgrading Node or the framework major. Not for event-loop, stream and runtime detail (use node-modern) or HTTP contract design (use api-design)."
trigger: "Use when a change touches a Node HTTP server: Fastify plugins, Hono routes, NestJS modules, Express handlers, or server startup and shutdown."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Node Backend

## Selection card
- Task: Implement or repair Node HTTP endpoints, middleware and server lifecycle in the project's framework.
- Start: Read package.json (engines, scripts, framework version, `type`), the lockfile, the server entrypoint and the route being changed.
- Finish: typecheck, lint and tests pass, the built server starts, the changed route answers valid and invalid input correctly, and SIGTERM drains in-flight work.

## Overview

Node services fail at their edges: unvalidated bodies, outbound calls without deadlines, keep-alive timeouts shorter than the load balancer's, and shutdowns that drop in-flight requests.
Checked 2026-11-02: Hono 4.13.16, Fastify 5.12.8 and NestJS 12.3.2. Latest stable Node target is 26.13.0 (LTS 26.13.0); verify framework/plugins/adapter requirements together.
Current Node can run TypeScript by stripping types, but only erasable syntax: enums, namespaces and parameter properties still need a build step.

## Rules

1. Validate every input with the framework's schema mechanism (Fastify JSON Schema or a type provider, Hono validator middleware, Nest `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true`) and serialize output through a response schema or DTO; never return ORM rows.
2. Every outbound call has a deadline (`fetch(url, { signal: AbortSignal.timeout(ms) })` or client timeouts; undici's defaults are minutes long), and every response body is consumed or cancelled, or the socket stays checked out.
3. Shutdown order on SIGTERM: fail readiness, stop accepting (`server.close()`, `fastify.close()`, `app.close()`), wait for in-flight requests with a deadline, stop consumers, then close DB and Redis. Nest lifecycle hooks only fire on signals after `app.enableShutdownHooks()`.
4. Set `server.keepAliveTimeout` above the load balancer's idle timeout and `headersTimeout` above that; otherwise the balancer reuses sockets Node already closed and returns intermittent 502s.
5. Keep the event loop free: no sync crypto, compression, fs or giant `JSON.parse` in handlers, no unbounded regex on user input. Bound body size (Fastify `bodyLimit` defaults to 1 MiB; Express and Hono need explicit limits).
6. Per-request identity lives in the framework's request context (Fastify `request`, Hono `c.var`, Nest guards or AsyncLocalStorage), never in module-level variables; authorize the object, not just the route.
7. No floating promises in handlers: await or explicitly track them. An unhandled rejection terminates the process by default.
8. Keep the framework, module system (ESM or CJS) and package manager. A framework or Node major is its own change.

## First moves by situation

| Situation | First moves |
|---|---|
| New route | Copy a sibling's schema, auth hook or guard, and error mapping; test in-process with `fastify.inject()`, Hono `app.request()`, or Supertest on Nest's `app.getHttpServer()` |
| Intermittent 502s behind a load balancer | Compare `keepAliveTimeout`/`headersTimeout` with the balancer idle timeout; check for crashes during deploys |
| Latency spikes | `node --cpu-prof` under load; `perf_hooks.monitorEventLoopDelay()`; find sync work, huge payloads and regex backtracking |
| Memory growth | Heap snapshots via `node --heapsnapshot-signal=SIGUSR2` compared over time; listeners added per request, unbounded caches, unconsumed fetch bodies |
| Fastify 4 to 5 | Node 20+ required; querystring, params and body need full JSON Schema (no shorthand); read the v5 migration guide for removed APIs |
| Express 4 to 5 (also NestJS 11+) | path-to-regexp v8 syntax: named wildcards `/*splat`, optional segments `/users{/:id}`; async handler rejections reach error middleware; `req.body` is undefined without a parser |
| Node major upgrade | Change `engines`, `.nvmrc` or `.node-version`, the Docker base image and the CI matrix together; rebuild native addons; run once with `node --throw-deprecation` |
| Security review | `npm audit --omit=dev` (or pnpm/bun equivalent), secure headers, CORS allowlist, proxy trust limited to known hops, rate limits on auth routes |

## Patterns and pitfalls

- **Fastify async handlers** — either return the payload or call `reply.send()` and `return reply`; doing both triggers "Reply already sent", doing neither hangs the request.
- **Fastify encapsulation** — hooks and decorators registered inside a plugin are invisible to sibling plugins unless wrapped with `fastify-plugin`; an auth hook in the wrong context silently skips routes. Prove it with `fastify.printRoutes()` and an unauthenticated inject per route.
- **Response schema as allowlist** — Fastify's serializer drops properties missing from the response schema; that is the leak guard, so keep schemas for every status code you return.
- **Hono RPC types** — `hc<AppType>` inference needs the routes chained in one expression (`const routes = app.get(...).post(...)`); separate statements lose the types. `c.req.json()` throws on malformed bodies, so read `c.req.valid('json')` after the validator.
- **Nest request scope bubbles** — a REQUEST-scoped provider makes every consumer request-scoped and re-instantiated per request; carry context with AsyncLocalStorage instead of scoping services.
- **Nest validation gaps** — without `whitelist`, extra properties reach services (mass assignment); nested DTOs need `@ValidateNested()` plus `@Type(() => Child)` or they are not validated at all.
- **Unconsumed fetch bodies** — undici keeps the connection until the body is read or cancelled; on error paths call `await res.body?.cancel()`.
- **`server.close()` waits forever** — it stops accepting and closes idle keep-alive sockets, but active requests and upgraded sockets keep it open; pair it with a deadline and `server.closeAllConnections()`.
- **Liveness vs readiness** — liveness that checks the database turns a DB blip into a restart storm; only readiness depends on dependencies and flips false at SIGTERM.
- **Per-process state** — cluster workers, PM2 instances and replicas each have their own memory; rate limits, caches and locks must live in Redis or the database to be global.
- **Proxy trust** — `req.ip` and protocol are spoofable or wrong unless proxy trust is set to the exact hop count or proxy addresses (Fastify `trustProxy`, Express `trust proxy`).
- **Config at boot** — parse `process.env` once with a schema and fail fast; `--env-file` is for local runs, not for production secrets.

## Workflow

1. `node --version`, package manager and lockfile; read `engines`, `type`, tsconfig `module` setting and the start script actually used in production.
2. Map route → hooks, middleware or guards → service → database or client; note where the request context and errors are set.
3. Write the failing in-process test first: valid input, invalid input (expect 400), unauthenticated (401), another user's object (403 or 404), dependency failure.
4. Implement with schemas, timeouts and explicit error mapping; keep framework conventions.
5. Run the proof; then start the built server, not the dev watcher, and exercise the route.
6. Send SIGTERM during a slow request and confirm it completes before the process exits 0.

## Proof

Prefer the project's package.json scripts and CI workflow. Common defaults:

- Install: `npm ci`, `pnpm install --frozen-lockfile` or `bun install --frozen-lockfile`
- Types: `npx tsc --noEmit -p .`
- Lint and format: the configured scripts (`npm run lint`, Biome or ESLint)
- Tests: `npm test` or `npx vitest run`; route tests through inject or `app.request()` without a network listener
- Dependencies: `npm explain <pkg>` for why a version is present; `npm audit --omit=dev`
- Smoke: start `node dist/server.js`, run `curl -fsS localhost:3000/healthz`, post an invalid body to the changed route and expect 400, then `kill -TERM <pid>` mid-request and confirm a clean exit

## Stop and ask

- The change moves Node or the framework to a new major, or switches CJS and ESM.
- It edits global middleware, CORS, auth hooks or error handlers used by every route.
- A dependency must be added for something the framework or Node already provides.
- Proof needs production credentials, third-party sandboxes or data you do not have.

## Before returning

- [ ] Node, framework and plugin versions match the lockfile and `engines`
- [ ] Inputs validated and outputs serialized through schemas or DTOs; no internal fields leak
- [ ] Outbound calls have deadlines; response bodies consumed or cancelled
- [ ] Object-level authorization enforced; request context not stored in module state
- [ ] No floating promises; body size bounded; no sync heavy work in handlers
- [ ] Typecheck, lint and tests pass
- [ ] Built server started; changed route answered valid and invalid input; SIGTERM drained in-flight work (observed)

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Hono](https://hono.dev/docs/), [Fastify](https://fastify.dev/docs/latest/), [NestJS](https://docs.nestjs.com/), [Node.js releases](https://nodejs.org/en/about/previous-releases), [Express 5 migration](https://expressjs.com/en/guide/migrating-5.html).

## Skills in scope

- node-modern — event-loop non-blocking I/O, streams, `AbortSignal` cancellation and worker threads.
- api-design — HTTP status semantics, idempotency keys, pagination and RFC 9457 Problem Details.
- database-development — queries, transactions, pooling and bounded results.
- authentication-sessions — sign-in, sessions, tokens and tenant authorization.
- queues-jobs — background consumers with delivery, retry and shutdown semantics.
- typescript-strict — strict compiler settings and typed boundaries for the service code.
