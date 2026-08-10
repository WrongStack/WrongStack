# 04 — Storage and Session Management

**Package:** `@wrongstack/core` (storage layer)
**Files examined:** `session-store.ts` (1262 lines), `file-session-writer.ts` (1149 lines), `session-catalog/store.ts` (1107 lines)
**Assessment:** Three medium correctness defects and one low validation leak found and resolved; targeted review complete

---

## 1. Session Store: Load Cache with Mtime Invalidation

**File:** `packages/core/src/storage/session-store.ts`, lines 93-107

```typescript
private readonly _loadCache = new Map<string, LoadCacheEntry>();
private readonly loadCache = new SessionLoadCache(this._loadCache);
```

**Verified:** The load cache stores parsed session data keyed by session ID. The `SessionLoadCache` wrapper invalidates entries when the file's `mtimeMs` or `size` changes (as documented in the comment at lines 96-98). This eliminates redundant full-file reads and JSON parses when the same session is loaded multiple times (e.g., WebUI session detail views).

**Verified:** `session-store/load-cache.ts` wraps the map with an LRU-style refresh and enforces both `LOAD_CACHE_MAX_ENTRIES = 50` and `LOAD_CACHE_MAX_BYTES = 64 MiB`. Oversized individual sessions are not cached. The initial unbounded-cache concern is therefore rejected.

---

## 2. Session Store: File Locking for Concurrent Access

**File:** `packages/core/src/storage/session-store.ts`, line 191

```typescript
await withFileLock(manifestPath, async () => {
  this.shardManifestCache.delete(shardKey);
  try {
    await fsp.unlink(manifestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
});
```

**Verified:** Shard manifest operations use `withFileLock` for cross-process safety. The lock ensures that concurrent agents (CLI, TUI, WebUI) don't corrupt the manifest file.

### A-21: Warm shard-manifest cache ignored peer-process invalidation (Medium)

The session store has multiple levels of file-based coordination:
1. Session JSONL files (append-only, atomic writes via `FileSessionWriter`)
2. Shard manifests (file-locked)
3. Session index (`_index.jsonl`, file-locked)
4. Checkpoint CAS (content-addressable storage)
5. Session catalog client (optional remote server)

`loadCache` validates mtime and size, but `shardManifestCache` returned its in-memory value without observing the persisted manifest. When a second store instance appended, renamed, or deleted a session, it removed the shared manifest file under the cross-process lock and cleared only its own Map. A first long-lived store that had already warmed the shard continued returning its stale Map entry indefinitely.

**Resolution (2026-08-10):** Process-local shard entries now retain the manifest's mtime, size, and file identity and re-stat before reuse. Missing or atomically replaced manifests evict the warm projection and rebuild under the existing file lock; a failed best-effort manifest write is never cached without a verifiable observation. A two-store regression warms one instance, renames through its peer, and proves the warm instance observes the new summary. The focused file passed **63/63**, the complete Core storage suite passed **920/920 across 69 files**, and Core typecheck passed.

---

## 3. Session Store: Catalog Client Detection

**File:** `packages/core/src/storage/session-store.ts`, lines 127-136

```typescript
const builtRuntime = import.meta.url.includes('/dist/');
this.catalogClient =
  this.projectRoot &&
  (builtRuntime || process.env['WRONGSTACK_SESSION_CATALOG_FORCE'] === '1') &&
  resolveSessionCatalogProjectServerUrl()
    ? new SessionCatalogProjectClient({...})
    : undefined;
```

**Finding (Low):** The catalog client is only instantiated when:
1. The runtime is built (`import.meta.url` contains `/dist/`)
2. OR the `WRONGSTACK_SESSION_CATALOG_FORCE` env var is set
3. AND a catalog server URL is resolvable
4. AND a project root is provided

This means in source/development mode (running via `tsx`), the catalog client is never used, even if a catalog server is running. This is intentional (source mode uses local file I/O), but could surprise developers who expect the catalog to be active in all modes.

---

## 4. File Session Writer

**File:** `packages/core/src/storage/file-session-writer.ts` (1150 lines)

The file session writer appends serialized events to JSONL through a coalesced FIFO write chain. The review covered buffer admission, failed-write retry, explicit and timer flushes, synchronous exit drain, close retry, checkpoint/truncate/reopen, summary replay, and clear-session behavior.

### A-13: Resume could append into a crash-torn final JSONL record (Medium)

The tolerant reader correctly skipped a malformed final record, but `resume()` reopened the file directly in append mode. If a process died halfway through its last JSON write, the next `session_resumed` record was appended to that partial record without a separating newline. The combined line was malformed, so the resume boundary was lost and recovery could continue treating the session as stale.

**Resolution (2026-08-10):** Resume now opens the existing transcript in read/append mode, inspects the final byte, and appends a newline boundary when needed before constructing the writer. A valid final JSON record that merely lacks a newline is preserved; a torn record remains available for forensics as its own malformed line and is skipped by the existing tolerant reader. The temporary handle is closed if inspection fails. Regressions cover both torn and valid newline-free tails.

### Targeted-review disposition

- **Partial writes:** FIFO serialization prevents concurrent append batches from interleaving. Failed async batches are restored at the head of the bounded buffer for ordered retry. The new resume boundary isolates a process-crash tail before new records are written.
- **Large events/backpressure:** The buffer is bounded at 2,000 events and 16 MiB, failed requeues preserve the oldest admitted events, and overflow emits a throttled structured error instead of allowing unbounded heap growth. JSON serialization determines the exact UTF-8 byte charge.
- **JSONL framing:** Every normal batch uses `JSON.stringify(event)` plus a literal record newline, so newlines inside string content remain JSON-escaped.
- **Descriptors:** Constructor failure, resume-tail inspection failure, synchronous exit drain, streaming summary replay, truncate/reopen, and normal close all close or transfer ownership of their file handles. Reopen failures preserve a retryable writer state rather than leaking a newly opened handle.
- **Checkpoints and truncation:** Buffered writes drain before the byte-offset scan; Windows handles close before replace and reopen afterward; summary counters are recomputed by streaming the surviving file.

### A-14: Storage replay regression leaked its live writer handle (Low)

The full storage suite passed but emitted Node's deprecated “Closing file descriptor on garbage collection” warning. Batched isolation traced it to the end-to-end `messages_dropped` replay test: the test created a real session writer, flushed it, and never closed it. Production ownership was not implicated, but the leak made descriptor regressions noisy and will become a hard Node error in a future runtime.

**Resolution (2026-08-10):** The regression now explicitly closes its writer. The isolated leak-producing group passes without the GC descriptor warning.

---

## 5. Session Resume Validation

**File:** `packages/core/src/storage/session-store.ts`, line 39

```typescript
import {
  formatInterruptedToolNotice,
  formatResumeValidationNotice,
  validateResumeFileObservations,
} from './session-resume-validation.js';
```

**Verified:** Session resume includes validation of file observations — when resuming a session, the system checks whether files observed in the previous session still exist and match their recorded state. If they don't, a validation notice is formatted and shown to the user.

**Finding (Verified Good):** This is a well-designed feature that prevents the agent from operating on stale assumptions after a resume. The `formatInterruptedToolNotice` specifically handles the case where a tool was interrupted mid-execution.

---

## 6. Session Store: LIST_SCAN_CONCURRENCY

**File:** `packages/core/src/storage/session-store.ts`, line 110

```typescript
private static readonly LIST_SCAN_CONCURRENCY = 32;
```

**Finding (Low):** The list operation scans session directories with a concurrency of 32. On systems with slow disk I/O (e.g., network-mounted filesystems), this could create I/O pressure. However, 32 is a reasonable default for modern SSDs and local NVMe drives.

---

## 7. Session Catalog Store

**File:** `packages/core/src/session-catalog/store.ts` (1071 lines)

The session catalog store provides a higher-level API for session management, including:
- Session listing with filtering
- Summary generation
- Cross-project session discovery

### A-09: Catalog filters were applied after a bounded fetch (Medium)

The catalog-backed `DefaultSessionStore.listFiltered()` requested only the newest `max(limit, 100)` rows, then applied provider, model, date, and token filters in process. A matching session outside that unfiltered prefix was therefore reported as absent. This contradicted the method's documented filter-before-limit contract and differed from the local-index implementation.

**Resolution (2026-08-10):** The complete filter criteria now crosses the authenticated IPC protocol and is translated to parameterized SQLite predicates before ordering and `LIMIT`. Search wildcard characters are treated literally, and ordering now uses the canonical `lastActivityAt → endedAt → startedAt` fallback with deterministic ties. A 106-row regression proves an older matching record is returned with `limit: 1`; the daemon integration test proves the new fields pass the request allowlist.

### Targeted-review disposition

- **Pagination:** `list_catalog` is an intentionally bounded first-page API (`MAX_PAGE = 1000`), not an unbounded scan. No current consumer exposes cursor navigation. Applying filters in SQLite means matches are selected from the full catalog before this page bound; lack of a cursor is a product capability gap, not evidence of an incorrect current result for supported limits.
- **Corruption recovery:** Database-open corruption (`SQLITE_CORRUPT`, `SQLITE_NOTADB`, malformed image) closes and quarantines the SQLite file and its WAL/SHM sidecars, creates a fresh WAL database, and rebuilds from JSONL/summary authority. Corrupt transcript lines are skipped during summary reconstruction; sessions without a valid `session_start` are retained as explicitly damaged rows.
- **Concurrency:** Mutations use `BEGIN IMMEDIATE` transactions with a five-second SQLite busy timeout. Production writes are additionally serialized through the single authenticated project daemon. Lease and resume operations perform their conflict checks and writes inside the same transaction.
- **Cross-project discovery:** Global and per-project read-only discovery use `callExisting()` and close temporary clients. They do not call the spawning `call()` path, so inspecting an inactive project does not wake its daemon.

---

## Summary

The storage layer is well-designed for crash-safety and cross-process coordination. The main concerns are:

1. **Cross-process cache freshness** — shard manifests now validate their persisted observation before reusing a warm projection
2. **File size** — `session-store.ts` (1262) and `file-session-writer.ts` (1149) are both large
3. **Catalog client gating** — source mode vs built mode behavior difference
4. **Cache size bounds** — verified at 50 entries and 64 MiB
5. **Catalog filtering** — now executed before the bounded page limit
6. **Crash-torn resume boundary** — repaired before new append records are admitted
7. **Descriptor validation** — the leaked end-to-end test writer now closes explicitly

The Session Catalog and file-writer review boundaries are complete. The remaining observations are maintainability or measurement concerns, not demonstrated correctness defects.
