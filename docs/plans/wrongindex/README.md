# WrongIndex implementation program

Status: proposed implementation plan; no WrongIndex service has been implemented.

Planning date: 2026-11-01. Intended owner: WrongIndex maintainers, with the WrongStack index maintainers owning integration approval. Implementation owners are not yet assigned.

This package is intended to move into a separate `WrongIndex` repository when implementation starts. Until then it lives in WrongStack so its compatibility decisions can be reviewed beside the current producer and consumers. The suggested future directory is `D:\Codebox\PROJECTS\WrongIndex`; creating it is a later task.

## 1. Product decision

Build a local, persistent codebase indexing service with a Rust engine, a command-line client, and a separate desktop GUI. One daemon per OS user manages all registered projects. Each checkout retains its own WrongStack-compatible SQLite index. WrongStack CLI, WebUI, desktop, and MCP integrations connect as clients.

The product must answer three questions reliably:

1. Which projects are being watched, and why?
2. How current is each project's index, and what is preventing it from becoming current?
3. Can WrongStack use the same database and obtain the same search and graph behavior?

The principal deliverable is a working service and desktop application, not merely a fast parser or a tray icon around the existing project daemons.

## 2. Read this package in order

| Document | Purpose |
|---|---|
| [Architecture](architecture.md) | Process model, project identity, lifecycle, scheduling, IPC, failure handling, security, and repository structure |
| [Compatibility](compatibility.md) | Exact storage inventory, parser and query parity, ownership transfer, cache coherence, and WrongStack integration |
| [Indexing pipeline](indexing-pipeline.md) | Watch registration, discovery, event reduction, parsing, transactional publication, reconciliation, and enrichment |
| [Desktop and operations](desktop-and-operations.md) | Screens, interactions, CLI, configuration, observability, install/update/uninstall behavior |
| [Delivery backlog](delivery-backlog.md) | Ordered milestones, task IDs, dependencies, exit criteria, estimates, and initial implementation handoff |
| [Validation](validation.md) | Requirement-to-test matrix, compatibility fixtures, fault injection, benchmarks, CI, and release evidence |

## 3. Scope and completion levels

### 3.1 Required product scope

- Single per-user daemon, surviving GUI and WrongStack client exits.
- Windows as the first supported release platform; explicit portability boundaries for Linux and macOS.
- Concurrent management of multiple projects without a separate project daemon for every project in the final native release.
- Automatic registration from WrongStack and manual registration from the GUI/CLI.
- Session-scoped, pinned, manual, and disabled watch policies.
- Existing WrongStack `index.db` locations and database semantics preserved.
- Debounced incremental updates, content-based skipping, deletion/rename handling, and recovery from missed events.
- Bounded CPU, memory, parser concurrency, queues, logs, and disk maintenance.
- Search, statistics, graph, incoming/outgoing call, context, and vector-query compatibility for the negotiated feature profile.
- GUI showing actual daemon state, freshness, progress, errors, and resource consumption.
- Authenticated local IPC; no network listener required for normal operation.
- Reversible migration, clear incompatible-client behavior, and an offline rollback path.
- Installable, diagnosable releases with downloaded-artifact smoke evidence.

### 3.2 Release levels

| Level | Name | What may be claimed |
|---|---|---|
| L0 | Contract baseline | Current WrongStack behavior captured in executable fixtures; no production daemon |
| L1 | Supervisor preview | Rust daemon, registry, watcher, CLI, GUI shell; existing engine may run as a supervised worker |
| L2 | Compatible preview | Supported WrongStack clients route through WrongIndex; same database and query behavior; legacy worker dependency disclosed |
| L3 | Native 1.0 | All languages and capabilities declared in the 1.0 profile run without the Bun indexing engine; single indexing daemon process |
| L4 | Additional platforms/features | Independently certified Linux/macOS, additional language profiles, optional enrichment providers |

The L1/L2 hybrid is a migration technique. It does not fulfill the final one-native-daemon objective. Native 1.0 must publish the complete language/capability profile; silently reducing the current supported language set is not an acceptable completion shortcut. Native Go/Python compiler helpers and other child processes must also be inventoried and removed or explicitly separated into a later, user-approved product profile before claiming a strictly single-process engine.

### 3.3 Deferred scope

- Cloud indexing, shared/team indexes, remote agents, multi-machine synchronization.
- Editing source files, Git actions, terminal management, or running project scripts from the GUI.
- New AI-provider credential management or automatic paid enrichment.
- A full code editor, IDE language server, or mandatory graph visualization canvas.
- A generic MCP tool redesign; existing WrongStack MCP behavior remains the integration reference.
- A system-wide privileged service account. The initial daemon runs as the signed-in user.

## 4. Non-negotiable invariants

| ID | Invariant |
|---|---|
| INV-01 | At most one authorized writer owns a resolved project index at a time. |
| INV-02 | Database commit precedes publication of a new usable generation. |
| INV-03 | Every response states enough generation/freshness information to detect an older cached result. |
| INV-04 | A failed or incomplete scan never treats unseen files as authoritative deletions. |
| INV-05 | Transient read/parse failures preserve the last good rows and remain visible as degraded freshness. |
| INV-06 | Event overflow, restart, wake, and watcher errors create reconciliation work; they never silently mark the index current. |
| INV-07 | Project identity includes the resolved index location and actual checkout, not only a shared repository ID. |
| INV-08 | Watcher, GUI, CLI, and WrongStack edit notifications converge on one project scheduler. |
| INV-09 | Unsupported schema/profile/client combinations are rejected before mutable database initialization. |
| INV-10 | Removing a project registration does not delete its source or existing index. |
| INV-11 | An unchanged targeted run does not publish a content generation or invalidate every query cache. |
| INV-12 | GUI lifecycle cannot accidentally kill the persistent daemon. |
| INV-13 | Unknown optional data is preserved or explicitly handled by a negotiated compatibility profile. |
| INV-14 | Old worker output cannot commit after a project is detached or ownership has changed. |

## 5. Core architectural decisions

| ADR | Decision | Rationale / revisit condition |
|---|---|---|
| WI-ADR-001 | Separate repository and release cadence | Independent installation and GUI; keep a versioned compatibility boundary with WrongStack |
| WI-ADR-002 | One daemon per user | Access matches project ownership; no elevation required for ordinary indexing |
| WI-ADR-003 | Actor-like project state plus bounded shared parser pool | Project isolation without one permanently busy thread per repository |
| WI-ADR-004 | One serialized writer lane per index | SQLite locking alone cannot enforce graph/cache/application ordering |
| WI-ADR-005 | Existing project index remains authoritative | Preserve WrongStack database reuse and avoid a second search database |
| WI-ADR-006 | Separate registry database | Service lifecycle and job bookkeeping do not alter the shared index schema |
| WI-ADR-007 | Named pipes on Windows; private Unix sockets later | Local authenticated transport without firewall/browser-origin complexity |
| WI-ADR-008 | Separate Tauri GUI process | Closing or crashing the WebView must not interrupt indexing |
| WI-ADR-009 | Explicit WrongStack adapter, new protocol namespace | Current per-project build-election behavior is unsuitable for an independently versioned global daemon |
| WI-ADR-010 | Hybrid migration before native cutover | Protect parser and graph correctness while Rust infrastructure stabilizes |
| WI-ADR-011 | Native replacement gated by differential tests | Tree-sitter adoption alone does not prove equivalent compiler-derived output |
| WI-ADR-012 | Freshness is tracked separately from activity | An idle process can still hold an incomplete or failed index |
| WI-ADR-013 | No repository-provided executable configuration | Indexing a project must not run its scripts, macros, plugins, or build commands |
| WI-ADR-014 | Benchmark targets are provisional until measured | Rust implementation does not itself prove lower latency or memory use |

These are proposed defaults for implementation, not records of already-shipped behavior.

## 6. Baseline inspected for this plan

Repository HEAD at inspection: `ad9f79dbc2aad903b0348e65abd7449273ec1a1c`. The checkout contains unrelated uncommitted work. Observations below describe the files read in that working tree, not an immutable certification of HEAD. Implementation must export a clean, checksummed baseline before creating compatibility fixtures.

| Concern | Current source |
|---|---|
| Path identity and checkout-specific storage | [wstack-paths.ts](../../../packages/persistence/src/wstack-paths.ts) |
| Index path overrides | [writer-helpers.ts](../../../packages/tools/src/codebase-index/writer-helpers.ts) |
| SQLite DDL | [writer-schema.ts](../../../packages/tools/src/codebase-index/writer-schema.ts) |
| Schema initialization and destructive mismatch behavior | [writer-init.ts](../../../packages/tools/src/codebase-index/writer-init.ts) |
| Schema version, symbol/ref shapes | [schema.ts](../../../packages/tools/src/codebase-index/schema.ts) |
| Pragmas | [writer-pragmas.ts](../../../packages/tools/src/codebase-index/writer-pragmas.ts) |
| Atomic updates | [writer-transactions.ts](../../../packages/tools/src/codebase-index/writer-transactions.ts) |
| Current daemon and event watcher | [project-server.ts](../../../packages/tools/src/codebase-index/project-server.ts), [project-server-watcher.ts](../../../packages/tools/src/codebase-index/project-server-watcher.ts) |
| Endpoint identity and build metadata | [project-server-endpoint.ts](../../../packages/tools/src/codebase-index/project-server-endpoint.ts) |
| Spawn and termination | [project-server-launch.ts](../../../packages/tools/src/codebase-index/project-server-launch.ts) |
| IPC request/response shapes | [worker-protocol.ts](../../../packages/tools/src/codebase-index/worker-protocol.ts), [project-server-protocol.ts](../../../packages/tools/src/codebase-index/project-server-protocol.ts) |
| Parser dispatch | [parser-dispatch.ts](../../../packages/tools/src/codebase-index/parser-dispatch.ts) |
| Incremental commit and finalization | [indexer-batch-commit.ts](../../../packages/tools/src/codebase-index/indexer-batch-commit.ts), [indexer-finalize.ts](../../../packages/tools/src/codebase-index/indexer-finalize.ts) |
| Startup, edits, external events | [CLI wiring](../../../packages/cli/src/wiring/codebase-index.ts) |
| Existing independent MCP entry | [MCP package](../../../packages/codebase-index-mcp/package.json) |

Observed details that override older architecture prose: `SCHEMA_VERSION` is 5; FTS uses `trigram`; current runtime loads SQLite through the runtime abstraction; linked Git worktrees receive separate index directories; reference binding and rank passes are already part of current finalization. The older refactor proposal's schema-4 snapshot is not the contract for WrongIndex.

## 7. Technology preflight

Live registry reads performed on 2026-11-01. These are planning candidates, not installed WrongIndex dependencies. Repeat before installation, confirm MSRV/target support, license, engine/peer constraints, and selected features; commit `Cargo.lock` and `bun.lock`. Do not upgrade WrongStack dependencies as a side effect.

| Component | Existing WrongStack declaration | Published stable candidate |
|---|---|---|
| Bun | `.bun-version`: 1.4.3 | Retain 1.4.3 for initial frontend tooling; recheck before bootstrap |
| Rust toolchain | Existing desktop uses edition 2021; not a WrongIndex toolchain pin | Select and pin a stable toolchain after MSRV checks |
| `notify` | Not declared in inspected desktop manifest | 8.2.1; 9.0.0-rc.7 excluded |
| `rusqlite` | Desktop pins 0.41.0 with bundled SQLite | 0.41.1 |
| `tauri` | Desktop pins 2.12.5 | 2.12.5; 3.0.0-alpha.5 excluded |
| `tokio` | Present transitively in desktop lockfile | 1.54.1 |
| `tree-sitter` Rust | JS runtime uses `web-tree-sitter` 0.27.1 | 0.27.1; grammar ABI compatibility requires separate verification |
| `ignore` | No WrongIndex manifest yet | 0.4.34; validate semantics against existing discovery |
| `xxhash-rust` | Existing index has its own xxHash64 implementation | 0.8.19; enable xxh64 and verify seed/output fixtures |
| `serde` | Desktop pins 1.0.229 | 1.0.229 |
| React / React DOM | Desktop 19.3.1 | 19.3.1 |
| Vite | Desktop 8.3.5 | 8.3.5 |
| TypeScript | Desktop ^7.0.2 | 7.0.2 |
| Vitest | Desktop 5.0.5 | 5.0.5 |
| Tauri JS API / CLI | Desktop 2.12.4 | 2.12.4 |
| Playwright | Tools ^1.64.1 | 1.64.1 |

Registry sources: [crates.io crate API](https://crates.io/api/v1/crates/notify), [rusqlite](https://crates.io/api/v1/crates/rusqlite), [Tauri](https://crates.io/api/v1/crates/tauri), [Tokio](https://crates.io/api/v1/crates/tokio), [tree-sitter](https://crates.io/api/v1/crates/tree-sitter), [ignore](https://crates.io/api/v1/crates/ignore), [xxhash-rust](https://crates.io/api/v1/crates/xxhash-rust), [serde](https://crates.io/api/v1/crates/serde), and the npm `/<package>/latest` endpoints for the listed frontend packages, including [React](https://registry.npmjs.org/react/latest), [Vite](https://registry.npmjs.org/vite/latest), [TypeScript](https://registry.npmjs.org/typescript/latest), [Vitest](https://registry.npmjs.org/vitest/latest), [Tauri API](https://registry.npmjs.org/@tauri-apps/api/latest), [Tauri CLI](https://registry.npmjs.org/@tauri-apps/cli/latest), [React DOM](https://registry.npmjs.org/react-dom/latest), and [Playwright](https://registry.npmjs.org/@playwright/test/latest).

Vite's declared Node engine is `^20.19.0 || >=22.12.0`; Vitest's is `^22.12.0 || ^24.0.0 || >=26.0.0`. Frontend scripts must be exercised under the chosen Bun runtime rather than assuming these declarations prove compatibility. Native Cargo tooling remains necessary for Rust builds; Bun is used for JS installation/scripts/tests.

Bundled SQLite version, compile options, FTS5/trigram availability, and relevant upstream SQLite fixes must be captured at bootstrap and release time. A Rust crate version is not sufficient evidence of SQLite compatibility.

## 8. Principal risks and planned responses

| Risk | Consequence | Response / gate |
|---|---|---|
| Legacy clients ignore the new writer owner | Semantic races, stale caches, or index rebuilds | Minimum supported WrongStack adapter; reject takeover if safe coexistence cannot be established |
| Schema version appears compatible but behavior differs | Incorrect calls/impact/search | Full structural and behavioral contract fixtures |
| Native parsers differ from compiler APIs | Missing symbols or incorrect ownership | Language-by-language differential gate, explicit fallback during preview |
| Watcher event loss or queue saturation | Silent stale index | Dirty marker, bounded queues, mandatory reconciliation |
| Long-lived readers retain WAL | Disk growth | Reader lifetimes, timeout/cancel, observed checkpoint policy |
| Large project consumes all parser slots | Other projects starve | Fair scheduling, quotas, interactive query priority |
| GUI closes the daemon through parent lifecycle | Background indexing stops | Separate lifecycle and installer process tests |
| Crash occurs after commit but before event publication | Clients miss a generation | Generation in the index transaction; reconnect snapshot reconciliation |
| Existing enrichment rows are erased by migration | Expensive data loss | Preservation fixtures; explicit optional feature contracts |
| Different checkout paths map to the same index | Cross-project contamination | Index identity collision rejection; WrongStack-resolved paths |
| Optional parser helper remains in native release | Single-process promise is unfulfilled | Process-tree acceptance and published backend inventory |
| Schedule assumes infrastructure is the difficult part | Native parity work underestimated | Separate estimates and exit gates for each language family |

## 9. Decisions to validate during implementation

The plan supplies defaults so initial work can start without a design questionnaire. Resolve these through bounded spikes and write the result as ADR updates:

1. Exact Rust toolchain/MSRV and supported Windows versions: validate selected dependencies and installer targets.
2. First preview language corpus: use WrongStack's own TS/JS-heavy tree plus Go, Python, Rust, configuration, and tree-sitter fixtures.
3. Native Go/Python/Rust semantic strategy: demonstrate parity before committing to grammar-only replacement.
4. Large full-run publication: benchmark bounded parse staging followed by one publish transaction; retain old generation on failure.
5. Existing optional enrichment: preserve stored data and mark stale according to current rules; new provider execution is opt-in.
6. Installer format/signing: select based on the actual release infrastructure; unsigned internal builds must be labeled.
7. Licensing of reused WrongStack implementation: review attribution and distribution obligations before extraction.

## 10. Definition of program completion

Native 1.0 is complete only when the declared compatibility profile passes the full validation matrix, the supported WrongStack clients use the existing indexes through WrongIndex, the GUI manages real background work, the packaged daemon survives the relevant failure/restart cases, and actual downloaded artifacts pass Windows smoke tests. A source build, GUI screenshot, green unit suite, or published tag alone is insufficient.

No implementation tests or performance benchmarks were run while writing this plan. Numerical budgets elsewhere in this package are proposed acceptance targets, not measured results.
