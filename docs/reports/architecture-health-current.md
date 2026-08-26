# Architecture Health Report

**Generated:** 2026-08-26T18:46:32.778Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 36 |
| Production source files | 3376 |
| Production source lines | 807669 |
| Test files | 2948 |
| Workspace dependency edges | 125 |
| Relative module edges | 10442 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 9 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- packages/core/src/coordination/delegate-tool.ts: hotspot grew from 1017 to 1040 lines; review and update the ratchet in the same change
- packages/webui/src/lib/ws-client.ts: hotspot grew from 1109 to 1229 lines; review and update the ratchet in the same change
- packages/webui/src/lib/ws-client.ts: relative import fan-out decreased from 11 to 10; review and update the ratchet in the same change
- packages/webui-server/src/server/backend-services.ts: hotspot grew from 891 to 920 lines; review and update the ratchet in the same change
- packages/core/src/coordination/agents/index.ts: "ROLE_DISPATCH_RATIONALE" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json
- packages/cli/src/wiring/tools.ts: "setupTools" is no longer test-only; remove it from architecture/test-only-exports.json in the same change

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 42 | 35 | @wrongstack/core |
| @wrongstack/bench | 22 | 45 | @wrongstack/core |
| @wrongstack/cli | 471 | 437 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 764 | 660 | @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 37 | 18 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 26 | @wrongstack/persistence |
| @wrongstack/kanban | 86 | 63 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 37 | 32 | @wrongstack/core |
| @wrongstack/persistence | 6 | 6 | — |
| @wrongstack/plug-lsp | 42 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 11 | 1 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 83 | 122 | @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 3 | 0 | — |
| @wrongstack/providers | 58 | 53 | @wrongstack/core |
| @wrongstack/requirement-intake | 16 | 9 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 13 | 16 | @wrongstack/core, @wrongstack/governance, @wrongstack/kanban, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory |
| @wrongstack/sage | 103 | 78 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 38 | 36 | @wrongstack/core, @wrongstack/kanban, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 18 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 93 | 61 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 50 | 36 | @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 27 | 29 | @wrongstack/core |
| @wrongstack/tools | 191 | 199 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 333 | 323 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 14 | 15 | @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/webui | 475 | 355 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-hq | 55 | 41 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 16 | 4 | @wrongstack/core |
| @wrongstack/webui-server | 197 | 168 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/wrongtrace | 10 | 3 | — |
| wrongstack | 1 | 1 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/cli/src/subcommands/handlers/audit.ts ↔ packages/cli/src/subcommands/index.ts
- packages/core/src/coordination/agents/agent-prompts.ts ↔ packages/core/src/coordination/agents/index.ts ↔ packages/core/src/coordination/agents/phase1-discovery.ts ↔ packages/core/src/coordination/agents/phase2-planning.ts ↔ packages/core/src/coordination/agents/phase3-build.ts ↔ packages/core/src/coordination/agents/phase3-wave1-platform.ts ↔ packages/core/src/coordination/agents/phase3-wave2-meta.ts ↔ packages/core/src/coordination/agents/phase4-verify.ts ↔ packages/core/src/coordination/agents/phase5-review.ts ↔ packages/core/src/coordination/agents/phase6-domain.ts ↔ packages/core/src/coordination/agents/phase7-knowledge.ts ↔ packages/core/src/coordination/agents/phase8-delivery.ts ↔ packages/core/src/coordination/agents/phase8-wave3-products.ts ↔ packages/core/src/coordination/agents/phase9-meta.ts ↔ packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts ↔ packages/core/src/coordination/agents/project-agent-auto-optimize.ts ↔ packages/core/src/coordination/agents/project-agent-identity.ts ↔ packages/core/src/coordination/agents/project-agent-optimizer.ts ↔ packages/core/src/coordination/dispatcher.ts ↔ packages/core/src/coordination/fleet.ts ↔ packages/core/src/coordination/multi-agent-coordinator.ts ↔ packages/core/src/execution/parallel-eternal-engine.ts ↔ packages/core/src/types/autonomy.ts ↔ packages/core/src/types/index.ts
- packages/core/src/coordination/brain-telemetry.ts ↔ packages/core/src/coordination/brain.ts ↔ packages/core/src/kernel/events.ts ↔ packages/core/src/kernel/events/brain-events.ts ↔ packages/core/src/kernel/events/session-events.ts
- packages/core/src/core/agent-internals.ts ↔ packages/core/src/core/agent-loop-context.ts ↔ packages/core/src/core/agent-loop-detector.ts ↔ packages/core/src/core/agent-loop.ts ↔ packages/core/src/core/agent-response.ts ↔ packages/core/src/core/agent-tools.ts ↔ packages/core/src/core/agent-types.ts ↔ packages/core/src/core/agent.ts ↔ packages/core/src/extension/extension-points.ts ↔ packages/core/src/extension/registry.ts ↔ packages/core/src/mailbox-attach.ts ↔ packages/core/src/types/plugin.ts
- packages/core/src/hq/protocol/client.ts ↔ packages/core/src/hq/protocol/core.ts ↔ packages/core/src/hq/protocol/fleet.ts ↔ packages/core/src/hq/protocol/session.ts
- packages/core/src/index.ts ↔ packages/core/src/plugins/prompts-plugin.ts ↔ packages/core/src/plugins/skills-plugin.ts ↔ packages/core/src/plugins/sync-plugin.ts ↔ packages/core/src/tools/mcp-control.ts ↔ packages/core/src/tools/mcp-use.ts
- packages/core/src/types/blocks.ts ↔ packages/core/src/types/context.ts ↔ packages/core/src/types/conversation-state.ts ↔ packages/core/src/types/messages.ts ↔ packages/core/src/types/provider.ts ↔ packages/core/src/types/run-env.ts ↔ packages/core/src/types/session.ts ↔ packages/core/src/types/token-counter.ts ↔ packages/core/src/types/tool.ts
- packages/tui/src/components/status-bar-chips.tsx ↔ packages/tui/src/components/status-bar-rails.tsx ↔ packages/tui/src/components/status-bar.tsx

## Largest production files

| Lines | File |
|---:|---|
| 1424 | `packages/tui/src/theme-presets.ts` |
| 1229 | `packages/webui/src/lib/ws-client.ts` |
| 1089 | `packages/tui/src/components/settings-picker-model.ts` |
| 1089 | `packages/webui/src/components/AgentOfficeView.tsx` |
| 1068 | `packages/core/src/storage/session-store.ts` |
| 1063 | `packages/sage/src/sqlite-store.ts` |
| 1063 | `packages/webui/src/components/FileActivityDrawer.tsx` |
| 1057 | `packages/core/src/coordination/multi-agent-coordinator.ts` |
| 1048 | `packages/plugins/src/path-guard/shell-targets.ts` |
| 1040 | `packages/core/src/coordination/delegate-tool.ts` |
| 1036 | `packages/webui-server/src/server/session-handlers.ts` |
| 1034 | `packages/cli/src/plugin-management.ts` |
| 1033 | `packages/tui/src/components/sidebar-content.tsx` |
| 1030 | `packages/core/src/index.ts` |
| 1023 | `packages/core/src/storage/file-session-writer.ts` |
| 1023 | `packages/tui/src/components/context-panel.tsx` |
| 1020 | `packages/webui-server/src/server/context-editor.ts` |
| 1019 | `packages/webui-server/src/server/goal-ws-handler.ts` |
| 1016 | `packages/core/src/core/context.ts` |
| 1015 | `packages/cli/src/slash-commands/sdd.ts` |
| 1013 | `packages/tools/src/codebase-index/project-server.ts` |
| 1012 | `packages/webui/src/components/ChatInput.tsx` |
| 1011 | `packages/webui-server/src/server/ws-payload-validation.ts` |
| 1010 | `packages/plugins/src/git-autocommit/index.ts` |
| 1010 | `packages/webui-server/src/server/kanban-routes.ts` |
| 1007 | `packages/simpleui/src/simple-ui-session.tsx` |
| 1002 | `packages/tui/src/components/kanban-panel.tsx` |
| 1002 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 999 | `packages/tui/src/components/agents-monitor.tsx` |
| 998 | `packages/tui/src/app.tsx` |
| 998 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 997 | `packages/mcp/src/client.ts` |
| 996 | `packages/tui/src/input-validation.ts` |
| 993 | `packages/sage/src/types.ts` |
| 987 | `packages/core/src/execution/brain-runtime.ts` |
| 986 | `packages/tools/src/codebase-index/indexer.ts` |
| 986 | `packages/webui/src/components/SettingsPanel/BrainSection.tsx` |
| 984 | `packages/core/src/coordination/provider-status-tracker.ts` |
| 983 | `apps/desktop/src/main/runtime-manager.ts` |
| 982 | `packages/core/src/coordination/autonomous-coordinator.ts` |
| 980 | `packages/tui/src/kanban-slash.ts` |
| 980 | `packages/webui/src/components/KanbanTaskInspector.tsx` |
| 979 | `packages/kanban/src/manager/assignment.ts` |
| 974 | `packages/webui/src/stores/viz-store.ts` |
| 974 | `packages/webui/src/types/server-message.ts` |
| 971 | `packages/sage/src/tools/memory-tools.ts` |
| 969 | `packages/webui-server/src/server/start-webui.ts` |
| 968 | `packages/kanban/src/types.ts` |
| 963 | `packages/tools/src/codebase-index/writer.ts` |
| 962 | `packages/tui/src/app-key-handler.ts` |

## Exports only tests reference

- 829 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
