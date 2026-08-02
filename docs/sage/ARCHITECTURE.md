# @wrongstack/sage — Architecture Reference

> **⚠️ PARTIALLY SUPERSEDED:** This document references JSONL as the canonical
> storage backend. As of 2026-07, SQLite replaced JSONL as the sole persistent
> store (`SqliteSageStore` with FTS5 + WAL mode). JSONL is now only a one-shot
> migration source (`sqlite-store-jsonl-migration.ts`). Sections describing
> JSONL data flow, file-watching, and atomic-write semantics are historical.
> Refer to `packages/sage/README.md` for the current architecture.

> **Package:** `@wrongstack/sage`  
> **Version:** `0.295.0`  
> **License:** MIT  
> **Author:** ECOSTACK TECHNOLOGY OÜ  
> **Source:** `packages/sage/src/` (12 modules, ~7,500 lines)  
> **Tests:** `packages/sage/tests/` (27 files, ~4,500+ lines)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [Module Map](#3-module-map)
4. [Storage Backends](#4-storage-backends)
5. [Middleware Layer](#5-middleware-layer)
6. [Retrieval System](#6-retrieval-system)
7. [Knowledge Graph](#7-knowledge-graph)
8. [Anchor Verification](#8-anchor-verification)
9. [Embedding System](#9-embedding-system)
10. [Tool Surface](#10-tool-surface)
11. [Review Queue](#11-review-queue)
12. [Hygiene Pipeline](#12-hygiene-pipeline)
13. [Event System](#13-event-system)
14. [Security Model](#14-security-model)
15. [Legacy Compatibility](#15-legacy-compatibility)

---

## 1. Overview

SAGE is WrongStack's **project-local, persistent, structured long-term memory** system. It lives at `.wrongstack/memories/` per project, backed by SQLite (`sage.db`). Legacy JSONL files are auto-imported once on first open and retained only as recovery backups.

### Core Responsibilities

- **Persist** structured project knowledge (facts, decisions, conventions, preferences, etc.)
- **Bind** knowledge to concrete code locations via anchors (files, symbols, directories, commands, packages, git blobs, tests)
- **Verify** that anchors remain valid over time (file existence, content hash, git blob, symbol presence)
- **Relate** memories through a knowledge graph with typed edges and BFS traversal
- **Inject** relevant memories into LLM context automatically via two middleware pipelines
- **Track** usage feedback (which injected memories the assistant actually references)
- **Review** proposed deletions/archivals through a non-destructive candidate queue
- **Audit** every mutation with a structured JSONL audit trail
- **Hygiene** — deduplicate, verify, and surface candidates for cleanup (never auto-deletes)

### Architecture Diagram (Conceptual)

```
┌─────────────────────────────────────────────────────┐
│                    Agent / LLM                       │
├─────────────────────────────────────────────────────┤
│  Tool Calls (13 tools)    │  Middleware (2 pipelines)│
└──────────────────┬────────┴────────────┬────────────┘
                   │                     │
┌──────────────────▼─────────────────────▼────────────┐
│                 SqliteSageStore                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ SQLite+FTS5 │  │ Graph Engine  │  │ Audit Log   │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
│  ┌─────────────┐  ┌──────────────┐                    │
│  │ JSONL Import│  │ Anchor Verify│                    │
│  └─────────────┘  └──────────────┘                    │
└──────────────────────────────────────────────────────┘
```

---

## 2. Data Model

### 2.1 `Sage` — Primary Record

```typescript
interface Sage {
  id: string;                    // ULID-based unique ID
  revision: number;              // Incremented on every mutation
  scope: SageScope;       // project | user | session | file | symbol
  kind: SageKind;         // 13 distinct types
  status: SageStatus;     // 6 lifecycle states
  persistence: PersistenceClass; // permanent | long_lived (default) | short_lived
  
  text: string;                  // The knowledge content (max 20K chars)
  summary?: string;
  
  // Quality scores (0..1 each)
  importance: number;
  confidence: number;
  freshness: number;
  
  tags: string[];                // Indexable labels (max 128, 256 chars each)
  anchors: MemoryAnchor[];       // Concrete code location bindings
  audience?: MemoryAudienceSelector; // Role/task/mode scoping
  sources: MemorySourceRef[];    // Provenance chain
  
  // Relationship tracking
  supersedes?: string[];         // Memory IDs this replaces
  supersededBy?: string;         // ID of the memory that superseded this
  contradicts?: string[];        // Memory IDs this contradicts
  
  // Temporal tracking
  createdAt: string;             // ISO-8601
  updatedAt: string;             // ISO-8601
  lastAccessedAt?: string;
  lastVerifiedAt?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  
  // Feedback counters (approximate, batch-persisted)
  injectionCount?: number;       // Times injected into context
  useCount?: number;             // Times referenced by assistant
}
```

### 2.2 Memory Kinds (13)

| Kind | Purpose | Example |
|------|---------|---------|
| `fact` | Codebase facts | "The API uses cursor-based pagination" |
| `decision` | Architecture decisions | "Chose SQLite over PostgreSQL for local dev" |
| `convention` | Project conventions | "All tests use Vitest with `vi.mock()`" |
| `preference` | User preferences | "Prefer short names over descriptive" |
| `warning` | Warnings | "Never use `as any` in this module" |
| `anti_pattern` | Anti-patterns | "Event bus in tests causes flakiness" |
| `workflow` | Reusable workflows | "Run `pnpm typecheck` before commit" |
| `bug_root_cause` | Bug root causes | "Race in SessionStore.finalize()" |
| `file_note` | File-specific notes | "This file handles auth middleware" |
| `symbol_note` | Symbol-specific notes | "This function is the entry point" |
| `command_note` | Command notes | "Use this to build the package" |
| `summary` | Summaries | "The security layer has 3 components" |
| `memory_review` | Review records | Hygiene-generated review entries |

### 2.3 Scopes (5)

| Scope | Visibility |
|-------|-----------|
| `project` | Shared across all agents/sessions in the project |
| `user` | Personal to a user |
| `session` | Current session only |
| `file` | Bound to a specific file |
| `symbol` | Bound to a specific symbol |

### 2.4 Lifecycle States (6)

```
active ──→ stale ──→ superseded ──→ archived ──→ deleted
  │                                         ↑
  └─────────→ contradicted ─────────────────┘
```

- **active**: Normal, retrievable, injectable
- **stale**: Anchor validation failed (file missing, content changed)
- **superseded**: A newer version replaced this
- **contradicted**: Another memory contradicts this
- **archived**: Retired from active use
- **deleted**: Soft-delete tombstone (audit trail, recoverable)

### 2.5 Persistence Classes (3)

| Class | Hygiene Behavior |
|-------|-----------------|
| `permanent` | Never deleted, never suggested for deletion. `{force: true}` required to override. |
| `long_lived` | Default. Hygiene reviews but never auto-deletes. |
| `short_lived` | Subject to time-based review thresholds. `expiresAt` for hard TTL. |

### 2.6 Anchor Types (7)

| Type | Path Required | Extra Required | Storage Node |
|------|--------------|----------------|--------------|
| `file` | Yes | — | `file:<rel-path>` |
| `directory` | Yes | — | `dir:<rel-path>` |
| `symbol` | Yes | `symbol` string | `symbol:<path>#<symbol>` |
| `package` | Yes (directory) | — | `dir:<path>` |
| `command` | No | `command` string | `command:<cmd>` |
| `test` | Yes | — | `file:<rel-path>` |
| `git` | Yes | — | `file:<rel-path>` |

### 2.7 Conversion Functions

The types module provides bidirectional converters between SAGE memory types and the legacy `@wrongstack/core` `MemoryEntry`/`MemoryScope`/`MemoryType` types:

- `superToLegacyScope()` / `legacyToSuperScope()`
- `kindToLegacyType()` / `legacyTypeToKind()`
- `toLegacyEntry()` — full Sage to MemoryEntry conversion
- `priorityFromImportance()` — numeric 0..1 → critical/high/medium/low

---

## 3. Module Map

### 3.1 Source Module Inventory

| Module | Lines | Role |
|--------|-------|------|
| `store.ts` | 3,772 | Primary JSONL-backed store (all CRUD, hygiene, graph, backfill) |
| `sqlite-store.ts` | 1,804 | SQLite backend alternative (performance-optimized subset) |
| `tools/memory-tools.ts` | 771 | 13 agent-exposed tool definitions |
| `types.ts` | 909 | All type definitions, converters, event augmentation |
| `middleware/tool-call-memory.ts` | 890 | Tool-result-triggered memory injection |
| `store-helpers.ts` | 275 | Shared normalization/validation utilities |
| `middleware/turn-memory.ts` | 311 | Per-turn query-based memory injection |
| `middleware/injection-tracker.ts` | 246 | In-memory injection registry + use detection |
| `graph/graph.ts` | 234 | Knowledge graph (JSONL-backed edge store) |
| `anchors/verify.ts` | 126 | Anchor existence/content verification |
| `embeddings/hashing.ts` | 132 | Offline deterministic hash-based embeddings |
| `middleware/memory-injector-agent.ts` | 145 | Task-aware budget planning for injection |
| `middleware/context-monitor.ts` | 51 | Context snapshot event emitter |
| `jsonl.ts` | 77 | JSONL I/O primitives (append, read, corrupt handling) |
| `paths.ts` | 59 | Project path resolution, normalization |
| `embeddings/provider.ts` | 38 | EmbeddingProvider interface |
| `index.ts` | 61 | Public API exports |

### 3.2 Dependency Graph (Internal)

```
index.ts
  ├── paths.ts              (standalone)
  ├── store.ts              
  │   ├── jsonl.ts          (I/O)
  │   ├── store-helpers.ts  (validation, normalization)
  │   ├── graph/graph.ts    (knowledge graph)
  │   ├── anchors/verify.ts (anchor verification)
  │   └── types.ts          (types + converters)
  ├── sqlite-store.ts
  │   ├── jsonl.ts
  │   ├── store-helpers.ts
  │   ├── paths.ts
  │   └── types.ts
  ├── middleware/tool-call-memory.ts
  │   ├── retrieval/format.ts
  │   ├── retrieval/relevance.ts
  │   ├── middleware/turn-memory.ts
  │   ├── middleware/memory-injector-agent.ts
  │   └── types.ts
  ├── middleware/turn-memory.ts
  │   ├── retrieval/format.ts
  │   ├── retrieval/relevance.ts
  │   ├── store-helpers.ts
  │   ├── middleware/injection-tracker.ts
  │   └── types.ts
  ├── tools/memory-tools.ts
  │   └── types.ts
  ├── embeddings/hashing.ts
  │   └── embeddings/provider.ts
  └── types.ts              (standalone event augmentation)
```

---

## 4. Storage Backends

### 4.1 `SageStore` (JSONL) — Primary

**File:** `store.ts` (3,772 lines)

#### Architecture

- **Append-only JSONL** at `memories.jsonl`
- Each line is a `SageRecord` with `recordType`, `schemaVersion`, `op` (create/update/delete), and the full `Sage` object
- **Full-load pattern**: Every read loads all records from JSONL, applies revision-based dedup (latest revision wins), and caches in `this.loaded`
- **Cache invalidation**: Cache key is `size:mtimeMs` — any mutation clears the cache
- **Snapshot safety**: After every mutation, writes a `latest.json` snapshot to `snapshots/`; if the JSONL log is empty or corrupt, the snapshot is used as fallback

#### Mutation Safety

```typescript
private async runMutation<T>(work: () => Promise<T>): Promise<T> {
  // Serializes mutations via Promise chain (this.mutationChain)
  // Guards concurrent process access via withFileLock
  // Invalidates cache at start of each mutation
}
```

- **In-process serialization**: Promise-chain `this.mutationChain` ensures mutations don't interleave
- **Cross-process locking**: `withFileLock(path/to/locks/store-mutation, ...)` with 60s timeout
- **Atomic write**: All file writes use `atomicWrite` (write to `.tmp`, then `rename`)
- **Automatic compaction**: Every mutation triggers `maybeCompactLog()` which rewrites the JSONL log (keeping only the latest revision per ID) when duplicate ratio exceeds 3x and record count exceeds 500

#### Key Operations

| Method | Async | Lock | Description |
|--------|-------|------|-------------|
| `rememberSuper()` | ✅ | Mutation | Create a new memory with validation, secret detection, anchor edges, relationship chain |
| `updateSage()` | ✅ | Mutation | Patch a memory, update revision, link graphs |
| `deleteSage()` | ✅ | Mutation | Soft-delete with cascade (cleans supersedes/contradicts refs in other memories) |
| `recoverSage()` | ✅ | Mutation | Restore `deleted` to `active` (or return head-of-chain for `superseded`) |
| `backfillRecoverable()` | ✅ | Mutation | Scan deleted records and create new active versions (default dry-run) |
| `hygiene()` | ✅ | Mutation | Full pipeline: dedup → near-dup → verify → contradiction → review candidates |
| `findMemoriesForFile()` | ✅ | Read-only | 3-bucket file-drawer query (primary/symbol/related matches) |
| `searchSuper()` | ✅ | Read-only | Token-based lexical search with anchor/tag boosting |
| `graphFor()` | ✅ | Read-only | Query → graph traversal + page rank scoring |
| `verify()` | ✅ | Read-only | Per-memory or all-memory anchor verification |
| `listSuperPage()` | ✅ | Read-only | Cursor-based pagination (updatedAt DESC, id DESC) |
| `listCandidates()` | ✅ | Read-only | Review candidate listing |
| `retrieveForAudience()` | ✅ | Read-only | Role/task/mode-targeted retrieval |

### 4.2 `SqliteSageStore` (SQLite) — Performance Alternative

**File:** `sqlite-store.ts` (1,804 lines)

#### Architecture

- Uses `node:sqlite` (`DatabaseSync` — synchronous API, experimental in Node 22+)
- **WAL mode** for concurrent read/write performance
- **FTS5** full-text search virtual table
- **Auto-migration**: On first open, if legacy `memories.jsonl` exists and SQLite DB is empty, migrates all records

#### Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,           -- Full Sage as JSON
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  freshness REAL NOT NULL,
  updated_at TEXT NOT NULL,
  persistence TEXT DEFAULT 'long_lived',
  context_policy TEXT DEFAULT 'eligible',
  audience TEXT DEFAULT NULL    -- JSON array or null
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deleted_at TEXT DEFAULT NULL
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  id UNINDEXED, text, tags, kind, scope, content='memories', content_rowid='rowid'
);

-- Indexes
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_kind ON memories(kind);
CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);
CREATE INDEX idx_edges_from ON edges(from_node);
CREATE INDEX idx_edges_to ON edges(to_node);
```

#### Feature Gap vs JSONL Store

| Feature | JSONL (store.ts) | SQLite (sqlite-store.ts) |
|---------|------------------|--------------------------|
| Full CRUD | ✅ | ✅ |
| Pagination | ✅ | ✅ |
| Hygiene | ✅ | ✅ (dedup subset) |
| Graph traversal | ✅ (full) | ❌ (delegates to JSONL graph) |
| Anchor verification | ✅ | ❌ (delegates) |
| Backfill recoverable | ✅ | ❌ |
| Auto-compaction | ✅ | N/A |
| FTS5 search | ❌ (uses lexical index) | ✅ |
| Performance | O(n) full loads | O(log n) indexed |
| Cross-process safety | File locks | Single-process (DatabaseSync) |

### 4.3 JSONL I/O (`jsonl.ts`)

```typescript
appendJsonl(filePath, value)    // Atomic append with file lock
readJsonl<T>(filePath)          // Full read, corrupt-line callback
readJsonlSnapshot<T>(filePath)  // Returns { values, signature }
readJson<T>(filePath)           // JSON.parse with ENOENT safety
writeJson(filePath, value)      // atomicWrite wrapper
```

- **Signature**: `size:mtimeMs` — used by store.ts to detect concurrent modifications
- **Corruption**: Malformed JSON lines trigger an `onCorrupt` callback, which store.ts uses to audit-log them
- **Locking**: Uses `withFileLock` from `@wrongstack/core/utils` (shared-across-process file locks)

### 4.4 Path System (`paths.ts`)

```
.wrongstack/memories/
├── manifest.json           — Schema version, last snapshot ref
├── memories.jsonl          — Append-only memory records
├── candidates.jsonl        — Review candidate records
├── audit.jsonl             — Structured mutation audit log
├── graph/
│   └── edges.jsonl         — Knowledge graph edges
├── indexes/                — Precomputed indexes (by-path, by-symbol, etc.)
├── snapshots/              — Full-memory snapshots for crash recovery
├── hygiene/                — Hygiene report output
├── tmp/                    — Temporary files for atomic writes
└── locks/                  — Cross-process file lock storage
```

Key design decisions:
- `normalizeSlashes()`: Windows `\` → `/`, duplicate `/` collapsed
- `normalizeProjectPath()`: Ensures all paths stay inside project root (prevents path escape)
- `ancestorPaths()`: Generates all ancestor directory paths for a given path
- `resolveSagePaths()`: Validates directory is relative and inside project

---

## 5. Middleware Layer

SAGE has two middleware pipelines that automatically inject relevant memories into LLM context. This is the most sophisticated part of the system.

### 5.1 Tool-Call Middleware

**File:** `middleware/tool-call-memory.ts` (890 lines)

**Hook:** Post-execution, on every tool call result.

**Flow:**

```
Tool Call Result
  ↓
Trigger Detection (reads tool name + input)
  ├── read → paths=[input.path]
  ├── tree → paths=[input.path ?? '.']
  ├── grep → paths=[input.path ?? '.'], query=[pattern glob path]
  ├── glob → paths=[input.path], query=[pattern glob path]
  ├── codebase_search → query, paths
  ├── bash/exec → query=[command text]
  ├── write/edit → paths
  ├── replace → files=[input.files parsed], pattern
  └── patch → paths=[extracted from patch header], directory
  ↓
Path Resolution + Result Path Extraction
  ↓
Verify on Mutation (if trigger is write/edit/patch, verify anchors)
  ↓
MemoryInjectorAgent.plan() ← Budget & task-aware plan
  ↓
Parallel Retrieval:
  ├── retrieveForPath() per path  ← anchor matches
  └── searchSuper()               ← lexical matches
  ↓
Graph Expansion (from strong seeds: relationStrength >= 0.9, maxDepth 2)
  ↓
Scoring Pipeline:
  ├── Dedupe by normalized text (normalizeTextKey)
  ├── Filter: importance >= minImportance (default 0.5)
  ├── Filter: relationStrength >= 0.75   ← the gate that usually decides
  ├── contextualInjectionScore = metadata*0.48 + relation*0.48 + persistenceBoost + kindBoost - unusedPenalty
  ├── Filter: score >= minScore (default 0.72)
  ├── Remove: already visible in context
  └── Apply cooldown (default: once per memory per session)
  ↓
Diversity Selection (selectDiverseMemories):
  ├── At most 3 per kind
  ├── At most 1 graph-only, 2 query-only (no path anchor)
  └── Priority: path > graph > query
  ↓
Format & Inject (formatMemoryHintsDetailed)
  ↓
Record injection + emit memory.injector_run trace
```

**Trigger Tool Mapping:**

| Tool | Trigger Type | Query Text Source |
|------|-------------|-------------------|
| `read` | `read` | File path |
| `tree` | `tree` | Directory path |
| `grep` | `grep` | Pattern + glob + path |
| `glob` | `glob` | Pattern + glob + path |
| `codebase_search` | `codebase_search` | Query input |
| `bash` / `exec` | `bash` | Command text + last 2K of result |
| `write` | `write` | File path |
| `edit` | `edit` | File path |
| `replace` | `edit` | Files + pattern |
| `patch` | `patch` | Patch directory + paths |

### 5.2 Turn-Context Middleware

**File:** `middleware/turn-memory.ts` (311 lines)

**Hook:** Pre-processing, on every LLM request turn.

**Flow:**

```
Request (system + messages)
  ↓
Feedback Loop: Check last assistant response for injected memory references
  → If found, credit recordUse()
  ↓
Extract last user text
  ↓
Memory searchSuper(query, limit=8, excludeAudienceScoped)
  ↓
Filter Pipeline:
  ├── status === 'active'
  ├── contextPolicy !== 'never'
  ├── Not already in system prompt (dedup)
  ├── relevance >= 0.62
  └── score = metadataScore * (0.3 + relevance * 0.7) >= minScore (0.65)
  ↓
Format & Append to request.system
```

**System Prompt Cache:**

The middleware implements an **FNV-1a fingerprint cache** over the system prompt to avoid re-normalizing a large prompt on every turn. The fingerprint combines 5 signals:

1. `system.length` — catches added/removed non-text blocks
2. Text-block count
3. Per-block raw-length sequence — catches reordering
4. Per-block content FNV-1a hash sequence — catches same-length swaps
5. Global running FNV-1a hash — catches multi-block permutation combinations

A version prefix (`v1`) allows cache invalidation when `normalizeTextKey`'s output format changes.

### 5.3 Memory Injector Agent

**File:** `middleware/memory-injector-agent.ts` (145 lines)

A deterministic, no-LLM budget planner for tool-call memory injection.

**Context Pressure → Budget Table:**

| Context Pressure | maxHints | maxChars | Condition |
|-----------------|----------|----------|-----------|
| ≥ 0.95 | 0 | 0 | Near-full context: inject nothing |
| ≥ 0.82 | 1 | 600 | Very full: one short hint |
| ≥ 0.65 | 3 | 1,400 | Moderate: a few hints |
| < 0.65 | base (8) | base (2,800) | Normal operation |

**Task Awareness:** Collects signals from:
- Active todo items (`activeForm` / `content`)
- Kanban task metadata (title, description, tags, labels)
- `ctx.currentKanbanTaskId` / `ctx.currentKanbanBoardId`

These signals are deduplicated, dedup terms merged into the query text to improve retrieval relevance.

### 5.4 Injection Tracker

**File:** `middleware/injection-tracker.ts` (246 lines)

An in-memory process-local registry of recently injected memories.

**Key Responsibilities:**
1. **Record injections** with timestamp, session ID, token set (pre-tokenized at record time)
2. **Detect assistant references** by comparing the assistant's response tokens against registered memory token sets
3. **Context snapshot** — track which memories are currently in the provider-bound request
4. **Consume-once semantics** — each injection yields at most one use credit

**Matching Algorithm:**

```typescript
consumeMatches(assistantText) {
  // Overlap coefficient (Szymkiewicz-Simpson)
  overlap = |memoryTokens ∩ assistantTokens| / min(|memoryTokens|, |assistantTokens|)
  if (overlap >= 0.5) → matched!
}
```

**Configuration:**
- TTL: 2 hours (default)
- Max entries: 500
- Min tokens for trackable memory: 4
- Match threshold: 0.5 overlap coefficient
- Prune interval: 30s (throttled)

**Context Needle Extraction:**

When recording, the tracker computes a `contextTextKey` from the rendered context text to enable accurate `snapshotContext()` — it finds the shortest prefix of the memory text that uniquely identifies it in the rendered string. This prevents context-snapshot false negatives when the full text isn't visible.

### 5.5 Context Monitor

**File:** `middleware/context-monitor.ts` (51 lines)

Emits a `memory.context_snapshot` event on every provider-bound request, containing:
- `activeMemoryIds` — memories currently in context
- `enteredMemoryIds` — memories that just entered (compared to last snapshot)
- `exitedMemoryIds` — memories that just left

---

## 6. Retrieval System

### 6.1 Query Relevance (`retrieval/relevance.ts`)

**`memoryQueryRelevance(memory, query)`:**

```
queryTerms = informativeTerms(query)  // tokenized, cleaned, generic terms removed
             ↓
Check exact anchor match (path/symbol/command in query)
  → 0.96–0.98 strength, return immediately
             ↓
Token intersection on (textTerms ∪ tagTerms ∪ anchorTerms)
             ↓
Anchor term match     → 0.78–0.92 (min=1, per-term += 0.05)
Tag term match        → 0.74–0.88 (min=1, per-term += 0.05)
3+ text terms         → 0.74–0.86 (base + 0.03 per term)
2 text terms          → 0.70
Short query (≤2 terms) → 0.66
Single term, long query → 0 (insufficient evidence)
```

**`memoryStructuralRelevance(memory, seeds)`:** Used for graph-expanded memories. Checks shared anchor keys (type:path/symbol) and shared informative tag terms (≥2 → 0.72).

**Generic Term Filter (60+ terms):** Common words like `add`, `file`, `code`, `test`, `memory`, `result`, `path`, `package`, etc. are excluded from informative term extraction to prevent false matches.

### 6.2 Format (`retrieval/format.ts`)

Converts memories into LLM-readable context blocks:

```
SAGE: related project knowledge (Memory Injector)
- [fact][permanent][critical] Project uses pnpm workspaces (packages/) [tags=pnpm,workspace]
- [decision] API uses cursor pagination (src/api/pagination.ts#Paginate) [tags=pagination]
```

Features:
- **MaxChars enforcement**: Hard truncation at byte boundary; if the first item doesn't fit, a safe truncated version is emitted
- **Memory ID tracking**: `formatMemoryHintsDetailed()` returns which memory IDs were rendered
- **Metadata rendering**: kind, persistence, importance, anchor, tags

### 6.3 Store-Based Retrieval

**`retrieveForPath(path)`:** Anchor-based scoring:
- Exact path match: +10
- Ancestor directory match: +5
- Prefix match: +3
- Plus quality bonuses: importance*2 + confidence + freshness

**`searchSuper(query)`:** Token-based lexical search:
- `tokenize()`: NFKC + lowercase, split on non-[Letter/Number/_.-], dedup, min 3 chars
- Each memory scored via `scoreQueryMemory()` — O(N) token intersection
- Result capped at 500 max

**`findRelatedSuper(ids)`:** Graph expansion + relationship scoring:
1. Load seeds (memories by ID)
2. Traverse graph from `mem:<id>` nodes (maxDepth=3, limit=2000)
3. Score candidates with `scoreMemoryRelationship()`:
   - Graph edge present: +8
   - Shared tags: +1.5 per tag (max 4)
   - Shared symbol anchors: +8 (same path) / +12 (different path)
   - Shared commands: +10 (exact) / +5 (same family)
   - Shared paths: +8 file / +10 package / +3 ancestor relation
   - Importance bonus: +importance*2
   - Persistence bonus: permanent +2, long_lived +1, short_lived -1

**`findMemoriesForFile(path)`:** 3-bucket file-drawer query:
1. **Primary matches** (strength 0.9–1.0): `scope_file`, `anchor_file`, `anchor_directory`
2. **Symbol matches** (strength 0.75–0.95): `scope_symbol`, `symbol` anchor; cursor line-range boosted to 0.95
3. **Related matches** (strength 0.3): basename mentioned in text
4. Each match includes `matchedVia`, `matchStrength`, `supersededByActiveId`, `pendingReview`

**`retrieveForAudience(context)`:** Role/task/mode filtered retrieval:
- Only `project` scope memories with `audience` field
- Audience match via `audienceMatches()` — OR within dimensions (any role match), AND across dimensions (role + mode must both match)

---

## 7. Knowledge Graph

**File:** `graph/graph.ts` (234 lines)

### Edge Model

```typescript
interface MemoryGraphEdge {
  schemaVersion: 1;
  id: string;                    // edge_<ULID>
  from: string;                  // mem:<id> | file:<path> | dir:<path> | symbol:<path>#<sym> | ...
  to: string;
  relation: MemoryGraphRelation; // 12 types
  weight: number;                // 0..1, clamped
  evidence?: string[];           // Human-readable, max 8 items
  createdAt: string;
  deletedAt?: string;            // Soft-delete marker
}
```

### 12 Relation Types

| Relation | Direction | Meaning |
|----------|-----------|---------|
| `about_file` | mem → file | Memory about a file |
| `about_directory` | mem → dir | Memory about a directory |
| `about_symbol` | mem → symbol | Memory about a symbol |
| `about_package` | mem → dir | Memory about a package |
| `about_command` | mem → command | Memory about a command |
| `derived_from` | mem → source | Memory derived from a session/tool/file |
| `validated_by` | mem → mem | One memory validates another |
| `invalidated_by` | mem → mem | One memory invalidates another |
| `supersedes` | mem → mem | Version chain |
| `contradicts` | mem → mem | Contradiction |
| `related_to` | mem → mem | General relationship |
| `same_topic` | mem → mem | Same topic (tag-only relationship) |

### Operations

| Method | Description |
|--------|-------------|
| `add(from, to, relation, weight, evidence)` | Single edge (duplicate prevention with lock) |
| `addMany(inputs[])` | Batch add (single read + single append) |
| `list()` | All active edges (deletedAt-not-set) |
| `removeNodeEdges(node)` | Soft-delete all edges from/to a node |
| `removeEdge(edgeId)` | Soft-delete one edge |
| `traverse(starts, opts)` | BFS traversal (maxDepth=6, limit=1000, optional relation filter) |

### Auto-Generated Edges

When a memory is created or updated, `addAutomaticEdges()` generates:

1. **Anchor → file/dir edges**: Each anchor produces a `about_*` edge from `mem:<id>` to the anchor node
2. **Symbol → file edges**: `symbol:<path>#<symbol>` → `file:<path>` with `related_to`
3. **File → directory edges**: `file:<path>` → `dir:<dirname>` with `related_to`
4. **Directory parent chain**: `dir:<a>` → `dir:<b>` for each ancestor pair
5. **Source → session/tool edges**: `mem:<id>` → `session:<id>` or `tool:<id>/<useId>` or `file:<path>` with `derived_from`
6. **Cross-memory relationship edges**: Via `memoryRelationshipProposals()` — compares anchors, tags, symbols between the new memory and all active memories (minScore=9.5, max 8 edges)

### Concurrency

- All mutations use `withFileLock` on `edges.jsonl.mutation`
- `add()` reads existing edges to prevent duplicates, then appends
- `addMany()` reads once, dedupes by `from\to\relation` key (including reverse check)
- `removeNodeEdges()` and `removeEdge()` read all, modify in memory, then rewrite entire file

---

## 8. Anchor Verification

**File:** `anchors/verify.ts` (126 lines)

### Verification Matrix

| Anchor Type | Check | Result |
|-------------|-------|--------|
| `command` | Skipped (execution required) | `unknown` |
| No path | — | `unknown` |
| Any | Path escape check (outside project root) | `stale` |
| Any | `fs.stat` existence | `stale` if missing |
| Any | `fs.realpath` symlink escape | `stale` if outside |
| `directory`/`package` | `stat.isDirectory()` | `verified` / `stale` |
| `file`/`symbol`/`test`/`git` | `stat.isFile()` | `stale` if not file |
| Any with `contentHash` | SHA-256 match | `stale` if changed |
| `symbol` | Regex `\b<symbol>\b` in file | `stale` if missing |
| Any with `gitBlobHash` | `git hash-object` match | `stale` if changed |

### Aggregation

- All anchors `verified` → memory `verified`
- Any anchor `stale` → memory `stale`
- Any anchor `contradicted` → memory `contradicted`
- No anchors → `unknown`
- Mixed (verified + unknown) → `unknown`

### Symbol Regex Safety

```typescript
function containsSymbol(text: string, symbol: string): boolean {
  const escaped}