# SAGE Memory — Full System Report

> **Status:** Source-verified architecture reference (as of 2026-08-11, post host-wiring / Review / remap work)  
> **Primary package:** `@wrongstack/sage`  
> **Related packages:** `sage-mcp`, `runtime`, `cli`, `tools`, `core`, `tui`, `webui`, `webui-server`, `simpleui`  
> **Supersedes for day-to-day reading:** sections of [`ARCHITECTURE.md`](./ARCHITECTURE.md) that still describe JSONL as the runtime store (JSONL is migration-only).  
> **Package owner summary:** [`packages/sage/README.md`](../../packages/sage/README.md)

This document is the end-to-end reference for SAGE: database layout, process model, IPC, retrieval, tools, MCP, middleware, host wiring, and every host surface (CLI, TUI, WebUI, SimpleUI, Desktop, ACP).

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Layered architecture](#2-layered-architecture)
3. [Database architecture](#3-database-architecture)
4. [Data model](#4-data-model)
5. [MemoryPort and capabilities](#5-memoryport-and-capabilities)
6. [IPC project server](#6-ipc-project-server)
7. [Retrieval and ranking](#7-retrieval-and-ranking)
8. [Host wiring and middleware](#8-host-wiring-and-middleware)
9. [Lifecycle: hygiene, triage, recovery](#9-lifecycle-hygiene-triage-recovery)
10. [Agent tool surface](#10-agent-tool-surface)
11. [MCP (`@wrongstack/sage-mcp`)](#11-mcp-wrongstacksage-mcp)
12. [CLI and TUI](#12-cli-and-tui)
13. [WebUI and webui-server](#13-webui-and-webui-server)
14. [SimpleUI and Desktop](#14-simpleui-and-desktop)
15. [Prompt / system-context channels](#15-prompt--system-context-channels)
16. [Configuration](#16-configuration)
17. [Security model](#17-security-model)
18. [Events and observability](#18-events-and-observability)
19. [Package and file map](#19-package-and-file-map)
20. [End-to-end flow](#20-end-to-end-flow)
21. [Recent hardening (shipped)](#21-recent-hardening-shipped)
22. [Known limits and design choices](#22-known-limits-and-design-choices)
23. [Quick reference](#23-quick-reference)
24. [Related docs](#24-related-docs)

---

## 1. Executive summary

**SAGE** is WrongStack’s **only long-term project memory backend**: structured, revisioned, anchor-bound knowledge stored in project-local SQLite and shared across sessions and host surfaces.

| Aspect | Value |
|---|---|
| Owner package | `@wrongstack/sage` |
| Canonical file | `.wrongstack/memories/sage.db` |
| Engine | Node built-in `node:sqlite` (Node ≥ 22.5 required) |
| Production model | **One detached project daemon** is the sole SQLite writer |
| Host contract | Core `MemoryPort` + typed capabilities |
| Host wiring | Shared `setupSage()` in `@wrongstack/sage` (CLI + WebUI) |
| JSONL | One-shot migration source only; never a writable runtime backend |
| `Sage.enabled: false` | Does **not** swap the store; only disables auto-injection and session-end hygiene |

**Core promise:** decisions, conventions, root causes, and file/symbol notes survive across sessions; relevant facts are injected into tool results when the agent is actually working on related code; hygiene never silently hard-deletes project knowledge (it creates review candidates); rename tools keep anchors pointed at live paths/symbols.

---

## 2. Layered architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Surfaces: CLI · TUI · WebUI · SimpleUI · Desktop · ACP · MCP        │
├──────────────────────────────────────────────────────────────────────┤
│  Wiring: setupSage() · tool registry · WS handlers · slash /memory   │
├──────────────────────────────────────────────────────────────────────┤
│  Host API: MemoryPort  (+ retrieval / surface / service capabilities)│
│            ProjectSageMemoryPort  ──IPC──►  Project Server (daemon)  │
├──────────────────────────────────────────────────────────────────────┤
│  Persistence: SqliteSageStore  (sole SQLite owner in production)     │
│    memories · memories_fts · edges · candidates · audit_log          │
├──────────────────────────────────────────────────────────────────────┤
│  Pipelines: inject · path/symbol remap · capture · consolidator      │
│             hygiene · triage · daily dry-run                         │
└──────────────────────────────────────────────────────────────────────┘
```

### Ownership rules

- Hosts (CLI, TUI, WebUI, …) **must not open SQLite directly**. They use `createProjectSageMemoryPort(...)`.
- In production, only the **project server** owns the SQLite connection, mutation queue, counters, and automatic hygiene throttle.
- Linked Git worktrees resolve to the main checkout identity and **share one daemon**.
- Tests / offline recovery: `WRONGSTACK_SAGE_INLINE=1` or `createSqliteMemoryPort(...)`.
- Runtime binds `TOKENS.MemoryStore` and `TOKENS.MemoryPort` to the same port instance (`packages/runtime/src/container.ts`).

Supported composition (from `packages/sage/README.md`):

| Factory / adapter | When |
|---|---|
| `createProjectSageMemoryPort(...)` | Production default for CLI, TUI, ACP, WebUI |
| `createSqliteMemoryPort(...)` | Tests and explicit offline recovery |
| `LegacyMemoryPortAdapter` | Third-party or historical `MemoryStore` wrappers |
| `getSageRetrieval` / `getSageService` / `getSageSurface` | Optional typed capabilities |
| `setupSage(...)` | Shared middleware + throttled hygiene teardown (CLI + WebUI) |

---

## 3. Database architecture

### 3.1 On-disk layout

Root directory: `.wrongstack/memories/` (`DEFAULT_SAGE_DIR`; config: `Sage.storage.directory`)

| Path | Role |
|---|---|
| `sage.db` (+ WAL/SHM) | **Canonical** store |
| `server.json` (mode `0600`) | Daemon metadata + **authToken** (token lives only here, never in the `hello` frame) |
| `manifest.json` | Schema / manifest metadata |
| `memories.jsonl`, `candidates.jsonl`, `audit.jsonl`, `graph/edges.jsonl` | Legacy backups; imported once |
| `tmp/`, `locks/`, `hygiene/`, `indexes/`, `snapshots/` | Helper paths (mostly historical / ops) |

Path safety: the directory must stay project-relative; absolute paths are rejected; symlink escape is blocked by `normalizeProjectPath`.

### 3.2 SQLite pragmas and schema version

```
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA busy_timeout = 30000
PRAGMA temp_store = MEMORY
PRAGMA foreign_keys = ON
+ cache_size / mmap_size (SageCachePragmas)
```

- **Schema version:** `SQLITE_SCHEMA_VERSION = 5`
- Migrations v2→v5 run in `initializeSqliteSageStore`
- If FTS5 becomes available on a DB that was created without it, a transactional backfill runs once and records `fts_index_initialized`

### 3.3 Tables

#### `memories`

| Column | Purpose |
|---|---|
| `id` | Primary key (ULID) |
| `data` | Full `Sage` JSON blob |
| `status`, `kind`, `scope` | Denormalized filter columns |
| `legacy_scope` | Legacy `MemoryStore` compatibility |
| `importance`, `confidence`, `freshness` | Scores |
| `updated_at`, `created_at` | ISO timestamps |
| `audience`, `tags` | Denormalized strings (FTS + filters) |
| `owner_session_id` | Session-scope isolation |
| `canonical_text` | Near-dup / merge key |

**Indexes include:** status, kind, scope, importance DESC, updated_at DESC, `(status, importance, updated)`, `(status, updated, id)` for cursor pagination, `canonical_text`, `(status, scope, canonical)`, `owner_session_id`, `legacy_scope`.

#### `memories_fts` (FTS5 external content)

- Columns: `text`, `tags`, `audience`
- `content='memories'`, `content_rowid='rowid'`
- AFTER INSERT / UPDATE / DELETE triggers keep FTS in sync
- If FTS5 is unavailable: LIKE fallback

#### `edges` (knowledge graph)

```
PRIMARY KEY (from_node, to_node, relation)
weight REAL DEFAULT 1
created_at TEXT
```

Indexes: `from_node`, `to_node`, `(to_node, relation)`.

**Unified edge-weight policy (2026-08-02):** on conflict, `weight = MAX(weight, excluded.weight)` so concurrent writers cannot erode strength and idempotent replays stay stable.

#### `candidates` (review queue)

`id`, `data` (JSON), `status`, `created_at`, `updated_at`, `canonical_text`  
Indexes: `(status, created_at DESC)`, `(status, canonical_text)`.

Carries hygiene and triage proposals (`memory_review`, `targetMemoryId`, `suggestedAction`, `reviewReason`).

#### `audit_log`

`id AUTOINCREMENT`, `event`, `at`, `trace_id`, `data`  
- Cap: **1000** rows  
- Prune every **256** inserts  
- Recent activity trail, not a full compliance log

#### `schema_meta`

Key/value store for version, `legacy_jsonl_migrated`, `fts_index_initialized`, etc.

### 3.4 Write model

- `SqliteMutationQueue` serializes mutations (single-writer invariant inside the process).
- Statement cache reduces prepare cost on hot paths.
- Dispose order: drain mutation queue → close DB.
- Injection/use counters write synchronously on the SQLite path; `flushPendingCounters` is a documented no-op (API retained for a possible future batching optimization).

### 3.5 Legacy JSONL migration

On first open, if the DB is empty and legacy JSONL exists:

1. Import memories, candidates, edges, and audit in one transaction
2. Set `legacy_jsonl_migrated`
3. Leave original files on disk as recovery backups (never rewritten by the runtime)

---

## 4. Data model

### 4.1 `Sage` record (conceptual)

```ts
id, revision, scope, kind, status, persistence?,
contextPolicy?: 'eligible' | 'never',
text /* ~20K max */, summary?,
importance, confidence, freshness ∈ [0,1],
tags[], anchors[], audience?, sources[],
supersedes?, supersededBy?, contradicts?,
createdAt, updatedAt, lastAccessedAt?, lastVerifiedAt?, lastUsedAt?, expiresAt?,
injectionCount?, useCount?, ownerSessionId?
```

`RememberSageInput` also accepts `expiresAt` for short-lived / session digests.

### 4.2 Kinds

All of the following are in `VALID_KINDS` / tool schema (accepted by `rememberSage`):

**Classic:**  
`fact`, `decision`, `convention`, `preference`, `warning`, `anti_pattern`, `workflow`, `bug_root_cause`, `file_note`, `symbol_note`, `command_note`, `summary`, `memory_review`

**Extended (auto-capture / continuity):**  
`tool_outcome`, `error_pattern`, `session_digest`, `role_operational`, `task_outcome`, `security_signal`, `fleet_convention`

### 4.3 Scope, status, persistence

| Dimension | Values |
|---|---|
| Scope | `project`, `user`, `session`, `file`, `symbol` |
| Status | `active` → `stale` / `superseded` / `contradicted` → `archived` → `deleted` (soft) |
| Persistence | `permanent` (hygiene never deletes), `long_lived` (default), `short_lived` (+ optional `expiresAt`) |

`contextPolicy: 'never'` is an absolute ban on automatic model-context injection.

### 4.4 Anchors

Types: `file` | `directory` | `symbol` | `package` | `command` | `test` | `git` | `agent`

Optional fields: `contentHash`, `gitBlobHash`, `lineStart` / `lineEnd`, `role` (for `agent`).

Path/symbol remaps rewrite `path` and/or `symbol` on live memories after renames (see §8.3).

### 4.5 Graph relations

`about_file` | `about_directory` | `about_symbol` | `about_package` | `about_command` | `about_agent`  
`derived_from` | `validated_by` | `invalidated_by`  
`supersedes` | `contradicts` | `related_to` | `same_topic`

### 4.6 Audience

```ts
{ roles?: string[], taskTypes?: string[], modes?: string[] }
```

- **OR** within a dimension, **AND** across dimensions
- Audience-scoped memories are **excluded** from ordinary path/search injection unless `includeAudienceScoped` is set
- On subagent spawn, hosts call `retrieveForAudience` with role / task type / mode

### 4.7 Sources (provenance)

`user` | `session` | `tool_result` | `project_instruction` | `file` | `test` | `command` | `legacy_memory`

---

## 5. MemoryPort and capabilities

```ts
SAGE_RETRIEVAL_CAPABILITY  // wrongstack.memory.retrieval.v1
SAGE_SURFACE_CAPABILITY    // wrongstack.memory.surface.v1
SAGE_SERVICE_CAPABILITY    // wrongstack.memory.sage-service.v1
```

| Capability | Consumers | Key APIs |
|---|---|---|
| **Retrieval** | Injection middleware | `retrieveForPath`, `searchSage`, `findRelatedSage`, `retrieveForAudience`, `recordInjection` / `recordUse` |
| **Surface** | TUI `/memory`, WebUI MemoryManager | list / listPage / get / remember / update / delete / graph / verify / hygiene / candidates / recover / audit / forFile |
| **Service** | Agent tools, MCP, unified search | Legacy `MemoryStore` shape + full SAGE ops + `unifiedSearchService` |

Adapters:

- `SqliteMemoryPort` — in-process
- `ProjectSageMemoryPort` / remote proxies — IPC (transparent)
- `LegacyMemoryPortAdapter` — third-party / historical stores

---

## 6. IPC project server

### 6.1 Endpoint

- **Unix:** `$TMPDIR/wssg-v1/<sha24>.sock` (short path for macOS `sun_path` limits)
- **Windows:** `\\.\pipe\wrongstack-sage-v1-<sha24>`
- Key: `sha256(storageRoot).slice(0, 24)`
- Protocol version is embedded in the path (`SAGE_PROJECT_SERVER_PROTOCOL_VERSION = 1`)

### 6.2 Wire protocol

Newline-delimited JSON frames:

| Type | Direction | Notes |
|---|---|---|
| `hello` | server → client | pid, projectRoot, storageRoot, endpoint, startedAt — **no token** |
| `request` | client → server | `{ id, op, args, meta: { clientId, authToken?, traceId?, sessionId? } }` |
| `response` | server → client | `ok: true \| false` |
| `event` | server → client | `memory.*` broadcast |
| `cancel` | client → server | Connection-scoped; no token |
| `shutdown` | client → server | **authToken required** |

### 6.3 Auth (WS-028)

- Token: 16 random bytes, stored only in owner-only `server.json`
- Clients prove they can read that file before issuing requests
- `clientId` is assigned server-side (client-supplied values are overwritten)
- Client-supplied `workspaceRoot` is ignored (server derives from `projectRoot`)
- Soft-delete patches over IPC require `force: true` for `status: 'deleted'`

### 6.4 Operation surface (~40 ops)

Legacy-compatible: `readAll`, `read`, `remember`, `forget`, `consolidate`, `clear`, `list`, `search`, `findRelated`, `scoreRelevant`

SAGE: `stats`, `listSage`, `listSagePage`, `getSage`, `rememberSage`, `updateSage`, `deleteSage`, `retrieveForPath`, `searchSage`, `unifiedSearch`, `findRelatedSage`, `recordInjection` / `recordUse`, `retrieveForAudience`, `graphFor`, `verify`, `hygiene`, candidate CRUD/resolve, `recoverSage`, `backfillRecoverable`, `findMemoriesForFile`, `readAudit`, `importLegacyFiles`, `consolidateSession`, `ping`

### 6.5 Lifecycle

- Bind election: on `EADDRINUSE`, probe health → attach to owner or exit
- Idle stop: default ~5 minutes (`WRONGSTACK_SAGE_SERVER_IDLE_MS`)
- Per-client write buffer cap ~8 MB
- Writes to already-closed sockets are ignored (broadcast race hardening)
- Ordered dispose: drain → close store → remove metadata → release endpoint

---

## 7. Retrieval and ranking

### 7.1 Path retrieval

- File match + ancestor walk
- Audience excluded by default
- Session isolation via `ownerSessionId`
- `findMemoriesForFile` returns three buckets — **primary / symbol / related** — with `matchedVia` and `matchStrength` (WebUI / SimpleUI file drawers)

### 7.2 Lexical / FTS search

- FTS path: BM25 → sigmoid score × metadata blend
- Non-FTS path: recency (90-day window) + metadata additive scoring
- Filters: path, tag, kind, audience, status, importance, confidence, recency, pagination
- Unified search service exposes one contract for external IPC/MCP consumers
- WebUI `listSagePage` supports server-side `query` + `kind` (not client-only filtering)

### 7.3 Soft hybrid re-rank

After FTS/LIKE candidate retrieval, multi-token queries are re-ordered with offline **hashing embeddings** (`hybridRerankMemories`):

- Default **on** for queries with ≥2 tokens (`SageSearchOptions.semanticRerank !== false`)
- Blend weight ≈ 0.25 cosine + original rank position
- Fail-open: embedding errors leave SQL order unchanged
- No durable vector index; no external API required
- `Sage.embeddings.enabled` is reserved for a future durable vector path (no longer emits a “not wired” config warning)

### 7.4 Injection scoring (tool-call path)

Evidence-first, not bag-of-words:

| Gate | Default |
|---|---|
| Relation floor | `0.85` |
| Importance floor | `0.5` |
| Composite minScore | `0.72` |
| Max hints / chars | `8` / `2800` |
| Repeat cooldown | `0` = once per session |

Additional rules:

- Single coincidental tokens are below the bar
- Graph expansion needs a concrete seed and contributes at most one related hit
- Context pressure: ~82% → at most 1 memory / 600 chars; ~95% → inject nothing
- Project-root (`.`) anchors are never universal file matches

### 7.5 Turn injection scoring (opt-in)

```
score = metadataScore * (metadataWeight + relevance * (1 - metadataWeight))
metadataWeight default = 0.3
```

Metadata score blends importance (×3), confidence (×2), freshness (×1).  
Relevance uses an overlap coefficient over query vs memory tokens.

### 7.6 Injection output format

```
--- SAGE: related project knowledge (Memory Injector) ---
- [fact][high] <memory id="…">…escaped text…</memory> (path#sym) [relation=…; tags=…]
```

- XML fences prevent untrusted memory text from escaping the data region
- Modern path stores evidence in `Context.memoryEvidence` / separate ephemeral system blocks
- Legacy session logs may still embed the suffix in tool output; `splitSageOutputBlock` peels it off before surfaces render tool text
- Structured lines also ride on `tool.executed.sage` for UI cards

---

## 8. Host wiring and middleware

### 8.1 Shared `setupSage` (authoritative)

**Implementation:** `packages/sage/src/host-wiring.ts`  
**CLI re-export:** `packages/cli/src/wiring/sage.ts` → `@wrongstack/sage`  
**WebUI:** `packages/webui-server/src/server/backend-services.ts` calls `setupSage` and exposes `runSageSessionHygiene` for shutdown

Both hosts install the **same** stack and the **same** throttled full-option hygiene teardown (`sageHygieneOptionsFromConfig`).

### 8.2 Middleware table

| Middleware | Pipeline | Default |
|---|---|---|
| `createSageToolCallMiddleware` | `toolCall` | **ON** (`inject.toolResults !== false`) |
| `createSageTurnMiddleware` | `request` | **OFF** (`inject.turnContext === true`) |
| `createSageDomainTermExtractorMiddleware` | `request` | ON when a port is present — **memory persistence disabled**; refreshes `.wrongstack/domain-terms.md` from in-memory terms only |
| `createSageContextMonitorMiddleware` | `request` | ON — emits `memory.context_snapshot` |
| `createSageOutcomeCaptureMiddleware` | `toolCall` | **OFF** unless `Sage.capture.*` |
| `createSagePathRemapMiddleware` | `toolCall` | **ON** (always when setup runs) |
| `subscribeSessionEndCommitExtractor` | events | ON when `projectRoot` is set |

### 8.3 Path and symbol remap

`shared/path-remap.ts` + `middleware/path-remap.ts`:

| Trigger | Behavior |
|---|---|
| Shell `mv` / `git mv` / PowerShell `Move-Item` | Remap file/dir anchors (exact + prefix) on active memories |
| `lsp_rename` | Capture identifier at line/character **before** the tool runs; remap symbol anchors on that path; rewrite exact symbol tokens in memory text |

Rate-limited (~50 remaps/hour/process). Fail-open.

### 8.4 Opt-in outcome capture

When enabled:

| Flag | Writes |
|---|---|
| `Sage.capture.toolOutcomes` | Successful command tools → `tool_outcome` |
| `Sage.capture.errorPatterns` | Failed tool output signatures → `error_pattern` |

Hourly cap (~20). Never auto-deletes.

### 8.5 InjectionTracker

- Shared by tool-call and turn middleware
- Token-overlap match ≥ 0.5, 3-token floor, consume-once
- Roughly 2 h TTL, ~500 entries
- Feeds `recordUse` usefulness counters

### 8.6 Other capture channels

1. **SessionMemoryConsolidator** (`core`): after successful sessions, LLM **add-only** `rememberSage` for project facts; then a short-lived **`session_digest`** (`scope: session`, `persistence: short_lived`, `expiresAt` ≈ 14 days, `ownerSessionId` set)
2. **Domain term extractor**: conversation / commits → glossary + SAGE entries
3. **Session-end commit extractor**: commit messages → durable notes

### 8.7 Teardown hygiene

- `autoAfterSession` default `true`
- Shared throttle: **1 hour** (`AUTO_HYGIENE_INTERVAL_MS`)
- Full option surface: `retentionDays`, `sessionRetentionDays`, `archiveLowConfidenceAfterDays`, `archiveUnusedAfterDays`, `unusedMinInjections`, `purgeDeletedAfterDays`, `verifyDepth`
- Manual `/memory hygiene` bypasses the throttle

### 8.8 Daily dry-run (`Sage.triage.dailyDryRun: true`)

Scheduled by `setupSage` (1 hour after boot, then every 24h):

1. Run hygiene (full option surface)
2. Bounded triage over up to **200** active/stale memories (`maxPhase3Calls: 40`, `maxPhase4Pairs: 15`)
3. **File** review proposals via `fileTriageProposals` (deduped against pending candidates) — does **not** auto-apply status mutations
4. Optional `getLlmCall()` for real LLM gray-zone/merge; otherwise neutral stub (`'3'`)

---

## 9. Lifecycle: hygiene, triage, recovery

```
rememberSage
  validate → near-dup merge → anchors/edges sync → audit
    → active
        ├─ verifyOnMutation (write/edit/patch): deep verify → may mark stale
        ├─ path/symbol remap (rename tools): rewrite anchors / text
        ├─ hygiene (session / manual / daily):
        │     verifyDepth existence|content|git → stale / verified
        │     exact + SimHash near-dup → superseded
        │     negation cues → investigate candidates
        │     retention rules → memory_review candidates (never auto-delete project facts)
        │     session GC (default 7d) → soft-delete
        │     opt-in purgeDeletedAfterDays → physical DELETE of old tombstones
        ├─ /memory verify: content / symbol / command / batched git hash-object
        └─ candidates accept / reject / update / merge (Review tab bulk)
              → deleted (soft) → recover / backfillRecoverable
```

**Invariant:** project memories are never hard-deleted automatically. `permanent` memories are exempt from retention suggestions.

### Hygiene verify depth

| `Sage.hygiene.verifyDepth` | Behavior |
|---|---|
| `existence` (default) | Cheap `fs.access` only |
| `content` | Deep `verifyMemoryAnchors` (content/symbol/command) |
| `git` | Deep path including git blob checks when applicable |

### Triage pipeline (5 phases)

`packages/sage/src/triage/`:

1. **pre-filter** — deterministic KEEP / DISCARD / UNCERTAIN  
2. **value-score** — anchors, usage, freshness, quality, persistence (+ injector rejection evidence)  
3. **llm-evaluator** — bounded prompt; rejection pressure appends a `REJ:` line  
4. **merge-detection**  
5. **action-dispatcher** — auto-apply or propose; repeated `belowScore` rejections can lower importance (never below the 0.9 user-designated floor)

CLI: `/memory triage` defaults to **dry-run**; `--apply` applies updates / merges / files proposals.  
Proposal filing is shared: `fileTriageProposals` (dedupe pending `targetMemoryId`).

---

## 10. Agent tool surface

Source of truth: `createSageTools(service)` in `packages/sage/src/tools/memory-tools.ts` (+ `memory-candidates-tool.ts`).

Registration: `packages/runtime/src/tool-registration.ts`  
If SAGE service capability exists → `createSageTools`; otherwise thin legacy tools from `packages/tools/src/memory.ts`.

### Tools (source order)

| Tool | Class | Role |
|---|---|---|
| `memory_for_file` | read / auto | Three-bucket file retrieval |
| `memory_for_path` | read / auto | Path + ancestors |
| `memory_search` | read / auto | Lexical / tag / path search |
| `memory_graph` | read / auto | Graph traverse |
| `memory_gather_batch` | read | Batch gather (graph scan limit 10) |
| `memory_verify` | confirm | Deep anchor verification |
| `memory_hygiene` | confirm | Non-destructive cleanup + candidates |
| `memory_candidates` | confirm | Propose / list / resolve / accept / reject |
| `remember` | confirm | Structured write |
| `forget` | confirm | Query-based removal |
| `memory_update` | confirm | Patch by id |
| `memory_delete` | confirm | Soft-delete; **`force: true` required** |
| `memory_recover` | confirm | Restore soft-deleted record |
| `memory_backfill_recoverable` | confirm | Bulk recover (default dry-run) |

### `remember` effectiveness rules (tool description)

1. One durable fact per call, self-contained without session context  
2. Prefer anchors — unanchored memories rarely inject  
3. Put exact paths / symbols / commands in the text for FTS + path match  
4. Session scope requires `ownerSessionId`  
5. Auto-audience uses host `ctx.meta.agentRole`; MCP forces `no_auto_audience`

---

## 11. MCP (`@wrongstack/sage-mcp`)

Thin adapter with **no local state**. Every byte of memory lives in the existing SAGE project daemon.

```
wstack-sage-mcp --project-root <path> [--writable] [--http ...] [--storage-dir ...]
```

| Mode | Tools exposed |
|---|---|
| Default (read-only) | `permission: 'auto'` and `riskTier: 'safe'` (search / for_file / for_path / graph family) |
| `--writable` | Also confirm-class `standard` tools |
| Never | `riskTier: 'destructive'`, `permission: 'deny'` |

Adapter pipeline:

1. Build `ProjectSageMemoryPort` and `initialize()` (election / spawn)
2. `createSageTools` → `selectAllowedTools`
3. Fabricate a minimal `Context` (empty `meta`)
4. Force `no_auto_audience = true` on `remember`
5. `Tool.validate` → `execute` → MCP content blocks

Transports: stdio (default) or loopback HTTP.

Package docs: `packages/sage-mcp/docs/{architecture,safety-contract,tool-surface}.md`. Re-derive tool counts from source after changes (includes `memory_gather_batch`).

---

## 12. CLI and TUI

### 12.1 Slash command `/memory`

Implementations: TUI `packages/tui/src/memory-slash.ts`, CLI slash command modules, user docs in `docs/slash/memory.md`.

Representative subcommands:

| Usage | Effect |
|---|---|
| `/memory [show\|list]` | Compatibility / active list view |
| `/memory search <query>` | Text, tags, paths, symbols, commands |
| `/memory file <path>` | Direct file attachments |
| `/memory path <path>` | File + ancestors |
| `/memory graph <id\|path\|query>` | Relationship traversal |
| `/memory remember / forget / update` | Mutations |
| `/memory verify [id]` | Deep verification |
| `/memory hygiene` | Cleanup + candidates |
| `/memory candidates …` | Review queue |
| `/memory triage [--apply]` | 5-phase triage (dry-run default; `--apply` mutates + files proposals) |
| `/memory audit / stats` | Audit trail / totals |
| `/memory audience …` | Role / task / mode scoped memory |
| `/memory clear --force` | Destructive bulk clear (guards) |

All surface ops go through `getSageSurface(memoryStore)`. The TUI never constructs a store; it receives `AppProps.memoryStore`.

### 12.2 TUI presentation

| Surface | Behavior |
|---|---|
| Statusline | Memory pipeline counters (line four); SAGE totals from the active surface capability |
| `SageMemoryBlock` | **Default compact chip** `🧠 N SAGE · tool — preview…` (`showSageMemoryInject` default **true**) |
| Full bordered panel | Available when compact mode is off (renderer supports `compact` prop) |
| `/context` | MemoryContextMonitor: active / entered / exited + injector summary |
| `/connections` (Ctrl+N) | SAGE daemon health: PID, mode, clients, queue, latency, uptime |
| Settings | `showSageMemoryInject`, `sageMemoryInjectThreshold` (relation floor UI) |

Parser alignment: `packages/tui/src/components/history/sage-output-format.ts` ↔ `packages/core/src/utils/sage-output-block.ts`.

---

## 13. WebUI and webui-server

### 13.1 WebSocket protocol

Client ops (`packages/webui-server/src/protocol/client-integrations.ts`):

- `memory.list`
- `memory.sage.list` / `listPage` / **`listCandidates`** / `get` / `graph` / `update` / `remember` / `delete` / `recover` / `candidateResolve` / `backfillRecoverable` / `forFile`

Server side:

- Handlers in `packages/webui-server/src/server/memory-handlers.ts` via `getSageSurface`
- `memory.event` broadcasts every `memory.*` EventBus event
- Tool events may carry structured `sage` lines rendered as **memory cards**, never folded into raw tool output

### 13.2 WebUI components

`packages/webui/src/components/MemoryManager/`:

| Component | Role |
|---|---|
| `index.tsx` | Manager shell: pagination (`PAGE_SIZE` 100), **Active / Review / Deleted** tabs |
| `MemoryList` / `MemoryDetail` / `MemoryEditor` | Browse + CRUD |
| `MemoryGraph` | Relationship map + structural evidence |
| `MemoryDrawer` | File-scoped drawer (`forFile`) |
| `ReviewQueue` | Pending candidates; single + **bulk** accept/keep; open target memory |
| `MemoryFilters` | Status / kind / tag / audience; search/kind forwarded to **server** `listPage` |
| `MemoryInjectorPanel` | Injector decision trace |
| `MemoryLifecycleTrace` | Enter / update / merge / recover / exit ledger |
| `DeleteMemoryDialog` | Force-aware delete UX |
| `SageTabs` | All memories vs audience-scoped guidance |

**FileActivityDrawer** includes a **Memory** tab that mounts `MemoryDrawer` for the open editor file.

Activity bar entry: **Memory** (`BrainCircuit`).  
Context Dashboard hosts injector + context monitor + audience panels.  
Settings → Connections reports SAGE ownership, mode, PID, storage, queue, and latency.

### 13.3 Host wiring

WebUI uses the same `setupSage` as CLI (inject, domain terms, context monitor, capture, path remap, daily dry-run, full hygiene teardown via `runSageSessionHygiene`).

Session consolidator remains registered on the WebUI agent services path.

---

## 14. SimpleUI and Desktop

### SimpleUI

- Lightweight **Memory drawer** (`memory-drawer.tsx`) for file-scoped lookup via `memory.sage.forFile`
- Same inject rules as other hosts
- Tool timeline: **compact SAGE chip** when collapsed (`🧠 N SAGE — preview…`); expanded view keeps MEMORY section
- Full CRUD/graph remain WebUI/TUI responsibilities

### Desktop / ACP

- Same `createProjectSageMemoryPort` composition path as other hosts
- ACP and Desktop must not open competing SQLite writers

Invariant: **CLI, TUI, WebUI, SimpleUI, and Desktop share one SAGE backend and injection policy.** Relative tool paths resolve from the live working directory before anchor matching.

---

## 15. Prompt / system-context channels

| Channel | Location | Default |
|---|---|---|
| Tool-result injection | SAGE tool-call middleware | ON |
| Turn system injection | `createSageTurnMiddleware` | OFF (protects prefix cache) |
| Static `# Relevant Memory` | `system-prompt-memory-skills.ts` | Runtime typically sets `injectMemory: false` to avoid double injection |
| Prompt enhancer | `prompt-enhancer.ts` | Only when user enables refinement |
| Audience pre-spawn | host subagent factory | Role / task / mode match |
| Agent tools | `memory_*` / `remember` | On demand |
| Session digest | consolidator after successful run | Auto, short-lived session scope |

Deleted tombstones are never eligible for automatic model context. Stale records may surface as warnings after mutation verification.

---

## 16. Configuration

```jsonc
{
  "Sage": {
    "enabled": true,              // false = inject + session hygiene off; store remains
    "storage": {
      "projectLocal": true,
      "directory": ".wrongstack/memories"
    },
    "inject": {
      "toolResults": true,
      "turnContext": false,
      "taskAware": false,
      "maxHintsPerTool": 8,
      "maxCharsPerTool": 2800,
      "maxTurnMemories": 8,
      "maxCharsPerTurn": 2400,
      "minScore": 0.72,
      "minImportance": 0.5,
      "relationFloor": 0.85,
      "repeatCooldownMs": 0,      // 0 = once per session
      "triggers": {
        "read": true,
        "tree": true,
        "grep": true,
        "glob": true,
        "codebase_search": true,
        "write": true,
        "edit": true,
        "patch": true
      }
    },
    "retrieval": { "metadataWeight": 0.3 },
    "hygiene": {
      "autoAfterSession": true,
      "autoOnFileChange": true,
      "retentionDays": 90,
      "sessionRetentionDays": 7,
      "archiveLowConfidenceAfterDays": 30,
      "archiveUnusedAfterDays": 30,
      "unusedMinInjections": 10,
      "purgeDeletedAfterDays": 0,  // opt-in physical purge of old tombstones
      "verifyDepth": "existence"   // or "content" | "git"
    },
    "capture": {
      "toolOutcomes": false,      // opt-in auto tool_outcome
      "errorPatterns": false      // opt-in auto error_pattern
    },
    "triage": {
      "dailyDryRun": false        // opt-in daily hygiene + triage proposals
    },
    "embeddings": { "enabled": false } // reserved for durable vector index future
  }
}
```

Security / config policy notes:

- `Sage.storage.directory` is stripped from untrusted in-project config (path escape risk)
- Legacy top-level `superMemory` migrates into `Sage` on load
- Former `Sage.storage.engine` (JSONL selector) is gone; SQLite is the only engine

Environment / flags:

| Variable / flag | Effect |
|---|---|
| `WRONGSTACK_SAGE_INLINE=1` | In-process store (tests / recovery) |
| `WRONGSTACK_SAGE_SERVER_IDLE_MS` | Daemon idle timeout |
| `features.memory === false` | Skip SAGE middleware entirely |

Also see `docs/configuration.md` → “SAGE memory storage”.

---

## 17. Security model

| Control | Mechanism |
|---|---|
| Single writer | Project server is the sole SQLite owner |
| Auth | Owner-only `server.json` token on every request / shutdown |
| Path sandbox | Project-relative normalize + realpath containment |
| Soft-delete | Tombstones + force gates + audit |
| Permanent override | Force required |
| Prompt isolation | `<memory id>` fences + escaped body text |
| Audience isolation | Default exclude from general inject |
| Session isolation | `ownerSessionId` |
| MCP | Default read-only; validate before execute |
| Socket teardown | Ignore writes to closed clients |
| Capture / remap rate limits | Per-process hourly caps |

---

## 18. Events and observability

| Event / signal | Meaning |
|---|---|
| `memory.*` mutations / accepted | UI refresh hooks |
| Audit `memory.injected` | Exact inject ledger |
| `memory.injector_run` | Gates, scores, rejection reasons |
| `memory.context_snapshot` | Active / entered / exited per request |
| `memory.audience_truncated` | Audience scan window saturated |
| `injector_rejection_burst` | Triage evidence from repeated rejections |
| WS `memory.event` | WebUI EventBus bridge |
| Logger `sage daily dry-run: …` | Daily hygiene/triage summary |
| Logger `sage auto-hygiene skipped` | Teardown throttle |

TUI `/connections` and WebUI Settings → Connections surface daemon health metrics.

---

## 19. Package and file map

### `@wrongstack/sage`

| Area | Files |
|---|---|
| Port / remote | `memory-port.ts`, `remote-memory-port.ts`, `project-server*.ts` |
| SQLite facade | `sqlite-store.ts` + many `sqlite-store-*.ts` modules |
| Schema | `sqlite-store-schema.ts` |
| Host wiring | `host-wiring.ts` (`setupSage`, hygiene options, daily dry-run) |
| Middleware | `middleware/*` (inject, turn, capture, path-remap, context, domain terms, …) |
| Shared helpers | `shared/path-remap.ts`, `shared/file-proposals.ts`, `shared/candidate-dedupe.ts` |
| Tools | `tools/memory-tools.ts`, `tools/memory-candidates-tool.ts` |
| Triage | `triage/*` |
| Retrieval | `retrieval/format.ts`, `retrieval/relevance.ts`, `retrieval/hybrid-rerank.ts` |
| Anchors | `anchors/verify.ts` |
| Embeddings | `embeddings/*` (hashing provider) |
| Types | `types.ts` |
| Public exports | `index.ts` |

### Other packages

| Package | Role |
|---|---|
| `sage-mcp` | Standalone MCP server |
| `runtime` | Container bind + tool registration |
| `cli` | `wiring/sage.ts` re-export, slash commands, MCP serve |
| `tools` | Legacy thin memory tools + icons |
| `core` | Config, consolidator (+ session_digest), sage-output-block, system prompt |
| `tui` | memory-slash, monitors, compact SageMemoryBlock, statusline |
| `webui` / `webui-server` | MemoryManager + ReviewQueue + WS handlers |
| `simpleui` | Memory drawer, compact SAGE tool chips |

Ops helpers: `scripts/sage-maintenance.mjs`, `scripts/memory-profile.mjs`, `scripts/analyze-memory-log.mjs`.

---

## 20. End-to-end flow

1. User opens a project in TUI / WebUI / CLI.  
2. Runtime constructs `createProjectSageMemoryPort` → attaches to the project socket or elects/spawns the daemon.  
3. Daemon opens `sage.db`, migrates schema, imports JSONL once if needed.  
4. Host calls `setupSage` → inject / remap / optional capture / context monitor / optional daily timer.  
5. Agent calls `read packages/foo.ts`.  
6. Tool-call middleware resolves the path → `retrieveForPath` + related graph → score gates (+ hybrid re-rank on multi-token search paths).  
7. Accepted memories become evidence / tool suffix → `recordInjection`; UI shows compact inject chip.  
8. Assistant text is scanned by `InjectionTracker` → matching ids get `recordUse`.  
9. Rename tools (`mv` / `git mv` / `lsp_rename`) remap anchors (and symbol text when applicable).  
10. Session consolidator may add long-lived facts **and** a short-lived `session_digest`.  
11. Teardown (if throttle allows) or daily dry-run runs hygiene; daily pass may file triage proposals.  
12. Operator reviews proposals in WebUI **Review** tab (single or bulk) or `/memory candidates`.  
13. External clients (`wstack-sage-mcp --project-root .`) talk to the same daemon.

---

## 21. Recent hardening (shipped)

| Item | Status |
|---|---|
| Shared `setupSage` (CLI ↔ WebUI) + full hygiene options + 1h throttle | Done |
| `verifyDepth` (`existence` / `content` / `git`) | Done |
| Soft hybrid re-rank (hashing, multi-token) | Done |
| Opt-in `tool_outcome` / `error_pattern` capture | Done |
| Session digest on successful consolidator run | Done |
| Daily dry-run: hygiene + bounded triage + file proposals | Done |
| WebUI Review tab + bulk accept/keep + `listCandidates` WS | Done |
| Path remap (`mv` / `git mv` / `Move-Item`) | Done |
| Symbol remap (`lsp_rename` with pre-read identifier) | Done |
| TUI compact inject chip default on | Done |
| SimpleUI compact inject chip + memory drawer | Done |
| MemoryManager server-side `query` / `kind` on `listPage` | Done |
| Proposal dedupe (`fileTriageProposals` / pending `targetMemoryId`) | Done |
| Extended kinds in `VALID_KINDS` + tool schema | Done |

---

## 22. Known limits and design choices

1. **Durable vector index / external embedding API** are not implemented. Soft hybrid re-rank is offline hashing only.  
2. Daily triage **files proposals** but does not auto-apply status updates (by design). Full LLM quality still depends on host providing `getLlmCall`.  
3. Path/symbol remaps are **tool-path driven** (`mv`/`git mv`/`lsp_rename`), not a full codebase-index event bus for every rename in the IDE.  
4. Turn-context injection remains **off by default** so ordinary turns do not break provider prefix caching.  
5. Soft-deleted tombstones can accumulate → list UIs paginate and keep Active / Deleted / Review separate.  
6. `Sage.enabled: false` is not “memory off”; explicit tools and `/memory` still work.  
7. `docs/sage/ARCHITECTURE.md` still contains JSONL-era sections; this report is the runtime source of truth for operators and implementers.

---

## 23. Quick reference

```bash
# CLI / TUI
/memory search "pagination"
/memory file packages/sage/src/sqlite-store.ts
/memory graph <id>
/memory verify
/memory hygiene
/memory candidates
/memory triage --dry-run
/memory triage --apply
/connections

# MCP
wstack-sage-mcp --project-root .                 # read-only
wstack-sage-mcp --project-root . --writable      # writes (confirm-class tools)

# Offline / test
WRONGSTACK_SAGE_INLINE=1 ...
```

```jsonc
// High-signal opt-ins
{
  "Sage": {
    "hygiene": { "verifyDepth": "content" },
    "capture": { "toolOutcomes": true, "errorPatterns": true },
    "triage": { "dailyDryRun": true }
  }
}
```

---

## 24. Related docs

| Document | Role |
|---|---|
| [`packages/sage/README.md`](../../packages/sage/README.md) | Ownership boundaries and composition |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Older package architecture write-up (partially superseded) |
| [`REFACTOR-REPORT.md`](./REFACTOR-REPORT.md) | Historical refactor notes |
| [`docs/slash/memory.md`](../slash/memory.md) | `/memory` user-facing command reference |
| [`docs/configuration.md`](../configuration.md) | `Sage.*` config fields |
| [`docs/agents.md`](../agents.md) | SAGE invariants for agents/contributors |
| [`docs/sage-memory-analysis-2026-08-08.md`](../sage-memory-analysis-2026-08-08.md) | Historical gap analysis (several items now closed) |
| [`docs/audit-2026-08/06-sage-memory.md`](../audit-2026-08/06-sage-memory.md) | Audit findings |
| [`packages/sage-mcp/docs/`](../../packages/sage-mcp/docs/) | MCP architecture, safety, tool inventory |

---

## Maintenance note

When you change any of the following, update **this document** in the same PR:

- SQLite schema / indexes / edge-weight policy  
- IPC ops, auth, or endpoint naming  
- Tool names or MCP allowlist policy  
- Injection gates / defaults  
- Host wiring (`setupSage` middleware set, daily dry-run, capture, remap)  
- WebSocket memory message types  
- MemoryManager / Review / TUI / SimpleUI memory UX contracts  

If a claim cannot be pointed at a source file, treat it as aspirational and move it to a design plan instead of leaving it here as fact.
