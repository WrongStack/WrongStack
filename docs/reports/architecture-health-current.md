# Architecture Health Report

**Generated:** 2026-08-18T12:21:55.991Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 32 |
| Production source files | 3263 |
| Production source lines | 777789 |
| Test files | 2822 |
| Workspace dependency edges | 103 |
| Relative module edges | 10115 |
| Non-command slash imports | 0 |
| Runtime module cycles | 0 |
| Type-inclusive module cycles | 17 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

PASS — no blocking architecture-health errors.

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 41 | 35 | @wrongstack/core |
| @wrongstack/bench | 22 | 45 | @wrongstack/core |
| @wrongstack/cli | 453 | 419 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/persistence, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/vector-memory, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-server |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 749 | 622 | @wrongstack/kanban, @wrongstack/persistence |
| @wrongstack/desktop | 37 | 17 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 26 | — |
| @wrongstack/kanban | 86 | 63 | @wrongstack/persistence |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 36 | 32 | @wrongstack/core |
| @wrongstack/persistence | 5 | 4 | — |
| @wrongstack/plug-lsp | 41 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 86 | 121 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/providers | 58 | 52 | @wrongstack/core |
| @wrongstack/requirement-intake | 16 | 9 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 12 | 15 | @wrongstack/core, @wrongstack/governance, @wrongstack/sage, @wrongstack/tools, @wrongstack/vector-memory |
| @wrongstack/sage | 103 | 77 | @wrongstack/core, @wrongstack/persistence |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 38 | 36 | @wrongstack/core, @wrongstack/kanban, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 15 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 93 | 61 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/techstack | 50 | 36 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/telegram | 21 | 29 | @wrongstack/core |
| @wrongstack/tools | 187 | 191 | @wrongstack/core, @wrongstack/kanban, @wrongstack/persistence |
| @wrongstack/tui | 331 | 317 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/vector-memory | 14 | 15 | @wrongstack/core, @wrongstack/sage |
| @wrongstack/webui | 459 | 332 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/webui-hq | 55 | 41 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/webui-server | 190 | 151 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools, @wrongstack/vector-memory |
| wrongstack | 1 | 0 | @wrongstack/cli |

## Module cycles

### Runtime

None.

### Type-inclusive

- packages/acp/src/registry/agents.catalog.ts ↔ packages/acp/src/registry/ensemble-registry.ts
- packages/cli/src/acp-server-agent.ts ↔ packages/cli/src/hq-server.ts ↔ packages/cli/src/hq-server/mailbox-gateway-manager.ts ↔ packages/cli/src/hq-server/routes.ts ↔ packages/cli/src/hq-server/routes/system-handlers.ts ↔ packages/cli/src/hq-server/server-lifecycle.ts ↔ packages/cli/src/hq-server/upgrade-handler.ts ↔ packages/cli/src/mcp-serve.ts ↔ packages/cli/src/subcommands/handlers/acp.ts ↔ packages/cli/src/subcommands/handlers/audit.ts ↔ packages/cli/src/subcommands/handlers/auth.ts ↔ packages/cli/src/subcommands/handlers/bench.ts ↔ packages/cli/src/subcommands/handlers/chronicle.ts ↔ packages/cli/src/subcommands/handlers/diag-doctor.ts ↔ packages/cli/src/subcommands/handlers/export.ts ↔ packages/cli/src/subcommands/handlers/hq.ts ↔ packages/cli/src/subcommands/handlers/init.ts ↔ packages/cli/src/subcommands/handlers/mailbox-serve.ts ↔ packages/cli/src/subcommands/handlers/mcp.ts ↔ packages/cli/src/subcommands/handlers/modeldiag-bench.ts ↔ packages/cli/src/subcommands/handlers/modeldiag-eval.ts ↔ packages/cli/src/subcommands/handlers/modeldiag-test.ts ↔ packages/cli/src/subcommands/handlers/modeldiag.ts ↔ packages/cli/src/subcommands/handlers/plugin-usage.ts ↔ packages/cli/src/subcommands/handlers/projects.ts ↔ packages/cli/src/subcommands/handlers/providers-models.ts ↔ packages/cli/src/subcommands/handlers/quick.ts ↔ packages/cli/src/subcommands/handlers/replay.ts ↔ packages/cli/src/subcommands/handlers/rewind.ts ↔ packages/cli/src/subcommands/handlers/sessions-config.ts ↔ packages/cli/src/subcommands/handlers/sessions-fleet.ts ↔ packages/cli/src/subcommands/handlers/tools-skills.ts ↔ packages/cli/src/subcommands/handlers/update.ts ↔ packages/cli/src/subcommands/handlers/version-help.ts ↔ packages/cli/src/subcommands/index.ts
- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/core/src/coordination/agents/agent-prompts.ts ↔ packages/core/src/coordination/agents/index.ts ↔ packages/core/src/coordination/agents/phase1-discovery.ts ↔ packages/core/src/coordination/agents/phase2-planning.ts ↔ packages/core/src/coordination/agents/phase3-build.ts ↔ packages/core/src/coordination/agents/phase3-wave1-platform.ts ↔ packages/core/src/coordination/agents/phase3-wave2-meta.ts ↔ packages/core/src/coordination/agents/phase4-verify.ts ↔ packages/core/src/coordination/agents/phase5-review.ts ↔ packages/core/src/coordination/agents/phase6-domain.ts ↔ packages/core/src/coordination/agents/phase7-knowledge.ts ↔ packages/core/src/coordination/agents/phase8-delivery.ts ↔ packages/core/src/coordination/agents/phase8-wave3-products.ts ↔ packages/core/src/coordination/agents/phase9-meta.ts ↔ packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts ↔ packages/core/src/coordination/agents/project-agent-auto-optimize.ts ↔ packages/core/src/coordination/agents/project-agent-identity.ts ↔ packages/core/src/coordination/agents/project-agent-optimizer.ts ↔ packages/core/src/coordination/dispatcher.ts ↔ packages/core/src/coordination/fleet.ts ↔ packages/core/src/coordination/multi-agent-coordinator.ts ↔ packages/core/src/execution/parallel-eternal-engine.ts ↔ packages/core/src/types/autonomy.ts ↔ packages/core/src/types/index.ts
- packages/core/src/coordination/brain-telemetry.ts ↔ packages/core/src/coordination/brain.ts ↔ packages/core/src/kernel/events.ts ↔ packages/core/src/kernel/events/brain-events.ts ↔ packages/core/src/kernel/events/session-events.ts
- packages/core/src/core/agent-internals.ts ↔ packages/core/src/core/agent-loop-context.ts ↔ packages/core/src/core/agent-loop-detector.ts ↔ packages/core/src/core/agent-loop.ts ↔ packages/core/src/core/agent-response.ts ↔ packages/core/src/core/agent-tools.ts ↔ packages/core/src/core/agent-types.ts ↔ packages/core/src/core/agent.ts ↔ packages/core/src/extension/extension-points.ts ↔ packages/core/src/extension/registry.ts ↔ packages/core/src/mailbox-attach.ts ↔ packages/core/src/types/plugin.ts
- packages/core/src/core/context.ts ↔ packages/core/src/core/conversation-state.ts ↔ packages/core/src/core/run-env.ts ↔ packages/core/src/types/blocks.ts ↔ packages/core/src/types/compactor.ts ↔ packages/core/src/types/messages.ts ↔ packages/core/src/types/provider.ts ↔ packages/core/src/types/session.ts ↔ packages/core/src/types/token-counter.ts ↔ packages/core/src/types/tool.ts ↔ packages/core/src/utils/context-evidence.ts ↔ packages/core/src/utils/token-estimate.ts ↔ packages/core/src/utils/tool-wire-compact.ts
- packages/core/src/hq/protocol/client.ts ↔ packages/core/src/hq/protocol/core.ts ↔ packages/core/src/hq/protocol/fleet.ts ↔ packages/core/src/hq/protocol/session.ts
- packages/core/src/index.ts ↔ packages/core/src/plugins/prompts-plugin.ts ↔ packages/core/src/plugins/skills-plugin.ts ↔ packages/core/src/plugins/sync-plugin.ts ↔ packages/core/src/tools/mcp-control.ts ↔ packages/core/src/tools/mcp-use.ts
- packages/kanban/src/types-operations.ts ↔ packages/kanban/src/types.ts
- packages/mcp/src/client.ts ↔ packages/mcp/src/tool-schema.ts ↔ packages/mcp/src/transport-base.ts ↔ packages/mcp/src/transport-sse.ts ↔ packages/mcp/src/transport-streamable.ts ↔ packages/mcp/src/transport.ts
- packages/plug-lsp/src/document-tracker.ts ↔ packages/plug-lsp/src/registry.ts
- packages/sdd/src/graph-split.ts ↔ packages/sdd/src/sdd-parallel-run.ts
- packages/techstack/src/adapters/interface.ts ↔ packages/techstack/src/adapters/paths.ts
- packages/tools/src/codebase-index/index-service.ts ↔ packages/tools/src/codebase-index/worker-protocol.ts
- packages/tui/src/components/status-bar-chips.tsx ↔ packages/tui/src/components/status-bar-rails.tsx ↔ packages/tui/src/components/status-bar.tsx
- packages/webui/src/components/SettingsPanel/MCPSection.tsx ↔ packages/webui/src/components/SettingsPanel/official-servers.ts

## Largest production files

| Lines | File |
|---:|---|
| 1108 | `packages/tui/src/components/sidebar-content.tsx` |
| 1063 | `packages/webui/src/components/FileActivityDrawer.tsx` |
| 1050 | `packages/sage/src/sqlite-store.ts` |
| 1038 | `packages/webui/src/lib/ws-client.ts` |
| 1036 | `packages/plugins/src/path-guard/shell-targets.ts` |
| 1021 | `packages/mcp/src/client.ts` |
| 1020 | `packages/core/src/index.ts` |
| 1020 | `packages/webui-server/src/server/context-editor.ts` |
| 1019 | `packages/tui/src/theme-presets.ts` |
| 1015 | `packages/cli/src/slash-commands/sdd.ts` |
| 1013 | `packages/core/src/core/context.ts` |
| 1013 | `packages/webui-server/src/server/goal-ws-handler.ts` |
| 1007 | `packages/simpleui/src/simple-ui-session.tsx` |
| 1006 | `packages/core/src/coordination/delegate-tool.ts` |
| 1002 | `packages/tui/src/components/kanban-panel.tsx` |
| 1002 | `packages/webui/src/components/ChronicleDashboard.tsx` |
| 1000 | `packages/tui/src/components/settings-picker-model.ts` |
| 999 | `packages/tui/src/components/agents-monitor.tsx` |
| 998 | `packages/tui/src/app.tsx` |
| 998 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 996 | `packages/tui/src/input-validation.ts` |
| 993 | `packages/sage/src/types.ts` |
| 987 | `packages/core/src/execution/brain-runtime.ts` |
| 986 | `packages/webui/src/components/SettingsPanel/BrainSection.tsx` |
| 983 | `apps/desktop/src/main/runtime-manager.ts` |
| 982 | `packages/core/src/coordination/autonomous-coordinator.ts` |
| 982 | `packages/webui-server/src/server/kanban-routes.ts` |
| 980 | `packages/tui/src/kanban-slash.ts` |
| 980 | `packages/webui/src/components/KanbanTaskInspector.tsx` |
| 978 | `packages/kanban/src/manager/assignment.ts` |
| 975 | `packages/tools/src/codebase-index/indexer.ts` |
| 974 | `packages/webui/src/stores/viz-store.ts` |
| 972 | `packages/core/src/coordination/multi-agent-coordinator.ts` |
| 971 | `packages/sage/src/tools/memory-tools.ts` |
| 970 | `packages/webui-server/src/server/collaboration-ws-handler.ts` |
| 965 | `packages/webui/src/components/AgentOfficeView.tsx` |
| 965 | `packages/webui/src/components/ChatInput.tsx` |
| 964 | `packages/core/src/coordination/provider-status-tracker.ts` |
| 960 | `packages/kanban/src/types.ts` |
| 957 | `packages/core/src/execution/eternal-autonomy.ts` |
| 953 | `packages/tui/src/app-key-handler.ts` |
| 950 | `packages/tui/src/components/history/utils.tsx` |
| 949 | `packages/core/src/hq/protocol/core.ts` |
| 949 | `packages/webui-server/src/server/ws-payload-validation.ts` |
| 944 | `apps/desktop/src/renderer/src/renderer.ts` |
| 941 | `packages/cli/src/cli-main.ts` |
| 938 | `packages/core/src/execution/auto-compaction-middleware.ts` |
| 938 | `packages/webui/src/types/server-message.ts` |
| 936 | `packages/tui/src/components/context-panel.tsx` |
| 936 | `packages/webui/src/components/CodeMap.tsx` |

## Exports only tests reference

- 803 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
