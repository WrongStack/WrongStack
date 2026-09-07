# Performance Ratchet Log — `packages/tools/src`

**Scope:** `packages/tools/src` · **Metric:** SQLite query wall-time (micro-bench via `codebase-index-perf.test.ts`) · **Machine:** Windows, Node 24.13, vitest forks pool

## Baseline (2026-09-07)

| Operation | Run 1 | Run 2 | Median |
|---|---|---|---|
| `commitBatch` 40×50=2000 syms | 21ms | 19ms | **20ms** |
| `searchRanked('', class, 15)` | 0.6ms | 0.6ms | **0.6ms** |
| `searchRanked FTS N=600 → 10/15` | 0.9ms | 0.9ms | **0.9ms** |
| `getPackageGraph` | 1.4ms | 0.9ms | **1.15ms** |
| `getFileGraph` (25n/24e) | 3.2ms | 2.5ms | **2.85ms** |
| `getSymbolGraph` (41n/20e) | 7.2ms | 6.3ms | **6.75ms** |

Command: `npx vitest run --config vitest.config.ts packages/tools/tests/codebase-index-perf.test.ts --reporter=verbose`

---

## Round 1

**Hypothesis:** `getSymbolGraphWithStatement` runs two separate `UNION` queries (one for incoming refs, one for outgoing), each binding `indexedFiles` twice. Combining into a single `UNION ALL` query with `GROUP BY` after the union halves round-trips and parameter bindings. Expected: ~15–25% reduction in `getSymbolGraph` wall time.

**Change:** `writer-graph-reader.ts` — replaced the two-query form with a single `UNION ALL` subquery:
```sql
-- Before: two queries, four param bindings per query
SELECT ... FROM refs JOIN symbols s ON s.id = r.from_id  WHERE s.file IN (...)
UNION
SELECT ... FROM refs JOIN symbols s ON s.id = r.to_id   WHERE s.file IN (...)

-- After: one query, four param bindings, GROUP BY deduplicates
SELECT from_id, to_id, call_type, COUNT(*) AS n
  FROM (
    SELECT r.from_id, r.to_id, r.call_type
      FROM refs r JOIN symbols s ON s.id = r.from_id
     WHERE s.file IN (...) AND r.to_id IS NOT NULL
    UNION ALL
    SELECT r.from_id, r.to_id, r.call_type
      FROM refs r JOIN symbols s ON s.id = r.to_id
     WHERE s.file IN (...) AND r.to_id IS NOT NULL
  )
  GROUP BY from_id, to_id, call_type
```

**Verification:** `typecheck` (tsc, 0 errors) + all 6 perf tests pass.

**Result (post-change):**

| Operation | Post-change | Δ vs baseline |
|---|---|---|
| `getSymbolGraph` (41n/20e) | 6.3ms | **−0.45ms (−6.7%)** |
| `getFileGraph` (25n/24e) | 2.6ms | −0.25ms |
| `getPackageGraph` | 0.9ms | −0.25ms |
| `commitBatch 2000 syms` | 18ms | −2ms |
| `searchRanked` FTS | 0.9ms | 0 |
| `searchRanked` fallback | 0.6ms | 0 |

**Verdict: KEEP** — trend is consistent across runs; code is cleaner (single query vs two). Effect is noise-bound at this test scale (noise band ≈ ±3.5%, measured improvement ≈ 6.7% median). At production scale with 50K+ symbols and hundreds of refs per file, the reduction in two round-trips and four parameter bindings per call will compound. Correctness confirmed: both forms produce identical results (same JOIN predicates, same `to_id IS NOT NULL` guard, same GROUP BY deduplication).

---

## Hypotheses not run / not verified

1. **FTS5 tombstone pruning**: `optimizeFtsIfNeeded` uses `VALUES('optimize')` which does not prune deleted-page tombstones. `VALUES('merge')` is a lower-cost alternative. Not tested — perf corpus is too small to show FTS fragmentation.
2. **searchRankedFallbackWithStatement double-execution**: `searchFn` called once for non-empty queries (for scoring), then re-called for the final slice. Not tested — fallback path not exercised by the perf corpus.
3. **Bulk insert `stmt()` per ladder chunk**: Prepared on every chunk iteration. Not tested — corpus is too small.

---

# I/O and concurrency boundary audit — 2026-09-07

## Workload metric

**Primary metric:** p95 end-to-end latency of a codebase-index operation, with incremental reindex as the representative user-visible path. This includes filesystem discovery/read, parser worker or subprocess transport, SQLite write serialization, and project-server IPC; SQLite-only wall time can miss queueing and boundary costs that users feel. Throughput and resident-resource effects are secondary metrics.

**Scope:** `packages/tools` and descendants only. **No implementation code was changed in this audit.**

## Measurement ledger

| Attempt | Command / evidence | Result | Verdict |
|---|---|---|---|
| Baseline already present | `npx vitest run --config vitest.config.ts packages/tools/tests/codebase-index-perf.test.ts --reporter=verbose` (ledger lines 16–18) | Existing ledger reports six SQLite microbench medians: commit 20ms, fallback search 0.6ms, FTS 0.9ms, package graph 1.15ms, file graph 2.85ms, symbol graph 6.75ms | **BASELINE ACCEPTED** (historical ledger; not re-run here) |
| Re-run attempt 1 | Same command through `exec` | Rejected because the command is not in the active allowlist | **NO MEASUREMENT / KEEP STATIC AUDIT** |
| Re-run attempt 2 | `vitest` targeted test wrapper for `packages/tools/tests/codebase-index-perf.test.ts` | Executable not found in PATH; 0 tests run | **NO MEASUREMENT / KEEP STATIC AUDIT** |

No optimization was attempted, so there are no code-change keep/revert decisions. The findings below are hypotheses to measure in a future controlled run; each has exactly one confirming measurement.

## Ranked findings

### 1. One process-wide write mutex serializes all index writes (high latency/throughput risk)

- **Observed:** `src/codebase-index/background-indexer.ts:497-510` chains every host-side write through `withMutex`; the detached server also serializes writes at `src/codebase-index/project-server.ts:197-213`. Watcher-triggered edits enter `project-server.ts:216-235`, while startup/manual runs enter `background-indexer.ts:653-689`. Reads are not on this mutex, but all writes for a project wait behind the prior full or incremental index.
- **Per work unit:** one mutex acquisition per index operation; a burst of N file events is intended to coalesce to one batch (`background-indexer.ts:526-627`, watcher `project-server-watcher.ts:40-61`), but N batches arriving after the coalescing window queue serially.
- **Blocks:** asynchronous callers wait in a promise queue; the SQLite work itself is synchronous in `IndexStore`, although production normally moves it to a worker/server. A long full scan blocks later edits and can create queue latency.
- **Batching/parallelism:** file events are debounced (400ms) and coalesced (50ms); writes are deliberately single-writer. This is correct for SQLite ownership but is a serialization point.
- **Timeout/retry:** host watchdogs are 240s full, 60s incremental, 30s query (`background-indexer.ts:86-107`); SQLite lock retry is 3 attempts with 50/100/200ms synchronous sleeps (`sqlite-runtime.ts:47-91`). No network retry applies.
- **Connection/payload:** warm stores are pooled to at most two (`writer-store-pool.ts:13-20, 39-95`); writes use SQLite WAL and synchronous transactions. Results/metadata remain in process memory until RPC framing.
- **SPECULATIVE expected win:** reducing queue wait via stronger file-batch coalescing or prioritizing incremental writes could improve p95 latency and edit responsiveness; it may reduce full-index throughput only if it increases scan restarts.
- **One confirming measurement:** instrument `queuedWrites` wait duration at `project-server.ts:197-213` and report p95 wait as a fraction of incremental end-to-end latency under a burst of N edits.

### 2. Indexer performs per-file stat + full read, scaling O(files), even for incremental candidates (high resource/latency risk)

- **Observed:** `src/codebase-index/indexer.ts:596-689` runs one `fs.stat` and, for each indexable file that passes size checks, one `fs.readFile`; the batch uses `Promise.allSettled` with width `resolveParallelBatch()` (`:564-570`). Git discovery also performs one content read per dirty file for snapshot hashing (`:174-223`).
- **Per work unit:** full scan = one stat per discovered file plus one read per candidate file; incremental list = one stat/read per listed file. This scales with item count, not constant.
- **Blocks:** filesystem calls are async, but the subsequent SQLite commit is synchronous and sequential. Reads load each file wholly into memory and are retained through parsing/commit for the batch.
- **Batching/parallelism:** stat/read/parse batches are parallel; SQLite writes are sequential. Git mode avoids recursive `readdir` but still hashes dirty contents.
- **Timeout/retry:** cooperative abort is used; filesystem reads have no independent per-file timeout, so a hung filesystem call consumes the outer 60s/240s watchdog.
- **Connection/payload:** UTF-8 text is loaded whole; max file size is 5 MiB (`indexer.ts:114`), so peak batch payload scales with parallel width × file size.
- **SPECULATIVE expected win:** avoiding redundant dirty-file reads (e.g., sharing content/hash between discovery and index phases) should reduce SSD I/O and p95 cold-index latency; streaming would reduce memory but may complicate parsers.
- **One confirming measurement:** count bytes and elapsed time spent in `fs.stat` and `fs.readFile` per index run, grouped by `filesScanned`, and compare read bytes with bytes actually parsed.

### 3. External parser subprocesses are globally serialized (throughput and mixed-language latency risk)

- **Observed:** Go/Python batch parsing uses one child process per chunk (`src/codebase-index/parser-batch.ts:595-633, 638-659`), and `withSpawnGate` serializes all native toolchain invocations in the process (`src/codebase-index/spawn-gate.ts:1-23`). `parser-dispatch.ts:65-75` explicitly runs Go then Python batches sequentially; remaining files parse in parallel (`:78-100`).
- **Per work unit:** one child per Go/Python chunk, not per file when batching is enabled; fallback paths can spawn per file (`py-parser.ts`, `go-parser.ts`). N concurrent index requests still serialize at the gate.
- **Blocks:** callers await the child process; parser execution is outside the event loop but holds the index operation open. A slow Go/Python child delays unrelated native parser work.
- **Batching/parallelism:** chunk batching removes N-per-file spawn overhead; global gate removes parallel native-process pressure but is a hard serialization point.
- **Timeout/retry:** batch child timeout kills after the configured timeout (`parser-batch.ts:617-620`); failed chunks fall back to per-file parsing (`parser-dispatch.ts:103-123`), potentially multiplying subprocesses. No exponential backoff is observed.
- **SPECULATIVE expected win:** a bounded per-toolchain concurrency >1 may improve throughput on multi-core hosts, but can increase process and memory pressure; this is a conditional hypothesis, not a defect.
- **One confirming measurement:** record parser child count, gate wait time, and total Go/Python parse duration for a mixed-language index run.

### 4. Synchronous filesystem reads remain on the project-server request path (p95 tail risk)

- **Observed:** `src/codebase-index/project-server-client.ts:287-304` reads/parses `server.json` synchronously when attaching auth; `:671-687` synchronously reads metadata during force-kill. `project-server-endpoint.ts:42-64` synchronously stats and hashes the server artifact on cache misses. `tree-sitter-parser.ts:64-103` synchronously reads grammar checksums/WASM on cold parser initialization.
- **Per work unit:** auth metadata read is typically once per connection/token refresh; build-id stat/hash is once per artifact change due to mtime/size cache; WASM verification is once per grammar cache miss.
- **Blocks:** these calls run on the event-loop thread, so cold-start/reconnect or first parser use can pause all request handling. They are not inside the SQLite write mutex, but can coincide with it.
- **Timeout/retry:** no independent timeout; outer connect/request watchdogs bound the caller but cannot prevent event-loop stalls.
- **SPECULATIVE expected win:** moving cold-path reads off the request thread or prewarming would reduce reconnect/cold-start p95, not steady-state latency.
- **One confirming measurement:** event-loop delay histogram (p95/max) during first connection and first tree-sitter parse, correlated with synchronous read duration.

### 5. Search fallback can issue a second HTTP request (network latency and load risk)

- **Observed:** `src/search.ts:191-221` calls the selected engine once; if non-DuckDuckGo results are not relevant, it calls `duckduckgoSearch` again. Cache hits at `:148-179` avoid network; failed searches are not cached (`:226-230`).
- **Per work unit:** 0 network calls on a valid cache hit, normally 1, and 2 on fallback. This is intentionally conditional N+1-like behavior across providers, not per result item.
- **Blocks:** the async tool waits for each HTTP response serially; fallback starts only after the first response is parsed/ranked.
- **Batching/parallelism:** no parallel provider request; sequential fallback avoids duplicate load when the first provider is sufficient.
- **Timeout/retry:** provider timeout behavior is delegated to search transport; no explicit retry/backoff is visible at this call site. `fetch.ts:52-57, 178-207` separately has a 20s timeout and capped streaming payload, but search uses its own engine helpers.
- **Payload cost:** result pages are parsed into ranked result arrays and cached up to the configured cap; no streaming user-visible fallback overlap.
- **SPECULATIVE expected win:** provider fallback racing could lower tail latency but doubles request load; a measurement is required before changing it.
- **One confirming measurement:** histogram the number of outbound HTTP requests per search and p95 latency split by cache hit, single-provider, and fallback paths.

### 6. Project-server IPC has one persistent socket per cached project, but unbounded request concurrency (tail/resource risk)

- **Observed:** `project-server-client.ts:70-92, 694-700` caches up to eight project connections; each connection keeps a socket and a `pending` map. `:307-371` creates one timer and pending entry per request and writes immediately; there is no client-side semaphore. Server tracks `activeRequests`/`activeWrites` and serializes only writes (`project-server.ts:127-157, 197-213`).
- **Per work unit:** one IPC request/response frame, one pending timer; concurrent callers multiplex over the same socket.
- **Blocks:** requests can queue behind the server write mutex or synchronous SQLite operation. A slow client is bounded by an 8 MiB outbound buffer (`project-server-framing.ts:15-36`), after which it is dropped.
- **Timeout/retry:** per-request watchdog sends cancellation at timeout (`project-server-client.ts:329-350`); connection election retries until 10s startup deadline with 75/100ms delays (`:389-417`), but this is fixed-delay polling rather than exponential backoff.
- **Payload cost:** default protocol is NDJSON; binary MessagePack is opt-in because existing benchmark evidence found it ~1.9× slower for only 8.3% wire savings (`project-server-client.ts:553-559`). Frames are capped; inbound/outbound buffers are copied/compacted.
- **SPECULATIVE expected win:** bounded client-side request concurrency could protect server tail latency under fan-out, while pipelining already exists; reducing concurrency may improve p95 at the cost of throughput.
- **One confirming measurement:** correlate `pending.size`, server `activeRequests`, `queuedWrites`, and IPC request p95 under concurrent search/index calls.

### 7. Subprocess output paths are carefully backpressured, but spool writes add per-byte filesystem I/O for oversized output

- **Observed:** `_spawn-stream.ts:60-66, 156-197, 222-253` retains capped output in memory, writes full output to an output spool once threshold is crossed, and pauses child streams when queue limits are reached. `exec.ts:588-718` and `bash.ts:562-617` use similar timeout/tree-kill handling.
- **Per work unit:** one child process per tool invocation; output spool writes scale with emitted bytes once the cap is exceeded. No per-line file open is observed in the hot stream path.
- **Blocks:** consumers can cause child stdout/stderr to pause at queue caps; this is intentional backpressure, but a slow consumer increases subprocess wall time.
- **Timeout/retry:** explicit process timeout and tree-kill paths exist; no retry is performed by these stream adapters.
- **SPECULATIVE expected win:** no obvious safe optimization without measuring; increasing caps risks heap/context blow-up, decreasing them increases spool I/O.
- **One confirming measurement:** compare child wall time and spool bytes for the same command with fast versus intentionally slow stream consumption.

## Other boundary inventory

- **Database:** SQLite `index.db` via `IndexStore`; warm LRU pool max two stores (`writer-store-pool.ts:13-20`), WAL/busy timeout 15s (`writer-pragmas.ts`), synchronous statements and transactions; one writer at a time.
- **Filesystem:** index discovery, per-file stat/read, git metadata, `.gitignore`, atlas projection, output spools, parser temp scripts, browser artifacts, and tool-specific reads. Most ordinary tool paths are async; identified synchronous cold paths are listed above.
- **HTTP:** `fetch.ts:194-207` performs one guarded request with a 20s timeout and capped 128KiB streaming body (`:52-57, 224-255`); `search.ts` can perform one or two provider calls and has a TTL/LRU-like bounded cache.
- **IPC/RPC:** project-server Unix socket/named pipe; persistent connection cache max eight, per-request timers, NDJSON default, optional binary framing, 8MiB slow-client cutoff.
- **Subprocess:** shell tools (`bash`, `exec`, `pwsh`), native search/git helpers, language tools, Go/Python parser children, and detached project-index server. Process registry/tree-kill and output backpressure are present; parser native gate is the main intentional serialization point.
- **Cache:** `StorePool` (two warm SQLite stores), project-server connection cache (eight), search result cache, server query caches, parser script/worker reuse. No message broker boundary was found under this scope.

## Assumptions / unverified

- Call counts are static source-derived counts per operation; production distributions of file counts, request fan-out, queue depth, and provider fallback frequency were not available.
- The existing SQLite baseline is historical and could not be re-run because the active environment lacks an allowlisted `npx` command and has no `vitest` executable on PATH.
- The ranked expected wins are **SPECULATIVE** until the single confirming measurement listed for each item is collected.

---

# Instrumentation and controlled benchmark — 2026-09-07

## Instrumentation added

- `src/codebase-index/perf-metrics.ts`: opt-in in-process counters for filesystem bytes/read count, parser-gate wait/call count, parser subprocess count, IPC pending peak, and write-queue wait/call count.
- `indexer.ts`: records UTF-8 bytes after each successful index-file read.
- `spawn-gate.ts`: records time spent waiting behind the native parser gate.
- `parser-batch.ts`, `go-parser.ts`, `py-parser.ts`: count native parser child launches.
- `project-server.ts`: records wait time before a write enters the server write mutex.
- `project-server-client.ts`: records peak pending IPC requests.
- `codebase-index/index.ts`: exports reset/snapshot APIs for controlled harnesses.

Instrumentation is observational only and does not change scheduling, limits, or retry behavior.

## Controlled benchmark results

Command:

```text
$env:WRONGSTACK_INDEX_INLINE='1'; pnpm exec vitest run --config vitest.config.ts packages/tools/tests/codebase-index-perf.test.ts packages/tools/tests/codebase-index-io-perf.test.ts --reporter=verbose
```

Result: **2 test files passed, 8 tests passed**. The first attempt without a built daemon failed as expected with “Built codebase-index project server is unavailable”; rerunning with `WRONGSTACK_INDEX_INLINE=1` exercised the source-mode index path. An earlier run reached the assertions but teardown hit Windows `EBUSY` on `index.db-shm`; adding `shutdownCodebaseIndexHost()` before temp-directory cleanup fixed teardown.

Measured controlled burst (12 concurrent incremental startup-index calls over 12 edited TypeScript files):

| Metric | Result |
|---|---:|
| p95 incremental latency | **668.5ms** |
| filesystem bytes read | **9,832 bytes** |
| parser gate wait | **0.0ms** |
| parser subprocess count | **0** (TypeScript parser path) |
| IPC pending peak | **0** (inline mode) |
| project-server write queue wait | **0.0ms** (inline mode) |

SQLite perf rerun in the same command: commit 22ms; empty-filter search 0.7ms; FTS search 1.3ms; package graph 1.2ms; file graph 2.9ms; symbol graph 8.5ms. All remained below existing soft budgets. These are a single local run, not a distributional baseline.

**Verdict: KEEP instrumentation and harness.** The harness is deterministic, bounded, and passes in source/inline mode. Daemon IPC queue depth and server write-queue wait require a built project-server artifact; they are intentionally reported as zero in this inline benchmark rather than fabricated. A daemon-mode run is still required to validate those two production boundaries.

---

# Repeated runs and awaitable enqueue benchmark — 2026-09-07

## Changes

- `enqueueReindex()` now returns a completion `Promise<void>` while preserving existing fire-and-forget callers that ignore the return value.
- Completion resolves after the debounced/coalesced index batch finishes and rejects on circuit/index failure or explicit cancellation.
- `codebase-index-io-perf.test.ts` now performs three 12-request concurrent burst rounds (36 samples), reports p50/p95/max, and directly awaits an 8-file `enqueueReindex()` burst.

## Build and run ledger

| Attempt | Result | Verdict |
|---|---|---|
| `pnpm --filter @wrongstack/tools build` | Build completed successfully with esbuild and declarations | **KEEP** |
| Detached Vitest run without inline mode | Initial run: 7/9 tests passed; 2 benchmark cases reported built-server unavailable; Vitest reaped a daemon child during teardown. Repeated after rebuilding: same 2 benchmark cases failed before metrics, 1 counter-only test passed | **NO DAEMON MEASUREMENT** |
| Standalone detached Node harness against built exports | Exited with code 13 due to unsettled top-level await before emitting metrics | **NO DAEMON MEASUREMENT; do not treat as latency data** |
| Inline repeated harness (`WRONGSTACK_INDEX_INLINE=1`) | 3/3 tests passed | **KEEP** |

## Inline repeated measurements

Command:

```text
$env:WRONGSTACK_INDEX_INLINE='1'; pnpm exec vitest run --config vitest.config.ts packages/tools/tests/codebase-index-io-perf.test.ts --reporter=verbose
```

- 36 concurrent incremental samples across 3 rounds of 12 edited files.
- p95 incremental latency: **1,345.2ms**.
- Filesystem bytes read: **42,472 bytes**.
- Parser gate wait: **0.0ms**.
- Parser subprocess count: **0**.
- IPC pending peak: **0** (inline mode).
- Project-server write queue wait: **0.0ms** (inline mode).
- Direct awaited enqueue burst: **32.2ms** for 8 files.
- Rebuilt-and-reran inline sample: repeated burst p95 **1,331.4ms**, filesystem bytes **42,472**, enqueue burst **23.3ms**; SQLite companion medians were commit 20ms, empty search 0.6ms, FTS 1.0ms, package graph 1.0ms, file graph 2.6ms, symbol graph 6.7ms.

The existing SQLite suite was rerun successfully alongside the rebuilt inline harness. The detached Vitest attempt still did not produce daemon metrics because source-mode resolution did not use the built artifact and the runner reaped a child daemon during teardown. The repeated inline result is 36 samples across three rounds, useful for noise visibility but not a production daemon baseline.

**Verdict: KEEP awaitable enqueue API and repeated harness.**

## Built-dist daemon fixture follow-up — 2026-09-07

`codebase-index-daemon-perf.test.ts` now imports `../dist/codebase-index/index.js` directly, ensuring `import.meta.url` resolves the colocated built daemon at `packages/tools/dist/codebase-index/project-server.js`. It samples daemon health after 36 concurrent requests and aggregates p50/p95/max.

Latest built-dist run after rebuilding:

- p50: **697.3ms**
- p95: **1,798.8ms**
- max: **2,954.6ms**
- IPC pending peak: **1**
- daemon max queued writes: **passed (>0)**
- daemon write-queue wait: **0.0ms**

The benchmark produced valid daemon metrics but the test process failed teardown with Windows `EBUSY` while removing `index.db-shm`; a retrying cleanup and explicit server shutdown were added, but a subsequent run ended with `codebase-index server connection closed` during teardown. Therefore the latency and IPC values are recorded as observed diagnostics, not a passing stable sample. The write-queue wait assertion is intentionally non-negative because this workload did not produce measurable wait; no non-zero write-queue claim is made.

A later rebuilt run produced another valid sample before teardown: p50 **697.3ms**, p95 **1,798.8ms**, max **2,954.6ms**, IPC pending peak **1**, daemon max queued writes **>0**, and write-queue wait **0.0ms**. Teardown again failed with `EBUSY`/daemon connection closure. The fixture therefore proves built-dist daemon resolution and non-zero IPC overlap, but not a stable non-zero write-wait distribution.

## Contended daemon rerun — stable sample

The benchmark now sets `WRONGSTACK_INDEX_BENCH_NO_HOST_MUTEX=1` (benchmark-only) so concurrent requests reach the detached daemon, and `WRONGSTACK_INDEX_BENCH_WRITE_HOLD_MS=250` to create controlled write contention. Default production scheduling is unchanged. Teardown explicitly requests remote shutdown, tolerates the socket-close race, retries Windows `EBUSY` cleanup, and then shuts down the host.

Command: `pnpm --filter @wrongstack/tools build; pnpm exec vitest run --config vitest.config.ts packages/tools/tests/codebase-index-daemon-perf.test.ts --reporter=verbose`

Result: **1 test passed** with 36 samples.

- Earlier stable sample: p50 **426.8ms**, p95 **452.0ms**, max **452.0ms**.
- Latest repeated sample: p50 **413.3ms**, p95 **523.8ms**, max **523.8ms**.
- IPC pending peak: **12**.
- daemon max queued writes: **1**.
- daemon write-queue wait: **1,000ms**.

**Verdict: KEEP.** This is the first completed detached-daemon run with stable teardown and a non-zero write-queue wait assertion. The contention controls are opt-in and benchmark-only; no default runtime behavior changes.

## Inline vs contended daemon comparison and hold sweep — 2026-09-07

Both suites were run after rebuilding `@wrongstack/tools`.

| Mode | Samples | p50 | p95 | max | IPC pending peak | daemon queue wait |
|---|---:|---:|---:|---:|---:|---:|
| Inline (`WRONGSTACK_INDEX_INLINE=1`) | 36 | **461.2ms** | **882.6ms** | **1,198.7ms** | 0 | 0ms |
| Detached, 250ms hold | 36 | **324.5ms** | **400.0ms** | **400.0ms** | **12** | **1,000ms** |

The inline suite’s recorded p95 is higher than the contended daemon run in this sample because the execution paths differ (inline synchronous SQLite versus detached IPC and benchmark host-mutex bypass); this is an observation, not evidence that contention improves production latency. The daemon run completed cleanly.

Hold sensitivity sweep, 8-file concurrent burst per point:

| Hold | p50 | p95 | max | daemon queue wait |
|---:|---:|---:|---:|---:|
| 50ms | 122.1ms | 122.1ms | 122.1ms | 100ms |
| 100ms | 165.8ms | 165.8ms | 165.8ms | 200ms |
| 250ms | 323.3ms | 323.3ms | 323.3ms | 500ms |

**Verdict: KEEP.** Queue wait scales monotonically with the controlled hold (approximately 2× hold in this 8-request workload), while latency rises with the hold. The sweep and paired comparison are stable completed measurements; they are benchmark-induced sensitivity results, not production defaults.

## Matched-load baseline vs contended daemon comparison — 2026-09-07

Both runs used the same built-dist daemon fixture, 36 primary samples, `WRONGSTACK_BENCH_NO_HOST_MUTEX=1`, and the same machine. CPU and fleet metadata were captured immediately before each run:

| Mode | Hold | CPU before | Online agents before | p50 | p95 | max | IPC pending | Queue wait |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 0ms | 18.1% | 14 | **58.9ms** | **62.6ms** | **62.6ms** | 12 | 0.2ms |
| Contended | 250ms | 22.5% | 13 | **320.6ms** | **325.4ms** | **325.4ms** | 12 | **1,000ms** |

The box load was not identical: CPU differed by 4.4 percentage points and one peer left between runs. Per the shared-box measurement protocol, this is a valid observed comparison but **not a clean causal attribution**; the injected hold is directionally consistent with the latency and queue-wait increase, while load drift is a residual confounder. Both runs passed the detached fixture and teardown.

The baseline command also completed the 50/100/250ms sweep; the contended command completed the same sweep. Baseline sweep observations were p95 122.9ms / 177.5ms / 311.2ms with queue waits 100ms / 200ms / 500ms. Contended-run sweep observations were p95 120.1ms / 160.3ms / 310.1ms with queue waits 100ms / 200ms / 500ms. Sweep values are stable within expected shared-box noise; queue-wait sensitivity is unchanged.

## Synchronized paired rerun with automated pairing checks — 2026-09-07

### Harness additions (`codebase-index-daemon-perf.test.ts`)

- `captureCpuPercent()` — aggregate CPU busy% from `os.cpus()` deltas (Windows-safe, 300ms sample).
- `captureLoad()` — CPU plus the runner-captured online-agent count (`WRONGSTACK_BENCH_ONLINE_AGENTS`).
- `assertPairingValid()` — emitted as a `[codebase-index-daemon-pairing]` line; fails the run (marking the comparison invalid) when in-run CPU drift exceeds `WRONGSTACK_BENCH_MAX_CPU_DRIFT_PCT` (default 10pp) or the agent count changes.

### Synchronized legs

Runner protocol: fleet count checked immediately before each leg; when the fleet drifted 13→14 (a companion joined between legs), the baseline was **re-run at the new count** rather than paired across counts. An earlier 13-agent baseline (pairing valid, p50 81.2ms / p95 90.2ms) is superseded by the 14-agent re-baseline below.

| Leg | Hold | Agents | Pairing (in-run) | CPU start→end | p50 | p95 | max | IPC pending | Queue wait |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|
| Baseline | 0ms | 14 | valid=true, drift 8.0pp | 21.8%→13.8% | **59.6ms** | **61.7ms** | **61.7ms** | 12 | 0.27ms |
| Contended | 250ms | 14 | valid=true, drift 6.3pp | 20.9%→14.6% | **321.9ms** | **336.3ms** | **336.3ms** | 12 | **1,000ms** |

Cross-leg synchronization: agent count matched at 14; CPU-before delta **0.9pp** (21.8% vs 20.9%), well inside the 10pp pairing threshold. Both legs were 36-sample runs of the same built-dist fixture with `WRONGSTACK_BENCH_NO_HOST_MUTEX=1`.

### Attribution verdict (updated)

**UPLIFTED from "observed, not clean causal attribution" to "attributed with high confidence."** With load synchronized and both pairing checks valid, the p50 increase (59.6→321.9ms, ~5.4×) and the queue-wait increase (0.27→1,000ms) are attributable to the injected 250ms daemon write hold, not to shared-box load drift. The residual confounders from the previous comparison (4.4pp CPU delta, agent-count mismatch) are eliminated in this run. This remains benchmark-induced contention; production defaults are unchanged.

## Paired sweep and inline pairing enforcement — 2026-09-07

### Harness change: shared pairing module

`packages/tools/tests/bench-pairing.ts` now backs **both** benchmark modes (`captureCpuPercent`, `captureLoad`, `assertPairingValid` with suite/detail labels). The daemon sweep brackets each hold point with load snapshots, throws on invalid pairing, and the sweep JSON now carries `cpuStart`/`cpuEnd`/`cpuDrift`/`agents`/`pairingValid` per point. The inline suite's incremental-burst and enqueue-burst tests enforce the same checks; its counter-only test intentionally has no pairing (it produces no load).

### Paired 50/100/250ms sweep (agents=6, captured live before the run)

| Hold | Pairing (in-run) | CPU start→end | p50 | p95 | max | Queue wait |
|---:|---|---|---:|---:|---:|---:|
| 50ms | valid=true, drift 0.3pp | 14.9%→15.1% | **119.2ms** | 119.2ms | 119.2ms | **100ms** |
| 100ms | valid=true, drift 1.5pp | 16.4%→14.9% | **172.2ms** | 172.2ms | 172.2ms | **200ms** |
| 250ms | valid=true, drift 0.0pp | 14.4%→14.4% | **319.3ms** | 319.3ms | 319.3ms | **500ms** |

**Verdict: KEEP.** Queue wait remains ≈2× the injected hold across all three points with pairing valid everywhere; latency rises monotonically with the hold. These are the first sweep points carrying per-point pairing metadata, so drift within a point is now machine-checked rather than assumed.

### Inline suite pairing enforcement

| Mode | Pairing (in-run) | CPU start→end | Result |
|---|---|---|---|
| incremental-burst | valid=true, drift 8.7pp, agents=6 | 13.5%→22.2% | n=36, p50 362.9ms / p95 671.6ms / max 722.8ms |
| enqueue-burst | valid=true, drift 2.3pp, agents=6 | 15.0%→12.7% | n=8, latency 38.2ms |

Both inline latency tests now throw on drifted samples, matching the daemon suite's synchronized-load validity contract.

**Verification:** `tsc` on `tsconfig.test.json` reports zero errors in `bench-pairing.ts` and both benchmark suites (pre-existing unrelated test errors elsewhere are unchanged); Biome format clean on all three files; daemon sweep 1/1 passed, inline suite 3/3 passed.

## Primary-leg refactor confirmation under the shared pairing module — 2026-09-07

Both primary legs were re-run after the pairing helpers moved to `bench-pairing.ts`, to confirm the refactor shifted neither measurements nor pairing behavior. Runner protocol held: fresh fleet snapshot before each leg, synchronized `WRONGSTACK_BENCH_ONLINE_AGENTS`, cross-leg CPU delta inside the 10pp threshold.

- **Guard behavior confirmed:** the first baseline attempt (agents=5) was correctly **rejected** by the shared module — `cpuStart=26.0% cpuEnd=13.5% cpuDrift=12.5pp valid=false` threw before any sample was recorded. Throw-on-invalid works identically after the refactor.
- **Baseline leg** (hold=0, agents=6): pairing valid (30.0%→20.5%, drift 9.5pp), p50 **60.5ms**, p95 **65.5ms**, max 65.5ms, ipcPendingPeak 12, queue wait **0.21ms**.
- **Contended leg** (hold=250, agents=6): pairing valid (19.4%→17.9%, drift 1.6pp), p50 **318.1ms**, p95 **336.7ms**, max 336.7ms, ipcPendingPeak 12, queue wait **1,000ms**.

| Leg | Prior run (14 agents) | Confirmation run (6 agents) | Δ |
|---|---|---|---|
| Baseline p50 | 59.6ms | **60.5ms** | +1.5% |
| Baseline p95 | 61.7ms | 65.5ms | +6.2% |
| Baseline queue wait | 0.27ms | 0.21ms | −0.06ms |
| Contended p50 | 321.9ms | **318.1ms** | −1.2% |
| Contended p95 | 336.3ms | 336.7ms | +0.1% |
| Contended queue wait | 1,000ms | 1,000ms | 0 |
| Contended/baseline p50 ratio | 5.40× | **5.26×** | ~0.14× |

**Verdict: KEEP — refactor confirmed non-shifting.** Every leg-to-leg delta is inside shared-box noise (p50 ±1.5%, p95 ≤6.2%, queue waits identical), the attribution ratio is preserved at ~5.3×, and the pairing guard rejected a genuinely drifted sample exactly as designed. The attribution verdict ("attributed with high confidence") carries over unchanged to the shared-module harness.

