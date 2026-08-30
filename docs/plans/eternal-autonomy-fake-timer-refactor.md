# Fake-Timer Refactor Plan — eternal-autonomy test files

**Status:** implemented (2026-08-30) · **Target:** `packages/core/tests/execution/eternal-autonomy{,-extra}.test.ts` · **Payoff:** ~25s → <2s in the core execution test group

## 1. Measured baseline (3 runs, 2026-08-30)

| File | Tests | Duration | Dominant waits |
|---|---:|---:|---|
| `eternal-autonomy.test.ts` | 25 | 14.4s | ~14 tests ≈1.0s each, 2 tests ≈2.0s, 1 ≈0.4s (exponential backoff) |
| `eternal-autonomy-extra.test.ts` | 28 | 10.7s | 2 tests ≈5.0s each, rest fast |
| Group total | 1339 | 17.9s | these two files ≈ 25s of 44s test time |

## 2. Wait sources (verified in source)

| Source | Location | Interceptable? |
|---|---|---|
| **Hardcoded 5s null-action cool-down** `await sleep(5_000)` | `packages/core/src/execution/eternal-autonomy.ts:233` | Yes — but hardcoded, not configurable |
| Cycle gap `await sleep(this.opts.cycleGapMs ?? 0)` | `eternal-autonomy.ts:190` | Already configurable; **default 0** → not a wait source |
| Iteration timeout `setTimeout(() => ctrl.abort(), iterationTimeoutMs ?? 5min)` | `eternal-autonomy.ts:244` | Never elapses in these tests → not a wait source |
| `sleep` util = plain `setTimeout` wrapper | `packages/core/src/utils/sleep.ts:4-6` | Yes — `vi.useFakeTimers()` intercepts it |
| Test-side poll `await new Promise((r) => setTimeout(r, 50))` | `eternal-autonomy.test.ts:339` | Trivial |
| **Unpinned ~1s cadence** (≈14 tests) and ~2s (2 tests) | fake `agent.run` mocks or an engine path — pin during implementation via the emitted `{phase:'sleep', ms}` events (`eternal-autonomy.ts:232,405`) | Yes |

The engine already emits `{ phase: 'sleep', ms }` events — tests can observe wait requests deterministically instead of racing wall clocks.

## 3. Recommended approach — Option B: injectable cool-down + tiny real timers

1. **Engine change (1 option):** add `noTaskCoolDownMs?: number` (default `5_000`) to the engine options; use it at `eternal-autonomy.ts:233` for both `sleep(...)` and the `emit({phase:'sleep', ms})` value. Production behavior unchanged; default stays 5s.
2. **Tests:** construct engines with `noTaskCoolDownMs: 0` (or 1) and `cycleGapMs: 0`. The two 5s tests (`eternal-autonomy-extra`: "keeps going when the brain denies completion", "keeps going on a prose answer without the exact option id") drop to milliseconds → **~10.5s saved**.
3. **Mock delays:** shrink the ~1s/~2s fake `agent.run` delays to 5ms/10ms (tests assert phase order and journal contents, not durations). **~14s saved** — pin the exact mock sites during implementation (grep `setTimeout` in the two files; only one test-side poll exists at `eternal-autonomy.test.ts:339`).
4. **Keep real timers.** No `vi.useFakeTimers()` anywhere in these files.

Estimated result: both files < 1.5s each; group 17.9s → < 6s.

### Why not Option A (vi.useFakeTimers + advanceTimersByTimeAsync)?

`sleep`/`setTimeout` would be intercepted fine, but the call graph must be audited for `AbortSignal.timeout(...)` and `performance.now()` deadlines, which fake timers do **not** control; each engine tick then needs `await vi.advanceTimersByTimeAsync()` + microtask flushing, which is the classic source of new flakiness. Choose A only if the maintainers reject adding the `noTaskCoolDownMs` option.

## 4. Risks & guardrails

- **Timing-based assertions:** sweep both files for `Date.now()`/duration assumptions before merging (none expected — tests assert phases and journal entries).
- **`stopRequested` race:** comments at `eternal-autonomy-extra.test.ts:112-113` rely on skipping the 5s sleep via a brainstorm flag. With cool-down 0 the `if (!stopRequested)` branch still executes — re-assert both tests after the change.
- **`sleep(0)` clamping:** `setTimeout(0)` ≈ 1ms — acceptable; use 1ms if a tick boundary matters.
- Do **not** touch the compactor tests (`compactor.test.ts` 5.5s, `intelligent-compactor.test.ts` 3.1s) in this refactor — they are data-heavy, not timer-heavy (separate candidate).

## 7. Follow-up investigation — compactor test family slimming (measured 2026-08-30)

The execution group's remaining weight after §3 is the **compactor family** (`compactor.test.ts` 6.9s + `intelligent-compactor.test.ts` 4.2s) — data-heavy, deliberately excluded above. A timed probe of the exact slow-test shape (30 rounds × tool_use/tool_result with N-byte blobs, `HybridCompactor({ preserveK: 5, eliseThreshold: 1000 })`) measured:

| blob size (`big`) | compact() wall | elision fires |
|---:|---:|---|
| 20_000 (current test) | 4_877 ms | ✅ |
| 10_000 | 1_687 ms | ✅ |
| **4_000** | **262 ms (18.6×)** | ✅ |
| 2_000 | 0 ms | ❌ — elision never triggers |
| 1_000 | 0 ms | ❌ |

Findings: (a) compact() cost grows **superlinearly** in blob size (~5× data → ~19× time), so shrinking the synthetic blobs is the lever, not parallelism; (b) there is an **activation floor** — below ~4_000 bytes per blob the elision phase silently never fires (before≈17k tokens stays under the compaction trigger), so slimming must stop at 4_000; (c) the slow tests assert only `elision happened` + `after < before`, no exact byte/token numbers → shrinking preserves assertion semantics.

**Recipe:** in both slow tests, change `'x'.repeat(20_000)` → `'x'.repeat(4_000)` (and the equivalent synthetic-data construction in `intelligent-compactor.test.ts`), keep `preserveK: 5` / `eliseThreshold: 1000`. Expected: compactor.test.ts 6.9s → ~0.5s, intelligent-compactor 4.2s → ~0.4s, execution group ~15.7s → **~5–6s**. Verify by re-running the group and asserting both slow tests still show `elision=true` behavior (the `report.after < report.before` assertions already enforce this).


