# SAGE Memory Architecture

> **⚠️ PARTIALLY SUPERSEDED:** This design draft (2026-07-11) describes the
> original JSONL-based architecture. As of 2026-07, the implementation uses
> SQLite (`SqliteSageStore`) with FTS5, WAL mode, graph edges, anchor
> verification, session-scoped ownership (`ownerSessionId`), and unified
> search with configurable ranking. JSONL is only a migration source. See
> `packages/sage/README.md` for the current architecture.

Status: design draft
Date: 2026-07-11

SAGE is the project-local long-term knowledge layer for WrongStack. It is not a bigger
`remember` tool. It is a platform subsystem that captures, verifies, retrieves, injects, cleans,
and retires project knowledge during normal agent work.

The system must be useful without explicit memory requests. Reading a file, listing a tree,
searching code, running tests, and editing files should all be able to surface relevant project
knowledge when it helps the agent act correctly.

## Goals

- Store project memory inside the project, under a gitignored directory.
- Preserve the existing `MemoryStore` contract so current tools, slash commands, and prompt
  injection keep working while the backend becomes richer.
- Treat memory quality as a first-class concern: dedupe, merge, verify, stale, supersede,
  contradict, archive, and delete.
- Attach memory to files, directories, symbols, packages, commands, tests, sessions, and other
  memories.
- Inject relevant memory automatically into tool results and turn-level context, with strict
  noise controls.
- Keep `core` at the bottom of the dependency graph. SAGE must depend on `core`, not the
  other way around.
- Make indexes rebuildable and data corruption recoverable.

## Non-Goals

- Do not store secrets, tokens, keys, credentials, or private environment values.
- Do not commit memory data. Project-local memory lives under ignored `.wrongstack/memories/`.
- Do not dump all memory into the prompt.
- Do not make vector embeddings mandatory. Lexical and graph retrieval must work offline.
- Do not couple memory logic directly into individual builtin tools.

## Package Boundary

Add a new package:

```text
packages/sage/
  src/
    index.ts
    types/
    storage/
    graph/
    retrieval/
    capture/
    hygiene/
    anchors/
    middleware/
    tools/
    cli/
    adapters/
```

Dependency direction:

```text
core  <-  sage  <-  cli/runtime/webui-server/apps
```

`packages/sage` may import `@wrongstack/core` types and utilities. `packages/core` must
not import `sage`.

Runtime wiring binds:

```ts
TOKENS.MemoryStore -> SageStore
```

`SageStore` implements the existing `MemoryStore` interface and also exposes richer
methods through a separate `SageService` interface.

## Project-Local Storage

Primary storage is project-local and gitignored:

```text
.wrongstack/memories/
  manifest.json
  memories.jsonl
  candidates.jsonl
  audit.jsonl

  graph/
    edges.jsonl

  indexes/
    by-path.json
    by-symbol.json
    by-tag.json
    by-kind.json
    lexical.json

  snapshots/
    latest.json
    latest.compact.json

  hygiene/
    runs.jsonl
    stale.jsonl
    conflicts.jsonl

  tmp/
  locks/
```

`.gitignore` already ignores `.wrongstack/` in this repository. The storage path is still specific
to `.wrongstack/memories/` so future repos can ignore only local state while allowing committed
`.wrongstack/AGENTS.md` and `.wrongstack/skills/` if desired.

### Storage Principles

- Canonical event streams are JSONL.
- Indexes are derived cache and can be deleted/rebuilt.
- Snapshots accelerate boot, but JSONL replay remains authoritative.
- All records carry a schema version.
- Writes use file locks plus temp-file atomic rename.
- JSON schema validation runs before append.
- Corrupt JSONL lines are quarantined into `audit.jsonl`; valid lines continue to load.
- Append-only updates preserve auditability. A memory update writes a new revision record rather
  than mutating old JSONL lines.

## Files

### `manifest.json`

Tracks schema and rebuild state:

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-07-11T00:00:00.000Z",
  "updatedAt": "2026-07-11T00:00:00.000Z",
  "lastSnapshotId": "snap_...",
  "indexes": {
    "version": 1,
    "builtAt": "2026-07-11T00:00:00.000Z"
  }
}
```

### `memories.jsonl`

Append-only memory revisions. The latest non-deleted revision per `id` is active.

```json
{
  "recordType": "memory",
  "schemaVersion": 1,
  "op": "create",
  "id": "mem_01JZ...",
  "revision": 1,
  "scope": "project",
  "kind": "decision",
  "status": "active",
  "text": "Session ids are date-sharded; sidecar paths must use sessionScopedPath().",
  "importance": 0.95,
  "confidence": 0.9,
  "freshness": 1,
  "tags": ["session", "storage"],
  "anchors": [
    {
      "type": "file",
      "path": "packages/core/src/storage/session-store.ts",
      "contentHash": "sha256:..."
    }
  ],
  "sources": [
    {
      "type": "project_instruction",
      "path": ".wrongstack/AGENTS.md"
    }
  ],
  "createdAt": "2026-07-11T00:00:00.000Z",
  "updatedAt": "2026-07-11T00:00:00.000Z"
}
```

### `candidates.jsonl`

Memory candidates before acceptance. Candidates can be accepted, rejected, merged into an existing
memory, or left pending for human review.

### `audit.jsonl`

Every mutation and automated decision:

```json
{
  "schemaVersion": 1,
  "event": "memory.accepted",
  "memoryId": "mem_01JZ...",
  "source": "session_consolidator",
  "reason": "High-value session lifecycle invariant",
  "at": "2026-07-11T00:00:00.000Z"
}
```

### `graph/edges.jsonl`

Append-only graph edges:

```json
{
  "schemaVersion": 1,
  "id": "edge_01JZ...",
  "from": "mem_01JZ...",
  "to": "file:packages/core/src/storage/session-store.ts",
  "relation": "about_file",
  "weight": 0.95,
  "createdAt": "2026-07-11T00:00:00.000Z"
}
```

## Core Types

```ts
export type SageScope =
  | 'project'
  | 'user'
  | 'session'
  | 'file'
  | 'symbol';

export type SageKind =
  | 'fact'
  | 'decision'
  | 'convention'
  | 'preference'
  | 'warning'
  | 'anti_pattern'
  | 'workflow'
  | 'bug_root_cause'
  | 'file_note'
  | 'symbol_note'
  | 'command_note'
  | 'summary';

export type SageStatus =
  | 'active'
  | 'stale'
  | 'superseded'
  | 'contradicted'
  | 'archived'
  | 'deleted';

export interface Sage {
  id: string;
  revision: number;
  scope: SageScope;
  kind: SageKind;
  status: SageStatus;
  text: string;
  summary?: string;
  importance: number;
  confidence: number;
  freshness: number;
  tags: string[];
  anchors: MemoryAnchor[];
  sources: MemorySourceRef[];
  supersedes?: string[];
  supersededBy?: string;
  contradicts?: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  lastVerifiedAt?: string;
  expiresAt?: string;
}

export interface MemoryAnchor {
  type: 'file' | 'directory' | 'symbol' | 'package' | 'command' | 'test' | 'git';
  path?: string;
  symbol?: string;
  command?: string;
  contentHash?: string;
  gitBlobHash?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface MemorySourceRef {
  type:
    | 'user'
    | 'session'
    | 'tool_result'
    | 'project_instruction'
    | 'file'
    | 'test'
    | 'command'
    | 'legacy_memory';
  sessionId?: string;
  toolUseId?: string;
  path?: string;
  command?: string;
  excerptHash?: string;
}
```

Line numbers are hints only. Verification relies on path, symbol, content hashes, git blob hashes,
and codebase index data.

## Graph Model

Relations:

```text
about_file
about_directory
about_symbol
about_package
about_command
derived_from
validated_by
invalidated_by
supersedes
contradicts
related_to
same_topic
```

Node identifiers:

```text
mem:<id>
file:<relative-path>
dir:<relative-path>
symbol:<relative-path>#<symbol-name>
command:<normalized-command>
session:<session-id>
tool:<session-id>/<tool-use-id>
```

Graph traversal supports:

- memory for a file
- memory for a directory/tree
- memory related to a symbol
- memory connected to an error output
- conflict and supersession discovery

## Retrieval

Retrieval combines multiple signals. It must not be a single substring search.

Signals:

- exact path match
- ancestor directory match
- symbol match
- package match
- command match
- FTS/lexical match
- tag match
- graph distance
- source strength
- kind priority
- importance
- confidence
- freshness
- verification status
- tool trigger type
- current user task
- session cooldown

Statuses:

- `active`: eligible
- `stale`: hidden by default; can appear as a warning when directly anchored
- `superseded`: hidden unless explain/debug mode is requested
- `contradicted`: never injected as guidance; only shown in audit/debug surfaces
- `archived`: not injected
- `deleted`: not loaded into active state

## Automatic Tool Result Injection

Memory must trigger even when the model does not ask for it. The implementation point is the
`toolCall` pipeline, not individual tools.

Flow:

```text
tool execute
-> toolCall pipeline
-> SageToolCallMiddleware
-> extract MemoryTriggerContext
-> retrieve relevant memory
-> apply limits and cooldown
-> append a clearly separated memory block to the tool result
-> log memory.injected
```

Trigger context:

```ts
export interface MemoryTriggerContext {
  trigger:
    | 'read'
    | 'tree'
    | 'grep'
    | 'glob'
    | 'codebase_search'
    | 'bash'
    | 'write'
    | 'edit'
    | 'patch';
  cwd: string;
  paths: string[];
  symbols?: string[];
  queryText?: string;
  command?: string;
  outputExcerpt?: string;
  sessionId: string;
  toolUseId: string;
}
```

### `read(path)`

Inject file and symbol scoped memory:

```text
SAGE: related project knowledge (Memory Injector)
- [decision][high] Session ids are date-sharded; sidecars must use sessionScopedPath().
- [warning][critical] Do not emit session_end from /save; only trailing session_end means clean exit.
```

The memory block must be outside the file content. It must never be formatted as if it were part
of the file.

### `tree(path)`

Inject directory/package scoped memory:

```text
SAGE: notes for packages/core/src/storage ---
- [convention] Session lifecycle changes require session-lifecycle tests.
- [warning] Storage writers must serialize writes through FIFO queues.
```

### `grep` / `glob` / `codebase_search`

Use query terms plus matched paths. Prefer direct path and symbol matches over broad lexical hits.

### `bash(command)`

Use normalized command, output excerpt, and error signatures:

- known build/test conventions
- previous root causes for similar failures
- commands that validate related memory

### `write` / `edit` / `patch`

Do not spam ordinary memory hints. Instead:

- mark affected anchored memories as verification-needed
- surface critical invariants for touched files
- emit stale/verification events
- optionally add a compact warning block when a high-confidence invariant is relevant

## Noise Control

Default retrieval limits:

```ts
export interface SageInjectionConfig {
  enabled: boolean;
  toolResults: boolean;
  turnContext: boolean;
  maxHintsPerTool: number;      // default 4
  maxCharsPerTool: number;      // default 1200
  maxTurnMemories: number;      // default 8
  minScore: number;             // default 0.65
  repeatCooldownMs: number;     // default 30 minutes
  pathCooldownMs: number;       // default 5 minutes
  allowStaleDirectWarnings: boolean;
}
```

Rules:

- Do not inject the same memory repeatedly in the same session.
- Critical memory can override score thresholds, but not cooldown spam controls.
- Low confidence memory requires direct path/symbol/command match.
- Stale memory is not guidance; it is only a warning.
- Contradicted memory is never guidance.
- If the tool result is already near the output cap, omit or shorten memory hints.
- Always clearly label injected memory as memory, not source output.

## Capture Pipeline

Sources:

- explicit `remember`
- session consolidation
- user stated preferences
- tool results
- build/test failures
- file edits
- project instructions
- codebase index metadata
- legacy memory import

Pipeline:

```text
candidate
-> secret scrub/reject
-> temporary/noise filter
-> classify kind/scope
-> normalize text
-> attach anchors
-> find duplicates/conflicts
-> policy decision
-> create/update/merge/reject
-> audit
-> index rebuild/update
```

No candidate becomes active memory without policy checks.

## Hygiene

Hygiene runs:

- after session
- after write/edit/patch touching anchored paths
- on explicit `/memory hygiene`
- opportunistically before injection for directly matched stale candidates
- optionally on startup if manifest says indexes or snapshots are dirty

Actions:

- dedupe exact and near-duplicate entries
- verify file/symbol anchors and mark `stale` on failure (self-heals to `active` on next successful verify)
- supersede old versions of a fact (dedup keeps the highest-quality entry)
- surface review candidates for expired, never-used, low-confidence, or stale memories

> **Hygiene never auto-deletes or auto-archives.** The `archived` and `deleted`
> report counters are always zero in the current pipeline. Instead, hygiene
> creates **review candidates** (`memory_candidates`) that the user or agent
> resolves via `memory_delete`, `memory_update`, or the ReviewQueue UI. Final
> deletion/archival decisions always belong to the caller, never to hygiene.

Staleness rules:

- file anchor missing -> stale
- symbol anchor missing -> stale
- content hash changed -> stale
- git blob hash changed -> stale
- newer active decision on same topic -> old decision superseded
- test/build evidence disproves memory -> contradicted
- unused low-confidence memory past retention -> review candidate (not auto-archived)

## Verification

Verifier sources:

- filesystem existence
- file content hash
- git blob hash
- codebase index symbol lookup
- package manifests
- config files
- command/test evidence
- session/tool audit history

Verification result:

```ts
export type VerificationStatus =
  | 'verified'
  | 'stale'
  | 'contradicted'
  | 'unknown';
```

Verification must be deterministic where possible. LLM verification can assist with classification
but must not be the only source of truth for file existence, symbol existence, or command results.

## Legacy Compatibility

The adapter maps existing memory scopes:

```text
project-agents  -> source project_instruction / scope project
project-memory  -> scope project
user-memory     -> scope user
```

Existing tools keep their names:

- `remember`
- `forget`
- `search_memory`
- `find_related_memories`

They delegate to SAGE through the `MemoryStore` interface. Richer tools live in
`packages/sage/src/tools`.

Legacy import:

```text
/memory import-legacy
```

This reads existing `memory.md` data, parses it into structured records, marks the source as
`legacy_memory`, and preserves the original text.

## Tools

New tools:

```text
memory_for_file
memory_for_path
memory_search
memory_graph
memory_verify
memory_hygiene
memory_candidates
```

Tool categories should stay under Session/Inspect unless a stronger existing category fits.

## Slash Commands

Extend `/memory`:

```text
/memory show
/memory search <query>
/memory file <path>
/memory path <dir>
/memory graph <query|path>
/memory remember <text>
/memory forget <query>
/memory hygiene
/memory verify
/memory stats
/memory candidates
/memory audit
/memory import-legacy
```

`show` should default to active project memory, not raw JSONL.

## Config

Add benign config fields:

```ts
export interface SageConfig {
  enabled?: boolean;
  storage?: {
    projectLocal?: boolean;       // true
    directory?: string;           // ".wrongstack/memories"
  };
  inject?: SageInjectionConfig;
  hygiene?: {
    autoAfterSession?: boolean;
    autoOnFileChange?: boolean;
    retentionDays?: number;
    archiveLowConfidenceAfterDays?: number;
  };
  embeddings?: {
    enabled?: boolean;
    provider?: string;
  };
}
```

Security rule: in-project config may only control benign behavior such as enabling/disabling
injection, limits, and hygiene cadence. It must not be allowed to configure providers, commands,
endpoints, plugins, hooks, or executable behavior.

Update `stripUnsafeInProjectFields()` classifications when adding the config key.

## Events

Add memory events:

```text
memory.candidate_created
memory.candidate_rejected
memory.accepted
memory.updated
memory.merged
memory.superseded
memory.contradicted
memory.staled
memory.archived
memory.injected
memory.verified
memory.hygiene_started
memory.hygiene_completed
memory.graph_edge_added
```

Event payloads must include `sessionId` and `traceId` when available.

## Tests

Coverage areas:

- JSONL append and replay
- snapshot load and rebuild fallback
- corrupt JSONL line quarantine
- legacy import
- `MemoryStore` compatibility
- file anchor verification
- symbol anchor verification
- graph edge traversal
- read/tree/grep/bash trigger extraction
- tool result injection formatting
- cooldown/no-spam behavior
- context output caps
- secret rejection
- dedupe and merge
- supersede and contradiction
- stale and archive
- slash commands
- config allow-list behavior

## Implementation Order

1. Add `packages/sage` package skeleton and public types.
2. Add project-local JSONL storage, locks, snapshots, and replay.
3. Implement `SageStore implements MemoryStore`.
4. Add legacy import from existing memory markdown.
5. Add lexical/path/tag indexes and rebuild command.
6. Add retriever and scorer.
7. Add `toolCall` middleware for `read`, `tree`, `grep`, `glob`, `codebase_search`, `bash`,
   `write`, `edit`, and `patch`.
8. Add file, directory, symbol, command, and git anchors.
9. Add hygiene engine.
10. Add verifier.
11. Add graph edges and traversal.
12. Add session consolidation v2.
13. Add slash commands and tools.
14. Add WebUI/TUI observability surfaces.
15. Retire or shim the old graph backend once compatibility is proven.

Each step must preserve the existing memory tools and prompt injection behavior.
