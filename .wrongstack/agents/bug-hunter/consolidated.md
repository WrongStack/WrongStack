# Bug-Hunter Agent Instructions

## Parallel Work and Chimera Reviews

- After any parallel fix pass, re-read the current on-disk state of every file in the cascade before citing or reporting a finding. Concurrent Chimera workers (bug-hunter, security-scanner) frequently resolve the same findings mid-session; citing pre-fix content produces false positives.
- If an existing on-disk diff already addresses a finding, preserve that work rather than applying a duplicate patch.
- Treat the `Resolved by the parallel worker` block in a Chimera review as authoritative for which findings remain open versus already fixed.
- Before classifying a finding as a false positive, confirm with `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/<pkg>/tsconfig.json` (exit 0 = no error) and the targeted vitest file.

## Verification and Testing Procedures

- After any refactor that adds, removes, or renames a method, grep the session's test files for every affected method name. Vitest transpiles with esbuild (no type-checking), so a test calling a deleted method fails at runtime with `TypeError: X is not a function` — a red suite is the only signal.
- Before trusting a reviewer claim that a method is "absent" from a class, re-read the actual source file and confirm with `grep`. Reviewers can misread a class body and produce ghost findings.
- When the `edit` tool reports "no match" for an `old_string` that `read`/`grep` show verbatim, suspect invisible Unicode characters in the target file.
- Since pnpm 10.x, `--publish-branch` defaults to both `master` and `main`, so publishing from `main` passes without explicit config. Verify against the installed pnpm version and official docs before concluding a local `pnpm publish` will fail. To isolate the branch check from a dirty working tree, use a throwaway git repo with `pnpm-workspace.yaml` containing `packages: []` and run `pnpm publish --dry-run`.
- For Windows atomic-write tests, mock the `fs.rename` seam, select the Windows retry branch, and inject a transient error (e.g., `EBUSY`). Do not hold an open file handle as retry evidence — its behavior is platform-dependent.
- For Kanban verification, resolve locally installed Vitest or Jest package bin entries and invoke them through `process.execPath` with `shell: false`. Do not add package-manager fallbacks to the generic verifier command allowlist.

## Data Integrity Invariants

- **Session-memory merge queries** (`packages/sage/src/sqlite-store-remember.ts`): always require strict `owner_session_id = ?` matching. Never let owned writes merge with `owner_session_id IS NULL` legacy rows — session-filtered retrieval deliberately hides those rows, and adoption silently changes their ownership semantics.
- **Fingerprint-cache refactors:** update the cache value type, hit path, write path, comparison path, eviction accounting, observability counters, and setup/teardown resets as one atomic change.
- **Hook-index observability:** update atomically across state initialization, `setup()`, `teardown()`, `duplicate_code_status`, `health()`, and the counter-increment branch.
- **Subagent removal:** every removal path must clear labels, generation records, throttle snapshots, stream buffers, history buffers, and tool aggregations together.
- **Auto-review concurrency** (`packages/core/src/plugins/auto-review-plugin.ts`): centralize bounded-expiry scheduling so both `iteration.completed` and `session.ended` paths apply identical cleanup.
- **Review-claim bookkeeping:** register before Chimera's enabled-state early return. Chimera exclusively owns the shared `review_needed`/`review_complete` listener pair; auto-review must not duplicate the start listener.
- **Process-group termination** (`verification-context.ts`): couple any POSIX `process.kill(-pid, ...)` to a child spawned with `detached: true` using one computed boolean that controls both spawning and termination.

## Security Patterns

- **NAT64 SSRF bypass:** conservatively block the entire RFC 8215 local-use prefix `64:ff9b:1::/48` in `packages/core/src/utils/ip-guard.ts`. Without the locally configured translation layout, fixed-group IPv4 decoding is unsafe and can permit private destinations through SSRF checks.
- **Retry-receipt cache gating:** when a receipt/cache idempotency contract only protects a subset of request types, gate the receipt lookup on the incoming request's type field before consulting the cache. Without the gate, a recycled `requestId` across request types returns a stale conflict error before the inner decoder can reject the malformed payload.
- **Revocation in retry-receipt caches:** make reservation best-effort for revocation-style operations (commit if available, skip caching if not). Gating revocation on retry-receipt capacity lets a busy admin DoS their own ability to revoke compromised grants — a security boundary that dwarfs the value of idempotency replay.

## TUI Rendering and Layout

- Calculate condensed banner widths using helpers from `packages/tui/src/terminal-width.ts`, not JavaScript string length — provider, model, and path values may contain multi-column Unicode characters.
- With Ink 7 `<Static>`, submit only unseen, commit-safe batches and track emitted IDs separately. `<Static>` identifies items by array length/index, so resubmitting the full transcript causes duplicates.
- Model each live assistant or tool-stream suffix as a separate fixed-height row; exclude their combined height from cached history totals and entry-space offsets.
- Use `flex-end` only while managed history is pinned; use `flex-start` for computed scrolled slices. Forcing `flex-end` while scrolled produces a blank oldest-history viewport.
- Enforce persistent panel visibility at the `AppStatusRegion` mount boundary (picker value while settings are open, persisted value otherwise). Child panels must remain presentation-only.
- Do not compact `replace`, `diff`, or `patch` entries into `ToolGroup` — the compact renderer preserves only one-line metadata and discards structured diff bodies and multi-file summaries.
- Trigger a React revision whenever mutable height-cache measurements change cached totals; otherwise `totalHeight()` and `onMeasure` remain stuck on render-time estimates.
- Recalculate the bottom region when picker or panel heights change, not only on terminal resize.
- In `packages/tui/src/components/scrollable-history.tsx`, always clear `selectionRef` whenever `HistoryScrollController` moves the viewport — selection coordinates are viewport-relative and become unsafe against newly mounted card spans. When copying compact tool groups, pass every mounted span's `entryIds` through `toolGroupsByHeadId` to `assembleSelectionText`; using only the group head silently omits later members.

## Terminal and Effect Lifecycle

- Enable terminal ownership via `setTuiActive(true)` immediately before Ink rendering and reset it in the directly paired `finally`. Enabling it earlier suppresses renderer output if pre-render setup throws.
- Keep generic `silent` mode independent from exclusive `tuiActive` mode: `silent` suppresses stdout only; `tuiActive` suppresses both terminal streams.
- Reset mouse terminal-state refs during effect cleanup. React StrictMode replays effects without recreating refs, leaving stale tracking state after `MOUSE_OFF`.

## Streaming and Memory Bounds

- Treat provider bridge live refs (`streamingTextRef`, `pendingDeltaRef`, each stream segment, and segment-array count) as bounded display/recovery tails, not canonical response storage. Bind them together so retention paths cannot diverge.
- Reconstruct retained history from canonical provider-response blocks, never from truncated live-stream segments.
- Enforce TUI memory limits per payload as well as per collection. A newest-item exemption in history or preview stores allows one tool output, file, paste, or diff to defeat entry/count budgets.
- Implement async pollers as completion-driven or single-flight. Clearing a `setInterval` prevents future polls but does not cancel already-overlapping requests.

## Compaction and Summary Caches

- In compaction tests, account for the current user message: `Agent.run` appends it before the context-window preflight compaction pipeline runs.
- Inject a private `CompactionSummaryCache` into `IntelligentCompactor` tests unless shared-cache behavior is the explicit subject under test.
- Cover cache reuse both across compactor instances and across repeated `compact()` calls on a single instance.
- Clear the process-wide summary-cache singleton in `beforeEach`.
- Trim generated summaries before cache-admission checks reject empty or fallback-placeholder results.

## Project Conventions

- Import `SubcommandHandler` and `SubcommandDeps` from `packages/cli/src/subcommands/contracts.ts`, not `packages/cli/src/subcommands/index.ts`. The aggregator pulls handlers into the frozen `ARCH-CYCLE-TYPE-03` strongly connected component.
- Treat `CONFIG_BEHAVIOR_DEFAULTS` as the public `Config` shape, where `autonomy` is optional. Strict consumers must narrow it or use optional chaining even when the concrete default currently supplies a value.
- Treat open todos as the authoritative auto-submit source. Submit synthesized continuation prompts directly; do not persist them as reusable next-step suggestions.
- In `packages/core/src/plugins/review-finding-parser.ts`, require a path-like filename with an extension and a spaced Markdown separator (`file:line — description`) when parsing review findings. Accepting unspaced hyphens truncates hyphenated repository paths. Validate reviewer citations against the supplied changed-file inventory rather than filesystem existence, and preserve uncited or unparseable findings as actionable.