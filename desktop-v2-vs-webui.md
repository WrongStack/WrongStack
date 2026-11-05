# Desktop v2 vs WebUI — Current Gap Analysis

Updated: **2026-11-04**. Source snapshot: `270618a3d` plus the existing dirty working tree.
Both frontend manifests identify version `1.4.0`. This report compares source implementations;
it does not certify an installed desktop binary, a running WebUI, or a published desktop release.

## How much difference remains?

**Most of the old missing-screen inventory has closed. The remaining work is action-level
depth, host/data-feed differences, and acceptance/release evidence. Full parity is still unproven.**

The current desktop feature catalog maps **32/32 WebUI views, 7/7 activities and 16/16 settings
tabs**, with no duplicate mappings; the existing parity test passed in this review. These are
catalog mappings, not 55 independently completed workflows. The 7 WebUI dock sections are a
separate inventory and are not checked by that test.

There is no defensible overall completion percentage: a mapped analytics entry does not render
WebUI's analytics dashboard, and a shared office component does not populate every host feed.
An action-by-action denominator and native acceptance matrix would be needed for that number.

The previous report understated both frontends. Desktop now has setup, provider test/quota,
session story, office, council cards, context editing, slash commands and multilingual UI.
WebUI already has a full terminal, SAGE, MCP management, OAuth/health, model editors and Brain
settings. Those must no longer be described as absent.

## 1. Why the gap is smaller

Both applications now consume feature UI from
[`@wrongstack/project-surfaces`](packages/project-surfaces/package.json).
Desktop supplies native project/profile/session adapters; WebUI supplies its own host adapters.
Sharing a component reduces presentation drift, while transport, state ownership and lifecycle
still need separate verification.

| Shared feature surface | Desktop entry point | WebUI entry point |
| --- | --- | --- |
| SAGE / memory management | [ProjectSage](apps/desktop-v2/src/ProjectSage.tsx) | [MemoryManager / SageTabs](packages/webui/src/components/MemoryManager/SageTabs.tsx) |
| Kanban workbench and inspectors | [ProjectKanban](apps/desktop-v2/src/ProjectKanban.tsx) | [KanbanView](packages/webui/src/components/KanbanView.tsx) |
| Code Atlas / CodeMap | [ProjectAtlas](apps/desktop-v2/src/ProjectAtlas.tsx) | [CodeMap](packages/webui/src/components/CodeMap.tsx) |
| Setup, provider tests and quota | [ProviderSurfaces](apps/desktop-v2/src/ProviderSurfaces.tsx) | [SetupScreen](packages/webui/src/components/SetupScreen.tsx), [ProviderTestView](packages/webui/src/components/ProviderTestView.tsx), [ProviderQuotaView](packages/webui/src/components/ProviderQuotaView.tsx) |
| Session Story dashboards | [SessionStory](apps/desktop-v2/src/SessionStory.tsx) | [SessionStoryView](packages/webui/src/components/SessionStoryView.tsx) |
| Agent Office / topology | [ProjectOffice](apps/desktop-v2/src/ProjectOffice.tsx) | [OfficeWorkspace](packages/webui/src/components/OfficeWorkspace.tsx) |
| Runtime debug dashboard | [ProjectDiagnostics](apps/desktop-v2/src/ProjectDiagnostics.tsx) | [DebugDashboard](packages/webui/src/components/DebugDashboard.tsx) |
| Context dashboard | [SessionContextDashboard](apps/desktop-v2/src/SessionContextDashboard.tsx) | [ContextDashboard](packages/webui/src/components/ContextDashboard.tsx) |
| Council decision card | [CouncilCard](apps/desktop-v2/src/CouncilCard.tsx) | [CouncilDecisionCard](packages/webui/src/components/ChatView/CouncilDecisionCard.tsx) |

This does not make all project domains shared: Files, Git review, roster, automation and many
settings still have desktop-owned implementations.

## 2. Corrections to the old Desktop-missing list

| Previous claim | Current desktop implementation | Status / boundary |
| --- | --- | --- |
| Setup / onboarding missing | `ProviderSurfaces` renders shared `SetupScreen`; WrongStack settings has Quick setup | Implemented; real account/vault lifecycle still requires external acceptance |
| Provider tests / quota only partial diagnostics | Dedicated Model tests and Plan quota pages render the shared views | Implemented UI; broad live-provider coverage is separate |
| Session Story missing | Session workspace renders shared `SessionStoryView` | Implemented; feed differences remain below |
| Analytics / debug all missing | Shared `DebugDashboard`, `SessionUsage`, project/profile recorded usage | Partial: full AnalyticsDashboard and RefreshDebugView are still distinct |
| Requirements intake uncertain | `ProjectRequirements`, resource inputs and durable drafts | Implemented workflow; suggestion/assessment depth remains backlog |
| Agent Office missing | Project `office` route renders shared `OfficeWorkspace` | Implemented; project feed lacks some conversation-level data |
| Council cards missing | Transcript lazy-loads shared `CouncilDecisionCard` | Decision card implemented; full council execution/inspection is a separate scope |
| Context editor only a dialog | Context panel has validated removal/apply, text cuts, modes, residency and retention | Functional implementation; dialog placement is a UX difference |
| Slash system absent | `desktop-commands`, `desktop-command-runner`, composer completion/help and aliases | Implemented; selected WebUI routes covered by focused tests, not every possible command argument |
| i18n absent / WebUI has 8 locales | Both support **7** locales: en, tr, de, fr, it, es, pt-BR; desktop has its own shell catalog and shared catalogs | Locale infrastructure implemented; untranslated strings and manual layout/accessibility review remain |

Evidence: [settings routing](apps/desktop-v2/src/WrongStackSettings.tsx),
[project routing](apps/desktop-v2/src/ProjectWorkspace.tsx),
[session routing](apps/desktop-v2/src/EngineWorkspace.tsx),
[context controls](apps/desktop-v2/src/SessionContextPanel.tsx),
[locale loading](apps/desktop-v2/src/surface-i18n.ts),
[supported languages](packages/project-surfaces/src/lib/languages.ts).
For example, `ContextEditorDialog` still contains English action labels, so equal locale keys
must not be interpreted as complete translation of every visible control.

## 3. Concrete WebUI capabilities still different in Desktop

| Area | WebUI | Desktop / remaining difference |
| --- | --- | --- |
| Full analytics dashboard | [AnalyticsDashboard](packages/webui/src/components/AnalyticsDashboard.tsx) combines event/category breakdowns, sessions, tool activity, usage and cost | `SessionUsage` and `ProjectUsageSummary` cover session estimates and project/profile token totals. The full dashboard is not rendered; an `analytics` catalog mapping alone does not close this gap |
| F5 recovery diagnostics | [RefreshDebugView](packages/webui/src/components/RefreshDebugView.tsx) exposes browser persistence/replay and cross-session checks | No equivalent dedicated desktop screen. Native host/reconnect semantics differ, so its acceptance checks need a desktop-specific design |
| Language-aware file editor | [CodeEditor](packages/webui/src/components/CodeEditor.tsx) uses Monaco; [MonacoDiffView](packages/webui/src/components/MonacoDiffView.tsx) supports editable side-by-side diffs | `FileWorkspace` uses a textarea with editing helpers. Monaco-style language services and WebUI's inline `completion.request` workflow are not implemented |
| Multi-participant collaboration | WebUI has `collab.*` participant control, annotations and injection workflows | Desktop has mailbox/fleet workflows but no participant/identity model or equivalent `collab.*` UI. This is a deliberate scope difference, not a missing mailbox screen |
| Office data depth | WebUI host can supply conversation fleet agents, transcripts and tool events | [desktop-office-feed](apps/desktop-v2/src/desktop-office-feed.ts) supplies project registry/mailbox activity but returns empty fleet-agent, agent-transcript and tool-event collections. The map exists; those feeds are not equivalent |
| Story integration depth | WebUI story host integrates its agent/context-request state | [desktop-story-feed](apps/desktop-v2/src/desktop-story-feed.ts) reads conversation Chronicle/mail/memory data but returns an empty roster and an inactive context-request hook. Shared dashboards do not establish identical host behavior |

These are specific source-level differences found in this pass. They are not a complete
enumeration of every button, protocol operation, shortcut or error state.

## 4. Corrections to the old WebUI-missing list

| Previous claim | Current source evidence | Assessment |
| --- | --- | --- |
| No full terminal pane | [TerminalPanel](packages/webui/src/components/TerminalPanel.tsx), mounted by [ViewRouter](packages/webui/src/components/ViewRouter.tsx) | Incorrect. Both have PTY-backed terminal UI; native desktop and server-hosted WebUI lifecycles differ |
| No Brain policy management | [BrainSection](packages/webui/src/components/SettingsPanel/BrainSection.tsx) and its rules/models/council/cache/trace/ledger sections | Incorrect. Compare individual controls before claiming a policy gap |
| MCP only in chat/protocol | [MCPSection](packages/webui/src/components/SettingsPanel/MCPSection.tsx), mounted by IntegrationsSection, handles connection lifecycle and auth state | Incorrect. Desktop's separate tool/content/task editors may differ in depth; blanket absence is false |
| No OAuth / health UI | [OAuthLoginSection](packages/webui/src/components/SettingsPanel/OAuthLoginSection.tsx), [ProviderHealthSection](packages/webui/src/components/SettingsPanel/ProviderHealthSection.tsx) | Incorrect |
| Model management missing | [ProviderModelsPanel](packages/webui/src/components/SettingsPanel/ProviderModelsPanel.tsx), ModelListEditor, ModelSchemaEditor and ModelTiersSection | Incorrect. Exact metadata/pricing/draft-admin equivalence needs a field-level comparison |
| SAGE types only / Kanban store only | Shared SAGE and Kanban feature surfaces are rendered by both applications | Incorrect. The full shared inspector/graph workflows must be counted |
| Vector memory uncertain | Shared SAGE surface includes vector-memory UI; desktop also has dedicated memory entry points | Neither frontend should be treated as lacking the whole feature; backend configuration and enabled-store behavior still need acceptance |
| Context modes absent | [ContextModePicker](packages/webui/src/components/ContextModePicker.tsx), context dashboard/editor and context settings | Incorrect as a blanket claim; residency/authoring controls need individual comparison |

Desktop also has substantial dedicated recovery, session plans, MCP tasks, Git hunk/conflict,
automation evidence/comparison/publication, roster, prompt journal/refinement, bulk-file and
worktree interfaces. Their existence is confirmed by the source inventory, but **this review
does not establish that every corresponding WebUI action is missing**. The old table inferred
absence from different component names and store organization; that inference is removed.

## 5. Remaining depth and acceptance work

The following is tracked delivery/verification work, not automatically a WebUI-only feature.
The [continuation backlog](docs/desktop-v2-next.md) and
[chat action inventory](docs/desktop-v2-chat-parity.md) contain the detailed boundaries.
Some older rows in [feature parity](docs/desktop-v2-feature-parity.md) predate the shared-surface
migration; current code takes precedence.

| Domain | Existing baseline | Remaining work / evidence boundary |
| --- | --- | --- |
| Conversation / history | Slash commands, stories, context edits, refinement comparison, rewind/redo/retry and retained history | Tool/media rendering depth, very long transcripts and compressed histories, reconnect/cancellation/partial-error behavior |
| Providers / policies | Setup, model editors, fallbacks/routing, OAuth/health UI, Brain/Fleet settings | Real account refresh/vault lifecycle, atomic custom-model writes, effective cross-runtime policies and real council/worker execution |
| Files / Git / worktrees | Bulk actions, version-bound saves, line staging, conflicts, discussions and managed run worktrees | Language-aware editor parity, external-writer races, binary/mode/symlink/submodule cases and broader native worktree acceptance |
| Agents / collaboration | Roster, live fleet, office, mailbox and session side effects | Per-worker routing/control, richer ancestry and feed data, receipt/retention depth, atomic multi-window operations and participant collaboration |
| Planning / project intelligence | Shared Kanban/SAGE/Atlas plus Goals, SDD, intake, Chronicle, Design, Kit, TechStack, Dead Code and Chimera | Domain-specific authoring/controls, real-model/external-service execution and large-catalog/restart/concurrency coverage; these are not absent project screens |
| Automation / MCP / processes | Structured automation evidence/publication UI, MCP auth/secrets/content/tool/task controls and process/browser interfaces | Real authorization-server acceptance, deeper lifecycle stress, publication click-through/signing, cache administration and browser/watcher integration |
| Usage / billing | Session cost estimates; recorded project/profile tokens by provider/model | Historical billing attribution, aggregate context-tier pricing and complete worker-inclusive project totals |
| Product / distribution | Native projects/windows/terminals, themes and 7 locale catalogs | Manual microphone/screen-reader/long-label passes, older-host migration, performance/scale and signed installers/update artifacts |

The continuation document records a **36/36 native release-build matrix on 2026-11-02** and
states that the first-release feature scope is complete. That is historical repository evidence,
not a native matrix rerun in this review and not proof of full WebUI parity. It also records
that the desktop executable is not yet a release asset and signed installer/update delivery
remains outstanding; release hosting was not rechecked here.

## 6. Verification performed for this update

Only `desktop-v2-vs-webui.md` was edited for this task. Existing application/test changes were
already present and were left intact.

- Read current navigation contracts, desktop catalog, mounted workspace/settings routes,
  shared-surface imports, locale setup and the adapters behind office/story.
- Inspected WebUI terminal, settings, editor, analytics and refresh-diagnostic implementations
  to correct false absence claims.
- **PASS:** desktop `bun run typecheck` — no type errors in **671 files**.
- **PASS:** desktop `bun run test` with these 12 existing files — **67 tests passed**:
  `feature-parity`, `desktop-slash-parity`, `desktop-commands`, `desktop-story-feed`,
  `desktop-office-feed`, `council-decisions`, `surface-i18n`, `desktop-shell-i18n`,
  `profile-surface-host`, `context-editor-model`, `context-modes-model`,
  `context-residency-model` (all under `apps/desktop-v2/tests/*.test.ts`).
- Documentation links and whitespace checked after editing.
- **NOT RUN:** full desktop/WebUI suites, native UI matrix, real provider/OAuth flows,
  manual accessibility/microphone checks, production builds, release gates and hosted CI.
  This documentation update is not a release certification.

Suggested next parity pass: inventory actions for the six concrete differences in section 3,
then test their desktop host adapters and user-visible workflows. Keep functional parity,
intentional platform differences and release acceptance as separate results.
