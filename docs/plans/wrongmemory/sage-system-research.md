# SAGE system research and compatibility findings

Research date: 2026-11-01. Method: source, manifests, documented contracts, and test inventory inspection. This is not a runtime audit or proof of live memory quality.

[Research source fingerprints](research-source-snapshot.json) record SHA-256 hashes of the referenced implementation/manifests in the inspected working tree. Use them to detect drift when starting implementation. They do not replace M0's clean immutable baseline or prove that the observed code passed tests.

## 1. Current system map

```text
WrongStack CLI / TUI / WebUI / Desktop / ACP / tool surfaces
  -> MemoryPort + SAGE retrieval/service/surface capabilities
  -> ProjectSageMemoryPort over project IPC
  -> project-server.ts, one canonical project owner
  -> SqliteMemoryPort / SqliteSageStore
  -> sage.db, JSON records + denormalized SQL + FTS + graph + candidates

Host middleware:
  tool-result recall / optional turn recall / evidence refresh / injection tracker
  outcome capture / rename remap / domain-term extraction / session-end extraction

Optional host vector layer:
  SAGE events -> vector mirror -> host semantic query -> RRF fusion

External MCP:
  independent sage-mcp OR attach-only wstack sage mcp -> existing project IPC
```

The [runtime container](../../../packages/runtime/src/container.ts) binds `TOKENS.MemoryStore` and `TOKENS.MemoryPort` to the same project port. `Sage.enabled=false` controls automatic behavior, not a switch to another store. Production hosts do not normally own writable SQLite connections; inline storage is an explicit test/offline path.

Sources: [memory-port.ts](../../../packages/sage/src/memory-port.ts), [remote-memory-port.ts](../../../packages/sage/src/remote-memory-port.ts), [project server](../../../packages/sage/src/project-server.ts), [shared host wiring](../../../packages/sage/src/host-wiring.ts).

## 2. Identity and paths

- Default relative storage directory is `.wrongstack/memories`.
- Canonical store is `sage.db` with normal SQLite WAL/SHM sidecars.
- Production endpoint resolution canonicalizes the repository identity; linked worktrees share the canonical SAGE store/daemon.
- Project-local storage overrides must remain inside the canonical project; absolute or escaping relative paths and symlink escapes are rejected.
- `server.json` contains daemon metadata and a private authentication token. Hello frames exclude that token.
- `manifest.json` has a separate record/manifest schema version.
- Legacy JSONL memory/candidate/audit/edge files are one-time migration inputs and recovery copies, not the writable runtime backend.

Sources: [paths](../../../packages/sage/src/paths.ts), [endpoint resolver](../../../packages/sage/src/project-server-endpoint.ts), [store initialization](../../../packages/sage/src/sqlite-store-initialize.ts), [JSONL migration](../../../packages/sage/src/sqlite-store-jsonl-migration.ts).

Important difference from WrongIndex: memory identity may be shared across linked worktrees; code indexes describe one checkout. WrongMemory must retain the memory sharing policy while binding verification evidence to the actual authorized checkout. A path missing in one branch is not universal proof that a shared memory is false.

## 3. Record model

Source: [memory-model.ts](../../../packages/sage/src/memory-model.ts), [types.ts](../../../packages/sage/src/types.ts), [input validation](../../../packages/sage/src/memory-input-validation.ts).

| Dimension | Current contract |
|---|---|
| Identity | String ID, integer revision, creation/update timestamps |
| Scopes | `project`, `user`, `session`, `file`, `symbol` |
| Statuses | `active`, `stale`, `superseded`, `contradicted`, `archived`, `deleted` |
| Persistence | `permanent`, `long_lived`, `short_lived`; absent defaults to long-lived |
| Context policy | `eligible` or `never`; orthogonal to lifecycle status |
| Knowledge | Text, optional summary, tags, importance, confidence, freshness |
| Structure | File/directory/symbol/package/command/test/git/agent anchors |
| Audience | Roles, task types, modes; project-local applicability selectors |
| Provenance | User/session/tool/file/test/command/instruction/legacy sources |
| Relationships | Supersedes, supersededBy, contradicts plus graph edges |
| Session isolation | `ownerSessionId` for session-scoped records |
| Validity | Applicability statement and bounded literal source checks |
| Feedback | Bounded judgments carrying observed revision and evidence |
| Telemetry | Injection/use counts and last access/use/verification times |

The 20 current kinds are `fact`, `decision`, `convention`, `preference`, `warning`, `anti_pattern`, `workflow`, `bug_root_cause`, `file_note`, `symbol_note`, `command_note`, `summary`, `memory_review`, `tool_outcome`, `error_pattern`, `session_digest`, `role_operational`, `task_outcome`, `security_signal`, and `fleet_convention`.

Scope is not a storage namespace: `scope=user` still lives inside this project's store. Changing it to global sharing would be a new feature and privacy boundary.

Current input limits include 20,000 text characters and 128 metadata items; literal validity check and feedback limits are separate. Rust must reproduce JS length/normalization behavior where contractual, including Unicode edge cases. Scope/session ownership are immutable through ordinary update; changing them requires a separately defined operation.

## 4. Real SQLite inventory

Sources: [schema](../../../packages/sage/src/sqlite-store-schema.ts), [initialization/migrations](../../../packages/sage/src/sqlite-store-initialize.ts), [text index helper](../../../packages/persistence/src/sqlite-text-index.ts), [SAGE text profile](../../../packages/sage/src/sqlite-store-text-index.ts), [HQ sync](../../../packages/sage/src/sqlite-store-hq-sync.ts).

`SQLITE_SCHEMA_VERSION=5` and `SAGE_SCHEMA_VERSION=1` describe different layers. Additive tables/columns/triggers make a single version constant an incomplete compatibility check.

| Object | Observed content |
|---|---|
| `memories` | ID, full JSON `data`, status/kind/scope/legacy_scope, importance/confidence/freshness, timestamps, audience/tags, owner_session_id, canonical_text |
| `memories.unicode_text` | Added by the shared text-index helper; NFKC/lowercase search projection |
| `ws_text_index_revisions` | Text projection revision, currently `nfkc-lower-v1` through the SAGE profile |
| `memories_fts` | FTS5 text/tags/audience, external content tied to `memories.rowid` |
| `edges` | Composite key from_node/to_node/relation; weight and creation timestamp |
| `candidates` | Candidate JSON plus status/timestamps/canonical_text |
| `audit_log` | Auto-increment ID, event/time/trace/data; bounded recent activity trail |
| `schema_meta` | Key/value integers for schema/migration/FTS/sync initialization |
| `hq_memory_sync` | Shared-scope change projection, revision, change ID, data/tombstone |
| `hq_memory_sync_clock` | Epoch/revision clock for sync consumers |

FTS insert/delete/update triggers guard malformed JSON; counter-only updates do not cause full text reindexing when indexed fields are unchanged. Text projection invalidation is trigger-driven and refreshed through the shared helper. HQ triggers exclude local access counters from change detection, and verification-only freshness/stamp changes do not create replication churn.

Pragmas: WAL, synchronous NORMAL, busy timeout 30 seconds, temp store MEMORY, foreign keys ON, configured cache and mmap. Actual FTS/JSON/SQLite capabilities must be measured in the packaged Rust runtime.

Audit is bounded to approximately 1,000 recent rows with pruning every 256 inserts. It is not a permanent compliance ledger or a basis for exact lifetime usage totals after pruning.

## 5. Mutation semantics

- Serialized mutations own canonical records, denormalized columns, anchor/relationship edges, candidate decisions, and audit.
- Remember normalizes durable content, applies quality/secret/progress guards, handles duplicates, and derives graph bindings.
- Update supports `expectedRevision`; feedback is submitted separately from content/lifecycle updates.
- Injection/use counter writers update JSON telemetry without advancing `updated_at`, the content-recency clock.
- Delete is a force-gated tombstone with revision increase and edge/reference cleanup, not ordinary physical removal.
- Recovery follows active superseding chains and avoids creating duplicate active knowledge after backfill.
- Backfill is dry-run by default and may restore a new active successor while retaining the original tombstone.
- A corrupt sibling row should not hide all valid search/review results. Trigger behavior must also tolerate relevant malformed rows.
- Shutdown drains mutation work before closing SQLite.

Sources: [remember](../../../packages/sage/src/sqlite-store-remember.ts), [update](../../../packages/sage/src/sqlite-store-update.ts), [counters](../../../packages/sage/src/sqlite-store-counters.ts), [delete](../../../packages/sage/src/sqlite-store-delete.ts), [recovery](../../../packages/sage/src/sqlite-store-recovery.ts), [codec](../../../packages/sage/src/sqlite-store-codec.ts), [mutation queue](../../../packages/sage/src/sqlite-store-mutation-queue.ts).

## 6. Graph and anchors

Graph memory IDs use `mem:<id>`. Anchor nodes bind file/directory/symbol/package/command/agent and related structural evidence. Relations include about_* links, derived/validated/invalidated evidence, supersedes, contradicts, related_to, and same_topic.

Edge upsert retains the maximum asserted weight; replay must not erode established strength. Anchor edges may be synchronized by their sole producer. Supersedes/contradicts assertions are add-only in the current relationship-sync helper; removing an array element does not automatically retract every graph assertion. A Rust "cleanup" that deletes/rebuilds every relationship would change semantics.

Traversal, hub damping, status/session visibility, cycle/depth/limit bounds, and synthetic/reconstructed edge evidence are part of retrieval parity.

Sources: [graph helpers](../../../packages/sage/src/sqlite-store-graph-helpers.ts), [relationship synchronization](../../../packages/sage/src/sqlite-store-relationship-sync.ts), [graph traversal](../../../packages/sage/src/sqlite-store-graph-traverse.ts), [anchor synchronization](../../../packages/sage/src/sqlite-store-anchor-sync.ts).

## 7. Retrieval and context use

There are several related surfaces, not one interchangeable search:

1. SAGE lexical/path/audience/graph retrieval for concrete tool/task context.
2. Unified search with query/filter/ranking-bound cursors and explained match reasons.
3. Automatic tool-result injection, applying strong relation/importance/score gates plus cooldown, diversity, visibility, and a context budget.
4. Optional turn-context injection; not the default.
5. Operator WebUI discovery with a distinct policy excluding all session-scoped memories.
6. Optional host-side vector mirror and reciprocal-rank fusion.

Current automatic injection defaults include relation strength 0.85, score 0.72, and importance 0.5. Preserve or explicitly version changes. These are not universally calibrated probabilities.

A request-time evidence refresh rechecks selected records before they are rendered; a shared injection tracker connects rendered memory to later reference/use signals. Use is a relevance signal, not a proven task outcome. No static memory prompt should duplicate dynamic host injection by default.

Sources: [host wiring](../../../packages/sage/src/host-wiring.ts), [scoring gates](../../../packages/sage/src/middleware/tool-call-memory-scoring.ts), [tool recall](../../../packages/sage/src/middleware/tool-call-memory.ts), [evidence refresh](../../../packages/sage/src/middleware/evidence-refresh.ts), [context monitor](../../../packages/sage/src/middleware/context-monitor.ts), [search contract](../../../packages/sage/src/service-contract.ts).

## 8. Vector architecture

The current vector package stores a separate corpus (`entries`, `vectors`, embedding cache, provider/dimension metadata). Some rows mirror SAGE; other vector entries are independent. SAGE remains authoritative for a mirrored memory's visibility and revision.

Production fusion occurs in the host wrapper because callable vector providers cannot cross the JSON IPC boundary and the embedding store/provider lives in the host. Vector-only hits are materialized by SAGE ID and rechecked for visibility. Recall is bounded; the inspected implementation uses an additional vector-candidate cap of 12, RRF k=60, default vector weight 0.3, and a default semantic-only admission floor 0.62. Model/provider changes require re-evaluation, not universal reuse of that threshold.

Automatic semantic augmentation fails open to lexical results on provider failure. Explicit operator vector search has a different contract: provider failure is an error, not a false empty result. WrongMemory must preserve that distinction.

Sources: [port wrapper](../../../packages/vector-memory/src/sage-port-wrapper.ts), [vector augmentation](../../../packages/sage/src/retrieval/vector-augment.ts), [event mirror](../../../packages/vector-memory/src/sage-event-mirror.ts), [vector schema](../../../packages/vector-memory/src/schema.ts), [unified WebUI contract](../unified-sage-search-backend-contract.md).

## 9. Validity and advisory feedback

Validity carries a human/model applicability statement and at most four literal `source_contains` checks. It cannot execute commands, expressions, or regular expressions. Evidence outcomes are satisfied/not_satisfied/unknown. A satisfied literal is evidence of source presence, not proof of the statement's truth or applicability to the current task. Current injection validity waits are bounded to 250 ms; unknown is represented explicitly and follows the existing fail-open policy.

Feedback verdicts are useful/outdated/incorrect/irrelevant/uncertain with observed revision, evidence, optional session, and time. Current history is bounded to eight entries. Same-revision factual challenges are not erased by later usefulness. Feedback does not automatically rewrite memory content or establish correctness.

Sources: [validity normalization](../../../packages/sage/src/shared/memory-validity.ts), [validity checks](../../../packages/sage/src/retrieval/validity-checks.ts), [feedback](../../../packages/sage/src/shared/model-feedback.ts).

Memory Companion is a host-owned read-only reviewer. Current inspected constants are one active worker, pending cap 32, tracked session cap 16, and probe ceiling 640 per session. Older notes describe smaller limits and must not be used as current implementation facts. Evidence reports carry revision/source information and remain advisory; this plan does not move an unrestricted autonomous agent into the daemon.

Source: [current Companion](../../../packages/fleet/src/host-memory-companion.ts).

## 10. Hygiene, consolidation, and capture

Do not summarize current hygiene as "it only creates proposals." The implementation performs structural verification and may reactivate verification-stale records, consolidate exact duplicates, assert relationships, manage session expiry, and produce advisory review candidates. Default session retention is seven days unless configured otherwise; opt-in physical purge exists for eligible old tombstones. Permanent/critical/conditional records have distinct safeguards. All automatic destructive boundaries must be captured and tested before porting.

Daemon-owned maintenance has durable last-run scheduling and single-flight behavior; host teardown is not its only trigger. Host-side optional LLM triage/consolidation can produce proposals with revision-bound target/member information and hold/auto-accept policy. Explicitly preserve that policy rather than introducing unreviewed model-written facts.

Capture paths include optional tool outcomes/error patterns, domain-term extraction with a markdown mirror, and session-end commit extraction. They require host events; MCP alone cannot observe all activity in another coding tool.

Sources: [hygiene](../../../packages/sage/src/sqlite-store-hygiene.ts), [daemon maintenance](../../../packages/sage/src/project-server-hygiene.ts), [consolidation](../../../packages/sage/src/consolidation/run.ts), [auto acceptance](../../../packages/sage/src/consolidation/auto-accept.ts), [outcome capture](../../../packages/sage/src/middleware/outcome-capture.ts), [domain terms](../../../packages/sage/src/domain-term-extractor.ts).

## 11. Existing MCP modes and client setup

| Mode | Current behavior |
|---|---|
| Standalone `wstack-sage-mcp` | Can lazily connect/start the existing project daemon; read-only default; writable mode exposes policy-allowed mutations |
| Attached `wstack sage mcp --origin ...` | Never starts the SAGE daemon; serves while an owner exists; read + propose policy; releases idle connection after 30 seconds |
| `wstack sage connect` | Plans/edits managed MCP config and an agent guidance skill/rule for Claude Code, Codex, Cursor, Antigravity; preserves unrelated entries |

Tool generation comes from current SAGE tool factories. Their live source includes search explanations and batch gather, so older README tool counts/allowlists are not a complete current inventory. Policy and executable tool schemas are authoritative.

MCP client-side confirmation is not a server-enforced permission guarantee. The new daemon must enforce grants independently of whether a client displays a confirmation. Caller origin labels are provenance labels, not authentication.

Sources: [adapter](../../../packages/sage-mcp/src/adapter.ts), [policy](../../../packages/sage-mcp/src/policy.ts), [attached server](../../../packages/sage-mcp/src/attached-server.ts), [tool factory](../../../packages/sage/src/tools/memory-tools.ts), [client setup planner](../../../packages/cli/src/sage-connect.ts).

## 12. Evidence and implementation implications

| Finding | WrongMemory implication |
|---|---|
| More DDL exists than the main schema file alone | Snapshot helper/HQ/text-index triggers and tables too |
| Worktrees share memory while indexes differ | Separate project namespace, store identity, and checkout evidence |
| Host owns injection/session tracker/provider fusion | Define split ownership explicitly before moving responsibilities |
| Session ownership currently travels through multiple APIs | New service binds identity centrally; no untrusted includeAllSessions bypass |
| Knowledge contains review/validity/feedback state | Migration is preservation of durable data, not regeneration |
| External attached MCP depends on WrongStack availability | New bridges must independently start/connect to the global service |
| Existing docs contain stale setup commands/limits | Refresh from manifests/source; do not copy historical pnpm/Node commands |
| Memory/graph changes feed vector and HQ consumers | Preserve events/change-feed behavior and prevent mirror loops |

Relevant existing test families include session isolation, validity gates, revision feedback, Unicode search, candidate reconciliation, corrupt-row handling, FTS trigger behavior, counter merge, HQ sync, daemon event auth/write caps/shutdown, and attached MCP lifecycle. M0 must execute/export the applicable suites against a frozen baseline. No green result is inferred from their filenames.
