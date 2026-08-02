# Architecture Health Report

**Generated:** 2026-08-02T13:00:05.863Z
**Scope:** packages, apps; excluded: website

## Summary

| Measure | Value |
|---|---:|
| Workspace packages | 29 |
| Production source files | 2826 |
| Production source lines | 672698 |
| Test files | 2415 |
| Workspace dependency edges | 86 |
| Relative module edges | 8468 |
| Non-command slash imports | 0 |
| Runtime module cycles | 2 |
| Type-inclusive module cycles | 16 |
| Tests without TypeScript test-project coverage | 0 |
| Tests in multiple TypeScript projects | 0 |

## Verification result

- packages/webui/src/stores/chat-store.ts: stale hotspot baseline; remove or tighten it in the same change

## Workspace packages

| Package | Sources | Tests | Workspace dependencies |
|---|---:|---:|---|
| @wrongstack/acp | 38 | 33 | @wrongstack/core |
| @wrongstack/bench | 22 | 45 | @wrongstack/core |
| @wrongstack/cli | 395 | 338 | @wrongstack/acp, @wrongstack/bench, @wrongstack/core, @wrongstack/desktop, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/providers, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/security-scanner, @wrongstack/simpleui, @wrongstack/techstack, @wrongstack/telegram, @wrongstack/tools, @wrongstack/tui, @wrongstack/webui, @wrongstack/webui-hq, @wrongstack/webui-server |
| @wrongstack/codebase-index-mcp | 5 | 4 | @wrongstack/core, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/core | 674 | 560 | @wrongstack/kanban, @wrongstack/persistence |
| @wrongstack/desktop | 37 | 16 | @wrongstack/core, @wrongstack/webui, @wrongstack/webui-server |
| @wrongstack/governance | 39 | 25 | — |
| @wrongstack/kanban | 67 | 52 | @wrongstack/persistence |
| @wrongstack/kanban-mcp | 5 | 5 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/tools |
| @wrongstack/mailbox-mcp | 5 | 7 | @wrongstack/core, @wrongstack/mcp |
| @wrongstack/mcp | 34 | 29 | @wrongstack/core |
| @wrongstack/persistence | 3 | 3 | — |
| @wrongstack/plug-lsp | 41 | 28 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/plugins | 78 | 115 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/providers | 55 | 49 | @wrongstack/core |
| @wrongstack/runtime | 12 | 15 | @wrongstack/core, @wrongstack/governance, @wrongstack/sage, @wrongstack/tools |
| @wrongstack/sage | 77 | 47 | @wrongstack/core |
| @wrongstack/sage-mcp | 5 | 3 | @wrongstack/core, @wrongstack/mcp, @wrongstack/sage |
| @wrongstack/sdd | 33 | 29 | @wrongstack/core, @wrongstack/kanban |
| @wrongstack/security-scanner | 15 | 26 | @wrongstack/core |
| @wrongstack/simpleui | 74 | 43 | @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/techstack | 46 | 32 | @wrongstack/core, @wrongstack/tools |
| @wrongstack/telegram | 20 | 28 | @wrongstack/core |
| @wrongstack/tools | 148 | 158 | @wrongstack/core, @wrongstack/kanban |
| @wrongstack/tui | 275 | 270 | @wrongstack/core, @wrongstack/kanban, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/tools |
| @wrongstack/webui | 406 | 300 | @wrongstack/core, @wrongstack/kanban, @wrongstack/providers, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/webui-hq | 53 | 36 | @wrongstack/core, @wrongstack/tools, @wrongstack/webui-server |
| @wrongstack/webui-server | 163 | 119 | @wrongstack/core, @wrongstack/kanban, @wrongstack/mcp, @wrongstack/providers, @wrongstack/runtime, @wrongstack/sage, @wrongstack/sdd, @wrongstack/techstack, @wrongstack/tools |
| wrongstack | 1 | 0 | @wrongstack/cli |

## Module cycles

### Runtime

- packages/core/src/core/context.ts ↔ packages/core/src/core/conversation-state.ts
- packages/kanban/src/manager/_internal.ts ↔ packages/kanban/src/manager/lifecycle.ts ↔ packages/kanban/src/server/remote-storage.ts ↔ packages/kanban/src/storage.ts

### Type-inclusive

- packages/acp/src/registry/agents.catalog.ts ↔ packages/acp/src/registry/ensemble-registry.ts
- packages/cli/src/acp-server-agent.ts ↔ packages/cli/src/hq-server.ts ↔ packages/cli/src/hq-server/routes.ts ↔ packages/cli/src/hq-server/routes/system-handlers.ts ↔ packages/cli/src/mcp-serve.ts ↔ packages/cli/src/subcommands/handlers/acp.ts ↔ packages/cli/src/subcommands/handlers/audit.ts ↔ packages/cli/src/subcommands/handlers/auth.ts ↔ packages/cli/src/subcommands/handlers/bench.ts ↔ packages/cli/src/subcommands/handlers/chronicle.ts ↔ packages/cli/src/subcommands/handlers/diag-doctor.ts ↔ packages/cli/src/subcommands/handlers/export.ts ↔ packages/cli/src/subcommands/handlers/hq.ts ↔ packages/cli/src/subcommands/handlers/init.ts ↔ packages/cli/src/subcommands/handlers/mailbox-serve.ts ↔ packages/cli/src/subcommands/handlers/mcp.ts ↔ packages/cli/src/subcommands/handlers/modeldiag.ts ↔ packages/cli/src/subcommands/handlers/plugin-usage.ts ↔ packages/cli/src/subcommands/handlers/projects.ts ↔ packages/cli/src/subcommands/handlers/providers-models.ts ↔ packages/cli/src/subcommands/handlers/quick.ts ↔ packages/cli/src/subcommands/handlers/replay.ts ↔ packages/cli/src/subcommands/handlers/rewind.ts ↔ packages/cli/src/subcommands/handlers/sessions-config.ts ↔ packages/cli/src/subcommands/handlers/sessions-fleet.ts ↔ packages/cli/src/subcommands/handlers/tools-skills.ts ↔ packages/cli/src/subcommands/handlers/update.ts ↔ packages/cli/src/subcommands/handlers/version-help.ts ↔ packages/cli/src/subcommands/index.ts
- packages/cli/src/fleet/host.ts ↔ packages/cli/src/fleet/routing.ts
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
- packages/tui/src/components/status-bar-chips.tsx ↔ packages/tui/src/components/status-bar.tsx
- packages/webui/src/components/SettingsPanel/MCPSection.tsx ↔ packages/webui/src/components/SettingsPanel/official-servers.ts

## Largest production files

| Lines | File |
|---:|---|
| 1522 | `packages/tui/src/components/scrollable-history.tsx` |
| 1266 | `packages/sage/src/middleware/tool-call-memory.ts` |
| 1261 | `packages/core/src/security/permission-policy.ts` |
| 1257 | `packages/tools/src/exec.ts` |
| 1226 | `packages/tools/src/codebase-index/writer.ts` |
| 1207 | `packages/tui/src/memory-slash.ts` |
| 1150 | `packages/core/src/storage/file-session-writer.ts` |
| 1149 | `packages/tui/src/components/status-bar.tsx` |
| 1148 | `packages/webui/src/components/ChatInput.tsx` |
| 1130 | `packages/cli/src/hq-server/ws.ts` |
| 1129 | `packages/cli/src/hq-server/routes/auth-handlers.ts` |
| 1129 | `packages/webui/src/lib/ws-client.ts` |
| 1111 | `packages/cli/src/slash-commands/memory.ts` |
| 1110 | `packages/cli/src/cli-main.ts` |
| 1101 | `packages/webui/src/components/SettingsPanel/index.tsx` |
| 1087 | `packages/cli/src/slash-commands/settings.ts` |
| 1087 | `packages/cli/src/subcommands/handlers/modeldiag.ts` |
| 1087 | `packages/tui/src/components/history/entry.tsx` |
| 1070 | `packages/core/src/storage/session-store.ts` |
| 1066 | `packages/core/src/plugins/auto-review-plugin.ts` |
| 1064 | `packages/acp/src/agent/protocol-handler.ts` |
| 1061 | `packages/webui-server/src/server/start-webui.ts` |
| 1046 | `packages/cli/src/webui-server.ts` |
| 1045 | `packages/webui/src/hooks/ws-handlers/session-handlers.ts` |
| 1038 | `packages/sage/src/sqlite-store.ts` |
| 1034 | `packages/cli/src/hq-server/routes.ts` |
| 1033 | `packages/tui/src/app.tsx` |
| 1022 | `packages/kanban/src/verification/verification-context.ts` |
| 1018 | `packages/core/src/execution/tool-executor.ts` |
| 1015 | `packages/cli/src/slash-commands/sdd.ts` |
| 1012 | `packages/mcp/src/client.ts` |
| 1006 | `packages/acp/src/client/acp-session.ts` |
| 1006 | `packages/webui/src/components/ChatView/index.tsx` |
| 1004 | `packages/webui-server/src/server/setup-events.ts` |
| 1002 | `packages/core/src/coordination/agents/project-agent-identity.ts` |
| 1000 | `packages/mcp/src/registry.ts` |
| 997 | `packages/tui/src/components/agents-monitor.tsx` |
| 996 | `packages/webui/src/components/MemoryManager/index.tsx` |
| 995 | `packages/cli/src/repl.ts` |
| 994 | `packages/core/src/coordination/mailbox-http-router.ts` |
| 991 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 989 | `packages/core/src/index.ts` |
| 985 | `packages/core/src/chronicle/metrics-store.ts` |
| 984 | `packages/tui/src/hooks/use-picker-keys.ts` |
| 982 | `packages/core/src/coordination/autonomous-coordinator.ts` |
| 980 | `packages/core/src/execution/brain-runtime.ts` |
| 980 | `packages/sdd/src/sdd-parallel-run.ts` |
| 979 | `packages/webui/src/components/AgentsPage.tsx` |
| 976 | `packages/simpleui/src/simple-ui-session.tsx` |
| 973 | `packages/cli/src/hq-server.ts` |

## TypeScript test coverage debt

- 0 test files are not included in a package TypeScript test project.
- 0 test files are included in more than one package TypeScript project.

> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.
