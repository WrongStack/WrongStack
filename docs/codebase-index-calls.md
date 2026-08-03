# Codebase Index: Incoming/Outgoing Calls Tools

> Two Tier 1 builtin tools — `codebase-incoming-calls` and `codebase-outgoing-calls` — that query the SQLite index ref graph to find all callers (incoming) or callees (outgoing) of a named symbol in under 1ms.

Added in 0.299.x. Commits: `e1ef4fc0b`, `dcc3bf946`, `dc8a82383`, `89b1c5b57`, `e61515f33`.

## Quick Reference

| Tool | Input | Output | Permission | Tier |
|---|---|---|---|---|
| `codebase-incoming-calls` | `{ symbol, file?, limit? }` | `{ calls: CallSite[], total, note? }` | `auto` | 1 (always loaded) |
| `codebase-outgoing-calls` | `{ symbol, file?, limit? }` | `{ calls: CallSite[], total, note? }` | `auto` | 1 (always loaded) |

### CallSite type

```typescript
interface CallSite {
  symbol: {
    id: number;
    name: string;
    kind: SymbolKind;     // function, method, class, type, ...
    lang: SymbolLang;     // ts, tsx, js, go, py, rs, ...
    file: string;         // absolute path
    line: number;         // 1-based
    signature: string;    // e.g. "function foo(a: string): Promise<void>"
  };
  callType: CallType;     // call, type_ref, inherit, implement, import
  line: number;           // source line where the reference occurs
}
```

### Usage

```
codebase-incoming-calls({ symbol: "enqueueReindex" })
→ 7 callers: setupCodebaseIndexing (cli), enqueueFile (webui), safeWatchDir (plugins), ...

codebase-outgoing-calls({ symbol: "callIndexOp" })
→ 17 deps: resolveProjectIndexDaemonAvailability, ensureWorker, callInline, terminateWorker, ...
```

## Architecture

### 7-Layer Dispatch Stack

```
Tool (codebase-incoming-calls-tool.ts)
  → background-indexer.incomingCallsService
    → callIndexOp('incomingCalls')
      → project-server / worker / inline
        → index-service.incomingCallsService
          → IndexStore.findIncomingCallsByName
            → writer-graph-reader.findIncomingCallsByName (SQL)
```

| Layer | File | Responsibility |
|---|---|---|
| **Tool** | `codebase-incoming-calls-tool.ts` | Input validation, index readiness gate, result formatting |
| **Public API** | `background-indexer.ts` | `callIndexOp` dispatch (server/worker/inline routing) |
| **Protocol** | `worker-protocol.ts` | `CallRefsOpArgs` type + `OpShapes` entry |
| **Server** | `project-server.ts` | IPC dispatch + GenerationLRUCache (128 entries) |
| **Worker** | `worker.ts` | Worker-thread dispatch case |
| **Service** | `index-service.ts` | `IncomingCallsResult` type + store acquire/release |
| **Store** | `writer.ts` | IndexStore method → graph-reader delegation |
| **SQL** | `writer-graph-reader.ts` | `findIncomingCallsByName` SQL + chunking + sort |

### Key Types

```typescript
// worker-protocol.ts
interface CallRefsOpArgs extends StatsOpArgs {
  symbol: string;
  file?: string;
  limit?: number;
}

// index-service.ts
interface IncomingCallsResult {
  calls: CallSite[];
  symbolFound: boolean;
  ambiguous: boolean;       // true when file-scoped name exists in multiple files
  totalMatches: number;     // pre-slice count for truncation detection
}

interface OutgoingCallsResult {
  calls: CallSite[];
  symbolFound: boolean;
  unresolvedCount: number;  // refs with to_id IS NULL
  totalMatches: number;
}
```

### SQL Query (Incoming)

```sql
SELECT
  s.id AS sym_id, s.name AS sym_name, s.kind AS sym_kind,
  s.lang AS sym_lang, s.file AS sym_file, s.line AS sym_line,
  s.signature AS sym_signature,
  r.call_type, r.line AS ref_line
FROM refs r
JOIN symbols s ON s.id = r.from_id
WHERE r.to_id IN (?, ?, ...)         -- resolved target IDs
ORDER BY r.line, r.id
```

Symbol name is resolved to IDs first, then ref edges are traversed. A separate fallback query catches unresolved refs (`to_id IS NULL AND to_name = ?`). Results are globally sorted in JavaScript after chunk merge.

### Chunking (MAX_SQL_VARS = 900)

Symbols with 900+ matching IDs (e.g., `export function target()` in 950 test files) require chunked queries:

```typescript
function chunkedIdQuery(stmt, ids, buildSql, extraArgs) {
  const results = [];
  for (let start = 0; start < ids.length; start += 900) {
    const chunk = ids.slice(start, start + 900);
    const placeholders = chunk.map(() => '?').join(',');
    results.push(...stmt(buildSql(placeholders)).all(...chunk, ...extraArgs));
  }
  return results;
}
```

**Important:** `buildSql` MUST NOT include `LIMIT` — per-chunk LIMIT would silently cap results. Callers slice the merged array instead.

## LLM Adoption Mechanisms

### 1. Tool usageHint

```
CALL THIS BEFORE REFACTORING OR CHANGING ANY FUNCTION:
- NEVER use grep or manual line reading to check where a function is called.
- ALWAYS call codebase-incoming-calls({ symbol: "funcName" }) first.
```

### 2. System prompt rules (4 layers synced)

| Layer | File | Section |
|---|---|---|
| Full | `system.md` | Core principle #1, Filesystem insight, Config & Project, read-edit loop |
| Pro | `system-pro.md` | Same 4 sections |
| Lite | `system-lite.md` | Discovery tools list |
| Subagent | `subagent-baseline.md` | Codebase discovery section |

### 3. Read-edit loop

```
codebase-search → codebase-incoming-calls/outgoing-calls → read → edit → verify
                     ^ new "Assess impact" step
```

## Impact Analysis Results (Production Index — 6,756 files)

### Blast Radius Ranking

| Rank | Symbol | Incoming | Outgoing | Risk |
|---|---|---|---|---|
| 🔴 1 | `indexStorePool.acquire` | 20 | — | Tüm veri erişimi |
| 🔴 2 | `callIndexOp` | 9 | 17 | Tüm operasyonlar |
| 🟠 3 | `runStartupIndex` | 13 | — | Startup + reindex |
| 🟡 4 | `searchCodebaseIndex` | 12 | — | Arama |
| 🟡 5 | `enqueueReindex` | 7 | 6 | Edit pipeline |

### `callIndexOp` — 9 callers

| Caller | File:Line |
|---|---|
| `flushReadyReindexBatch` | background-indexer.ts:548 |
| `runStartupIndex` | background-indexer.ts:642 |
| `searchCodebaseIndex` | background-indexer.ts:757 |
| `codebaseIndexStats` | background-indexer.ts:768 |
| `packageGraphService` | background-indexer.ts:776 |
| `fileGraphService` | background-indexer.ts:781 |
| `symbolGraphService` | background-indexer.ts:786 |
| `incomingCallsService` | background-indexer.ts:791 |
| `outgoingCallsService` | background-indexer.ts:796 |

### `enqueueReindex` — 7 callers (edit pipeline entry)

| Caller | Surface | File:Line |
|---|---|---|
| `setupCodebaseIndexing` | CLI | codebase-index.ts:107 |
| `enqueueFile` | WebUI | codebase-indexing.ts:156 |
| `safeWatchDir` | Plugins | index.ts:248 |
| (+ 4 test references) | | |

### `flushReadyReindexBatch` — 3 safety layers converge

```
flushReadyReindexBatch(key)
  ├─ Circuit breaker check (indexCircuitBreaker.allowRequest)
  ├─ Process-wide mutex (withMutex)
  └─ Watchdog timeout (callIndexOp, 60s default)
       → callIndexOp('index', { files: [...batch.files].sort() })
```

## Edit → Index Pipeline

### 5-Function Data Flow

```
User Edit (CLI/WebUI/External)
    │
    ▼
1. enqueueReindex(file)           — 3 callers, entry point
    │
    ▼
2. debounceKey(root, dir, file)   — pure: JSON.stringify key
    │
    ▼  400ms debounce timer
    │
3. addReadyReindex(file)          — setImmediate batch merging
    │
    ▼  setImmediate (same tick)
    │
4. flushReadyReindexBatch(key)    — circuit breaker + mutex + watchdog
    │
    ▼
5. callIndexOp('index', { files }) — routes to server/worker/inline
    │
    ▼
SQLite (index.db) WAL write
```

### Timing

| Phase | Duration |
|---|---|
| Edit → debounce timer fire | 400ms |
| Batch merge + flush dispatch | ~1ms |
| SQLite write (typical) | 5–15ms per file |
| **Total edit→search latency** | **~410ms** |

### Concurrency Controls

| Control | Location | Protects Against |
|---|---|---|
| Per-file debounce (400ms) | `enqueueReindex` | Rapid successive same-file edits |
| Batch merging (setImmediate) | `addReadyReindex` | Same-cycle files share one index run |
| Circuit breaker | `flushReadyReindexBatch` | Queuing behind wedged pipeline |
| Process-wide mutex | `flushReadyReindexBatch` | Two writes racing SQLite |
| Watchdog timeout (60s) | `callIndexOp` | Wedged worker blocks forever |
| SQLite busy_timeout + retry | `runSqliteWithRetry` | WAL lock contention |

### Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| SQLite locked | `SQLITE_BUSY` | Retry 3× exponential backoff → `LockError` |
| Worker wedged | Watchdog 60s | `terminateWorker()` → lazy respawn |
| Repeated failures | Circuit breaker (3 fails) | Circuit opens → fail-fast until cooldown |
| Corrupt index | Constraint error | Auto-retry with `force: true` (wipe + rebuild) |

## Verification

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ 0 errors |
| Lint (Biome) | ✅ 0 errors |
| Unit tests (calls) | ✅ 15/15 |
| Subpath export tests | ✅ 4/4 |
| System prompt tests | ✅ 28/28 |
| Director prompt tests | ✅ 27/27 |
| Existing codebase-index tests | ✅ 86/86 |
| Dead-code tests | ✅ 8/8 |
| Dead-code scan of new exports | ✅ 18/18 alive, 0 dead |
| Production (6,756 files) | ✅ <1ms queries |

## Files Changed

### New (3 files)

- `packages/tools/src/codebase-index/codebase-incoming-calls-tool.ts`
- `packages/tools/src/codebase-index/codebase-outgoing-calls-tool.ts`
- `packages/tools/tests/codebase-index-calls.test.ts`

### Modified (14 files)

- `schema.ts` — `CallSite` interface
- `writer-graph-reader.ts` — SQL + chunking + sort
- `writer.ts` — IndexStore methods
- `worker-protocol.ts` — `CallRefsOpArgs` + `OpShapes`
- `index-service.ts` — service functions + result types
- `background-indexer.ts` — public API + inline dispatch
- `worker.ts` — worker dispatch
- `project-server.ts` — server dispatch + caches
- `index.ts` — exports
- `builtin.ts` — TIER1_TOOLS + builtinTools
- `system.md` + `system-pro.md` + `system-lite.md` + `subagent-baseline.md` — prompt sync
- `subpath-exports.test.ts` — runtime import test
- `CHANGELOG.md` — unreleased entry
