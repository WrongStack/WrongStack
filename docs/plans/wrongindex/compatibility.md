# WrongStack storage and integration contract

Status: proposed implementation contract derived from inspected source. Freeze executable fixtures before writing native production data.

## 1. Compatibility has four independent versions

| Version | Describes | Must not be substituted with |
|---|---|---|
| WrongIndex application version | Distributed daemon/GUI release | A schema version |
| IPC protocol version | Transport/envelope negotiation | A client artifact hash |
| Storage profile | Tables, columns, indexes, optional features, metadata semantics | Only `SCHEMA_VERSION` |
| Engine semantic profile | Parser, ownership, resolution, ranking, and query behavior | SQLite file readability |

The current WrongStack schema constant is 5, but additive tables/column repairs and semantic metadata revisions can change without that constant changing. Profile names such as `wrongstack-index-v5-baseline-<manifest-hash>` are proposed; they must resolve to a checked-in manifest, not an undocumented label.

A profile manifest includes source commit and per-file hashes, DDL fingerprint, SQLite compile requirements, required/optional tables, column defaults/nullability, index definitions, parser capability IDs, fingerprint algorithms, metadata keys, vector encoding, and supported query shapes. New profile selection occurs before constructing any existing mutable `IndexStore` equivalent.

## 2. Storage identity

WrongStack resolves its index directory through `resolveIndexDir(projectRoot, override)` and `resolveWstackPaths`. Default main-checkout location:

```text
~/.wrongstack/projects/<project-key>/codebase-index/index.db
```

Linked worktrees use checkout-specific `codebase-index-worktrees/<checkout>` directories beside the shared project state. Exact key derivation remains owned by [the current resolver](../../../packages/persistence/src/wstack-paths.ts), not this illustrative path.

WrongStack passes actual `checkoutRoot` and resolved `indexDir` when registering. WrongIndex records and validates them. Standalone GUI registration uses either an explicit index directory or a versioned resolver port with shared fixtures. Do not invent a new hash directory for an existing WrongStack project.

Current indexed file paths are tied to the actual checkout and may be absolute; this is not a project-relative-path migration. Port the precise behavior per field. Moving a checkout requires an explicit rebind/rebuild workflow and must not reuse old absolute symbol paths silently.

## 3. Baseline table inventory

The source of truth is [writer-schema.ts](../../../packages/tools/src/codebase-index/writer-schema.ts), [writer-init.ts](../../../packages/tools/src/codebase-index/writer-init.ts), and actual fixture introspection. The following inventory makes the implementation work explicit:

| Table | Columns / important contract |
|---|---|
| `metadata` | `key TEXT PRIMARY KEY`, `value TEXT NOT NULL` |
| `files` | `file` PK; `lang`, `mtime_ms`, `content_hash`, `symbol_count`, `last_indexed`, `package`, `git_blob` |
| `symbols` | Integer `id` PK; `lang`, `kind`, `name`, `file`, `line`, `col`, `signature`, `doc_comment`, `scope`, `end_line`, `is_exported`, `signature_hash` |
| `refs` | Integer `id` PK; `from_id`, `to_name`, nullable `to_id`, `call_type`, `line`, `lang`, nullable `module`, nullable `to_file` |
| `lang_family` | `lang` PK, `family`; includes wildcard behavior for legacy language-less refs |
| `symbols_fts` | FTS5 `text` column, tokenizer `trigram`; rowid maps to symbol ID |
| `symbol_rank` | `symbol_id` PK; `rank`, `in_deg`, `out_deg` |
| `file_rank` | `file` PK; `rank`, `in_deg`, `out_deg` |
| `file_concepts` | `file` PK; content/structural hashes, summary, nullable crux positions, state, model, timestamp |
| `subsystems` | `id` PK; name, summary, JSON member files, model, timestamp |
| `concept_edges` | Composite PK `(from_id, to_id, relation)` |
| `file_vectors` | `file` PK; BLOB vector, source hash, provider |
| `symbol_vectors` | Optional table; symbol ID PK/FK, BLOB vector; existing character n-gram vector contract |

Preserve declared SQL types, defaults, nullability, boolean encoding, and exact index definitions. Do not add foreign keys to tables that currently lack them without a negotiated migration. FTS shadow tables are SQLite-owned, not hand-maintained application tables.

### 3.1 Required metadata inventory

Capture all keys from current writer and finalizer, including at least:

- `version`, `last_indexed`, `next_symbol_id`, and deprecated-column repair markers.
- `graph_stamp`, reference resolution version, module resolution version, module owner version, and relation graph version.
- Rank/concept/vector/provider markers and any current feature-specific invalidation keys discovered during export.
- New namespaced publication keys only after profile negotiation: index epoch, committed generation, run ID, and engine profile.

This list is a minimum export checklist, not a declaration that these are the only existing keys. Unknown keys must not be erased.

### 3.2 SQLite runtime contract

Current pragmas include WAL, synchronous NORMAL, busy timeout 15,000 ms, foreign keys ON, memory temp store, configured cache/mmap sizes, journal size limit 64 MiB, and WAL autocheckpoint 1,000 pages. See [writer-pragmas.ts](../../../packages/tools/src/codebase-index/writer-pragmas.ts).

WrongIndex must inspect effective values and runtime support rather than swallowing every configuration error. Cap aggregate cache/mmap commitments across all active projects. NORMAL durability is an explicit accepted policy, not a guarantee against every power-loss scenario.

Validate at startup/release:

1. Actual SQLite library version and compile options.
2. FTS5 and trigram creation/query behavior.
3. Foreign keys enabled on every relevant connection.
4. Reader/writer behavior and busy timeouts on supported filesystems.
5. Existing vector BLOB endian/layout rules through cross-runtime fixtures.
6. Current upstream SQLite WAL fixes and packaged library availability.

WAL permits concurrent readers and one writer; long readers can prevent checkpoint completion. Keep indexes on local supported storage. Network/share/cloud-synchronized locations require explicit unsupported/degraded policy rather than an implied safety guarantee. [SQLite WAL](https://www.sqlite.org/wal.html)

## 4. Exact data semantics

### 4.1 Hashes and text

- Byte content hash: current xxHash64, seed zero, 16-character lowercase hexadecimal output. Match the exact current input conversion, BOM handling, invalid UTF-8 handling, and newline semantics; do not assume hashing raw bytes always equals hashing decoded/re-encoded text.
- Structural fingerprint: current SHA-256 canonicalization over declaration and outgoing-reference fields. Preserve string sorting and whitespace normalization semantics across JS/Rust.
- Git blob trust: stamp only after a complete, stable, qualifying full-project run; targeted edits clear/recompute trust according to the baseline.
- Signature hash is not a replacement for content hash. Cosmetic source changes can preserve enrichment while still changing source positions.
- Preserve NULL versus empty string, JSON serialization contracts, integer timestamps, and locale-independent ordering.
- Define line/column base and encoding per parser. UTF-8 byte columns, Unicode scalars, and JS UTF-16 offsets differ; astral Unicode fixtures are mandatory.

### 4.2 Symbol IDs and edges

Use the existing monotonic allocation contract with `next_symbol_id` never below existing MAX(id)+1. Allocate inside the writer transaction. Do not impose a new deterministic ID scheme on an existing database.

Replacing/deleting symbols updates dependent FTS rows, outgoing refs, incoming target invalidation, rank rows, vector rows, and concept state according to the baseline. Reference ownership includes module-owner symbols for symbol-less importing files. Distinct imports from different modules must not collapse solely because their names match.

Compare symbol identity semantically across independently built fixture databases; numeric IDs may differ. Within one persisted database, assert required ID/reference consistency directly. Do not normalize away broken referential links in the oracle.

### 4.3 Parse and discovery failures

- A genuine deletion removes previous rows and dependent data atomically.
- A permission/read/parse error retains the previous successful rows and marks that file/project degraded.
- An empty successful parse is distinct from a failed parse.
- Partial discovery cannot authorize deleting all unseen rows.
- A parser/backend change invalidates the relevant caches/trust markers even if source bytes are unchanged.

## 5. Migration and compatibility admission

Current WrongStack initialization can drop/rebuild tables on a schema-version mismatch. It may also repair columns, rebuild FTS, or remove a feature-disabled vector table. Therefore opening a shared index through an ordinary writer constructor is already a mutation, even before indexing begins.

Admission algorithm:

1. Inspect metadata and schema through a read-only, bounded connection.
2. Resolve the full storage/engine profile and optional-feature policy.
3. Verify no conflicting owner and identify the supported WrongStack adapter floor.
4. If unknown/newer/incompatible: reject writes, offer read-only diagnostics, and leave bytes untouched.
5. For a supported migration: acquire ownership, create a consistent backup, record intent, migrate transactionally, validate, then publish activation.
6. Rebuild only through an explicit maintenance action with optional data preservation/export and recovery instructions.

Backups use SQLite's online backup API or another documented consistent SQLite snapshot mechanism. Copying only an active WAL database's `index.db` is not a backup. Restore requires closed connections, verified ownership, and a supported file replacement procedure, especially on Windows. [SQLite Backup API](https://www.sqlite.org/backup.html)

Do not increment `SCHEMA_VERSION` merely to label WrongIndex ownership: older initializers could treat that as permission to rebuild.

## 6. Writer ownership and legacy-client boundary

### 6.1 What an ownership lock can and cannot do

An OS-backed lock keyed by resolved index identity coordinates cooperating new components. Its monotonically increasing owner epoch fences queued tasks and worker responses. It does not stop an unmodified legacy process that ignores the lock from opening SQLite.

SQLite file locks serialize transactions but do not prevent a legacy process from writing incompatible graph state after a WrongIndex commit. A PID file, heartbeat, metadata flag, or one-time endpoint probe is insufficient protection against such a client starting later.

Consequently, production write takeover requires a compatible WrongStack release that honors external ownership across startup, edit hooks, worker/inline fallbacks, schema initialization, maintenance, and direct store users. Inventory every writer, including vector/concept passes. The application must clearly document the minimum supported WrongStack version.

If an older installation cannot be excluded or upgraded, keep the project unclaimed/read-only or use an explicitly separate experimental index. Do not advertise that experimental path as adoption of the current production index. Same-user malicious writers are outside the guarantee; known unsupported clients are a compatibility conflict, not an invisible caveat.

### 6.2 Transfer state machine

```text
unclaimed -> negotiating -> draining_previous_owner -> backed_up
          -> activating_new_owner -> owned
owned -> draining -> released -> legacy_or_other_supported_owner
any intermediate state -> recovery_required
```

Transfer procedure:

1. Supported WrongStack adapter disables local admission and requests the current owner to drain.
2. Close mutable legacy readers/writers and stop its external watcher.
3. Acquire the index ownership guard and increment owner epoch.
4. Probe for remaining supported owners and validate profile.
5. Create backup and record transition intent.
6. Start the selected backend as the sole writer, reconcile, publish epoch/generation.
7. Point clients at WrongIndex; keep rollback instructions and transition receipt.

All mutations validate owner epoch/config revision at commit, not only before parsing. A compatibility worker is owned by the daemon and must not elect itself as an independent project daemon. Preview worker mode and native mode cannot write concurrently.

Fallback after daemon failure is conservative: reconnect/restart first. `auto` mode may return to a supported local owner only after ownership release/recovery and profile checks. Connection timeout alone never authorizes simultaneous fallback writes.

## 7. WrongStack integration work

Proposed configuration shape; not existing WrongStack flags:

```json
{
  "indexing": {
    "service": "auto",
    "watchPolicy": "session"
  }
}
```

`service` values: `local`, `wrongindex`, `auto`. During staged rollout keep the current behavior as the default until the adapter and recovery gates pass. `wrongindex` requires service admission; `auto` follows the safe ownership protocol; `local` must refuse an externally owned index until release. Persisted GUI pinning may override session activation, but client config must not erase user pinning.

| Surface | Required change |
|---|---|
| CLI startup wiring | Resolve exact index path; acquire session; request reconciliation; report actual backend/freshness |
| Edit/write/patch/format/AST replacement hooks | Send targeted changes to service; preserve current successful-write detection |
| Background indexer | Introduce transport selection behind current public service functions; no accidental worker/inline fallback |
| Project daemon launcher | Keep local mode; do not apply legacy artifact-election/kill logic to WrongIndex |
| Read services and direct IndexStore consumers | Route queries or enforce negotiated read-only access; inventory mutable constructors |
| WebUI/desktop hosts | Share session/lease semantics and consume generation/state events |
| MCP package | Continue existing tool schemas; use the shared adapter; keep model-facing serialization contracts |
| Reindex/status commands | Surface backend, owner, queue, freshness, cancellation, and typed errors |
| Enrichment and SAGE bridges | Preserve optional post-index side effects or explicitly negotiate capability and staleness |
| Shutdown | Release only this client's lease; never stop the global daemon because one session closes |

## 8. Query compatibility matrix

| Operation | Required parity dimensions |
|---|---|
| Search | Query tokenization, FTS/BM25 fallback, filters, total counts, tie ordering, limits, zero-hit summary |
| Stats | File/symbol/language counts, timestamps, errors, readiness meaning |
| Package graph | Package labels, edges, unresolved imports, filtering |
| File graph | Path normalization, package filter, dependency direction |
| Symbol graph | Symbol ownership, call edges, file filter |
| Incoming calls | Name/file disambiguation, imports, transitive depth/cycles, limits |
| Outgoing calls | Same rules with direction reversed; preserve call types |
| Context | Candidate ranking, path scope, symbols per file, supplied vector scores |
| Vector search | BLOB decode, dimensions, provider consistency, similarity thresholds |
| Higher-level tools | Skeleton, read symbol, repo map, impact/diff/flow/atlas consume compatible data and keep their external contracts |

The existing [worker protocol](../../../packages/tools/src/codebase-index/worker-protocol.ts) is the starting operation inventory. Whole-file source reads and AST mutation remain WrongStack responsibilities unless separately designed; an index service must not silently become a file-editing authority.

## 9. Cache coherence

Every mutating producer must update a durable generation in the same index transaction as usable content changes. Namespace new metadata to avoid confusing existing markers. Cross-process readers can also observe SQLite `data_version`, but it is connection-relative and cannot replace an application-wide durable generation.

Invalidate/check at least: server query cache, BM25 corpus, graph adjacency, graph rank views, repo-map/context caches, WebUI codemap cache, vector/provider caches, and in-flight replies. Current BM25 already checks `PRAGMA data_version`; that does not prove every consumer does.

During refresh choose one tested policy per query surface:

- Read last committed snapshot from an independent read connection, returning its generation and `stale` when relevant.
- Serve a previous-generation cached result explicitly marked stale.
- Return a typed wait/retry response if that operation cannot provide a valid snapshot.

Never expose half-published refs/FTS/ranks as the new generation. Crash after database commit but before notification is repaired by reconnect/snapshot checks. A reset/rebuild changes index epoch as well as generation lineage.

## 10. Native language migration

Current dispatch includes TS/TSX/JS/JSX, Go, Python, Rust, JSON, YAML, ten tree-sitter language routes (C, C++, Java, C#, PHP, Ruby, Swift, Kotlin, shell, Elixir), and generic mapped-language fallback. Export the full current language-extension map rather than treating this prose list as complete.

| Group | Main parity risk | Migration order |
|---|---|---|
| JSON/YAML and simple config | Path/ownership and empty-file semantics | First native write slice |
| Existing tree-sitter routes | Grammar/query differences, fallback behavior, columns | After runtime/grammar ABI fixture capture |
| Rust | Existing helper/AST extraction vs tree-sitter declarations | Independently gated |
| TS/JS | Compiler API declarations, signatures, overloads, JSX, import aliases | Separate high-effort milestone |
| Go/Python | Compiler/AST helper behavior, package/import/qualified calls | Separate language milestones |
| Generic mapped languages | Recall and source-file inclusion | Preserve current behavior before improving it |

For every language, enumerate parser, helper processes, fallback rules, grammar version, output fidelity, and errors. Native tree-sitter is a candidate implementation, not a proof of equivalent semantic behavior. Keep the compatibility backend until the full language profile passes; publish differences instead of hiding them behind changed fixtures.

## 11. Reverse compatibility and rollback

Rollback order: stop service write admission -> drain -> release ownership -> verify a supported local WrongStack reader/writer can open the profile -> reconcile using that owner -> detach service. Restore a backup only if required and explicitly selected; doing so can discard valid newer index/enrichment changes.

Uninstall removes service binaries/autostart registration after stopping ownership safely. Preserve WrongStack indexes and project sources. Keep registry/config by default with a separate explicit remove-user-data option constrained to the WrongIndex data root. Uninstall must not leave supported clients waiting forever on an external-owner flag.
