# Tool governance follow-up validation

This follow-up continues [the implementation report](tool-governance-2026-10-31.md). It resolves the reproduced validation blockers below while preserving unrelated shared-checkout work. No commit, push, release, deployment or installed-binary replacement was performed by this task.

## Reproduced defects and corrections

- The session-bound Kanban `updateTask` helper treated event context as the last parameter even after optimistic-concurrency options were added after it. Its generic type stopped binding the context, and an explicit `undefined` context with options reached production code as `undefined`. The new three-case regression ran red on that runtime error with two passing controls, then green. The explicit wrapper preserves attribution and concurrency conflict checks.
- Provider fallback fixtures discarded the EventBus payload type through `Record<string, unknown>`, making request IDs `unknown`. They now retain the actual `EventMap` payload type. Three desktop model imports use explicit ESM extensions, and the session-route fixture includes and tests its required redo handler.
- The HQ launch fixture selected menu option 4, which now launches VibeUI; HQ is option 5. Its mock asserted before resolving readiness, producing an unhandled rejection and leaving the test waiting for 60 seconds. Readiness now returns the actual flags and detects early CLI exit. The unchanged HQ assertion failed directly before correcting the fixture selection, then passed without an unhandled rejection.
- The Windows shell tree-kill test performed synchronous machine-wide CIM queries to check a single fixture process. In this run the original test timed out. A direct production-path proof confirmed the actual timed-out child exited. The durable test now reads the fixture's PID and probes that exact PID; permission/probe errors do not count as exit, and failure cleanup remains scoped by the unique fixture marker. No Windows production kill policy was changed on this evidence.
- Provider route handler interfaces moved into a type-only module, keeping their existing re-exports and all timeout validation behavior. The route file is below the hotspot threshold. The private HQ segment-path helper is no longer exported solely for unit tests; public HTTP tests cover nested segment mapping and rejected malformed mappings.
- Eleven measured hotspot decreases were recorded, and the below-threshold provider-route entry was removed. No line/import allowance was increased and no new test-only-export exception was accepted.
- General lint rejected redundant wording in a desktop attachment alt label. The wording was corrected. An existing NotificationMenu accessibility suppression was moved to the JSX element it applies to. Remaining lint warnings are intentional benchmark-fixture warnings outside production scope.

## Completed checks

| Check | Result |
| --- | --- |
| First focused integration batch | 9 files, 53 tests passed: Kanban helper/mirror, fallback flows, session routes, desktop models and Windows tree kill. |
| Previous process/runtime failure recheck | 9 files, 115 tests passed: ACP, goal verifier timeout, MCP lifecycle/protocol refusal, shell background/cleanup, plugin runner timeout, coverage-lock runtime and error-message architecture. |
| HQ and catalog regression recheck | 8 files, 79 tests passed: HQ startup, standalone fallback agents, registry governance, tool contracts/search/plugin management, catalog-generator fixtures and Director setup. |
| Provider/HQ refactor checks | Before: 3 files, 72 tests passed. After: 3 files, 74 tests passed, including public nested/malformed segment coverage. |
| CLI test-project typecheck | Passed: 1,567 files. |
| WebUI-server production typecheck | Passed: 326 source files. |
| Global test typecheck | Passed against the existing baseline: 43 projects, 1,104 diagnostics / 504 unique, **zero new diagnostics**, zero unparsed failures. Initial rerun had 1,202 diagnostics, 34 new unique / 98 added occurrences. No baseline was loosened. |
| Architecture gate | Passed after the task's refactors. A late rerun after concurrent source changes **failed**: `ProjectKanban.tsx` grew from its tightened 744-line baseline to 748 lines, and committed-evidence freshness was stale. API snapshots and report artifacts were regenerated; the final snapshot check passed and the independent core-layer check reported zero upward edges. No allowance was raised for the new growth. |
| Catalog, schema budgets, website and docs | Passed: 78 built-ins, 78 icons, 12 selection contracts, six schema budgets; website projection current; no missing maintained documentation links. |
| General lint | Passed over 12,475 files; five non-production benchmark-fixture warnings. |
| Production lint-warning gate | Passed: zero production warnings, zero errors. An earlier concurrent attempt failed because the Biome JSON process could not allocate memory; the isolated rerun completed normally. |
| WebUI-server consumer build | Final rerun **passed**, including JavaScript and TypeScript declarations. An earlier late attempt hit four errors in concurrently edited backend services/dispatcher/wiring; the external source changes completed before the successful rerun. This task did not patch those files. |

## Full-suite boundary

The initial fresh `bun run test` attempt with four workers exited with code 9 before producing a test summary. A concurrent Biome JSON process reported memory-allocation failure; that does not by itself establish the cause of the test-runner exit.

The second complete root run used two workers, with no additional heavy validation commands launched by this task. It completed in 2,783.64 seconds with exit 1: **4,328 files passed, 10 failed, 12 skipped; 56,144 tests passed, 11 failed, 69 skipped, 1 todo**. No assertion was weakened to accept that result. The command stopped before its chained WebUI phase.

Remaining failures were:

- Program survivors after timeout/abort or refused handshake: plugin SDK process-tree tests (two cases), Goal verifier, Chimera cascade verifier, MCP protocol negotiation and SDD verifier.
- Windows fixture-directory `EBUSY` during benchmark grader, bash cleanup and bash abort cleanup.
- Plugin runtime timeout exceeding its test deadline.
- PowerShell side-effect test unable to launch the installed WindowsApps `pwsh.exe` alias (`EPERM`).

The exact ten failing files were then rerun together with one worker, unchanged: **10 files / 122 tests passed** in 39.80 seconds. A separate real plugin-SDK control/timeout probe passed and observed no surviving fixture child. Its attempted `taskkill` event instrumentation did not capture those events, so it does **not** prove a causal explanation for the full-run failures. No speculative production tree-kill change was made. The root suite remains **NOT CLEAN**; isolated passes do not supersede it.

Final cleanup found one surviving full-run fixture process, verified against the recorded failed MCP PID, unique fixture command marker and run creation-time window, and terminated it. No unrelated process was targeted. This is additional evidence that the full-run lifecycle failure cannot be dismissed by the isolated pass.

The chained WebUI phase was run separately with its package script and two workers: **510 files / 6,223 tests passed; one file / one test failed**, exit 1, 708.81 seconds. The failure is `tests/components/activity-bar-customize.test.tsx`, `never shows more icons than the budget allows`: observed 15 icons against a limit of 14. A subsequent single-worker check of that complete file plus the notification-menu file passed **2 files / 33 tests**, without a task-owned activity-bar implementation change. The shared checkout contained concurrent activity-bar/mobile work; neither a causal explanation nor a clean full WebUI suite is established by that isolated pass. No browser visual, hosted CI or release certification is claimed.

Final scoped Biome verification checked **85 files** with no fixes/errors; `git diff --check` passed. Unrelated working-tree changes were left intact. The remaining acceptance gaps are the combined-run Windows lifecycle behavior, the full WebUI budget failure and the late architecture drift/freshness failure. None is hidden by a baseline change or an isolated green rerun.

The shared checkout started this continuation at `7acbdd963caa73a39dc8b80fc37d1f943864befb`; another stream advanced HEAD during the work, including to `fcb06d64fab3a473d251d803405d6cbd999432a9` and `c4bcffb5d9cd836043b8816831bd5c24b52993b8`. Of 86 recorded task inputs, 85 retained the same hash across the root run; only the generated architecture JSON report changed. Monitored executable source/config inputs were unchanged, while the global checkout continued moving. Later metadata refreshes updated the generated reports/snapshots again. Focused passes and baseline ratchets do not establish hosted CI or full release certification.

Local command logs, typecheck summaries and input hashes are retained under `.reports/tool-governance-followup-1793473567291/` (ignored local evidence, not checked-in release artifacts). Disposable proof scripts and fixtures were removed from the task-owned scratch directory.
