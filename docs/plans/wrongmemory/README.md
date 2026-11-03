# WrongMemory implementation program

Status: proposed standalone project; no WrongMemory daemon or adapter is implemented by this plan.

Planning date: 2026-11-01. Intended ownership: WrongMemory maintainers own the service; WrongStack maintainers own the SAGE integration contract. Individual implementation owners are unassigned.

The plan lives in `docs/plans/wrongmemory/` for review beside SAGE. A future implementation can start in a separate `D:\Codebox\PROJECTS\WrongMemory` repository. This task creates documentation only; it does not create that project, migrate memories, install a daemon, or change coding-tool configuration.

## 1. Product objective

Create a Rust memory service that preserves SAGE's structured knowledge, anchors, relationships, retrieval rules, review workflow, and provenance while making them available independently of WrongStack. One persistent memory daemon manages many local projects. WrongStack connects through a native service adapter; external coding tools connect through MCP.

The service must remain useful with WrongStack closed. An external client can recall project knowledge, inspect its provenance, propose new knowledge, and, when granted an explicit write capability, update it. A Rust rewrite is not permission to reduce SAGE to a vector database or a folder of summaries.

The normal desktop deployment has one daemon for the signed-in OS user. Multiple coding tools and projects share it. Multiple OS users retain separate daemons/data permissions; one privileged machine-global service is deferred. This is the concrete interpretation of "one daemon per machine" for the initial single-user development machine.

WrongMemory and [WrongIndex](../wrongindex/README.md) are separate services. The target is one memory daemon and one index daemon, not one combined process. Their optional integration uses explicit events and capability negotiation; neither must be installed for the other to work.

## 2. Read this package in order

| Document | Purpose |
|---|---|
| [SAGE system research](sage-system-research.md) | Current architecture, real schemas, retrieval, lifecycle, MCP modes, host wiring, and source evidence |
| [Architecture and storage](architecture-and-storage.md) | Rust process/crate model, identity, per-project databases, ownership, IPC, scheduling, and migrations |
| [Retrieval and lifecycle](retrieval-and-lifecycle.md) | Recall policy, vectors, graph, verification, revisions, feedback, candidates, hygiene, and learning boundaries |
| [MCP and client integration](mcp-and-client-integration.md) | Transport compatibility, external-tool setup, grants, tool schemas, configuration editing, and usage workflow |
| [WrongStack integration](wrongstack-integration.md) | MemoryPort adapter, exact source changes, injection/capture preservation, rollout, and rollback |
| [Delivery backlog](delivery-backlog.md) | Ordered tasks, dependencies, milestones, estimates, and separate-project kickoff |
| [Validation and operations](validation-and-operations.md) | Acceptance matrix, isolation/fault tests, metrics, benchmarks, install/update/recovery, and release proof |

## 3. Required scope

- Rust headless daemon with persistent per-user lifecycle and many project registrations.
- Reuse existing SAGE SQLite stores in place after compatibility/ownership admission.
- Preserve all current memory kinds, scopes, lifecycle states, anchors, audience metadata, validity, feedback, graph, candidates, recovery, and required synchronization contracts.
- Project isolation across every read, exact-ID lookup, graph hop, vector hit, event, count, cursor, mutation, and administrative action.
- MCP stdio support through lightweight client-owned bridges; optional loopback HTTP hosted by the same daemon.
- Native WrongStack adapter exposing its existing memory capabilities without unsafe competing SQLite access.
- Read/propose default for configured external agents; direct write and curation require explicit grants.
- Independently working lexical retrieval; optional semantic retrieval with explicit provider/model provenance.
- Background maintenance, anchor verification, and durable review jobs without depending on a host's teardown.
- Local CLI, diagnostics, project/review management, and documented external client onboarding.
- Windows-first installed-artifact proof; portable core with later independently certified Linux/macOS packages.
- Backups, migration rollback, idempotent writes, reconnect recovery, bounded resources, and clear degraded states.

## 4. Explicit boundaries

- MCP-compatible tools can connect; unsupported clients require an adapter. Do not claim universal integration without client/version evidence.
- MCP makes memory tools available. It cannot force an agent to call them, read another tool's private chat history, or guarantee automatic context injection.
- Optional rules/skills/hooks improve recall behavior, but each is tested and disclosed separately from transport connectivity.
- Existing `scope=user` records remain project-local. Global preference sharing is a later explicit namespace with consent, filtering, and provenance.
- No automatic scraping of private transcripts, credentials, editor state, or every repository on the machine.
- No shell execution for validity checks, command anchors, or project-provided memory instructions.
- No remote/cloud access or synchronization by default. Existing HQ integration is preserved through its supported adapter, not exposed to arbitrary MCP clients.
- Standalone GUI/tray management is a planned product increment; the user's core daemon/MCP/WrongStack objective must not depend on the GUI running.

## 5. Completion levels

| Level | Deliverable | Permitted claim |
|---|---|---|
| L0 | Immutable SAGE contract/oracle and real fixtures | Researched specification; no new service |
| L1 | Rust supervisor/registry/IPC plus bounded compatibility backend | Multi-project preview; legacy backend dependency disclosed |
| L2 | Independent MCP and WrongStack adapter over adopted fixture stores | Compatible service preview; source/runtime limitations explicit |
| L3 | Rust storage/retrieval/lifecycle and native integration certified | Native WrongMemory 1.0 for the declared full SAGE profile |
| L4 | GUI, semantic acceleration, additional clients/platforms | Individually tested optional increments |

The final native daemon must not require Bun/Node or one SAGE project-server process per project. A stdio bridge process per external client is a transport shim, not another SQLite owner or memory daemon. Local model inference may use native threads; an optional external embedding/model endpoint is an additional dependency and must not be described as a self-contained one-process inference engine.

## 6. Invariants

| ID | Required invariant |
|---|---|
| WM-INV-01 | One authorized mutable owner per resolved SAGE store. |
| WM-INV-02 | Every request is bound to a granted project set and authenticated principal. |
| WM-INV-03 | Client-supplied project/session/role strings never grant access. |
| WM-INV-04 | SAGE rows are authoritative; vectors and GUI caches never become a second truth store. |
| WM-INV-05 | Atomic memory/edge/candidate changes commit before events or success replies. |
| WM-INV-06 | Retrying an admitted mutation cannot create duplicate memories, approvals, counters, or tombstones. |
| WM-INV-07 | Revision conflicts are detected inside the serialized mutation, not after it. |
| WM-INV-08 | Retrieval visibility is enforced before ranking, pagination, count, or graph expansion can disclose hidden data. |
| WM-INV-09 | Applicability, factual truth, structural verification, usage, and task success remain separate signals. |
| WM-INV-10 | Model feedback is attributed and revision-bound, not automatic truth or permission. |
| WM-INV-11 | Temporary tool/session progress is not silently promoted into durable project knowledge. |
| WM-INV-12 | GUI/client shutdown releases its own lease; it does not stop the global daemon. |
| WM-INV-13 | Unknown/newer storage profiles are inspected without mutable initialization. |
| WM-INV-14 | Worktree-shared memory identity is distinct from checkout-specific evidence identity. |
| WM-INV-15 | Rebuildable semantic caches may be invalidated; irreplaceable knowledge is never treated as a disposable code index. |
| WM-INV-16 | Rejected/revoked clients cannot receive future events or cached replies. |

## 7. Baseline and evidence boundary

Inspected WrongStack HEAD: `ad9f79dbc2aad903b0348e65abd7449273ec1a1c`. The checkout contains unrelated dirty work, including the separate WrongIndex plan. Source observations describe files read in this working tree, not a clean release certification. Capture an immutable source manifest and fixture database set in M0 before porting behavior.

Current source findings and known documentation drift are detailed in [the research report](sage-system-research.md). No private live memory database was opened or exported for this planning task. Existing test files were inspected as contract evidence; their presence is not a claim that they passed during this task.

## 8. Dependency preflight

Local manifests inspected: `packages/sage/package.json`, `packages/sage-mcp/package.json`, `packages/mcp/package.json`, `packages/vector-memory/package.json`, and the existing desktop Rust manifest from the preceding WrongIndex investigation. SAGE currently uses WrongStack's SQLite abstraction and custom MCP package; it does not declare the proposed Rust crates.

Live crate registry snapshot read on 2026-11-01:

| Candidate | Published stable | Decision |
|---|---|---|
| `rmcp` | 3.8.0 | Official Rust MCP SDK candidate; verify exact protocol-era support before pinning |
| `rusqlite` | 0.41.1 | Bundled SQLite candidate; test FTS/JSON/backup capabilities and upstream fixes |
| `tokio` | 1.54.1 | Async scheduling/IPC; SQLite work stays on bounded blocking lanes |
| `serde` | 1.0.229 | DTOs with unknown-field preservation strategy |
| `notify` | 8.2.1 | Optional anchor watch invalidation; exclude 9.0.0-rc.7 |
| `ulid` | 3.0.0 | Preserve current ULID representation; confirm behavioral compatibility |
| `unicode-normalization` | 0.1.26 | NFKC parity; case mapping still requires separate fixture checks |
| `tauri` | 2.12.5 | Optional management GUI; exclude 3.0.0-alpha.5 |

Sources: [rmcp](https://crates.io/api/v1/crates/rmcp), [rusqlite](https://crates.io/api/v1/crates/rusqlite), [Tokio](https://crates.io/api/v1/crates/tokio), [serde](https://crates.io/api/v1/crates/serde), [notify](https://crates.io/api/v1/crates/notify), [ULID](https://crates.io/api/v1/crates/ulid), [Unicode normalization](https://crates.io/api/v1/crates/unicode-normalization), [Tauri](https://crates.io/api/v1/crates/tauri).

The [official Rust SDK](https://github.com/modelcontextprotocol/rust-sdk) is preferred over hand-written MCP framing/negotiation. A published SDK version alone does not prove support for every target client or the latest protocol revision. Pin stable releases after checking MSRV, features, transitive native libraries, licensing, and conformance. Do not install from an unpinned main branch for a release.

Rust toolchain, inference runtime/model, and optional GUI frontend versions are selected during dedicated preflight spikes, not guessed here. Bun remains the JS/TS package and script runtime for the adapter/oracle/frontend. Commit Cargo/Bun lockfiles and toolchain pins. No WrongStack dependency changes are part of this plan.

## 9. Principal design decisions

| ADR | Proposed decision |
|---|---|
| WM-ADR-001 | Separate repository and independently versioned application/protocol/storage/semantic profiles |
| WM-ADR-002 | One per-user daemon with per-project store actors and bounded connection retention |
| WM-ADR-003 | Existing SAGE databases stay authoritative; separate service registry |
| WM-ADR-004 | Native authenticated IPC for WrongStack; MCP gateways reuse the same service methods |
| WM-ADR-005 | Default external mode is read/propose; no daemon master credential in model-facing config |
| WM-ADR-006 | Fixed project binding for ordinary MCP connections; no mutable "current project" shared by clients |
| WM-ADR-007 | Preserve SAGE session/audience/validity/lifecycle semantics through executable parity tests |
| WM-ADR-008 | Move optional semantic recall behind a service-owned provider boundary; prevent double host fusion |
| WM-ADR-009 | Keep WrongStack's injection/rendering and session context monitoring in the host initially |
| WM-ADR-010 | Global preferences require a separate later namespace; never reinterpret local user scope |
| WM-ADR-011 | Separate WrongIndex identity/event adapter; shared worktrees do not imply shared checkout evidence |
| WM-ADR-012 | Maintenance uses durable schedules and per-project jobs with revision revalidation |
| WM-ADR-013 | Full native migration is distinct from a supervised legacy preview |

## 10. Program completion

The program is complete when the full negotiated SAGE profile works through a native Rust daemon across multiple projects, supported WrongStack hosts use it without a competing local owner, independent MCP clients work with WrongStack closed, and installed artifacts pass isolation, lifecycle, recovery, compatibility, and performance acceptance. A working tool list or successful `memory_search` alone is insufficient.

All implementation tasks and numerical targets in this package are planned. Runtime tests, quality-of-recall evaluations, packaged clients, and migration proof remain NOT RUN.
