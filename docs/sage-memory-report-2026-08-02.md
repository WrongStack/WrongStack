# SAGE Memory System Review

**Date:** 2026-08-02  
**Scope:** Architecture, storage, retrieval, ranking, lifecycle, session and audience isolation, safety, observability, configuration, and tests.

## Executive Summary

SAGE Memory has a strong technical foundation: a single SQLite owner per project, WAL mode, a detached IPC daemon, serialized mutations, FTS5 search, graph anchors, lifecycle management, hygiene, recovery, and broad test coverage.

However, several correctness and isolation issues should be addressed before investing further in semantic retrieval. Some public API contracts are ahead of their implementations, and a few edge cases can expose memory across sessions, suppress relevant results, or leave lifecycle operations in inconsistent states.

Overall, the system is mature and can be improved incrementally without replacing its core architecture. The highest-value work is to strengthen correctness guarantees while preserving the existing single-owner SQLite design.

## Architecture

```text
Runtime / CLI / WebUI / MCP
          |
      MemoryPort
          |
 ProjectSageMemoryPort
          |
   Project IPC daemon
          |
   SqliteMemoryPort
          |
   SqliteSageStore
          |
 SQLite + FTS5 + graph + audit + candidates
```

Primary components:

- Host boundary: `packages/sage/src/memory-port.ts`
- Single-writer project service: `packages/sage/src/project-server.ts`
- Persistent store: `packages/sage/src/sqlite-store.ts`
- Retrieval and ranking: `packages/sage/src/retrieval/`
- Automatic injection: `packages/sage/src/middleware/`
- Agent tools: `packages/sage/src/tools/`
- WebUI administration: `packages/webui-server/src/server/memory-handlers.ts`
- MCP adapter: `packages/sage-mcp/src/`

## Strengths

- Production uses one SQLite owner per canonical project, substantially reducing cross-process race conditions: `packages/sage/README.md:9`.
- WAL, a busy timeout, indexed reads, and transactional schema migrations are present.
- Mutations are serialized through a queue and protected by a project-level file lock.
- Anchor paths are normalized with project containment and symlink awareness.
- Lexical retrieval uses FTS5 and retains a fallback path when FTS is unavailable.
- Soft deletion, recovery, supersession, candidate review, verification, and hygiene are comprehensive.
- Automatic injection applies lifecycle, relevance, cooldown, and token-budget gates.
- The test suite is extensive: the SAGE package currently contains 583 passing tests.

## P0 Findings

### 1. Session scope does not provide actual session isolation

`Sage.scope = 'session'` exists, but a memory has no required owning session identifier. `sessionId` is stored only as optional source metadata:

- `packages/sage/src/types.ts:84`
- `packages/sage/src/types.ts:101`
- `packages/sage/src/types.ts:566`

Search options do not support filtering by the current session:

- `packages/sage/src/types.ts:646`
- `packages/sage/src/sqlite-store-search-sage.ts:16`

Turn-context injection also does not pass the current session identity into retrieval:

- `packages/sage/src/middleware/turn-memory.ts:55`

As a result, a temporary memory created in session A may be returned by searches or automatically injected in session B until hygiene deletes it.

Recommended changes:

- Add a first-class `ownerSessionId` field and indexed SQLite column.
- Require a session ID for `scope: 'session'` writes.
- Automatically filter session-scoped memories by the current request session during injection and ordinary retrieval.
- Provide an explicit `includeAllSessions` option for administrative surfaces.
- Define a controlled migration policy for existing session-scoped records that have no owner.

### 2. Audience filtering occurs after SQL `LIMIT`

Search and path retrieval fetch the top N rows first and remove audience-scoped records in JavaScript afterward:

- `packages/sage/src/sqlite-store-search-sage.ts:38-44`
- `packages/sage/src/sqlite-store-search-sage.ts:54-66`
- `packages/sage/src/sqlite-store-retrieve-path.ts:37-55`

If the first 20 matches are audience-scoped and the 21st is a general memory, automatic injection can return no result even though an eligible general memory exists.

Recommended changes:

- Add `audience IS NULL` to SQL before `ORDER BY` and `LIMIT` whenever `includeAudienceScoped: false`.
- Apply the same behavior to FTS, empty-query, LIKE fallback, graph-edge, and path-fallback retrieval.
- Add regression tests with audience-scoped rows occupying the entire initial result window.

### 3. Candidate resolution is not atomic

Candidate resolution first moves the candidate out of `pending`, then performs the target memory mutation:

- Candidate claim: `packages/sage/src/sqlite-store-candidates.ts:250`
- Target mutation: `packages/sage/src/sqlite-store-candidates.ts:275`

If deletion or archival fails, the candidate remains resolved. A retry returns `alreadyResolved: true`, so the intended action cannot be retried through the same candidate.

The acceptance path has a related boundary: it creates or merges the memory first and marks the candidate accepted in a later transaction:

- `packages/sage/src/sqlite-store-candidates.ts:145-184`

Recommended changes:

- Complete candidate and target-memory updates in one transaction.
- If a single transaction is not practical, introduce `resolving` and `failed` states with retry metadata.
- Do not persist an accepted or resolved state before the target operation commits successfully.

## P1 Findings

### 4. Deletion safety differs between adapters

The WebUI treats an omitted `force` value as `true`:

- `packages/webui-server/src/server/memory-handlers.ts:423`

The direct store-level `updateSage({ status: 'deleted' })` path requires force only for permanent records:

- `packages/sage/src/sqlite-store-update.ts:36`

WebUI, IPC, and direct SQLite consumers therefore have different deletion semantics.

Recommended changes:

- Require explicit `force: true` for every deletion at the store boundary.
- Remove the WebUI `force ?? true` default.
- Use a separate internal authorization path for controlled system operations such as candidate resolution.
- Add parity tests across WebUI, IPC, `SqliteMemoryPort`, and direct store calls.

### 5. The unified search contract is substantially ahead of its implementation

The public API advertises:

- Path, audience, and anchor filters
- Freshness and cursor filters
- Status selection
- Ranking selection
- Configurable limits
- Suggestions

Contract: `packages/sage/src/service-contract.ts:41-64`

The current implementation:

- Hard-codes the limit to 50: `packages/sage/src/sqlite-store-search.ts:24`
- Hard-codes status to `active`: `packages/sage/src/sqlite-store-search.ts:42`
- Assigns every result a score of `1.0`: `packages/sage/src/sqlite-store-search.ts:123`
- Always returns an empty suggestions array: `packages/sage/src/sqlite-store-search.ts:149`
- Always reports `hybrid` ranking.

This is a silent contract violation for typed and IPC consumers.

Recommended changes:

- Either implement the complete `SearchOptions` contract, or narrow the public type to the actual MVP behavior.
- Reject unsupported options explicitly instead of silently ignoring them.
- Add contract tests at the direct store, IPC, and external adapter boundaries.

### 6. Audience retrieval can miss rare roles

> **Fixed 2026-09-04** (bug-hunt round `audience-truncation-p1-6`). The short-term paging solution below is implemented, and the silent-miss case described here is closed: `retrieveSqliteSageForAudience` now fires the truncation signal (`onTruncated` callback + the `memory.audience_truncated` audit event) whenever the scan ends before corpus exhaustion with fewer than `limit` matches — previously a capped scan finding zero or partial matches stayed silent, indistinguishable from an empty corpus. Regression coverage: `packages/sage/tests/audience-memory.test.ts`, `describe('scan-cap truncation signal (P1-6 regression)')` — pins the scan-cap exit with zero matches (signal fires with `{sqlRowsExamined: 10000, returned: 0}`) and the exact-full-page boundary (stays silent, standard pagination semantics). The long-term recommendation (audience dimensions as indexed SQL columns) remains open.

Audience retrieval fetches only the globally highest-importance `limit * 5` audience records:

- `packages/sage/src/sqlite-store-audience.ts:35`

Matching records for a rare role may exist below this window. The truncation signal is emitted only when the number of matches already found exceeds the requested limit:

- `packages/sage/src/sqlite-store-audience.ts:59`

If the prefetch window contains zero matching records but relevant records exist later, no result and no truncation warning are produced.

Recommended changes:

- Normalize audience dimensions into indexed columns or join tables and filter them in SQL.
- As a short-term solution, page through ordered rows until enough matches are found or the corpus is exhausted.
- Return explicit `truncated` and cursor information rather than relying only on a callback.

### 7. Use attribution is not session-aware

`InjectionTracker` keys usefulness matching by memory ID and explicitly does not isolate those entries by session:

- `packages/sage/src/middleware/injection-tracker.ts:50`
- `packages/sage/src/middleware/injection-tracker.ts:166`

Although turn middleware has access to `getSessionId`, it does not pass a session ID to `consumeMatches`, `recordUse`, or `recordInjection`:

- `packages/sage/src/middleware/turn-memory.ts:50-54`
- `packages/sage/src/middleware/turn-memory.ts:131`

Concurrent sessions can therefore produce inaccurate usefulness counters and audit attribution.

Recommended changes:

- Key matchable injections by session and memory ID.
- Pass the current session ID through matching and persistence calls.
- Add concurrent multi-session attribution tests.

### 8. Corrupt records are silently presented as missing data

Persisted JSON is cast to the `Sage` type without runtime schema validation:

- `packages/sage/src/sqlite-store-codec.ts:12`

A parse error during a single-record read returns `null`:

- `packages/sage/src/sqlite-store-codec.ts:37-49`

The FTS path also catches every error and silently falls back to LIKE retrieval:

- `packages/sage/src/sqlite-store-search-sage.ts:47-69`

Data corruption and SQL defects can therefore appear as ordinary missing data or low recall.

Recommended changes:

- Add minimum runtime validation when decoding persisted records.
- Distinguish corrupt records from missing records.
- Fall back only for known FTS-unavailable errors.
- Mark memory health as degraded and emit an audit event when corruption is encountered.

### 9. Several lifecycle rewrites do not consistently increment revisions

Primary update and deletion paths increment `revision`, but hygiene performs several direct rewrites without consistently following the same revision semantics.

Affected categories include:

- Verification and freshness changes
- Exact deduplication
- Near deduplication
- Status changes performed during hygiene

Recommended changes:

- Centralize semantic memory rewrites in one helper.
- Increment `revision` and update `updatedAt` exactly once for every persisted semantic change.
- Add monotonic revision tests across verification, deduplication, session GC, recovery, and supersession.

### 10. Cancellation usually cancels the response, not the operation

The IPC client sends cancellation messages, but most store mutations do not receive or observe the abort signal. A caller can time out and report failure while the operation continues and commits.

Recommended changes:

- Check cancellation before beginning a transaction and immediately before commit for long-running operations.
- Clearly distinguish a canceled operation from a detached response when synchronous SQLite work cannot be interrupted safely.
- Add cancellation-after-dispatch tests for remember, hygiene, import, and backfill operations.

## P2 Findings

### 11. The embedding configuration is not connected to retrieval

An embedding provider and configuration surface exist, but vectors are not persisted or consumed by the current store and retrieval pipeline. Enabling embeddings currently has no practical effect.

The semantic retrieval roadmap also describes JSONL as canonical storage:

- `docs/competitive-roadmap-2026-2027/13-semantic-sage-retrieval.md:17`

The current production architecture uses SQLite as the canonical store:

- `packages/sage/README.md:9`

Recommended changes:

- Emit a clear warning or reject `embeddings.enabled: true` until it is wired.
- Update the semantic retrieval roadmap for the SQLite canonical store.
- Address retrieval correctness before adding semantic ranking.

### 12. The capability guard does not validate the complete required interface

`SageServiceLike` requires `unifiedSearchService` and `listSagePage`, but the runtime guard does not check either method:

- Contract: `packages/sage/src/service-contract.ts:146`
- Guard: `packages/sage/src/service-guard.ts:4`

An incomplete adapter can pass the guard and fail later at runtime.

Recommended changes:

- Add all required service methods to the guard.
- Add negative tests for every required capability.
- Consider separating smaller capability interfaces so consumers validate only what they use.

### 13. Documentation disagrees with current behavior

Several documents still describe retired or incomplete behavior, including JSONL as canonical storage and graph or injection features that differ from the current implementation.

Recommended changes:

- Mark historical architecture plans as superseded.
- Generate or validate configuration documentation from executable defaults where practical.
- Keep the semantic retrieval roadmap aligned with the current SQLite and daemon architecture.

## Missing Tests

The following tests should be added first:

1. A session A memory cannot be retrieved or injected in session B.
2. A general memory below N audience-scoped rows is still returned with `includeAudienceScoped: false`.
3. A rare audience role below the over-fetch window is found or truthfully reported as truncated.
4. Candidate target mutation failure leaves the candidate retryable.
5. Direct store deletion requires explicit force for non-permanent and permanent memories.
6. A WebUI delete request without force is rejected.
7. Every advertised unified search option has a contract test.
8. IPC and adapter tests verify that unified search options survive transport.
9. Revisions increase monotonically across all hygiene operations.
10. Corrupt SQLite JSON changes health state and emits an audit event.
11. Non-FTS SQL errors are surfaced instead of silently using LIKE fallback.
12. Mutation cancellation behavior is tested after server dispatch.
13. Candidate acceptance is tested across the memory-created/candidate-pending crash boundary.
14. Concurrent sessions receive correct injection and use attribution.
15. Main mutation and counter mutation queues are stress-tested together.

## Recommended Roadmap

### Phase 1: Correctness and isolation

- Add first-class session ownership and retrieval filtering.
- Move audience exclusion before SQL limits.
- Make candidate resolution atomic or explicitly retryable.
- Unify deletion authorization at the store boundary.
- Add regression tests before changing behavior.

### Phase 2: Integrity and observability

- Surface corrupt records and unexpected FTS failures.
- Standardize revision updates.
- Clarify cancellation semantics.
- Add health and audit signals for degraded retrieval.

### Phase 3: Complete the retrieval contract

- Implement all unified search filters and pagination.
- Produce meaningful normalized scores and match explanations.
- Support explicit ranking modes.
- Implement suggestion behavior or remove it from the active contract.

### Phase 4: Semantic retrieval

- Build a sanitized offline evaluation corpus first.
- Persist vectors separately from canonical memory records.
- Key vectors by normalized content hash, provider/model ID, and dimensions.
- Fuse lexical, semantic, anchor, graph, recency, and quality signals with inspectable contributions.
- Use a deterministic fallback when embeddings are unavailable or corrupt.

### Phase 5: Continuous quality measurement

Track at least:

- Recall@K
- Precision@K
- Mean reciprocal rank
- Injection usefulness ratio
- Repeatedly injected but unused memory ratio
- Cross-session isolation regressions
- Retrieval latency
- Token cost per useful injection

## Verification

The review performed the following checks without modifying production code:

- `@wrongstack/sage` tests: 46 of 46 test files passed.
- `@wrongstack/sage` tests: 583 of 583 tests passed.
- SAGE TypeScript type checking passed.
- WebUI memory handler tests: 44 of 44 tests passed.

The passing suite demonstrates that current behavior is stable. It does not invalidate the findings above because most concern uncovered boundary conditions or behavior that existing tests intentionally encode, such as the WebUI's default `force: true` deletion behavior and the MVP unified search contract.

## Final Assessment

SAGE Memory should be evolved rather than replaced. Its single-owner SQLite architecture, lifecycle model, retrieval middleware, and testing discipline provide a solid foundation.

The immediate priority should be correctness, not embeddings. Session isolation, audience filtering before limits, candidate transaction boundaries, and deletion authorization are the highest-value changes. Once those guarantees are in place, completing unified search and adding measurable semantic retrieval can improve recall without weakening the existing safety and determinism properties.
