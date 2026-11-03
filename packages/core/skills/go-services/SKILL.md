---
name: go-services
description: "Go services, workers and CLIs: net/http ServeMux, context cancellation, goroutines, errgroup, database/sql, slog and go.mod toolchains. Use when adding or fixing Go handlers, workers, shutdown or data access, chasing races or goroutine leaks, or bumping the go directive or toolchain. Not for HTTP contract design (use api-design) or container image builds (use docker-deploy)."
trigger: "Use when a change touches go.mod, Go handlers or middleware, goroutine and channel lifecycles, database/sql access or a Go toolchain upgrade."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
paths: ["*.go", "go.mod"]
---

# Go Services

## Selection card
- Task: Implement or repair Go HTTP services, workers and CLIs with correct cancellation and goroutine ownership.
- Start: Read go.mod (the `go` and `toolchain` lines), the `main` package, and the handler or worker being changed.
- Finish: `go vet ./...` and `go test -race` pass, the real binary starts, the changed path answers, and SIGTERM drains cleanly.

## Overview

Go services fail at lifetimes, not syntax: goroutines nobody waits for, contexts that never cancel, servers with zero timeouts, and races only `-race` can see.
Checked stable Go target: 1.27.3 on 2026-10-23. Inspect go.mod/toolchain, dependencies and actual compiler before using release-specific APIs.
Semantics follow the module's `go` directive, not the installed compiler: per-iteration loop variables (1.22), synchronous timer channels (1.23) and container-aware GOMAXPROCS (1.25) apply only when go.mod declares that version or later.

## Rules

1. Every goroutine has an owner that can stop it and waits for it: tie loops to `ctx.Done()`, wait through `errgroup.Group` or `sync.WaitGroup.Go` (1.25+), and never return from the owner while children still run.
2. Pass the caller's `context.Context` into every blocking call (`http.NewRequestWithContext`, `QueryContext`, sends inside `select`). Use `context.WithoutCancel` only for work that must outlive the request, and give it its own deadline.
3. No zero timeouts: set `ReadHeaderTimeout` (plus read, write and idle as the workload allows) on `http.Server` and a `Timeout` on every `http.Client`; never ship `http.DefaultClient` or bare `http.ListenAndServe`.
4. Bound input and fan-out: `http.MaxBytesReader` on bodies, `errgroup.SetLimit` or a semaphore for parallel work, channel buffers sized on purpose.
5. Wrap with `%w` and inspect with `errors.Is`/`errors.As`; never compare error strings. Return a literal `nil`, never a typed nil pointer as an `error`.
6. Close what you open after checking the open error: `defer rows.Close()` then check `rows.Err()`; drain and close `resp.Body` so the connection is reused; check `Close()` errors on files you wrote.
7. Guard or confine shared state. Copying a struct that holds a `sync.Mutex`, map or slice copies a lock or shares the backing data (`go vet` copylocks catches the mutex case).
8. Keep the module's `go` directive, `toolchain` line and dependency majors. A version bump is its own reviewed change.

## First moves by situation

| Situation | First moves |
|---|---|
| New endpoint | Copy a sibling handler's middleware, error and logging conventions; on go ≥ 1.22 the stdlib mux supports `mux.HandleFunc("GET /items/{id}", h)` with `r.PathValue("id")`; do not swap an existing router for it unasked |
| Memory or goroutine growth | Pull `/debug/pprof/goroutine?debug=2` from an internal-only pprof listener; group by stack; look for sends without a `ctx.Done()` case, unclosed bodies, unstopped tickers |
| Flaky or racy test | `go test -race -count=50 -run TestName ./pkg/...`; replace `time.Sleep` with channels or `testing/synctest` (1.25+) |
| Shutdown cuts requests or hangs | `signal.NotifyContext`, then `srv.Shutdown(ctx)` and wait for it to return; stop workers next; close DB pools last |
| Slow queries or pool exhaustion | Log `db.Stats()` (`WaitCount`, `WaitDuration`, `InUse`); find unclosed rows and long transactions; size `SetMaxOpenConns`/`SetConnMaxLifetime` against the server limit |
| Go version upgrade | Read the release notes for every skipped version; bump `go` deliberately; `go mod tidy -diff`; prove the compiler with `GOTOOLCHAIN=local go version` |
| Latency or CPU regression | `go test -bench . -benchmem -count=10` into `benchstat`; CPU profile via pprof; prefer `b.Loop()` (1.24+) in new benchmarks |
| Security review | `govulncheck ./...`; `os.Root` (1.24+) for user-influenced paths; `http.CrossOriginProtection` (1.25+) for cookie-authenticated mutations |

## Patterns and pitfalls

- **ListenAndServe returns first** — once `Shutdown` is called, `ListenAndServe` returns `http.ErrServerClosed` immediately. If `main` exits on that return, in-flight requests are cut. Block on `Shutdown`'s return, with a deadline shorter than the orchestrator's grace period.
- **errgroup context ends at Wait** — the context from `errgroup.WithContext` is canceled on the first error and when `Wait` returns; follow-up work that reuses it fails with `context canceled`.
- **`wg.Add` inside the goroutine** — races with `Wait`. Increment with `wg.Add(1)` before the `go` statement, or switch to `wg.Go` (1.25+); the 1.25 vet waitgroup analyzer reports the misplaced form.
- **Blocked-send leak** — a producer sending to a channel whose reader returned early blocks forever. Every send that can outlive its reader sits in a `select` with `<-ctx.Done()`.
- **Transaction pins a connection** — inside `BeginTx`, calling `db.QueryContext` instead of `tx.QueryContext` needs a second connection; with a small pool that deadlocks under load and silently escapes the transaction.
- **Panics outside handler goroutines** — `net/http` recovers panics in the handler goroutine only. A panic in a goroutine spawned from a handler or worker kills the process; recover at each goroutine root that runs untrusted work.
- **Body reuse** — an unread or unclosed `resp.Body` blocks keep-alive reuse and leaks sockets; when ignoring a body, `io.Copy(io.Discard, io.LimitReader(resp.Body, n))` then `Close`.
- **Lenient JSON decoding** — `json.Decoder` accepts unknown fields and trailing data. Enable `dec.DisallowUnknownFields()` where the contract requires it and confirm a second `Decode` returns `io.EOF`. The `omitzero` tag (1.24+) omits zero structs and `time.Time`; `encoding/json/v2` started as a GOEXPERIMENT, so check its status before adopting it.
- **Typed nil interface** — `var p *MyErr; return p` yields a non-nil `error`; callers take the failure branch on success.
- **Timers in loops** — `time.After` in a hot `select` loop allocates a timer per iteration. Reuse one `time.NewTimer` or `Ticker` and `Stop()` it; the 1.23 stop/reset guarantees need go ≥ 1.23 in go.mod.
- **Silent toolchain switching** — a `toolchain` line or newer `go` directive makes the go command download a different compiler (`GOTOOLCHAIN=auto`), so CI and laptops can build with different versions. Check `go version` and `go env GOTOOLCHAIN` in CI output.
- **Structured logs** — `log/slog` with `InfoContext(ctx, ...)` keeps trace correlation; never log request bodies, tokens or DSNs.

## Workflow

1. `go env GOVERSION GOTOOLCHAIN GOFLAGS`; read go.mod `go`/`toolchain`; `go list -m all` for the key dependencies.
2. Map the path: `main` → server or mux → middleware → handler → store; note how shutdown and config loading are wired.
3. Write the failing test first: table-driven, `httptest.NewRecorder` or `httptest.NewServer`; for concurrency use channels or `synctest.Test` (1.25+), never sleeps.
4. Implement with context, timeouts, bounded fan-out and explicit close paths.
5. Run the proof commands, then the race detector on the touched packages with `-count` above 1.
6. Start the real binary, hit the changed path, send SIGTERM and observe a clean drain and exit code 0.

## Proof

Prefer the project's Makefile, Taskfile or CI workflow. Common defaults:

- Format: `gofmt -l .` prints nothing (or `goimports -l .` if the project uses it)
- Vet and lint: `go vet ./...`, then `staticcheck ./...` or `golangci-lint run` (v2 config needs `version: "2"`; convert v1 files with `golangci-lint migrate`)
- Tests: `go test -race -count=1 ./...` (`-count=1` bypasses the cache; add `-shuffle=on` to expose order dependence)
- Modules: `go mod tidy -diff` (1.23+) exits non-zero when go.mod/go.sum are stale; `go mod verify`
- Vulnerabilities: `govulncheck ./...` reports only reachable vulnerable symbols
- Build: `go build -trimpath -o bin/app ./cmd/app` with the project's CGO and ldflags settings
- Smoke: start `./bin/app`, run `curl -fsS localhost:8080/healthz` and the changed route, then `kill -TERM <pid>` and confirm in-flight requests finished

## Stop and ask

- The change bumps the `go` directive, adds a `toolchain` line, or moves a dependency to a new major version.
- It swaps the router, ORM, logger or DI wiring, or adds cgo to a static build.
- A race or leak only reproduces against production infrastructure or credentials you do not have.
- A schema change drops or rewrites data (hand off to database-migrations).

## Before returning

- [ ] `go`/`toolchain` lines unchanged or the bump is explained; `go mod tidy -diff` is clean
- [ ] Every new goroutine has a stop condition and an owner that waits for it
- [ ] Context reaches every new blocking call; server and clients have explicit timeouts
- [ ] Request bodies bounded; rows and response bodies closed; errors wrapped with `%w`
- [ ] `go vet ./...` and `go test -race -count=1 ./...` pass with no sleep-based synchronization
- [ ] Real binary started, changed path exercised, SIGTERM drained and exited 0 (observed, not assumed)

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Go releases](https://go.dev/dl/?mode=json), [Go documentation](https://go.dev/doc/), [Go release notes](https://go.dev/doc/devel/release).

## Skills in scope

- api-design — HTTP routing contracts, JSON decoding bounds, status and error contracts.
- observability — `log/slog` handlers, OpenTelemetry trace propagation and Prometheus metrics.
- testing — table-driven tests, `testing/synctest`, deterministic barriers and `-race` verification.
- docker-deploy — multi-stage static or distroless Go builds and container signal handling.
- database-development — `database/sql` queries, transactions and pool sizing behind the handlers.
- queues-jobs — worker delivery, retry and shutdown semantics for Go consumers.
