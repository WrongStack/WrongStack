---
name: dotnet-backend
description: "ASP.NET Core and .NET services: Minimal APIs, controllers, DI lifetimes, EF Core, BackgroundService, Options and ProblemDetails. Use when adding or fixing .NET endpoints, hosted workers, EF Core queries or migrations, configuration, or moving a project to a newer TargetFramework or SDK. Not for HTTP contract design (use api-design) or sign-in flows (use authentication-sessions)."
trigger: "Use when a change touches *.csproj, Program.cs, appsettings*.json, ASP.NET Core endpoints, EF Core DbContexts or hosted services."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
paths: ["*.csproj", "appsettings*.json", "Program.cs"]
---

# Dotnet Backend

## Selection card
- Task: Implement or repair ASP.NET Core APIs, hosted workers and EF Core persistence.
- Start: Read global.json, the .csproj (TargetFramework, Directory.Packages.props), Program.cs and the endpoint or service being changed.
- Finish: build with warnings as errors, tests and format check pass, and the published artifact starts and answers the changed route.

## Overview

ASP.NET Core bugs live in lifetimes: a scoped `DbContext` captured by a singleton, a request token never passed down, a crashing hosted service, a retry strategy that breaks your transaction.
Checked 2026-11-02: .NET stable SDK 10.0.403 and runtime 10.0.14. .NET 11 RC is a preview, not the stable target. Verify framework/package compatibility before upgrade.
.NET 10 is the current LTS; .NET 8 LTS support ends in November 2026, so net8.0 projects need a planned move rather than another patch.

## Rules

1. Never let a singleton or `BackgroundService` hold a scoped service. Create `await using var scope = scopeFactory.CreateAsyncScope()` per unit of work. `ValidateScopes`/`ValidateOnBuild` run only in Development by default, so captive dependencies pass in production silently.
2. Pass `CancellationToken` end to end (`ToListAsync(ct)`, `SaveChangesAsync(ct)`, `HttpClient`) and never block on async (`.Result`, `.Wait()`, `GetAwaiter().GetResult()`); sync-over-async starves the thread pool under load.
3. Bind and return explicit DTOs (`record` types), never EF entities. Prefer `TypedResults` in Minimal APIs so OpenAPI metadata and status codes stay accurate.
4. One `DbContext` per unit of work and never shared across concurrent tasks; parallel reads need `IDbContextFactory<T>`. Use `AsNoTracking()` for reads and a concurrency token (`IsRowVersion` or `IsConcurrencyToken`) where writers can race.
5. Outbound HTTP goes through `IHttpClientFactory` (typed or named clients) with explicit timeouts and resilience (`AddStandardResilienceHandler`); never `new HttpClient()` per call, never inject a typed client into a singleton.
6. Configuration binds through `AddOptions<T>().Bind(...).ValidateDataAnnotations().ValidateOnStart()` so bad settings fail at boot, not on first request. Secrets come from user-secrets, environment or a vault.
7. Errors leave as `ProblemDetails`: `AddProblemDetails()` plus `UseExceptionHandler()` or an `IExceptionHandler`; no stack traces or exception messages outside Development.
8. Keep the SDK pin, TargetFramework and central package versions. A framework or major EF upgrade is its own change.

## First moves by situation

| Situation | First moves |
|---|---|
| New endpoint | Copy a sibling's route group, auth policy (`RequireAuthorization`) and filters; on .NET 10, check whether the project uses built-in Minimal API validation (`AddValidation()`) or FluentValidation and stay consistent |
| `ObjectDisposedException` / "a second operation was started on this context" | A `DbContext` used after its scope ended or by two tasks at once; look for fire-and-forget `Task.Run`, captured contexts in singletons, unawaited calls |
| Slow endpoint | Enable EF logging (`LogTo` or `Microsoft.EntityFrameworkCore.Database.Command`); count queries; fix N+1 with `Include`/projection; `AsSplitQuery()` for multi-collection includes |
| Host exits after a worker throws | Since .NET 6 an unhandled `BackgroundService` exception stops the host (`BackgroundServiceExceptionBehavior.StopHost`); catch per iteration, log, back off |
| Framework or SDK upgrade | Read the breaking-change list for every skipped version; update global.json, TFM and packages together; `dotnet list package --outdated`; rerun EF model checks |
| Migration added | `dotnet ef migrations has-pending-model-changes`; read `dotnet ef migrations script --idempotent`; from EF Core 9, `Migrate()` throws when the model has unmigrated changes |
| Wrong client IP or scheme behind a proxy | `UseForwardedHeaders` trusts only loopback by default; configure known proxies or networks for the real load balancer |
| Security review | `dotnet list package --vulnerable --include-transitive`; authorization on every route group; antiforgery on form endpoints; rate limiter on auth routes |

## Patterns and pitfalls

- **Retry strategy vs transactions** — with `EnableRetryOnFailure`, a user-started `BeginTransactionAsync` throws `InvalidOperationException`; wrap the whole unit in `db.Database.CreateExecutionStrategy().ExecuteAsync(...)` so the retry replays the full transaction.
- **Bulk ops skip the tracker** — `ExecuteUpdateAsync`/`ExecuteDeleteAsync` go straight to SQL: no `SaveChanges` interceptors, no automatic concurrency check, and already-tracked entities keep stale values.
- **Context pooling** — `AddDbContextPool` reuses instances; per-request state stored in context fields (tenant id, user) leaks across requests unless reset. Use a scoped service or query filters fed from it.
- **Global query filters** — tenant or soft-delete filters are bypassed by `IgnoreQueryFilters()` and by raw SQL; test both paths with two tenants.
- **Typed clients in singletons** — a typed client captured by a singleton pins one handler forever and stops seeing DNS changes; keep consumers transient/scoped or use a singleton `HttpClient` with `SocketsHttpHandler.PooledConnectionLifetime`.
- **Shutdown budget** — `HostOptions.ShutdownTimeout` defaults to 30 seconds; workers must honor `stoppingToken` and finish within it, and the container grace period must exceed it.
- **Form endpoints and antiforgery** — Minimal API endpoints binding `[FromForm]` require antiforgery tokens by default (.NET 8+); `DisableAntiforgery()` only for non-cookie authenticated callers.
- **System.Text.Json web defaults** — camelCase, case-insensitive and numbers-from-strings are on for web; nullable-annotation enforcement (`RespectNullableAnnotations`, .NET 9+) is opt-in, so non-nullable properties still accept `null` unless enabled.
- **Request size** — Kestrel caps bodies near 30 MB by default; uploads need explicit `RequestSizeLimit` and streaming, not `IFormFile` buffering of large files.
- **Native AOT** — `CreateSlimBuilder` and source-generated `JsonSerializerContext` are mandatory; treat IL2026/IL3050 trim warnings as errors, because reflection-based libraries fail only at runtime.
- **Testable time** — inject `TimeProvider` (.NET 8+) instead of `DateTime.UtcNow`, then drive it with `FakeTimeProvider` in tests.

## Workflow

1. `dotnet --info` and global.json (`rollForward`); read TFMs, Directory.Build.props, Directory.Packages.props and packages.lock.json if present.
2. Map the path: route group → filters/auth → handler or controller → service → `DbContext` or client; note registration lifetimes in Program.cs.
3. Write the failing test first: `WebApplicationFactory<Program>` integration test (expose `Program` with `public partial class Program;`) against a real database container where the project already does.
4. Implement with DTOs, cancellation, scoped work units and ProblemDetails errors.
5. For schema changes, add a migration and read the SQL before applying it anywhere shared.
6. Run the proof, publish, start the artifact and hit the changed route.

## Proof

Prefer the project's scripts and CI workflow. Common defaults:

- Restore: `dotnet restore --locked-mode` when packages.lock.json exists
- Build: `dotnet build -c Release -p:TreatWarningsAsErrors=true`
- Format: `dotnet format --verify-no-changes`
- Tests: `dotnet test -c Release --no-build`
- Packages: `dotnet list package --vulnerable --include-transitive` and `dotnet list package --outdated`
- EF Core: `dotnet ef migrations has-pending-model-changes` and `dotnet ef migrations script --idempotent -o migrate.sql`
- Smoke: `dotnet publish -c Release -o out`, start the published entry assembly, then `curl -fsS localhost:5000/healthz` (a `MapHealthChecks` route) and the changed route; stop with SIGTERM and watch workers finish

## Stop and ask

- The change moves TargetFramework, SDK major, or EF Core major, or turns on Native AOT or trimming.
- A migration drops, renames or rewrites data, or would run against a shared or production database.
- It changes authentication schemes, cookie settings or authorization policies used beyond the touched route.
- Proof needs Azure, a vault or production credentials not available locally.

## Before returning

- [ ] global.json, TFM and central package versions intended; restore in locked mode passes
- [ ] No scoped service captured by a singleton or hosted service; scopes created per unit of work
- [ ] `CancellationToken` passed through all new async I/O; no sync-over-async
- [ ] Endpoints bind and return DTOs; errors leave as ProblemDetails without internals
- [ ] EF changes: tracking, concurrency and retry strategy considered; migration SQL read
- [ ] Build (warnings as errors), format check and tests pass
- [ ] Published artifact started, changed route answered, graceful stop observed

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/), [.NET releases](https://dotnet.microsoft.com/en-us/download/dotnet), [EF Core](https://learn.microsoft.com/en-us/ef/core/), [.NET breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/breaking-changes).

## Skills in scope

- api-design — Minimal API and controller contracts, ProblemDetails (RFC 9457) and OpenAPI.
- database-development — EF Core queries, transactions, isolation and bounded results.
- database-migrations — EF Core migrations that must deploy without downtime.
- authentication-sessions — sign-in, cookies, tokens and tenant authorization.
- testing — `WebApplicationFactory<TEntryPoint>` integration tests and database fixtures.
- queues-jobs — hosted consumers with delivery, retry and shutdown semantics.
