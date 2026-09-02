# Architecture Health Report

**Generated:** 2026-09-02T18:55:13.588Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 36 |
| Production source files | 3504 |
| Production source lines | 855936 |
| Test files | 3082 |
| Workspace dependency edges | 128 |
| Relative module edges | 10972 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 9 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- packages/cli/src/execution.ts: hotspot grew from 878 to 881 lines; review and update the ratchet in the same change
- packages/cli/src/fleet/host.ts: hotspot shrunk from 841 to 839 lines; review and update the ratchet in the same change
- packages/cli/src/goal-host.ts: hotspot grew from 930 to 931 lines; review and update the ratchet in the same change
- packages/cli/src/plugin-management.ts: hotspot shrunk from 1038 to 1033 lines; review and update the ratchet in the same change
- packages/cli/src/slash-commands/sdd.ts: hotspot grew from 1003 to 1014 lines; review and update the ratchet in the same change
- packages/cli/src/webui-server.ts: hotspot grew from 941 to 943 lines; review and update the ratchet in the same change
- packages/core/src/chronicle/file-observer.ts: hotspot shrunk from 812 to 807 lines; review and update the ratchet in the same change
- packages/core/src/chronicle/query.ts: hotspot grew from 1297 to 1309 lines; review and update the ratchet in the same change
- packages/core/src/coordination/autonomous-coordinator.ts: hotspot grew from 982 to 1103 lines; review and update the ratchet in the same change
- packages/core/src/coordination/collab-debug.ts: hotspot grew from 900 to 915 lines; review and update the ratchet in the same change
- packages/core/src/coordination/director.ts: hotspot shrunk from 967 to 966 lines; review and update the ratchet in the same change
- packages/core/src/coordination/fleet-supervisor.ts: hotspot grew from 828 to 834 lines; review and update the ratchet in the same change
- packages/core/src/coordination/provider-status-tracker.ts: hotspot shrunk from 1096 to 1092 lines; review and update the ratchet in the same change
- packages/core/src/coordination/subagent-budget.ts: hotspot grew from 828 to 855 lines; review and update the ratchet in the same change
- packages/core/src/core/fallback-model.ts: hotspot grew from 874 to 879 lines; review and update the ratchet in the same change
- packages/core/src/execution/prompt-enhancer.ts: hotspot shrunk from 823 to 814 lines; review and update the ratchet in the same change
- packages/core/src/hq/protocol/core.ts: hotspot shrunk from 949 to 944 lines; review and update the ratchet in the same change
- packages/plugins/src/duplicate-code-detector/index.ts: hotspot shrunk from 876 to 872 lines; review and update the ratchet in the same change
- packages/plugins/src/git-autocommit/index.ts: hotspot grew from 1022 to 1030 lines; review and update the ratchet in the same change
- packages/plugins/src/prompt-firewall/index.ts: hotspot grew from 938 to 955 lines; review and update the ratchet in the same change
- packages/plugins/src/secret-scanner/index.ts: hotspot grew from 927 to 934 lines; review and update the ratchet in the same change
- packages/plugins/src/semantic-search-indexer/index.ts: hotspot grew from 936 to 948 lines; review and update the ratchet in the same change
- packages/plugins/src/semver-bump/index.ts: new 807-line hotspot is not in architecture/hotspots.json
- packages/plugins/src/test-runner-gate/index.ts: hotspot grew from 861 to 876 lines; review and update the ratchet in the same change
- packages/primitives/src/regex-ambiguity.ts: hotspot grew from 827 to 834 lines; review and update the ratchet in the same change
- packages/providers/src/openai-codex.ts: hotspot grew from 817 to 819 lines; review and update the ratchet in the same change
- packages/sage/src/domain-term-extractor.ts: hotspot shrunk from 873 to 872 lines; review and update the ratchet in the same change
- packages/sage/src/sqlite-store.ts: hotspot shrunk from 1063 to 1033 lines; review and update the ratchet in the same change
- packages/sage/src/tools/memory-tools.ts: hotspot shrunk from 985 to 977 lines; review and update the ratchet in the same change
- packages/sage/src/types.ts: hotspot grew from 993 to 996 lines; review and update the ratchet in the same change
- packages/tools/src/codebase-index/writer.ts: hotspot shrunk from 1081 to 1080 lines; review and update the ratchet in the same change
- packages/tools/src/json.ts: hotspot grew from 861 to 908 lines; review and update the ratchet in the same change
- packages/tui/src/components/context-panel.tsx: hotspot shrunk from 1024 to 1014 lines; review and update the ratchet in the same change
- packages/tui/src/components/history/utils.tsx: hotspot grew from 1015 to 1030 lines; review and update the ratchet in the same change
- packages/tui/src/components/settings-picker-model.ts: hotspot grew from 1089 to 1095 lines; review and update the ratchet in the same change
- packages/tui/src/components/settings-picker.tsx: hotspot grew from 816 to 821 lines; review and update the ratchet in the same change
- packages/tui/src/components/sidebar-content.tsx: hotspot grew from 1035 to 1041 lines; review and update the ratchet in the same change
- packages/tui/src/input-validation.ts: hotspot grew from 959 to 983 lines; review and update the ratchet in the same change
- packages/tui/src/reducers/settings-values.ts: hotspot grew from 842 to 845 lines; review and update the ratchet in the same change
- packages/webui/src/components/AgentOfficeView.tsx: hotspot shrunk from 1089 to 1081 lines; review and update the ratchet in the same change
- packages/webui/src/components/AudienceMemoryPanel.tsx: hotspot grew from 906 to 909 lines; review and update the ratchet in the same change
- packages/webui/src/components/CodeMap.tsx: hotspot shrunk from 936 to 931 lines; review and update the ratchet in the same change
- packages/webui/src/components/ContextDashboard.tsx: hotspot shrunk from 1046 to 1044 lines; review and update the ratchet in the same change
- packages/webui/src/components/FileActivityDrawer.tsx: hotspot shrunk from 1063 to 1062 lines; review and update the ratchet in the same change
- packages/webui/src/components/OfficeMapCanvas.tsx: hotspot grew from 1044 to 1049 lines; review and update the ratchet in the same change
- packages/webui/src/components/SddWizard.tsx: hotspot grew from 851 to 899 lines; review and update the ratchet in the same change
- packages/webui/src/components/SidePanel/SkillsList.tsx: new 800-line hotspot is not in architecture/hotspots.json
- packages/webui/src/components/SkillDetailView.tsx: hotspot grew from 915 to 1051 lines; review and update the ratchet in the same change
- packages/webui/src/components/TechStackView/index.tsx: hotspot grew from 831 to 865 lines; review and update the ratchet in the same change
- packages/webui/src/hooks/ws-handlers/misc-handlers.ts: hotspot grew from 992 to 1004 lines; review and update the ratchet in the same change
- packages/webui/src/stores/viz-store.ts: hotspot grew from 974 to 1110 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/context-editor.ts: hotspot grew from 1020 to 1039 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/file-handlers.ts: hotspot shrunk from 1108 to 1105 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/routes.ts: hotspot shrunk from 966 to 964 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/session-handlers.ts: hotspot grew from 1706 to 1715 lines; review and update the ratchet in the same change
- packages/webui-server/src/server/start-webui.ts: hotspot grew from 1044 to 1053 lines; review and update the ratchet in the same change
- apps/desktop/src/renderer/src/renderer.ts: hotspot grew from 944 to 961 lines; review and update the ratchet in the same change
- packages/webui-hq/src/app.tsx: stale hotspot baseline; remove or tighten it in the same change
- packages/webui-hq/src/views/control.tsx: stale hotspot baseline; remove or tighten it in the same change
- packages/webui-hq/src/views/settings.tsx: stale hotspot baseline; remove or tighten it in the same change
- packages/tools/src/builtin.ts: "BUILTIN_TOOL_DESCRIPTIONS" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/local-prefs.ts: "getHqLocalPrefsSnapshot" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/local-prefs.ts: "reloadHqLocalPrefs" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/local-prefs.ts: "resetHqLocalPrefs" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/selectors.ts: "actionableAlertCount" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/transport/hq-socket.ts: "closeHqSocket" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/transport/hq-socket.ts: "resolveHqSocketUrl" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/transport/resume-frames.ts: "MAX_RESUME_FRAMES" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/transport/resume-frames.ts: "normalizeResumeSeq" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/wire.ts: "applySocketMessage" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/wire.ts: "armSnapshotRefresh" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/data/wire.ts: "hydrateFromHttp" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/domain/fleet-topology.ts: "FLEET_COLUMN_GAP" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/domain/fleet-topology.ts: "FLEET_LEAF_H" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/domain/mailbox-filters.ts: "EMPTY_LIVE_FILTER_STATE" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/domain/mailbox-live.ts: "buildLiveFeed" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/domain/transcript-store.ts: "entryKey" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/domain/use-session-transcript.ts: "coalesceStreamedText" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/webui-hq/src/app.tsx: "getHqViewDefinition" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/app.tsx: "HQ_VIEW_DEFINITIONS" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/auth.ts: "authHeaders" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/auth.ts: "normalizeHqTokenInput" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/auth.ts: "setHqToken" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/hq-ws-client.ts: "closeHqClient" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/inspector-slots.tsx: "RightInspector" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/inspector.ts: "clearInspectorSlots" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/transcript-store.ts: "entryKey" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/lib/use-session-transcript.ts: "coalesceStreamedText" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/stores/hq-local-prefs.ts: "getHqLocalPrefsSnapshot" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/stores/hq-local-prefs.ts: "reloadHqLocalPrefs" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/stores/hq-local-prefs.ts: "resetHqLocalPrefs" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/control.tsx: "controlClientLabel" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/fleet-nav.tsx: "buildNav" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/fleet-topology.ts: "FLEET_COLUMN_GAP" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/fleet-topology.ts: "FLEET_LEAF_H" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/live-console.tsx: "commandLifecycleTone" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/mailbox-filters.ts: "EMPTY_LIVE_FILTER_STATE" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/mailbox-live.ts: "buildLiveFeed" is no longer test-only; remove it from architecture/test-only-exports.json in the same change
- packages/webui-hq/src/views/settings.tsx: "scorePassword" is no longer test-only; remove it from architecture/test-only-exports.json in the same change

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 42 | 35 | @wrongstack/core |
| @wrongstack/bench | 22 | 45 | @wrongstack/core |
| @wrongstack/cli | 476 | 452 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 792 | 701 | @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 37 | 18 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 27 | @wrongstack/persistence |
| @wrongstack/kanban | 87 | 65 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 37 | 32 | @wrongstack/core |
| @wrongstack/persistence | 6 | 6 | — |
| @wrongstack/plug-lsp | 42 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 11 | 1 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 83 | 122 | @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 5 | 4 | — |
| @wrongstack/providers | 59 | 54 | @wrongstack/core |
| @wrongstack/requirement-intake | 16 | 9 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 13 | 16 | @wrongstack/core, @wrongstack/governance, @wrongstack/kanban, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory |
| @wrongstack/sage | 103 | 80 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 38 | 36 | @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 18 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 93 | 61 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 50 | 36 | @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 27 | 29 | @wrongstack/core |
| @wrongstack/tools | 191 | 202 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 335 | 328 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 14 | 15 | @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/webui | 501 | 406 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-hq | 110 | 31 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 16 | 7 | @wrongstack/core |
| @wrongstack/webui-server | 204 | 182 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/wrongtrace | 11 | 5 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/cli/src/subcommands/handlers/audit.ts ↔ packages/cli/src/subcommands/index.ts
- packages/core/src/coordination/agents/agent-prompts.ts ↔ packages/core/src/coordination/agents/index.ts ↔ packages/core/src/coordination/agents/phase1-discovery.ts ↔ packages/core/src/coordination/agents/phase2-planning.ts ↔ packages/core/src/coordination/agents/phase3-build.ts ↔ packages/core/src/coordination/agents/phase3-wave1-platform.ts ↔ packages/core/src/coordination/agents/phase3-wave2-meta.ts ↔ packages/core/src/coordination/agents/phase4-verify.ts ↔ packages/core/src/coordination/agents/phase5-review.ts ↔ packages/core/src/coordination/agents/phase6-domain.ts ↔ packages/core/src/coordination/agents/phase7-knowledge.ts ↔ packages/core/src/coordination/agents/phase8-delivery.ts ↔ packages/core/src/coordination/agents/phase8-wave3-products.ts ↔ packages/core/src/coordination/agents/phase9-meta.ts ↔ packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts ↔ packages/core/src/coordination/agents/project-agent-auto-optimize.ts ↔ packages/core/src/coordination/agents/project-agent-identity.ts ↔ packages/core/src/coordination/agents/project-agent-optimizer.ts ↔ packages/core/src/coordination/dispatcher.ts ↔ packages/core/src/coordination/fleet.ts ↔ packages/core/src/coordination/multi-agent-coordinator.ts ↔ packages/core/src/execution/parallel-eternal-engine.ts ↔ packages/core/src/types/autonomy.ts ↔ packages/core/src/types/index.ts
- packages/core/src/coordination/brain-telemetry.ts ↔ packages/core/src/coordination/brain.ts ↔ packages/core/src/kernel/events.ts ↔ packages/core/src/kernel/events/brain-events.ts ↔ packages/core/src/kernel/events/session-events.ts
- packages/core/src/core/agent-internals.ts ↔ packages/core/src/core/agent-loop-context.ts ↔ packages/core/src/core/agent-loop-detector.ts ↔ packages/core/src/core/agent-loop.ts ↔ packages/core/src/core/agent-response.ts ↔ packages/core/src/core/agent-tools.ts ↔ packages/core/src/core/agent-types.ts ↔ packages/core/src/core/agent.ts ↔ packages/core/src/extension/extension-points.ts ↔ packages/core/src/extension/registry.ts ↔ packages/core/src/mailbox-attach.ts ↔ packages/core/src/session-note-attach.ts ↔ packages/core/src/types/plugin.ts
- packages/core/src/hq/protocol/client.ts ↔ packages/core/src/hq/protocol/core.ts ↔ packages/core/src/hq/protocol/fleet.ts ↔ packages/core/src/hq/protocol/session.ts
- packages/core/src/index.ts ↔ packages/core/src/plugins/prompts-plugin.ts ↔ packages/core/src/plugins/skills-plugin.ts ↔ packages/core/src/plugins/sync-plugin.ts ↔ packages/core/src/tools/mcp-control.ts ↔ packages/core/src/tools/mcp-use.ts
- packages/core/src/types/blocks.ts ↔ packages/core/src/types/context.ts ↔ packages/core/src/types/conversation-state.ts ↔ packages/core/src/types/messages.ts ↔ packages/core/src/types/provider.ts ↔ packages/core/src/types/run-env.ts ↔ packages/core/src/types/session.ts ↔ packages/core/src/types/token-counter.ts ↔ packages/core/src/types/tool.ts
- packages/tui/src/components/status-bar-chips.tsx ↔ packages/tui/src/components/status-bar-rails.tsx ↔ packages/tui/src/components/status-bar.tsx ↔ packages/tui/src/components/status-line-registry.tsx

## Largest production files

| Lines | File |
|---:|---|
| 1715 | `packages/webui-server/src/server/session-handlers.ts` |
| 1424 | `packages/tui/src/theme-presets.ts` |
| 1343 | `packages/webui/src/lib/ws-client.ts` |
| 1309 | `packages/core/src/chronicle/query.ts` |
| 1279 | `packages/webui/src/stores/ui-store.ts` |
| 1172 | `packages/core/src/coordination/multi-agent-coordinator.ts` |
| 1169 | `packages/webui/src/types/server-message.ts` |
| 1128 | `packages/webui/src/components/ChatInput.tsx` |
| 1110 | `packages/webui/src/stores/viz-store.ts` |
| 1105 | `packages/webui-server/src/server/file-handlers.ts` |
| 1103 | `packages/core/src/coordination/autonomous-coordinator.ts` |
| 1095 | `packages/tui/src/components/settings-picker-model.ts` |
| 1092 | `packages/core/src/coordination/provider-status-tracker.ts` |
| 1088 | `packages/core/src/core/context.ts` |
| 1088 | `packages/core/src/storage/session-store.ts` |
| 1081 | `packages/webui/src/components/AgentOfficeView.tsx` |
| 1080 | `packages/tools/src/codebase-index/writer.ts` |
| 1078 | `packages/core/src/storage/file-session-writer.ts` |
| 1068 | `packages/tools/src/codebase-index/project-server.ts` |
| 1062 | `packages/webui/src/components/FileActivityDrawer.tsx` |
| 1056 | `packages/webui-server/src/server/kanban-routes.ts` |
| 1053 | `packages/webui-server/src/server/start-webui.ts` |
| 1051 | `packages/core/src/coordination/delegate-tool.ts` |
| 1051 | `packages/webui/src/components/SkillDetailView.tsx` |
| 1049 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 1048 | `packages/plugins/src/path-guard/shell-targets.ts` |
| 1047 | `packages/core/src/index.ts` |
| 1044 | `packages/webui/src/components/ContextDashboard.tsx` |
| 1041 | `packages/tui/src/components/sidebar-content.tsx` |
| 1039 | `packages/webui-server/src/server/context-editor.ts` |
| 1038 | `packages/webui-server/src/server/ws-payload-validation.ts` |
| 1036 | `packages/tui/src/components/kanban-panel.tsx` |
| 1033 | `packages/cli/src/plugin-management.ts` |
| 1033 | `packages/sage/src/sqlite-store.ts` |
| 1030 | `packages/plugins/src/git-autocommit/index.ts` |
| 1030 | `packages/tui/src/components/history/utils.tsx` |
| 1019 | `packages/webui-server/src/server/goal-ws-handler.ts` |
| 1014 | `packages/cli/src/slash-commands/sdd.ts` |
| 1014 | `packages/tui/src/components/context-panel.tsx` |
| 1013 | `packages/simpleui/src/simple-ui-session.tsx` |
| 1011 | `packages/tui/src/components/status-bar-rails.tsx` |
| 1005 | `packages/tui/src/kanban-slash.ts` |
| 1004 | `packages/tui/src/app.tsx` |
| 1004 | `packages/webui/src/hooks/ws-handlers/misc-handlers.ts` |
| 1002 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 1001 | `packages/webui/src/components/SettingsPanel/BrainSection.tsx` |
| 997 | `packages/mcp/src/client.ts` |
| 996 | `packages/sage/src/types.ts` |
| 996 | `packages/webui/src/stores/fleet-store.ts` |
| 994 | `packages/core/src/session-catalog/store.ts` |

## Exports only tests reference

- 853 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
