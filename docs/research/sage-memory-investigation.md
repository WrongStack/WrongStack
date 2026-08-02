# SAGe Memory System — Research Investigation Report

> **Status:** research report (2026-08-02). Read-only investigation; no code was modified by the research itself.
> **Fix status (2026-08-02, implemented after this report):**
> - **A1/A3 (session isolation in graph/audience/unified-search retrieval) — FIXED.** `sessionId`/`includeAllSessions` threaded through `findRelatedSage`, graph/tag candidate collection, `retrieveForAudience` (store + all capability surfaces + IPC protocol/dispatcher), and `executeUnifiedSearch`/`SearchOptions`. Shared `buildSessionClause` helper in `packages/sage/src/sqlite-store-search-helpers.ts`; `searchSage` + `retrieveForPath` now delegate to it. Regression tests added in `tests/session-isolation.test.ts`.
> - **B1 (usage counters polluting `updated_at`) — FIXED.** `recordSqliteInjection`/`recordSqliteUse` no longer advance `updated_at`; hygiene's `injected_never_used` retention check now ages by `lastAccessedAt ?? updatedAt`. Regression test added in `tests/feedback-counters.test.ts`.
> - All 612 sage tests pass; `@wrongstack/sage`, `@wrongstack/cli`, `@wrongstack/webui-server` typecheck clean; Biome lint clean.

---

**Scope:** storage, retrieval, formatting, injection, hygiene, retention, persistence classes, tool-result injection format, and consumers (TUI/WebUI/core). **Method:** read-only source investigation of ~70 files across `packages/sage`, `packages/webui`, `packages/tui`, `packages/core`, `packages/webui-server`.

## 1. Current state summary

The system is a SQLite-backed (`node:sqlite`, WAL, FTS5, external-content triggers) store behind a `MemoryPort` capability surface, served either in-process (`SqliteSageStore`) or through a detached IPC project server (`project-server.ts`, 33-op protocol, per-process `authToken`). It is mature and unusually well-documented: schema migrations v2→v5 are transactional and guarded, mutation serialization uses a file-lock + `BEGIN IMMEDIATE` queue with a separate counter chain, injection is a multi-gate pipeline (trigger extraction → path/lexical/graph retrieval → relation floor → importance gate → composite score → diversity selection → fence-escaped formatting → cooldown → telemetry), and hygiene implements exact-dedup, near-dedup (union-find), anchor verification, session GC, retention candidates, and opt-in tombstone purge. Two recent milestones (Phase 1/3 security + P0-1 session isolation) landed and are externally verified. The issues below are residual gaps, contract drift, and a few real bugs — not systemic failure.

## 2. Findings

### A. Retrieval & session isolation

- **A1. [HIGH → FIXED] Session isolation missing from graph-based and audience retrieval** — `findRelatedSage` options (`sqlite-store-find-related.ts:30-35`), `traverseSqliteGraph` (`sqlite-store-graph-traverse.ts:14-20`), `graphSqliteSageFor` (`graph-for.ts:20-27`), and `retrieveSqliteSageForAudience` (`sqlite-store-audience.ts:32-36`) had no session filter while `searchSqliteSage` (`search-sage.ts:30-50`) and `retrieveSqliteSageForPath` (`retrieve-path.ts:22-37`) did. The injection middleware called `findRelatedSage` without a session (`tool-call-memory.ts:648-657`), so graph-expanded memories from other sessions could be injected. *Fix: threaded `sessionId`/`includeAllSessions` through all surfaces; shared `buildSessionClause`; middleware passes `sessionId`.*
- **A2. [MEDIUM] `executeUnifiedSearch` ignores most of its own contract** — `SearchQuery` (`service-contract.ts:41-57`) declares `paths/freshness/audience/anchor/cursor`; only `text/kinds/scopes/importanceAtLeast` are applied. `suggestions: []` always, despite `docs/search-and-suggest.md` §4. `computeNormalizedScores` (`sqlite-store-search.ts:232-240`) is position-relative (`1 - index/len`), so the same memory scores differently by result-set size — contradicting the doc's "absolute 0..1 score" promise (§6). *Proposal: honor-or-reject declared fields, implement `suggest:'empty'`, make scores absolute.*
- **A3. [MEDIUM → FIXED] `unifiedSearchService` had no session/audience/contextPolicy filter** — *Fix: `SearchOptions.sessionId`/`includeAllSessions` + session clauses in both FTS and non-FTS query paths.*

### B. Storage & persistence

- **B1. [MEDIUM → FIXED] Usage telemetry pollutes `updated_at`** — `recordSqliteInjection`/`recordSqliteUse` (`sqlite-store-counters.ts`) bumped `updated_at` on every injection/use, so recency ordering reflected injection activity and hygiene's `injected_never_used` check (`sqlite-store-hygiene.ts:386`) could never fire for actively-injected memories. *Fix: counters no longer touch `updated_at`; the unused check ages by `lastAccessedAt ?? updatedAt`.*
- **B2. [MEDIUM] Three different edge-weight merge semantics** — accumulate (`sqlite-store.ts:723`), overwrite (`sqlite-store-anchor-sync.ts:31`, hygiene supersedes, JSONL migration), max (`sqlite-store-admin.ts:53`); plus a documented cross-process "last writer wins" race (`sqlite-store.ts:500-504`). *Proposal: unify on accumulate.*
- **B3. [MEDIUM] Persistence-class validation documented but not implemented** — `types.ts:577-579` claims validation; `validateRememberInput` (`store-helpers.ts:387-483`) and `updateSqliteSage` (`sqlite-store-update.ts`) never check it; `updateSage` also accepts arbitrary `kind`/`scope`.
- **B4. [LOW] `hardDeleteSage` is a misnomer** — routes through soft-delete tombstone (`sqlite-store.ts:553-566`).
- **B5. [LOW] Migrated audit rows lose structured detail** — `migrateSqliteLegacyJsonl` (`sqlite-store-jsonl-migration.ts:132-135`) stores the whole record in `data`, which `sqliteRowToAuditRecord` (`sqlite-store-codec.ts:99-116`) can't parse back into `memoryId/source/reason`.
- **B6. [LOW] Stale comments** — `idx_scope_legacy` vs actual `idx_legacy_scope` (`schema.ts:62-64` vs `initialize.ts:56`); duplicated 14-line `looksLikeSecret` comment (`store-helpers.ts:532-561`).

### C. Injection & formatting

- **C1. [MEDIUM] `recordUse` measures explicit reference, not behavioral compliance** — `consumeMatches` (`injection-tracker.ts:170-235`) credits only id citation, first-80-chars containment, or ≥0.5 token overlap; the `unusedPenalty` (`tool-call-memory.ts:866-868`) de-rates never-referenced memories even when behaviorally used.
- **C2. [MEDIUM] Turn-context `recordUse` drops `sessionId`** — `turn-memory.ts:53`.
- **C3. [MEDIUM] Turn-context system-prompt dedup lacks the 24-char guard** — `turn-memory.ts:102` vs `MIN_CONTAINS_LENGTH` (`tool-call-memory.ts:1153-1166`).
- **C4. [MEDIUM] WebUI-server wiring lacks tracker/events/monitor** — `webui-server/src/server/backend-services.ts:232-261` constructs the Sage middleware without shared `InjectionTracker`, `EventBus`, or `ContextMonitor`; no cross-path `recordUse` attribution or injector telemetry for WebUI sessions.
- **C5. [MEDIUM] SAGE-suffix parser duplicated in three packages** — byte-identical `extractSageBlock` + regex + headings in `webui/src/lib/sage-block.ts`, `tui/src/components/history/sage-output-format.ts`, `core/src/utils/sage-output-block.ts`; turn-context uses a default heading the parsers don't recognize (`format.ts:23`).
- **C6. [LOW] Cooldown ledger is per-process** (`tool-call-memory.ts:162, 769-782`).
- **C7. [LOW] Backslash-escape round-trip ambiguity** — `escapeFenceText` (`format.ts:121-132`) vs consumer unescape policy (TUI `sage-output-format.ts:64-71`).
- **C8. [LOW] Char-vs-byte budget mismatch + `(.)` anchor rendering** (`format.ts:54`, `77-85`).

### D. Hygiene, retention, verification

- **D1. [MEDIUM] `localeCompare` on timestamps survives in three modules** despite `shared/pagination.ts:127-133` documenting the bug: `sqlite-store-hygiene.ts:151,226,267`, `sqlite-store-find-file.ts:153`, `sqlite-store-jsonl-migration.ts:101`.
- **D2. [MEDIUM] Two verification strengths diverge** — hygiene inline verify is existence-only (`fs.promises.access`); `verifyMemoryAnchors` (`anchors/verify.ts:104-151`) checks content-hash/symbol/git-blob.
- **D3. [MEDIUM] Contradiction detection unimplemented; report fields hardcoded** — `contradicted: 0`, `archived: 0/archivedUnused: 0` (`sqlite-store-hygiene.ts:495-499`).
- **D4. [LOW] Command anchors are unverifiable** — `verifyAnchor` returns `'unknown'` for commands (`anchors/verify.ts:41-43`), blocking stale detection for whole memories.
- **D5. [LOW] `git hash-object` subprocess per git-anchored file** (`anchors/verify.ts:123-140`).
- **D6. [LOW] Keeper-selection rules differ across dedup paths** (hygiene vs legacy consolidate vs remember-merge).

### E. Candidates & lifecycle

- **E1. [LOW] Candidate metadata encoded in tag prefixes** — `review:`/`suggested:`/`source:` tags (`memory-candidates-tool.ts:107-112`, `sqlite-store-hygiene.ts:410-415`) parsed back by `sqlite-store-find-file.ts:89-101`; was the vector for the removed `source:<id>` retargeting fallback (`candidate-lifecycle.ts:73-83`).
- **E2. [INFO — sound] Candidate resolution race handling** — claim-then-mutate with revert-on-failure (`sqlite-store-candidates.ts:281-386`); IPC force-gate enforced (`project-server.ts:364-394`).

### F. Consumers (WebUI / TUI / core)

- **F1. [MEDIUM] WebUI `SageEntry` type mirror drifting** — `webui/src/types/sage.ts:20-43` omits `persistence`, `sources`, `useCount`, `injectionCount`, `ownerSessionId`; no drift-check test.
- **F2. [LOW] Out-of-band `sageLines` path is well-tested** (`tool-result-sage.test.tsx:147-184`, `sage-block.test.ts`).

### G. Docs & contract drift

- **G1. [MEDIUM] Four-tier SAGE guidance kept in sync by hand** — `system-pro.md` / `system.md` / `system-lite.md` / `coordination/subagent-baseline.md` (verified memory `01KYSQ89EYVQYHCBDK5SHNANB6`).
- **G2. [LOW] `search-and-suggest.md` contract vs implementation** — see A2.
- **G3. [MEDIUM — meta] SAGE's own memories drift from code** — e.g. "InjectionTracker 500→250, statement cache 128→48 with max-age" (shipped code: 500 + `Set`, 128, no expiry) and "session isolation in all retrieval paths" (was false for graph/audience/unifiedSearch). Anchor verification checks files/symbols, not semantic claims.

## 3. Proposed improvement roadmap

**Tier 1 — correctness/security (done 2026-08-02):** session isolation for graph/audience/unified-search; counters decoupled from `updated_at`; localeCompare remnants remain open (D1).

**Tier 2 — contract honesty (open):** make `unifiedSearch` honor-or-reject declared fields + absolute scores + `suggest`; single shared SAGE-block parser; unify edge-weight semantics; persistence/kind/scope validation on update.

**Tier 3 — depth (open):** contradiction detection + real archival; content-aware hygiene verification; batch `git hash-object`; typed candidate review fields; WebUI type-mirror drift check; shared tracker/events/monitor in webui-server; semantic-claim re-verification for codebase fact-memories.

## 4. Assumptions / unverified

- `packages/cli/src/wiring/sage.ts` passes the shared tracker/events (per verified memory, not re-read during research).
- `packages/core/src/utils/sage-output-block.ts` is byte-identical to the two read mirrors.
- `project-server-client.ts`/`remote-memory-port.ts` transport details and the `sage-mcp` adapter were not deep-audited.
- Embeddings: only `HashingEmbeddingProvider` exists; no vector index is wired into retrieval.
