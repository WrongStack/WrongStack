# SAGe Memory System — Research Investigation Report

> **Status:** research report (2026-08-02). Read-only investigation; no code was modified by the research itself.
> **Fix status (2026-08-02, implemented after this report):**
> - **A1/A3 (session isolation in graph/audience/unified-search retrieval) — FIXED.** `sessionId`/`includeAllSessions` threaded through `findRelatedSage`, graph/tag candidate collection, `retrieveForAudience` (store + all capability surfaces + IPC protocol/dispatcher), and `executeUnifiedSearch`/`SearchOptions`. Shared `buildSessionClause` helper in `packages/sage/src/sqlite-store-search-helpers.ts`; `searchSage` + `retrieveForPath` now delegate to it. Regression tests added in `tests/session-isolation.test.ts`.
> - **A2 (unifiedSearch contract) — FIXED.** `executeUnifiedSearch` now honors freshness/paths/audience/anchor, rejects `cursor` explicitly, implements `suggest: 'never'/'empty'/'always'` (v1 lexical adjacency), and scores absolutely (`computeAbsoluteScores`: sigmoid-bm25 × metadata for FTS, additive recency + metadata otherwise). Suggestions honor every primary filter. `tests/unified-search-service.test.ts` (12 tests).
> - **B1 (usage counters polluting `updated_at`) — FIXED.** `recordSqliteInjection`/`recordSqliteUse` no longer advance `updated_at`; hygiene's `injected_never_used` retention check now ages by `lastAccessedAt ?? updatedAt`. Regression test added in `tests/feedback-counters.test.ts`.
> - **B2 (edge-weight semantics) — FIXED.** Unified on `weight = MAX(weight, excluded.weight)` for every live writer (addGraphEdge, syncSqliteAnchorEdges, hygiene supersedes, admin recovery); the JSONL migration stays overwrite as a documented replay exemption. Policy documented beside the `edges` table in `sqlite-store-schema.ts`. `tests/edge-weight-policy.test.ts` (3 tests).
> - **B3 (persistence/kind validation) — FIXED.** `validateRememberInput` + `updateSqliteSage` reject unknown persistence/kind; `VALID_KINDS`/`VALID_SCOPES` exported from `store-helpers.ts`; `CreateCandidateInput` omits `persistence` (candidates are proposals) while the runtime path still rejects it. `tests/update-validation.test.ts` (8 tests).
> - **C4 (webui-server wiring) — FIXED.** `backend-services.ts` now passes a shared `InjectionTracker`, `events`, and `createSageContextMonitorMiddleware` (mirrors `cli/src/wiring/sage.ts`).
> - **C5 (SAGE-block parser duplication) — FIXED.** Parser centralized in `packages/core/src/utils/sage-output-block.ts` (exported via `./utils/sage-output-block` + barrel); webui/tui delegate (simpleui keeps a core-free copy with a source-drift test). Turn-context DEFAULT heading now carries the `(Memory Injector)` suffix every parser recognizes.
> - **D1 (localeCompare timestamps) — FIXED.** Byte comparison everywhere (`compareIsoAscending`/`compareIsoDescending`); only doc-comment mentions remain.
> - **D2 (verification-strength divergence) — RESOLVED BY DOCUMENTATION.** Hygiene's existence-only inline verify is intentional (cheap O(N) sweep); content-aware checks stay in `verifySqliteSage`/`verifyMemoryAnchors` on demand.
> - **D3 (contradiction detection) — FIXED.** Deterministic v1 pass (shared `isPossiblyContradictory` in `store-helpers.ts`): flags near-identical claims with opposite polarity, links `contradicts`, emits `investigate` candidates; the remember merge path refuses polarity pairs; `contradicted` report field is real. `tests/hygiene-contradiction.test.ts` + `tests/store-helpers-contradiction.test.ts`.
> - **D4 (command anchors unverifiable) — FIXED.** Existence probe in `anchors/verify.ts`: quote-aware tokenizer, per-wrapper flag-arity table, PATH walk (POSIX exec-bit), projectRoot-relative paths, platform-gated shell builtins; unknown-flag/demand-fetch ambiguity resolves to `'unknown'` (never a wrongful `'stale'` demotion). `tests/command-anchor.test.ts` (15 tests).
> - All 657 sage tests pass (53 files); `@wrongstack/sage`, `@wrongstack/core`, `@wrongstack/tui`, `@wrongstack/webui`, `@wrongstack/webui-server`, `@wrongstack/cli` typecheck clean; Biome lint clean.

---

**Scope:** storage, retrieval, formatting, injection, hygiene, retention, persistence classes, tool-result injection format, and consumers (TUI/WebUI/core). **Method:** read-only source investigation of ~70 files across `packages/sage`, `packages/webui`, `packages/tui`, `packages/core`, `packages/webui-server`.

## 1. Current state summary

The system is a SQLite-backed (`node:sqlite`, WAL, FTS5, external-content triggers) store behind a `MemoryPort` capability surface, served either in-process (`SqliteSageStore`) or through a detached IPC project server (`project-server.ts`, 33-op protocol, per-process `authToken`). It is mature and unusually well-documented: schema migrations v2→v5 are transactional and guarded, mutation serialization uses a file-lock + `BEGIN IMMEDIATE` queue with a separate counter chain, injection is a multi-gate pipeline (trigger extraction → path/lexical/graph retrieval → relation floor → importance gate → composite score → diversity selection → fence-escaped formatting → cooldown → telemetry), and hygiene implements exact-dedup, near-dedup (union-find), anchor verification, session GC, retention candidates, and opt-in tombstone purge. Two recent milestones (Phase 1/3 security + P0-1 session isolation) landed and are externally verified. The issues below are residual gaps, contract drift, and a few real bugs — not systemic failure.

## 2. Findings

### A. Retrieval & session isolation

- **A1. [HIGH → FIXED] Session isolation missing from graph-based and audience retrieval** — `findRelatedSage` options (`sqlite-store-find-related.ts:30-35`), `traverseSqliteGraph` (`sqlite-store-graph-traverse.ts:14-20`), `graphSqliteSageFor` (`graph-for.ts:20-27`), and `retrieveSqliteSageForAudience` (`sqlite-store-audience.ts:32-36`) had no session filter while `searchSqliteSage` (`search-sage.ts:30-50`) and `retrieveSqliteSageForPath` (`retrieve-path.ts:22-37`) did. The injection middleware called `findRelatedSage` without a session (`tool-call-memory.ts:648-657`), so graph-expanded memories from other sessions could be injected. *Fix: threaded `sessionId`/`includeAllSessions` through all surfaces; shared `buildSessionClause`; middleware passes `sessionId`.*
- **A2. [MEDIUM → FIXED] `executeUnifiedSearch` ignored most of its own contract** — *Fix: honors freshness/paths/audience/anchor, rejects `cursor` explicitly, implements `suggest: 'never'/'empty'/'always'` (v1 lexical adjacency), and scores absolutely (`computeAbsoluteScores`: sigmoid-bm25 × metadata for FTS, additive recency + metadata otherwise). Suggestions honor every primary filter.*
- **A3. [MEDIUM → FIXED] `unifiedSearchService` had no session/audience/contextPolicy filter** — *Fix: `SearchOptions.sessionId`/`includeAllSessions` + session clauses in both FTS and non-FTS query paths.*

### B. Storage & persistence

- **B1. [MEDIUM → FIXED] Usage telemetry pollutes `updated_at`** — `recordSqliteInjection`/`recordSqliteUse` (`sqlite-store-counters.ts`) bumped `updated_at` on every injection/use, so recency ordering reflected injection activity and hygiene's `injected_never_used` check (`sqlite-store-hygiene.ts:386`) could never fire for actively-injected memories. *Fix: counters no longer touch `updated_at`; the unused check ages by `lastAccessedAt ?? updatedAt`.*
- **B2. [MEDIUM → FIXED] Three different edge-weight merge semantics** — *Fix: unified on `weight = MAX(weight, excluded.weight)` for every live writer (the report proposed accumulate; MAX is monotone + idempotent + race-safe). The JSONL migration stays overwrite as a documented replay exemption. Policy beside the `edges` table in `sqlite-store-schema.ts`.*
- **B3. [MEDIUM → FIXED] Persistence-class validation documented but not implemented** — *Fix: `validateRememberInput` + `updateSqliteSage` reject unknown persistence/kind; `VALID_KINDS`/`VALID_SCOPES` exported; `CreateCandidateInput` omits `persistence` (candidates are proposals) with runtime defense-in-depth retained.*
- **B4. [LOW] `hardDeleteSage` is a misnomer** — routes through soft-delete tombstone (`sqlite-store.ts:553-566`).
- **B5. [LOW] Migrated audit rows lose structured detail** — `migrateSqliteLegacyJsonl` (`sqlite-store-jsonl-migration.ts:132-135`) stores the whole record in `data`, which `sqliteRowToAuditRecord` (`sqlite-store-codec.ts:99-116`) can't parse back into `memoryId/source/reason`.
- **B6. [LOW] Stale comments** — `idx_scope_legacy` vs actual `idx_legacy_scope` (`schema.ts:62-64` vs `initialize.ts:56`); duplicated 14-line `looksLikeSecret` comment (`store-helpers.ts:532-561`).

### C. Injection & formatting

- **C1. [MEDIUM] `recordUse` measures explicit reference, not behavioral compliance** — `consumeMatches` (`injection-tracker.ts:170-235`) credits only id citation, first-80-chars containment, or ≥0.5 token overlap; the `unusedPenalty` (`tool-call-memory.ts:866-868`) de-rates never-referenced memories even when behaviorally used.
- **C2. [MEDIUM] Turn-context `recordUse` drops `sessionId`** — `turn-memory.ts:53`.
- **C3. [MEDIUM] Turn-context system-prompt dedup lacks the 24-char guard** — `turn-memory.ts:102` vs `MIN_CONTAINS_LENGTH` (`tool-call-memory.ts:1153-1166`).
- **C4. [MEDIUM → FIXED] WebUI-server wiring lacks tracker/events/monitor** — *Fix: `backend-services.ts` passes a shared `InjectionTracker`, `events`, and `createSageContextMonitorMiddleware` (mirrors `cli/src/wiring/sage.ts`).*
- **C5. [MEDIUM → FIXED] SAGE-suffix parser duplicated in three packages** — *Fix: parser centralized in `core/src/utils/sage-output-block.ts` (exported via `./utils/sage-output-block` + barrel); webui/tui delegate (simpleui keeps a core-free copy with a source-drift test). Turn-context DEFAULT heading now carries the `(Memory Injector)` suffix.*
- **C6. [LOW] Cooldown ledger is per-process** (`tool-call-memory.ts:162, 769-782`).
- **C7. [LOW] Backslash-escape round-trip ambiguity** — `escapeFenceText` (`format.ts:121-132`) vs consumer unescape policy (TUI `sage-output-format.ts:64-71`).
- **C8. [LOW] Char-vs-byte budget mismatch + `(.)` anchor rendering** (`format.ts:54`, `77-85`).

### D. Hygiene, retention, verification

- **D1. [MEDIUM → FIXED] `localeCompare` on timestamps survives in three modules** — *Fix: byte comparison everywhere (`compareIsoAscending`/`compareIsoDescending`), incl. the legacy-list sorter; only doc-comment mentions remain.*
- **D2. [MEDIUM → RESOLVED BY DOCUMENTATION] Two verification strengths diverge** — *Decision: hygiene's existence-only inline verify is intentional (cheap O(N) sweep; stale-vs-active is all retention needs); content-aware checks stay in `verifySqliteSage`/`verifyMemoryAnchors` on demand via `/memory verify`.*
- **D3. [MEDIUM → FIXED] Contradiction detection unimplemented; report fields hardcoded** — *Fix: deterministic v1 pass (shared `isPossiblyContradictory` in `store-helpers.ts`): near-identical claims with opposite polarity are flagged, `contradicts` linked, `investigate` candidates emitted, and the remember merge path refuses polarity pairs (a write-time merge previously destroyed them before hygiene ran). `contradicted` is now a real count; `archived`/`archivedUnused` remain candidate-driven by design.*
- **D4. [LOW → FIXED] Command anchors are unverifiable** — *Fix: existence probe in `anchors/verify.ts` (quote-aware tokenizer, per-wrapper flag-arity table, PATH walk with POSIX exec-bit, projectRoot-relative paths, platform-gated shell builtins); unknown-flag/demand-fetch ambiguity resolves to `'unknown'`, never a wrongful `'stale'` demotion.*
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

**Tier 1 — correctness/security (done 2026-08-02):** session isolation for graph/audience/unified-search (A1/A3); counters decoupled from `updated_at` (B1); localeCompare eliminated (D1); edge-weight semantics unified (B2); persistence/kind validation on remember/update/candidates (B3); contradiction detection (D3); verifiable command anchors (D4).

**Tier 2 — contract honesty (done 2026-08-02):** unifiedSearch honors-or-rejects declared fields + absolute scores + `suggest` modes (A2); single shared SAGE-block parser with heading alignment (C5); webui-server tracker/events/monitor wiring (C4).

**Tier 3 — depth (open):** batch `git hash-object` (D5); typed candidate review fields (E1); WebUI `SageEntry` type-mirror drift check (F1); semantic-claim re-verification for codebase fact-memories (G3); `recordUse` behavioral-signal measurement (C1); turn-context `recordUse` sessionId (C2); turn-context dedup 24-char guard parity (C3); per-process cooldown ledger (C6); hygiene content-aware verification if ever needed (D2 tracked as a decision); four-tier instruction doc sync (G1).

## 4. Assumptions / unverified

- `packages/cli/src/wiring/sage.ts` passes the shared tracker/events (per verified memory, not re-read during research).
- `packages/core/src/utils/sage-output-block.ts` is byte-identical to the two read mirrors.
- `project-server-client.ts`/`remote-memory-port.ts` transport details and the `sage-mcp` adapter were not deep-audited.
- Embeddings: only `HashingEmbeddingProvider` exists; no vector index is wired into retrieval.
