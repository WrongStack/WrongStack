# Validation, performance, and release evidence

Status: planned checks only. None of these suites has been run for WrongIndex.

## 1. Validation principles

- Assert real behavior through storage, IPC, filesystem, and supported WrongStack tools.
- Mock clocks and external providers where useful; do not mock the parser/storage/owner being certified.
- Use isolated fixture directories, private data roots/endpoints, bounded waits, and explicit teardown.
- Prove a regression test fails on the intended broken behavior before accepting it as a regression guard.
- Differential tests must identify both engine artifacts and baseline source hashes; comparing two stale builds is not parity evidence.
- Normalize only irrelevant nondeterminism. Keep ordering, scope, positions, NULL semantics, unresolved references, and stale/error state visible.
- Report actual PASS/FAIL/NOT RUN/UNSUPPORTED separately. A test selection that matches zero tests is not success.
- Focused checks certify their stated scope; final release requires the full applicable gate matrix.

## 2. Proposed test layout and commands

Rust unit/integration tests use Cargo's existing toolchain with temporary filesystem/SQLite fixtures. Rust formatting and Clippy are gates. Frontend and TS client tests use Vitest under Bun; UI browser checks use Playwright where appropriate. Real packaged Tauri lifecycle tests require a Windows native automation/smoke harness selected during the desktop spike.

Proposed commands for the future repository, not available WrongIndex commands today:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:unit
bun run test:contract
bun run test:differential
bun run test:integration
bun run test:fault
bun run test:desktop
bun run bench:acceptance
bun run release:check
```

Wire scripts to real suites with nonzero discovery checks and machine-readable summaries. Native Tauri build features may require platform-specific command variants; document them rather than excluding the desktop from the release gate. When modifying WrongStack, use its own Bun scripts (`bun run test`, not Bun's alternate `bun test` runner) and required package/full integration gates.

## 3. Requirement-to-evidence matrix

| Requirement | Test scenario | Observable acceptance |
|---|---|---|
| One normal daemon per user | Start ten clients concurrently | One elected instance; all clients connect; no endpoint/PID corruption |
| Project identity | Same checkout via alias, linked worktree, clone, index override | Correct deduplication/isolation; conflicting root/index rejected |
| Existing SQLite reuse | Adopt fixture written by captured WrongStack | Same active path; baseline tool queries remain correct |
| Single writer | Simultaneous supported local/service activation | Exactly one owner; loser receives conflict; no hidden inline fallback |
| Old client boundary | Unsupported artifact attempts attachment | Explicit refusal/documented incompatibility; no false protection claim |
| Profile admission | Unknown schema, missing columns, optional vectors | Inspect before mutation; unsupported bytes unchanged |
| Session policy | Two clients, close one, expire second | First close does not stop watch; expiry/grace behavior correct |
| Pinned policy | Close all clients and GUI | Edits continue updating index; restart restores registration |
| Manual/disabled policy | Files change while dormant | No hidden continuous watch; explicit job policy honored |
| Initial scan race | Edit/create/delete during attachment scan | Final results converge; no permanent gap or false current state |
| Incremental edit | Change declaration and callers | Search and both call directions reflect usable committed generation |
| No-op | Touch, watcher echo, unchanged full/targeted runs | Hash skip; no spurious content generation or graph rebuild |
| Rename/delete | Rename symbols/files/directories | Old targets/FTS/refs/ranks cleaned; new bindings correct |
| Incomplete discovery | Deny access to subdirectory | No mass deletion; last good rows retained; degraded reported |
| Parser error | Syntax/read error then valid save | Failure visible; successful recovery clears current error |
| Ignore changes | Exclude/include existing subtree | Indexed set changes only after complete policy-aware discovery |
| Event loss | Drop event/inject overflow then reconcile | Index equals fresh oracle build; queue remains bounded |
| Root restore | Rename/remove/remount root | Preserved index unavailable, then reattached and reconciled |
| Fair scheduling | Large scan A plus small edit B | B progresses within budget; A eventually completes |
| Cache coherence | Warm every consumer then edit via another client | New generation visible everywhere; stale responses labeled |
| Atomic publication | Query continuously during graph rewrite | Prior or new complete generation; no partial committed view |
| Commit crash window | Crash immediately after commit | Reconnect sees committed run; no double application |
| GUI independence | Close/crash desktop during pinned indexing | Daemon and watch survive; reopened UI reconciles snapshot |
| IPC security | Wrong token/SID, malformed/large/slow frames | Denied/bounded without leaking project state |
| Safe removal | Remove registration/uninstall | Source and index retained; ownership released |
| Native process goal | Inspect installed process tree over multiple projects | No Bun/Node index engine or per-project daemon/helper requirement |
| Installed release | Fresh install, login, update, rollback, uninstall | Supported lifecycle and exact artifact identity verified |

## 4. Differential oracle design

For each fixture:

1. Materialize identical source trees with controlled timestamps and path mappings.
2. Produce a database with the immutable WrongStack baseline.
3. Produce or incrementally update the counterpart with WrongIndex.
4. Inspect schemas/metadata and semantic table projections.
5. Run the same public query operation vectors against both.
6. Replay edits, deletions, renames, policy changes, and failures.
7. Compare results to both the baseline incremental path and a fresh complete rebuild where meaningful.
8. Save a bounded artifact bundle with source hashes, engine versions, diff, stdout/stderr, and assertion identity.

Maintain separate suites for independent-build equivalence and in-place shared-index compatibility. Independent databases can remap allocated IDs to semantic identities; in-place updates must preserve all required referential properties without concealing raw corruption.

SQLite byte equality is not required: page layout, row IDs, and timestamps can differ. Schema, stored semantic values, query order where contractual, reference resolution, and runtime behavior are required. Floating rank/vector tolerances must be justified, fixed, and accompanied by expected ordering; do not invent broad tolerances after a failure.

## 5. Fixture catalog

| Group | Required cases |
|---|---|
| Filesystem paths | Spaces, non-ASCII, astral Unicode, long Windows paths, drive root, UNC rejection/degradation, symlinks/junctions, case behavior |
| Checkout identity | Main checkout, linked worktree, clone, explicit index override, moved/missing root, nested repo |
| Encodings | UTF-8, BOM, CRLF/LF, invalid bytes per baseline behavior, empty file, same-size restored-mtime edit |
| TS/JS | Overloads, class methods, anonymous/export-default, nested scopes, JSX/TSX, imports/aliases/re-exports, config paths, symbol-less modules |
| Go | Multiple files/package, receiver methods, qualified calls, import aliases, duplicate names across packages, invalid source |
| Python | Classes/methods, decorators, nested functions, relative imports, aliases, multiline definitions, non-ASCII identifiers |
| Rust | Modules, impl/trait methods, generics, imports/aliases, macro syntax without executing macros, scopes |
| Tree-sitter group | At least one valid/boundary/fallback fixture for every current grammar route |
| Config/generic | JSON/YAML manifests, package labels, imports in files without declarations, mapped unsupported syntax |
| Resolution | Same name different languages/modules, unresolved -> resolved, target deletion, import cycle, re-export chain |
| Query | Zero hits, empty query, filters, ties, short trigram query, pagination limits, transitive call cycles |
| Optional tables | Concepts pending/ready/stale, vector provider changes, absent/present symbol vectors, preserved unknown metadata |
| Storage history | Current index, repaired older index, unknown newer schema, divergent same-version schema, corrupted FTS |

Every failure fixture includes a valid control so harness/setup errors are distinguishable from the intended assertion. Grammar asset checksums and semantic query versions are part of fixture provenance.

## 6. Deterministic concurrency and crash tests

Use barriers/hooks at boundaries instead of arbitrary sleeps. Production code exposes narrowly scoped test fault hooks disabled in normal release builds, or external process coordination markers where practical.

Required crash points:

- After durable admission, before parsing.
- After source read, before revision revalidation.
- After owner transfer intent, before old owner drain completes.
- After ownership acquired, before new activation.
- During multi-table transaction before commit.
- After commit, before registry update.
- After registry update, before event delivery.
- During backup/migration/update activation.
- During cancellation concurrent with successful commit.

Assert exactly one successful committed effect where applicable, no partial graph/FTS publication, correct run receipts after restart, old epoch rejection, and eventual index/disk convergence. Re-run timing-sensitive integration scenarios at least five times for initial acceptance; repeated success supplements deterministic synchronization rather than replacing it.

## 7. Benchmark program

### 7.1 Corpus tiers

| Tier | Proposed size | Purpose |
|---|---|---|
| S | Approximately 500 files | Functional latency and small-project overhead |
| M | Approximately 10,000 files | Typical monorepo behavior and multiple projects |
| L | Approximately 100,000 files | Scaling, staging, queues, retained database caches |
| Mixed | 10 registered projects, 3 actively changing | Real service scheduling and dormant overhead |

Record bytes, language mix, symbol/ref counts, ignore policy, largest file, dependency topology, Git state, and corpus generation seed. File count alone is not workload identity.

### 7.2 Proposed initial acceptance budgets

Reference machine to be fixed during M0: Windows x64, local SSD, 8 logical CPUs, 16 GiB RAM, with antivirus/storage conditions recorded. These budgets are targets, not measured claims:

| Measurement | Initial target / interpretation |
|---|---|
| Steady idle CPU, watch-only | Below 1% average over 5 minutes on reference workload; report CPU denominator |
| Daemon RSS, 10 attached idle projects | Target <=150 MiB excluding GUI and OS file cache; tuning gate if exceeded |
| Single ordinary edit, M corpus | p95 observed event -> usable generation <=2 seconds under normal load |
| Warm search, M corpus | p95 <=50 ms and p99 <=150 ms end-to-end IPC for bounded standard query set |
| Warm graph/calls query | p95 <=200 ms for defined bounded queries; report graph size/depth |
| Unchanged M verification | Target <=25% of current baseline elapsed time, with same work/trust scope |
| Cold full index | No more than 10% regression vs captured baseline before claiming parity release; report each corpus/language |
| Small-project fairness | An ordinary edit progresses while another project scans; target <=5 seconds absent commit contention |
| Overflow recovery | Eventually equals full oracle; bound dirty-path memory and report recovery duration |
| Soak | 24-hour initial qualification; no monotonic handle/thread/connection growth and RSS reaches a workload plateau |

Adjust unrealistic targets explicitly after M0/WI-513 with recorded evidence and rationale. Never report a target change as a measured speedup. GUI RSS is reported separately, then included in total installed-product resource figures.

### 7.3 Benchmark procedure

Measure cold/warm full build, no-op full verification, targeted no-op, 1/10/100-file edits, branch-switch bursts, rename/delete, paused-resume reconciliation, query-under-write, and multi-project saturation. Run at least five comparable iterations for short benchmarks and report distribution, not the best sample. Record outliers and environment interference.

Do not claim that a metadata-only scan equals a full byte verification. Do not compare native warm cache against legacy cold cache. Record engine/helper process tree and combined CPU/RSS during hybrid/native comparisons.

## 8. CI pipeline

Per change: formatting/lint/typecheck, Rust unit tests, TS contract tests, changed-area integration, profile/schema drift checks, grammar/license manifest checks. Required merges include full platform-appropriate integration and compatibility gates.

Windows is required for named pipes, actual watcher semantics, path/reparse behavior, installed GUI lifecycle, update/uninstall, and release smoke. Linux can exercise portable core tests early but does not replace Windows proof. macOS support begins only with its own native runner and artifact tests.

Run controlled expensive benchmark/soak jobs outside ordinary unit-test timing assertions. Serialize shared corpus/coverage/build writers or use independent artifact/data roots. No production index, user credentials, or repository untracked files enter fixtures.

## 9. Release gate matrix

| Gate | Evidence |
|---|---|
| Source identity | Clean release commit, exact tag, profile/source hashes |
| Build reproducibility | Locked dependencies, selected toolchain, grammar checksums, platform metadata |
| Functional | Full applicable Rust/TS/IPC/filesystem/GUI suites with counts |
| Compatibility | Full language/query/storage profile; explicit unsupported matrix |
| Ownership | Transfer, no fallback writer, rollback, legacy floor |
| Fault | Crash windows, disk full, root loss, queue overflow, cancellation |
| Performance | Reproducible corpus/machine results and budgets |
| Soak | Duration/workload/resource plots and final database validation |
| Security | ACL/token/frame/path/UI boundaries and dependency/license review |
| Packaging | Installer, autostart, upgrade, rollback, uninstall |
| Artifact integrity | Checksums/signature status/provenance where supported |
| Download smoke | Downloaded installed binary, version/profile identity, real indexing/query |
| WrongStack live proof | Supported installed client uses same database and fresh queries |
| Documentation | Actual commands, support matrix, migration and recovery instructions |

Native 1.0 cannot pass with required languages still on the compatibility backend, required platform tests NOT RUN, or a hidden helper-process requirement.

## 10. End-to-end acceptance demonstration

Record one reproducible demonstration with machine-readable assertions:

1. Install WrongIndex and supported WrongStack builds from release artifacts.
2. Open project A through WrongStack; verify registration and existing index path.
3. Pin project B from the GUI; open project C with a session-scoped client.
4. Edit A externally; query search/incoming/outgoing calls through actual WrongStack tools.
5. Edit A through a WrongStack tool; verify watcher echo produces no duplicate content generation.
6. Close GUI and every B client; edit B and verify index updates through CLI.
7. Close C's final session; verify lease/grace stops watching while preserving the index.
8. Warm all A query caches, rename/delete a target, and verify consistent next-generation graph results.
9. Inject overflow/daemon crash; restart and verify full reconciliation.
10. Reopen GUI; confirm accurate project/job/freshness state and no lost committed generation.
11. Inspect process tree across all projects and confirm the native product claim.
12. Perform supported ownership release/rollback; prove local WrongStack works again.

Save artifact versions, database paths, epoch/generation IDs, queries/results, exit codes, and timings. Redact project source and credentials from shared evidence.

## 11. Completion report template

For each milestone report: delivered task IDs, implementation commit, baseline/profile IDs, exact commands, pass/fail/skip counts, benchmark scope, platform, artifact identity, known limitations, and next gate. Distinguish code implemented, focused tests passed, full local verification, hosted CI, packaged artifacts, and live installed proof.

For this planning task, only document structure/source links and whitespace will be checked. WrongIndex runtime, native parity, benchmark, packaging, and live integration checks remain NOT RUN until implementation exists.
