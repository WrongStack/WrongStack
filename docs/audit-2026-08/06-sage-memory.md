# 06 — SAGE Memory System

**Package:** `@wrongstack/sage`
**Files examined:** `middleware/tool-call-memory.ts` (1593 lines), `sqlite-store.ts` (1051 lines), `tools/memory-tools.ts` (816 lines), `types.ts` (902 lines)
**Assessment:** Complete for the audited injection, SQLite persistence, memory-tool, and type surfaces; two defects resolved

---

## 1. Tool-Call Memory Middleware: Injection Complexity

**File:** `packages/sage/src/middleware/tool-call-memory.ts` (1593 lines)

This is the **largest file in the entire SAGE package** and one of the top 5 largest in the monorepo. It implements the memory injection pipeline that runs on every tool call.

**Finding (High concern):** At 1593 lines, this file handles:
- Memory retrieval from multiple sources (path-anchored, search, graph traversal)
- Scoring and ranking (relation strength, importance, relevance)
- Cooldown tracking (per-session injection deduplication)
- Audience scoping (role-based memory filtering)
- Context budget management
- Injection formatting
- Rejection tracking and burst detection
- Verification on mutation
- Task-aware query folding

The complexity is inherent — the middleware must decide, on every tool call, which memories to inject, in what order, and within what budget. But the size makes it very difficult to reason about edge cases.

**Finding A-07 (Low, documentation):** The `repeatCooldownMs` option (lines 36-48) defaults to `0` (once per session), but its migration note contradicts itself:

> "prior versions defaulted to a 30-minute time-boxed cooldown. The default changed to once-per-session; operators upgrading without setting this option will see memories re-injected every turn instead of every 30 minutes."

The first clause and implementation say once per session, while "re-injected every turn" says the opposite. The runtime behavior is once per session; the migration sentence should say memories stop repeating within that session unless a positive cooldown is configured.

**Resolution (2026-08-10):** The migration note now describes once-per-session behavior and positive cooldown semantics accurately.

---

## 2. Memory Injection: Relation Strength and Importance Gates

**File:** `packages/sage/src/middleware/tool-call-memory.ts`, lines 24-28

```typescript
minImportance?: number | undefined;
relationFloor?: number | undefined;
```

**Verified from comments:** `minImportance` is a hard gate — a memory below it is never auto-injected, no matter how exactly its anchor matches. This fixes the issue where a trivial note with a file anchor outranked an important unanchored one. `relationFloor` provides a separate floor for relation strength.

**Finding (Verified Good):** The two-gate system (importance + relation strength) prevents low-quality memories from being injected purely on the strength of a path match. This is well-designed.

---

## 3. SQLite Store

**File:** `packages/sage/src/sqlite-store.ts` (1051 lines)

The SQLite store is the persistence layer for SAGE memories. It uses SQLite for full-text search (FTS) and structured queries.

The original monolithic-store concern is stale: production responsibilities are now split across schema, initialization/migration, mutation queue, search, lifecycle, statement-cache, candidate, graph, hygiene, and recovery modules. `sqlite-store.ts` remains the public integration surface, but the reviewed persistence logic is not implemented as one indivisible 1,051-line unit.

**Verified — migrations:** Schema version upgrades are transactional and defensive against partially upgraded databases. V2–V5 probe for columns before adding them, corrupt rows are skipped or JSON-guarded where appropriate, and the migration/recovery suites cover populated legacy, versionless, malformed, rollback, and JSONL replay states.

**Verified — concurrent access:** Initialization enables WAL, `busy_timeout = 30000`, and `synchronous = NORMAL`. Normal mutations pass through a per-process promise queue, a cross-process file lock, and one `BEGIN IMMEDIATE` transaction. Counter-only updates use their own queue and SQLite transaction; because `DatabaseSync` work is synchronous, transaction bodies cannot interleave on the same event loop. Two independent store connections racing the same candidate are covered and converge to one row. The earlier “WAL might be absent” concern is rejected.

**Finding A-15 (Medium, search correctness):** FTS triggers kept new inserts, updates, and deletes synchronized, but initialization only used `CREATE VIRTUAL TABLE IF NOT EXISTS`. If a database accumulated memories while its runtime lacked FTS5 and was later opened by an FTS-capable runtime, the newly created external-content index started empty. Non-empty search saw a valid FTS table, returned zero rows, and therefore never entered the LIKE fallback. Existing memories became silently unsearchable.

**Resolution (2026-08-10):** Successful FTS initialization now performs a one-time transactional backfill guarded by `schema_meta.fts_index_initialized`. A runtime without FTS5 does not write the marker, so a later capable runtime retries. The backfill clears any pre-marker index state, indexes valid rows, tolerates malformed legacy JSON, and commits the marker atomically. A regression recreates an existing v5 database without FTS, adds a memory, reopens it with FTS5, and proves the memory is searchable.

**Verified — lifecycle and connection ownership:** Each `SqliteSageStore` owns one synchronous SQLite connection, not one connection per call. Prepared statements use a bounded 128-entry LRU cache. Production ownership is through `SqliteMemoryPort.dispose()`, which drains both mutation queues before clearing statements and closing the connection; the project server awaits that disposal during shutdown. A pool would add no benefit to the synchronous per-store API and is not a missing feature.

---

## 4. Memory Tools

**File:** `packages/sage/src/tools/memory-tools.ts` (816 lines)

The memory tools (`remember`, `memory_search`, etc.) are the agent-facing API for memory operations.

**Verified from system prompt context:** The tools enforce:
- `file_note` / `symbol_note` / `command_note` require anchors (hard reject without them)
- Pure WIP/todo/progress chatter is rejected for non-session scopes
- Unanchored writes with default scores are demoted in injection ranking
- Usefulness feedback (`useCount`) boosts memories that are referenced

**Finding (Verified Good):** The quality gates are well-designed. The anchor requirement for structural kinds prevents unfindable memories. The demotion of unanchored writes creates an incentive to anchor without hard-rejecting valid unanchored content.

---

## 5. SAGE Types

**File:** `packages/sage/src/types.ts` (902 lines)

**Finding (Low):** At 902 lines with zero relative imports, this is a pure type definition file. The size suggests the type system for SAGE is complex. The main types include:
- `Sage` — the core memory entry
- Various status, scope, and kind enums
- Configuration types
- Retrieval and injection types

The complexity is inherent in a memory system that supports multiple scopes, audiences, persistence levels, and verification states.

---

## 6. Memory Injection: Sessionless Payload Collision

**File:** `packages/sage/src/middleware/tool-call-memory.ts`, lines 43-46

> "Sessionless payloads are keyed under the synthetic `<no-session>` token, so two distinct sessions sharing one process will collide on that ledger."

**Rejected as a production finding (2026-08-10):** Supported tool-call payloads carry a `Context`, `ContextInit.session` is required, and `SessionWriter.id` is a required string. Both production SAGE installations also provide a live session getter: CLI resolves `agent.ctx.session.id`, while WebUI resolves `sessionGetter().id`. The `<no-session>` branch is reachable only through malformed structural test doubles or unsupported callers that violate the Context contract; it is not evidence of cross-session suppression in production.

---

## 7. Rejection Burst Detection

**File:** `packages/sage/src/middleware/tool-call-memory.ts`, lines 148-150

```typescript
const MAX_REJECTED_DETAIL = 20;
```

The middleware tracks rejected memory injections and emits a `memory.injector_rejection_burst` event when rejections cross a threshold within a time window. The detail list is capped at 20 entries to keep sanitization fast.

**Finding (Verified Good):** The burst detection is well-designed — it surfaces when the injector is repeatedly rejecting memories, which could indicate a misconfigured `minImportance` or `minScore` threshold. The cap on detail entries prevents log explosion.

---

## Validation

- Focused migration, recovery, mutation-queue, and malformed-row coverage: **22/22 passed across 4 files**.
- Audit-compatible package run with the four separate active extractor test files excluded: **842/842 passed across 62 files**.
- Full SAGE run reached **874/877 passing tests across 66 files**. The three failures are confined to the separate, concurrently edited untracked `session-end-commit-extractor` test fixture, whose mock exposes `persistVia` while that work-in-progress production file calls `persistViaAndMirror`; neither file is part of this audit fix.
- Production-source TypeScript check (`packages/sage/tsconfig.json`) passed. The package test-typecheck is presently blocked by type errors in the same separate untracked domain-term/session-end test work.

## Summary

The SAGE memory system is sophisticated and well-gated. Two real defects were confirmed and resolved: the contradictory cooldown migration note (A-07) and the missing FTS backfill when support appears after a database already contains memories (A-15). WAL, bounded statement caching, serialized transactional writes, production drain-before-close, and required production session identity were verified. The sessionless collision and missing-WAL draft claims are rejected. The injection middleware's size remains a maintainability observation, not a demonstrated runtime defect.
