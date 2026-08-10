# Audit Report 08: Tools, Plugins & Codebase Index

**Package:** `packages/tools/`, `packages/plugins/`
**Date:** 2026-08-10
**Auditor:** Deep investigation (solo)

---

## Summary

The tools package implements built-in agent tools (codebase indexing, kanban, session management) and the plugins package provides security/compliance hooks (path-guard, secret-scanner, test-runner-gate). The codebase indexer is the most complex subsystem — a multi-language symbol parser with content-hash incremental skip, worker-pool parallelism, and SQLite-backed storage.

Overall code quality is high with sophisticated concurrency handling and defensive error recovery. Findings are primarily low-severity improvements.

---

## Findings

### A-04: Index metric combines distinct outcomes (Low)

**File:** `packages/tools/src/codebase-index/indexer.ts:738-740, 784`

```typescript
// line 738: skippedMeta path (content-hash match)
langStats[lang] = (langStats[lang] ?? 0) + result.skippedMeta.symbolCount;
symbolsIndexed += result.skippedMeta.symbolCount;
filesIndexed++;  // ← counted as "indexed" but no parsing occurred
```

`filesIndexed` increments for fully parsed files, trusted/hash-skipped files, parse failures that still persist a file row, and empty-symbol files. The counter therefore describes files represented or processed by the index operation, not files newly parsed.

**Impact:** Metric inflation — users/operators can't distinguish "N files newly parsed" from "N files checked and skipped." The `IndexResult.filesIndexed` is consumed by the `codebase-stats` tool output, so agents see misleading numbers.

**Resolution (2026-08-10):** Added backward-compatible `fileOutcomes` counters for `parsed`, `skipped`, `empty`, and `failed`; existing `filesIndexed` remains available. Incremental and zero-symbol tests assert the new outcomes.

### T-02: Path-guard glob compiler is bounded (Positive)

**File:** `packages/plugins/src/path-guard/index.ts:121-152`

`compilePathGlob()` does not embed raw regular-expression syntax from configured globs. It escapes regex metacharacters and emits a small bounded vocabulary for `*`, `**`, and `?`. The draft ReDoS claim is therefore unsupported. A `performance.now()` check after synchronous regex execution would measure latency but could not interrupt a catastrophic match.

### A-19: Plugin hook ownership was shared across host instances (Low)

**Files:** `path-guard/index.ts:56-62`, `secret-scanner/index.ts:222-244`

Both plugins used module-scope `state` objects with a single `hookUnregister` slot:

```typescript
const state: PathGuardState = {
  invocations: 0,
  blocks: 0,
  warns: 0,
  lastBlock: null,
  hookUnregister: null,  // single slot
};
```

Calling `setup()` on a second host released the first host's hook and overwrote its unregister handle. Secret-scanner additionally replaced the active custom-pattern set, so the first host began enforcing the second host's configuration. Core's plugin loader explicitly supports isolated concurrent host handles, making this a real lifecycle contract violation rather than a hypothetical future limitation.

**Resolution (2026-08-10):** Path-guard and secret-scanner now key lifecycle state and hook handles by `PluginAPI`. Secret-scanner captures a host-specific pattern/regex projection and activates it for that host's synchronous hook/tool invocation. Reinitializing or tearing down one API affects only that API. Multi-host regressions verify hook ownership, independent teardown, and distinct custom-pattern enforcement. The focused suites passed **326/326**, the complete plugins suite passed **2,486 tests with 1 skipped across 117 files**, and plugin typecheck passed.

### A-20: Codebase indexer worker pool activation was unreachable (Low)

**File:** `packages/tools/src/codebase-index/indexer.ts:640`

```typescript
let pool = toParse.length >= WORKER_POOL_THRESHOLD ? getParserPool() : null;
```

`WORKER_POOL_THRESHOLD` is 500, but the indexer compared it with `toParse.length` inside an outer batch whose balanced-profile hard cap is 40 files (and whose frugal cap is 4). The worker path therefore could never activate under any supported performance profile.

**Resolution (2026-08-10):** Pool eligibility is now based on the complete post-fast-skip run size, while the current batch must contain at least two parse candidates and frugal mode remains inline. This preserves the 500-file startup-amortization threshold without making it environment-configurable or raising bounded I/O concurrency. A regression proves 500 run candidates with a 40-file batch activates while 499 candidates or a single parse candidate stays inline. Focused codebase-index tests passed **23/23**; the full Tools suite passed **2,589 tests with 7 skipped across 170 files**, and Tools typecheck passed.

### T-05: Secret-scanner combined regex cache key omitted pattern flags (Info)

**File:** `packages/plugins/src/secret-scanner/index.ts:202`

```typescript
const newCacheKey = JSON.stringify(patterns.map((p) => [p.type, p.regex.source]));
```

The cache key includes `type` and `regex.source` but not `regex.flags`. If two pattern sets differ only in flags (e.g., case-sensitive vs case-insensitive), the cache would serve the stale compiled regex. Current patterns all use the same flags, so this is not a live bug.

**Resolution (2026-08-10):** The setup-time cache was removed while isolating per-host scanner projections. Each host compiles its bounded configured pattern set once, so neither flags nor another host's cache entry can produce a stale regex.

---

## Architecture Notes

### Codebase Index Pipeline (well-designed)

The indexer implements a sophisticated 3-phase pipeline:

1. **Phase 1 (parallel):** stat + incremental skip (mtime check) + content-hash short-circuit + file read
2. **Phase 1.5 (post-batch):** parse — either inline or via worker pool (threshold-gated to avoid spawn overhead for small batches)
3. **Phase 2 (sequential):** SQLite batch commit in a single transaction per outer batch

The split between "produce" (async, parallelizable) and "settle" (synchronous, budget-mutating) in the tool executor's output handling mirrors this design — the codebase consistently separates concurrency-safe work from state-mutating work.

### Git-first file discovery

`findGitSourceFiles()` (line 119) uses `git ls-files --cached --others --exclude-standard -z` to enumerate tracked+untracked files. This avoids hundreds of serial `readdir` calls on large repos. Non-Git projects fall back to the filesystem walker. The `git status --porcelain` output is parsed to detect dirty/deleted files for incremental updates.

---

## Summary Table

| ID | Severity | Finding | Fix effort |
|----|----------|---------|------------|
| A-04 | Low | filesIndexed combines parsed/skipped/failed/empty outcomes | **Resolved** |
| T-02 | Positive | Glob compiler escapes regex syntax and emits bounded patterns | — |
| A-19 | Low | Plugin hook/state ownership shared across host instances | **Resolved** |
| A-20 | Low | Worker-pool threshold compared against an always-smaller capped batch | **Resolved** |
| T-05 | Info | Secret-scanner cache key omits regex flags | **Resolved** |
