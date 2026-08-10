# WrongStack Source Audit — Executive Summary

**Date:** 2026-08-10
**Version:** v0.303.0
**Method:** Targeted source review with direct verification of the consolidated findings below

## Outcome

No critical or high-severity defect was confirmed. The audit found several medium correctness defects and low-severity hardening or diagnostic opportunities. Every confirmed actionable item below has now been addressed in the working tree. Several claims in the initial draft were downgraded or rejected after following the production implementation beyond the first call site.

## Confirmed Actionable Findings

| ID | Severity | Area | Finding | Resolution |
|---|---|---|---|---|
| **A-01** | **Medium** | Core learning | Cross-category proven directives could suppress a fresh entry. | **Resolved:** both proven suppression and overlap replacement are category-scoped; regression test added. |
| **A-03** | Low | WebUI server | Several intervals depended entirely on normal lifecycle cleanup. | **Resolved:** reviewed long-lived intervals now call `unref()`. |
| **A-04** | Low | Codebase index | `filesIndexed` combined parsed, skipped, failed, and empty outcomes. | **Resolved:** backward-compatible `fileOutcomes` counters expose each result separately. |
| **A-05** | Low | Governance | Lifecycle/assignment block diagnostics omitted actual values. | **Resolved:** block reasons now include both lifecycle and assignment state. |
| **A-06** | Low | Secret vault | Repair of an already-loose POSIX key file was untracked fire-and-forget work. | **Resolved:** repair uses the vault's tracked hardening queue and `flushHardening()`. |
| **A-07** | Low | SAGE docs | The `repeatCooldownMs` migration note contradicted runtime behavior. | **Resolved:** comment now describes once-per-session and positive cooldown semantics accurately. |
| **A-08** | **Medium** | Session Kanban | Mirror coalescing could discard an intermediate completed Todo snapshot, causing a false requirement-scope shrink warning. | **Resolved:** skipped completions are applied through a bounded reconciliation graph before the latest snapshot; general scope-shrink protection remains enabled. |
| **A-09** | **Medium** | Session catalog | Catalog-backed filtering happened after fetching only the newest bounded prefix, hiding older matches. | **Resolved:** provider/model/date/token/title predicates now execute in SQLite before ordering and `LIMIT`; store and daemon regressions added. |
| **A-10** | **Medium** | MCP registry | Lossy sanitization or truncation could map distinct MCP server/tool identities to the same provider-wire name, hiding later tools. | **Resolved:** lossy segments receive deterministic bounded identity suffixes while ordinary safe names remain stable. |
| **A-11** | **Medium** | MCP OAuth | Authorization callbacks were not bound to the discovered issuer, leaving multi-issuer flows exposed to OAuth mix-up. | **Resolved:** distributed endpoints require advertised RFC 9207 support and callbacks validate one exact `iss`; same-origin deployments use a constrained compatibility path. |
| **A-12** | **Low** | MCP OAuth | Concurrent discovery could bypass the 32-session pending bound, and disconnect could be undone by a late discovery result. | **Resolved:** in-flight attempts reserve capacity and are invalidated by disconnect. |
| **A-13** | **Medium** | Session storage | Resume could append `session_resumed` directly into a crash-torn final JSON record, losing the recovery boundary. | **Resolved:** resume isolates any newline-free tail before admitting new JSONL records. |
| **A-14** | **Low** | Storage tests | The `messages_dropped` end-to-end replay test left its real session writer open for garbage collection. | **Resolved:** the test now closes the writer explicitly; the isolated group is warning-free. |
| **A-15** | **Medium** | SAGE SQLite | A database populated while FTS5 was unavailable received an empty index when later opened with FTS5, hiding existing memories from non-empty search. | **Resolved:** first successful FTS initialization transactionally backfills existing rows and records an atomic retry-safe marker. |
| **A-16** | **Medium** | WebUI WebSocket | Browser cookie/bootstrap authentication was not consistently bound to the exact Origin/Host authority, admitting loopback aliases and public sibling origins. | **Resolved:** loopback bootstrap and cookie auth now require matching normalized hostname and effective port; the development cross-port escape hatch remains explicit. |
| **A-17** | **Medium** | MCP Windows lifecycle | Graceful shutdown signaled the `cmd.exe` wrapper rather than delivering EOF to the real stdio server, weakening both cleanup and later tree escalation. | **Resolved:** Windows closes protocol stdin first and force-kills the still-rooted tree only after the grace window. |
| **A-18** | **Low** | WebUI goal broadcast | Fan-out recomputed the same large serialized frame's UTF-8 byte length once per client. | **Resolved:** broadcast computes frame size once; the 10K-task/100-client mean fell from 48.64 ms to 4.91 ms. |
| **A-19** | **Low** | Plugin lifecycle | Path-guard and secret-scanner shared hook handles and scanner configuration across concurrent plugin hosts. | **Resolved:** lifecycle state, teardown ownership, counters, and scanner projections are isolated per `PluginAPI`. |
| **A-20** | **Low** | Codebase index | The 500-file worker threshold was compared with a parse batch capped at 40, so worker parsing could never activate. | **Resolved:** eligibility uses complete run size while per-batch I/O and frugal-mode bounds remain intact. |
| **A-21** | **Medium** | Session storage | A warm shard-manifest cache did not observe another store process deleting/rebuilding the shared manifest. | **Resolved:** cached projections validate mtime, size, and file identity before reuse; a two-store regression covers peer invalidation. |

Additional low-risk items found in the reports were also closed: mutable ad-hoc Council profiles are normalized on every call, Vitest now clears/restores mocks, lifecycle errors include column titles, and the secret-scanner cache key includes regex flags.

## Validation Snapshot

- 15 focused test files: **356/356 passed**.
- Repository-wide typecheck passed across **32/33 workspace projects**; the remaining project has no typecheck script.
- Test-type ratchet: **0 new diagnostics** across 30 projects.
- Scoped Biome check passed after formatting the audit-owned files.
- The repository-wide test chain passed when run as its two constituent commands: root Vitest exited 0, and WebUI passed **5,238/5,238 tests across 322 files**.
- Full coverage passed: Node coverage ran **2,307 passing files / 33,052 passing tests** (plus 3 files and 16 tests skipped), followed by the zero-coverage and script-coverage gates.
- Production build, build-manifest lineage, architecture snapshots/ratchets, provider catalog, plugin projections, package contracts, test inventory, skip budget, Windows `node-pty`, i18n, and the moderate dependency audit all passed.
- Session Catalog focused validation: **14/14 tests passed** across store, registry lifecycle, and daemon IPC suites; Core typecheck passed.
- MCP package validation: **594/594 tests passed** across 32 files, including real Windows graceful-exit and descendant-cleanup fixtures; Core and MCP typechecks passed.
- Core storage validation: **920/920 tests passed** across 69 files; Core typecheck passed.
- SAGE SQLite migration/recovery validation: **22/22 focused tests passed** across 4 files; the audit-compatible package run passed **842/842 tests across 62 files**; production-source typecheck passed. The unfiltered run reached 874/877, with the three unrelated failures confined to concurrent untracked session-end extractor work.
- WebUI HTTP/WS security and broadcast validation: **279/279 focused tests passed**; the full server suite passed **1,536/1,536 across 134 files** on confirmation rerun; production-source typecheck passed.
- Compaction validation: the core regression suite passed **50/50**; HybridCompactor measured 1.13 ms mean at 1K messages and 5.99 ms at 5K, while a 5K tool-pair history confirmed the preserve repair loop is bounded to two iterations.
- Council abort validation: the Council, Brain, Wire Adapter, and AI Gateway suites passed **107/107**; production callers carry the combined overall/per-call signal through `provider.complete` to HTTP `fetch` or the SDK `abortSignal`.
- Plugin lifecycle validation: **326/326 focused tests passed**; the full plugins suite passed **2,486 tests with 1 skipped across 117 files**; plugin typecheck passed.
- Codebase-index worker activation validation: **23/23 focused tests passed**; the full Tools suite passed **2,589 tests with 7 skipped across 170 files**; Tools typecheck passed.

## Validation or Measurement Needed

No audit finding remains in the measurement-only queue. Windows-sensitive behavior is validated by the local Windows test matrix; hosted CI is not part of this project's acceptance or release process.

## Rejected or Corrected Draft Claims

- **Permission-cache destructive-command bypass:** rejected. `bash` and `exec` permission subjects include the command invocation, so `ls` and a destructive command do not share the asserted cache key.
- **Dirty-base worktree merge:** rejected. `WorktreeManager.mergeBranch()` runs `git status --porcelain` and refuses a dirty base before checkout/merge.
- **File-lock watcher leak:** rejected. Timer and watcher callbacks converge on an idempotent `settle()` that closes the watcher.
- **Unbounded session load cache:** rejected. `SessionLoadCache` enforces both a 50-entry and 64 MiB bound.
- **SAGE missing WAL mode:** rejected. The SQLite store is explicitly WAL-backed; concurrency still deserves integration coverage, but WAL absence is not a finding.
- **SAGE sessionless cooldown collision:** rejected. Production Context and SessionWriter contracts require a session ID, and both CLI and WebUI SAGE wiring provide a live session getter; only malformed structural callers can reach the synthetic fallback.
- **Windows coverage takes 2.5–3 hours:** removed. That duration was not established by this audit and must not be used to size CI.
- **Worktree and WebSocket success inferred from file existence:** removed. A module's presence or size does not prove its validation behavior.

## Verified Strengths

- Permission evaluation uses separator-aware shell allow matching and protects agent-state write targets.
- Tool execution separates asynchronous production from synchronous budget settlement.
- Worktree merge rejects dirty bases and reports/reset-cleans squash conflicts.
- Session load caching is mtime/size validated and bounded.
- SAGE uses SQLite WAL, serializes normal writes with a file lock plus immediate transaction, drains mutations before production close, and production Context/SessionWriter contracts provide session identity.
- MCP child shutdown registers its exit listener before checking exit state, avoiding the documented TOCTOU race.
- Kanban lease checks block stale workers after recovery/reassignment.
- GitHub Pages publishing remains the only operationally required GitHub Actions path; code acceptance is validated locally.

## Report Map

| # | Report |
|---|---|
| 01 | [Core Kernel](./01-core-kernel.md) |
| 02 | [Security](./02-security.md) |
| 03 | [Execution Pipeline](./03-execution-pipeline.md) |
| 04 | [Storage and Sessions](./04-storage-sessions.md) |
| 05 | [MCP Protocol](./05-mcp-protocol.md) |
| 06 | [SAGE Memory](./06-sage-memory.md) |
| 07 | [WebUI Server](./07-webui-server.md) |
| 08 | [Tools and Plugins](./08-tools-plugins.md) |
| 09 | [Build and CI](./09-build-ci.md) |
| 10 | [Kanban and Governance](./10-kanban-governance.md) |
