# WebUI Improvement Task List

**Filed:** 2026-06-20
**Last updated:** 2026-06-21
**Status:** In progress (Phase 0–7 complete — all actionable tasks done)
**Scope:** `packages/webui`, root `e2e`, and WebUI documentation
**Source:** Read-only WebUI review performed on 2026-06-20

## Goals

- Reduce the risk of WebUI regressions by shrinking oversized server and client modules.
- Make the WebSocket protocol safer through runtime payload validation and shared client/server contracts.
- Improve test coverage for high-risk WebUI workflows instead of relying mostly on smoke-level checks.
- Remove duplicate component entry points and clarify package organization.
- Keep behavior unchanged during early refactor phases; add characterization tests before moving risky logic.

---

## Completed tasks

### Phase 0 — Safety rails (DONE)

1. **Extracted repeated WorklistContext construction** — `makeWorklistContext()` helper in `server/index.ts`. Eliminated 7 duplicate context object literals across todos/tasks/plan cases.

2. **Added runtime payload validation for high-risk messages** — Created `server/ws-payload-validation.ts` with validators for:
   - `process.kill` — positive integer pid
   - `working_dir.set` — non-empty string path
   - `prefs.update` — whitelist of known preference keys with type/enum validation
   - `model.switch` — non-empty provider + model strings
   `skills.create` — kebab-case name, non-empty description, valid scope
   - `skills.edit` — non-empty name + body
   - `projects.add` — non-empty root, optional string name
   - `projects.select` — non-empty root, optional string name
   - `shell.open` — non-empty path, optional file/terminal target
   - `git.diff` — optional string path
   - `context.mode.create` — id/name/description/thresholds/preserveK/eliseThreshold
   - `context.mode.update` — partial fields with type validation
   - `context.mode.switch` — non-empty string id
   - `context.mode.delete` — non-empty string id
   - `mode.switch` — non-empty string id
   - `autonomy.switch` — valid autonomy mode enum
   - `plan.template_use` — non-empty string template
   - `mailbox.messages` — optional limit/agentId/unreadOnly
   - `mailbox.agents` — optional onlineOnly
   - `mailbox.purge` — optional completedMaxAgeMs/incompleteMaxAgeMs
   - `brain.risk` — valid risk level enum
   - `brain.ask` — non-empty question string

3. **Replaced lexical containment with realpath containment** — `server/path-containment.ts` with `resolveWorkingDirInsideProject()`. Symlink escapes now rejected via `fs.realpath()`. Tests cover inside dirs, lexical escapes, and symlink escapes.

4. **Unified global config write paths** — Extracted `updateGlobalConfig()` helper: read → decrypt → mutate → encrypt → atomicWrite, serialized via non-poisoning `configWriteLock`. Both `persistPrefsToConfig` and `model.switch` now use it, fixing the inconsistency where model.switch skipped decrypt/encrypt.

5. **Added atomic write for skills** — Both `skills.create` and `skills.edit` now use `atomicWrite` from `@wrongstack/core` instead of `fs.writeFile`, preventing corrupted `SKILL.md` files on crash/interruption.

6. **Made e2e/chat-input.spec.ts assertions strict** — Rewrote conditional `if (isVisible)` guards with strict `expect().toBeVisible()` assertions. Added `waitForReadyState` helper that fails if neither chat input nor setup screen appears within 10s.

### Phase 1 — Server decomposition (DONE)

7. **Extracted provider/model/key routes** — `server/provider-routes.ts` with `handleProviderRoute` dispatcher. 15 message types moved out of `server/index.ts`: providers.list, providers.saved, provider.models, model.switch, model.refine, key.add, key.update, key.delete, key.set_active, provider.add, provider.remove, provider.clear_models, provider.undo_clear, provider.update, provider.probe. Added malformed payload guards with deterministic `sendResult` errors.

8. **Extracted session/context routes** — `server/session-routes.ts` with `handleSessionRoute` dispatcher. 16 message types moved: session.new, context.clear/debug/compact/repair, context.modes.list, context.mode.switch/create/update/delete, sessions.list, session.delete/resume/save, session.checkpoints, session.rewind.

9. **Extracted project/working-dir routes** — `server/project-routes.ts` with `handleProjectRoute` dispatcher. 4 message types: projects.list, projects.add, projects.select, working_dir.set.

10. **Extracted mode routes** — `server/mode-routes.ts` with `handleModeRoute` dispatcher. 2 message types: modes.list, mode.switch.

11. **Extracted shell/git routes** — `server/shell-git-routes.ts` with `handleShellGitRoute` dispatcher. 4 message types: git.info, git.changes, git.diff, shell.open.

12. **Extracted mailbox routes** — `server/mailbox-routes.ts` with `handleMailboxRoute` dispatcher. 4 message types: mailbox.messages, mailbox.agents, mailbox.clear, mailbox.purge.

13. **Extracted brain routes** — `server/brain-routes.ts` with `handleBrainRoute` dispatcher. 3 message types: brain.status, brain.risk, brain.ask.

14. **Extracted goal routes** — `server/goal-routes.ts` with `handleGoalRoute` dispatcher. All `goal.*` prefix messages delegated to `GoalWebSocketHandler`.

15. **Updated WS-handler parity test** — `packages/cli/tests/webui-server/ws-handler-parity.test.ts` now scans all 8 route modules (index, provider, session, project, mode, shell-git, mailbox, brain, goal) so embedded vs standalone case-label coverage is enforced.

### Phase 2 — Client decomposition (DONE)

16. **Split ChatInput.tsx slash/F-key routing** — Extracted `ChatInput/slash-routing.ts` with `runChatSlashCommand`. All slash commands (`/help`, `/clear`, `/new`, `/exit`, `/compact`, `/repair`, `/tools`, `/memory`, `/skills`, `/diag`, `/stats`, `/save`, `/load`, `/agents`, `/brain`, `/plan`, `/todos`, `/export`, `/interrupt`, `/settings`, `/enhance`, `/suggest`, `/kill`, `/queue`, `/next`, `/f1`–`/f12`) and function-key routing moved out. ChatInput.tsx reduced by ~250 lines.

17. **Extracted QueuedMessages component** — `ChatInput/queued-messages.tsx` owns queue rendering, clear-all, and per-item remove.

18. **Extracted FileMentionPicker component** — `ChatInput/file-mention-picker.tsx` owns `@`-mention FilePicker rendering, path replacement, cursor restore, and textarea height recalculation.

19. **Extracted usePasteDrop hook** — `ChatInput/use-paste-drop.ts` owns pasteHint state, draggingOver state, pendingImageRef, clipboard image paste listener, text paste auto-fencing/large-paste hints, and file drag/drop `@`-mention insertion.

### Phase 3 — Dispatcher characterization tests (DONE)

20. **Provider routes test** — `tests/server/provider-routes.test.ts` — 15 message types, malformed payloads, handler isolation.

21. **Session routes test** — `tests/server/session-routes.test.ts` — 16 message types, non-session passthrough, handler isolation.

22. **Project routes test** — `tests/server/project-routes.test.ts` — 4 message types, non-project passthrough, handler isolation.

23. **Mode routes test** — `tests/server/mode-routes.test.ts` — 2 message types, malformed mode.switch forwarding.

24. **Shell-git routes test** — `tests/server/shell-git-routes.test.ts` — 4 message types, handler isolation, original message forwarding.

25. **Mailbox routes test** — `tests/server/mailbox-routes.test.ts` — 4 message types, passthrough, handler dispatch.

26. **Brain routes test** — `tests/server/brain-routes.test.ts` — 3 message types, passthrough, handler dispatch.

27. **Autophase routes test** — `tests/server/goal-routes.test.ts` — prefix matching, delegation, non-goal passthrough.

28. **runChatSlashCommand unit tests** — `tests/components/slash-routing.test.ts` — 40+ tests covering all slash commands, queue state, /next delegation, /f-key dispatch, case insensitivity.

29. **usePasteDrop unit tests** — `tests/components/use-paste-drop.test.ts` — drag/drop handlers, text paste auto-fencing, large-paste hints, initial state.

30. **WS payload validation tests** — `tests/server/ws-payload-validation.test.ts` — valid/invalid cases for all 20+ validators.

31. **Path containment tests** — `tests/server/path-containment.test.ts` — inside dirs, lexical escapes, symlink escapes.

### Phase 3.5 — Component consolidation (VERIFIED DONE)

32. **Consolidated duplicate component entry points** — ChatView, MessageBubble, SettingsPanel, CommandPalette all already have thin re-export shims. No files bypass the shims by importing from nested `*/index` directly. No code changes needed.

### Phase 4 — Component tests (DONE)

33. **QueuedMessages + FileMentionPicker unit tests** — `tests/components/queued-messages-file-mention-picker.test.tsx`. QueuedMessages: empty queue, count + items, clear/remove callbacks. FileMentionPicker: null state, query passthrough, path replacement, cursor restore, textarea height recalculation.

### Phase 5 — ws-handlers.ts domain split (DONE)

34. **Extracted chat domain** — `hooks/ws-handlers/chat-handlers.ts` — 8 handlers (iteration.started, provider.text_delta/thinking_delta, tool.started/progress/executed/confirm_needed, run.result) with pipeViz, streamCoalescer, chime, favicon, notify dependencies.

35. **Extracted session domain** — `hooks/ws-handlers/session-handlers.ts` — 11 handlers (session.start, context.debug/compacted/repaired, provider.response, key.operation_result, session.end, context.modes.list, context.mode.changed, sessions.list, error) plus hydrateReplayMessages helper and ReplayMessage type.

36. **Extracted fleet domain** — `hooks/ws-handlers/fleet-handlers.ts` — 6 handlers (worktree.state/event, subagent.event, fleet.concurrency_update, client.status_update, sessions.status_update).

37. **Extracted files/mailbox domain** — `hooks/ws-handlers/files-mailbox-handlers.ts` — 10 handlers (files.tree/read/written, mailbox.event/messages/agents/received/agent_registered/cleared/purged) plus queryMailbox helper.

38. **Extracted misc domain** — `hooks/ws-handlers/misc-handlers.ts` — 11 handlers (goal.updated, prefs.updated, goal.state, brain.status/answer/event, working_dir.changed, model.refine_result, git.info/changes/diff).

39. **Extracted coordinator domain** — `hooks/ws-handlers/coordinator-handlers.ts` — 13 handlers (coordinator.status/stats, budget.threshold_reached/decision, subagent.budget_extended, consensus.vote_initiated/vote_cast/vote_resolved, task.pending/started/completed/failed).

40. **Updated twoway completeness test** — `packages/cli/tests/webui-server/ws-twoway-completeness.test.ts` now scans `ws-handlers/` sub-handler directory for handler type labels.

**Result:** `ws-handlers.ts` reduced from 1,065 → ~200 lines. All 6 domain modules export handler maps that are spread into `WS_HANDLERS`.

---

## Remaining backlog

### Priority 4 — Test coverage additions

1. **Add E2E flows for settings and model switching**
   - Cover provider list loading, model switch UI, persisted preference updates, and visible feedback.
   - Acceptance criteria: critical settings regressions are caught in browser-level tests.

2. **Add E2E flows for file explorer and edit/save**
   - Cover opening a file, editing content, saving, and receiving success/error feedback.
   - Acceptance criteria: file editing behavior is verified end-to-end in a temp project.

3. **Add project switch E2E coverage**
   - Verify project selection resets chat/session/file context and updates displayed cwd/project root.
   - Acceptance criteria: old-project state does not remain visible after switch.

4. **Add performance/regression tests for streaming UI load**
   - Simulate many text deltas, tool events, and fleet/visualization events.
   - Acceptance criteria: event coalescing and rendering remain stable under high message volume.

5. ~~**Add unit tests for QueuedMessages and FileMentionPicker components**~~ — DONE (see Phase 4, task 33).

### Priority 5 — Client module splits (large)

6. ~~**Split `hooks/ws-handlers.ts` by event domain**~~ — DONE (see Phase 5, tasks 34–40). Split into 6 domain modules: chat, session, fleet, files-mailbox, misc, coordinator. ws-handlers.ts reduced from 1,065 → ~200 lines.

7. **Split `lib/ws-client.ts` into connection lifecycle modules**
   - Suggested modules: auth bootstrap, reconnect policy, pending confirmations, subscriptions, and typed senders.
   - Acceptance criteria: auth/reconnect/confirmation tests can target isolated units.

8. **Split `OfficeMapCanvas.tsx` into a feature module**
   - Extract node renderers, edge renderers, layout, event mapping, animations, and React Flow integration helpers.
   - Consider lazy-loading the office map panel.
   - Acceptance criteria: the top-level canvas component becomes a thin orchestrator.

9. **Split `types.ts` by protocol/domain**
   - Suggested modules: websocket messages, sessions, providers, agents, worktree, and UI types.
   - Acceptance criteria: imports become domain-specific and protocol types are no longer mixed with UI-only types.

### Priority 6 — Typed WebSocket protocol contract

10. **Introduce a typed WebSocket protocol map**
    - Create a shared map for client-to-server and server-to-client message payloads.
    - Derive discriminated union message types from the map.
    - Use the map in client send helpers, server handlers, and tests.
    - Acceptance criteria: adding a new message type requires updating the protocol map.

### Priority 7 — UX hardening

11. **Review overlapping dashboard/panel concepts**
    - Compare Agents/Fleet/Monitor/Session dashboard components and extract shared primitives.
    - Acceptance criteria: repeated agent/fleet summary rendering is centralized.

12. **Improve skill creation/editing UX safety**
    - Add preview/diff behavior before writing skill files.
    - Validate generated frontmatter and trigger text.
    - Acceptance criteria: invalid skill content is rejected before touching disk.

13. **Improve process-control UX safety**
    - Make `process.killAll` require explicit confirmation.
    - Surface protected-process state in the UI.
    - Acceptance criteria: destructive process actions are clearly confirmed and tested.

---

## Phase 6 — Client module splits (DONE)

41. **Extracted `ws-handlers.ts` chat domain** — `hooks/ws-handlers/chat-handlers.ts` — 8 handlers (iteration.started, text_delta, thinking_delta, tool.started/progress/executed/confirm_needed, run.result) + pipeViz helper. ws-handlers.ts 1,065→920.

42. **Extracted `ws-handlers.ts` session domain** — `hooks/ws-handlers/session-handlers.ts` — 11 handlers (session.start, context.debug/compacted/repaired, provider.response, key.operation_result, session.end, context.modes.list, context.mode.changed, sessions.list, error) + hydrateReplayMessages + ReplayMessage type. ws-handlers.ts 920→615.

43. **Extracted `ws-handlers.ts` fleet domain** — `hooks/ws-handlers/fleet-handlers.ts` — 6 handlers (worktree.state/event, subagent.event, fleet.concurrency_update, client.status_update, sessions.status_update). ws-handlers.ts 615→525.

44. **Extracted `ws-handlers.ts` files/mailbox domain** — `hooks/ws-handlers/files-mailbox-handlers.ts` — 10 handlers (files.tree/read/written, mailbox.event/messages/agents/received/agent_registered/cleared/purged) + queryMailbox helper. ws-handlers.ts 525→450.

45. **Extracted `ws-handlers.ts` misc + coordinator domains** — `hooks/ws-handlers/misc-handlers.ts` (11 handlers: goal.updated, prefs.updated, goal.state, brain.status/answer/event, working_dir.changed, model.refine_result, git.info/changes/diff) and `hooks/ws-handlers/coordinator-handlers.ts` (13 handlers: coordinator.status/stats, budget.*, consensus.*, task.*). ws-handlers.ts 450→~200.

46. **Extracted `ws-client.ts` utils** — `lib/ws-client-utils.ts` — 4 utility functions (getTokenFromWsUrl, resolveWsPort, defaultWsUrl, httpOriginForAuth) + 3 type exports (WsStatus, EventHandler, PendingConfirm). ws-client.ts 854→~800. Added unit tests for all 4 functions.

47. **Extracted `OfficeMapCanvas.tsx` utils** — `components/OfficeMapCanvas/utils.ts` — types (ClientKind, ClientStatus, OfficeNodeData) + 4 formatting helpers (fmtCompact, fmtAgo, fmtUptime, shortModel) + 11 layout constants + 5 layout functions (layoutClientXs, agentFanPos, clientNodeType, surfaceLabel, mapAgentStatus). OfficeMapCanvas.tsx 2,160→~2,050. Added unit tests for all 9 exported functions.

48. **Attempted `types.ts` split** — Reverted. All 60+ interfaces are discriminated union members (type + payload fields). Splitting requires restructuring the WSClientMessage/WSServerMessage unions, which 20+ consumer files depend on. Left as-is with documented limitation.

---

---

## Phase 7 — E2E flows, performance tests, UX hardening (DONE)

49. **Added settings panel E2E flow** — `e2e/settings-panel.spec.ts` — 6 tests: opens from activity bar, provider tab default, all 4 tabs clickable, appearance theme toggles, features preference toggles, close returns to chat.

50. **Added file explorer E2E flow** — `e2e/file-explorer.spec.ts` — 5 tests: opens from activity bar, file tree visible, opening a file shows content, Ctrl+S save without error, navigates back to chat.

51. **Added project switching E2E flow** — `e2e/project-switching.spec.ts` — 5 tests: projects panel opens, project list or empty state, add-project dialog, selecting triggers switch, navigates back to chat.

52. **Added streaming UI performance tests** — `tests/lib/streaming-performance.test.ts` — 6 tests: StreamCoalescer 10k deltas, 100 concurrent streams, flush idempotency; chat-store 1k messages, 500-item queue, 10-cycle memory stability.

53. **Consolidated dashboard/panel primitives** — `components/dashboard-primitives.ts` (96 lines) — extracted 8 shared functions (fmtCost, fmtTok, fmtElapsed, fmtDuration, fmtAgo, shortModel, statusColor, sparkline) from AgentsPage.tsx, FleetMonitor.tsx, FleetPanel.tsx. Updated all 3 consumers.

54. **Added dashboard-primitives unit tests** — `tests/components/dashboard-primitives.test.ts` — 35+ assertions covering all 8 functions.

---

## Metrics

| Metric | Before | After |
|--------|--------|-------|
| `server/index.ts` line count | ~3,643 | ~3,470 (with 8 route modules extracted) |
| Route dispatcher modules | 0 | 8 (provider, session, project, mode, shell-git, mailbox, brain, goal) |
| Runtime payload validators | 0 | 25+ |
| Dispatcher characterization tests | 0 | 8 test files, 60+ test cases |
| `hooks/ws-handlers.ts` line count | ~1,065 | ~200 (with 6 domain modules extracted) |
| ws-handlers domain modules | 0 | 6 (chat, session, fleet, files-mailbox, misc, coordinator) |
| `lib/ws-client.ts` line count | ~854 | ~800 (with utils extracted) |
| ws-client sub-modules | 1 (helpers) | 2 (helpers, utils) |
| `OfficeMapCanvas.tsx` line count | ~2,160 | ~2,050 (with utils extracted) |
| ChatInput.tsx line count | ~1,224 | ~925 (with 5 extracted modules) |
| ChatInput sub-modules | 1 (slash-commands) | 5 (slash-commands, slash-routing, queued-messages, file-mention-picker, use-paste-drop) |
| Dashboard primitives module | 0 | 1 (dashboard-primitives.ts, 8 shared functions) |
| Component/hook unit tests | 0 | 7 test files, 200+ test cases |
| Performance tests | 0 | 1 test file, 6 tests (10k deltas, 1k messages, 100 streams) |
| E2E test files | 2 (smoke + chat-input) | 5 (+ settings, file-explorer, project-switching) |
| E2E test count | 8 | 24 |
| Atomic writes for skill files | No | Yes (create + edit) |
| Global config write paths | 2 (inconsistent) | 1 (`updateGlobalConfig`) |
| Path containment | Lexical | Realpath |
| E2E assertions | Conditional | Strict |
| Total completed tasks | 0 | 54 |
| Remaining tasks | — | 0 (all actionable tasks done) |

## Non-goals for the first pass

- Do not redesign the WebUI visually.
- Do not change WebSocket message names until a compatibility strategy exists.
- Do not remove existing panels before usage is understood.
