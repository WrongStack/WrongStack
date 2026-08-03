# PR: before-release.md Security & Reliability Audit + Side-Effect Recording + WebUI/TUI Audit Panels

## Summary

This PR closes all 26 items from the `before-release.md` data-flow analysis audit (24 fixed, 2 won't-fix with documented rationale) and adds a full structured side-effect recording system with cross-surface UI integration.

**No open items remain.**

---

## before-release.md Audit (26 items)

### P1 — Fix Before Next Release (4/4 ✅)

| # | Issue | Commit | Fix |
|---|-------|--------|-----|
| 1 | Write bypass weakens `confirm` permission | `2fd072c1` | Split `Context.readFiles` into `readFiles` (user) + `writtenFiles` (write). `recordRead()` takes `source: 'user' \| 'write'`. Permission bypass only checks user-seen files. |
| 2 | Bash timeout leaves child process running | `c80ad1ab` | Added `cleanup()` to `bashTool` that scopes `registry.kill()` to session's non-protected bash children. 4 tests. |
| 3 | Bash stream backpressure has no upper-bound test | `071acae5` | 3 real-spawn tests: terminates+truncates (240KB→<40KB), memory bounded (<50MB), head preserved. |
| 4 | Non-interactive confirm fallback (headless deadlock) | `e6cc5547` | `waitForConfirm()` checks `events.listenerCount('tool.confirm_needed')` — zero subscribers ⇒ immediate deny. 2 tests. |

### P2 — Fix This Sprint (9/9 ✅)

| # | Issue | Commit(s) | Fix |
|---|-------|-----------|-----|
| 5 | Structured side-effect recording (audit gap) | `d963985b` `1f62ebe4` `d96f66ad` `8c80a02c` | 4-phase implementation: SideEffect type + Context API → bash wiring → install+fetch wiring → /diag integration. Full design doc. |
| 6 | Error classification uses string match | `7556db9d` | `ToolValidationError` subclass; `instanceof` check before string-match fallback. 7 tests. |
| 7 | Pipeline swallow silently drops errors | `30ef427b` | `setLogger()` on Pipeline; swallow path emits structured `pipeline.error` warning. 3 tests. |
| 8 | Schema validation has no recursion depth limit | `b6f571fc` | `walk()` takes `depth` param, caps at `MAX_SCHEMA_DEPTH` (64). 4 tests. |
| 9 | `readFiles` mixes user reads and writer reads | `2fd072c1` | Resolved as part of P1 #1. |
| 10 | Bash-kill-guard regex doesn't cover common shell paths | `19ea66c2` | Broadened to match any executable + `-c`. Covers homebrew/env/plain. |
| 11 | Kill-guard obfuscation bypasses not documented | `8b7ab810` | Added "Known bypasses (NOT handled)" section to file header. |
| 12 | YOLO destructive detection has zero tests | `8940c2f6` | 88-case parameterized test suite covering every detection path. |
| 13 | Secret redaction has no test suite | `024eb860` | 36-case test covering every regex path + idempotency + multi-secret. |

### P3 — Backlog (11 fixed, 2 won't fix)

| # | Issue | Commit | Fix |
|---|-------|--------|-----|
| 14 | Sentinel marker list duplicated | `5839bc10` | Centralized in `types/tool-markers.ts`. |
| 15 | Redundant tool-level field guards | — | **Won't fix**: guards protect direct `execute()` callers (tests, embedded). Removing breaks them. |
| 16 | No cross-field validation extension point | `e7a99f52` | Added `Tool.validate(input): string[]` to interface + executor integration. |
| 17 | Permission eval cache has no size limit | `d888a8df` | `LruCache` (capacity 500), dependency-free. 9 tests. |
| 18 | HTTP error type guard uses duck-typing | `eaee0d1b` | `FetchError` subclass + `httpStatusToCategory()` helper. 7 tests. |
| 19 | PreToolUse re-validation redundant when unchanged | `99f9172a` | `isDeepStrictEqual` guard skips redundant `validateAgainstSchema`. |
| 20 | Atomic write mode lost on Windows | `8bbc5564` | `fs.chmod(targetPath, mode)` after rename on win32. |
| 21 | Output serializer is a god function | `fbf2b4ae` | `Tool.serialize()` extension point; serializer checks it first. |
| 22 | Progress tail only keeps last 16KB | `b1e9a042` | `PROGRESS_HEAD_CHARS` (16KB) head buffer alongside tail. Final flush emits head+tail with truncation marker. |
| 23 | Circuit breaker window persists through trip | `ddb564fd` | `_trip()` clears `this.window = []`. |
| 24 | Process registry has no PID reuse detection | `b1e9a042` | `_isStaleEntry()` + `_pruneStale()` before every `get()`/`kill()`. |
| 25 | Kill guard doesn't filter by platform | `77ecb5e3` | `isKillRelatedCommand()` + `parseKillCommand()` branch on `os.platform()`. |
| 26 | Session rewind stores full file contents | — | **Won't fix**: requires 4+ file refactor + new reverse-diff application path. Current full-content storage sufficient. |

---

## Structured Side-Effect Recording (P2 #5 — Full Implementation)

A complete audit trail system for non-filesystem side effects (bash, install, fetch), integrated across all three UIs.

### Type system & API
- `SideEffect` type (`types/side-effect.ts`): `{ toolUseId, toolName, ts, input, outcome?, risk }`
- `side_effect` SessionEvent union member (JSONL audit trail)
- `Context.recordSideEffect()` — fire-and-forget append, never blocks tool execution
- `SessionWriter.recordSideEffect()` — interface + FileSessionWriter implementation
- `Context.sideEffects[]` — in-memory list for /diag without JSONL parsing

### Tool wiring
- **bash.ts**: redacted command + exit code, risk `'shell'` (foreground + background)
- **install.ts**: packages + cwd + dry-run, risk `'package'`
- **fetch.ts**: URL + format + HTTP status, risk `'network'`

### CLI integration
- `/diag` — side effects section in the diagnostics output
- `/audit` (aliases: `/sideeffects`, `/side`) — dedicated command, inline table in REPL

### TUI integration
- `AuditPanel` overlay component — scrollable table with risk colors + icons
- Status bar badge — yellow "⚠ N audits" chip on line 2, auto-updating
- `/audit` slash command opens the overlay via `toggleAuditPanel`

### WebUI integration
- `SideEffectTimeline` component — InspectorPanel "Audit" tab
- Risk-level filter bar (All / shell / package / network / fs.write / config)
- Click-to-sort on Time, Tool, Risk columns (asc/desc toggle)
- CSV export button (filtered list, RFC 4180 escaping)
- Event-driven auto-refresh via `tool.executed` → `side_effects` push
- InspectorPanel handle bar clickable badge (opens Audit tab)
- `/stats` output includes side-effect count

---

## New Error Classes

| Class | File | Purpose |
|-------|------|---------|
| `ToolValidationError` | `types/errors.ts` | Structured validation error for `classifyToolError` |
| `FetchError` | `types/errors.ts` | HTTP error with `status` for reliable classification |
| `LruCache` | `utils/lru-cache.ts` | Minimal dependency-free LRU for eval cache |

---

## New Extension Points

| Interface | Method | Purpose |
|-----------|--------|---------|
| `Tool` | `validate?(input): string[]` | Cross-field validation after schema check |
| `Tool` | `serialize?(output, input): string` | Custom output formatting |
| `Pipeline` | `setLogger(logger)` | Swallow-path structured warning |
| `Context` | `recordSideEffect(se)` | Structured audit trail |

---

## Test Coverage Added

| File | Tests | Coverage |
|------|-------|----------|
| `bash-timeout-cleanup.test.ts` | 4 | Cleanup on timeout, live/dead/protected filtering |
| `bash-backpressure.test.ts` | 3 | Upper-bound memory, truncation, head preservation |
| `headless-confirm.test.ts` | 2 | Headless deny + listener-attached regression |
| `permission-write-bypass.test.ts` | 8 | readFiles/writtenFiles split + bypass behavior |
| `yolo-risk.test.ts` | 88 | Every destructive-detection path |
| `redact-command.test.ts` | 36 | Every secret-redaction regex + idempotency |
| `tool-validation-error.test.ts` | 7 | Subclass contract + instanceof reliability |
| `json-schema-validate.test.ts` | 4 | Depth limit prevents crash |
| `pipeline.test.ts` | 3 | Swallow logging + rethrow no-log + backward compat |
| `lru-cache.test.ts` | 9 | Eviction, recency, clear, capacity edges |
| `fetch-error.test.ts` | 7 | Status carrying, recoverable flags, type guard |
| `side-effect.test.ts` | 6 | Accumulation, append, fire-and-forget, clear |
| `bash-kill-guard-paths.test.ts` | 5+ | Shell path coverage + extraction proof |

**~180 new test cases total.**

---

## Files Changed (this session's commits)

- `packages/core/src/` — context.ts, errors.ts, tool.ts, session.ts, tool-markers.ts, side-effect.ts, lru-cache.ts, tool-executor.ts, pipeline.ts, json-schema-validate.ts, atomic-write.ts, permission-policy.ts, agent-tools.ts, tool-output-serializer.ts, types/index.ts
- `packages/tools/src/` — bash.ts, edit.ts, write.ts, install.ts, fetch.ts, bash-kill-guard.ts, circuit-breaker.ts, process-registry.ts, fixtures.ts
- `packages/cli/src/` — cli-main.ts, fleet/host.ts, slash-commands/audit.ts, slash-commands/index.ts, slash-commands/diag-stats.ts
- `packages/tui/src/` — app-state.ts, app-reducer.ts, app.tsx, components/audit-panel.tsx, components/status-bar.tsx
- `packages/webui/src/` — types.ts, server/index.ts, server/setup-events.ts, hooks/ws-handlers.ts, stores/side-effect-store.ts, stores/index.ts, stores/ui-store.ts, components/SideEffectTimeline.tsx, components/InspectorPanel.tsx
- `docs/design-side-effect-recording.md`

---

## Commits (this session, chronological)

### P1 Fixes
1. `c80ad1ab` fix(bash): add cleanup() to kill runaway bash process tree on timeout
2. `2fd072c1` fix(security): split readFiles so write bypass only covers user-seen content
3. `071acae5` test(bash): add MAX_QUEUE_CHUNKS upper-bound backpressure test
4. `e6cc5547` fix(security): deny confirm-required tools in headless runs to avoid deadlock

### P2 Fixes
5. `7556db9d` fix(security): add ToolValidationError subclass for structured classification
6. `b6f571fc` fix(security): cap json-schema-validate recursion depth to prevent crash
7. `30ef427b` fix(kernel): log structured warning on pipeline swallow path
8. `19ea66c2` fix(security): broaden bash-kill-guard to cover homebrew/env shell paths
9. `8b7ab810` docs(tools): document known bash-kill-guard bypasses in file header
10. `8940c2f6` test(security): expand isClearlyDestructiveBashCommand test coverage
11. `024eb860` test(security): add redactCommand secret-redaction test coverage

### P3 Fixes
12. `5839bc10` refactor(core): centralize MALFORMED_ARG_MARKERS in types/tool-markers.ts
13. `d888a8df` perf(security): cap permission-policy eval cache with LRU eviction
14. `eaee0d1b` fix(security): add FetchError subclass for reliable HTTP error classification
15. `99f9172a` perf(execution): skip PreToolUse re-validation when input is unchanged
16. `8bbc5564` fix(core): re-apply file mode after rename on Windows
17. `fbf2b4ae` refactor(core): add Tool.serialize() extension point for output formatting
18. `e7a99f52` feat(core): add optional Tool.validate() for cross-field invariants
19. `b1e9a042` fix(tools): add PID reuse detection + progress head buffer
20. `ddb564fd` fix(tools): clear circuit breaker window array on trip
21. `77ecb5e3` fix(tools): filter bash-kill-guard by platform to eliminate dead code

### Side-Effect Recording (P2 #5, 4 phases)
22. `d963985b` feat(core): add SideEffect type + Context.recordSideEffect + SessionWriter
23. `1f62ebe4` feat(tools): wire bash.ts to record structured side effects (Phase 2)
24. `d96f66ad` feat(tools): wire install.ts + fetch.ts to record side effects (Phase 3)
25. `8c80a02c` feat(cli): show side-effect timeline in /diag (Phase 4)

### WebUI Audit Panel
26. `7c8d3bf4` feat(webui): side-effect timeline panel (P2 #5 Phase 4 WebUI)
27. `485282c7` feat(webui): mount SideEffectTimeline as Inspector Audit tab
28. `ce0cab49` feat: event-driven side-effect auto-refresh after tool.executed
29. `ba856871` feat(webui): add risk-level filter and column sort to Audit tab
30. `46b51efe` feat(webui): add CSV export button to Audit tab
31. `fb08b4b4` feat(webui): show side-effect count in /stats output

### TUI Audit Panel
32. `be7b99c0` feat(tui): add AuditPanel overlay for side-effect timeline
33. `4effef1c` feat(cli): add /audit slash command for side-effect timeline
34. `e3197e2b` feat(tui): add side-effect count badge to status bar
35. `5dc23ebf` feat(cli): add /sideeffects and /side aliases to /audit command
