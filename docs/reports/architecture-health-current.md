# Architecture Health Report

**Generated:** 2026-08-09T16:38:36.673Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 31 |
| Production source files | 2939 |
| Production source lines | 724049 |
| Test files | 2613 |
| Workspace dependency edges | 95 |
| Relative module edges | 8976 |
| Non-command slash imports | 0 |
| Runtime module cycles | 2 |
| Type-inclusive module cycles | 18 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- 1 unexcepted module cycle(s)

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 38 | 35 | @wrongstack/core |
| @wrongstack/bench | 22 | 45 | @wrongstack/core |
| @wrongstack/cli | 403 | 382 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-server |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 698 | 591 | @wrongstack/kanban, @wrongstack/persistence |
| @wrongstack/desktop | 37 | 16 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 26 | — |
| @wrongstack/kanban | 73 | 55 | @wrongstack/persistence |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 34 | 31 | @wrongstack/core |
| @wrongstack/persistence | 3 | 3 | — |
| @wrongstack/plug-lsp | 41 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 79 | 117 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/providers | 58 | 52 | @wrongstack/core |
| @wrongstack/requirement-intake | 14 | 8 | @wrongstack/core |
| @wrongstack/requirement-intake-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/requirement-intake |
| @wrongstack/runtime | 12 | 15 | @wrongstack/core, @wrongstack/governance, @wrongstack/sage, @wrongstack/tools |
| @wrongstack/sage | 84 | 62 | @wrongstack/core |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 34 | 31 | @wrongstack/core, @wrongstack/kanban, @wrongstack/requirement-intake |
| @wrongstack/security-scanner | 15 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 76 | 52 | @wrongstack/kanban, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/techstack | 46 | 32 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/telegram | 20 | 28 | @wrongstack/core |
| @wrongstack/tools | 155 | 164 | @wrongstack/core, @wrongstack/kanban |
| @wrongstack/tui | 290 | 300 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/webui | 420 | 320 | @wrongstack/core, @wrongstack/kanban, @wrongstack/plugins, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/webui-hq | 55 | 39 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/webui-server | 167 | 133 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/providers, @wrongstack/requirement-intake, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools |
| wrongstack | 1 | 0 | @wrongstack/cli |

## Module cycles

### Runtime

- packages/core/src/core/context.ts ↔ packages/core/src/core/conversation-state.ts
- packages/kanban/src/manager/_internal.ts ↔ packages/kanban/src/manager/lifecycle.ts ↔ packages/kanban/src/server/remote-storage.ts ↔ packages/kanban/src/storage.ts

### Type-inclusive

- packages/acp/src/registry/agents.catalog.ts ↔ packages/acp/src/registry/ensemble-registry.ts
- packages/cli/src/acp-server-agent.ts ↔ packages/cli/src/hq-server.ts ↔ packages/cli/src/hq-server/routes.ts ↔ packages/cli/src/hq-server/routes/system-handlers.ts ↔ packages/cli/src/mcp-serve.ts ↔ packages/cli/src/subcommands/handlers/acp.ts ↔ packages/cli/src/subcommands/handlers/audit.ts ↔ packages/cli/src/subcommands/handlers/auth.ts ↔ packages/cli/src/subcommands/handlers/bench.ts ↔ packages/cli/src/subcommands/handlers/chronicle.ts ↔ packages/cli/src/subcommands/handlers/diag-doctor.ts ↔ packages/cli/src/subcommands/handlers/export.ts ↔ packages/cli/src/subcommands/handlers/hq.ts ↔ packages/cli/src/subcommands/handlers/init.ts ↔ packages/cli/src/subcommands/handlers/mailbox-serve.ts ↔ packages/cli/src/subcommands/handlers/mcp.ts ↔ packages/cli/src/subcommands/handlers/modeldiag.ts ↔ packages/cli/src/subcommands/handlers/plugin-usage.ts ↔ packages/cli/src/subcommands/handlers/projects.ts ↔ packages/cli/src/subcommands/handlers/providers-models.ts ↔ packages/cli/src/subcommands/handlers/quick.ts ↔ packages/cli/src/subcommands/handlers/replay.ts ↔ packages/cli/src/subcommands/handlers/rewind.ts ↔ packages/cli/src/subcommands/handlers/sessions-config.ts ↔ packages/cli/src/subcommands/handlers/sessions-fleet.ts ↔ packages/cli/src/subcommands/handlers/tools-skills.ts ↔ packages/cli/src/subcommands/handlers/update.ts ↔ packages/cli/src/subcommands/handlers/version-help.ts ↔ packages/cli/src/subcommands/index.ts
- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
- packages/core/src/coordination/agents/agent-prompts.ts ↔ packages/core/src/coordination/agents/index.ts ↔ packages/core/src/coordination/agents/phase1-discovery.ts ↔ packages/core/src/coordination/agents/phase2-planning.ts ↔ packages/core/src/coordination/agents/phase3-build.ts ↔ packages/core/src/coordination/agents/phase3-wave1-platform.ts ↔ packages/core/src/coordination/agents/phase3-wave2-meta.ts ↔ packages/core/src/coordination/agents/phase4-verify.ts ↔ packages/core/src/coordination/agents/phase5-review.ts ↔ packages/core/src/coordination/agents/phase6-domain.ts ↔ packages/core/src/coordination/agents/phase7-knowledge.ts ↔ packages/core/src/coordination/agents/phase8-delivery.ts ↔ packages/core/src/coordination/agents/phase8-wave3-products.ts ↔ packages/core/src/coordination/agents/phase9-meta.ts ↔ packages/core/src/coordination/agents/phase9-wave4-platform-meta.ts ↔ packages/core/src/coordination/agents/project-agent-identity.ts ↔ packages/core/src/coordination/agents/project-agent-optimizer.ts ↔ packages/core/src/coordination/dispatcher.ts ↔ packages/core/src/coordination/fleet.ts ↔ packages/core/src/coordination/multi-agent-coordinator.ts ↔ packages/core/src/execution/parallel-eternal-engine.ts ↔ packages/core/src/types/autonomy.ts ↔ packages/core/src/types/index.ts
- packages/core/src/coordination/brain-telemetry.ts ↔ packages/core/src/coordination/brain.ts ↔ packages/core/src/kernel/events.ts ↔ packages/core/src/kernel/events/brain-events.ts ↔ packages/core/src/kernel/events/session-events.ts
- packages/core/src/core/agent-internals.ts ↔ packages/core/src/core/agent-loop.ts ↔ packages/core/src/core/agent-response.ts ↔ packages/core/src/core/agent-tools.ts ↔ packages/core/src/core/agent-types.ts ↔ packages/core/src/core/agent.ts ↔ packages/core/src/extension/extension-points.ts ↔ packages/core/src/extension/registry.ts ↔ packages/core/src/mailbox-attach.ts ↔ packages/core/src/types/plugin.ts
- packages/core/src/core/context.ts ↔ packages/core/src/core/conversation-state.ts ↔ packages/core/src/core/run-env.ts ↔ packages/core/src/types/blocks.ts ↔ packages/core/src/types/compactor.ts ↔ packages/core/src/types/messages.ts ↔ packages/core/src/types/provider.ts ↔ packages/core/src/types/session.ts ↔ packages/core/src/types/token-counter.ts ↔ packages/core/src/types/tool.ts ↔ packages/core/src/utils/context-evidence.ts ↔ packages/core/src/utils/token-estimate.ts ↔ packages/core/src/utils/tool-wire-compact.ts
- packages/core/src/hq/protocol/client.ts ↔ packages/core/src/hq/protocol/core.ts ↔ packages/core/src/hq/protocol/fleet.ts ↔ packages/core/src/hq/protocol/session.ts
- packages/core/src/index.ts ↔ packages/core/src/plugins/prompts-plugin.ts ↔ packages/core/src/plugins/skills-plugin.ts ↔ packages/core/src/plugins/sync-plugin.ts ↔ packages/core/src/tools/mcp-control.ts ↔ packages/core/src/tools/mcp-use.ts
- packages/kanban/src/manager/_internal.ts ↔ packages/kanban/src/manager/lifecycle.ts ↔ packages/kanban/src/server/remote-storage.ts ↔ packages/kanban/src/storage.ts
- packages/kanban/src/types-operations.ts ↔ packages/kanban/src/types.ts
- packages/mcp/src/client.ts ↔ packages/mcp/src/tool-schema.ts ↔ packages/mcp/src/transport-base.ts ↔ packages/mcp/src/transport-sse.ts ↔ packages/mcp/src/transport-streamable.ts ↔ packages/mcp/src/transport.ts
- packages/plug-lsp/src/document-tracker.ts ↔ packages/plug-lsp/src/registry.ts
- packages/sdd/src/graph-split.ts ↔ packages/sdd/src/sdd-parallel-run.ts
- packages/techstack/src/adapters/interface.ts ↔ packages/techstack/src/adapters/paths.ts
- packages/tools/src/codebase-index/index-service.ts ↔ packages/tools/src/codebase-index/worker-protocol.ts
- packages/tui/src/components/status-bar-chips.tsx ↔ packages/tui/src/components/status-bar.tsx
- packages/webui/src/components/SettingsPanel/MCPSection.tsx ↔ packages/webui/src/components/SettingsPanel/official-servers.ts

## Largest production files

| Lines | File |
|---:|---|
| 1996 | `packages/plugins/src/path-guard/index.ts` |
| 1593 | `packages/sage/src/middleware/tool-call-memory.ts` |
| 1484 | `packages/tools/src/codebase-index/writer.ts` |
| 1427 | `packages/core/src/execution/compaction-core.ts` |
| 1396 | `packages/cli/src/slash-commands/kanban.ts` |
| 1377 | `packages/tui/src/components/sidebar-panels.tsx` |
| 1275 | `packages/core/src/coordination/mailbox-types.ts` |
| 1255 | `packages/cli/src/hq-server/routes/auth-handlers.ts` |
| 1237 | `packages/core/src/storage/session-store.ts` |
| 1229 | `packages/webui/src/components/ChatInput.tsx` |
| 1227 | `packages/tui/src/app.tsx` |
| 1226 | `packages/webui-server/src/server/connections-health-route.ts` |
| 1207 | `packages/tui/src/memory-slash.ts` |
| 1202 | `packages/webui/src/lib/ws-client.ts` |
| 1193 | `packages/cli/src/cli-main.ts` |
| 1190 | `packages/tui/src/components/status-bar.tsx` |
| 1167 | `packages/cli/src/hq-server/routes.ts` |
| 1167 | `packages/core/src/core/agent-loop.ts` |
| 1167 | `packages/webui-server/src/server/http-server.ts` |
| 1160 | `packages/core/src/chronicle/sqlite-journal.ts` |
| 1150 | `packages/core/src/storage/file-session-writer.ts` |
| 1143 | `packages/cli/src/slash-commands/memory.ts` |
| 1140 | `packages/webui/src/components/ChatView/index.tsx` |
| 1139 | `packages/core/src/execution/council-orchestrator.ts` |
| 1136 | `packages/cli/src/hq-server/ws.ts` |
| 1133 | `packages/core/src/chronicle/metrics-store.ts` |
| 1127 | `packages/cli/src/webui-server.ts` |
| 1124 | `packages/tui/src/components/history/entry.tsx` |
| 1121 | `packages/webui-server/src/server/start-webui.ts` |
| 1117 | `packages/webui/src/hooks/ws-handlers/session-handlers.ts` |
| 1115 | `packages/requirement-intake/src/service.ts` |
| 1115 | `packages/webui/src/components/MemoryManager/index.tsx` |
| 1114 | `packages/core/src/coordination/agents/project-agent-identity.ts` |
| 1113 | `packages/webui/src/stores/chat-store.ts` |
| 1106 | `packages/cli/src/slash-commands/settings.ts` |
| 1101 | `packages/webui/src/components/SettingsPanel/index.tsx` |
| 1098 | `packages/cli/src/slash-commands/brain.ts` |
| 1095 | `packages/cli/src/subcommands/handlers/modeldiag.ts` |
| 1075 | `packages/acp/src/agent/protocol-handler.ts` |
| 1070 | `packages/cli/src/hq-server.ts` |
| 1066 | `packages/core/src/security/permission-policy.ts` |
| 1063 | `packages/core/src/plugins/auto-review-plugin.ts` |
| 1051 | `packages/sage/src/sqlite-store.ts` |
| 1049 | `packages/core/src/execution/tool-executor.ts` |
| 1046 | `packages/acp/src/client/acp-session.ts` |
| 1041 | `packages/core/src/session-catalog/store.ts` |
| 1036 | `packages/webui-server/src/server/setup-events.ts` |
| 1032 | `packages/mcp/src/registry.ts` |
| 1030 | `packages/tui/src/components/scrollable-history.tsx` |
| 1026 | `packages/core/src/execution/autonomy-brain.ts` |

## Exports only tests reference

- 795 runtime exports are referenced by tests and by no other production file.
- Green coverage on one of these proves the function works, not that anything calls it.
- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
