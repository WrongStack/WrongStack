# Architecture Health Report

**Generated:** 2026-09-11T19:08:51.528Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 36 |
| Production source files | 3741 |
| Production source lines | 903861 |
| Test files | 3252 |
| Workspace dependency edges | 128 |
| Relative module edges | 11906 |
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
| @wrongstack/acp | 42 | 37 | @wrongstack/core, @wrongstack/primitives |
| @wrongstack/bench | 26 | 52 | @wrongstack/core |
| @wrongstack/cli | 490 | 477 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-protocol, @wrongstack/webui-server, @wrongstack/wrongtrace |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 848 | 740 | @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/desktop | 40 | 26 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 28 | @wrongstack/persistence |
| @wrongstack/kanban | 87 | 67 | @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 37 | 37 | @wrongstack/core |
| @wrongstack/persistence | 6 | 9 | — |
| @wrongstack/plug-lsp | 50 | 36 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugin-sdk | 11 | 3 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 83 | 123 | @wrongstack/core, @wrongstack/plugin-sdk, @wrongstack/primitives, @wrongstack/tools |
| @wrongstack/primitives | 6 | 5 | — |
| @wrongstack/providers | 66 | 61 | @wrongstack/core |
| @wrongstack/requirement-intake | 16 | 10 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 13 | 17 | @wrongstack/core, @wrongstack/governance, @wrongstack/kanban, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory |
| @wrongstack/sage | 104 | 87 | @wrongstack/core, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 38 | 37 | @wrongstack/core, @wrongstack/kanban, @wrongstack/primitives, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 18 | 27 | @wrongstack/core |
| @wrongstack/simpleui | 95 | 67 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/techstack | 50 | 37 | @wrongstack/core, @wrongstack/persistence, @wrongstack/tools |
| @wrongstack/telegram | 27 | 32 | @wrongstack/core |
| @wrongstack/tools | 213 | 216 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence, @wrongstack/primitives |
| @wrongstack/tui | 387 | 348 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 14 | 18 | @wrongstack/core, @wrongstack/persistence, @wrongstack/sage |
| @wrongstack/webui | 542 | 372 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-protocol |
| @wrongstack/webui-hq | 116 | 38 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-protocol, @wrongstack/webui-server |
| @wrongstack/webui-protocol | 16 | 7 | @wrongstack/core |
| @wrongstack/webui-server | 224 | 209 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/primitives, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory, @wrongstack/webui-protocol, @wrongstack/wrongtrace |
| @wrongstack/wrongtrace | 11 | 6 | — |
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
| 1581 | `packages/providers/src/openai-codex.ts` |
| 1119 | `apps/desktop/src/main/runtime-manager.ts` |
| 1067 | `packages/core/src/coordination/delegate-tool.ts` |
| 1058 | `packages/simpleui/src/simple-ui-session.tsx` |
| 1057 | `packages/webui-server/src/server/ws-payload-validation.ts` |
| 1055 | `packages/cli/src/slash-commands/settings-mutations.ts` |
| 1055 | `packages/mcp/src/client.ts` |
| 1051 | `packages/core/src/index.ts` |
| 1051 | `packages/webui/src/components/SkillDetailView.tsx` |
| 1049 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 1048 | `packages/plugins/src/path-guard/shell-targets.ts` |
| 1044 | `packages/webui/src/components/ContextDashboard.tsx` |
| 1041 | `packages/tui/src/components/sidebar-content.tsx` |
| 1040 | `packages/cli/src/auth-menu/panel-service.ts` |
| 1039 | `packages/webui-server/src/server/context-editor.ts` |
| 1036 | `packages/tui/src/components/kanban-panel.tsx` |
| 1035 | `packages/tui/src/components/history/utils.tsx` |
| 1033 | `packages/cli/src/plugin-management.ts` |
| 1033 | `packages/sage/src/sqlite-store.ts` |
| 1032 | `packages/webui-server/src/server/routes.ts` |
| 1030 | `packages/plugins/src/git-autocommit/index.ts` |
| 1026 | `packages/sage/src/tools/memory-tools.ts` |
| 1021 | `packages/webui/src/hooks/ws-handlers/misc-handlers.ts` |
| 1015 | `packages/webui-server/src/server/git-handlers.ts` |
| 1015 | `packages/webui-server/src/server/goal-ws-handler.ts` |
| 1015 | `packages/webui/src/components/SettingsPanel/BrainSection.tsx` |
| 1014 | `packages/cli/src/slash-commands/sdd.ts` |
| 1014 | `packages/tui/src/components/context-panel.tsx` |
| 1013 | `packages/tools/src/codebase-index/indexer.ts` |
| 1013 | `packages/tui/src/input-validation.ts` |
| 1008 | `packages/cli/src/webui-server.ts` |
| 1007 | `packages/core/src/execution/brain-runtime.ts` |
| 1007 | `packages/sage/src/types.ts` |
| 1005 | `packages/tui/src/kanban-slash.ts` |
| 1003 | `packages/kanban/src/types.ts` |
| 1002 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 999 | `packages/kanban/src/manager/assignment.ts` |
| 996 | `packages/webui/src/stores/fleet-store.ts` |
| 994 | `packages/core/src/types/session.ts` |
| 992 | `packages/tui/src/app-state.ts` |
| 991 | `packages/tools/src/codebase-index/writer.ts` |
| 984 | `packages/tui/src/components/agents-monitor.tsx` |
| 982 | `packages/core/src/coordination/sqlite-mailbox.ts` |
| 980 | `packages/webui/src/components/KanbanTaskInspector.tsx` |
| 978 | `packages/core/src/execution/eternal-autonomy.ts` |
| 973 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 973 | `packages/core/src/hq/auth-store.ts` |
| 971 | `packages/core/src/coordination/fleet-supervisor.ts` |
| 970 | `packages/core/src/coordination/director.ts` |
| 968 | `packages/tools/src/codebase-index/background-indexer.ts` |

## Exports only tests reference

- 910 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
