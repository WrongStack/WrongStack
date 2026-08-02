# @wrongstack/sage — Refactor & Bug Report

> **⚠️ HISTORICAL:** This refactor report (2026-07-21) documents findings from
> a manual review of the pre-SQLite codebase. Many issues have since been
> addressed by the SQLite migration (JSONL→SQLite, 2026-07), Phase 1-5
> remediation (atomic writes, IPC auth, audience pagination), and the
> 2026-08-02 correctness review (`docs/sage-memory-report-2026-08-02.md`).
> Treat this document as historical context, not a current issue list.

> **Analysis Date:** 2026-07-21  
> **Scope:** `packages/sage/src/` (7,478 lines across 16 modules)  
> **Method:** Manual code review of every source file  
> **Priority:** Critical → High → Medium → Low

---

## Table of Contents

1. [Critical Findings](#1-critical-findings)
2. [High Severity Findings](#2-high-severity-findings)
3. [Medium Severity Findings](#3-medium-severity-findings)
4. [Low Severity Findings](#4-low-severity-findings)
5. [Architecture Issues](#5-architecture-issues)
6. [Performance Issues](#6-performance-issues)
7. [Test Gaps](#7-test-gaps)
8. [Phased Refactoring Plan](#8-phased-refactoring-plan)
9. [Dependency Graph](#9-dependency-graph)
10. [Rollback Strategy](#10-rollback-strategy)

---

## 1. Critical Findings

### C1. `SqliteSageStore` — No SQL Injection Protection on FTS5 Query

**File:** `packages/sage/src/sqlite-store.ts`  
**Lines:** ~640–668  
**Severity:** CRITICAL

The FTS5 search path constructs a query string with string interpolation:

```typescript
// Around line 660 — FTS5 MATCH query
const ftsQuery = `"${escapeLikePattern(query)}"`;
```

While `escapeLikePattern()` handles `LIKE` escaping (`%`, `_`, `\`), **FTS5 MATCH syntax supports operators** (`AND`, `OR`, `NOT`, `*`, `"`, `(`, `)`). A query containing FTS5 control characters (proximity `/N`, column-scoped `col:`, quoted phrases) could produce a valid but unexpected MATCH expression. Even though the store is local and the only callers are the middleware and memory_search tool (which pass user/LLM-generated text), this is still a latent injection surface.

**Fix:** Use `fts5('?', {raw: query})` or properly escape FTS5 special characters. Wrap the query in double quotes with proper escaping of `"` inside the query.

### C2. `SimHash` Band Collision + Transitive Merge Risk

**File:** `packages/sage/src/store.ts`  
**Lines:** 3121–3191  
**Severity:** CRITICAL (recall correctness)

The banded-bucketing strategy uses top 13 bits of a 64-bit SimHash as the bucket key. With `SIMHASH_BAND_BITS = 13` and `SIMHASH_THRESHOLD = 7`:

- **Birthday paradox in band**: With ~2,000 active memories, P(band collision) ≈ 1 - exp(-2000² / (2 × 2¹³)) ≈ 0.77. While the threshold check mitigates false positives, the O(N²) comparison within each bucket means that a band collision with 50+ memories creates 1,225 pairwise comparisons — still fast, but the `transitive union-find` weakness (A↔B, B↔C → A,B,C grouped even when A↔C are 20+ bits apart) means **recall false positives are possible**.

**Real risk**: Three distinct facts about the same topic (e.g., three different `pnpm` commands) could be collapsed into one group and deduplicated away, losing 2/3 of them. The `transitiveMerges` counter in the hygiene report exists to track this, but **no automatic alerting** is attached.

**Fix options (ordered by desirability):**
1. After union-find grouping, validate that every pair within a merged group is within threshold (O(N²) within the small group, not the whole bucket)
2. Keep the current approach but emit a warning event when `transitiveMerges > 0`
3. Add an explicit test for 3-way transitive collapse with diverse texts

---

## 2. High Severity Findings

### H1. `runMutation` Chain Breaks on Rejection

**File:** `packages/sage/src/store.ts`  
**Lines:** 2834–2856  
**Severity:** HIGH

```typescript
private async runMutation<T>(work: () => Promise<T>): Promise<T> {
  const next = this.mutationChain
    .catch(() => undefined)     // ⚠️ Swallows any prior mutation rejection
    .then(() => withFileLock(...));
  this.mutationChain = next;    // ⚠️ Race: if work() throws, ALL subsequent mutations hang
  try {
    return await next;
  } finally {
    if (this.mutationChain === next) this.mutationChain = Promise.resolve();
  }
}
```

**Problem 1:** If `work()` throws after the lock is acquired, the lock is released (because `withFileLock`'s cleanup runs), but `this.mutationChain` is set to a rejected promise. The `catch(() => undefined)` on the NEXT call swallows that rejection, but the `work()` rejection is NOT caught by the outer `try/finally` — it propagates to the caller **before** `this.mutationChain` is reset. The `finally` block sets `mutationChain = Promise.resolve()` ONLY when `this.mutationChain === next`, which is always true in the non-racy case. However, if two mutations are called concurrently, the second call might see `this.mutationChain === next` before the first one resets it, leading to:

- **Scenario**: Mutation A starts, mutation B arrives. B chains onto A's work. A's work throws. B's chained `.then()` receives `undefined` (from `catch(() => undefined)`) and proceeds with the stale `loaded` cache. **Mutation B operates on stale data.**

**Problem 2:** The `this.loaded = undefined` invalidation happens inside `withFileLock`'s callback (line 2843), but `this.loadedLogSignature` is checked BEFORE the mutation lock is acquired (in `loadMemories()`, line 2374). If another process modifies the file between cache invalidation and lock acquisition, the mutation might see stale data.

**Fix:** Use a proper mutex/queue pattern instead of promise-chaining:
```typescript
private mutationQueue = new PQueue({ concurrency: 1 });
// or use a simpler exclusive-lock pattern
```

### H2. `injectionCount` / `useCount` — Gaps Count as Active

**File:** `packages/sage/src/store.ts`  
**Lines:** ~1439–1568 (updateSage path)  
**Severity:** HIGH

The feedback counters (`injectionCount` and `useCount`) are **not persisted on every increment**. The store uses a `counterFlushIntervalMs` (default 1 hour) to batch-persist them. Between flushes:

1. **Memory leak**: Every `recordInjection()` and `recordUse()` call accumulates in a `Map<memoryId, Increment>` that is never cleaned if a memory is deleted before the flush
2. **Lost data**: If the process crashes between increments and flush, all counters are lost
3. **Stale counts**: The JSONL store reads counter values from disk at `loadMemories()` time; in-memory increments are not visible to concurrent reads within the same process

**Fix:** 
- Persist counters immediately for `permanent` and `short_lived` memories
- Add a TTL or max-size bound to the increment accumulator
- Emit a warning event when unflushed counts exceed a threshold (e.g., 1,000)

### H3. `SqliteSageStore` — Missing `contextPolicy` Filter in Queries

**File:** `packages/sage/src/sqlite-store.ts`  
**Lines:** Various query methods  
**Severity:** HIGH

The SQLite store's `listSuperPage()` method does not filter out `contextPolicy: 'never'` memories in automatic retrieval paths. While the middleware checks this field, the store-level API should also respect it for consistency. The JSONL store explicitly filters: `.filter(memory => memory.contextPolicy !== 'never')`.

### H4. `injection-tracker.ts` — `consumeMatches` Only Checks Token Overlap

**File:** `packages/sage/src/middleware/injection-tracker.ts`  
**Lines:** 159–179  
**Severity:** HIGH

The overlap coefficient check uses `normalizeTextKey` (NFKC + lowercase + whitespace normalize) on the assistant text, then tokenizes and checks `intersection / min(|A|, |B|)`. This has a false-positive weakness: very short memory texts (< 6 tokens) achieve threshold (0.5) even with coincidental single-word overlap.

The `minTokens` guard (default 4) mitigates but doesn't eliminate this — a 4-token memory only needs 2 overlapping tokens to trigger.

**Fix:** Add an absolute match count minimum: `intersection >= 3` regardless of ratio. Or switch to Jaccard similarity instead of overlap coefficient for shorter texts.

### H5. `tool-call-memory.ts` — `bash` Trigger Concatenates Result Without Size Check

**File:** `packages/sage/src/middleware/tool-call-memory.ts`  
**Lines:** 128–129  
**Severity:** HIGH

```typescript
if (trigger.trigger === 'bash' && nextPayload.result.content) {
  trigger.queryText = `${trigger.queryText} ${nextPayload.result.content.slice(-2_000)}`;
}
```

The result content is appended to the query text raw. For a `bash` command that outputs binary content, source code, or JSON, this slices the last 2K characters — but those characters might be non-textual (binary encoding artifacts). This could pollute the retrieval index with garbage tokens.

**Fix:** Check that the content is plausibly textual before appending (e.g., ratio of printable ASCII characters > 0.8). Or use a regex to extract only identifier-like tokens.

### H6. `findMemoriesForFile` — `normalizeProjectPath` Called on Potentially Invalid Scopes

**File:** `packages/sage/src/store.ts`  
**Lines:** ~3406  
**Severity:** HIGH

```typescript
// inside scoreForFileMemory()
const anchorPath = normalizeProjectPath(memory.scope, anchor.path);
```

The first parameter is `memory.scope` (of type `SageScope`), but `normalizeProjectPath` expects `projectRoot: string`. Since JavaScript coerces any value to string, this silently works but produces incorrect normalization for `session`/`symbol` scopes. The function should receive `this.projectRoot`.

---

## 3. Medium Severity Findings

### M1. Empty `catch {}` Blocks (21 Occurrences)

**Files:** Multiple  
**Severity:** MEDIUM

21 empty catch blocks across the codebase. While most have preceding comments explaining the swallowed error, this pattern:
- Silently hides failures in production
- Makes debugging difficult
- The `audit` method is async and fire-and-forget in some paths, so audit failures in catch blocks are themselves unobservable

**List of empty catch blocks:**

| File | Line | Context |
|------|------|---------|
| `store.ts` | 148 | Malformed page cursor |
| `store.ts` | 1350 | Candidates log missing |
| `store.ts` | 1693 | Legacy file read failure |
| `store.ts` | 1878 | Permanent candidate guard |
| `store.ts` | 1949 | `createCandidate` failure |
| `store.ts` | 2487 | Log stat file missing |
| `store.ts` | 3247 | Audience validation |
| `store.ts` | 3570 | Source path normalization |
| `sqlite-store.ts` | 103 | Malformed cursor |
| `sqlite-store.ts` | 124 | `DatabaseSync` probe |
| `sqlite-store.ts` | 230 | FTS5 creation failure |
| `sqlite-store.ts` | 666 | FTS5 query failure |
| `sqlite-store.ts` | 1066 | Anchor access check |
| `sqlite-store.ts` | 1138 | Edge table insert failure |
| `sqlite-store.ts` | 1509 | Candidate resolution |
| `sqlite-store.ts` | 1579 | `createCandidate` failure |
| `jsonl.ts` | 73 | `readJson` parse failure |
| `anchors/verify.ts` | 57 | `stat` failure |
| `anchors/verify.ts` | 101 | Git hash-object failure |
| `middleware/tool-call-memory.ts` | 762 | JSON parse of result content |
| `middleware/turn-memory.ts` | 137 | Turn middleware handler failure |

**Fix (per catch block, not uniform):** Either:
1. Add structured logging via `audit()` or `console.warn()`
2. Lift the comment into an error object
3. For cursor decode failures: increment a counter instead of silent swallow

### M2. `store.ts` / `sqlite-store.ts` — Duplicated Normalization Functions

**File:** Both stores  
**Severity:** MEDIUM

`store.ts` defines its own `normalizeText()`, `validateRememberInput()`, `normalizeAudience()`, `normalizeSelectorValue()`, `dedupeAnchors()`, `dedupeSources()`, `dedupeByKey()`, `canonicalMemoryText()`, `normalizeTags()`, `normalizeAudience()` — many of which are EXACT duplicates of functions in `store-helpers.ts`.

`store.ts` has 8 duplicated functions totaling ~250 lines. Each duplication is a maintenance hazard — fixing a normalization bug in one but not the other creates an inconsistent codebase.

**Fix:** Import from `store-helpers.ts` into both stores. The `store.ts` versions exist because `store-helpers.ts` was extracted later.

### M3. `findNearDuplicateGroups` — O(N²) Within Bucket, No Hard Timeout

**File:** `packages/sage/src/store.ts`  
**Lines:** 3130–3192  
**Severity:** MEDIUM

The inner pair loop (`for i, for j`) within each bucket is O(m²) where m is the bucket size. With `SIMHASH_BAND_BITS = 13`, a bucket with 2,000 memories (birthday-paradox plausible) creates ~2 million pairwise comparisons. Each comparison involves a `hammingDistance64()` call that loops over 64 bits.

**Fix:** Add a bucket-size cap (e.g., skip near-dedup for buckets > 200) or a time budget. The SimHash already bucketed, so large buckets are likely populated by near-duplicate texts anyway — but the pair loop should still have an upper bound.

### M4. `applyDeclaredRelationships` — Race Condition in Non-Atomic Read-Then-Write

**File:** `packages/sage/src/store.ts`  
**Lines:** 2783–2814  
**Severity:** MEDIUM

```typescript
private async applyDeclaredRelationships(memory: Sage): Promise<void> {
  const all = await this.loadMemories();
  for (const id of memory.supersedes ?? []) {
    const target = all.find(...);
    if (!target) continue;
    await this.updateMemory(target, { status: 'superseded', supersededBy: memory.id });
    // ...but `target` was read before `updateMemory` was called
  }
}
```

Between reading `all` from disk and calling `updateMemory()`, another concurrent mutation could change the target memory's status. While `runMutation` serializes in-process mutations, cross-process writes from another WrongStack instance could race here.

**Severity reduced to medium** because `runMutation` + file locks serialize within-project access. Cross-project races are possible but unlikely.

### M5. `tool-call-memory.ts` — Cooldown Map Memory Leak

**File:** `packages/sage/src/middleware/tool-call-memory.ts`  
**Lines:** 97, 245, 582–588  
**Severity:** MEDIUM

```typescript
const seen = new Map<string, number>();  // Module-scope, never fully cleaned
```

The cooldown map is module-level (closure variable in `createSageToolCallMiddleware`). `pruneCooldowns()` only fires when `seen.size > 10_000`. In a long-lived session with 100s of memory injections per tool call, this map can grow to 10K+ entries, all kept alive in memory.

**Fix:** Replace with a bounded LRU cache or a `Map` with TTL sweeps on every insertion (not just size-based).

### M6. `graph/graph.ts` — Full File Rewrite on `removeNodeEdges()` / `removeEdge()`

**File:** `packages/sage/src/graph/graph.ts`  
**Lines:** 135–165, 170–196  
**Severity:** MEDIUM

Every edge removal reads ALL edges, modifies one `deletedAt` field, then rewrites the ENTIRE file. For a project with 10,000+ edges (easily reachable in a large repo with auto-generated memory relationships), this is very expensive.

**Fix:** Use append-only JSONL for edge deletions too (write a copy of the edge with `deletedAt` set), then perform the rewrite during compaction. Or switch to SQLite-backed edge storage.

### M7. `turn-memory.ts` — Cache Invalidation Version Bump Coupling

**File:** `packages/sage/src/middleware/turn-memory.ts`  
**Lines:** 227–258  
**Severity:** MEDIUM

```typescript
const NORMALIZER_VERSION = 'v1';
```

The documentation warns about a `NORMALIZER_VERSION` that must be manually bumped when `normalizeTextKey` changes. This is a **cross-package coupling** — `normalizeTextKey` is in `store-helpers.ts`, but the cache version is in `turn-memory.ts`. A developer modifying `store-helpers.ts` may never see this comment, causing a silent recall regression.

**Fix:** Move the version constant to `store-helpers.ts` and import it in `turn-memory.ts`.

---

## 4. Low Severity Findings

### L1. `memoryInjectorAgent.ts` — `ctx.meta` Mutation is Invasive

**File:** `packages/sage/src/middleware/memory-injector-agent.ts`  
**Lines:** 58–68  
**Severity:** LOW

```typescript
ctx.meta['memoryInjectorLastRun'] = { ... };
```

The injector agent mutates the shared `ctx.meta` object. If other middleware or the application logic reads this key, they'll see the injection run metadata. This is a minor protocol contamination.

### L2. `store.ts` — `const DEFAULT_PAGE_STATUSES` Mirrored in `sqlite-store.ts`

Both files define identical `DEFAULT_PAGE_STATUSES`, `MAX_PAGE_LIMIT`, and pagination helpers. ~40 lines of duplicated code.

### L3. `Anchors/verify.ts` — `containsSymbol()` Uses Unanchored Regex

```typescript
new RegExp(`\\b${escaped}\\b`).test(text);
```

The `\b` word boundary matches at [A-Za-z0-9_] transitions. For symbols containing `$`, `#`, `.`, or other non-word characters, the `\b` assertion may not work correctly. Example: `$secret` or `C++` are not valid `\b` positions.

### L4. `store.ts` — `scoreMemoryRelationship` Function Duplicated

`store-helpers.ts` exports `scoreMemoryRelationship` (for both stores), but `store.ts` also defines internal helper functions that partially overlap with it. The `memoryRelationshipProposals()` in `store.ts` re-implements the same logic.

### L5. `tool-call-memory.ts` — `extractPatchPaths()` Uses Regex on Entire Input

```typescript
for (const match of input.patch.matchAll(/^\+\+\+\s+([^\t\r\n]+)/gm)) {
```

The `patch` input can be arbitrarily large (generated by `git diff` for entire repos). The regex match creates a potentially large array of results.

### L6. `store.ts` — `fileSignature()` Race

```typescript
const stat = await fs.stat(filePath);
return `${stat.size}:${stat.mtimeMs}`;
```

Between `stat` and the return value, another process could modify the file. The signature is used as a cache key; a stale cache hit could serve data that was read before the modification completed.

---

## 5. Architecture Issues

### A1. `store.ts` is 3,772 Lines — Monolithic God Class

**Severity:** HIGH

The JSONL store contains:
- CRUD operations (remember, update, delete, recover)
- Hygiene pipeline (dedup, near-dup, verify, contradictions)
- Pagination (listSuperPage with cursor encoding)
- Graph integration (auto-edges, relationship proposals)
- Backfill recovery
- File-drawer queries (findMemoriesForFile)
- Audit logging
- Cache management (loaded, loadedLogSignature)
- Mutation serialization (mutationChain)
- Compaction (log compaction, purge)
- Index management (writeIndexes, writeSnapshot)
- Legacy API implementation (remember, forget, search, list, findRelated)

**Suggested split:**
```
store.ts → SageStore (core CRUD + loadMemories + runMutation)
           ├── SageHygieneEngine   (hygiene pipeline)
           ├── SageGraphEngine     (auto-edges, proposals)
           ├── SagePagination      (listSuperPage, cursor)
           ├── SageFileDrawer      (findMemoriesForFile)
           └── SageBackfill        (recovery, backfill)
```

### A2. SQLite Store Feature Gap

**Severity:** MEDIUM

`SqliteSageStore` lacks:
- `findMemoriesForFile()` — the 3-bucket file-drawer query
- `findRelatedSuper()` — graph-based related memory discovery
- `verify()` — anchor verification
- `backfillRecoverable()` — tombstone recovery
- `graphFor()` — graph traversal from query
- `compactLog()` — log compaction (N/A for SQLite)
- `retrieveForAudience()` — role/task/mode-based retrieval

This means SQLite users fall back to the JSONL store for these features, negating many performance benefits.

### A3. Cross-Process Safety is Fragile

**Severity:** MEDIUM

The store uses `withFileLock` for cross-process safety, but:
- `loadMemories()` checks `fileSignature()` without a lock
- Between the signature check and the mutation lock acquisition, another process can modify the file
- The signature includes `mtimeMs` which has ~1ms resolution on most filesystems — rapid mutations within 1ms won't be detected
- Windows has inferior file locking semantics compared to POSIX

### A4. No Read-Only Replica Pattern

The full-load JSONL pattern means every read operation (search, list, paginate) loads all memories. With 10,000+ memories, even reads are expensive. A read-only replica (in-memory cache, SQLite replica, or periodic index) would help.

---

## 6. Performance Issues

### P1. JSONL Full-Load-on-Every-Read

Every `searchSuper()`, `retrieveForPath()`, `listSuperPage()`, and `findMemoriesForFile()` call reloads the entire JSONL log (if cache signature mismatch). For 10K records:

- `memories.jsonl` ≈ 10–50 MB
- Each read → parse every line → filter by revision → O(10K) objects
- Memory: 10K `Sage` objects ≈ 50–100 MB

**Mitigation:** The cache key (`size:mtimeMs`) makes this cheap for repeated reads without concurrent writes, but every mutation invalidates the cache.

### P2. `afterMutation()` Writes 7 Files

```typescript
private async afterMutation(): Promise<void> {
  const memories = await this.loadMemories();   // Full reload
  const snapshotId = await this.writeSnapshot(memories);  // Write all memories
  await this.writeIndexes(memories);            // Write 5 index files
  await this.writeManifest(snapshotId);          // Write manifest
  await this.maybeCompactLog();                 // Maybe rewrite entire log
}
```

Every single mutation triggers 7+ file I/O operations: 1 full read + 1 snapshot write + 5 index writes + 1 manifest write + occasionally 1 full log rewrite.

### P3. `writeIndexes()` Writes 5 Separate Files

The index writing is wasteful: 5 separate `writeJson` calls for `by-path.json`, `by-symbol.json`, `by-tag.json`, `by-kind.json`, `lexical.json`. A single file with all indexes would reduce I/O overhead and keep the snapshots consistent.

### P4. `graph/graph.ts` — `list()` Re-Parses All Edges Every Time

```typescript
async list(): Promise<MemoryGraphEdge[]> {
  const records = await readJsonl<MemoryGraphEdge>(this.edgesLog);
  // Parse every line, filter out deleted
}
```

Every graph traversal starts by re-reading and re-parsing ALL edges. For a project with 10K+ edges, this is O(10K) parse + O(10K) filter on every graph read. Graph reads happen on every memory creation (auto-edges) and on every `findRelatedSuper()` call.

---

## 7. Test Gaps

| Area | Coverage | Gaps |
|------|----------|------|
| `store.ts` CRUD | Good | Missing tests for concurrent mutations, cross-process |
| `sqlite-store.ts` | Basic | Missing: FTS5 fallback, migration from corrupt JSONL, edge deletion cascade |
| Hygiene | Good | Missing: `purgeDeletedAfterDays` path, near-dup with diverse texts |
| Graph | Good | Missing: `addMany` with existing edges (duplicate prevention), traversal with depth limit interaction |
| Middleware (tool-call) | Basic | Missing: bash trigger injection, cooldown timing, edge cases in diversity selection |
| Middleware (turn) | Basic | Missing: system prompt cache hit/miss edge cases, large system prompt performance |
| InjectionTracker | Good | Missing: cross-session attribution, TTL expiry at scale |
| `findMemoriesForFile` | None | No dedicated tests for the 3-bucket response |
| `backfillRecoverable` | None | No tests for recovery pipeline |
| `SqliteSageStore.hygiene` | None | SQLite hygiene path is untested |
| Audience scoping | Partial | Missing: role/task/mode combinations |

---

## 8. Phased Refactoring Plan

### Phase 1: Low Risk / High Payoff (Safe, No Behavior Change)

| Step | Description | Files Affected | Effort | Risk |
|------|-------------|----------------|--------|------|
| 1.1 | Remove duplicated normalization functions from `store.ts`; import from `store-helpers.ts` | `store.ts` | 1h | Low |
| 1.2 | Remove duplicated pagination constants from `sqlite-store.ts`; import from shared location | `sqlite-store.ts`, `store.ts` | 30m | Low |
| 1.3 | Move `NORMALIZER_VERSION` to `store-helpers.ts` | `turn-memory.ts`, `store-helpers.ts` | 15m | Low |
| 1.4 | Add `contextPolicy` filter to SQLite store queries | `sqlite-store.ts` | 30m | Low |
| 1.5 | Fix `normalizeProjectPath` call in `scoreForFileMemory` to use `this.projectRoot` | `store.ts` | 5m | Low |
| 1.6 | Replace empty `catch {}` at cursor decode with structured logging | `store.ts`, `sqlite-store.ts` | 30m | Low |
| 1.7 | Fix `containsSymbol()` regex for non-word symbols | `anchors/verify.ts` | 20m | Low |

### Phase 2: Medium Risk (Behavior Change, Test Heavily)

| Step | Description | Files Affected | Effort | Risk |
|------|-------------|----------------|--------|------|
| 2.1 | FTS5 query parameterization in SQLite store | `sqlite-store.ts` | 1h | Medium |
| 2.2 | Add absolute match minimum to `consumeMatches()` | `injection-tracker.ts` | 30m | Medium |
| 2.3 | Replace cooldown map with bounded LRU cache | `tool-call-memory.ts` | 1h | Medium |
| 2.4 | Add content-type check to bash trigger injection | `tool-call-memory.ts` | 30m | Medium |
| 2.5 | Add SimHash bucket size cap + warning event | `store.ts` | 1h | Medium |
| 2.6 | Add transitive merge validation in near-dup groups | `store.ts` | 1.5h | Medium |
| 2.7 | Make `injectionCount`/`useCount` flush atomic on per-delete | `store.ts` | 1h | Medium |
| 2.8 | Add bucket-size cap to near-dup pair loop | `store.ts` | 30m | Medium |

### Phase 3: High Risk (Requires Full Regression)

| Step | Description | Files Affected | Effort | Risk |
|------|-------------|----------------|--------|------|
| 3.1 | Replace `runMutation` promise-chain with proper mutex | `store.ts` | 2h | High |
| 3.2 | Extract hygiene engine from store.ts | `store.ts` → `hygiene/` | 3h | High |
| 3.3 | Extract file-drawer query from store.ts | `store.ts` → `retrieval/` | 2h | High |
| 3.4 | Implement SQLite `findMemoriesForFile` | `sqlite-store.ts` | 3h | High |
| 3.5 | Implement graph edge append-only deletion (no rewrite) | `graph/graph.ts` | 2h | High |
| 3.6 | AfterMutation I/O batching (single atomic snapshot) | `store.ts` | 4h | High |

### Phase 4: Future (Post-Roadmap)

| Step | Description | Effort |
|------|-------------|--------|
| 4.1 | In-memory read-only replica for high-frequency reads | 5h |
| 4.2 | Configurable backend selection (JSONL / SQLite / hybrid) | 8h |
| 4.3 | Eventual-consistency cross-process replicas | 16h |
| 4.4 | Profiling-guided SimHash threshold auto-tuning | 4h |

---

## 9. Dependency Graph

```
Phase 1 (Low Risk)
├── 1.1 (duplicated fns) → prerequisite for Phase 3.2
├── 1.2 (pagination consts)
├── 1.3 (version constant)
├── 1.4 (contextPolicy)
├── 1.5 (path normalization)
├── 1.6 (empty catch) → 2.7 (counter flush) depends on knowing which catches are safe
└── 1.7 (symbol regex)

Phase 2 (Medium Risk)
├── 2.1 (FTS5) → independent
├── 2.2 (consumeMatches) → independent
├── 2.3 (cooldown LRU) → independent
├── 2.4 (bash content check) → independent
├── 2.5 (SimHash cap) → 2.6 (transitive validation) depends on 2.5
├── 2.6 (transitive merge validation)
├── 2.7 (counter flush safety) → depends on 1.6
└── 2.8 (bucket size cap)

Phase 3 (High Risk)
├── 3.1 (mutex) → 3.2, 3.3 depend on stable mutation framework
├── 3.2 (extract hygiene) → depends on 1.1, 3.1
├── 3.3 (extract file-drawer) → depends on 3.1
├── 3.4 (SQLite file-drawer) → independent
├── 3.5 (graph append-only) → independent
└── 3.6 (afterMutation batch) → depends on 3.1, 3.2, 3.3
```

**Critical Path:** 1.1 → 3.1 → 3.2 → 3.6 (the longest chain enabling the biggest gains)

---

## 10. Rollback Strategy

### Per-Step Rollback

Each Phase 1 and 2 step is small enough to be a single commit:

```bash
git revert <commit> -m "revert: <step description>"
git commit -m "revert: <step>"
```

### Phase 3 Rollback

Each extraction produces a well-defined module boundary. Rollback strategy:
1. Delete the extracted file(s)
2. Restore the original inline code in `store.ts` (preserved in git history)
3. No data migration needed — the JSONL/SQLite data format is unchanged

### Data Safety Guarantees

None of the proposed changes alter the JSONL schema or SQLite schema. Every refactoring step:

- Keeps existing `memories.jsonl` records parseable
- Preserves the `Sage` shape
- Maintains backward compatibility with the existing `SageStore` constructor
- Does not change the `SqliteSageStore` database schema

### Test Strategy for Rollback Verification

For each phase, the existing 27 test files must pass at the commit boundary:

```bash
pnpm --filter @wrongstack/sage test
pnpm --filter @wrongstack/sage typecheck
```

If any Phase 3 change causes a test failure, the extraction is incomplete — revert and fix.

---

## Summary of Findings

| Severity | Count | Action Required |
|----------|-------|-----------------|
| Critical | 2 | Fix before next release |
| High | 6 | Fix in current sprint |
| Medium | 7 | Schedule for next sprint |
| Low | 6 | Fix opportunistically |
| Architecture | 4 | Phase 3 roadmap |
| Performance | 4 | Phase 3–4 roadmap |
| Test Gaps | 8 | Add alongside fixes |

**Total actionable items: 37**
**Total estimated effort (Phases 1–3): ~25–30 developer hours**
