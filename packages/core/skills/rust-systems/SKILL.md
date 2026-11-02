---
name: rust-systems
description: "Rust services, CLIs and crates with Tokio, Axum, serde, sqlx, thiserror and Cargo workspaces: async tasks, errors, unsafe, MSRV. Use when adding or fixing Rust handlers, async tasks, channels, error types, serde contracts or unsafe/FFI code, or moving edition, MSRV or crate majors. Not for HTTP contract design (use api-design) or container builds (use docker-deploy)."
trigger: "Use when a change touches Cargo.toml, Rust source, Tokio tasks or channels, Axum extractors, serde types or an edition/MSRV upgrade."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
paths: ["*.rs", "Cargo.toml"]
---

# Rust Systems

## Selection card
- Task: Implement or repair Rust services, CLIs and libraries with sound ownership, async and error contracts.
- Start: Read Cargo.toml (edition, `rust-version`, features, workspace resolver), `rust-toolchain.toml`, and the crate entrypoint being changed.
- Finish: fmt, clippy with `-D warnings` and tests pass on the declared toolchain, and the real binary serves or exits as specified.

## Overview

Rust moves memory bugs to compile time but leaves the expensive ones at runtime: futures dropped mid-operation, tasks that silently detach, blocking calls on async workers, and panics on input the compiler never saw.
Checked stable Rust target: 1.99.1 on 2026-10-23. Verify rust-version, edition, workspace/toolchain pins and crate support before upgrading.
Edition 2024 (Rust 1.85+) changed temporary drop order in `if let` and tail expressions, made `std::env::set_var` unsafe, requires `#[unsafe(no_mangle)]`, and defaults to the MSRV-aware resolver ("3").

## Rules

1. No `.unwrap()`, `.expect()`, slice indexing or truncating `as` casts on untrusted input, I/O or arithmetic. Release builds wrap integer overflow silently unless `overflow-checks` is on; use `checked_*` and `TryFrom`.
2. Never hold a `std::sync::MutexGuard`, `RefCell` borrow or `Rc` across `.await`. The resulting "future cannot be sent between threads safely" error is the signal: scope the guard in a block that ends before the await, or switch to `tokio::sync::Mutex` only when the lock must span it.
3. Every `.await` inside `tokio::select!` is a cancellation point: the losing branch's future is dropped mid-operation. In loops, select only on cancel-safe operations (`mpsc::Receiver::recv`, `CancellationToken::cancelled`) and pin long-running futures outside the loop.
4. Blocking work (`std::fs`, CPU-heavy parsing, sync drivers, `std::thread::sleep`) goes to `tokio::task::spawn_blocking` or a dedicated pool; on a runtime worker it stalls every task scheduled there.
5. Every spawned task is owned. Dropping a `JoinHandle` detaches the task, it does not cancel it; hold tasks in a `JoinSet` (aborts on drop) or `TaskTracker` with a `CancellationToken`, and await them on shutdown.
6. Bound channels and concurrency: `mpsc::channel(n)`, `Semaphore`, `buffer_unordered(n)`. `unbounded_channel` needs a proven upstream bound.
7. Libraries expose typed error enums (`thiserror`); applications add context (`anyhow::Context`). Map errors to safe public responses; never send `Debug` output of internal errors to clients.
8. Every `unsafe` block carries a `// SAFETY:` comment naming the invariant it relies on; in edition 2024, unsafe operations inside an `unsafe fn` still need their own `unsafe {}` block.
9. Respect `rust-version`, edition and feature flags. Features must be additive: Cargo unifies them across the graph, so a feature that removes API breaks other dependents.

## First moves by situation

| Situation | First moves |
|---|---|
| New Axum route | Axum 0.8 paths use `/{id}` and `/{*rest}` (0.7 used `/:id`); the body-consuming extractor (`Json`, `Bytes`, `Form`) must be last; return `Result<impl IntoResponse, AppError>` with one `IntoResponse` impl for the error type |
| "future is not `Send`" | Find the `!Send` value alive across `.await` (std guard, `Rc`, `RefCell` borrow, raw pointer); end its scope before the await rather than wrapping it |
| Latency collapse under load | Look for blocking calls in async fns (`std::fs`, sync DB, heavy serde, `block_on`); tokio-console needs `--cfg tokio_unstable` plus console-subscriber |
| Memory growth | Unbounded channels, detached tasks, per-connection buffers never shrunk; profile with heaptrack or dhat |
| Edition or MSRV upgrade | `cargo fix --edition`, then set `edition = "2024"`; review `if let` on lock guards and Drop-sensitive code; prove with `cargo +<rust-version> check --workspace` |
| Dependency major bump | `cargo tree -i <crate>` for duplicate majors; read the changelog; `cargo semver-checks` for published library crates |
| Unsafe or FFI review | `cargo +nightly miri test -p <crate>` on pure-Rust parts; check aliasing, alignment and raw-pointer lifetimes; `unsafe extern` blocks in 2024 |
| sqlx macros fail in CI | `query!` needs `DATABASE_URL` or offline data: commit `.sqlx/` from `cargo sqlx prepare` and set `SQLX_OFFLINE=true` |

## Patterns and pitfalls

- **select! re-creating futures** — `loop { select! { m = rx.recv() => .., _ = sleep(d) => .. } }` builds a fresh `sleep` every iteration, so a busy channel means the timeout never fires. Create the deadline once and `tokio::pin!` it. `read_exact` and `read_to_end` are not cancel-safe; tokio docs state cancel safety per method.
- **Edition 2024 drop order** — in 2021 the guard from `if let Some(v) = m.lock().unwrap().get(k)` lived through `else` (a classic self-deadlock); 2024 drops it before `else`. Migration changes when guards and other `Drop` types release, so review that code by hand.
- **Axum body limits** — `DefaultBodyLimit` (2 MB) covers `Json`, `Bytes`, `Form` and `String` extractors, not handlers streaming the raw `Body`; add `RequestBodyLimitLayer` from tower-http there.
- **Graceful shutdown waits forever** — `axum::serve(..).with_graceful_shutdown(signal)` waits for every connection, including SSE and WebSocket streams; race it against a hard timeout and cancel stream tasks with a token.
- **Async fn in traits** — native `async fn` in traits (1.75+) is not dyn-compatible and does not promise `Send` futures; public traits used on multi-threaded runtimes need `-> impl Future<Output = T> + Send` or `trait_variant`, and `dyn` use still needs `async_trait` or boxing.
- **serde boundaries** — `deny_unknown_fields` does not work together with `flatten`; `#[serde(default)]` hides missing required data; untagged enums try every variant and produce vague errors. serde_json stops at recursion depth 128 by default.
- **Mutex choice and poisoning** — std `Mutex` beats `tokio::sync::Mutex` for short synchronous sections. A panic while holding a std lock poisons it; decide whether `lock()` errors propagate or recover with `into_inner()`.
- **Drop cannot await** — a tokio `File` or `BufWriter` dropped without `flush().await` or `shutdown().await` can lose buffered bytes; durable writes need an explicit async close path.
- **Spans across await** — holding `span.enter()` across `.await` attributes other tasks' events to the span; use `.instrument(span)` or `#[tracing::instrument]`.
- **Virtual workspace resolver** — a virtual manifest does not infer the resolver from member editions; set `workspace.resolver` explicitly or dev-dependency features leak into normal builds.
- **Panics in tasks** — a panic inside `tokio::spawn` surfaces only as `JoinError` when someone awaits the handle; with `panic = "abort"` it kills the process instead. Pick deliberately and log `JoinError::is_panic`.

## Workflow

1. `rustc --version`, `cargo --version`, read `rust-toolchain.toml`, edition, `rust-version`, workspace members and default features.
2. Map the path: binary `main` → runtime and router → extractor or task → domain → storage; note who owns each spawned task.
3. Write the failing test first: `#[tokio::test]` (with `start_paused = true` for time-dependent logic), `tower::ServiceExt::oneshot` against the router, or a unit test at the domain boundary.
4. Implement with typed errors, bounded channels and explicit cancellation; keep wire types separate from domain types.
5. Run the proof commands for the declared toolchain and the feature sets CI builds.
6. Start the real binary, hit the changed path, send SIGINT/SIGTERM and observe tasks drain and buffers flush.

## Proof

Prefer the project's `justfile`, Makefile, `xtask` or CI workflow. Common defaults:

- Format: `cargo fmt --all -- --check`
- Lint: `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- Tests: `cargo test --workspace --all-features`, or `cargo nextest run --workspace` plus `cargo test --doc` (nextest skips doctests)
- Lockfile: `cargo build --locked` fails if Cargo.lock would change
- Features (libraries): `cargo hack check --feature-powerset --no-dev-deps`
- MSRV: `cargo +<rust-version> check --workspace --all-features`
- Supply chain: `cargo deny check` or `cargo audit`
- Unsafe: `cargo +nightly miri test -p <crate>`
- Smoke: `cargo run --release -p <service>`, then `curl -fsS localhost:3000/healthz` and the changed route; send SIGTERM and confirm a clean exit

## Stop and ask

- The change bumps edition or `rust-version`, or adds new `unsafe`, FFI or `build.rs` native linking.
- It replaces the async runtime, web framework or serialization format.
- It changes the public API of a published crate (semver impact) or removes a feature flag.
- Verification needs production credentials, or a schema change drops data (hand off to database-migrations).

## Before returning

- [ ] Edition, `rust-version` and feature flags respected; Cargo.lock changes intended (`--locked` passes)
- [ ] No new `unwrap`/`expect`/indexing on external input; overflow-sensitive math checked
- [ ] No std guard or `!Send` value held across `.await`; `select!` branches cancel-safe
- [ ] Spawned tasks owned (`JoinSet`/`TaskTracker`) and drained on shutdown; channels bounded
- [ ] Every new `unsafe` block has a concrete `// SAFETY:` invariant (Miri run where applicable)
- [ ] fmt, clippy `-D warnings` and tests pass; real binary started and the changed path observed

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Rust stable manifest](https://static.rust-lang.org/dist/channel-rust-stable.toml), [Rust book](https://doc.rust-lang.org/book/), [Edition guide](https://doc.rust-lang.org/edition-guide/), [Tokio docs](https://docs.rs/tokio/latest/tokio/).

## Skills in scope

- api-design — Axum or Tonic route contracts, Problem Details responses and serde wire formats.
- testing — unit, property, async cancellation and Miri/sanitizer harnesses.
- observability — `tracing` spans, structured fields and OpenTelemetry subscribers.
- docker-deploy — cached cargo multi-stage builds, minimal runtime images and signal handling.
- database-development — sqlx or Diesel queries, transactions and pool sizing.
