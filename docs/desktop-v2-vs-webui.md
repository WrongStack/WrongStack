# Desktop v2 vs WebUI — Historical parity ledger

For the **1.5.6 review and current acceptance**, start with the [current action matrix](desktop-v2-review-2026-11-10.md#current-action-matrix). The sections below preserve the dated comparison and implementation receipts through November 8. Their version, feature and validation statements belong to those checkpoints.

Updated: **2026-11-08**. Original comparison baseline: **`745d85fe8`**; implementation and validation were performed on the shared `main` checkout.
The shared checkout continued to advance independently during validation; native evidence is
identified by the tested portable hashes, rather than inferred from HEAD.
Both frontend manifests now identify **1.5.2**. The Nov 7 immutable native acceptance package remains a separate, earlier snapshot. This implementation preserves pre-existing work in
the native engine/HTTP bridge, context/refinement, core/MCP/provider code and documentation/tooling.
This validation agent did not commit, reset, stash, push or publish. Another agent independently restored and committed saved change groups; those commits are not acceptance evidence.

This is a **source comparison and implementation ledger**. Local tests, browser checks and native
acceptance are reported separately below; none constitutes release certification. “Source-confirmed gap” below means a concrete difference in the inspected
production paths; it does not mean a reproduced runtime defect.

## 1. Current assessment

**Desktop v2 has the major WebUI screens and considerably more implementation than the
2026-11-04 report described. Full action-level parity is still not established.**

The current catalog maps **32/32 WebUI views, 7/7 activities and 16/16 settings tabs**, without
duplicate mappings. The **7 WebUI dock sections** were separately mapped to reachable
native surfaces in the source comparison below; the automated catalog parity test does not
compare dock sections. These counts measure navigation coverage, not completed workflows.

The implementation round addresses the following original differences:

- Conversation-local **Chimera report actions** and **non-council Brain decision cards**.
- **Message pinning**, richer **tool/ToolFlow summaries**, and the **performance-round card**.
- **Transcript virtualization** and **shared-surface scroll restoration**.
- Some **recovery diagnostic fields** and **background-service auto-heal feedback**, despite
  the existing native reconnect and service-control screens.

No overall completion percentage is justified. A shared screen, registered command or saved
setting does not prove its transport, restart behavior, permission handling or error path.

The continuation document's “code-complete against the WebUI” statement is broader than the
evidence in this report. The original gap descriptions below explain the implementation work; their present status is
recorded in the dated implementation and acceptance entries, rather than inferred from those
historical descriptions. Older backlog entries also describe work that has since landed.

### Latest acceptance checkpoint

**Package boundary:** current receipts below belong to the protected 1.5.2 snapshot and checksum-named portable. Older Nov 7 packages remain historical evidence. Later shared-main edits are not certified by these receipts.

| Area | Current result | Still required |
| --- | --- | --- |
| Original gaps G01–G11 and CLI/TUI preference mirrors | Implemented; dated native scenarios below identify the exercised behavior | Finish the remaining current-package acceptance scopes |
| File tree refresh bursts | Component RED 3 concurrent reads → GREEN 1; fresh follow-up/close/StrictMode tests PASS; full315-file/1124-test suite PASS; post-fix native Files workflow PASS on current1.5.2 | Historical runtime exit causes are separate from the refresh fix |
| Current native package | 1.5.2 normal guarded rebuild PASS: `52d3697b278a-c86179698276`; source fingerprint `51ef9be5bf2a8894fb1bc9a92e97346ef3e7b46f043ea3d45e63036157fab462`; both binary checksums and engine version verified; prior portables preserved | This certifies the protected source snapshot, not later main edits |
| Real Office/Story workers | Current c861 engine paid and missing-price worker producer probes PASS 3/3 each. Prior 9e83 native paid/unpriced Office ownership/reload controls passed | Current 1.5.2 native Office controls remain separate from producer proof |
| Worker pricing | Current c861 bundled-engine paid-worker proof PASS 3/3 | Current native Office projection/reload acceptance |
| Unknown worker prices | Current c861 missing-rate worker proof PASS 3/3; missing rates stay unavailable, explicitly free models retain USD 0 | Current native unavailable-cost/no-combined-total/owner acceptance; historical missing spend is not reconstructed |
| Windows process teardown | Earlier Kit/descendant leak proofs PASS. Native taskkill false failure reproduced and fixed; standalone Windows proof 4/4 and full native Rust library 38/38 PASS; format PASS | Five focused suites PASS (61 tests, tracked hashes stable); guarded 9002 build PASS; paid and unpriced Office session-stop/foreign-owner checks PASS on that package |
| Pre-package source checks | Current protected Desktop production types PASS (754 files); complete suite PASS (315 files / 1124 tests, unchanged Desktop inputs); fixture follow-up PASS (3 files / 87 tests); test-type ratchet PASS (44 projects, 0 new, 1032 present / 1920 allowed baseline; baseline unchanged) | Full uncached root coverage certification remains incomplete |
| Root coverage | R5 stopped without final coverage summary; 47 inputs changed concurrently. Both observed Kanban failures subsequently PASS on unchanged current inputs (10/10) | Completed current-source coverage run; no coverage percentages are available |
| Full native matrix | Current 1.5.2 retry: Files PASS (1/43 at checkpoint), 0 failed, Roster active. Approved G Hub restart raised available commit from 10.82 to 28.89 GiB. First low-memory failure retained | Finish the other 42 scopes and extra unpriced Office variant; no 43/43 PASS claimed |
| Configured providers | All six real completions PASS on current c861 bundled engine: MiniMax, ZAI, Alibaba, OpenCode, ChatGPT and xAI | Provider quality beyond smoke completions is separate |
| Physical microphone | OS speech availability/button mapping PASS | Actual acoustic Dictate acceptance remains open; typed or synthetic input is not microphone proof |

Latest detailed repair evidence is recorded at the end of this report and under
`.temp_files/desktop-parity-finish/`. No overall parity or release completion is claimed.

### WebUI dock source comparison

| WebUI dock | Reachable Desktop counterpart | Evidence boundary |
| --- | --- | --- |
| Goal | ProjectGoals | Project-owned run controls |
| Goal State | ProjectMission inside ProjectGoals | Persistent set/pause/resume/refine/clear, expected-mission protection |
| Fleet | AgentTranscripts; ProjectOffice / ProjectLiveFleet | Conversation and project ownership remain distinct |
| Work | SessionTodos + SessionWorklist | Live plan/task updates; bound Kanban todos stay board-managed |
| Worktrees | ProjectWorktrees | Project workspace entry point |
| Collab | SessionActivity + SessionCollab | Selected native engine owns the shared surface |
| Browser | SessionBrowser | Session frame/selection and console/network details; viewing sends no page input |

All seven have source-level counterparts. This mapping does not certify every
action or ownership edge on the latest native artifact.

## 2. Rechecked: old missing-feature claims that are now closed

“Implemented” in this table refers to source integration, with native evidence stated separately.

| Old gap | Current Desktop v2 implementation and reachability | Remaining boundary |
| --- | --- | --- |
| Full analytics dashboard absent | [ProjectAnalytics](../apps/desktop-v2/src/ProjectAnalytics.tsx) mounts the shared [AnalyticsDashboard](../packages/project-surfaces/src/analytics/AnalyticsDashboard.tsx); [ProjectWorkspace](../apps/desktop-v2/src/ProjectWorkspace.tsx) has an actual analytics route | Dashboard exists. Event/category data is a separate instrumentation issue; the validation log records that neither client feeds that event buffer |
| Language-aware editor and engine completion absent | [FileWorkspace](../apps/desktop-v2/src/FileWorkspace.tsx) mounts [CodeEditorSlot](../apps/desktop-v2/src/CodeEditorSlot.tsx), which loads [MonacoFileEditor](../apps/desktop-v2/src/MonacoFileEditor.tsx); it registers language completion providers and sends `completion.request` | Plain editor is an explicit preference/failure fallback, not the only implementation. Live completion quality and cancellation need native/provider evidence |
| Editable side-by-side diff absent | [DiffPreview](../apps/desktop-v2/src/DiffPreview.tsx) loads [MonacoDiffEditor](../apps/desktop-v2/src/MonacoDiffEditor.tsx); Apply uses version-bound `saveFileVersion` | Native gap-closing run is recorded as passed; broader external-writer cases remain acceptance work |
| Participant collaboration absent | [EngineWorkspace](../apps/desktop-v2/src/EngineWorkspace.tsx) supplies [SessionCollab](../apps/desktop-v2/src/SessionCollab.tsx) to Activity; it mounts the shared CollabPanel through [collabClient](../apps/desktop-v2/src/session-collab-model.ts) | Roles/actions are engine-governed. Two actual participants, role refusal and reconnect are separate acceptance cases; this is no longer an absent identity UI |
| Office fleet/transcript/tool feeds always empty | [ProjectOffice](../apps/desktop-v2/src/ProjectOffice.tsx) watches live project conversations and passes [merged fleet state](../apps/desktop-v2/src/office-fleet.ts) into [desktopOfficeFeed.setFleet](../apps/desktop-v2/src/desktop-office-feed.ts) | Feed scope is the project's live native conversations. Do not assume identical retention or the same population as WebUI's active fleet |
| Story roster always empty | [desktopStoryFeed.useAgents](../apps/desktop-v2/src/desktop-story-feed.ts) reads the conversation's `state.fleet.agents` | Context entry routing differs by design; see section 4 |
| Recovery diagnostics entirely absent | [ProjectDiagnostics](../apps/desktop-v2/src/ProjectDiagnostics.tsx) adds [ConnectionDiagnostics](../apps/desktop-v2/src/ConnectionDiagnostics.tsx): engine status, journal progress, restored message count, recorded session, last frame, storage and reconnect | A native counterpart exists; some WebUI diagnostic comparisons are still absent (G08) |
| SAGE validity/companion review missing | [desktopSurfaceHost](../apps/desktop-v2/src/desktop-surface-host.ts) reads [MemoryReviewStore](../apps/desktop-v2/src/memory-reviews.ts) and follows live `memory.event` frames | Project/profile ownership and the conversations read by this window still delimit available reviews |
| Font, text-size and status-bar customization missing | [AppearanceFonts](../apps/desktop-v2/src/AppearanceFonts.tsx) and [AppearanceSettings](../apps/desktop-v2/src/AppearanceSettings.tsx) provide UI/code fonts, ligatures, zoom and chip preferences | Native gap-closing acceptance is recorded; this is not a missing appearance screen |
| Saved SDD graph cannot be run directly | [ProjectSdd](../apps/desktop-v2/src/ProjectSdd.tsx) sends `sdd.run.from_graph` when the saved graph is selected | Real model/run combinations remain execution acceptance |
| Slash commands limited to a static desktop subset | [desktop-engine-commands](../apps/desktop-v2/src/desktop-engine-commands.ts) discovers `command.list` and runs `command.run`; desktop-owned names take precedence | Command invocation exists. Terminal-only behavior and host-specific hooks are not identical, and textual command output does not imply rich UI rendering |

The newest relevant repository evidence is
[Native acceptance of the gap-closing round](desktop-v2-validation.md#native-acceptance-of-the-gap-closing-round-2026-11-05):
`--gaps --release --bundled` **PASS**, no renderer errors, covering engine commands, analytics
navigation, applying a Monaco diff, fonts/zoom and status chips. This is **historical recorded
evidence**, not a run performed on the snapshot above. It supersedes the earlier “pending native
run” sentence in that log and the corresponding pending list in the continuation document.

## 3. Implementation status and original gap ledger

IDs are stable for follow-up reviews. Priority is proposed implementation order, not bug severity.
The nine original source gaps have implementations in the working tree. **Implemented does not mean
every native lifecycle acceptance case has passed.** Additional settings differences G10/G11 now have working-tree implementations and a passing
native display-preference scope. The combined native Chimera producer/card/follow-up scope now passes; see section 8 for its fixture and external-model limits. The detailed observations below this table
describe the original baseline, retained so that IDs and acceptance conditions remain auditable.

| ID | Delivered implementation | Current evidence / remaining acceptance |
| --- | --- | --- |
| G01 | [Conversation report card](../apps/desktop-v2/src/ChimeraMessageCard.tsx), session-scoped reducer, deduplicated replay, report-specific navigation and saved-composer follow-up | Native recorded notification → journal/card → exact report → preserved draft → reload → real refined send/receipt PASS; duplicate/foreign reports refused. Combined automatically generated review → native card/detail/refined-send acceptance now PASS (section 8); external-model quality remains separate |
| G02 | [Brain message projection](../apps/desktop-v2/src/brain-message.ts) and [native card](../apps/desktop-v2/src/BrainMessageCard.tsx) for answered/denied/human/intervention/check, including historical Markdown fallback | Model/render tests, session isolation and existing council tests; real native deterministic arbiter answer/denial events PASS. External-provider quality and human/intervention paths remain separate |
| G03 | [Conversation-owned message pins](../apps/desktop-v2/src/message-pins.ts), pin/unpin and a navigable pinned-message list | Project/native-session storage scope, reload persistence and bounded validation; native results recorded in section 6 |
| G04 | WebUI's [ToolCallOverview](../packages/project-surfaces/src/tools/ToolCallOverview.tsx) and [ToolFlowOverview](../packages/project-surfaces/src/tools/ToolFlowOverview.tsx) now render from the shared package in both apps | Desktop activity retains full details; existing WebUI tests and native activity render tests cover summaries/ToolFlow byte metrics |
| G05 | [TranscriptVirtualizer](../apps/desktop-v2/src/TranscriptVirtualizer.tsx) replaces growing message DOM pages; index-based find/pin navigation, focused-row retention and always-mounted approval/question footer | Real Chromium fixture: 10,000 messages, 11 initially mounted message rows, offscreen find/focus/append/approval checks. Native performance scope PASS: 3,000-line answer, explicit scroll workload, large file tree and terminal load. Browser 10,000-message history is separate from native large-history lifecycle coverage |
| G06 | [Surface scroll restoration](../apps/desktop-v2/src/surface-scroll.ts) on project and profile hosts; separate reader/surface/inspector storage keys, delayed-content restoration and cleanup | Browser project-A/project-B revisit test; sessionStorage plus bounded window-memory fallback. Full native inspector/theme/layout matrix remains open |
| G07 | [Shared performance marker parser](../packages/project-surfaces/src/lib/perf-run-message.ts) and native performance-round card | Valid, malformed and historical rendering tests; WebUI keeps the same parser via re-export |
| G08 | Host `engine.identity` vs journal Core-ID comparison; saved layout pointers; read-only comparison of all four window/native draft revisions | Pending/unreadable/saving states stay unknown rather than false matches. Comparison tests and native results below; cross-window concurrent-write stress not rerun |
| G09 | [Per-service auto-heal state](../apps/desktop-v2/src/service-healing.ts), phase/result/refusal feedback, health refresh and manual-control gating | Older events rejected; per-service states retained; stale restart no longer blocks controls indefinitely. Real test-owned Kanban crash → offline → next-use healthy replacement PASS. Real watchdog restart/error/host-policy-refusal → native reducer PASS; mounted native panel states and controls PASS. Packaged native repair/failure/manual recovery PASS after fixing lost health/control acknowledgements; recorded refusal/expiry are separately labeled |

The following subsections record **pre-implementation observations and original close conditions**.
They are deliberately narrower than “Chimera missing”, “Brain missing” or “chat not implemented”.

### G01 — P1 — Conversation-local Chimera report follow-up

- **WebUI:** [ChatRowView](../packages/webui/src/components/ChatView/ChatRowView.tsx) selects
  [ChimeraReportCard](../packages/webui/src/components/ChatView/ChimeraReportCard.tsx).
  The card opens the specific report in the hub and submits a report-specific follow-up to the
  owning conversation, with busy/sent gating. [ChatView](../packages/webui/src/components/ChatView/index.tsx)
  requests persisted reports when the session is hydrated.
- **Desktop at baseline:** [TranscriptMessage](../apps/desktop-v2/src/TranscriptMessage.tsx) has council,
  Markdown/source, user references/hunt cards and attachments, but no Chimera report branch.
  [ChatMessage / engine reducer](../apps/desktop-v2/src/engine-state.ts) has no report/actioned
  message field. [ProjectChimera](../apps/desktop-v2/src/ProjectChimera.tsx) exists separately.
- **Impact:** the project review workspace does not supply the same durable, actionable report
  inside the reviewed conversation. This is a missing conversation integration, not an absent
  review engine.
- **Close when:** live and replayed reports appear once in the owning conversation; open-report
  targets the correct report; an explicit follow-up respects the desktop's draft/refinement/send
  contract; busy, refusal, repeated click, restart and foreign-session cases are exercised.

### G02 — P2 — Non-council Brain decision presentation

- **WebUI:** [BrainDecisionCard](../packages/webui/src/components/ChatView/BrainDecisionCard.tsx)
  renders structured decisions and recognizes legacy/replayed Brain Markdown, exposing routing,
  risk, confidence and decision detail when supplied.
- **Desktop at baseline:** the [engine reducer](../apps/desktop-v2/src/engine-state.ts) folds `brain.event`
  through [reduceCouncil](../apps/desktop-v2/src/council-decisions.ts); transcript messages carry
  a council field, without a corresponding general Brain decision field/card.
  [BrainDecisions](../apps/desktop-v2/src/BrainDecisions.tsx) already provides a separate
  `brain.status` / `brain.ask` interface.
- **Impact:** non-council decision explanations lack the WebUI's conversation presentation.
  Council cards and Brain configuration must continue to count as implemented.
- **Close when:** supported non-council events/replayed decisions retain their structured facts
  in the right conversation; missing fields remain unknown; existing council rendering survives.

### G03 — P2 — Message pin/unpin

- **WebUI:** [MessageBubble](../packages/webui/src/components/MessageBubble/index.tsx) offers
  Pin/Unpin using [ui-store](../packages/webui/src/stores/ui-store.ts)'s `pinnedIds` and
  `togglePin`.
- **Desktop at baseline:** [TranscriptMessage](../apps/desktop-v2/src/TranscriptMessage.tsx) offers copy,
  prompt edit, newest-answer retry and source toggle, without message pin state or an action.
  Sidebar **session** pins are a different feature.
- **Close when:** a message can be pinned/unpinned and located again, with an explicit
  session/project ownership and restart policy, including unloaded earlier messages.

### G04 — P2 — Rich tool and ToolFlow overview

- **WebUI:** [ToolCallOverview](../packages/webui/src/components/MessageBubble/ToolCallOverview.tsx)
  classifies file/filesystem, command, VCS, verification, web, workflow, codebase, browser, E2E,
  language, package, observability, security, design and catalog work.
  [ToolFlowOverview](../packages/webui/src/components/MessageBubble/ToolFlowOverview.tsx) shows
  script description/source and measured output metrics.
- **Desktop at baseline:** [toolInputView](../apps/desktop-v2/src/tool-input-view.ts) specializes
  edit/write/bash/exec/read/grep/glob/replace. Other inputs fall back to
  [StructuredToolValue through ToolInputView](../apps/desktop-v2/src/ToolInputView.tsx).
  [SessionActivity](../apps/desktop-v2/src/SessionActivity.tsx) still provides real tool events,
  output, timing and navigation; generic rendering is not a missing execution path.
- **Close when:** an explicit tool-family matrix covers the missing summaries and ToolFlow
  metrics, while retaining lossless detail, failure states and correct agent/turn ownership.
  ToolFlow byte counts must not be presented as tokens, cost or speed.

### G05 — P1 — Transcript virtualization at scale

- **WebUI:** [ChatView](../packages/webui/src/components/ChatView/index.tsx) renders grouped rows
  through `virtua`'s `VList`, including index-based navigation to offscreen search results.
- **Desktop at baseline:** [EngineWorkspace](../apps/desktop-v2/src/EngineWorkspace.tsx) renders
  `state.messages.slice(hiddenMessages).map(...)`; [transcript-window](../apps/desktop-v2/src/transcript-window.ts)
  starts with 150 messages and “Show earlier” increases that rendered count. It does not evict
  offscreen rows as a virtual list would.
- **Impact:** paging limits the initial DOM, but loading/searching farther back can grow it.
  This is a structural scale difference; no measured performance regression is claimed here.
- **Close when:** a large mixed transcript has bounded mounted rows, stable scroll while
  streaming/loading older messages, correct find navigation, accessible focus and no loss of
  approvals/questions. Set and measure a native performance budget before claiming improvement.

### G06 — P2 — Shared-surface scroll restoration

- **WebUI:** [webuiSurfaceHost](../packages/webui/src/components/MemoryManager/webui-surface-host.ts)
  delegates `useScrollRestore` to `useScrollPosition`.
- **Desktop at baseline:** [desktopSurfaceHost](../apps/desktop-v2/src/desktop-surface-host.ts) returns a new
  ref without restoring a position. [ProjectWorkspace](../apps/desktop-v2/src/ProjectWorkspace.tsx)
  conditionally mounts project pages. Shared SAGE, analytics and diagnostics request this hook.
- **Impact:** sharing those components does not carry WebUI's revisit/scroll contract into the
  desktop host. Durable form drafts are a separate, already implemented concern.
- **Close when:** leaving and returning to the same project/surface/inspector restores the
  reader's position without leaking it to another project or selected item; reset behavior and
  large/loading datasets are covered. Native reproduction/acceptance is still required.

### G07 — P3 — Performance-round prompt card

- **WebUI:** [MessageBubbleCards](../packages/webui/src/components/MessageBubble/MessageBubbleCards.tsx)
  includes `PerfRunCard`; [perf-run-message](../packages/webui/src/lib/perf-run-message.ts)
  parses the round's marker into scope/mode/metric presentation.
- **Desktop at baseline:** [TranscriptMessage](../apps/desktop-v2/src/TranscriptMessage.tsx) recognizes hunt
  prompts but has no performance-round parser/card branch.
- **Impact:** the command bridge can expose a performance command without reproducing its
  compact transcript presentation. This is presentation parity, not missing command execution.
- **Close when:** marked performance prompts render a truthful scope/mode/metric card on live
  and replay paths, with safe fallback for malformed/ordinary text.

### G08 — P2 — Recovery diagnostic comparisons

- **WebUI:** [RefreshDebugView](../packages/webui/src/components/RefreshDebugView.tsx) shows
  bound-vs-selected session mismatch, persisted environment/view/dock values, hydration flags
  and transcript information.
- **Desktop at baseline:** [ConnectionDiagnostics](../apps/desktop-v2/src/ConnectionDiagnostics.tsx) shows
  native engine/journal/reconnect information, restored counts and storage size, but no explicit
  selected-native-session vs recorded-engine-session mismatch verdict or restored view/draft
  ownership comparison.
- **Impact:** the diagnostic UI is implemented, but its ability to expose wrong-session
  restoration is not equivalent. No actual session bleed was reproduced in this review.
- **Close when:** desktop-specific ownership checks explain mismatches after reload/restart
  without flagging legitimate native-ID/engine-ID differences, with two-project/two-window
  acceptance. Do not copy browser storage keys into a native design.
- **WebUI boundary:** its “Record probe” handler records a local note; it does **not** actually
  perform F5 or replay. A matching button alone is not an acceptance test.

### G09 — P2 — Background-service auto-heal progress

- **WebUI:** [ConnectionsHealthSection](../packages/webui/src/components/SettingsPanel/ConnectionsHealthSection.tsx)
  subscribes to `connections.auto_heal_status`, shows a per-service automatic-restart badge,
  displays success/failure/policy-refusal feedback and refreshes health on terminal events.
- **Desktop at baseline:** [BackgroundServices](../apps/desktop-v2/src/BackgroundServices.tsx) loads
  `connections.health`, refreshes after its own restart/shutdown actions and offers manual
  refresh. It does not subscribe to auto-heal phases or represent automatic-restart state.
- **Impact:** background repair has less immediate explanation in the native service screen.
  Health, restart, stop and restart-all already exist. This does not establish that the
  standalone engine runs the same auto-healer or that it cannot recover a service.
- **Close when:** confirm which auto-heal events the desktop engine emits, then expose its
  supported progress/result/policy-refusal states without stale busy badges or duplicate manual
  actions; exercise restart, refusal, error and a missing terminal event.
- **2026-11-06 verification:** the real watchdog and native feedback checks below pass.
  That earlier verification round did not reproduce a new production defect. The packaged Tauri journey was subsequently exercised below; it reproduced an
  acknowledgement defect that the earlier component tests did not cover.

## 4. Platform and host differences requiring an explicit decision

These are **not counted as missing features** without an agreed behavioral requirement.

| Difference | Current evidence | Decision / acceptance needed |
| --- | --- | --- |
| Story context entry | [Desktop Story](../apps/desktop-v2/src/desktop-story-feed.ts) deliberately returns an inactive context-request hook because the conversation opens Context directly; [WebUI Story](../packages/webui/src/components/MemoryManager/webui-story-feed.ts) reads `storyContextRequested` | Keep direct native Context navigation if it satisfies the same user task; do not reopen “empty Story roster” |
| Office population and retention | Desktop merges fleet state from live native conversations in the project; WebUI's [host](../packages/webui/src/components/MemoryManager/webui-surface-host.ts) reads its fleet/monitor/viz stores | Exercise multiple conversations, stop/restart and late events; distinguish current fleet from retained history |
| Host connection/back behavior | Desktop project host supplies `useConnected: () => true` and no navigate-back callback; ProjectContent separately gates on engine connection. WebUI reads socket state and navigates back to chat | Check disconnect during an already-open surface and native breadcrumb/back behavior. The constant alone is not proof that disconnected actions succeed |
| MCP task updates | Desktop polls its task list; WebUI subscribes, as recorded in the validation log | Compare latency, cancellation, task questions and restart ownership; polling itself is not missing functionality |
| Command confirmation and terminal hooks | Desktop arms a destructive command for a second send; WebUI uses a confirm dialog. Standalone `/tuneup` lacks CLI doctor/history/update hooks and refuses terminal-only `--pick` | Compare user-visible outcomes per host. `/coordinator` and `/shadow` are TUI-only boundaries, not WebUI parity gaps |
| Fonts and delivery | Desktop can select installed fonts and uses native zoom; WebUI has a bundled font catalog. Native install/update and browser hosting differ | Specify desired font choices and distribution requirements independently of navigation parity |

## 5. Coverage and work that must not be mistaken for confirmed WebUI-only gaps

| Domain inspected | Current Desktop baseline | Further review / execution evidence |
| --- | --- | --- |
| Setup, providers and settings | Shared setup/test/quota; dedicated provider/model/OAuth/health/policy editors; seven locale catalogs | G09; field-by-field settings comparison, actual OAuth refresh/vault writes, effective policy and model-route execution |
| Chat/composer | Draft recovery, queue/BTW/steer, refinement, context controls, images/PDFs, references, slash/engine commands, agent transcripts and council | G01–G05/G07; native multi-session stress, remaining per-tool presentation and live-provider media |
| Files/Git/worktrees | Monaco/completion, editable diff, native tree, staging/conflicts and managed worktrees | External writes, mode/binary/symlink/submodule handling, native editor focus/worker lifecycle |
| Memory/Kanban/Atlas/Office/Story | Shared surfaces with desktop host slots and real feed adapters | G06; host ownership, long histories, restart and real worker topology/control |
| Goals/SDD/intake/project intelligence | Existing native workspaces, graph runs, Kit, Design, TechStack, Dead Code and Chimera | Action-by-action comparison remains necessary; historical backlog text is not evidence an action is still absent |
| Automation/MCP/process/browser | Dedicated management, evidence/publication, tool/content/task and native process/browser interfaces | Real authorization/external execution, publication click-through, lifecycle stress and large catalogs |
| Usage/diagnostics | Shared analytics/debug, session cost/context and project/profile recorded usage, reconnect view | G08; historical billing attribution and worker-inclusive totals are accounting/acceptance work, not proof of a WebUI-only dashboard |
| Appearance/accessibility/locales | Fonts/zoom/status chips, themes and seven locale catalogs; dated native accessibility/performance evidence exists | Screen-reader/microphone and locale layout checks on the actual current binary; equal locale coverage does not prove every label is translated |

False positives were explicitly rejected during follow-up passes:

- **“Desktop file tree is not virtualized.”** [FileTreeView](../apps/desktop-v2/src/FileTreeView.tsx)
  renders a computed row slice. G05 concerns the conversation list, not the file tree.
- **“WebUI has inline PDF viewing but Desktop does not.”** WebUI's
  [AttachmentGallery](../packages/webui/src/components/MessageBubble/AttachmentGallery.tsx) also
  uses a named PDF chip. Desktop's lack of an embedded PDF viewer is not established as a
  WebUI-only capability. Likewise, “Today”/“Yesterday” are hardcoded in both inspected day-label
  helpers; this is not a Desktop-only localization finding.

- **“Mailbox maintenance and Chronicle facets are absent.”**
  [ProjectMailbox](../apps/desktop-v2/src/ProjectMailbox.tsx) sends clear/purge/compact through
  a computed `mailbox.${maintenance}` operation; [ProjectChronicle](../apps/desktop-v2/src/ProjectChronicle.tsx)
  uses the batched `chronicle.facets` operation. Literal string differences in a protocol scan
  are candidates for inspection, not proof of missing actions.

## 6. Verification performed for this update

Initial documentation review passes: **(1)** revisit every old concrete gap, **(2)** compare transcript/actions and host
contracts, **(3)** challenge absence claims against alternative native implementations and the
latest validation entries, **(4)** inspect protocol-string differences and settings/service-health
paths, rejecting dynamic-operation false positives. The following results are the **initial audit**,
before the implementation in section 3.

- **PASS:** Desktop `bun run typecheck` — **708 files**, no type errors, Bun **1.4.3**.
- **PASS:** Desktop focused existing tests — **13 files / 63 tests**:
  `feature-parity`, `desktop-slash-parity`, `desktop-engine-commands`,
  `desktop-story-feed`, `desktop-office-feed`, `office-fleet`, `session-collab`,
  `code-editor`, `reconnect`, `transcript-window`, `transcript-message`,
  `tool-input-view`, `surface-i18n` (under `apps/desktop-v2/tests/*.test.ts`).
  Invoked with `bun run test` and explicit paths from the desktop package.
  These are existing catalog/model/adapter tests, not nine new runtime gap reproductions.
- **PASS:** local Markdown file links, internal heading links, whitespace and
  `git diff --check -- desktop-v2-vs-webui.md` checked after editing.
- **NOT RUN in the initial documentation pass:** full Desktop/WebUI suites, native UI matrix, real multi-participant collaboration,
  real provider/OAuth flows, manual accessibility/microphone, production builds, release gates,
  signed installers/update delivery and hosted CI. They are outside this documentation-only pass.
- Release hosting and installed-binary identity were not checked. The dated native records above
  are not current release certification.

### Implementation verification (2026-11-06)

- The initial Chimera event-to-transcript test failed on the real reducer before the change
  (expected one card, received none); its valid ordinary-message and foreign-session controls
  passed. A second failing proof caught a refined follow-up losing its sent receipt; preserving
  `journalRaw` through the existing acknowledged native user-message path makes it pass.
- Existing WebUI overview/parser implementations were moved to the shared package with thin
  compatibility re-exports, retaining their imports and tests.
- Dependencies: inspected pinned Bun **1.4.3**, local manifests and the live registry before
  installing **virtua 0.54.2** (stable; React peer `>=16.14.0`). The shared surface declares its
  existing workspace `@wrongstack/tools` helper dependency. Bun regenerated workspace version
  metadata in `bun.lock`; unrelated package upgrades were not requested.
- **PASS:** full Desktop suite — **298 files / 1,047 tests**, after the final production change.
- **PASS:** full WebUI suite — **516 files / 6,247 tests**. Existing tool overview and performance
  parser import paths continue to work through the compatibility re-exports.
- **PASS:** Desktop, WebUI and shared-surface typechecks — **720 / 1,025 / 249 files** respectively.
- **PASS:** scoped Biome checks (52 changed files), report links and whitespace checks.
- **PASS:** `bun tests/transcript-virtual-browser.mjs` — actual production virtualizer in Chromium,
  10,000 messages and 11 initially mounted message rows, offscreen index navigation, retained
  keyboard focus, always-mounted approval and appended reply. The same browser fixture also
  tests isolated project scroll restoration and Chimera prepare/open/draft-preservation controls.
- **PASS:** native release build through `scripts/launch.ts build`, with Bun **1.4.3** prepended
  to PATH. The first attempt selected the unrelated global Bun 1.4.4 and failed during package
  build; the corrected pinned-runtime build completed.
- **PASS:** `tests/native-smoke.mjs --gaps --release --bundled` on portable
  `ac5de023a608-ac5eca8f6365`, checksum verification enabled and no renderer errors.
  It covers real engine commands, analytics navigation, editable diff, fonts/zoom/status chips,
  quota navigation, sidebar stop/remove, actual message pin/reload/navigation/unpin and
  host-vs-journal Core identity.
- **PASS:** the same native scope repeated with
  `WRONGSTACK_DESKTOP_TEST_PORTABLE=apps/desktop-v2/dist-native/1fd59273afbd-ac5eca8f6365`.
  This pins the checks to this round's own release build despite concurrent checkout/build
  activity. Both portable checksums passed; no renderer errors. The current run record is
  `.temp_files/desktop-v2-native/gap-close/native-result.json`.
- Native fixture corrections: wait for refinement to finish before choosing Original, complete
  approval through the normal user flow, and reveal a virtualized user row before clicking Pin.
  The initial fixture timeouts are not reported as product failures or passing acceptance.
- **NOT RUN:** full native matrix, live native Chimera report → hub → refined follow-up, live Brain
  provider outcomes, daemon failure/recovery injection, multi-window concurrent writes, native
  large-history performance budget, real external OAuth/provider flows and release/hosted CI
  certification. These remain acceptance work; the implementation table does not mark them passed.
- No installed application was replaced and no release was published.

## 7. Repeat-review procedure

1. Keep G01–G09 IDs. Re-read the mounted route, reducer/model, transport adapter and nearest
   tests before changing a status. Record the new date and commit/dirty scope.
2. For each implementation round, select one gap and its concrete close conditions. Obtain a
   runnable valid-control/failing-case proof before calling it a runtime bug; source comparison
   alone supports a parity observation.
3. Mark **IMPLEMENTED / native acceptance pending** only when the action, state and error paths
   exist. Mark **VERIFIED** only with the exact native build identity, tested actions and results.
4. Re-run focused checks and document/link validation after each revision. Preserve other
   working-tree changes. Move closed gaps into dated closure history rather than silently
   deleting them or renumbering later IDs.
5. Next acceptance work: native Chimera live-event/replay/refinement, live Brain outcomes,
   auto-heal failure/refusal, large retained histories and multi-window draft ownership. Continue
   the field-level settings and per-domain action inventory before claiming the list is exhaustive.

## 8. Acceptance continuation — final scoped rerun (2026-11-06)

Selected acceptance baseline portable: **`b413c7082a5a-ac5eca8f6365`**. All rows below refer to this same
immutable package; fixture-maintenance reruns retain their own harness hashes and logs.

| Native scope | Latest result | Duration |
| --- | --- | --- |
| Display preferences, keyboard behavior and two-window propagation | PASS | 23 s |
| Composer, refinement, media, permissions, next steps and Code Assist editing | PASS | 255 s |
| Large answer, file tree and terminal performance | PASS | 82 s |
| Recorded history, fork/resume, search and catalog paging | PASS | 207 s |
| Recorded Chimera card/follow-up and real Brain arbiter answer/denial | PASS | 27 s |
| Concurrent project windows and approvals | PASS | 104 s |
| Commands, analytics, diff, appearance, pins and diagnostic identity | PASS | 37 s |
| Session inspection/rewind/file recovery and preserved draft | PASS | 58 s |
| Main-screen WCAG checks and German label fit | PASS | 196 s |
| Broad default project/session workflow | PASS | 551 s |

**10/10 selected native scopes PASS.** Each scope's latest result, native checksums and exact
harness fingerprint are recorded in `.temp_files/desktop-parity-acceptance/final-acceptance.json`.
The final harness hash was also rechecked after completion. The broad default workflow includes
real task dispatch/model output, provider-vault reuse in a new process, native permissions and
version-checked Code Assist restoration. Fixture waits now observe paged engine completion
as well as the renderer; report/Brain/pin navigation uses actual conversation Find. Boundary
summary checks retain exact policy values while accepting the translated sentence capitalization.

This is a **selected acceptance set**, not a full 39-scope matrix or release gate. The older
baselines and failures below remain historical evidence and do not supersede this latest table.
The remaining runtime/acceptance boundaries are listed at the end of this section.

This round adds `--parity-cards` and a serial, build-pinned native matrix runner
(`tests/native-matrix.mjs`). Results are saved after each scope under
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T09-54-19-357Z/`.
The matrix has **38 scopes** including the default suite. An initial matrix failure is not
discarded when a later targeted test passes.

### Newly exercised paths

- **PASS, standalone native run:** a recorded Chimera notification traversed the native
  journal, deduplicated and excluded a foreign session, opened its report, preserved the
  existing draft, restored a prepared follow-up after reload, and completed real refinement,
  acknowledged sending and sent-receipt rendering. The report and notification were seeded
  boundary fixtures; **a reviewer model did not generate that report**.
- **PASS:** the real native Brain arbiter produced answer and denial events from explicit
  deterministic rules and rendered the structured conversation cards. This does not establish
  external-model Brain quality or every escalation/intervention path.
- **PASS:** `tests/service-crash-live.mjs` killed only a test-owned project Kanban daemon after
  a command-line ownership check. Health changed healthy → offline; next use started a new PID
  and health returned to healthy. Cleanup completed; results are in
  `.temp_files/desktop-parity-acceptance/service-crash/result.json`.
  An offline on-demand daemon is deliberately **not** an automatic-healer trigger. Automatic
  healing is opt-in via `WRONGSTACK_AUTO_HEAL_SERVICES=1`; restart/error/refusal feedback needs
  its own live test.

### Full native baseline and fixture maintenance

The immutable portable `1fd59273afbd-ac5eca8f6365` completed all **38 native scopes**:
**31 PASS / 7 FAIL**. The full result, per-scope logs and native artifact identities are retained in
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T09-54-19-357Z/matrix.json`.
This is a failed baseline, not full native certification.

The seven failures are `parity-cards`, `multi`, `perf`, `composer`, `recovery`, `history` and
the default workflow. The performance case exposed the real follow defect below. The other
cases need fixture maintenance: await the saved selected-session layout before reload;
search/reveal retained virtualized messages instead of counting mounted DOM rows; and accept
the correct singular `1 task` board label. Conversation search also strengthens cross-session
absence and rewind checks because it covers offscreen retained messages. These changes must
pass on the rebuilt portable before they are treated as resolved. The first rebuilt rerun
passed **5/8 scopes** (`perf`, `parity-cards`, `multi`, `recovery`, `gaps`); `composer`,
`history` and the default workflow still failed. A second targeted run confirmed these three
are not yet resolved. Composer advanced through real clarify, model policy, bilingual refiner,
queue and draft cases before another offscreen topic-history assertion failed. At that stage, restored-history
search reported a match without bringing its row into view, and the default Kanban flow still
needed diagnosis of its sidebar selector and an intermittently concatenated title. Subsequent
code/fixture changes and the final native passes below supersede those intermediate failures.

A separate unit fixture still searched lowercase `observer` while the English control is
`Observer`; its selector now asserts the actual label and the join behavior remains checked.
The rerun passed **298 files / 1,047 tests**. Typecheck passed **721 files**. The growing-answer
browser proof passed three consecutive runs; the 10,000-message virtualization proof also passed.

### Native failure found: growing transcript loses auto-follow

The fixed-build matrix reproduced a real failure in the unchanged native performance scope:
short turns finished, and the engine journal contained “Long reply complete.”, but the viewport
remained on the preceding answer with “Jump to latest”. Layout-generated scroll events were
being mistaken for user navigation. Before-proof artifacts are retained in
`.temp_files/desktop-parity-acceptance/long-follow-proof/`.

The working-tree fix separates user wheel/touch/keyboard/scrollbar intent from layout events
and follows virtual-row resizing through the virtualizer handle. The new browser regression
covers a 1,000-line answer followed to its end and an explicit user pause preserved while it
grows to 2,000 lines. Desktop unit tests and typecheck pass. **PASS:** the unchanged native
`--perf --release --bundled` scope passed on rebuilt portable
`d2bee6b475b8-ac5eca8f6365` (104 seconds for the full performance scope). Its checksums were
verified and there were no renderer errors. The native after-proof log is
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T10-31-00-589Z/perf.log`.
The final package repeat passed in 82 seconds: its 3,000-line answer rendered in 972ms,
with engine completion at 665ms. These are local fixture measurements. The latest selected
acceptance table above supersedes the intermediate rerun state; no full release gate is claimed.

### Native restored-history navigation follow-up

The restored-history scope repeatedly reproduced a second navigation failure: Find correctly
reported `1 match in 1 message · message 1`, but the matching first row was not mounted.
The viewport was at `scrollTop=0` and only the following, approximately 10,597px-tall assistant
row was in the DOM. Diagnostic output is retained in
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T10-46-02-460Z/history.log`.

A working-tree change retains the one requested virtual row and repeats navigation after its
content commits. Browser navigation before a very tall answer, the 10,000-row bounds check and
typecheck pass. **PASS:** the native history scope on portable
`2cfb960e4e8d-ac5eca8f6365` completed in 221 seconds: fork/resume, search navigation,
multimodal/long-text paging, over-1,000-item catalog paging, revision refusal, project isolation
and preserved drafts. The unchanged content/search assertions now pass. Before/after evidence is
retained in `.temp_files/desktop-parity-acceptance/restored-find-proof/`; the full after-proof is
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T10-53-13-190Z/history.log`.

### Follow-resume control after search/pin navigation

The next full composer run reached real approval handling and exposed a follow-up regression:
Find paused following without showing “Jump to latest”, so the next approval's action buttons
stayed outside the viewport. The original native approval visibility assertion failed; recorded
evidence is in `.temp_files/desktop-parity-acceptance/follow-resume-proof/`.
Search and pin navigation now use the same pause function as explicit scrolling, including the
resume button and new-message baseline. **PASS:** full native `--composer` on portable
`b413c7082a5a-ac5eca8f6365` completed in 255 seconds, including the unchanged approval-action
viewport assertion, allow/deny/remembered permissions, complete command arguments, structured
turn activity, next steps and version-checked Code Assist restoration. The fixture also now
recognizes the new-message badge on the resume button and the canonical `activityAfter` tool
section instead of obsolete sibling/`.turn-tools` assumptions. Full log:
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T11-31-22-791Z/composer.log`.

### Field-level settings follow-up

A source pass found **99 distinct literal `syncPref` keys** in the WebUI settings components.
This excludes dynamic preference keys and is not a complete configuration-schema denominator.
Ten keys had no literal-name hit in desktop/shared source; inspection rejected or qualified
the following candidates instead of treating grep absence as implementation proof.

| Item | Source evidence / current assessment |
| --- | --- |
| G10 — IMPLEMENTED; native PASS | [ConversationAppearanceSettings](../apps/desktop-v2/src/ConversationAppearanceSettings.tsx) adds thinking visibility, tool grouping and opt-in composer auto-collapse to the existing native appearance store. [SessionActivity](../apps/desktop-v2/src/SessionActivity.tsx) / TurnTools consume display choices; [useComposerCollapse](../apps/desktop-v2/src/useComposerCollapse.ts) shares the WebUI transition rule and protects drafts/attachments/references and running turns. No second preference store or new dependency |
| G11 — IMPLEMENTED; native PASS | The same native appearance controls enable/disable root navigation/palette and [ConversationShortcuts](../apps/desktop-v2/src/ConversationShortcuts.tsx). Conversation Find and editing remain available; focusing the composer expands it first. Existing native defaults keep shortcuts enabled until explicitly changed; WebUI defaults them off. Unit tests cover disable/re-enable and Find separation |
| `chimeraProvider` — rejected false positive | Desktop [review-policy-model](../apps/desktop-v2/src/review-policy-model.ts) reads/writes it through the computed `${prefix}Provider` key and a combined provider/model picker |
| `enhanceCountdownMs` / `enhanceDelayMs` — explicit policy decision | Desktop refinement is reviewed and manually sent. Adding delayed automatic submission requires an intentional UX/authorization contract; a missing literal key is not a failed refinement implementation |
| `titleAnimation`, `showAgentSwarmPanel`, `confirmExit` — platform comparison needed | Browser tab-title animation, dock placement and before-unload warning do not directly map to a native app whose detached sessions keep running |

The standalone server accepts these four Boolean keys in
[pref-helpers](../packages/webui-server/src/server/pref-helpers.ts) and validates them in
[ws-payload-preferences](../packages/webui-server/src/server/ws-payload-preferences.ts), but
`DISPLAY_ONLY_KEYS` explicitly excludes them from config persistence. The WebUI persists them
in its own local preference store. Desktop now uses the existing
native appearance store, including verified host persistence and cross-window propagation; no second
preference store or new dependency is required. Preserve the different scopes of global navigation
shortcuts, editor/composer editing keys and conversation search when applying G11.

### G10/G11 native acceptance

**PASS:** `--display-prefs --release --bundled` on portable
`b413c7082a5a-ac5eca8f6365` (23 seconds, including a second native window), with verified portable checksums and no renderer errors.
The test uses actual native controls/storage/reload/keyboard actions and explicitly recorded
activity frames for the visibility/grouping check; it sends no model prompts or real tool calls.
It verifies opt-in collapse, expand-on-focus, preserved nonempty drafts after reload, global
shortcut disable/re-enable and conversation Find remaining available. A second native window
reads the saved settings and receives later changes live. Simultaneous conflicting writes to
the same preference record are not a separate stress case here.

Desktop **302 files / 1,056 tests**, Desktop typecheck **726 files**, WebUI typecheck
**1,026 files**, shared typecheck **250 files** and WebUI auto-collapse **13 tests** passed.
The auto-collapse decision helper is shared, with a thin WebUI re-export; existing native
appearance persistence owns the desktop choices. Logs are retained in
`.temp_files/desktop-parity-acceptance/matrix-2026-11-06T11-55-18-668Z/display-prefs.log`.
The broader selected native acceptance set also completed successfully; this is not full
39-scope/release certification. The final package's full composer scope has
also passed (255 seconds). A separate real-Chromium visual check verified the four controls,
live checkbox changes and desktop/800px Turkish layouts without overflow; screenshots are in
`.temp_files/desktop-parity-acceptance/display-ui/`.

### Remaining runtime and acceptance boundaries

| Item | What remains |
| --- | --- |
| Chimera producer / renderer acceptance | PASS — combined real native application flow on `08b1155844d3-53e2f152b527`: actual tracked-file read/write → 15-second automatic producer → read-only reviewer → verified finding/store → conversation card → exact report hub → preserved draft → reload → explicit refinement/approval/send/receipt. `matrix-2026-11-06T15-17-34-461Z` passed in 55 seconds. No report/event injection or automatic leader wake; the controlled loopback finding verifies integration, not external-model review quality |
| G09 policy/long-run boundary | Packaged native automatic repair, restart failure and manual recovery now pass through the actual engine, journal and WebView2 on `08b1155844d3-53e2f152b527`. A missing request-acknowledgement defect was reproduced and fixed. Recorded native refusal/progress/expiry frames also pass. Actual denial by a custom host boundary is covered separately by the live daemon test; the default native compatibility policy permits elevated restarts. Multi-failure escalation under the default five-minute cooldown remains outside this selected native scope |
| Platform/policy mapping | Source comparison completed: `titleAnimation`, `showAgentSwarmPanel` and `confirmExit` are CLI/TUI configuration mirrors in WebUI, without browser runtime consumers. WebUI's `App.tsx` updates the browser title independently; `useF5Resilience` flushes stores on unload without an exit-confirmation policy. These keys are not missing Desktop browser behaviors. Desktop's existing Terminal display section now also exposes all three through the canonical profile preference API, localized in seven languages; source typecheck and scoped Biome pass, while packaged UI acceptance of the new controls is pending; refinement countdown/delay keys reflect a different reviewed-send policy |
| External/runtime acceptance | External-model Brain quality, complete provider/OAuth combinations, microphone hardware/OS behavior, and a full release/distribution gate are not covered by the selected local fixture matrix |

### Chimera producer integration (2026-11-06)

**Reproduced and implemented:** the actual standalone `startWebUI` entry completed a valid
leader run with a modified tracked file, but produced zero review notifications when automatic
review was enabled. The disabled control also completed normally. Neither reports nor review
events were injected into this proof. The missing composition consisted of both canonical
built-in review producers and the review executor previously installed only by the CLI.

The CLI review executor, read-only policy, task builders, fallback ladder and work registry now
live in `@wrongstack/runtime/chimera`; the CLI keeps compatibility re-exports. The standalone
host loads the canonical producers for each leader session and reuses its existing fleet lazily.
Only that leader context's iterations reach its producer bus; reviewer iterations cannot recurse
and report ownership is captured before asynchronous work. Reports use the same per-project
metadata store as the report routes. Plugin feature flags, explicit plugin disablement and
extension enablement are honored.

Reviewers retain the canonical read-only tools/capabilities. Completion persists the report before
publishing passive availability. No cascade executor, fix agent or leader wake is installed.
Session shutdown/eviction joins producer and reviewer work before releasing the journal or
fleet. Starting another leader turn does not wait for an unfinished background reviewer. The
canonical post-session producer may review settled content again after an earlier review has
completed; in-flight claims are not permanent completed-content deduplication.

Validation artifacts are retained under
`.temp_files/desktop-chimera-producer/round-01/`. `prove.ts` is the before/after source-engine
proof; `verify.ts` adds report-route durability, session affinity, unchanged source content and
an enabled-versus-disabled leader-provider-call control. `native-verifier.log` records repeated
runs against the newly compiled `apps/desktop-v2/binaries/wrongstack-engine.exe`.

The new engine binary is separate from the earlier immutable portable application's selected
acceptance results. A loopback provider verifies real runtime composition and protocol behavior;
it does not certify external-model review quality, the combined native renderer interaction,
the complete 39-scope native matrix, or release/distribution readiness.

| Producer validation | Result |
| --- | --- |
| Same runnable source proof, disabled/enabled controls | PASS after reproducing zero enabled reports before the fix |
| Final compiled Windows engine producer verifier | PASS — 3/3 repeats; real reviewer call, durable report detail, unchanged file, correct session and equal leader-call counts with review enabled/disabled |
| New standalone ownership regressions + registry/shutdown/history checks | PASS — 24 tests in 6 files; 10 new Chimera cases |
| Existing CLI Chimera tests | PASS — 85 tests in 12 files |
| Complete runtime package suite | PASS — 432 tests in 43 files |
| Production typechecks | PASS — WebUI Server, runtime, CLI source and CLI test project |
| Scoped Biome / diff whitespace checks | PASS |
| Complete WebUI Server suite | 3479 PASS / 1 history-search timeout; the focused history rerun passed |
| WebUI Server separate test-project typecheck | FAIL — 59 errors in 22 files, with no diagnostics in the new Chimera test |

Exact commands, intermediate failures, retained artifacts and verification limits are recorded
in `.temp_files/desktop-chimera-producer/round-01/final-validation.md`. A focused passing
producer proof does not turn the remaining broad gates into a full workspace certificate.

### G09 real watchdog fault and native feedback verification (2026-11-06)

[service-auto-heal-live.mjs](../apps/desktop-v2/tests/service-auto-heal-live.mjs) starts a real,
test-owned Session Catalog daemon and first proves healthy operation. It corrupts only that
fixture's authentication metadata, verifies that the real health collector reports `error`,
and starts the production watchdog with automatic healing enabled only in the fixture process.
The collector and restart executor are not replaced. A short explicit attempt limit exercises
escalation without waiting through the default cooldown.

| Live scenario | Observed phases and outcome |
| --- | --- |
| Explicit denying host boundary | `refused`; service remains in error and no restart begins |
| Real authentication fault retained during restart | `restarting` → `failed` → `escalated`; service remains in error |
| Restore authentic metadata at restart admission | `restarting` → `restarted`; health becomes healthy and the daemon PID changes |

Actual watchdog events also traverse the production native reducer; their per-service state and
manual-control gating are asserted outside the observer callback, because the watchdog
intentionally isolates subscriber exceptions. Each fixture disposes its watchdog, shuts down its
own daemon and waits for that process to exit. Results, events and cleanup status are retained
in `.temp_files/desktop-parity-acceptance/service-auto-heal/result.json`. The final live verifier
passed **3/3 repeats**, each with `cleanupComplete: true`.

[service-healing-feedback.test.ts](../apps/desktop-v2/tests/service-healing-feedback.test.ts)
adds six mounted native-component cases for terminal messages, health refresh, disabled controls
during restart, restored controls after completion/refusal/failure, older-event rejection and
missing-terminal-event expiry. Together with the existing service tests, all 11 focused tests
pass. The full Desktop V2 suite passes **303 files / 1062 tests**; desktop typecheck passes
**726 files**; existing backend watchdog tests pass **14/14**. Scoped Biome and whitespace
checks pass. No production code change was needed for these reproduced branches.

That earlier round established real-daemon watchdog acceptance plus native reducer and
mounted DOM coverage. It did not certify the complete native transport journey; the following
packaged run exercised that journey and exposed the missing acknowledgement described below. The refusal scenario configures a denying host boundary through the supported
watchdog API; the default native compatibility boundary permits elevated service restarts,
so this test must not be described as a native user-policy refusal.

### G09 packaged native follow-up — lost acknowledgements fixed (2026-11-06)

The packaged acceptance run exposed a real defect beyond the earlier mocked-command DOM
tests: `connections.health_result` reached the native journal without its request's
`requestId`. Native `EngineOperations` therefore ignored valid health responses, timed out,
and could not populate the service list. Service-action success and refusal replies had the
same missing correlation. A health-collector error also lacked the explicit failure flag and
was absent from the native panel's expected reply types.

Before the fix, the native run timed out despite five journaled healthy responses and no
renderer exceptions. The source proof used the real backend handler and real native request
tracker: its legacy id-less valid-input control passed, but a correlated health request failed.
The durable backend regression initially had **7 FAIL / 1 PASS** for normal health, collector
failure and service-action refusal branches.

The fix reuses canonical `withRequestId` for health and every service-action reply. Health
errors carry `success: false`, and the native panel subscribes to that error reply as well.
It does not change the watchdog's opt-in switch, cooldown, retry policy or authorization.
The exact source proof passes **3/3 repeats**; all **8** new backend contract cases and **2**
new native component acknowledgement cases pass.

The rebuilt immutable portable is **`08b1155844d3-53e2f152b527`**:

- Native application SHA256: `08b1155844d340ddae2ec648a2cf4b803893696859b80391abaf94315e99a946`.
- Engine SHA256: `53e2f152b527a031d2ba7e13642f3e4e0df28e3f2ac51ee0ae1681610ee6b4b8`.

`tests/native-smoke.mjs --service-healing --release --bundled` passes with both checksums
verified and no renderer errors. It uses two isolated native host lifetimes to preserve the
production cooldown rather than shortening it:

| Packaged native scenario | Evidence |
| --- | --- |
| Real catalog metadata-table fault | Native health reports `error`; actual watchdog emits `restarting` → `restarted`; daemon PID changes; health returns to healthy; WebView2 shows successful automatic repair and enables manual controls |
| Real catalog authentication fault retained during restart | Actual watchdog emits `restarting` → `failed`; WebView2 shows the failure and enables manual controls |
| Manual recovery after restoring fixture authentication | Clicking the native Restart button receives a correlated successful acknowledgement; daemon PID changes and health returns to healthy |
| Recorded policy-refusal journal frame | WebView2 displays the refusal and leaves manual controls usable. This is a recorded renderer boundary, not a real denial by the default native policy |
| Recorded restart with no terminal event | Native controls initially disable. Advancing only the test WebView's clock past two minutes and refreshing health displays expiry guidance and re-enables controls. The backend's real clock is untouched |

The first mailbox-authentication fault fixture was rejected as unsuitable because the real
mailbox probe classified it `offline`; it was not used as proof of an `error` trigger. The
final failure fixture uses the previously verified real Session Catalog authentication fault.
Earlier failed and partial runs remain under
`.temp_files/desktop-auto-heal-native/round-01/`; final native events, results and screenshots
are in `.temp_files/desktop-v2-native/service-healing/`.

The matrix at `matrix-2026-11-06T14-20-29-662Z` remains **FAIL**: both scenario checks
passed, then its five-second test-owned-process cleanup helper timed out. This was not erased
by a later result. Only that fixture cleanup deadline was changed to 30 seconds; the next matrix
at `matrix-2026-11-06T14-24-58-873Z` passed in **110 seconds**, including cleanup. The final
visual check also waits for the native health row itself to display the healthy replacement;
`matrix-2026-11-06T14-28-11-573Z` passed in **105 seconds** including cleanup, and its native
harness fingerprint was independently rechecked after completion. Matrix records retain the package identity, complete native-harness fingerprint and per-run log.

Production typechecks pass for Desktop V2 and WebUI Server; the full Desktop V2 suite passes
**304 files / 1064 tests**. Related backend checks pass **79 tests in 4 files**, and the full
WebUI Server suite passes **372 files / 3489 tests**. The separate
WebUI Server test-project typecheck remains at **59 errors in 22 files**, with no diagnostics
in the new acknowledgement regression. This selected native scope does not certify the full
native matrix or release/distribution. The native matrix now discovers **40 scopes** including
the default scope; older 38/39-scope results above retain their historical meaning.

### Remaining-scope continuation (2026-11-06)

The following evidence supersedes pending statements above only for the named scopes.

| Scope | Current result and boundary |
| --- | --- |
| Automatically generated Chimera report through native follow-up | PASS — `matrix-2026-11-06T15-17-34-461Z`, 55 seconds, portable `08b1155844d3-53e2f152b527`. Actual leader read/write, real 15-second producer and read-only reviewer, disk-verified controlled finding, durable report, native card/exact hub, preserved draft, reload and explicit refined send/receipt. No report/event seeding or automatic leader wake. Loopback model quality is not external-model quality |
| CLI/TUI preferences exposed in WebUI | Added the three missing controls (`titleAnimation`, `showAgentSwarmPanel`, `confirmExit`) to Desktop's existing Terminal display section and all seven locale catalogs. They use the canonical profile prefs API. They configure CLI/TUI behavior; WebUI has no browser runtime consumers of these keys. Source typecheck and scoped Biome PASS. Actual compiled-engine update acknowledgement, explicit prefs readback and disk persistence PASS for both booleans and all three swarm placements, preserving unrelated features (`collaboration-live/1793980743055`). New native package `00e8e3c44ecb-624202657f3a` UI acceptance PASS in `matrix-2026-11-06T16-10-19-905Z` (parity-finish 94 seconds, including explicit settings saves/reloads, compact layout and retained-socket Leave recovery). Generated Chimera regression also PASS on this package (142 seconds); both scopes include checksum verification and cleanup |
| Actual collaboration participants | PASS against the bundled engine — two real WebSocket clients, distinct participant IDs, observer pause refusal, unauthorized controller refusal, leave/rejoin, close cleanup, reconnect, foreign-session rejection and no leader run. Engine cleanup verified. Evidence: `.temp_files/desktop-parity-finish/collaboration-live/1793978691735/result.json` |
| Collaboration renderer-reload recovery | Reproduced a retained native-socket membership that refused a fresh panel's Join, with no Leave action available in the error view. Added an explicit translated Leave action to the shared panel; it clears the local error/role after sending the canonical leave, without automatic retry or authority changes. Same real-engine/Chromium proof RED at `collab-reload-round/1793979861942`, GREEN at `1793979958900`: production panel/native adapter, persistent socket, renderer reload, explicit leave/rejoin and unchanged external participant identity. Shared 250-file and Desktop 727-file typechecks and scoped Biome PASS. Durable mounted regression added; its Vitest DOM execution remains blocked by the separately reproduced jsdom VM incompatibility. The same recovery is now also PASS in the new packaged Tauri window (`--parity-finish`, `00e8e3c44ecb-624202657f3a`), with unchanged host/Core identity across renderer reload, no implicit leave, explicit recovery, controller-role refusal and preserved chat draft |
| Configured live providers | Actual model catalog and one minimal completion tested per configured provider. PASS: MiniMax, Z.AI, Alibaba, OpenCode Go and xAI. ChatGPT catalog succeeds but completion fails with authentication / HTTP 400 on two observations. No login/reauthorization proof, full-model inventory or unconfigured-provider claim. Evidence: `.temp_files/desktop-parity-finish/providers-live/1793978993609/result.json` |
| Server test-project typecheck repair | 59 errors in 22 files reduced to zero in 783 files. Corrected test imports, mocks, required fixture metadata and optional-index typing, preserving runtime assertions. Related 26 files / 515 tests PASS; scoped Biome PASS. Evidence: `.temp_files/desktop-parity-finish/server-test-types-after3.log` |
| Current broad source gates | Desktop source typecheck PASS. Full Desktop attempt: 226 files / 847 tests PASS, 78 DOM worker startup errors. Full WebUI Server attempt: 354 files PASS / 18 files FAIL, 3375 tests PASS / 3 FAIL. Errors include jsdom VM setup, ws export resolution, shared-cache misses, Git assertion and outdated Lite identity wording; only the stale Lite marker was updated to the verified unique current marker. Focused verification remains required |
| Parallel dependency update | User confirmed another agent is updating dependencies in the same checkout. Vitest, jsdom and ws changed during verification; these changes were preserved. Minimal `jsdom-boundary.ts` proves default non-VM DOM works, while both script VM modes fail with EventTarget errors under Bun 1.4.3 / jsdom 31.0.0; the DOM failure also reproduces with Vitest 5.1.0. No downgrade or node_modules patch was applied by this parity continuation |
| Complete native matrix | 41 scopes planned at `matrix-2026-11-06T15-19-38-883Z`; intentionally stopped by the fingerprint guard after the current child completed cleanup: 12 recorded scopes, 9 PASS / 3 FAIL / 29 NOT RUN. Recorded-card failure was an immediate mounted-row assertion after reload; its test now navigates retained conversation history before checking the virtualized card. Chronicle scenario assertions passed, then the owned-process cleanup exited 1; diagnostics now retain bounded helper stderr. Goals failed during setup because the concurrently rebuilt `sage/dist` could not import `@wrongstack/hq`. Targeted rerun `matrix-2026-11-06T15-50-36-806Z` PASS 2/2 (recorded cards 62 seconds, Chronicle 85 seconds including cleanup). The subsequent runtime-boundary matrix `matrix-2026-11-06T15-53-47-696Z` PASS 6/6: Files/Git 330 seconds, MCP 93 seconds, MCP Tasks 123 seconds, usage 94 seconds, fleet 102 seconds and platform/new surfaces 75 seconds. Neither partial nor targeted matrices are full release certification |

### Source gate recovery and native boundary completion

The shared checkout keeps the user's Vitest 5.1.0, jsdom 31.0.0 and existing ws 8.22.1 patch.
A minimal managed [jsdom Window proxy patch](../patches/jsdom@31.0.0.patch) registers the real
VM global proxy with its existing EventTarget implementation. The same installed-library
proof first passed the default non-VM control and failed both VM script modes; after the patch,
all three modes pass listener add/dispatch/remove and still reject forged EventTarget receivers.
`bun install --frozen-lockfile` passes. A normal managed dependency link was restored after
Bun's editable patch copy; the lockfile and patch reproduce the passing result.

| Current source gate | Latest result |
| --- | --- |
| Complete Desktop V2 suite | PASS — 305 files / 1068 tests, including the new collaboration recovery and three Window-runtime regressions |
| Complete WebUI Server suite | PASS — 372 files / 3489 tests; prior cache/export/Git/Lite-marker failures did not recur after the dependency environment stabilized and the stale marker was updated |
| Real Windows special-file boundaries | PASS — production native `EngineOperations` and `saveFileVersion` against the compiled engine: regular save, external-writer conflict, unchanged binary bytes, allowed in-project junction, exact correlated `Forbidden` for an escaping junction, valid regular Git conflict control and explicit refusal to text-resolve real index stages with symlink/gitlink modes. Evidence: `file-boundary-live/1793981165669/result.json` |
| Real configured Brain route | PASS — headless policy, `brain.answer`, correct request/session correlation and no leader run; `providers-live/1793980367024/result.json`. The configured pool was Z.AI + MiniMax; the resolving tier was not captured, so this is functional routing evidence, not a model-quality or model-origin certificate |
| OS dictation capability | Native `--surfaces` PASS: the actual platform reported available / English (United States), and the real button matched. No microphone recording or spoken-input quality is claimed |
| New packaged changes | PASS 2/2 — `00e8e3c44ecb-624202657f3a`, `matrix-2026-11-06T16-10-19-905Z`: final CLI controls + native collaboration reload recovery, and automatically generated Chimera. Build source fingerprint stayed unchanged during compilation; prior portable hashes were independently preserved |

Logs are retained in `.temp_files/desktop-parity-finish/`. The native harness now also includes
`--parity-finish` (42 scopes before the subsequent Office/Story scenario); historical 40/41-scope
counts above remain historical. Office/Story acceptance with actual provider-backed workers,
full final-package matrix and release gates are still being completed.

Live-provider evidence records provider/model identifiers, result categories, timing and
usage, with a separately scrubbed short diagnostic for the failed ChatGPT request; credentials,
OAuth tokens and raw engine logs are not written to the live-account artifacts. Provider
checks run through the actual compiled engine's provider-test route and never start a leader
agent or give a model file tools.

### Latest backend repairs and remaining native gate (2026-11-06)

Two worker-cost defects were reproduced through actual delegated provider calls. The
[host price resolver](../packages/fleet/src/host-model-pricing.ts) now combines the final
routed model's catalog rates with saved custom model prices. The shared
[fleet accumulator](../packages/coordination/src/fleet-bus.ts) distinguishes missing rates
from genuine zero prices; optional catalog failures preserve saved rates or leave the estimate unavailable. [Delegate completion](../packages/coordination/src/delegation/run-delegation.ts)
omits an incomplete estimate. It does not reconstruct historical unknown charges.

The ordinary compiled backend, with **no source aliases**, is SHA256
`3bec1a91fd98fdfb87eeaa70606b9f8da8376f2f82965fe02c6f2e90fba17d85`.
It passes the same real-worker paid and unpriced scenarios three times each. Paid worker:
expected/actual USD **0.00011**; independent parent control USD **0.00044**. Unknown worker:
no priced amount, with the same parent control. Each run uses its own Git root and fixture
home and stops its owned process tree. These are compiled-engine results, not Tauri UI proof.

The failed coverage run also exposed a real Windows lifecycle defect. A timed-out process
continued writing its heartbeat after return. Independent `taskkill /T /F` measurements
completed successfully in **7.441 / 8.460 seconds**, beyond the old five-second backstop.
The [shared helper](../packages/core/src/utils/tree-kill.ts) and
[process registry](../packages/tools/src/process-registry.ts) now allow that traversal to finish
within a bounded 30-second fallback. Successful cleanup still settles immediately.
[MCP close](../packages/mcp/src/client-lifecycle.ts),
[benchmark commands](../packages/bench/src/exec-command.ts) and
[SDD verification](../packages/sdd/src/verify-task.ts) retain Windows ownership/results until
actual exit or their bounded cleanup backstop. POSIX behavior is unchanged.

| Follow-up verification | Observed result |
| --- | --- |
| Real Bash heartbeat and native process-state probe | PASS 3/3; stopped heartbeat, missing PID, owned cleanup |
| Gated Windows cleanup/ownership regressions | 34 tests PASS in three final repeats; regular-success and bounded-stall controls retained |
| All 17 files that failed initial coverage | PASS: 17 files / 488 tests / 1 existing skip, 215 seconds; selected backend hash unchanged throughout |
| Final pricing scope after shared cleanup changes | PASS: 189 files / 2965 tests / 1 existing TODO |
| Desktop provider fixture and delegation model | PASS: 3 files / 6 tests |
| Current test-type ratchet | PASS: 0 new diagnostics; 1042 allowed baseline diagnostics remain |
| Changed backend source typechecks | PASS: core 638, tools 395, MCP 175, bench 32, SDD 45, coordination 190, fleet 60 files; counts overlap across projects |
| Backend production build and ordinary engine compile | PASS; selected backend source fingerprint unchanged: `87c4c3f9ea9955fb33b7aed69155c77c2e079dcb342b0c1ef047759db645aea3` |

The initial full uncached release matrix remains a recorded **16 PASS / 3 FAIL** run;
follow-up successes do not retroactively change it. Full tests/coverage must be rerun after
final inputs settle. Core API snapshots were refreshed. Architecture health still reports
working-tree type cycles, Desktop hotspots and moved/test-only export records. No cycle
exceptions or hotspot limits were raised. The registry comment stays within its existing
729-line budget, and the now-production-used Windows deadline was removed from the
test-only export registry.

The user confirmed the other agent's shared UI work is continuing and will announce when
it finishes. Final Tauri packaging, completed Office/Story cost/replay acceptance and the
**43-scope** native matrix remain pending that notification. No installed application,
Git branch/worktree, commit, publication or push was changed by this continuation.

### 2026-11-06 architecture gate closure

The complete `bun run check:architecture` gate now exits 0. The two new type-only
cycles were removed by sharing message/action contracts outside their components.
Engine state types, saved-draft validation, lazy conversation panels and Goal usage
pricing were extracted without changing their behavior. The redundant Chimera
wrapper was removed. No hotspot allowance was increased: the workspace allowance
was removed after shrinking below the threshold, and the Chimera allowance tightened.
Moved Chimera/tool-summary test-only export records now point at their current owners.
Superseded transcript pagination helpers and their implementation-only test were removed;
the real virtualized transcript and search/replay checks remain.

- Desktop typecheck: PASS, 733 checked files.
- WebUI server typecheck: PASS, 335 checked files.
- Scoped Biome check and `git diff --check`: PASS.
- Complete Desktop suite after the completed-worker repair: PASS, 305 files / 1069 tests (28.43 seconds). The old test for removed pagination helpers is no longer counted; two real lifecycle regression cases were added.
- Complete WebUI server suite: 371 files PASS / 1 FAIL; the sole failure timed out while seeding 506 transcript files. Unchanged isolated rerun PASS, all 5 tests / 12.22 seconds; broad rerun is still required.
- Guarded native packaging: PASS, immutable `947ef389064e-5efd1f6ea51c`; all-package-source hash unchanged.
- Native Office/Story on that package: paid worker/parent cost assertions passed for all three workers; completed Office ownership then failed. That failure exposed same-batch lifecycle deletion, now reproduced and repaired in source; rebuilt-package acceptance is pending.
- Evidence: `.temp_files/desktop-parity-finish/architecture-cleanup-final.log`,
  `*-extractions-types.log`, `architecture-final-biome.log`, and
  `architecture-final-diff-check.log`.

### 2026-11-06 completed worker replay repair

Native package `947ef389064e-5efd1f6ea51c` passed real approval, provider-backed
worker completion, exact parent/worker counters and paid estimates for three
conversations across two projects. The completed Office switch to Project Beta
then failed: `Office gamma` was absent, with no renderer errors and its native
owner still running.

The captured journal reproduced the root cause: `task_completed` and routine
`removed` arrived in one batch. The reducer deleted the terminal fleet entry
before any view could cache it. Native-frame proof RED observed the missing entry;
the unchanged proof is GREEN after retaining terminal lifecycle receipts in the
conversation's existing bounded roster. Explicit removals, unfinished-worker
removals and session shutdown still clear their entries. Two durable regression
cases were added to `office-fleet.test.ts` (all 5 cases PASS).

The immutable failed package and captured frame proof remain under
`.temp_files/desktop-parity-finish/completed-fleet-round/`. Current native rebuild,
completed ownership, Story replay and combined usage acceptance are not yet green.

### 2026-11-06 rebuilt native Office/Story acceptance PASS

Immutable portable **`8fac5d60d9fc-dd5f67fc53cf`** passed the unchanged full
Office/Story native scenario. Actual approvals and provider-backed workers across
two projects and three conversations preserved live and completed ownership,
exact parent/worker pricing, combined conversation cost, Story/usage renderer reload,
and isolation when another project's owner was stopped. Browsing did not start
additional workers or resume leaders. Both portable checksums were verified.

The backend was rebuilt normally before native packaging. Engine SHA-256:
`dd5f67fc53cf2477624e5261ab25c119c80156c03fe14c7e19d7e2c0a44de452`.
All guarded package sources and desktop inputs retained fingerprint
`c1a0a7d5aafd290727d2ff118b6da9e81a0ad49ca41f563dcbd4b514d947c1eb`
through the successful build. Before/after per-file manifests are recorded.
The preceding attempt was correctly rejected after shared SAGE/UI edits changed
its inputs; that package was not staged as an acceptance artifact.

Current repaired source also passes the complete Desktop suite (305 files / 1069
tests), architecture gate, Desktop typecheck and the test-type ratchet (0 new
errors). The complete 43-scope native matrix and an uncached full release-check
rerun are the remaining broad validation work; no release is published or certified.

Evidence: `.temp_files/desktop-parity-finish/native-office-story-repaired.log`,
`native-pricing-build-result.json`, `native-inputs-before.json`,
`native-inputs-after.json`, `desktop-completed-fleet-suite.log`,
`completed-fleet-architecture.log`, and `completed-fleet-test-types.log`.

### 2026-11-06 current validation checkpoint

The latest accepted immutable package is `96825c90e9bb-f00fb845cef8`.
Its first matrix batch passed 11 of 43 scopes, including models, goals, SDD,
Office/Story, model-draft restart, the full composer scenario, parity cards,
Chimera, Brain policy, multiple windows and performance. This is partial
coverage; the interrupted accessibility scope is not counted as a pass.

A further benchmark lifecycle race was reproduced: buffer overflow or caller
abort began process-tree cleanup, but the original timeout could subsequently
replace the termination cause and start a second kill. The first cleanup now
cancels that timer and deduplicates later stop requests. The same two failing
assertions pass after the fix, with normal-close and real-timeout controls.
Six affected process/verification test files pass all 59 tests. Windows test
fixtures now outlive the bounded cleanup interval and retain actual child-exit
assertions; POSIX deadlines remain unchanged.

The complete release rerun is still pending. The preceding full root cohort
recorded 4524 passing, 10 failing and 12 skipped files; focused reruns after
repairs do not turn that historical run green. A subsequent interrupted run
exposed two incomplete Goal pricing test stubs and additional cleanup timing
cases; both are repaired and focused checks pass. The test-type ratchet reports
zero new diagnostics. Architecture and workspace type gates passed in that run.

Shared production edits are tracked automatically, as requested by the user.
The next guarded build rejected changed Diagnostics/UI translation inputs during
compilation and did not stage a package. Rebuilding and final broad validation
continue without waiting for another agent status message. Prior native results
can be retained only for identical executable bytes and an identical harness;
a changed artifact requires a fresh complete matrix. No release is certified.

Evidence: `.temp_files/desktop-parity-finish/native-final-scope-plan.json`,
`benchmark-termination-round/red.log`, `benchmark-termination-round/green.log`,
`benchmark-termination-round/all-observed-green.log`,
`goal-pricer-types-green.log`, `final-goal-pricer-test-types.log`, and
`last-runtime-fix-native-build.log`.

### 2026-11-06 shared UI follow-up

Automatic tracking observed continued Diagnostics, provider, skill, Chronicle,
conversation and appearance changes. A second guarded package attempt rejected
source drift; neither rejected build is a final acceptance artifact.

Three shared UI changes exceeded their existing hotspot line limits. Explorer
chrome, the review empty state, the skill heading and a Chronicle event row were
extracted as presentation components while retaining the new behavior. The
complete Desktop suite passes **306 files / 1072 tests**, and Desktop typechecking
passes **738 files** after the extraction. Chronicle's line ratchet tightened
from 744 to 716 and SkillLibrary's from 903 to 898; FileWorkspace's 2053-line
limit was preserved. The registry records the four explicit component-import
edges introduced by composition (FileWorkspace +2, Chronicle +1, SkillLibrary
+1); no runtime-cycle exception or line-limit increase was added.

Scoped component formatting passes. A broader `biome check` also reports the
existing generated test-only-export registry's array-format difference under
the concurrently upgraded Biome CLI; this is recorded separately from lint.
Shared manifest EOF whitespace is outside this continuation's owned scope.
The final architecture rerun, stable-source packaging, full native matrix and
full uncached release matrix remain pending their actual results.

Evidence: `.temp_files/desktop-parity-finish/hotspot-desktop-suite.log`,
`hotspot-desktop-types.log`, `hotspot-architecture.log`,
`hotspot-architecture-final.log`, `latest-hotspot-format.log`, and
`settled-build-watch.json`.

Subsequent shared display work changed the same files again. Its finite numeric
plural count was preserved, and Roster's duplicate display formatter now delegates
to the existing identical `displayCount` implementation. After reviewing the
display/card diffs, the registry records exact line deltas: Roster 1586 to 1589,
Chimera 764 to 766, Chronicle 716 to 720 and SessionHistory 745 to 747.
These are explicit per-file baseline changes for the reviewed formatting,
helpers and explanatory comments; the global threshold and cycle rules remain
unchanged. Chronicle remains below its original 744-line allowance. This later
entry supersedes the earlier statement about no line-limit increase for the
ongoing shared display changes. The original extraction itself still adds no
line-limit increase.

The complete `bun run check:architecture` rerun now **passes**, including the
Core API snapshot, architecture health and zero-upward-edge Core layer check.
Evidence: `shared-display-architecture.log`. Automatic source tracking subsequently
observed a shared primitives source edit, so final backend/native packaging still
requires a fresh unchanged-input build; the previous package's partial results
remain historical.

### 2026-11-06 OAuth diagnosis and renewed validation

Guarded native packaging passed on unchanged inputs, producing immutable
`ea5c6048a224-3711f05cc5ab` with engine SHA-256
`3711f05cc5ab40594b2cc73ac769320e324808533e09397e040b72e7080777b1`.
The unknown-worker-price proof passed three times on that compiled engine.
The subsequent complete uncached release attempt recorded **4 PASS / 1 FAIL /
14 SKIP**: HQ Next compilation exhausted Windows virtual-memory/thread capacity
(`1455`, paging file too small). Dependent native acceptance did not start.
This infrastructure failure does not certify the skipped checks.

A live ChatGPT check reproduced the HTTP 400. A scrubbed diagnostic using the
real encrypted host refresh transaction established that **the token endpoint
returns `invalid_grant` before any Responses completion request**. The user
completed manual browser reauthorization; the verified credential was saved
atomically and encrypted, with selected-account concurrency protection. A fresh
compiled-engine completion check is pending its actual result.

A separate reproducible display defect hid the actionable renewal guidance:
`ProviderError.describe()` projected the safe structured body, but `oauthFailure`
put the renewal guidance only in its constructor message. Desktop/WebUI therefore
showed only `invalid request (400)`. The OAuth helper now retains its generated,
non-secret message and authentication type in the structured body. The unchanged
proof is GREEN; **5 files / 74 focused tests PASS**, including seven new cases
for expired-session descriptions, transient retry behavior and secret rejection.
No raw token response or remote error description is exposed.

An opt-in physical dictation acceptance scenario was added. It waits for the
user's own Dictate click, expects the phrase `microphone test complete`, checks
that speech appends to an existing draft without sending a message, and stops
recording in cleanup. Ordinary automated native runs do not start the microphone.
Actual acoustic acceptance remains pending; preparing this scenario is not proof
that a microphone recording succeeded.

Evidence: `.temp_files/desktop-parity-finish/chatgpt-transaction-diagnostic-result.json`,
`chatgpt-reauthorize-state.json`, `chatgpt-after-reauthorization.log`,
`oauth-reauth-round/red.log`, `oauth-reauth-round/green.log`,
`oauth-reauth-round/regressions.log`, and `release-final-clean.log`.

### 2026-11-06 ChatGPT live recovery PASS

The manually reauthorized ChatGPT account passed an actual completion through
immutable compiled engine `ea5c6048a224-3711f05cc5ab`: `gpt-6.1-sol`, **3070 ms**,
input/output usage **11/5**. The engine exited cleanly; no leader run or file-tool
execution was started. This closes the account-specific HTTP 400 boundary.
The accompanying safe renewal-guidance source repair still requires its rebuilt
native acceptance; these are distinct claims.

Evidence: `.temp_files/desktop-parity-finish/chatgpt-after-reauthorization.log`
and `providers-live/1794001873937/result.json`.

### 2026-11-07 final artifact and manual audio boundary

Guarded packaging passed with unchanged expanded inputs (all package source,
workspace package manifests and build scripts), producing immutable
**`c61942622337-203930dd298e`**. Engine SHA-256:
`203930dd298e68d223971dcda785c5d9be5a9093671d4fc6e1ee4ed23a6a397c`.
The complete architecture gate passed again after refreshing the generated
Core API usage inventory. A direct integration regression also confirms that a
real expired SubscriptionOAuthProvider reaches the model-test result with
`authentication`, `auth failed`, `invalid_grant` and safe sign-in guidance:
**2 files / 10 tests PASS**, including the seven helper cases already counted
above.

The manual microphone scenario reached a real available English (United States)
recognizer and waited for a user click and test phrase. It timed out without
observing that start/phrase. The scenario exits 1 and is **not completed**;
this does not establish an acoustic microphone or speech-recognition defect.
Its failure receipt's original `liveMicrophone` field denoted the requested
scenario, not successful recording. Future failure receipts explicitly record
`userStartObserved` and `phraseMatched`; only successful recognition is PASS.
The actual microphone-to-draft boundary therefore remains open.

A sequential validation driver has been launched for the final artifact. It
first repeats the compiled-engine proof, then starts the uncached complete
release check, and starts all **43** native scopes after production build and
lineage verification pass. Historical native passes are not reused because
both artifact and harness changed. Each stage is recorded when it actually runs. The old coverage PID 142620 was
confirmed absent; its lock was left for the standard coverage wrapper to recover.

Evidence: `.temp_files/desktop-parity-finish/oauth-reauth-round/settled-native-1.log`,
`oauth-reauth-round/architecture-refreshed.log`,
`oauth-reauth-round/model-ui-regression.log`, `native-live-microphone.log`,
`settled-validation-state.json`, and `post-oauth-validation-driver.log`.

### 2026-11-07 Windows build worker repair

The final c619 compiled engine also passed the actual ChatGPT completion:
**2112 ms**, input/output **11/5**, with clean engine exit and no leader run.
All three current unknown-worker-price proofs pass on this identical engine;
the validation driver pins the engine and fixture hashes before reusing them.

A further full release attempt failed in HQ Next after successful webpack
compilation: page-data collection opened **29** Bun child processes and a child
aborted out of memory. The installed Next **16.4.5** worker-count implementation
and live stable registry were checked. Its supported `experimental.cpus` option
now bounds Windows static generation to **2** workers; other platforms retain
their existing default. The same package production build passes, generates all
**28/28** static pages, and externalizes scripts across **29** exported pages.
Bun, framework versions, webpack extensions and all checks are preserved.

This is a reviewed build-resource configuration change, verified through the
actual build rather than a test that merely repeats a constant. See the
[Next memory guide](https://nextjs.org/docs/app/guides/memory-usage) and installed
`next/dist/build/index.js` worker selection. The previous failed release run is
retained; a fresh full uncached run now uses `release-post-worker-final.log`.
Native acceptance starts after its production build and lineage gate pass.
The HQ Next output is not embedded by the native engine's asset pack, so this
build-only configuration change does not alter c619's executable identity.

Evidence: `.temp_files/desktop-parity-finish/chatgpt-final-native-engine.log`,
`final-compiled-engine-proof-receipt.json`, `hq-build-worker-round/red-release.log`,
`hq-build-worker-round/green-build.log`, and `hq-build-worker-round/format.log`.

### 2026-11-07 broad-gate follow-up during native acceptance

The complete workspace production build now passes (114.2 seconds), as do
package/catalog projections, build lineage and workspace typechecking. The
running full release attempt still records its initial failed architecture,
skip and test-type gates; later focused successes do not change that history.

The SDK Windows-only skip condition was unchanged. Adding its previously
verified lifecycle deadline changed the skip scanner's three-line fingerprint;
the single reviewed declaration was refreshed, preserving **211** declarations.
Current shared FileWorkspace metrics include the other agent's change-count and
file-kind icon components. Complete architecture and skip-budget follow-ups both
pass. No skip condition or global architecture threshold was weakened.

Three newly added Chronicle test diagnostics were repaired: required installation
and machine scope fields, plus sound `unknown` narrowing for raw parser-boundary
JSON. Original Unicode fixture bytes and all assertions remain. Both affected
files pass **25 tests**, and their complete **100-file** test TypeScript project
has zero errors. A fresh global ratchet and final full release rerun remain
required after the broad running cohort finishes.

The c619 native matrix has observed SDD and Office/Story UI wait timeouts, which
remain failed results pending unchanged isolated reproduction. All three Office
workers were approved and provider-backed; a captured owner then exited with
Windows status -1073740791. No production UI cause is established. The available
Office screenshot predates this run and is explicitly marked stale; it is not
current failure evidence. Current state/process records and logs are preserved
under `native-ui-failure-round`. The matrix continues collecting the other scopes.

Evidence: `reviewed-skip-budget.log`, `reviewed-architecture-followup.log`,
`reviewed-test-skips-followup.log`, `chronicle-test-types-regressions.log`,
`chronicle-test-project-types.log`, and `native-post-worker-final-matrix.log`
under `.temp_files/desktop-parity-finish/`.

### 2026-11-07 serialized recovery after allocation failures

The combined validation producer has ended. Its full root run exits 9 after
memory allocation failure; the root coverage summary was not produced. Its
native matrix process exits **3221226505 (0xC0000409)** during composer.
Actual c619 matrix results are **3 PASS** (models, goals, model-draft restart),
**2 FAIL** (SDD and Office/Story UI waits), composer **interrupted**, and the
remaining **37 scopes not started**. None of the uncompleted checks is green.
The earlier statement that this matrix was still collecting scopes is historical.

The abandoned composer host was linked to the current prompt-journal artifact,
then checked by exact executable path, creation time and absence of a live owned
UI before its tree was stopped. This continuation did not intentionally target
other agents' `ws-desktop-tour` hosts. Cleanup records are preserved.

A new producer runs root validation **sequentially**, with the repository's
supported `WRONGSTACK_VITEST_MAX_WORKERS=2` override and no native UI testing.
API snapshots, architecture, skip budget and the global test-type preflights all
pass. The full uncached release has passed build/lineage, architecture, skips,
workspace types and the test-type ratchet and has reached coverage. It must
finish before the next native acceptance run starts. Approximately thirty
frontend source/style inputs changed independently after c619 packaging; they
are preserved, and a new unchanged-input package is needed for current-UI proof.

The manual microphone helper now additionally observes the **actual Tauri speech
result channel**, forwarding events unchanged. Matching typed text alone cannot
satisfy acoustic acceptance. It records booleans rather than raw speech, verifies
that recording stops and restores the original draft. This strengthens the
prepared test; it does not change the uncompleted physical microphone result.

Evidence: `settled-validation-state.json`, `terminated-native-composer-host.json`,
`terminated-native-composer-cleanup.log`, `serialized-root-state.json`,
`serialized-architecture-preflight.log`, `serialized-skip-preflight.log`,
`serialized-test-types-preflight.log`, and `release-serialized-final.log`
under `.temp_files/desktop-parity-finish/`.


### 2026-11-07 — Kit cleanup deadline and isolated validation follow-up

A production-path regression proof reproduced an early-settlement defect in
`runKitProcess`: its 15-second cleanup deadline expired before the supported
30-second Windows taskkill backstop. The normal-completion control passed; both
timeout and cancellation with a legal delayed exit failed on the original code.
The runner now waits for the Windows backstop plus the existing pipe-drain window;
POSIX behavior is unchanged. The same three cases pass, retained in
`packages/tools/tests/project-kit-runner-lifecycle.test.ts`.

The serialized root coverage run was stopped before this production edit; its
partial results are not certification. The next isolated 9-file cohort completed
with **144 PASS / 8 FAIL**, across **4 passing / 5 failing files**. Remaining
failures are four benchmark stop/resume deadlines, one benchmark descendant
cleanup deadline, one CLI shim cleanup deadline, one Kit Windows exit-code
assertion, and one intermittent PowerShell `EPERM` launch failure. The lifecycle
regression, SDD cleanup, Bash hermetic timeout and core PID checks passed in this
cohort. Exact logs are in
`.temp_files/desktop-parity-finish/kit-kill-grace-round/observed-files-focused.log`.
These failures are being isolated before any further claim of parity or readiness.
The previous c619 native package predates the Kit fix and is not final-source proof.


### 2026-11-07 — Stalled Windows taskkill descendant fallback

A further controlled proof showed that the final direct-wrapper fallback can
orphan a process launched through a Windows `.cmd` shim. The descendant-ready
and unrelated-process controls passed; the descendant remained alive after the
wrapper exited. Explicit `SIGKILL` alone also failed this topology.

The current fallback uses Windows PowerShell/.NET P/Invoke with Toolhelp instead
of a WMI command-line scan. It accepts a real owned `ChildProcess`, validates
its parent and creation time, retains descendant handles and checks creation
times before terminating descendants deepest first. The caller then retains
its existing direct-child stop. Native helper startup is bounded to five seconds;
callers now budget for the 30-second taskkill plus this fallback. On restricted
hosts where the helper cannot run, cleanup retains its prior best-effort behavior.
No dependency or runtime version was changed.

The unchanged real cmd-shim proof now passes with an alive unrelated-process
control (`windows-native-fallback-round/stable-native-green-5s.log`). Its RED
assertion is retained in `red-cmd-unmasked.log`. An earlier FFI candidate was
discarded before acceptance; its logs are not proof of the current implementation.
The permanent regression is
`packages/core/tests/utils/tree-kill-native-windows.test.ts`. Its one explicit
Windows platform guard increases the reviewed declaration inventory from 211
to 212; no previously running test was disabled.

The subsequent critical cohort and metadata checks are in progress. Two
benchmark stop/resume cases have already exceeded their outer deadlines, which
also encompass the separately bounded 30-second post-run process sweeps. These
failures remain open until the complete run and isolated follow-up are reviewed.
This source repair has not yet been rebuilt into an accepted native package.


### 2026-11-07 — Focused follow-up and compiled fallback proof

The stable 13-file critical cohort completed with **193 PASS / 2 FAIL**
(195 tests), with **no owned source input changes during the run**. Both failures
were benchmark outer deadlines that also included legal process-table cleanup.
The benchmark integration tests now budget one 30-second sweep per completed
unit and one final sweep; their result, resume, grading, cancellation and leak
assertions are unchanged. The four-file follow-up is **51/51 PASS**.

The permanent native fallback regression now uses an explicit cleanup marker
and a 60-second safety fuse, so a naturally expiring descendant cannot satisfy
the early-stop assertion under ordinary startup load. Cleanup validates the
owned temporary directory and does not signal arbitrary descendant PIDs.
The paired initial 8-second RED/GREEN proof is preserved separately.

A standalone executable built with the pinned **Bun 1.4.3** also passed the
actual cmd-shim descendant-stop and unrelated-process controls. This verifies
the helper's module loading and native call from a compiled executable; it does
not substitute for acceptance of the full Desktop portable package. Receipts:
`windows-native-fallback-round/compiled-proof-result.json` and
`windows-native-fallback-round/final-followup.log`.

Current metadata checks pass: complete architecture/layer checks, reviewed
212-declaration skip budget and the global test-type ratchet with **0 new**
diagnostics (1042 existing baseline-allowed diagnostics remain). Production
type checks pass for Core (639 files), Tools (395) and Desktop (742). Only the
reviewed ProcessRegistry and independently changed VectorMemoryStore hotspot
measurements were refreshed; unrelated implementation work was preserved.
The current full Desktop suite and full uncached root validation remain the
next gates before rebuilding the native acceptance package.


### 2026-11-07 — Current complete Desktop suite

The authoritative Desktop suite now passes **307/307 files and 1080/1080 tests**
with two workers (`windows-native-fallback-round/desktop-full-current.log`).
The runner is installed Vitest 5.0.5, matching the manifest's `^5.0.5` constraint,
under the pinned Bun 1.4.3.

The first full-root producer stopped at architecture preflight because another
agent's Requirement Intake change introduced a 716-line hotspot. Its actual
code diff was reviewed and preserved; only its measured registry row was added.
The separate retry has reached the full uncached release checks with two workers.
The first attempt did not run the release matrix and is not a failed-test receipt.
No native matrix overlaps this root run. The latest accepted native package and
its input manifests were archived before the next build; the builder now checks
the staged engine against its verified compilation identity and preserves the
latest accepted portable.


### 2026-11-07 — interrupted root run and Windows follow-up

The R2 full root gate did not complete: a roughly six-hour host time gap interrupted
validation. Its surviving process tree was identified by exact creation time and executable
path and stopped; no unrelated agent processes were stopped. Gap-tainted timeout failures
are not treated as reproduced product defects.

- Windows coverage lock liveness now uses .NET process lookup instead of a timing-sensitive
  tasklist CSV probe. Unknown probe outcomes still conservatively preserve the lock.
- `/dev` Windows test fixtures now outlive the complete legal process cleanup budget;
  timeout, exit-code and leak assertions remain intact. These changes and actual PowerShell
  execution passed 81 tests across three files, with one existing skip.
- PowerShell name resolution follows a readable Store execution-alias link to the same
  executable version; explicit paths and unavailable link targets retain their previous
  behavior. The installed-alias path proof failed before the fix and passed afterward.
  Resolver and real PowerShell execution checks: three files, 35 tests PASS, two existing
  platform skips. This does not establish that every intermittent spawn failure is resolved.
- One new Windows-only PID probe guard was reviewed; the skip budget is now 213 declarations.

The latest accepted portable package predates these changes. Full uncached root gates,
a fresh fingerprint-stable native build, the serialized 43-scope native matrix and physical
microphone acceptance remain outstanding. The next root run temporarily prevents automatic
idle sleep for its validation thread and restores the prior execution requirement on exit.


### 2026-11-07 — shared-checkout gate follow-up

R3 architecture preflight stopped on independent Chronicle client growth (705 to 719
lines). The batching/disposal change was reviewed, its ten tests passed, and only that
file's hotspot measurement was refreshed; the source was preserved. R4 then passed
architecture and the reviewed 213-declaration skip gate, but stopped at three new test-type
diagnostics in HQ and Sage. No full root pass is claimed from either attempt.

The Sage diagnostic exposed a real synchronous connection failure: the error handler
accessed its promise before initialization, replacing the connector error with a
ReferenceError. A regression including a successful connection control reproduced this
before the fix. The attempt is now published before the connector executes. The new
regression also checks that a subsequent connection can recover. The HQ test fixture was
updated to use the actual UserInputRequest/UserInputResponse contract.

Sage/HQ follow-up verification: 42 tests PASS across two files; global test-type ratchet
PASS with zero new diagnostics (1042 existing allowed). Full root R5 is running; dependency
audit and production build have passed. Later gates and current native acceptance remain pending.


### 2026-11-07 — root R5 evidence boundary

The uncached two-worker root matrix completed with **17/19 gates PASS**. Architecture
failed on the reviewed Sage hotspot growing from 1733 to 1753 lines. Coverage did not
complete: 4225 test-file result markers were emitted, with two failing Kanban scenarios,
and 4551 coverage chunks totaling roughly 4.2 GB were written. After more than 25 minutes
without another output or chunk, the CPU-active coverage subtree was explicitly stopped.
Its exact creation identities, ancestry and executable digest were verified; the temporary
Bun Node-compatible image matched the pinned Bun binary. The matrix process was preserved
and recorded coverage as failed. **No coverage percentages or passing full test summary
were produced; coverage is NOT COMPLETED.**

The two observed test failures were the asynchronous onConnected/dispose Kanban race
and the Kanban subscriber's out-of-order read/reconnect scenario. Their source and tests
were changing concurrently; both require a fresh focused run before classification.
The final root fingerprint recorded **47 changed inputs**, including Kanban, WebUI server,
Telegram, MCP adapters, shared surfaces, tools and test fixtures. These results therefore
are not full certification of current source. Other agents' changes were preserved.

Fresh current-source Kanban follow-up: both previously failing files now PASS (10/10 tests);
the production/test input hashes remained unchanged during that focused run. No additional
Kanban patch was applied by this continuation.


### 2026-11-07 — current-source follow-up and native rebuild

After the mixed-source R5 run, the changed root suites passed **15 files / 130 tests**,
the changed WebUI suites passed **4 files / 121 tests**, and the complete current Desktop
suite passed **307 files / 1080 tests** in 71.49 seconds. Both earlier Kanban failures
passed on unchanged current inputs; no additional production patch was needed for them.

The coverage-excluded R6 matrix ran against unchanged production/test inputs. It passed
17/18 selected gates, including the full production build/types and architecture. Its
remaining test-type errors came from newly added fixtures: a board lacked its required
column order/version, a Goal host assigned readonly identity after construction and omitted
interface methods, and a Kanban renderer test passed an ignored second argument to its seed
helper. The fixtures now use their actual contracts; unrelated Goal execution fails loudly,
and the renderer regression establishes valid non-empty health/history/verification state
before asserting cleanup. Focused tests pass and the follow-up global test-type ratchet
passes with **zero new diagnostics / 1042 existing allowed**. Together these receipts cover
all 18 non-coverage gates; they are not a passing uncached coverage certification.

Only reviewed Chronicle, Sage and Mailbox hotspot measurements were refreshed. The stale
coverage lock was reclaimed and removed by the normal production ownership wrapper, with
a passing file-based control; it was not deleted manually.

A normal backend rebuild and guarded native packaging subsequently passed; see the current-package checkpoint below. Native Office/Story
acceptance has an opt-in unpriced-worker mode that exercises actual provider-backed workers,
checks missing engine prices, requires an unpriced label without USD zero or a complete
combined estimate, and repeats the native usage assertions after reload. It has not yet
passed on the rebuilt package. The standard matrix now optionally stops after its first
failure and records not-run scopes explicitly; all 43 standard scopes are still required.


### 2026-11-07 — current immutable native package and runtime boundary

The normal backend rebuild and guarded native packaging passed without source drift.
Portable `d4814cbc796c-7a4779e7ad03` contains engine SHA-256
`7a4779e7ad03873b4b09c4b7c9c2448d30f99c503ae262aedbed228d0a408e1c`.
Paid-worker and unavailable-price compiled-engine proofs each passed three runs.
All six configured providers completed real requests successfully on that engine,
including ChatGPT (2494 ms); no additional reauthorization is pending.

Earlier current-package native Office controls repeatedly failed before completing:
raw Windows exits included UI `0xE0000008` and engine `0xC0000409`. Instrumented
runs are diagnostic only and are not acceptance evidence. Read-only source review
found no demonstrated unbounded Office canvas, catalog accumulation or session
restart loop. No speculative production fix or dependency upgrade was applied.

A subsequent uninstrumented paid Office control passed on the same package
(`matrix-2026-11-07T12-45-11-592Z`). Passive measurements throughout that passing
control recorded at least 21665 MiB available system commit and a normal 1480 by
960 client window at 96 DPI. These measurements apply to the passing run; they do
not establish the cause or memory conditions of earlier failures. The earlier
intermittent native exits remain unresolved. The unpriced control and standard
43-scope matrix are tracked independently in `native-current-acceptance-state.json`.


The first native unavailable-price run (`matrix-2026-11-07T12-46-25-412Z`)
reached the usage panel without a renderer error and failed the harness expectation
`/unpriced/i`. The actual English UI correctly stated `1 without a cost estimate`.
Only the harness wording was corrected to require that exact unavailable-price
count. Its independent assertions still require one conversation-owned worker,
no dollar amount for that worker, no complete combined estimate, and the same
behavior after reload. This is a test correction, not a production pricing fix.
The unchanged portable is being rerun with a newly recorded harness digest.


The corrected unpriced run (`matrix-2026-11-07T12-49-49-581Z`) passed its
unavailable-price and reload assertions, then failed `session.kill` with
`Could not stop engine process tree`. Host logs show taskkill terminated the
root engine but returned failure for concurrently exiting Git descendants.
This is distinct from the earlier UI/engine crashes. A real Windows production-path
regression reproduced the false failure before the fix and passed afterward.
The native stop helper now retains process handles for the observed owned tree;
on nonzero taskkill status it accepts completion only if every retained process
object has exited. The standalone Windows boundary proof passed 4/4 tests, including surviving-descendant
refusal and foreign-process preservation. The full native library passed 38/38 tests
(`cargo test --locked --no-default-features --lib`), and `cargo fmt -- --check` passed.
A normal fingerprint-guarded native rebuild is running; rebuilt-package acceptance remains open. No full unpriced scope
or standard 43-scope pass is claimed from these partial assertions.


The stop-fix rebuild compiled the native release successfully but correctly refused
immutable staging: `packages/core/src/sandbox/backends/windows-native.ts` and
`packages/tools/src/process-registry.ts` changed during that build. The prior
portable and manifests were preserved. Five focused current-source suites are
being checked with before/after hashes before the next normal guarded build.
The controller advances to paid/unpriced Office controls and all 43 standard
scopes only after the rebuild succeeds without input drift.


The follow-up five-suite run passed **61/61 tests** with both tracked process-source
hashes unchanged. The subsequent normal guarded build passed without input drift:
portable `90024f0d65cb-868c97037053`, engine SHA-256
`868c9703705352df675b3c977baa24868760edea1c5849e75959e9621fc8ac98`,
source fingerprint `105f1bdd736530e511ed1ae62e06f0d2ae0e5579fb9e6490a97bfc0dd8c513d4`.
The prior d481 portable was preserved. This package includes the verified native
stop helper. Paid/unpriced Office controls and the standard matrix are now running
against it; prior live-provider receipts apply to the prior engine digest.


New-package native controls both passed in full: priced Office
`matrix-2026-11-07T13-07-52-960Z` and unpriced Office
`matrix-2026-11-07T13-09-27-347Z`. Each exercised three real workers,
two projects, three conversation owners, live/completed Office and Story,
reload, stopping one owner and preserving the foreign project. The unpriced
scope also passed exact missing-price labeling, no dollar amount, no combined
complete estimate and usage replay. Its evidence records `workerPricing: unavailable`.
The 43-scope standard matrix has now started on the same immutable 9002 package.
Previous intermittent UI/engine crash observations remain unresolved; these
passing controls prove the stop/pricing paths, not a general crash fix.


### 2026-11-07 — first 9002 standard matrix and Mailbox selector

The first standard matrix on 9002 (`matrix-2026-11-07T13-10-48-293Z`)
ended **8 PASS / 1 FAIL / 34 not run**. SDD, Office/Story, Composer,
Chronicle, Goals, Models, model-draft restart and model profiles passed.
The Mailbox scenario timed out at its initial search locator with no renderer
errors. Its fresh screenshot shows the search field present. Production uses
`type="search"` and the exact accessible name `Search mailbox messages`;
the test still queried role `textbox`. Only the test role was corrected to
`searchbox`, preserving its exact name, project region, time limit and all
subsequent mutation/isolation assertions. Formatting passed. Native verification
of this correction and remaining scopes is pending; no production UI fix is claimed.


The post-matrix probes on the exact new `868c97037053` engine passed:
paid-worker proof **3/3**, unknown-price proof **3/3**, and all six real provider
completions (MiniMax 837 ms, ZAI 1410 ms, Alibaba 2542 ms, OpenCode 1213 ms,
ChatGPT 3028 ms, xAI 688 ms). Cleanup and no-unexpected-leader-run checks passed.
The corrected Mailbox focus runs after those probes; a passing focus will trigger
both Office controls and a new complete standard matrix with the new harness digest.


Corrected native Mailbox acceptance **PASS** in 43 seconds on the unchanged
9002 portable (`matrix-2026-11-07T13-32-22-983Z`). The real bundled UI/engine
passed threads/Markdown, actor read and completion receipts, reopening, reply/direct
send, invalid-recipient refusal and preserved drafts, project isolation, registered
agents and purge/compact/clear without creating conversations. Portable checksums
were verified. A temporary driver initially misparsed the `MATRIX RESULT` summary
as `MATRIX` metadata after the native process had already passed; the result parser
was corrected and the authoritative matrix receipt was independently verified.
Both Office controls and a new full standard matrix were then started with the
corrected harness, without rebuilding or changing production code.


The corrected complete matrix has reached **9/43 PASS, 0 FAIL** on the same
9002 package: Mailbox now passes inside the full batch as well as its focused
proof. Kit is next. The paid and unpriced Office controls also passed again
before this full run (`13-34-32-845Z` and `13-35-30-867Z`). Native harness and
portable hashes remain fixed for the batch; the remaining 34 scopes are pending.


### 2026-11-07 — current native performance measurements

The performance scope passed as a measurement/functional scenario on 9002.
Its authoritative artifact is `.temp_files/desktop-v2-native/performance/native-performance.json`.
These are local fixture measurements, not external-provider throughput, a WebUI
comparison, or a promise that all performance targets have been met.

| Measurement | Observed |
| --- | --- |
| Cold engine connection / complete profile ready | 1707 ms / 8403 ms |
| File tree | 20,000 files, 37 mounted rows; root expansion 34 ms; folder expansion 83 ms; refresh 6388 ms |
| Long transcript | 3000 lines / 186,793 characters; send-to-render 1592 ms; scroll p95 17 ms |
| Streaming frame outlier | Longest 283 ms; one frame over 100 ms |
| Terminal flood | Three terminals, 30,000 lines each; all complete in 9863 ms; combined 9125 lines/s |
| Whole owned process-tree private memory | Idle 3172.2 MB; after terminal load 4872.7 MB |
| Idle memory breakdown | UI 8.1 MB, WebView 234.4 MB, host/engines/consoles 2929.5 MB |

The memory values include owned backend/daemon processes, rather than only the
small UI executable. No memory-efficiency parity claim is inferred from them.


### 2026-11-07 — 36-scope checkpoint and Analytics heading correction

The corrected full matrix (`matrix-2026-11-07T13-36-32-634Z`) ended
**36 PASS / 1 FAIL / 6 not run**. Its accessibility report recorded **zero
violations at every impact level** and **zero overflowing German labels**.
The gap-closing scope successfully ran the engine commands and deletion confirmation,
then timed out expecting `Analytics Dashboard`. Its fresh screenshot shows the
correct Analytics page open. Desktop deliberately supplies `heading={t('pages.analytics')}`
to the shared dashboard, so the visible h1 is `Analytics`. Only the native test's
exact h1 expectation was corrected; routing and production code were preserved.
Formatting passed. The last seven scopes now run serially as a diagnostic cohort,
without fail-fast, to expose remaining failures before another complete matrix.


### 2026-11-07 — complete 9002 scope coverage and current-source refresh

The final diagnostic cohort (`matrix-2026-11-07T14-35-31-545Z`) passed
**7/7**, including the complete default end-to-end scenario. Together with the
36 unchanged-scope passes, every standard scope now has native evidence on the
same immutable 9002 package. This is explicitly **two batches**, not one 43/43 run.
A redundant single-batch recheck was started, then intentionally superseded when
source tracking found **75 changed build inputs, including 13 Desktop inputs**.
Only its matrix subtree was stopped after exact creation-time/executable identity
verification; taskkill returned success and the retained root handle signaled exit.
That cancellation is not classified as another reproduced product failure.

Current-source Desktop validation subsequently passed:

- Production typecheck: **742 files, zero errors**.
- Complete Desktop suite: **307 files / 1083 tests**, Vitest **5.1.0** from the
  Desktop workspace; both result cache and filesystem module cache disabled.
  The 1023 recorded Desktop source/test inputs were unchanged throughout.
- Global test-type check initially found 14 new fixture diagnostics. Delegation
  results are now narrowed by their discriminant, the delegation-only fixture
  returns its actual union arm, optional notice captures accept explicit undefined,
  the inbox fixture uses canonical `note`, and the sandbox fixture supplies actual
  tool metadata and execution options. Production types and baseline were preserved.
- Five focused files passed **64 tests** with unchanged corrected fixture hashes.
  The original global ratchet now passes: **44 projects, zero new diagnostics,
  1032 present diagnostics against the existing 1920 allowance**.

Root Vitest remains 5.0.5 while Desktop pins 5.1.0; the workspace-specific runner
identities were inspected instead of treating these as a mid-test dependency change.
A current-source pipeline waits for competing test/build writers, checks Desktop
input hashes, performs a normal guarded build preserving 9002, and then runs
Office controls, the full 43 scopes and exact-new-engine live probes serially.


### 2026-11-07 — stable current-source package

The current-source normal build passed with no before/after input drift:
portable **`9e8394f466c4-e12b1f05c2f5`**, engine SHA-256
`e12b1f05c2f5cd2915a754f4c4ea5e3d78ce9bc2ebf2498283558220c8afe052`,
source fingerprint `c9ad828364b852aa2863a1639e82d98807346952e14b63c8df2a0d17703def2f`.
The previous 9002 portable was preserved. The new package's priced and unpriced Office controls
both passed; its full standard matrix has started (SDD PASS). New-engine
worker and actual-provider proofs are queued serially after native acceptance.
Prior 868c provider receipts are not transferred to this different engine digest.


The current-source 9e83 package's complete Office controls both passed:
priced `matrix-2026-11-07T15-34-24-685Z` and unavailable-price
`matrix-2026-11-07T15-35-46-172Z`. Both retain the three-worker/two-project/
three-conversation ownership, native pricing/reload and foreign-stop assertions.
The full 43-scope standard matrix is now active on 9e83; its first SDD scope passed.


### Protected native continuation and isolated tree diagnosis (2026-11-08)

The original current-package matrix passed 18 scopes before the source guard stopped it during temporary shared-checkout harness removal. A checksum-verified protected copy recovered all 6,503 production inputs and the exact 97-input harness hash `7aa96ccaa54ecab7b07d9c379897ebd2c2f408a1c5206ca909ecce4389dcb8ae`. The next 25-scope batch failed Files: the 3,000-file `bulk-tree` locator did not appear within 20 seconds; 24 later scopes did not run. Its journal contains six responses with all 3,000 files, so the evidence does not support calling this an absent backend folder. No renderer error or native exit was recorded in that failure.

An isolated real-native run on the same portable passed the unchanged tree-scale assertions: 3,000 files, 36 mounted tree rows, folder pagination, End/Home navigation, and deep search. The initial README control passed. This proves that focused scenario, not the complete Files scope or an intermittent-race fix. Samples also captured a request-acknowledgement timeout; the full Files sequence is being repeated before assigning a root cause. Production code was not changed for this diagnosis.

The current `e12b1f05c2f5cd2915a754f4c4ea5e3d78ce9bc2ebf2498283558220c8afe052` engine passed paid-worker probes 3/3, missing-price probes 3/3, and real completions from all six configured providers (MiniMax, ZAI, Alibaba, OpenCode, ChatGPT, xAI). Provider engine shutdown and worker/provider cleanup checks passed. These current-engine receipts supersede the earlier 868c-only provider boundary.

Evidence: `.temp_files/desktop-parity-finish/current-source-validation/source-recovery/engine-probes-state.json`, frozen matrix `matrix-2026-11-07T16-59-03-060Z`, and `.temp_files/desktop-parity-finish/tree-scale-isolated/prepared.json` (points to the isolated portable run and artifacts). The protected full recheck is tracked separately in `remaining-recheck-state.json`; no combined 43-scope PASS is claimed while it runs. Physical microphone acceptance, uncached root coverage, and diagnosis of older intermittent native exits remain open.

Full recheck interim checkpoint: Files failed at the Git `native-hunks.txt` change-row lookup (acknowledgement timeout shown); Roster failed after the page/browser connection closed; Automation passed in 95 seconds and MCP is active. Together with the earlier 18 passed scopes this is 19 distinct current-package PASS scopes, not full acceptance. Four captured journals replayed through the real state reducer without errors after matching native incomplete-tail handling. A metadata-only full Files trace is queued serially after this matrix, without changing production code or existing assertions.

Runtime interruption checkpoint (2026-11-08): the resumed matrix stopped after Fleet because the Bun controller exited `0xC0000409`; Atlas had started but did not produce a result. The combined exact-package inventory is **21 PASS / 4 failed scopes / 18 incomplete scopes**. A process-object observer captured Bun and bundled-engine `0xC0000409` exits; Windows Application Error confirms an engine fault at offset `0x42b32a5`, and also records a WebView2 `0xC0000005` event. These codes are observations, not a diagnosed root cause. Sampled available system commit fell to 3,677 MiB of 211,648 MiB; physical memory remained available. Unrelated applications were not closed.

The queued metadata-only full Files attempt failed at the initial Prompt library gate. Its metadata file contains no captured calls, so it supplies no proof about request-loss location; the tracing harness needs correction before that claim could be made. Evidence and complete scope accounting: `.temp_files/desktop-parity-finish/tree-scale-isolated/acceptance-latest.json`, `resume-exit-observation.json`, `resume-memory-samples.jsonl`, and `application-errors.json`. No production fix is claimed from these runs.


### Native IPC diagnostic correction (2026-11-08)

A minimal real-native `snapshot` control confirmed that `window.__TAURI_INTERNALS__.invoke` and its parent global are non-writable and non-configurable. Replacing that function silently failed, which explains the previous zero-row metadata attempt; it was an ineffective diagnostic harness, not evidence that the application issued no calls. A CDP function-call observer then captured native calls and replies with **zero debugger pauses**, both before and after an actual page reload. The observer does not replace Tauri functions and persists only method/request IDs, event types/IDs and timestamps, not payload bodies or credentials. The full original Files scenario is now running with this verified observer, separately from acceptance counts. Relevant files: `.temp_files/desktop-parity-finish/tree-scale-isolated/ipc-control-state.json`, `ipc-cdp-control-state.json`, `ipc-trace-reload-state.json`, `full-cdp-state.json`. The diagnostic uses the [official CDP function-call breakpoint API](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json).


### File refresh overlap reproduced and repaired (2026-11-08)

A real `FileWorkspace` component regression, mocking only engine I/O, first rendered the normal README control and then reproduced three concurrent `files.tree` requests during a watcher burst (expected maximum one). The source fix serializes full snapshots, combines changes arriving during one read into a fresh follow-up, and drops queued work when the view closes. StrictMode remount remains usable. Three new component tests pass; together with adjacent file-tree/localization and notification tests, the focused run is **4 files / 16 tests PASS**. This fixes independently reproduced refresh amplification; it does not diagnose earlier native runtime crashes.

The earlier immutable 9e83 package passed the full Files workflow with the verified metadata-only observer, including conflicts, bulk operations, the 3,000-file tree and Git history. This is pre-fix evidence. Latency analysis now uses the **first** receipt for each request UUID: replaying the same journal after reload must not be counted as a delayed acknowledgement. The previous 88-second last-receipt calculation was invalid; the longest observed first receipt was a 17.9-second `files.tree` request.

The initial complete current Desktop suite was **315 files, 1123 passed / 1 failed test**. That failure was a notification test constructing the supposedly same fixture with a new timestamp on each call; a single fixed timestamp now preserves its identity, and the focused suite passes. Production notification behavior is unchanged. The full suite is being rerun. The validation wrapper was also corrected to propagate failed suites/non-stable inputs as nonzero exits, and guarded native packaging independently requires a passing Desktop test receipt. The first run is archived under `tree-scale-isolated/fixed-validation/attempt-1-notification-failure`. Current production typecheck passed **754 files**. The broad pre-build test-type gate found 745 new diagnostics, including 736 missing-declaration diagnostics; Desktop had no new test-type diagnostics. It will be repeated after the normal dependency/native rebuild; no baseline was expanded.


### Current protected 1.5.2 checkpoint (2026-11-08)

The source copy at `C:\Users\ersin\AppData\Local\Temp\wrongstack-parity-build-o7gd1z1i` contains 14,659 unique source paths and 48 workspaces with local workspace dependency links. Its complete Desktop suite passed 315 files / 1124 tests without Desktop input drift; production types passed 754 files. A normal backend rebuild and guarded native build staged `52d3697b278a-c86179698276`. The two files were copied into the main checkout’s immutable `dist-native` directory only after checksum verification; `wrongstack-engine.exe --version` reports 1.5.2. No installed application was replaced.

The fresh declaration build removed the 736 missing-declaration diagnostics. Seven remaining fixture diagnostics were repaired using real intervention enums/source values, the actual provider-runner function contract, and explicit execution options. Only three core test files were overlaid into the protected copy; their hashes were recorded and none is a production build input. Those tests passed 87/87, followed by the full 44-project type ratchet with 0 new / 1032 present diagnostics against the unchanged 1920-entry allowance.

The same c861 engine passed paid-worker probes 3/3, unknown-price probes 3/3, and real completions from all six configured providers. Fixture cleanup/engine exit was observed; this is not a claim that every runtime shutdown had exit code zero. Current receipts: `.temp_files/desktop-parity-finish/tree-scale-isolated/quality-summary.json`, `current-fixed-package.json`, and `current-engine-probes-state.json`.

Native acceptance is still incomplete. The first Files case lost its native window at Monaco startup; the process observer recorded native exit `0xE0000008`, available system commit as low as 490.72 MiB, and then the controller failed to create a process with WinError 1455 (paging file too small). This did not pass the Files workflow. Its state and observations are preserved in `native-resource-failure-52d3697b/`. A new 43-scope controller, retaining the repository’s unchanged native-smoke assertions and harness hash, waits for at least 16 GiB available commit before each scope. It uses Python orchestration so a separate long-lived Bun matrix controller cannot erase later scope coverage. The repository’s original Bun matrix command is not being reported as passed.

A provenance/creation-time/path audit found no live native or protected-runtime test leftovers to stop. User applications were left running. Restarting the unrelated ~19 GiB Logitech G Hub background process requires the user’s explicit approval; it has not been restarted. Physical acoustic Dictate acceptance and uncached root coverage remain open.


### Approved resource recovery and post-fix native Files PASS (2026-11-08)

After the explicit G Hub restart request, the user replied “devam et”. The selected background process was rechecked by PID, creation time, image hash/path and original arguments, then restarted with its same command hidden. Replacement liveness was verified; other applications were untouched. Available Windows commit increased from 10.82 to 28.89 GiB and the native gate resumed automatically. Receipt: `tree-scale-isolated/memory-blocker-restart-result.json`.

The current1.5.2 package passed the full native Files workflow, including code/plain editor, version-bound save, hunk stage/unstage, stale refusal, conflict variants, large-tree pagination/keyboard/search, bulk operations and history graph. Checkpoint1/43 PASS, no failed scope in this resumed run; Roster active. The first low-memory attempt remains failed/incomplete. One extra unpriced Office variant is queued after standard43; the standard Office scope already exercises priced workers, so that variant is not duplicated.
