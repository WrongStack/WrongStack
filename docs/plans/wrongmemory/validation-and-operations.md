# Validation, operations, and release acceptance

Status: proposed checks. No WrongMemory implementation suite has run for this planning task.

## 1. Test strategy

Use Rust unit/integration tests for storage/policy/service, shared JSON fixtures for Rust/TypeScript DTO parity, the captured WrongStack oracle for behavior, real MCP clients/transports for conformance, and installed binaries for lifecycle/release proof. Mock time/provider/network boundaries where justified; do not mock the store, visibility layer, or IPC being certified.

Temporary fixtures have unique data roots, stores, endpoints, sessions, and project IDs. All waits/timeouts/cancellations are bounded. Race scenarios use barriers/fault hooks; real sleeps do not establish ordering. Existing regression tests must fail for the intended assertion before being accepted as guards.

Proposed future commands:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:contracts
bun run test:differential
bun run test:integration
bun run test:mcp
bun run test:clients
bun run test:fault
bun run bench:acceptance
bun run release:check
```

These scripts must be implemented before use and fail when a required suite selects zero tests. WrongStack changes use its own Bun scripts/package gates, not a substituted runner. Optional GUI/native platform checks become required only for the platforms/features claimed by that release.

## 2. Functional and isolation matrix

| Requirement | Scenario | Required observable result |
|---|---|---|
| Singleton | Ten clients start concurrently | One normal daemon; all attach to elected instance |
| Many projects | Three projects, two clients each | Independent stores/queues, no per-project native engine |
| Existing data | Adopt current fixture SAGE store | Same path and records, graph/candidates/provenance retained |
| Managed data | New external-only project then WrongStack attach | One visible store descriptor; no hidden empty local store |
| Worktrees | Two branches share SAGE but have different sources | Shared knowledge, checkout-labeled evidence, no false global invalidation |
| Project grants | Substitute project ID/root/store path | Denied before read/count/mutation |
| Session isolation | Copy another session's ID | No read/graph/counter/vector/candidate disclosure |
| WebUI policy | Search/exact-ID resolve owned and unowned session rows | All session rows hidden in ordinary discovery |
| Audience | Change claimed role/mode in untrusted request | No widening of authorization; applicability handled separately |
| Exact-ID privacy | Query hidden vs absent ID | Indistinguishable authorized response/error shape |
| Counts/cursors | Filter hidden rows and replay cursor elsewhere | Counts do not disclose them; mismatched cursor rejected |
| Graph privacy | Reach hidden node through visible neighbor | No hidden content/IDs/bridge expansion |
| Vector privacy | Return stale/hidden/foreign project semantic hit | Authoritative materialization drops it before disclosure |
| Candidate policy | Read-propose client sends accept/resolve/delete | Server refuses even if schema/action is forged |
| Source provenance | Model claims source=user or origin=trusted client | Attributed claim only; no privilege upgrade |
| Revision CAS | Two clients update same revision | One valid commit, second conflict |
| Feedback | Incorrect challenge then useful verdict on same revision | Challenge remains; no automatic content/lifecycle rewrite |
| Counters | Duplicate retry and counter-only update | Exactly admitted telemetry effect; recency/FTS/HQ unchanged |
| Deletion | Without force/destructive grant; then authorized tombstone | Denied first; atomic revision/history/edge cleanup second |
| Recovery | Backfill then ordinary recover | One active successor; tombstone history preserved |
| Unknown schema | Open newer/divergent store | No mutable init or destructive downgrade |
| Corrupt row | Malformed JSON beside valid memory | Valid siblings remain usable; corruption reported |
| Validity | Satisfied/missing literal/unreadable source | Correct evidence labels; no unsupported truth claim |
| Conditional duplicates | Same text, different conditions | No silent merge |
| Maintenance | Restart due schedule and concurrent hosts | One effective scheduled pass; durable last-run/options |
| Session retention | Expire eligible session records | Baseline configured tombstone policy; private contents not disclosed |
| Semantic outage | Fail embedding backend | Automatic recall lexical/degraded; explicit semantic call error |
| Revocation | Revoke grant with live cache/subscription | Future reads/writes/events denied; no cached leakage |
| MCP independence | Stop every WrongStack host | External bridge starts/connects; recall/propose still works |
| Client exit | Close bridge stdin or GUI | Bridge exits; daemon/other projects continue |
| Safe fallback | Disconnect daemon during host mutation | Receipt recovery; no inline competing writer |
| HQ | Counter/stamp-only change then semantic change | No sync storm; actual shared content/tombstone projection preserved |

## 3. Differential fixtures

Capture both independent-store equivalence and in-place interoperability:

1. Materialize controlled source/worktree/session fixtures.
2. Build an initial store through captured SAGE APIs.
3. Copy it consistently and replay identical operations through WrongMemory.
4. Compare canonical JSON, denormalized fields, Unicode text, graph weights/relationships, candidate states, tombstones, audit categories, and HQ projections.
5. Query through supported host/MCP surfaces, preserving ordering/cursor/error/visibility behavior.
6. Apply races, corruption, restart, maintenance, and provider failures.
7. Reopen through a supported legacy reader/owner after release to prove actual reverse compatibility.

Normalize only noncontractual nondeterminism such as independent ULID/time allocation and random sync IDs. Do not normalize away revisions, malformed data handling, scope/owner, edge direction, NULL/empty distinctions, condition fields, or query order. Raw SQLite page equality is unnecessary; semantic/DDL/consumer compatibility is required.

Corpus must cover all 20 kinds, five scopes, six states, persistence classes, contextPolicy, all anchor/relationship types, audience/session combinations, conditional validity, Unicode NFKC/astral/CRLF/BOM cases, duplicate/review/conflict cases, staleReason, expiry/purge, old/current/unknown profiles, legacy JSONL, FTS absence/backfill, and corrupt siblings.

## 4. Protocol and client matrix

Record client name/version, OS, MCP revision/era, stdio/HTTP, discovery/initialize behavior, allowed tools, schema/result fidelity, denied operations, cancellation, reconnect, bridge EOF, and independent daemon activation.

Required initial installed-client evidence: Claude Code, Codex, Cursor, and whichever Antigravity version the preset claims. If a client/version is unavailable, mark NOT RUN and retain generic configuration support without claiming named certification. Extra clients enter the supported list only after their own probes.

MCP conformance includes newline framing/Unicode, stdout cleanliness, malformed/oversized frames, cancellation, request ID correlation, error semantics, protocol mismatch, modern per-request metadata and legacy initialization where negotiated. HTTP adds Origin/auth/Host/stream bounds and revision-specific behavior. Tool inventory must be deterministic for an authorization profile and match runtime policy enforcement.

Managed config tests: preserves unrelated servers, handles JSON/TOML comments where supported, rejects malformed input, has idempotent add/remove, detects concurrent modifications, resolves executable paths with spaces, stores no secrets in committed config, and removes only owned guidance blocks.

## 5. Fault injection

Required controlled boundaries:

- Before/after durable mutation admission.
- Between revision read and publication under writer scheduling.
- During multi-table memory/edge/candidate transaction.
- After commit before reply or registry update.
- During outbox publication/reconnect snapshot.
- After ownership drain intent before release/new activation.
- During backup/migration/update install.
- During cancellation racing commit.
- During grant revocation racing event delivery.
- During session expiry racing recovery/update.
- During source replacement/symlink change and worktree remap.

Assert no partial authoritative state, duplicate accepted memory, double usage credit, wrong-principal event, or stale-owner commit. Store receipts/outbox are authoritative when registry bookkeeping lags. Keep primary SQLITE_FULL/IOERR errors rather than masking them with failed rollback messages. Repeat timing-sensitive acceptance runs at least five times in addition to deterministic synchronization.

## 6. Quality evaluation

Create a held-out task corpus with ground-truth required memories, applicable conditions, authorized session/project, and hard negative memories. Evaluate lexical-only and semantic-enabled modes separately.

Metrics: relevant fact recall, precision within a fixed context budget, missed critical conventions, wrong-project/session leakage (zero tolerance), stale/contradicted injection rate, conditional applicability errors, duplicate tokens, total schema/hint tokens, and measured task outcomes where reproducible.

Do not train/tune thresholds on the same cases reported as held-out quality. Do not interpret high `useCount`, positive model feedback, or a single Companion demo as task-success proof. Automatic injection quality and interactive user search have distinct evaluation targets.

## 7. Performance program

Proposed reference machine: Windows x64, local SSD, 8 logical CPUs, 16 GiB RAM. Record antivirus, filesystem, power mode, runtimes, provider/model, and source/profile hashes. Baseline numbers must be measured in M0.

| Corpus | Shape |
|---|---|
| S | 1,000 memories, mixed anchors/kinds and moderate graph |
| M | 25,000 memories with candidates/history/graph relationships |
| L | 100,000 memories; bounded high-degree graph and pagination stress |
| Multi | Ten registered projects, three active, many client sessions |
| Semantic | Matching SAGE corpus, fixed provider/dimensions/model revision |

Initial proposed targets, not measurements:

| Measurement | Target |
|---|---|
| Idle daemon CPU | <1% average over five minutes on reference idle workload |
| Ten attached project RSS | <=150 MiB lexical-only target, excluding GUI/model and OS cache |
| Warm bounded lexical recall, M | p95 <=50 ms, p99 <=150 ms including local IPC |
| Warm bounded path/graph recall | p95 <=100 ms for fixed traversal/query set |
| Bounded create/update/propose | p95 <=100 ms absent fsync/storage contention; report workload |
| Noisy neighbor | Small interactive query p95 <=200 ms beside one maintenance job |
| Literal evidence | Existing 250 ms automatic wait boundary; unknown on bounded failure |
| Semantic overhead | Separate cold model load, warm inference, retrieval, fusion, and total memory figures |
| Soak | Initial 24-hour mixed workload; handle/thread/cache growth plateaus |

Measure at least five comparable short runs and report distributions. Cold/warm and lexical/semantic cannot be mixed to invent a speedup. Export migration/backup/large hygiene durations and maximum lock/query stall separately. If targets are unrealistic, update them explicitly with evidence before release instead of silently lowering the gate.

## 8. CLI and configuration operations

Proposed commands:

```text
wrongmemory daemon start|status|stop|restart
wrongmemory project add|list|show|detach
wrongmemory search <project-id> <query> [--json]
wrongmemory candidates list <project-id>
wrongmemory doctor [--project <id>] [--json]
wrongmemory backup <project-id> --output <path>
wrongmemory migrate inspect|plan|apply <project-id>
wrongmemory ownership release <project-id>
wrongmemory jobs list|show|cancel
wrongmemory maintenance status|run <project-id>
wrongmemory connect|disconnect|grants ...
wrongmemory diagnostics export --output <path>
wrongmemory autostart enable|disable|status
```

Read-only doctor/migration inspect by default. Mutating apply/repair/restore operations are explicitly named and report their scope. JSON output excludes log noise; stderr carries diagnostics. Exit codes distinguish denied/conflict/unavailable/unsupported/failed/timeout. Canceling a wait is distinct from canceling a committed durable mutation.

Configuration groups: startup/data root, resource budgets, IPC/optional HTTP, project defaults, grants, maintenance retention, evidence budgets, semantic provider, diagnostics/privacy, and update channel. Project policy comes through the daemon with revision acknowledgments; last writer does not silently override operator security/retention policy. Changing active data root requires a controlled migration/restart.

## 9. Observability and privacy

Structured logs: timestamp, instance/project/workspace IDs, principal label, request/job/run ID, operation, duration, error code, memory ID/revision when appropriate, generation, and retry. Never log tokens, full source excerpts, raw transcripts, complete memory text, provider keys, or environment dumps by default.

Metrics: active/hot stores, clients/bridges, request latency, queue wait, mutation/receipt replay count, revision conflict rate, denied requests, authorized recall channels, semantic failures/staleness, candidate backlog, maintenance outcomes, WAL/backup/cache/log bytes, and process RSS/CPU/handles/threads. Paths/memory text are not metric labels.

Diagnostics exports are bounded/redacted with included-category preview. Plain SQLite and backups are not encrypted merely because file permissions are restrictive. Do not claim encryption at rest by default. Optional encryption/key management requires a separate compatible design, including old-reader/backup consequences. No telemetry, provider upload, or cross-project sharing by default.

## 10. Optional desktop management

Planned after core release: Overview, Projects/Workspaces, Memory Library, Review Queue, Graph/Evidence, Clients/Grants, Maintenance, Diagnostics, and Settings.

Display actual store/backend/profile, current revision/source evidence, proposal provenance/diff/target revision, pending factual challenges, session visibility policy, semantic provider state, and job outcomes. Operator inspection and automatic context eligibility are distinct labels.

Actions: search/filter, review/accept/reject with conflicts, revision-bound edit, explicit retire/recover, backup/inspect migration, grant/revoke, schedule/disable maintenance, and connect-client dry-run. No unrestricted SQL/shell/file bridge in the WebView. Close/quit GUI does not stop daemon; stopping the service is a separate explicit action.

Accessibility: keyboard/screen-reader support, clear focus, contrast/text state labels, reduced motion, high DPI, long paths/text, and connecting/stopped/degraded/conflict/empty states. Native lifecycle proof is required if the GUI is distributed.

## 11. Install, update, and uninstall

Windows x64 per-user package first. Include native daemon/CLI, versioned profiles, licenses, and optional model/GUI assets separately. Native core must run without a developer checkout, Bun, or Node. Optional start-at-login is distinct from opening the GUI or enabling project capture.

Update: download/verify -> check client/data profile -> drain admission -> commit/flush -> stop -> replace binaries safely -> start/recover -> reconnect. Keep compatible binary rollback separately from data rollback; old binaries may not understand new registry/store extensions. Do not blindly restore an old knowledge backup and discard newer valid memories.

Uninstall: stop/drain/release owners, remove owned autostart and binaries, preserve memories/project sources by default, offer explicit owned config/grant cleanup, and keep diagnostics/config unless user selects removal. Removal of WrongMemory data must be constrained to its verified data root and must not delete adopted project SAGE stores.

## 12. Required runbooks

Ship diagnosis/recovery instructions for: daemon startup failure, incompatible profile/client, owner conflict, duplicate store discovery, revoked credential, session hidden by policy, missing worktree source, parse/corrupt memory row, FTS repair, semantic provider unavailable, stale vector mirror, stalled candidate, revision conflict, maintenance backlog, WAL growth, disk full, interrupted migration/update, backup/restore, service release, disconnect, and uninstall.

Start runbooks with read-only diagnosis and show which exact next operation mutates data. "Delete sage.db and retry" is not an acceptable generic remedy for durable knowledge.

## 13. Release evidence matrix

| Gate | Required evidence |
|---|---|
| Source/profile identity | Exact release commit/tag, schema/semantic/MCP profile hashes |
| Build | Locked dependencies/toolchain/SQLite features and licensed assets |
| Compatibility | Full current SAGE record/read/write/lifecycle/host/HQ profile |
| Isolation | Project/session/principal/graph/vector/count/event matrix |
| WrongStack integration | Real anchored recall, capture/review/maintenance, no competing owner |
| MCP | Actual named clients, protocol modes, denied actions, WrongStack-closed operation |
| Resilience | Crash/receipt/revocation/owner/disk/source failure tests |
| Quality/performance | Held-out recall results, reproducible benchmarks, soak |
| Packaging | Fresh install/autostart/update/rollback/uninstall |
| Artifacts | Checksums/signing status/provenance and downloaded native smoke |
| Live proof | Same existing SAGE store used by supported WrongStack and external client |
| Documentation | Exercised command/config/migration/recovery instructions |

Never replace a required NOT RUN with an assumption. A tag/assets/green unit test suite alone is not native product release proof.

## 14. Concrete final demonstration

1. Install WrongMemory and a supported WrongStack build from downloaded artifacts.
2. Adopt project A's selected SAGE store safely; show existing records/graph/review queue.
3. Connect two independent coding clients to A and a third to project B with read/propose grants.
4. Stop WrongStack; prove recall and a new pending proposal still work through MCP.
5. Reopen WrongStack; review/accept the proposal; query accepted revision from the external client.
6. Create a session-private fixture via trusted host; prove external/WebUI/other-session paths cannot disclose it.
7. Change source conditions/rename an anchor in a linked worktree; inspect checkout-bound evidence without globally deleting knowledge.
8. Warm lexical/vector/graph caches; retire a memory and prove stale derived data cannot return it as eligible.
9. Crash after a committed mutation before reply; retry and obtain the original result with no duplicate.
10. Revoke one client's grant and verify events/caches/calls stop while other clients continue.
11. Inspect process tree: one memory daemon; lightweight bridges disclosed; no required legacy engine.
12. Perform supported ownership release/rollback and verify intended local data access/location.

Save artifact/profile IDs, paths, revisions, receipts, queries, exit codes, timings, and redacted logs. Keep private knowledge out of publicly shared demonstration bundles.

## 15. Planning-task validation boundary

Only Markdown structure, local links, task IDs, source references, and whitespace are checked now. WrongMemory runtime, migrations, client configuration changes, performance, installed artifacts, and live interoperability remain NOT RUN because implementation has not started.
