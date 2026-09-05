# Architecture Health Report

**Generated:** 2026-09-05T20:06:42.428Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 36 |
| Production source files | 3636 |
| Production source lines | 871931 |
| Test files | 3071 |
| Workspace dependency edges | 127 |
| Relative module edges | 11437 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 8 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

PASS — no blocking architecture-health errors.

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 42 | 35 | @wrongstack/core |
| @wrongstack/bench | 26 | 51 | @wrongstack/core |
| @wrongstack/cli | 475 | 455 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 838 | 708 | @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 37 | 18 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 28 | @wrongstack/persistence |
| @wrongstack/kanban | 87 | 67 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 37 | 34 | @wrongstack/core |
| @wrongstack/persistence | 6 | 6 | — |
| @wrongstack/plug-lsp | 42 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 11 | 1 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 83 | 122 | @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 5 | 4 | — |
| @wrongstack/providers | 59 | 54 | @wrongstack/core |
| @wrongstack/requirement-intake | 16 | 9 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 13 | 16 | @wrongstack/core, @wrongstack/governance, @wrongstack/kanban, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory |
| @wrongstack/sage | 104 | 82 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 38 | 36 | @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 18 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 93 | 63 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 50 | 36 | @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 27 | 31 | @wrongstack/core |
| @wrongstack/tools | 197 | 202 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 359 | 331 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 14 | 16 | @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/webui | 536 | 356 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-hq | 111 | 34 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 16 | 7 | @wrongstack/core |
| @wrongstack/webui-server | 220 | 187 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
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

## Largest production files

| Lines | File |
|---:|---|
| 1056 | `packages/webui-server/src/server/kanban-routes.ts` |
| 1051 | `packages/core/src/coordination/delegate-tool.ts` |
| 1051 | `packages/webui/src/components/SkillDetailView.tsx` |
| 1049 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 1048 | `packages/core/src/index.ts` |
| 1048 | `packages/plugins/src/path-guard/shell-targets.ts` |
| 1046 | `packages/mcp/src/client.ts` |
| 1044 | `packages/webui/src/components/ContextDashboard.tsx` |
| 1041 | `packages/tui/src/components/sidebar-content.tsx` |
| 1039 | `packages/webui-server/src/server/context-editor.ts` |
| 1038 | `packages/webui-server/src/server/ws-payload-validation.ts` |
| 1036 | `packages/tui/src/app.tsx` |
| 1036 | `packages/tui/src/components/kanban-panel.tsx` |
| 1033 | `packages/cli/src/plugin-management.ts` |
| 1033 | `packages/sage/src/sqlite-store.ts` |
| 1030 | `packages/plugins/src/git-autocommit/index.ts` |
| 1030 | `packages/tui/src/components/history/utils.tsx` |
| 1029 | `packages/cli/src/auth-menu/panel-service.ts` |
| 1025 | `packages/simpleui/src/simple-ui-session.tsx` |
| 1019 | `packages/webui-server/src/server/goal-ws-handler.ts` |
| 1019 | `packages/webui/src/hooks/ws-handlers/misc-handlers.ts` |
| 1015 | `packages/webui/src/components/SettingsPanel/BrainSection.tsx` |
| 1014 | `packages/cli/src/slash-commands/sdd.ts` |
| 1014 | `packages/tui/src/components/context-panel.tsx` |
| 1007 | `packages/core/src/execution/brain-runtime.ts` |
| 1005 | `packages/tui/src/kanban-slash.ts` |
| 1002 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 996 | `packages/sage/src/types.ts` |
| 996 | `packages/webui/src/stores/fleet-store.ts` |
| 994 | `packages/core/src/types/session.ts` |
| 992 | `packages/kanban/src/types.ts` |
| 991 | `packages/kanban/src/manager/assignment.ts` |
| 986 | `packages/tools/src/codebase-index/indexer.ts` |
| 984 | `packages/tui/src/components/agents-monitor.tsx` |
| 983 | `apps/desktop/src/main/runtime-manager.ts` |
| 983 | `packages/tui/src/input-validation.ts` |
| 981 | `packages/sage/src/tools/memory-tools.ts` |
| 980 | `packages/webui/src/components/KanbanTaskInspector.tsx` |
| 978 | `packages/core/src/execution/eternal-autonomy.ts` |
| 975 | `packages/cli/src/webui-server.ts` |
| 973 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 966 | `packages/core/src/coordination/director.ts` |
| 965 | `packages/webui/src/components/SidePanel/SessionList.tsx` |
| 963 | `packages/tui/src/app-state.ts` |
| 962 | `packages/tui/src/app-key-handler.ts` |
| 961 | `apps/desktop/src/renderer/src/renderer.ts` |
| 955 | `packages/plugins/src/prompt-firewall/index.ts` |
| 950 | `packages/webui-server/src/server/backend-services.ts` |
| 948 | `packages/plugins/src/semantic-search-indexer/index.ts` |
| 945 | `packages/core/src/hq/protocol/core.ts` |

## Exports only tests reference

- 837 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
